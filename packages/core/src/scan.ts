/**
 * Deterministic scan: files → structure → graph. No LLM involved.
 * Incremental by content hash: LLM-authored fields carry over for unchanged
 * files and are flagged `stale` for changed ones.
 */
import { buildChecklist } from "./security/checklist.js";
import { checkSupplyChain, isDependencyManifest } from "./security/supply-chain.js";
import type { RegistryFetch } from "./security/registry.js";
import { buildHealth } from "./quality/health.js";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import posix from "node:path/posix";
import type { EdgeKind, GraphEdge, GraphNode, KnowledgeGraph, Layer, SecurityReport, TourStep } from "./types.js";
import { DEFAULT_EDGE_WEIGHT, SCHEMA_VERSION } from "./types.js";
import { walk, looksBinary, type WalkedFile } from "./walk.js";
import { preloadGrammars } from "./treesitter.js";
import { extractStructure, supportsGrammar, type Structure, type SymbolInfo } from "./extract.js";
import { parseNonCode, type NonCodeInfo } from "./noncode.js";
import { parseTsPaths, resolveImport, type ResolverContext } from "./resolve.js";
import { fileNodeKind, isTestPath } from "./languages.js";
import { detectEntryPoints, detectMounts, type EntryPoint, type Mount } from "./security/entrypoints.js";
import { taintRegexFor } from "./security/rules.js";
import { scanFile, finalizeSecurity, stripComments, type RawFinding } from "./security/analyze.js";
import {
  buildHeuristicLayers, buildHeuristicTour, detectFrameworks, fileComplexity, functionComplexity, heuristicLayer, isFileKind, listPreview,
} from "./heuristics.js";
import { loadFingerprints, loadGraph, loadMeta, paths, saveFingerprints, saveGraph, saveMeta, loadConfig, type LensMeta } from "./persistence.js";

export interface ScanOptions {
  exclude?: string[];
  maxFiles?: number;
  full?: boolean;
  /** Skip the security pass. */
  noSecurity?: boolean;
  /** Skip registry lookups for supply-chain checks (also set by LENS_OFFLINE=1). */
  offline?: boolean;
  /** Registry fetch override, for tests. */
  registryFetch?: RegistryFetch;
  onProgress?: (msg: string) => void;
}

export interface ScanResult {
  graph: KnowledgeGraph;
  meta: LensMeta;
  changedFiles: string[];
  removedFiles: string[];
  staleNodes: number;
  durationMs: number;
  skipped: { ignored: number; unknown: number; tooLarge: number; binary: number };
  fingerprints: Record<string, string>;
}

interface FileRec {
  f: WalkedFile;
  src: string;
  hash: string;
  loc: number;
  structure?: Structure;
  noncode?: NonCodeInfo;
  entries: EntryPoint[];
  mounts: Mount[];
  raw: RawFinding[];
  nodeId: string;
}

const COMMON_NAMES = new Set([
  "get", "set", "run", "init", "main", "map", "filter", "reduce", "push", "pop", "call", "apply", "bind", "then", "catch", "log", "error", "warn",
  "info", "debug", "toString", "valueOf", "json", "send", "end", "write", "read", "open", "close", "parse", "stringify", "keys", "values", "entries",
  "join", "split", "slice", "splice", "forEach", "find", "some", "every", "includes", "indexOf", "replace", "trim", "format", "print", "len", "append",
  "update", "delete", "has", "add", "remove", "create", "next", "render", "use", "new", "handle", "process", "start", "stop", "execute", "resolve", "reject",
  "Error", "Promise", "Map", "Set", "Array", "Object", "String", "Number", "Boolean", "Date", "Math", "JSON", "require", "super", "self", "this",
]);

