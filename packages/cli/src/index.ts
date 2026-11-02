#!/usr/bin/env node
import { Command, Option } from "commander";
import pc from "picocolors";
import path from "node:path";
import { promises as fs, existsSync } from "node:fs";
import { execFile } from "node:child_process";
import {
  scanAndSave, loadGraph, loadMeta, saveGraph, saveMeta, loadConfig, saveConfig, paths, writeJsonAtomic, readJson,
  applyPatch, PatchValidationError, validateGraph, KnowledgeGraphSchema, formatZodError,
  buildBatches, architectureContext, tourContext, domainContext, securityContext,
  diffImpact, isGitRepo, saveDiff, GraphSearch, indexGraph, neighbors, shortestPath, explain, graphStats, findNode,
  toMermaid, toDot, embedInDashboard, onboardingMarkdown, buildKnowledgeGraph, buildEmbeddings, osvScan, DEFAULT_IGNORES,
  EDGE_KINDS, NODE_KINDS, type EdgeKind, type KnowledgeGraph, type NodeKind, type PatchKind, type EmbeddingStore, type Severity,
} from "@lens/core";
import { startServer, dashboardHtmlPath } from "./server.js";
import { cloneOrUpdate, parseRepo, reposDir, sessionToken } from "./cloud.js";
import { fileURLToPath } from "node:url";

const VERSION = "0.1.0";
// `lens … | head` closes stdout early; that's not an error.
process.stdout.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code === "EPIPE") process.exit(0);
  throw e;
});
const rel = (p: string) => {
  const r = path.relative(process.cwd(), p);
  return r.startsWith("..") ? p : r || ".";
};
const program = new Command();
program.name("lens").description("Codebase knowledge graphs with a security view.").version(VERSION);

const resolveDir = (d?: string) => path.resolve(d ?? process.cwd());
const out = (x: unknown): void => void process.stdout.write(typeof x === "string" ? x + (x.endsWith("\n") ? "" : "\n") : JSON.stringify(x, null, 2) + "\n");
const log = (m: string) => process.stderr.write(pc.dim("[lens] ") + m + "\n");
const fail = (m: string, code = 1): never => {
  process.stderr.write(pc.red("error: ") + m + "\n");
  process.exit(code);
};

async function requireGraph(dir: string): Promise<KnowledgeGraph> {
  const g = await loadGraph(dir);
  if (!g) fail(`No graph at ${rel(paths(dir).graph)}. Run \`lens scan\` first.`);
  return g!;
}

function openBrowser(url: string) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  execFile(cmd, args, { windowsHide: true }, () => {});
}

/* ---------------- scan ---------------- */
program
  .command("scan")
  .description("Build or refresh the structural graph (deterministic, no LLM)")
  .argument("[dir]", "project directory")
  .option("--full", "ignore previous graph and fingerprints")
  .option("--exclude <globs>", "comma-separated gitignore-style patterns")
  .option("--no-security", "skip the security pass")
  .option("--json", "print the result summary as JSON")
  .action(async (dir, o) => {
    const root = resolveDir(dir);
    if (!existsSync(root)) fail(`No such directory: ${root}`);
    const r = await scanAndSave(root, {
      full: o.full, exclude: o.exclude ? String(o.exclude).split(",").map((s: string) => s.trim()).filter(Boolean) : undefined,
      noSecurity: o.security === false, onProgress: o.json ? undefined : log,
    });
    const g = r.graph;
    const summary = {
      graph: rel(paths(root).graph),
      files: g.stats.files, nodes: g.stats.nodes, edges: g.stats.edges, loc: g.stats.loc,
      languages: g.project.languages, frameworks: g.project.frameworks,
      changedFiles: r.changedFiles.length, removedFiles: r.removedFiles.length, staleNodes: r.staleNodes,
      enrichedNodes: g.stats.enrichedNodes, endpoints: g.nodes.filter((n) => n.kind === "endpoint").length,
      findings: g.security?.summary.bySeverity, riskScore: g.security?.summary.riskScore, ms: r.durationMs,
    };
    if (o.json) return out(summary);
    out(`${pc.bold(g.project.name)}  ${g.stats.files} files · ${g.stats.nodes} nodes · ${g.stats.edges} edges · ${g.stats.loc.toLocaleString("en-US")} lines · ${(r.durationMs / 1000).toFixed(1)}s`);
    out(`  languages   ${g.project.languages.slice(0, 6).join(", ") || "-"}`);
    if (g.project.frameworks.length) out(`  frameworks  ${g.project.frameworks.join(", ")}`);
    out(`  layers      ${g.layers.map((l) => `${l.name} ${l.nodeIds.length}`).join(" · ")}`);
    if (g.security) {
      const s = g.security.summary;
      out(`  security    risk ${s.riskScore}/100 · ${pc.red(`${s.bySeverity.critical} critical`)} · ${s.bySeverity.high} high · ${s.bySeverity.medium} medium · ${summary.endpoints} endpoints (${s.unguardedEndpoints} unguarded)`);
    }
    if (r.changedFiles.length && r.changedFiles.length !== g.stats.files) out(`  changed     ${r.changedFiles.length} files since last scan${r.staleNodes ? `, ${r.staleNodes} LLM summaries now stale` : ""}`);
    out(`  enriched    ${g.stats.enrichedNodes}/${g.stats.nodes} nodes have LLM summaries`);
    out(pc.dim(`  → ${summary.graph}`));
  });

