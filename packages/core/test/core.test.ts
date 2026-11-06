import { describe, expect, it, beforeAll } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  healthScore,
  extractStructure, finalizeSecurity, scanProject, scanAndSave, loadGraph, loadMeta, applyPatch, PatchValidationError, parseUnifiedDiff, computeImpact,
  GraphSearch, buildKnowledgeGraph, embedInDashboard, validateGraph, buildBatches, KnowledgeGraphSchema, globToRegExp, stripComments, isPlaceholderDbUrl, siteUrl,
  type KnowledgeGraph, type GraphNode, type GraphEdge,
} from "../src/index.js";
import { MAX_TAINT_DEPTH, traceTaint, type FunctionSource } from "../src/security/taint.js";

const FIX = path.join(__dirname, "fixtures");

// The fixture holds a placeholder so GitHub's secret scanning doesn't block pushes.
// The fake key is assembled here and written into the temp copy.
export const FAKE_STRIPE_KEY = ["sk", "live", "51HxQ2" + "abcdefghijKLMNOPqrstu1234"].join("_");
async function copyDir(src: string, dst: string) {
  await fs.cp(src, dst, { recursive: true });
  const client = path.join(dst, "src", "db", "client.ts");
  const text = await fs.readFile(client, "utf8").catch(() => null);
  if (text) await fs.writeFile(client, text.replace("__STRIPE_LIVE_KEY__", FAKE_STRIPE_KEY));
}

describe("extract", () => {
  it("pulls functions, classes, imports, and calls from TypeScript", async () => {
    const s = await extractStructure("typescript", `
import { a, b as c } from "./x";
/** Adds */
export function add(x: number) { if (x) return a(x); return c(); }
export class Svc extends Base { run() { return this.helper(); } helper() { return 1; } }
router.post("/items", auth, async (req, res) => { res.json(await add(1)); });
`);
    const names = s.symbols.map((x) => (x.owner ? `${x.owner}.${x.name}` : x.name));
    expect(names).toEqual(expect.arrayContaining(["add", "Svc", "Svc.run", "Svc.helper", "POST /items"]));
    expect(s.symbols.find((x) => x.name === "add")?.doc).toBe("Adds");
    expect(s.imports[0]).toMatchObject({ source: "./x", style: "import" });
    expect(s.calls.find((c) => c.caller === "Svc.run")?.callee).toBe("helper");
    expect(s.calls.find((c) => c.caller === "POST /items" && c.callee === "add")).toBeTruthy();
    expect(s.exports).toEqual(expect.arrayContaining(["add", "Svc"]));
  });

  it("handles Python, Go, Rust, Java", async () => {
    const py = await extractStructure("python", `from .m import X\nclass A(B):\n    def f(self):\n        return g()\ndef g(): pass\n`);
    expect(py.symbols.map((s) => s.name)).toEqual(["A", "f", "g"]);
    expect(py.symbols[0]!.bases).toEqual(["B"]);
    const go = await extractStructure("go", `package x\nimport "fmt"\ntype S struct{}\nfunc (s *S) M() { fmt.Println() }\n`);
    expect(go.symbols.find((s) => s.name === "M")?.owner).toBe("S");
    const rs = await extractStructure("rust", `pub struct A;\nimpl A { pub fn new() -> Self { A } }\n`);
    expect(rs.symbols.find((s) => s.name === "new")?.owner).toBe("A");
    const java = await extractStructure("java", `import a.B;\npublic class C { public void m() { x(); } }`);
    expect(java.symbols.map((s) => s.name)).toEqual(["C", "m"]);
  });

  it("does not count keywords or parameter lists as branches", async () => {
    const s = await extractStructure("java", `class A { void f(int a, int b) { return; } }`);
    expect(s.symbols.find((x) => x.name === "f")?.branches).toBe(0);
  });
});