export async function scanProject(rootIn: string, opts: ScanOptions = {}): Promise<ScanResult> {
  const t0 = Date.now();
  const root = path.resolve(rootIn);
  const progress = opts.onProgress ?? (() => {});
  const config = await loadConfig(root);
  const exclude = [...(config.exclude ?? []), ...(opts.exclude ?? [])];

  progress("discovering files");
  const walked = await walk(root, { exclude, maxFiles: opts.maxFiles });
  const prevGraph = opts.full ? null : await loadGraph(root);
  const prevMeta = opts.full ? null : await loadMeta(root);
  const prevFp = opts.full ? {} : await loadFingerprints(root);

  /* ---- read files ---- */
  const recs: FileRec[] = [];
  let binary = 0;
  for (const f of walked.files) {
    let src: string;
    try {
      src = await fs.readFile(f.abs, "utf8");
    } catch {
      continue;
    }
    if (looksBinary(src)) {
      binary++;
      continue;
    }
    const kind = fileNodeKind(f.path, f.lang);
    recs.push({
      f, src, hash: createHash("sha1").update(src).digest("hex").slice(0, 16),
      loc: src.split("\n").length, entries: [], mounts: [], raw: [], nodeId: `${kind}:${f.path}`,
    });
  }
  walked.skipped.binary = binary;
  const fileSet = new Set(recs.map((r) => r.f.path));
  const changedFiles = recs.filter((r) => prevFp[r.f.path] !== r.hash).map((r) => r.f.path);
  const removedFiles = Object.keys(prevFp).filter((p) => !fileSet.has(p));

  /* ---- project meta + resolver context ---- */
  progress(`parsing ${recs.length} files`);
  const byPath = new Map(recs.map((r) => [r.f.path, r]));
  const allDeps: Record<string, string> = {};
  const ctx: ResolverContext = { files: fileSet, tsPaths: [], workspacePackages: new Map(), qualifiedTypes: new Map(), pyRoots: [""], byStem: new Map() };
  for (const r of recs) {
    const base = posix.basename(r.f.path);
    const stem = base.replace(/\.[^.]+$/, "");
    (ctx.byStem.get(stem) ?? ctx.byStem.set(stem, []).get(stem)!).push(r.f.path);
    const dir = posix.dirname(r.f.path) === "." ? "" : posix.dirname(r.f.path);
    if (/^[tj]sconfig(\.[\w-]+)?\.json$/.test(base)) {
      const { paths: tp, baseUrl } = parseTsPaths(r.src, dir);
      ctx.tsPaths.push(...tp);
      if (baseUrl !== undefined && !dir) ctx.tsBaseUrl = baseUrl;
    }
    if (base === "package.json" && dir) {
      try {
        const pkg = JSON.parse(r.src) as { name?: string; main?: string; module?: string; exports?: unknown; source?: string };
        if (pkg.name) ctx.workspacePackages.set(pkg.name, { dir, entry: pkg.source ?? pkg.module ?? pkg.main });
      } catch { /* ignore */ }
    }
    if (base === "go.mod" && !ctx.goModule) ctx.goModule = /^module\s+(\S+)/m.exec(r.src)?.[1];
    if ((base === "pyproject.toml" || base === "setup.py" || base === "setup.cfg") && dir) ctx.pyRoots.push(dir);
    if (dir === "src" || dir.endsWith("/src")) if (r.f.lang.id === "python" && !ctx.pyRoots.includes(dir)) ctx.pyRoots.push(dir);
  }
  ctx.tsPaths.sort((a, b) => b.prefix.length - a.prefix.length);

  /* ---- per-file extraction ---- */
  await preloadGrammars(recs.map((r) => r.f.lang.grammar).filter((g): g is string => !!g && supportsGrammar(g)));
  let done = 0;
  const slow: Array<[string, number]> = [];
  for (const r of recs) {
    const tFile = Date.now();
    const { lang } = r.f;
    if (lang.category === "code" || lang.category === "test" || lang.category === "script") {
      if (supportsGrammar(lang.grammar)) r.structure = await extractStructure(lang.grammar!, r.src);
      else if (lang.id === "vue" || lang.id === "svelte") {
        const script = /<script[^>]*>([\s\S]*?)<\/script>/.exec(r.src);
        if (script) {
          const offset = r.src.slice(0, script.index).split("\n").length - 1;
          const s = await extractStructure(/lang=["']ts["']/.test(script[0]) ? "typescript" : "javascript", script[1]!);
          for (const x of s.symbols) x.lines = [x.lines[0] + offset, x.lines[1] + offset];
          for (const x of s.imports) x.line += offset;
          for (const x of s.calls) x.line += offset;
          r.structure = s;
        }
      }
    }
    if (!r.structure?.parsed || lang.category !== "code") r.noncode = parseNonCode(r.f.path, lang.id, r.src);
    if (r.noncode?.dependencies) Object.assign(allDeps, r.noncode.dependencies);
    const took = Date.now() - tFile;
    if (took > 150) slow.push([r.f.path, took]);
    if (++done % 250 === 0) progress(`parsed ${done}/${recs.length}`);
  }
  if (process.env.LENS_PROFILE) for (const [p, t] of slow.sort((a, b) => b[1] - a[1]).slice(0, 10)) progress(`slow: ${p} ${t}ms`);
  // Java/Kotlin/C#/Scala package-qualified types for import resolution.
  for (const r of recs) {
    if (!r.structure || !["java", "kotlin", "scala", "csharp", "php"].includes(r.f.lang.id)) continue;
    const pkg = /^\s*(?:package|namespace)\s+([\w.\\]+)/m.exec(r.src)?.[1]?.replace(/\\/g, ".");
    for (const s of r.structure.symbols) if (s.kind === "class" && !s.owner) ctx.qualifiedTypes.set(pkg ? `${pkg}.${s.name}` : s.name, r.f.path);
  }
  const frameworks = detectFrameworks(allDeps, recs.map((r) => r.f.path));

  /* ---- entry points + security raw findings ---- */
  if (!opts.noSecurity) progress("security pass");
  for (const r of recs) {
    if (r.structure && (r.f.lang.id === "typescript" || r.f.lang.id === "javascript")) r.mounts = detectMounts(r.src);
    if (r.structure) {
      // Detect routes on comment-stripped text so documentation examples don't become endpoints.
      const clean = stripComments(r.src, r.f.lang.id);
      r.entries = detectEntryPoints({ path: r.f.path, lang: r.f.lang.id, src: clean, lines: clean.split("\n"), symbols: r.structure.symbols }, frameworks);
    }
    if (!opts.noSecurity) {
      r.raw = scanFile({ path: r.f.path, lang: r.f.lang.id, src: r.src, symbols: r.structure?.symbols ?? [], isTest: isTestPath(r.f.path), entryPoints: r.entries });
    }
  }

  /* ---- build graph ---- */
  progress("building graph");
  const nodes = new Map<string, GraphNode>();
  const edgeMap = new Map<string, GraphEdge>();
  const addEdge = (source: string, target: string, kind: EdgeKind, origin: GraphEdge["origin"], extra: Partial<GraphEdge> = {}) => {
    if (source === target) return;
    const k = `${source}|${target}|${kind}`;
    const prev = edgeMap.get(k);
    if (prev) {
      prev.weight = Math.min(1, prev.weight + 0.05);
      return;
    }
    edgeMap.set(k, { source, target, kind, weight: DEFAULT_EDGE_WEIGHT[kind] ?? 0.5, origin, ...extra });
  };
  const symId = (filePath: string, s: Pick<SymbolInfo, "kind" | "name" | "owner">) => `${s.kind}:${filePath}:${s.owner ? `${s.owner}.` : ""}${s.name}`;

  // Directory module nodes are not emitted; the dashboard derives directories from paths.
  const symbolIndex = new Map<string, Map<string, string>>(); // file → (qname|name → id)
  const exportedByName = new Map<string, string[]>(); // name → ids (for global fallback)
  const classByName = new Map<string, string[]>();

  for (const r of recs) {
    const kind = fileNodeKind(r.f.path, r.f.lang);
    const st = r.structure;
    const funcs = st?.symbols.filter((s) => s.kind === "function") ?? [];
    const classes = st?.symbols.filter((s) => s.kind === "class") ?? [];
    const branches = funcs.reduce((a, s) => a + s.branches, 0);
    const tags = new Set<string>([r.f.lang.id, ...(r.noncode?.tags ?? [])]);
    if (isTestPath(r.f.path)) tags.add("test");
    if (r.entries.length) tags.add("has-routes");
    const node: GraphNode = {
      id: r.nodeId, kind, name: posix.basename(r.f.path), path: r.f.path, lines: [1, r.loc], language: r.f.lang.id,
      summary: "", summarySource: "heuristic", tags: [...tags], complexity: fileComplexity(r.loc, branches),
      exported: undefined, metrics: { loc: r.loc },
    };
    if (r.noncode?.frontmatter && Object.keys(r.noncode.frontmatter).length) node.knowledge = { frontmatter: r.noncode.frontmatter, wikilinks: r.noncode.wikilinks };
    nodes.set(node.id, node);
    const table = new Map<string, string>();
    symbolIndex.set(r.f.path, table);

    const taintRe = taintRegexFor(r.f.lang.id);
    const srcLines = taintRe ? r.src.split("\n") : [];
    for (const s of st?.symbols ?? []) {
      const id = symId(r.f.path, s);
      if (nodes.has(id)) continue; // overloads: keep first
      const readsInput = s.kind === "function" && !!taintRe && srcLines.slice(s.lines[0] - 1, s.lines[1]).some((l) => taintRe.test(l));
      const loc = s.lines[1] - s.lines[0] + 1;
      const sub = s.subkind;
      nodes.set(id, {
        id, kind: s.kind, name: s.owner ? `${s.owner}.${s.name}` : s.name, path: r.f.path, lines: s.lines, language: r.f.lang.id,
        summary: s.doc ?? "", summarySource: "heuristic",
        tags: [sub, ...(s.exported ? ["exported"] : []), ...(readsInput ? ["reads-input"] : []), ...s.decorators.slice(0, 3).map((d) => d.replace(/\(.*$/, "").slice(0, 40))].filter(Boolean),
        complexity: s.kind === "function" ? functionComplexity(s.branches, loc) : fileComplexity(loc, 0),
        signature: s.signature, exported: s.exported, metrics: { loc, branches: s.kind === "function" ? s.branches : undefined },
      });
      const ownerId = s.owner ? table.get(s.owner) : undefined;
      addEdge(ownerId ?? r.nodeId, id, "contains", "static");
      table.set(s.owner ? `${s.owner}.${s.name}` : s.name, id);
      if (!table.has(s.name)) table.set(s.name, id);
      if (s.exported && !s.owner) (exportedByName.get(s.name) ?? exportedByName.set(s.name, []).get(s.name)!).push(id);
      if (s.kind === "class") (classByName.get(s.name) ?? classByName.set(s.name, []).get(s.name)!).push(id);
      if (s.kind === "function" && !s.owner) (exportedByName.get(`fn:${s.name}`) ?? exportedByName.set(`fn:${s.name}`, []).get(`fn:${s.name}`)!).push(id);
    }
    // Non-code children
    for (const c of r.noncode?.children ?? []) {
      const cid = `${c.kind === "section" ? "concept" : c.kind === "step" ? "concept" : c.kind}:${r.f.path}:${c.name}`;
      if (c.kind === "section") continue; // sections stay in the doc summary to avoid noise
      if (nodes.has(cid)) continue;
      nodes.set(cid, {
        id: cid, kind: c.kind === "step" ? "concept" : c.kind, name: c.name, path: r.f.path, lines: c.lines, language: r.f.lang.id,
        summary: c.summary, summarySource: "heuristic", tags: [...(c.tags ?? []), ...(c.kind === "step" ? ["step"] : [])], complexity: "simple",
        ...(c.kind === "endpoint" ? { endpoint: { method: c.method, route: c.route ?? c.name, auth: "unknown" as const, entryType: c.method === "RPC" ? "rpc" as const : "http" as const, framework: "spec" } } : {}),
      });
      addEdge(r.nodeId, cid, "contains", "static");
      if (c.kind === "table") addEdge(r.nodeId, cid, "defines_schema", "static");
    }
    // Endpoints from code
    for (const e of r.entries) {
      const eid = `endpoint:${r.f.path}:${e.method} ${e.route}`;
      if (nodes.has(eid)) continue;
      const handlerId = e.handler ? table.get(e.handler) ?? table.get(e.handler.split(".").pop()!) : undefined;
      nodes.set(eid, {
        id: eid, kind: "endpoint", name: `${e.method} ${e.route}`, path: r.f.path, lines: [e.line, e.line], language: r.f.lang.id,
        summary: `${e.entryType === "cli" ? "Command-line entry" : e.entryType === "cron" ? "Scheduled job" : e.entryType === "server-action" ? "Server action" : `${e.method} route`} ${e.route}${e.handler ? ` handled by ${e.handler}` : ""} (${e.framework}). Auth: ${e.auth}.`,
        summarySource: "heuristic", tags: [e.framework, e.entryType, `auth:${e.auth}`], complexity: "simple",
        endpoint: { method: e.method, route: e.route, framework: e.framework, auth: e.auth, authEvidence: e.authEvidence, entryType: e.entryType, handlerId },
      });
      addEdge(r.nodeId, eid, "contains", "static");
      if (handlerId) {
        addEdge(eid, handlerId, "routes", "static", { evidence: { path: r.f.path, line: e.line } });
        const h = nodes.get(handlerId);
        if (h && !h.tags.includes("reads-input") && e.entryType !== "cron") h.tags.push("reads-input");
      }
    }
  }

  /* ---- imports, calls, inheritance ---- */
  const fileImportTables = new Map<string, { names: Map<string, string>; namespaces: Map<string, string> }>();
  for (const r of recs) {
    const st = r.structure;
    if (!st) continue;
    const lang = r.f.lang.id;
    const importedNames = new Map<string, string>(); // local name → target symbol id
    const namespaceImports = new Map<string, string>(); // local namespace → target file path
    for (const imp of st.imports) {
      let target = resolveImport(r.f.path, lang, imp, ctx);
      // Python: `from pkg import module`
      if (!target && lang === "python" && imp.names.length) {
        for (const nm of imp.names) {
          const t = resolveImport(r.f.path, lang, { ...imp, source: `${imp.source}.${nm}` }, ctx);
          if (t) {
            addEdge(r.nodeId, byPath.get(t)!.nodeId, "imports", "static", { evidence: { path: r.f.path, line: imp.line } });
            namespaceImports.set(nm, t);
          }
        }
      }
      if (!target) continue;
      const tRec = byPath.get(target);
      if (!tRec) continue;
      addEdge(r.nodeId, tRec.nodeId, imp.style === "reexport" ? "exports" : "imports", "static", { evidence: { path: r.f.path, line: imp.line } });
      const tTable = symbolIndex.get(target);
      for (const nm of imp.names) {
        const id = tTable?.get(nm);
        if (id) importedNames.set(nm, id);
        else namespaceImports.set(nm, target); // default/namespace import
      }
      if (!imp.names.length) {
        const local = imp.source.split(/[./\\:]/).filter(Boolean).pop();
        if (local) namespaceImports.set(local, target);
      }
    }
    fileImportTables.set(r.f.path, { names: importedNames, namespaces: namespaceImports });
    const table = symbolIndex.get(r.f.path)!;
    // Inheritance
    for (const s of st.symbols) {
      if (s.kind !== "class" || !s.bases.length) continue;
      const sid = symId(r.f.path, s);
      for (const b of s.bases) {
        const target = table.get(b) ?? importedNames.get(b) ?? uniq(classByName.get(b));
        if (target && target !== sid) addEdge(sid, target, nodes.get(target)?.tags.includes("interface") || nodes.get(target)?.tags.includes("trait") || nodes.get(target)?.tags.includes("protocol") ? "implements" : "inherits", "static");
      }
    }
    // Calls
    for (const c of st.calls) {
      if (COMMON_NAMES.has(c.callee)) continue;
      const callerId = (c.caller && table.get(c.caller)) || r.nodeId;
      const callerNode = nodes.get(callerId);
      const owner = c.caller.includes(".") ? c.caller.slice(0, c.caller.lastIndexOf(".")) : undefined;
      let target: string | undefined;
      let origin: GraphEdge["origin"] = "static";
      const recv = c.receiver?.replace(/\?$/, "");
      if (recv && /^(this|self|@|\$this|s|r)$/.test(recv) && owner) target = table.get(`${owner}.${c.callee}`);
      if (!target && !recv) target = importedNames.get(c.callee);
      if (!target && recv) {
        const ns = namespaceImports.get(recv.split(".")[0]!) ?? namespaceImports.get(recv);
        if (ns) target = symbolIndex.get(ns)?.get(c.callee);
        if (!target && importedNames.has(recv)) {
          // imported class/object: Foo.bar() or foo.bar()
          const cls = nodes.get(importedNames.get(recv)!);
          if (cls?.path) target = symbolIndex.get(cls.path)?.get(`${cls.name}.${c.callee}`);
        }
      }
      if (!target) target = table.get(c.callee) && nodes.get(table.get(c.callee)!)?.kind !== "class" ? table.get(c.callee) : undefined;
      if (!target && !recv && /^[A-Z]/.test(c.callee)) target = importedNames.get(c.callee) ?? table.get(c.callee); // constructor
      if (!target && c.callee.length > 3) {
        const g = uniq(exportedByName.get(`fn:${c.callee}`));
        if (g && nodes.get(g)?.path !== r.f.path) {
          target = g;
          origin = "heuristic";
        }
      }
      if (target && target !== callerId && callerNode) addEdge(callerId, target, "calls", origin, { evidence: { path: r.f.path, line: c.line } });
    }
  }

  /* ---- middleware + router mounts (need import tables) ---- */
  for (const r of recs) {
    const table = symbolIndex.get(r.f.path);
    if (!table) continue;
    const imported = fileImportTables.get(r.f.path);
    for (const e of r.entries) {
      const eid = `endpoint:${r.f.path}:${e.method} ${e.route}`;
      for (const mw of e.middleware ?? []) {
        const t = table.get(mw) ?? imported?.names.get(mw);
        if (t) addEdge(eid, t, "middleware", "static", { evidence: { path: r.f.path, line: e.line } });
      }
    }
    for (const m of r.mounts) {
      const targetFile = imported?.namespaces.get(m.target) ?? (imported?.names.get(m.target) ? nodes.get(imported.names.get(m.target)!)?.path : undefined);
      if (!targetFile) continue;
      for (const n of nodes.values()) {
        if (n.kind !== "endpoint" || n.path !== targetFile || !n.endpoint || n.endpoint.framework === "next") continue;
        if (n.tags.includes("mounted")) continue;
        const route = (m.prefix.replace(/\/$/, "") + (n.endpoint.route === "/" ? "" : n.endpoint.route)) || "/";
        n.endpoint.route = route;
        n.name = `${n.endpoint.method} ${route}`;
        n.tags.push("mounted");
        if (m.guarded && n.endpoint.auth !== "guarded") {
          n.endpoint.auth = "guarded";
          n.endpoint.authEvidence = m.guarded;
          n.tags = n.tags.map((t) => (t.startsWith("auth:") ? "auth:guarded" : t));
        }
        n.summary = n.summary.replace(/ route \S+/, ` route ${route}`).replace(/Auth: \w+\./, `Auth: ${n.endpoint.auth}.`);
        addEdge(r.nodeId, n.id, "routes", "static", { evidence: { path: r.f.path, line: m.line }, label: `mount ${m.prefix}` });
      }
    }
  }
  // Mount-level guards clear the matching "unauthenticated" findings.
  for (const r of recs) {
    r.raw = r.raw.filter((f) => {
      if (f.rule !== "unauthenticated-mutation") return true;
      const ep = [...nodes.values()].find((n) => n.kind === "endpoint" && n.path === r.f.path && n.lines?.[0] === f.line);
      return !ep || ep.endpoint?.auth !== "guarded";
    });
  }

  /* ---- non-code references ---- */
  const serviceByName = new Map<string, string>();
  for (const n of nodes.values()) if (n.kind === "service" && !isFileKind(n)) serviceByName.set(n.name, n.id);
  for (const r of recs) {
    const dir = posix.dirname(r.f.path) === "." ? "" : posix.dirname(r.f.path);
    for (const ref of r.noncode?.refs ?? []) {
      let target: string | undefined;
      if (ref.kind === "file") {
        const clean = ref.target.replace(/^\.\//, "").replace(/[?#].*$/, "");
        const cands = [posix.normalize(posix.join(dir, clean)), posix.normalize(clean), clean.replace(/\/$/, "")];
        for (const c of cands) {
          if (byPath.has(c)) target = byPath.get(c)!.nodeId;
          else {
            // directory reference: README → dir/index or first file under it
            const under = recs.find((x) => x.f.path.startsWith(c.replace(/\/$/, "") + "/"));
            if (under && ref.edge !== "documents") target = under.nodeId;
          }
          if (target) break;
        }
      } else if (ref.kind === "service") target = serviceByName.get(ref.target);
      if (target && target !== r.nodeId) addEdge(r.nodeId, target, ref.edge, "static", { evidence: { path: r.f.path, line: ref.line } });
    }
    // .env keys → files that read them
    if (r.noncode?.envKeys?.length) {
      const keys = new Set(r.noncode.envKeys);
      for (const other of recs) {
        if (other === r || !other.structure) continue;
        for (const m of other.src.matchAll(/(?:process\.env\.|os\.environ(?:\.get)?\(?\[?["']|getenv\(["']|ENV\[["']|env\(["'])([A-Z_][A-Z0-9_]*)/g)) {
          if (keys.has(m[1]!)) {
            addEdge(r.nodeId, other.nodeId, "configures", "heuristic", { label: m[1] });
            break;
          }
        }
      }
    }
  }

  /* ---- tests ---- */
  for (const r of recs) {
    if (!isTestPath(r.f.path)) continue;
    const base = posix.basename(r.f.path);
    const stem = base.replace(/\.(test|spec)(?=\.)/, "").replace(/^test_/, "").replace(/_test(?=\.)/, "").replace(/(Tests?)(?=\.)/, "").replace(/\.[^.]+$/, "");
    const targets = new Set<string>();
    for (const e of edgeMap.values()) if (e.source === r.nodeId && e.kind === "imports" && !isTestPath(nodes.get(e.target)?.path ?? "")) targets.add(e.target);
    for (const cand of ctx.byStem.get(stem) ?? []) if (!isTestPath(cand)) targets.add(byPath.get(cand)!.nodeId);
    for (const t of targets) addEdge(t, r.nodeId, "tested_by", "heuristic");
  }

  /* ---- metrics, summaries, layers ---- */
  const edges = [...edgeMap.values()];
  const fanIn = new Map<string, number>();
  const fanOut = new Map<string, number>();
  for (const e of edges) {
    if (e.kind === "contains") continue;
    fanOut.set(e.source, (fanOut.get(e.source) ?? 0) + 1);
    fanIn.set(e.target, (fanIn.get(e.target) ?? 0) + 1);
  }
  const outBy = groupBy(edges, (e) => e.source);
  const inBy = groupBy(edges, (e) => e.target);
  for (const n of nodes.values()) {
    n.metrics = { ...n.metrics, fanIn: fanIn.get(n.id) ?? 0, fanOut: fanOut.get(n.id) ?? 0 };
    if (!n.summary) n.summary = heuristicSummary(n, byPath.get(n.path ?? ""), outBy.get(n.id) ?? [], inBy.get(n.id) ?? [], nodes);
  }

  /* ---- carry over LLM work from previous graph ---- */
  let staleNodes = 0;
  const unchanged = new Set(recs.filter((r) => prevFp[r.f.path] === r.hash).map((r) => r.f.path));
  let layers: Layer[];
  let tour: TourStep[];
  if (prevGraph && prevGraph.schema === SCHEMA_VERSION) {
    for (const p of prevGraph.nodes) {
      const n = nodes.get(p.id);
      if (n && p.summarySource === "llm") {
        n.summary = p.summary;
        n.summarySource = "llm";
        n.tags = [...new Set([...n.tags, ...p.tags])];
        n.complexity = p.complexity;
        if (p.notes) n.notes = p.notes;
        if (!p.path || !unchanged.has(p.path)) {
          n.stale = true;
          staleNodes++;
        } else if (p.stale) n.stale = true;
      }
      // LLM-created nodes (concepts, domain) survive if their anchors survive.
      if (!n && (p.kind === "concept" || p.kind === "domain" || p.kind === "flow" || p.kind === "step") && p.summarySource === "llm") nodes.set(p.id, p);
    }
    for (const e of prevGraph.edges) {
      if (e.origin !== "llm") continue;
      if (!nodes.has(e.source) || !nodes.has(e.target)) continue;
      edges.push(e);
    }
  }
  const nodeList = [...nodes.values()];
  if (prevMeta?.layersSource === "llm" && prevGraph?.layers.length) {
    const heur = buildHeuristicLayers(nodeList.map((n) => ({ ...n, layer: undefined })));
    const assigned = new Set<string>();
    layers = prevGraph.layers.map((L) => ({ ...L, nodeIds: L.nodeIds.filter((id) => nodes.has(id) && !assigned.has(id) && assigned.add(id)) }));
    // new files: put in the matching LLM layer by heuristic id if it exists, else heuristic layer
    for (const h of heur) {
      const target = layers.find((L) => L.id === h.id) ?? layers.find((L) => L.name.toLowerCase() === h.name.toLowerCase());
      const fresh = h.nodeIds.filter((id) => !assigned.has(id));
      if (!fresh.length) continue;
      if (target) target.nodeIds.push(...fresh);
      else layers.push({ ...h, nodeIds: fresh });
      fresh.forEach((id) => assigned.add(id));
    }
    for (const L of layers) for (const id of L.nodeIds) nodes.get(id)!.layer = L.id;
    layers = layers.filter((L) => L.nodeIds.length);
  } else {
    layers = buildHeuristicLayers(nodeList);
  }
  // Symbols inherit their file's layer
  for (const n of nodeList) if (!n.layer && n.path) n.layer = nodes.get(byPath.get(n.path)?.nodeId ?? "")?.layer ?? heuristicLayer(n);

  if (prevMeta?.tourSource === "llm" && prevGraph?.tour.length) {
    tour = prevGraph.tour.map((s) => ({ ...s, nodeIds: s.nodeIds.filter((id) => nodes.has(id)) })).filter((s) => s.nodeIds.length).map((s, i) => ({ ...s, order: i + 1 }));
  } else tour = buildHeuristicTour({ nodes: nodeList, edges, layers });

  /* ---- security ---- */
  let security: SecurityReport | undefined;
  if (!opts.noSecurity) {
    const symsByFile = new Map<string, GraphNode[]>();
    for (const n of nodeList) if ((n.kind === "function" || n.kind === "class") && n.path) (symsByFile.get(n.path) ?? symsByFile.set(n.path, []).get(n.path)!).push(n);
    const ENDPOINT_RULES = new Set(["unauthenticated-mutation", "webhook-no-signature", "server-action-no-auth"]);
    const locate = (p: string, line: number, rule: string) => {
      if (ENDPOINT_RULES.has(rule)) {
        const ep = nodeList.find((n) => n.kind === "endpoint" && n.path === p && n.lines?.[0] === line);
        if (ep) return ep.id;
      }
      const inner = (symsByFile.get(p) ?? []).filter((s) => s.lines && s.lines[0] <= line && s.lines[1] >= line).sort((a, b) => b.lines![0] - a.lines![0])[0];
      return inner?.id ?? byPath.get(p)?.nodeId ?? `file:${p}`;
    };
    const manifests = recs.filter((r) => isDependencyManifest(r.f.path)).map((r) => ({ path: r.f.path, src: r.src }));
    const supplyChain = await checkSupplyChain({
      root,
      manifests,
      localPackages: localPackageNames(manifests),
      offline: opts.offline,
      fetch: opts.registryFetch,
      onProgress: progress,
    });
    const raw = [...recs.flatMap((r) => r.raw), ...supplyChain.findings];
    security = finalizeSecurity({ graph: { nodes: nodeList, edges }, raw, locate, previous: prevGraph?.security });
    security.checklist = buildChecklist({
      root,
      files: recs.map((r) => ({ path: r.f.path, src: r.src })),
      deps: allDeps,
      endpoints: nodeList.filter((n) => n.kind === "endpoint"),
      security,
      supplyChain: supplyChain.status,
    });
  }

  /* ---- code health ---- */
  const health = buildHealth({
    root,
    files: recs.map((r) => ({ path: r.f.path, src: r.src, lang: r.f.lang.id, category: r.f.lang.category, isTest: isTestPath(r.f.path), symbols: r.structure?.symbols ?? [], imports: r.structure?.imports ?? [] })),
    nodes: nodeList,
    edges,
    deps: allDeps,
  });

  /* ---- project ---- */
  const project = describeProject(root, recs, frameworks);
  const gitCommit = gitHead(root);
  const graph: KnowledgeGraph = {
    schema: SCHEMA_VERSION,
    kind: "codebase",
    project: { ...project, analyzedAt: new Date().toISOString(), gitCommit },
    nodes: nodeList,
    edges,
    layers,
    tour,
    security,
    health,
    stats: {
      files: recs.length,
      nodes: nodeList.length,
      edges: edges.length,
      loc: recs.reduce((a, r) => a + r.loc, 0),
      byKind: nodeList.reduce<Record<string, number>>((a, n) => ((a[n.kind] = (a[n.kind] ?? 0) + 1), a), {}),
      enrichedNodes: nodeList.filter((n) => n.summarySource === "llm").length,
    },
  };
  const meta: LensMeta = {
    version: SCHEMA_VERSION,
    analyzedAt: graph.project.analyzedAt,
    gitCommit,
    analyzedFiles: recs.length,
    layersSource: prevMeta?.layersSource === "llm" ? "llm" : "heuristic",
    tourSource: prevMeta?.tourSource === "llm" && tour.length ? "llm" : "heuristic",
    domainSource: prevMeta?.domainSource,
    enrichedAt: prevMeta?.enrichedAt,
  };
  return { graph, meta, changedFiles, removedFiles, staleNodes, durationMs: Date.now() - t0, skipped: walked.skipped, fingerprints: Object.fromEntries(recs.map((r) => [r.f.path, r.hash])) };
}

/** Scan and persist to .lens/. */
/** Names of the packages this repo defines, so workspace dependencies aren't looked up on npm. */
function localPackageNames(manifests: Array<{ path: string; src: string }>): Set<string> {
  const names = new Set<string>();
  for (const m of manifests) {
    if (posix.basename(m.path) !== "package.json") continue;
    try {
      const name = (JSON.parse(m.src) as { name?: unknown }).name;
      if (typeof name === "string") names.add(name);
    } catch {
      // Invalid package.json has no name to collect; the parser reports it elsewhere.
    }
  }
  return names;
}

export async function scanAndSave(root: string, opts: ScanOptions = {}): Promise<ScanResult> {
  const res = await scanProject(root, opts);
  await saveGraph(root, res.graph);
  await saveMeta(root, res.meta);
  await saveFingerprints(root, res.fingerprints);
  await fs.mkdir(paths(root).intermediate, { recursive: true });
  return res;
}

function uniq(a: string[] | undefined): string | undefined {
  return a && a.length === 1 ? a[0] : undefined;
}

function groupBy<T>(xs: T[], k: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of xs) (m.get(k(x)) ?? m.set(k(x), []).get(k(x))!).push(x);
  return m;
}

export function gitHead(root: string): string | undefined {
  try {
    return execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || undefined;
  } catch {
    return undefined;
  }
}

function describeProject(root: string, recs: FileRec[], frameworks: string[]) {
  const top = (name: string) => recs.find((r) => r.f.path === name);
  let name = path.basename(root);
  let description = "";
  let homepage: string | undefined;
  const pkg = top("package.json");
  if (pkg) {
    try {
      const o = JSON.parse(pkg.src) as { name?: string; description?: string; homepage?: string };
      if (o.name && !/^(root|monorepo|workspace)$/.test(o.name)) name = o.name;
      description = o.description ?? "";
      homepage = siteUrl(o.homepage);
    } catch { /* ignore */ }
  }
  for (const f of ["pyproject.toml", "Cargo.toml"]) {
    const r = top(f);
    if (r && !description) description = /^\s*description\s*=\s*"([^"]+)"/m.exec(r.src)?.[1] ?? "";
  }
  const readme = recs.find((r) => /^readme\.(md|rst|txt)$/i.test(r.f.path));
  if (!description && readme) description = readme.noncode?.summary ?? "";
  const locByLang = new Map<string, number>();
  for (const r of recs) if (r.f.lang.category === "code" || r.f.lang.category === "test") locByLang.set(r.f.lang.id, (locByLang.get(r.f.lang.id) ?? 0) + r.loc);
  const languages = [...locByLang.entries()].sort((a, b) => b[1] - a[1]).map(([l]) => l);
  homepage ??= detectHomepage(recs, readme);
  return { name, description: description.slice(0, 400), languages, frameworks, root: undefined, ...(homepage ? { homepage } : {}) };
}

/** Normalize a candidate website URL to its origin; drop code hosts, badges, and local addresses. */
export function siteUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let u: URL;
  try {
    u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return undefined;
  }
  const h = u.hostname.toLowerCase();
  if (!/\./.test(h) || /^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.)/.test(h)) return undefined;
  if (/(^|\.)(github\.com|gitlab\.com|bitbucket\.org|npmjs\.(com|org)|pypi\.org|shields\.io|example\.(com|org|net)|githubusercontent\.com|badge\.fury\.io)$/.test(h)) return undefined;
  return u.origin;
}

/** Where the repo says it lives: CNAME, README "Live:/Website:" lines, then APP_URL-style example env vars. */
function detectHomepage(recs: FileRec[], readme: FileRec | undefined): string | undefined {
  for (const p of ["CNAME", "public/CNAME", "docs/CNAME", "static/CNAME"]) {
    const r = recs.find((x) => x.f.path === p);
    const url = r && siteUrl(r.src.trim().split(/\s+/)[0]);
    if (url) return url;
  }
  if (readme) {
    const head = readme.src.split("\n").slice(0, 60).join("\n");
    const m = /\b(?:live|website|homepage|site|demo|production|app)\b[^\n]{0,40}?(https?:\/\/[^\s)>\]"'`|]+)/i.exec(head);
    const url = siteUrl(m?.[1]);
    if (url) return url;
  }
  const envRe = /^\s*(?:export\s+)?(?:NEXT_PUBLIC_|VITE_|PUBLIC_|REACT_APP_)?(?:APP|SITE|PUBLIC|BASE|FRONTEND|WEB)_URL\s*=\s*["']?(https?:\/\/[^\s"'#]+)/im;
  for (const r of recs) {
    if (!/(^|\/)\.env\.(example|sample|template|dist)$|(^|\/)\.env\.production$/i.test(r.f.path)) continue;
    const url = siteUrl(envRe.exec(r.src)?.[1]);
    if (url) return url;
  }
  return undefined;
}

function heuristicSummary(n: GraphNode, rec: FileRec | undefined, out: GraphEdge[], inn: GraphEdge[], nodes: Map<string, GraphNode>): string {
  const names = (es: GraphEdge[], side: "source" | "target") => [...new Set(es.map((e) => nodes.get(e[side])?.name).filter(Boolean) as string[])];
  if (isFileKind(n)) {
    if (rec?.structure?.fileDoc && rec.structure.fileDoc.length > 20) return rec.structure.fileDoc;
    if (rec?.noncode?.summary) return rec.noncode.summary;
    const syms = rec?.structure?.symbols.filter((s) => !s.owner) ?? [];
    const fns = syms.filter((s) => s.kind === "function").map((s) => s.name);
    const cls = syms.filter((s) => s.kind === "class").map((s) => s.name);
    const imports = out.filter((e) => e.kind === "imports").length;
    const usedBy = inn.filter((e) => e.kind === "imports").length;
    const role = isTestPath(n.path ?? "") ? "Test file" : /\.(tsx|jsx|vue|svelte)$/.test(n.path ?? "") ? "UI module" : `${LANG_NAMES[n.language ?? ""] ?? cap(n.language ?? "source")} ${rec?.f.lang.category === "script" ? "script" : "module"}`;
    const parts = [
      `${role}${cls.length ? ` defining ${listPreview(cls, 3)}` : ""}${fns.length ? `${cls.length ? " and" : " with"} ${fns.length === 1 ? "function" : "functions"} ${listPreview(fns, 4)}` : ""}.`,
      imports || usedBy ? `Imports ${imports} project file${imports === 1 ? "" : "s"}; imported by ${usedBy}.` : "",
      rec?.entries.length ? `Exposes ${rec.entries.length} route${rec.entries.length === 1 ? "" : "s"}.` : "",
    ];
    return parts.filter(Boolean).join(" ");
  }
  if (n.kind === "function") {
    const calls = names(out.filter((e) => e.kind === "calls"), "target");
    const callers = names(inn.filter((e) => e.kind === "calls"), "source");
    return [
      `${n.tags.includes("method") ? "Method" : "Function"} ${n.name}.`,
      calls.length ? `Calls ${listPreview(calls, 4)}.` : "",
      callers.length ? `Called by ${listPreview(callers, 3)}.` : "",
    ].filter(Boolean).join(" ");
  }
  if (n.kind === "class") {
    const members = names(out.filter((e) => e.kind === "contains"), "target").map((x) => x.split(".").pop()!);
    const bases = names(out.filter((e) => e.kind === "inherits" || e.kind === "implements"), "target");
    const kind = n.tags.find((t) => ["interface", "struct", "trait", "enum", "type", "protocol", "record", "module", "object"].includes(t)) ?? "class";
    return `${cap(kind)} ${n.name}${bases.length ? ` extending ${listPreview(bases, 2)}` : ""}${members.length ? ` with members ${listPreview(members, 5)}` : ""}.`;
  }
  return n.name;
}

const LANG_NAMES: Record<string, string> = {
  typescript: "TypeScript", javascript: "JavaScript", python: "Python", go: "Go", rust: "Rust", java: "Java", kotlin: "Kotlin", csharp: "C#",
  cpp: "C++", c: "C", php: "PHP", ruby: "Ruby", swift: "Swift", scala: "Scala", shell: "Shell", powershell: "PowerShell", css: "CSS", html: "HTML",
};
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
