import { describe, expect, it, beforeAll } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  healthScore,
  extractStructure, scanProject, scanAndSave, loadGraph, loadMeta, applyPatch, PatchValidationError, parseUnifiedDiff, computeImpact,
  GraphSearch, buildKnowledgeGraph, embedInDashboard, validateGraph, buildBatches, KnowledgeGraphSchema, globToRegExp, stripComments, isPlaceholderDbUrl, siteUrl,
  type KnowledgeGraph,
} from "../src/index.js";
import { commentLines, forwardTarget, weakTestReason } from "../src/quality/tells.js";

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

describe("AI tells", () => {
  const TELLS = ["narrating-comments", "ai-attribution", "restating-comments", "emoji", "comment-habits", "readme-boilerplate", "scaffold-leftovers", "inconsistent-libs", "forwarding-wrappers", "blanket-try", "weak-tests", "fragmented"];

  async function project(files: Record<string, string>) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lens-tells-"));
    for (const [rel, src] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
      await fs.writeFile(path.join(dir, rel), src);
    }
    const { graph } = await scanProject(dir, { full: true });
    await fs.rm(dir, { recursive: true, force: true });
    return new Map(graph.health!.checks.map((c) => [c.id, c]));
  }

  const handler = (name: string) => `export async function ${name}(id: string) {\n  try {\n    return await load(id);\n  } catch (err) {\n    throw new Error(\`${name} failed: \${String(err)}\`);\n  }\n}\n`;

  it("flags each tell with the file and line Remediate needs", async () => {
    const by = await project({
      "package.json": JSON.stringify({ name: "t", dependencies: { axios: "1", "is-number": "7" } }),
      "README.md": "# Tasks\n\n- 🚀 Fast\n- 🔒 Secure\n- 📦 Small\n\ngit clone https://github.com/yourusername/tasks\n\nBuilt with Claude Code.\n\nHappy coding!\n\n## License\n\nMIT\n",
      "src/api.ts": `import axios from "axios";\nimport isNumber from "is-number";\n// Now we fetch the user from the API\nexport async function loadUser(id: string) {\n  console.info("🚀 loading user");\n  const retries = isNumber(id) ? 1 : 0; // changed to fix the retry bug\n  return axios.get(\`/users/\${id}?r=\${retries}\`);\n}\n`,
      "src/client.ts": `export async function getJson(url: string) {\n  const response = await fetch(url);\n  // Return the response\n  return response;\n}\n`,
      "src/feed.ts": `export async function feed() {\n  const res = await fetch("/feed");\n  return res.json();\n}\n`,
      "src/math.ts": `// Generated by Claude Code\nfunction add(a: number, b: number) {\n  return a + b;\n}\nfunction sum(a: number, b: number) {\n  return add(a, b);\n}\nexport const total = sum(1, 2);\n`,
      "src/handlers.ts": `import { load } from "./load";\n${handler("getUser")}${handler("getTeam")}${handler("getPlan")}${handler("getBill")}`,
      "src/load.ts": `export async function load(id: string) {\n  return { id };\n}\n`,
      "src/sections.ts": `// ===== Setup =====\nexport const a = 1;\n// ===== Routes =====\nexport const b = 2;\n// ===== Start =====\nexport const c = 3;\n`,
      "src/consts/index.ts": `export * from "./a";\nexport * from "./b";\n`,
      ...Object.fromEntries(["a", "b", "c", "d", "e"].map((n) => [`src/consts/${n}.ts`, `export const ${n.toUpperCase()} = "${n}";\n`])),
      "test/api.test.ts": `import { it, expect } from "vitest";\nimport { loadUser } from "../src/api";\nit("exports loadUser", () => {\n  expect(loadUser).toBeDefined();\n});\n`,
      "test/feed.test.ts": `import { it } from "vitest";\nimport { feed } from "../src/feed";\nit("runs", async () => {\n  await feed();\n});\n`,
      "test/math.test.ts": `import { it, expect } from "vitest";\nimport { total } from "../src/math";\nit("adds", () => {\n  expect(total).toBe(3);\n});\n`,
      "apps/web/package.json": JSON.stringify({ name: "web" }),
      "apps/web/README.md": "# React + TypeScript + Vite\n\nThis template provides a minimal setup.\n",
      "apps/web/public/vite.svg": "<svg/>",
    });
    const paths = (id: string) => by.get(id)?.hits.map((h) => `${h.path}${h.line ? `:${h.line}` : ""}`);
    expect(paths("narrating-comments")).toEqual(["src/api.ts:3", "src/api.ts:6"]);
    expect(paths("ai-attribution")).toEqual(["README.md:9", "src/math.ts:1"]);
    expect(paths("restating-comments")).toEqual(["src/client.ts:3"]);
    expect(by.get("emoji")?.hits.map((h) => h.detail)).toEqual(["🚀 in a log message"]);
    expect(paths("comment-habits")).toEqual(["src/sections.ts:1"]);
    expect(by.get("readme-boilerplate")?.hits.map((h) => h.detail)).toEqual(["3 headings and bullets start with an emoji", '"yourusername"', '"Happy coding"', "names a license but the repo has no LICENSE file"]);
    expect(paths("scaffold-leftovers")).toEqual(["apps/web/README.md", "apps/web/public/vite.svg"]);
    expect(by.get("inconsistent-libs")?.hits).toEqual([{ path: "src/api.ts", detail: "uses axios for HTTP requests; the rest of the project uses fetch (2 files)" }]);
    expect(by.get("forwarding-wrappers")?.hits.map((h) => h.detail)).toEqual(["sum() only calls add() with the same arguments"]);
    expect(paths("blanket-try")).toEqual(["src/handlers.ts:2"]);
    expect(by.get("weak-tests")?.hits).toEqual([
      { path: "test/api.test.ts", detail: "every assertion only checks that a value exists or matches a snapshot" },
      { path: "test/feed.test.ts", detail: "1 tests and no assertions" },
    ]);
    expect(by.get("fragmented")?.hits.map((h) => h.path)).toEqual(["src", "src/consts"]);
    expect(by.get("unused-deps")?.hits.map((h) => h.detail)).toEqual(["is-number replaces a one-line check; inline it"]);
  });

  it("leaves ordinary code, AI-product docs, and real tests alone", async () => {
    const by = await project({
      "package.json": JSON.stringify({ name: "c", dependencies: { zod: "3" } }),
      "LICENSE": "MIT\n",
      "README.md": "# Digest\n\nSummaries are generated by Claude for each upload.\n\n## Setup\n\n- Node 22\n- pnpm\n\n## License\n\nMIT\n",
      "src/digest.ts": [
        `import { z } from "zod";`,
        `const Upload = z.object({ id: z.string() });`,
        `// Lets the caller override the timeout.`,
        `export async function summarize(raw: unknown, timeoutMs = 5000) {`,
        `  const upload = Upload.parse(raw);`,
        `  // Retry once because the token may have just expired.`,
        `  const res = await fetch(\`/summaries/\${upload.id}\`, { signal: AbortSignal.timeout(timeoutMs) });`,
        `  // Return early so a missing summary renders the empty state.`,
        `  if (res.status === 404) return null;`,
        `  // The reply text is generated by Claude at request time.`,
        `  return res.json();`,
        `}`,
        `export function parse(raw: string) {`,
        `  try {`,
        `    return JSON.parse(raw) as unknown;`,
        `  } catch (err) {`,
        `    throw new Error(\`bad summary: \${String(err)}\`);`,
        `  }`,
        `}`,
        `export const fetchSummary = (id: string) => summarize({ id });`,
        ``,
      ].join("\n"),
      "test/digest.test.ts": `import { it, expect } from "vitest";\nimport { parse } from "../src/digest";\nit("parses", () => {\n  expect(parse('{"a":1}')).toEqual({ a: 1 });\n  expect(() => parse("x")).toThrow("bad summary");\n});\n`,
    });
    for (const id of TELLS) expect(by.get(id)?.hits, id).toEqual([]);
    expect(by.get("unused-deps")?.hits).toEqual([]);
  });

  it("reads line, block, and trailing comments but not strings", () => {
    const src = `const url = "http://x"; // trailing\n/**\n * Block line\n */\nconst s = "// not a comment";\n`;
    expect(commentLines(src, "typescript")).toEqual([
      { line: 1, text: "trailing", full: false },
      { line: 3, text: "Block line", full: true },
    ]);
    expect(commentLines(`# lead\nx = "#nope"  # tail\n# type: ignore\n`, "python").map((c) => c.text)).toEqual(["lead", "tail"]);
  });

  it("matches only wrappers that pass their arguments through unchanged", () => {
    expect(forwardTarget("function f(a, b) {\n  return g(a, b);\n}", ["a", "b"])).toBe("g");
    expect(forwardTarget("const f = async (id) => await load(id);", ["id"])).toBe("load");
    expect(forwardTarget("def f(x):\n    return g(x)", ["x"])).toBe("g");
    expect(forwardTarget("function f(a, b) {\n  return g(b, a);\n}", ["a", "b"])).toBeNull();
    expect(forwardTarget("function f(a) {\n  return g(a, 1);\n}", ["a"])).toBeNull();
    expect(forwardTarget("function f(s) {\n  return JSON.parse(s);\n}", ["s"])).toBeNull();
  });

  it("treats value checks as real assertions in Python tests", () => {
    expect(weakTestReason("def test_a():\n    assert f() == 2\n", "python")).toBeNull();
    expect(weakTestReason("def test_a():\n    assert f() is not None\n", "python")).toBe("every assertion only checks that a value exists");
    expect(weakTestReason("def test_a():\n    f()\n", "python")).toBe("1 tests and no assertions");
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