describe("scan (vuln fixture)", () => {
  let g: KnowledgeGraph;
  beforeAll(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lens-vuln-"));
    await copyDir(path.join(FIX, "vuln-app"), dir);
    g = (await scanProject(dir, { full: true })).graph;
  });

  it("produces a schema-valid graph with no dangling edges", () => {
    expect(KnowledgeGraphSchema.safeParse(g).success).toBe(true);
    expect(validateGraph(g).errors).toEqual([]);
  });

  it("resolves tsconfig path aliases and relative imports", () => {
    const imp = g.edges.filter((e) => e.kind === "imports").map((e) => `${e.source} -> ${e.target}`);
    expect(imp).toContain("file:src/routes/users.ts -> file:src/services/userService.ts");
    expect(imp).toContain("file:src/server.ts -> file:src/routes/users.ts");
  });

  it("detects endpoints, mount prefixes, and auth status", () => {
    const eps = new Map(g.nodes.filter((n) => n.kind === "endpoint").map((n) => [n.name, n.endpoint!]));
    expect(eps.get("POST /users/export")?.auth).toBe("unguarded");
    expect(eps.get("POST /admin/run")?.auth).toBe("guarded");
    expect(eps.get("GET /health")?.auth).toBe("public");
    expect(eps.get("DELETE /api/users/:id")).toBeTruthy();
    expect(eps.get("GET /items/<name>")?.auth).toBe("guarded");
  });

  it("finds the planted vulnerabilities", () => {
    const rules = new Set(g.security!.findings.map((f) => f.rule));
    for (const r of ["js-exec-shell", "prisma-raw-unsafe", "py-unsafe-deser", "py-sql-format", "open-redirect", "jwt-no-verify", "webhook-no-signature", "react-dangerous-html", "secret-stripe-live-key", "secret-db-url-password", "debug-enabled"]) {
      expect(rules, r).toContain(r);
    }
  });

  it("does not flag the parameterized $queryRaw tagged template", () => {
    expect(g.security!.findings.some((f) => f.path === "src/services/userService.ts" && f.line === 12)).toBe(false);
  });

  it("links sinks to reachable endpoints across files and marks taint via the handler", () => {
    const f = g.security!.findings.find((x) => x.rule === "prisma-raw-unsafe")!;
    expect(f.reachableFrom.some((id) => id.includes("GET /:id"))).toBe(true);
    expect(f.tainted).toBe(true);
    expect(f.severity).toBe("critical");
    const path = g.security!.exposure.find((e) => e.findingId === f.id)!.path;
    expect(path.at(-1)).toBe("function:src/services/userService.ts:findUser");
  });

  const tracedPath = (findingId: string) =>
    g.security!.exposure.find((e) => e.findingId === findingId && e.tainted)?.path ?? [];

  it("traces request input across two files into a SQL sink", () => {
    const f = g.security!.findings.find((x) => x.path === "src/db/reportQueries.ts" && x.line === 4)!;
    expect(f.tainted).toBe(true);
    expect(f.severity).toBe("critical");
    expect(f.reachableFrom.some((id) => id.includes("/reports/:reportId"))).toBe(true);
    const path = tracedPath(f.id);
    expect(path).toContain("function:src/services/reportService.ts:loadReport");
    expect(path.at(-1)).toBe("function:src/db/reportQueries.ts:queryReport");
  });

  it("traces request input across two files into an exec sink that needs taint", () => {
    const f = g.security!.findings.find((x) => x.path === "src/lib/shell.ts" && x.line === 4)!;
    expect(f.rule).toBe("js-spawn-tainted");
    expect(f.tainted).toBe(true);
    const path = tracedPath(f.id);
    expect(path).toContain("function:src/services/reportService.ts:renderReport");
    expect(path.at(-1)).toBe("function:src/lib/shell.ts:convertToPdf");
    expect(f.message).toContain("renderReport → convertToPdf");
  });

  it("does not flag an exec sink whose input was sanitized upstream", () => {
    expect(g.security!.findings.some((x) => x.path === "src/lib/shell.ts" && x.line === 8)).toBe(false);
  });

  it("traces Python input across files into SQL and shell sinks, from every endpoint", () => {
    const sql = g.security!.findings.find((x) => x.path === "py/report_store.py" && x.line === 6)!;
    expect(sql.tainted).toBe(true);
    const entries = g.security!.exposure.filter((e) => e.findingId === sql.id && e.tainted).map((e) => e.entryId);
    expect(entries).toEqual(["endpoint:py/reports.py:GET /reports/<key>", "endpoint:py/reports.py:GET /reports/<key>/raw"]);
    expect(sql.reachableFrom).toEqual(expect.arrayContaining(entries));
    const exec = g.security!.findings.find((x) => x.path === "py/export_job.py" && x.line === 5)!;
    expect(exec.tainted).toBe(true);
    expect(tracedPath(exec.id)).toContain("function:py/reports.py:start_export");
  });

  it("treats an int() keyword argument as clean in Python", () => {
    const f = g.security!.findings.find((x) => x.path === "py/report_store.py" && x.line === 11)!;
    expect(f.tainted).toBe(false);
    expect(tracedPath(f.id)).toEqual([]);
  });

  it("traces Go request input across packages into SQL and shell sinks, including grouped params", () => {
    const sql = g.security!.findings.find((x) => x.path === "go/store/store.go" && x.line === 11)!;
    expect(sql.tainted).toBe(true);
    expect(tracedPath(sql.id)).toEqual(["endpoint:go/main.go:ANY /report", "function:go/main.go:reportHandler", "function:go/store/store.go:Find"]);
    const exec = g.security!.findings.find((x) => x.rule === "go-exec")!;
    expect(exec.tainted).toBe(true);
    expect(exec.message).toContain("archiveHandler → Archive");
  });

  it("reports that the fixture trace ran within its limits", () => {
    expect(g.security!.taint).toMatchObject({ truncated: false, limits: [] });
    expect(g.security!.taint!.tracedFunctions).toBeGreaterThan(5);
  });

  it("builds the pre-launch checklist from scanner findings and repo files", () => {
    const list = g.security!.checklist!;
    const by = new Map(list.map((c) => [c.id, c]));
    expect(list.length).toBeGreaterThanOrEqual(30);
    expect(list.every((c) => c.evidence.length > 0)).toBe(true);
    expect(by.get("t3-rawsql")?.status).toBe("fail");
    expect(by.get("t1-git-secrets")?.status).toBe("fail");
    expect(by.get("t2-debug")?.status).toBe("fail");
    expect(by.get("t1-auth")?.status).toBe("fail");
    expect(by.get("t1-env")?.status).toBe("fail"); // fixture has no .gitignore or .env.example
    expect(by.get("t3-backups")?.status).toBe("manual");
  });

  it("redacts secrets", () => {
    const f = g.security!.findings.find((x) => x.rule === "secret-stripe-live-key")!;
    expect(f.snippet).toContain("[redacted]");
    expect(JSON.stringify(g)).not.toContain("sk_live_51HxQ2");
  });
});