/* ---------------- batches / context / apply ---------------- */
program
  .command("batches")
  .description("Write file batches for file-analyzer agents to .lens/intermediate/")
  .argument("[dir]")
  .option("--pending", "only files that still need LLM summaries (new, stale, or never enriched)")
  .option("--max-files <n>", "files per batch", "25")
  .option("--max-loc <n>", "approximate lines per batch", "4000")
  .option("--no-docs", "skip markdown/doc files")
  .action(async (dir, o) => {
    const root = resolveDir(dir);
    const g = await requireGraph(root);
    const batches = buildBatches(g, { pendingOnly: !!o.pending, maxFiles: Number(o.maxFiles), maxLoc: Number(o.maxLoc), includeDocs: o.docs !== false });
    const idir = paths(root).intermediate;
    await fs.mkdir(idir, { recursive: true });
    for (const f of await fs.readdir(idir)) if (/^(batch|enrich)-\d+\.json$/.test(f)) await fs.rm(path.join(idir, f));
    for (const b of batches) await writeJsonAtomic(path.join(idir, `batch-${b.index}.json`), b, true);
    const manifest = { total: batches.length, files: batches.reduce((a, b) => a + b.files.length, 0), batches: batches.map((b) => ({ index: b.index, input: path.join(idir, `batch-${b.index}.json`), output: path.join(idir, `enrich-${b.index}.json`), files: b.files.length, loc: b.loc, preview: b.files.slice(0, 3).map((f) => f.path) })) };
    await writeJsonAtomic(path.join(idir, "batches.json"), manifest, true);
    out(manifest);
  });

program
  .command("context")
  .description("Write a compact agent context (architecture | tour | domain | security)")
  .argument("<kind>")
  .argument("[dir]")
  .option("--stdout", "print instead of writing a file")
  .action(async (kind: string, dir, o) => {
    const root = resolveDir(dir);
    const g = await requireGraph(root);
    const make = { architecture: architectureContext, tour: tourContext, domain: domainContext, security: securityContext }[kind as "tour"];
    if (!make) fail(`Unknown context kind "${kind}". Use architecture, tour, domain, or security.`);
    const ctx = make(g);
    if (o.stdout) return out(ctx);
    const file = path.join(paths(root).intermediate, `context-${kind}.json`);
    await writeJsonAtomic(file, ctx, true);
    out({ file, bytes: JSON.stringify(ctx).length });
  });

