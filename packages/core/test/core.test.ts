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
import { commentLines, forwardTarget, weakTestReason } from "../src/quality/tells.js";
import { isPolicyJson, scanInfra } from "../src/security/infra.js";

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

  it("finds the planted infrastructure misconfigurations", () => {
    const hits = (path: string) => new Set(g.security!.findings.filter((f) => f.path === path).map((f) => f.rule));
    const expectRules = (path: string, rules: string[]) => {
      const found = hits(path);
      for (const r of rules) expect(found, `${path}: ${r}`).toContain(r);
    };
    expectRules("Dockerfile", ["docker-root-user", "docker-no-healthcheck"]);
    expectRules("Dockerfile.worker", ["docker-latest-tag", "docker-secret-env", "curl-pipe-shell", "docker-add-url", "docker-root-user"]);
    expectRules("infra/main.tf", [
      "tf-public-acl", "tf-public-access-block-off", "tf-open-ingress", "tf-public-db", "tf-hardcoded-credential",
      "tf-unencrypted", "tf-unencrypted-storage", "iam-wildcard-action", "iam-wildcard-resource",
    ]);
    expectRules("k8s/deployment.yaml", [
      "k8s-privileged", "k8s-host-namespace", "k8s-host-path", "docker-socket-mount", "k8s-run-as-root-explicit",
      "k8s-allow-privilege-escalation", "k8s-plain-env-secret", "k8s-no-resource-limits",
    ]);
    expectRules("deploy/app.yaml", ["k8s-run-as-root", "k8s-privilege-escalation-default", "k8s-secret-manifest"]);
    expectRules("iam/policy.json", ["iam-wildcard-action", "tf-public-principal"]);
    expectRules(".github/workflows/ci.yml", ["gha-prt-checkout", "gha-unpinned-action", "gha-script-injection", "gha-secret-echo", "gha-write-all", "curl-pipe-shell"]);
  });

  it("keeps infra checks precise", () => {
    const at = (path: string, rule: string) => g.security!.findings.filter((f) => f.path === path && f.rule === rule);
    // Port 443 open to the world and the egress block are fine; only the SSH ingress is flagged.
    expect(at("infra/main.tf", "tf-open-ingress").map((f) => f.line)).toEqual([20]);
    // Action "*" on Resource "*" is full admin; the Deny statement is ignored.
    const admin = at("infra/main.tf", "iam-wildcard-action");
    expect(admin.map((f) => [f.line, f.severity])).toEqual([[56, "critical"]]);
    // The second stage builds FROM an earlier stage, not an unpinned image.
    expect(at("Dockerfile.worker", "docker-latest-tag").map((f) => f.line)).toEqual([1]);
    // Explicit runAsUser: 0 is reported once by the line rule, not again as a missing setting.
    expect(at("k8s/deployment.yaml", "k8s-run-as-root")).toEqual([]);
    expect(at(".github/workflows/ci.yml", "gha-unpinned-action").map((f) => f.line)).toEqual([13]);
    expect(at(".github/workflows/ci.yml", "gha-prt-checkout")[0]?.severity).toBe("critical");
  });

  it("treats CloudTrail logs that quote a policy as data, not a policy", () => {
    const log = '{"eventVersion": "1.11", "requestParameters": {"policy": {"Statement": [{"Effect": "Allow", "Principal": "*", "Action": "s3:GetObject"}]}}}';
    expect(isPolicyJson("samples/ct.json", log)).toBe(false);
    expect(isPolicyJson("iam/policy.json", '{"Statement": [{"Effect": "Allow", "Action": "*"}]}')).toBe(true);
  });

  it("accepts an entrypoint that chowns a volume as root and then drops to another user", () => {
    const rules = (raw: string) => scanInfra({ path: "Dockerfile", lang: "dockerfile", cleaned: raw, raw }).map((f) => f.rule);
    const base = 'FROM node:22-slim\nHEALTHCHECK CMD ["true"]\n';
    expect(rules(`${base}CMD ["node", "index.js"]\n`)).toContain("docker-root-user");
    expect(rules(`${base}ENTRYPOINT ["/bin/sh", "-c", "chown -R node /data && exec setpriv --reuid=node --regid=node --init-groups \\"$@\\"", "x"]\nCMD ["node", "index.js"]\n`)).not.toContain("docker-root-user");
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