describe("false-positive guards", () => {
  it("ignores docs-style placeholder database URLs", () => {
    expect(isPlaceholderDbUrl("postgresql://user:pass@host/db")).toBe(true);
    expect(isPlaceholderDbUrl("postgres://admin:password@db.example.com/app")).toBe(true);
    expect(isPlaceholderDbUrl("postgres://admin:hunter2secret@prod-db.internal.acme.net:5432/app")).toBe(false);
  });

  it("does not treat a first-party /events beacon as a webhook", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lens-evt-"));
    await fs.writeFile(
      path.join(dir, "server.js"),
      `const express = require("express");\nconst app = express();\napp.post("/analytics/event", (req, res) => res.sendStatus(204));\napp.post("/slack/events", (req, res) => res.sendStatus(200));\n`,
    );
    const { graph } = await scanProject(dir, { full: true });
    const eps = new Map(graph.nodes.filter((n) => n.kind === "endpoint").map((n) => [n.name, n.endpoint!]));
    expect(eps.get("POST /analytics/event")?.entryType).toBe("http");
    expect(eps.get("POST /slack/events")?.entryType).toBe("webhook");
    expect(graph.security!.findings.some((f) => f.rule === "webhook-no-signature" && f.message.includes("/analytics/event"))).toBe(false);
  });
});