program
  .command("apply")
  .description("Validate and merge agent patch files (enrich | layers | tour | domain | triage)")
  .argument("<kind>")
  .argument("<files...>")
  .option("-d, --dir <dir>", "project directory")
  .option("--keep", "keep patch files after applying")
  .option("--dry-run", "validate only: report what would apply, change nothing")
  .action(async (kind: PatchKind, files: string[], o) => {
    if (!["enrich", "layers", "tour", "domain", "triage"].includes(kind)) fail(`Unknown patch kind "${kind}".`);
    const root = resolveDir(o.dir);
    const g = await requireGraph(root);
    const meta = (await loadMeta(root)) ?? { version: "lens/1", analyzedAt: g.project.analyzedAt, analyzedFiles: g.stats.files, layersSource: "heuristic" as const, tourSource: "heuristic" as const };
    const results: unknown[] = [];
    let failed = 0;
    for (const f of files) {
      const data = await readJson<unknown>(path.resolve(f));
      if (data === null) {
        failed++;
        results.push({ file: f, error: "not found or not valid JSON" });
        continue;
      }
      try {
        const target = o.dryRun ? (structuredClone(g) as KnowledgeGraph) : g;
        const r = applyPatch(target, o.dryRun ? { ...meta } : meta, kind, data);
        results.push({ file: f, applied: r.applied, dropped: r.dropped.length, droppedSample: r.dropped.slice(0, 8) });
        if (!o.keep && !o.dryRun) await fs.rm(path.resolve(f), { force: true });
      } catch (e) {
        failed++;
        results.push({ file: f, error: e instanceof PatchValidationError ? e.message : String(e) });
      }
    }
    if (!o.dryRun) {
      await saveGraph(root, g);
      await saveMeta(root, meta);
    }
    out({ kind, dryRun: !!o.dryRun, results, enrichedNodes: g.stats.enrichedNodes, totalNodes: g.stats.nodes });
    if (failed) process.exitCode = 2;
  });

program
  .command("validate")
  .description("Schema + referential integrity check")
  .argument("[dir]")
  .action(async (dir) => {
    const root = resolveDir(dir);
    const g = await requireGraph(root);
    const schema = KnowledgeGraphSchema.safeParse(g);
    const v = validateGraph(g);
    const errors = [...(schema.success ? [] : [formatZodError(schema.error)]), ...v.errors];
    out({ ok: errors.length === 0, errors, warnings: v.warnings, stats: g.stats });
    if (errors.length) process.exitCode = 1;
  });

/* ---------------- serve / export ---------------- */
program
  .command("serve")
  .description("Open the dashboard (127.0.0.1, token-gated)")
  .argument("[dir]")
  .option("-p, --port <port>", "port (0 = random)", process.env.LENS_PORT ?? "4747")
  .option("--host <host>", "bind address", "127.0.0.1")
  .option("--no-open", "don't open a browser")
  .option("--graph <file>", "serve a specific graph file instead of <dir>/.lens/knowledge-graph.json")
  .action(async (dir, o) => {
    const root = resolveDir(dir);
    if (!o.graph) await requireGraph(root);
    if (o.host !== "127.0.0.1" && o.host !== "localhost" && o.host !== "::1") log(pc.yellow(`binding to ${o.host}: anyone who can reach this address and has the token can read files in the graph`));
    let s;
    try {
      s = await startServer({ root, port: Number(o.port), host: o.host, graphFile: o.graph });
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "EADDRINUSE") s = await startServer({ root, port: 0, host: o.host, graphFile: o.graph });
      else throw e;
    }
    out(`${pc.bold("Lens dashboard")}  ${pc.cyan(s.url)}`);
    out(pc.dim("The URL carries a one-time token. Ctrl+C to stop."));
    if (o.open) openBrowser(s.url);
    const stop = async () => {
      await s.close();
      process.exit(0);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });

program
  .command("cloud")
  .description("Hosted server (Railway): GitHub repos in a workspace volume, sign-in from LENS_USERNAME/LENS_PASSWORD")
  .action(async () => {
    const workspace = path.resolve(process.env.LENS_WORKSPACE ?? "/data");
    await fs.mkdir(reposDir(workspace), { recursive: true });

    const username = process.env.LENS_USERNAME?.trim() ?? "";
    const password = process.env.LENS_PASSWORD ?? "";
    const login = username && password ? { username, password } : null;
    if (!login) log(pc.yellow("LENS_USERNAME and LENS_PASSWORD aren't set; nobody can sign in."));
    if (password && password.length < 12) fail("LENS_PASSWORD must be at least 12 characters.");

    // Last repo opened, then LENS_REPO, then the bundled demo app.
    const wanted = [(await fs.readFile(path.join(workspace, "last-repo"), "utf8").catch(() => "")).trim(), process.env.LENS_REPO ?? ""];
    let root: string | null = null;
    for (const w of wanted) {
      const r = w ? parseRepo(w) : null;
      if (!r) continue;
      try {
        root = await cloneOrUpdate(workspace, r);
        break;
      } catch (e) {
        log(pc.yellow(`couldn't open ${w}: ${(e as Error).message}`));
      }
    }
    if (!root) {
      root = path.join(workspace, "demo", "vuln-app");
      if (!existsSync(root)) {
        const here = path.dirname(fileURLToPath(import.meta.url));
        await fs.cp(path.resolve(here, "../../core/test/fixtures/vuln-app"), root, { recursive: true });
      }
    }
    if (!(await loadGraph(root))) await scanAndSave(root);

    const token = login ? await sessionToken(workspace, login) : undefined;
    const s = await startServer({ root, token, port: Number(process.env.PORT ?? 8080), host: "0.0.0.0", cloud: { workspace, login } });
    out(`${pc.bold("Lens")} listening on port ${process.env.PORT ?? 8080}, project ${root}`);
    const stop = async () => {
      await s.close();
      process.exit(0);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });

program
  .command("export")
  .description("Export the graph (html = self-contained dashboard, no source viewer)")
  .argument("[dir]")
  .addOption(new Option("-f, --format <format>").choices(["html", "mermaid", "dot", "json"]).default("html"))
  .option("-o, --out <file>", "output file (default: .lens/export.<ext> or stdout for mermaid/dot)")
  .option("--with-diff", "embed the current diff impact (html only)")
  .action(async (dir, o) => {
    const root = resolveDir(dir);
    const g = await requireGraph(root);
    let content: string;
    let ext = o.format as string;
    if (o.format === "html") {
      const html = await fs.readFile(dashboardHtmlPath(), "utf8");
      const diff = o.withDiff && isGitRepo(root) ? diffImpact(root, g) : undefined;
      content = embedInDashboard(html, { graph: g, diff });
    } else if (o.format === "mermaid") {
      content = toMermaid(g);
      ext = "mmd";
    } else if (o.format === "dot") content = toDot(g);
    else content = JSON.stringify(g);
    if (!o.out && (o.format === "mermaid" || o.format === "dot")) return out(content);
    const file = path.resolve(o.out ?? path.join(paths(root).dir, `export.${ext}`));
    await fs.writeFile(file, content, "utf8");
    out({ file, bytes: content.length });
  });

/* ---------------- diff / security ---------------- */
program
  .command("diff")
  .description("Impact of uncommitted changes (or a branch vs --base)")
  .argument("[dir]")
  .option("--base <ref>", "compare HEAD against the merge-base with this ref")
  .option("--staged", "only staged changes")
  .option("--depth <n>", "dependency hops to follow", "3")
  .option("--json", "raw JSON")
  .option("--save", "write .lens/diff.json (the dashboard picks it up in exports)")
  .action(async (dir, o) => {
    const root = resolveDir(dir);
    if (!isGitRepo(root)) fail("Not a git repository.");
    const g = await requireGraph(root);
    const r = diffImpact(root, g, { base: o.base, staged: o.staged, depth: Number(o.depth) });
    if (o.save) await saveDiff(root, r);
    if (o.json) return out(r);
    const name = (id: string) => g.nodes.find((n) => n.id === id)?.name ?? id;
    const byId = new Map(g.nodes.map((n) => [n.id, n]));
    const riskColor = r.risk === "high" ? pc.red : r.risk === "medium" ? pc.yellow : pc.green;
    out(`${pc.bold("Diff impact")} ${r.base} → working tree   risk ${riskColor(r.risk)}`);
    out(`  ${r.changedFiles.length} files changed · ${r.changed.length} nodes touched · ${r.impacted.length} dependents within ${o.depth} hops`);
    if (r.affectedLayers.length) out(`  layers: ${r.affectedLayers.join(", ")}`);
    if (r.affectedEndpoints.length) out(`  endpoints: ${r.affectedEndpoints.map(name).slice(0, 12).join(", ")}`);
    if (r.testsToRun.length) out(`  tests to run: ${r.testsToRun.map((id) => byId.get(id)?.path ?? id).slice(0, 15).join(" ")}`);
    if (r.securityRelevant.length) out(pc.yellow(`  security-relevant: ${r.securityRelevant.map(name).slice(0, 10).join(", ")}`));
    const direct = r.impacted.filter((i) => i.distance === 1).slice(0, 15);
    if (direct.length) {
      out("  direct dependents:");
      for (const i of direct) out(`    ${pc.dim(i.via.padEnd(10))} ${byId.get(i.id)?.path ?? ""} ${pc.dim(byId.get(i.id)?.kind === "file" ? "" : name(i.id))}`);
    }
    if (r.unknownFiles.length) out(pc.dim(`  not in graph (run lens scan): ${r.unknownFiles.slice(0, 8).join(", ")}`));
  });

const SEV: Severity[] = ["critical", "high", "medium", "low", "info"];
program
  .command("security")
  .description("Security findings report")
  .argument("[dir]")
  .option("--json", "raw JSON (the full security report)")
  .option("--md", "markdown report")
  .option("--osv", "also query OSV.dev for known-vulnerable dependencies (network)")
  .addOption(new Option("--min <severity>", "minimum severity").choices(SEV).default("low"))
  .option("--all", "include triaged false positives / accepted")
  .action(async (dir, o) => {
    const root = resolveDir(dir);
    const g = await requireGraph(root);
    if (!g.security) fail("No security report; rescan without --no-security.");
    if (o.osv) {
      log("querying OSV.dev");
      const r = await osvScan(root, g);
      await saveGraph(root, g);
      log(`checked ${r.queried} dependencies, ${r.added} vulnerable`);
    }
    const sec = g.security!;
    const min = SEV.indexOf(o.min);
    const findings = sec.findings.filter((f) => SEV.indexOf(f.severity) <= min && (o.all || (f.status !== "false_positive" && f.status !== "accepted")));
    if (o.json) return out({ ...sec, findings });
    const byId = new Map(g.nodes.map((n) => [n.id, n]));
    const eps = sec.entryPoints.map((id) => byId.get(id)!).filter(Boolean);
    if (o.md) {
      const lines = [`# Security report: ${g.project.name}`, "", `Risk score **${sec.summary.riskScore}/100**. Endpoints: ${eps.length} (${sec.summary.unguardedEndpoints} unguarded, ${sec.summary.guardedEndpoints} guarded, ${sec.summary.publicEndpoints} public).`, "", "| Severity | Finding | Location | Reachable from | Status |", "|---|---|---|---|---|"];
      for (const f of findings) lines.push(`| ${f.severity} | ${f.title} (${f.cwe ?? f.rule}) | \`${f.path}:${f.line}\` | ${f.reachableFrom.map((id) => byId.get(id)?.name).filter(Boolean).slice(0, 3).join(", ") || "-"} | ${f.status} |`);
      lines.push("", "## Unguarded endpoints", "");
      for (const e of eps.filter((e) => e.endpoint?.auth === "unguarded")) lines.push(`- \`${e.name}\` at \`${e.path}:${e.lines?.[0]}\``);
      return out(lines.join("\n"));
    }
    const s = sec.summary;
    out(`${pc.bold("Security")}  risk ${s.riskScore}/100   ${pc.red(`${s.bySeverity.critical} critical`)}  ${pc.yellow(`${s.bySeverity.high} high`)}  ${s.bySeverity.medium} medium  ${s.bySeverity.low} low`);
    out(`  endpoints: ${eps.length} total · ${pc.red(`${s.unguardedEndpoints} unguarded`)} · ${s.guardedEndpoints} guarded · ${s.publicEndpoints} public`);
    for (const f of findings.slice(0, 60)) {
      const col = f.severity === "critical" ? pc.red : f.severity === "high" ? pc.yellow : f.severity === "medium" ? pc.cyan : pc.dim;
      const reach = f.reachableFrom.length ? pc.dim(` ← ${f.reachableFrom.map((id) => byId.get(id)?.name).filter(Boolean).slice(0, 2).join(", ")}${f.reachableFrom.length > 2 ? ` +${f.reachableFrom.length - 2}` : ""}`) : "";
      out(`  ${col(f.severity.padEnd(8))} ${f.id} ${f.title}${f.tainted ? pc.red(" [input]") : ""}${f.status !== "open" ? pc.dim(` (${f.status})`) : ""}`);
      out(pc.dim(`           ${f.path}:${f.line}`) + reach);
    }
    if (findings.length > 60) out(pc.dim(`  … ${findings.length - 60} more (use --json)`));
  });

/* ---------------- query / explain / onboard ---------------- */
const query = program.command("query").description("Query the graph without loading it into an LLM context");
query
  .command("search")
  .argument("<q...>")
  .option("-d, --dir <dir>")
  .addOption(new Option("-m, --mode <mode>").choices(["fuzzy", "semantic", "hybrid"]).default("hybrid"))
  .option("-k, --kind <kinds>", "comma-separated node kinds")
  .option("-n, --limit <n>", "max results", "15")
  .action(async (q: string[], o) => {
    const g = await requireGraph(resolveDir(o.dir));
    const s = new GraphSearch(g);
    const kinds = o.kind ? (String(o.kind).split(",") as NodeKind[]).filter((k) => (NODE_KINDS as readonly string[]).includes(k)) : undefined;
    const hits = s[o.mode as "hybrid"](q.join(" "), { limit: Number(o.limit), kinds });
    out(hits.map((h) => ({ id: h.id, score: Number(h.score.toFixed(3)), kind: h.node.kind, path: h.node.path, lines: h.node.lines, summary: h.node.summary.slice(0, 200) })));
  });
query
  .command("node")
  .argument("<ref>", "node id, path, or path:symbol")
  .option("-d, --dir <dir>")
  .action(async (ref: string, o) => {
    const g = await requireGraph(resolveDir(o.dir));
    const n = findNode(g, ref);
    if (!n) fail(`No node matches "${ref}". Try \`lens query search ${ref}\`.`);
    out(n);
  });
query
  .command("neighbors")
  .argument("<ref>")
  .option("-d, --dir <dir>")
  .option("--depth <n>", "hops", "1")
  .addOption(new Option("--direction <dir>").choices(["in", "out", "both"]).default("both"))
  .option("-e, --edges <kinds>", "comma-separated edge kinds")
  .option("-n, --limit <n>", "max results", "60")
  .action(async (ref: string, o) => {
    const g = await requireGraph(resolveDir(o.dir));
    const n = findNode(g, ref);
    if (!n) fail(`No node matches "${ref}".`);
    const kinds = o.edges ? (String(o.edges).split(",") as EdgeKind[]).filter((k) => (EDGE_KINDS as readonly string[]).includes(k)) : undefined;
    const idx = indexGraph(g);
    const res = neighbors(idx, n!.id, { depth: Number(o.depth), direction: o.direction, kinds, limit: Number(o.limit) });
    out({ node: n!.id, neighbors: res.map((x) => ({ ...x, name: idx.nodes.get(x.id)?.name, summary: idx.nodes.get(x.id)?.summary.slice(0, 140) })) });
  });
query
  .command("path")
  .argument("<from>")
  .argument("<to>")
  .option("-d, --dir <dir>")
  .action(async (from: string, to: string, o) => {
    const g = await requireGraph(resolveDir(o.dir));
    const a = findNode(g, from);
    const b = findNode(g, to);
    if (!a || !b) fail(`Could not resolve ${!a ? from : to}.`);
    const idx = indexGraph(g);
    const p = shortestPath(idx, a!.id, b!.id);
    if (!p) return out({ from: a!.id, to: b!.id, path: null });
    const hops = p.slice(1).map((id, i) => {
      const prev = p[i]!;
      const e = [...(idx.out.get(prev) ?? []), ...(idx.in.get(prev) ?? [])].find((x) => (x.source === prev && x.target === id) || (x.target === prev && x.source === id));
      return { from: prev, to: id, edge: e?.kind, direction: e?.source === prev ? "→" : "←" };
    });
    out({ from: a!.id, to: b!.id, length: p.length - 1, hops });
  });
query
  .command("stats")
  .option("-d, --dir <dir>")
  .action(async (o) => out(graphStats(await requireGraph(resolveDir(o.dir)))));

program
  .command("explain")
  .description("Everything the graph knows about a file, symbol, or node id")
  .argument("<ref>")
  .argument("[dir]")
  .action(async (ref: string, dir) => {
    const g = await requireGraph(resolveDir(dir));
    const r = explain(g, ref);
    if (!r) fail(`No node matches "${ref}".`);
    out(r);
  });

program
  .command("onboard")
  .description("Write an onboarding guide from the graph")
  .argument("[dir]")
  .option("-o, --out <file>", "output path", "ONBOARDING.md")
  .option("--stdout")
  .action(async (dir, o) => {
    const root = resolveDir(dir);
    const md = onboardingMarkdown(await requireGraph(root));
    if (o.stdout) return out(md);
    const file = path.resolve(root, o.out);
    await fs.writeFile(file, md, "utf8");
    out({ file });
  });

/* ---------------- embeddings / knowledge / init ---------------- */
program
  .command("embed")
  .description("Build real embeddings for semantic search (optional; needs an API key or Ollama)")
  .argument("[dir]")
  .addOption(new Option("--provider <p>").choices(["openai", "voyage", "ollama"]))
  .option("--model <m>")
  .action(async (dir, o) => {
    const root = resolveDir(dir);
    const g = await requireGraph(root);
    const cfg = await loadConfig(root);
    const provider = o.provider ?? cfg.embedProvider ?? process.env.LENS_EMBED_PROVIDER;
    if (!provider) fail("Pick a provider: --provider openai|voyage|ollama (keys come from OPENAI_API_KEY / VOYAGE_API_KEY / OLLAMA_HOST).");
    const prev = await readJson<EmbeddingStore>(paths(root).embeddings);
    const store = await buildEmbeddings(g, { provider, model: o.model ?? cfg.embedModel, previous: prev, onProgress: (d, t) => log(`embedded ${d}/${t}`) });
    await writeJsonAtomic(paths(root).embeddings, store);
    await saveConfig(root, { ...cfg, embedProvider: provider, embedModel: store.model });
    out({ provider: store.provider, model: store.model, vectors: Object.keys(store.vectors).length, dim: store.dim });
  });

program
  .command("knowledge")
  .description("Build a knowledge-base graph from a folder of markdown")
  .argument("[dir]")
  .action(async (dir) => {
    const root = resolveDir(dir);
    const g = await buildKnowledgeGraph(root);
    const prev = await loadGraph(root);
    if (prev?.kind === "codebase") log(pc.yellow("replacing a codebase graph with a knowledge graph in this directory"));
    await saveGraph(root, g);
    await saveMeta(root, { version: "lens/1", analyzedAt: g.project.analyzedAt, analyzedFiles: g.stats.files, layersSource: "heuristic", tourSource: "heuristic" });
    out({ graph: paths(root).graph, articles: g.stats.byKind.article ?? 0, sources: g.stats.byKind.source ?? 0, topics: g.stats.byKind.topic ?? 0, missingPages: g.stats.byKind.entity ?? 0, links: g.stats.edges });
  });

program
  .command("init")
  .description("Create .lens/.lensignore and config with sensible defaults")
  .argument("[dir]")
  .option("--auto-update", "enable the post-commit auto-refresh hook for this project")
  .action(async (dir, o) => {
    const root = resolveDir(dir);
    const p = paths(root);
    await fs.mkdir(p.dir, { recursive: true });
    if (!existsSync(p.ignore)) {
      await fs.writeFile(p.ignore, [
        "# Extra exclusions for Lens (gitignore syntax). .gitignore is already honored.",
        "# Built-in defaults: " + DEFAULT_IGNORES.slice(0, 12).join(" ") + " …",
        "#",
        "# Uncomment to skip tests or fixtures:",
        "# **/__tests__/**",
        "# **/*.test.*",
        "# **/fixtures/**",
        "",
      ].join("\n"));
    }
    const cfg = await loadConfig(root);
    if (o.autoUpdate) cfg.autoUpdate = true;
    await saveConfig(root, cfg);
    const gi = path.join(p.dir, ".gitignore");
    if (!existsSync(gi)) await fs.writeFile(gi, "intermediate/\ntmp/\nembeddings.json\nexport.*\n");
    out({ dir: p.dir, config: cfg });
  });

program
  .command("clean")
  .description("Remove .lens/intermediate scratch files")
  .argument("[dir]")
  .action(async (dir) => {
    const root = resolveDir(dir);
    await fs.rm(paths(root).intermediate, { recursive: true, force: true });
    out({ removed: paths(root).intermediate });
  });

program.parseAsync().catch((e: Error) => fail(e.message));