describe("code health", () => {
  it("flags the habits it's built for and leaves clean code alone", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lens-health-"));
    await fs.mkdir(path.join(dir, "src"));
    const helper = `export function formatPrice(cents: number): string {\n  const dollars = Math.floor(cents / 100);\n  const rest = cents % 100;\n  const padded = rest < 10 ? "0" + rest : String(rest);\n  return "$" + dollars + "." + padded;\n}\n`;
    await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "h", dependencies: { lodash: "1", react: "19" }, devDependencies: { typescript: "5" } }));
    await fs.writeFile(path.join(dir, "src/index.ts"), `import { formatPrice } from "./price";\nimport React from "react";\nexport function main() {\n  try { JSON.parse("x"); } catch (e) {}\n  try { JSON.parse("y"); } catch {\n    // storage may be blocked; ignore\n  }\n  console.log(formatPrice(5), React);\n  // For now, just return a placeholder value\n  const data: any = {};\n  return data;\n}\n`);
    await fs.writeFile(path.join(dir, "src/price.ts"), helper);
    await fs.writeFile(path.join(dir, "src/price_v2.ts"), helper.replace("formatPrice", "formatPriceV2") + `export function neverCalledAnywhere() {\n  return 1;\n}\n`);
    await fs.writeFile(path.join(dir, "IMPLEMENTATION_SUMMARY.md"), "# Done\n\nChanged `src/old/cart.ts` and `src/old/checkout.ts`.\n");
    await fs.writeFile(path.join(dir, "README.md"), "# App\n");
    const { graph } = await scanProject(dir, { full: true });
    const by = new Map(graph.health!.checks.map((c) => [c.id, c]));
    expect(by.get("swallowed-errors")?.count).toBe(1); // the commented catch is a documented choice
    expect(by.get("debug-leftovers")?.count).toBe(1);
    expect(by.get("stubs")?.count).toBe(1);
    expect(by.get("type-escapes")?.hits.some((h) => h.detail === "any")).toBe(true);
    expect(by.get("duplicates")?.hits.map((h) => h.path).sort()).toEqual(["src/price.ts", "src/price_v2.ts"]);
    expect(by.get("version-files")?.hits.map((h) => h.path)).toEqual(["src/price_v2.ts"]);
    expect(by.get("dead-functions")?.hits.some((h) => h.detail.startsWith("neverCalledAnywhere"))).toBe(true);
    expect(by.get("unused-deps")?.hits.map((h) => h.detail)).toEqual(["lodash is declared but never imported"]);
    expect(by.get("stale-docs")?.hits.map((h) => h.path)).toEqual(["IMPLEMENTATION_SUMMARY.md"]);
    expect(by.get("untested")?.severity).toBe("high"); // no tests at all
    expect(graph.health!.score).toBeLessThan(100);
  });

  // Regression: the Health header showed the scan-time score, so closing rows never changed it.
  it("scores only what's still open", () => {
    const allOpen = healthScore([{ severity: "high", open: 1 }, { severity: "low", open: 5 }]);
    expect(allOpen).toBe(92);
    expect(healthScore([{ severity: "high", open: 0 }, { severity: "low", open: 5 }])).toBe(98);
    expect(healthScore([])).toBe(100);
    expect(healthScore([{ severity: "high", open: 50 }])).toBe(70); // capped per group
  });
});

describe("project homepage", () => {
  it("normalizes site URLs and skips code hosts and local addresses", () => {
    expect(siteUrl("https://projecthype.io/")).toBe("https://projecthype.io");
    expect(siteUrl("projecthype.io")).toBe("https://projecthype.io");
    expect(siteUrl("https://github.com/me/app")).toBeUndefined();
    expect(siteUrl("http://localhost:5173")).toBeUndefined();
  });

  it("reads the README live link before example env vars", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lens-home-"));
    await fs.writeFile(path.join(dir, "README.md"), "# App\n\n[![ci](https://img.shields.io/x)](https://github.com/me/app)\n**Live:** https://projecthype.io  \n");
    await fs.writeFile(path.join(dir, ".env.example"), "APP_URL=https://staging.projecthype.io\n");
    await fs.writeFile(path.join(dir, "main.py"), "def f():\n    return 1\n");
    const { graph } = await scanProject(dir, { full: true });
    expect(graph.project.homepage).toBe("https://projecthype.io");
  });
});

describe("incremental + apply", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "lens-"));
    await copyDir(path.join(FIX, "vuln-app"), dir);
    await scanAndSave(dir, { full: true });
  });

  it("rejects malformed patches and drops unknown ids", async () => {
    const g = (await loadGraph(dir))!;
    const meta = (await loadMeta(dir))!;
    expect(() => applyPatch(g, meta, "enrich", { nodes: [{ id: "x" }] })).toThrow(PatchValidationError);
    const rep = applyPatch(g, meta, "enrich", {
      nodes: [
        { id: "file:src/server.ts", summary: "Express entry point.", tags: ["entry"] },
        { id: "src/middleware.ts", summary: "Auth middleware (id without prefix)." },
        { id: "file:does/not/exist.ts", summary: "nope" },
      ],
      edges: [{ source: "file:src/server.ts", target: "file:ghost.ts", kind: "depends_on" }],
    });
    expect(rep.applied).toBe(2);
    expect(rep.dropped.length).toBe(2);
    expect(g.nodes.find((n) => n.id === "file:src/middleware.ts")?.summarySource).toBe("llm");
  });

  it("layers patch accepts globs and assigns leftovers", async () => {
    const g = (await loadGraph(dir))!;
    const meta = (await loadMeta(dir))!;
    applyPatch(g, meta, "layers", {
      layers: [
        { id: "api", name: "API", description: "Routes.", rank: 1, nodeIds: ["glob:src/routes/**", "glob:app/**"] },
        { id: "service", name: "Service", description: "Logic.", rank: 2, nodeIds: ["file:src/services/userService.ts"] },
      ],
    });
    const assigned = g.layers.flatMap((L) => L.nodeIds);
    expect(assigned).toContain("file:src/routes/users.ts");
    const files = g.nodes.filter((n) => n.kind === "file");
    for (const f of files) expect(assigned).toContain(f.id);
    expect(meta.layersSource).toBe("llm");
  });

  it("carries LLM summaries across rescans and flags changed files stale", async () => {
    const g = (await loadGraph(dir))!;
    const meta = (await loadMeta(dir))!;
    applyPatch(g, meta, "enrich", { nodes: [{ id: "file:src/server.ts", summary: "LLM server summary." }, { id: "file:src/middleware.ts", summary: "LLM mw summary." }] });
    const { saveGraph, saveMeta } = await import("../src/persistence.js");
    await saveGraph(dir, g);
    await saveMeta(dir, meta);
    await fs.appendFile(path.join(dir, "src/middleware.ts"), "\nexport const x = 1;\n");
    const r = await scanAndSave(dir);
    const s = r.graph.nodes.find((n) => n.id === "file:src/server.ts")!;
    const m = r.graph.nodes.find((n) => n.id === "file:src/middleware.ts")!;
    expect(s.summary).toBe("LLM server summary.");
    expect(s.stale).toBeFalsy();
    expect(m.summary).toBe("LLM mw summary.");
    expect(m.stale).toBe(true);
    expect(r.changedFiles).toEqual(["src/middleware.ts"]);
    const pending = buildBatches(r.graph, { pendingOnly: true }).flatMap((b) => b.files.map((f) => f.path));
    expect(pending).toContain("src/middleware.ts");
  });

  it("keeps triage verdicts across rescans", async () => {
    const g = (await loadGraph(dir))!;
    const meta = (await loadMeta(dir))!;
    const target = g.security!.findings.find((f) => f.rule === "debug-enabled")!;
    applyPatch(g, meta, "triage", { findings: [{ id: target.id, status: "false_positive", note: "Guarded by __main__, dev only." }] });
    const { saveGraph } = await import("../src/persistence.js");
    await saveGraph(dir, g);
    const r = await scanAndSave(dir);
    expect(r.graph.security!.findings.find((f) => f.rule === "debug-enabled")!.status).toBe("false_positive");
  });
});

describe("diff impact", () => {
  it("parses unified diffs", () => {
    const files = parseUnifiedDiff(`diff --git a/src/a.ts b/src/a.ts\nindex 1..2\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -3,2 +3,4 @@\n+x\ndiff --git a/n.ts b/n.ts\nnew file mode 100644\n--- /dev/null\n+++ b/n.ts\n@@ -0,0 +1,2 @@\n`);
    expect(files).toEqual([{ path: "src/a.ts", status: "M", hunks: [[3, 6]] }, { path: "n.ts", status: "A", hunks: [[1, 2]] }]);
  });

  it("walks dependents and flags affected endpoints", async () => {
    const g = (await scanProject(path.join(FIX, "vuln-app"), { full: true })).graph;
    const r = computeImpact(g, [{ path: "src/services/userService.ts", status: "M", hunks: [[3, 5]] }], { base: "HEAD", head: "x" });
    expect(r.changed).toContain("function:src/services/userService.ts:findUser");
    expect(r.impacted.map((i) => i.id)).toContain("file:src/routes/users.ts");
    expect(r.affectedEndpoints.some((id) => id.includes("GET /:id"))).toBe(true);
    expect(r.risk).not.toBe("low");
  });

  it("runs against a real git repo", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lens-git-"));
    await copyDir(path.join(FIX, "vuln-app"), dir);
    const git = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { stdio: "ignore" });
    git("init", "-q");
    git("-c", "user.email=t@t", "-c", "user.name=t", "add", ".");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
    const { graph } = await scanAndSave(dir, { full: true });
    await fs.appendFile(path.join(dir, "src/middleware.ts"), "\nexport function extra() { return 1; }\n");
    const { diffImpact } = await import("../src/diff.js");
    const r = diffImpact(dir, graph);
    expect(r.changedFiles.map((f) => f.path)).toEqual(["src/middleware.ts"]);
    expect(r.impacted.map((i) => i.id)).toContain("file:src/server.ts");
  });
});

describe("search", () => {
  it("fuzzy tolerates typos and semantic expands synonyms", async () => {
    const g = (await scanProject(path.join(FIX, "vuln-app"), { full: true })).graph;
    const s = new GraphSearch(g);
    expect(s.fuzzy("midleware")[0]?.node.path).toBe("src/middleware.ts");
    const sem = s.semantic("which parts handle authentication").slice(0, 5).map((h) => h.id);
    expect(sem.some((id) => id.includes("middleware") || id.includes("requireAuth"))).toBe(true);
    expect(s.hybrid("user service").length).toBeGreaterThan(0);
  });
});

describe("knowledge base", () => {
  it("builds articles, wikilinks, backlinks, sources, and missing-page entities", async () => {
    const g = await buildKnowledgeGraph(path.join(FIX, "wiki"));
    expect(g.kind).toBe("knowledge");
    const att = g.nodes.find((n) => n.name === "Attention")!;
    expect(att.knowledge?.backlinks).toEqual(expect.arrayContaining(["Index", "Transformers"]));
    expect(g.edges.some((e) => e.kind === "cites" && e.target.startsWith("source:"))).toBe(true);
    expect(g.nodes.some((n) => n.kind === "entity" && n.name === "Missing Page")).toBe(true);
  });
});

describe("misc", () => {
  it("escapes embedded graph data against script breakout", () => {
    const html = embedInDashboard("<head><!--LENS_DATA--></head>", { graph: { x: "</script><script>alert(1)</script>" } as unknown as KnowledgeGraph });
    expect(html).not.toContain("</script><script>alert");
    expect(html).toContain("\\u003c/script");
  });

  it("glob matching", () => {
    expect(globToRegExp("src/**").test("src/a/b.ts")).toBe(true);
    expect(globToRegExp("src/*.ts").test("src/a/b.ts")).toBe(false);
  });

  it("strips comments without shifting lines", () => {
    const s = stripComments("a\n// exec(x)\n/* eval(\n y) */\nb", "typescript");
    expect(s.split("\n").length).toBe(5);
    expect(s).not.toContain("exec");
  });
});


describe("traceTaint", () => {
  type Fn = { lines: string[]; params: string[]; lang?: string; path?: string; name?: string };
  const node = (id: string, kind: GraphNode["kind"], extra: Partial<GraphNode> = {}): GraphNode => ({
    id, kind, name: id.split(":").pop()!, summary: "", summarySource: "heuristic", tags: [], complexity: "simple", ...extra,
  });
  /** One endpoint routed to `handler`; `calls` lists resolved call edges. Each function starts at line 1. */
  function build(fns: Record<string, Fn>, calls: Array<[string, string]> = [], handlers = ["handler"]) {
    const nodes = new Map<string, GraphNode>();
    const out = new Map<string, GraphEdge[]>();
    const functions = new Map<string, FunctionSource>();
    const edge = (source: string, target: string, kind: GraphEdge["kind"]) =>
      out.set(source, [...(out.get(source) ?? []), { source, target, kind, weight: 1, origin: "static" }]);
    for (const [name, f] of Object.entries(fns)) {
      const id = `function:${name}`;
      nodes.set(id, node(id, "function", { path: f.path, name: f.name ?? name }));
      functions.set(id, {
        lang: f.lang ?? "typescript", startLine: 1, lines: f.lines, params: f.params,
        receiverParam: f.lang === "python" && f.params[0] === "self",
      });
    }
    const endpoints = handlers.map((h) => {
      const ep = node(`endpoint:GET /${h}`, "endpoint", { endpoint: { route: `/${h}`, auth: "unguarded", entryType: "http" } });
      nodes.set(ep.id, ep);
      edge(ep.id, `function:${h}`, "routes");
      return ep;
    });
    for (const [a, b] of calls) edge(`function:${a}`, `function:${b}`, "calls");
    return { nodes, out, endpoints, functions };
  }
  const trace = (...args: Parameters<typeof build>) => traceTaint(build(...args));

  it("clears taint only for the category a sanitizer covers", () => {
    const t = trace({
      handler: { params: ["req", "res"], lines: ["function handler(req, res) {", "  const safe = escapeHtml(req.query.q);", "  db.query(`SELECT ${safe}`);", "  res.send(safe);", "}"] },
    });
    expect(t.reached("function:handler", 3, "injection")).toBeTruthy();
    expect(t.reached("function:handler", 4, "xss")).toBeUndefined();
  });

  it("trusts a repo helper only when its returns are sanitized", () => {
    const t = trace({
      handler: { params: ["req"], lines: ["function handler(req) {", "  exec(toId(req.query.id));", "  exec(tidy(req.query.id));", "}"] },
      toId: { params: ["value"], lines: ["function toId(value) {", "  return Number(value);", "}"] },
      tidy: { params: ["value"], lines: ["function tidy(value) {", "  return value.trim();", "}"] },
    });
    expect(t.reached("function:handler", 2, "command-exec")).toBeUndefined();
    expect(t.reached("function:handler", 3, "command-exec")).toBeTruthy();
  });

  it("no longer treats generic escape or sanitize names as sanitizers", () => {
    const t = trace({
      handler: { params: ["req"], lines: ["function handler(req) {", "  exec(sanitizeInput(req.body.cmd));", "  exec(quote(req.body.cmd));", "}"] },
    });
    expect(t.reached("function:handler", 2, "command-exec")).toBeTruthy();
    expect(t.reached("function:handler", 3, "command-exec")).toBeTruthy();
  });

  it("follows a call the resolver missed by matching the function name", () => {
    const t = trace({
      handler: { params: ["req"], lines: ["function handler(req) {", "  return jobs.runJob(req.body.name);", "}"] },
      runJob: { path: "src/jobs.ts", params: ["name"], lines: ["function runJob(name) {", "  exec(`make ${name}`);", "}"] },
    });
    expect(t.reached("function:runJob", 2, "command-exec")?.entries.get("endpoint:GET /handler")).toEqual([
      "endpoint:GET /handler", "function:handler", "function:runJob",
    ]);
  });

  it("doesn't follow a library call into a repo function that shares its name", () => {
    const t = trace({
      handler: { lang: "python", path: "app/views.py", params: ["request"], lines: ["def handler(request):", "    subprocess.run(request.args['cmd'])", "    child().run(request.args['cmd'])"] },
      run: { lang: "python", path: "app/tasks.py", params: ["cmd"], lines: ["def run(cmd):", "    os.system(cmd)"] },
    });
    expect(t.tainted.has("function:run")).toBe(false);
  });

  it("follows a name-only call through self or the callee's module or class", () => {
    const t = trace({
      handler: {
        lang: "python", path: "app/views.py", params: ["self", "request"],
        lines: ["def handler(self, request):", "    self.archive(request.args['a'])", "    report_store.find(request.args['b'])", "    ReportStore.purge(request.args['c'])"],
      },
      archive: { lang: "python", path: "app/views.py", name: "View.archive", params: ["self", "name"], lines: ["def archive(self, name):", "    os.system(name)"] },
      find: { lang: "python", path: "app/report_store.py", params: ["key"], lines: ["def find(key):", "    os.system(key)"] },
      purge: { lang: "python", path: "app/db.py", name: "ReportStore.purge", params: ["key"], lines: ["def purge(key):", "    os.system(key)"] },
    });
    for (const f of ["archive", "find", "purge"]) expect(t.reached(`function:${f}`, 2, "command-exec"), f).toBeTruthy();
  });

  it("binds destructured, keyword, and rest parameters", () => {
    const t = trace({
      handler: { params: ["{ body }"], lines: ["function handler({ body }) {", "  exec(body.cmd);", "  logAll('x', body.a);", "}"] },
      logAll: { params: ["...parts"], lines: ["function logAll(...parts) {", "  exec(parts.join(' '));", "}"] },
      pyHandler: { lang: "python", params: ["key"], lines: ["def pyHandler(key):", "    return load(limit=5, name=key)"] },
      load: { lang: "python", params: ["name", "limit"], lines: ["def load(name, limit):", "    os.system(name)", "    os.system(limit)"] },
    }, [["handler", "logAll"], ["pyHandler", "load"]], ["handler", "pyHandler"]);
    expect(t.reached("function:handler", 2, "command-exec")).toBeTruthy();
    expect(t.reached("function:logAll", 2, "command-exec")).toBeTruthy();
    expect(t.reached("function:load", 2, "command-exec")).toBeTruthy();
    expect(t.reached("function:load", 3, "command-exec")).toBeUndefined();
  });

  it("records every endpoint that reaches a function", () => {
    const t = trace({
      a: { params: ["req"], lines: ["function a(req) {", "  sink(req.query.x);", "}"] },
      b: { params: ["req"], lines: ["function b(req) {", "  sink(req.query.y);", "}"] },
      sink: { params: ["v"], lines: ["function sink(v) {", "  exec(v);", "}"] },
    }, [["a", "sink"], ["b", "sink"]], ["a", "b"]);
    expect([...t.tainted.get("function:sink")!.entries.keys()]).toEqual(["endpoint:GET /a", "endpoint:GET /b"]);
  });

  it("reports truncation when the call chain exceeds the depth cap", () => {
    const fns: Record<string, Fn> = { handler: { params: ["req"], lines: ["function handler(req) {", "  f0(req.body);", "}"] } };
    for (let i = 0; i <= MAX_TAINT_DEPTH + 1; i++) fns[`f${i}`] = { params: ["v"], lines: [`function f${i}(v) {`, `  f${i + 1}(v);`, "}"] };
    const t = trace(fns);
    expect(t.truncated).toBe(true);
    expect(t.limits).toContain("depth");
  });

  it("keeps a taint-only candidate past a truncated trace at low confidence", () => {
    const fns: Record<string, Fn> = { handler: { params: ["req"], lines: ["function handler(req) {", "  f0(req.body);", "}"] } };
    const last = MAX_TAINT_DEPTH + 1;
    for (let i = 0; i <= last; i++) fns[`f${i}`] = { params: ["v"], lines: [`function f${i}(v) {`, `  f${i + 1}(v);`, "}"] };
    const calls = Object.keys(fns).filter((n) => n !== `f${last}`).map((n, i): [string, string] => [n, `f${i}`]);
    const { nodes, out, functions } = build(fns, calls);
    const edges = [...out.values()].flat();
    const raw = { rule: "js-spawn-tainted", title: "t", category: "command-exec" as const, severity: "high" as const, confidence: "high" as const, path: "x.ts", line: 2, message: "m.", needsTaint: true };
    const sec = finalizeSecurity({ graph: { nodes: [...nodes.values()], edges }, raw: [raw], locate: () => `function:f${last}`, functions });
    expect(sec.taint?.truncated).toBe(true);
    expect(sec.findings).toHaveLength(1);
    expect(sec.findings[0]!.confidence).toBe("low");
    const untruncated = finalizeSecurity({ graph: { nodes: [...nodes.values()], edges }, raw: [{ ...raw }], locate: () => "function:f0", functions: new Map([["function:f0", functions.get("function:f0")!]]) });
    expect(untruncated.findings).toHaveLength(0);
  });
});
