import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { scanAndSave } from "@lens/core";
import { startServer } from "../src/server.js";

const FIX = path.resolve(__dirname, "../../core/test/fixtures/vuln-app");

function get(url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, headers }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode!, body, headers: res.headers }));
    });
    req.on("error", reject);
    req.end();
  });
}

function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const u = new URL(url);
    const data = JSON.stringify(body);
    const req = http.request({ method: "POST", host: u.hostname, port: u.port, path: u.pathname, headers: { "Content-Type": "application/json", ...headers } }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ status: res.statusCode!, body: b }));
    });
    req.on("error", reject);
    req.end(data);
  });
}

describe("lens serve", () => {
  let dir: string;
  let base: string;
  let token: string;
  let close: () => Promise<void>;
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "lens-srv-"));
    await fs.cp(FIX, dir, { recursive: true });
    await fs.symlink("/etc/hosts", path.join(dir, "src", "link.ts"));
    await scanAndSave(dir, { full: true });
    const s = await startServer({ root: dir, port: 0, host: "127.0.0.1" });
    base = s.url.split("/#")[0]!;
    token = s.token;
    close = s.close;
  });
  afterAll(async () => close?.());

  const auth = () => ({ "X-Lens-Token": token });

  it("serves the dashboard with a CSP", async () => {
    const r = await get(`${base}/`);
    expect(r.status).toBe(200);
    expect(r.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(r.body).toContain("<!--LENS_DATA-->");
  });

  it("requires the token on every API route", async () => {
    for (const p of ["/api/meta", "/api/graph", "/api/file?path=src/server.ts", "/api/diff"]) {
      expect((await get(base + p)).status).toBe(401);
      expect((await get(base + p, { "X-Lens-Token": token.slice(0, -1) + "x" })).status).toBe(401);
    }
  });

  it("serves graph files and nothing else", async () => {
    expect((await get(`${base}/api/file?path=src/server.ts`, auth())).status).toBe(200);
    for (const p of ["../../etc/passwd", "/etc/passwd", "src/../../../etc/passwd", "src/link.ts", ".git/config", "src/server.ts%00.png"]) {
      const r = await get(`${base}/api/file?path=${encodeURIComponent(p)}`, auth());
      expect(r.status, p).toBeGreaterThanOrEqual(403);
    }
  });

  it("rejects non-loopback Host headers (DNS rebinding)", async () => {
    const r = await get(`${base}/api/graph`, { ...auth(), Host: "attacker.example:80" });
    expect(r.status).toBe(421);
  });

  it("reports meta", async () => {
    const r = await get(`${base}/api/meta`, auth());
    expect(JSON.parse(r.body)).toMatchObject({ hasEmbeddings: false, project: { name: "vuln-app" } });
  });

  it("switches projects only with the token and only to folders", async () => {
    expect((await post(`${base}/api/project/open`, { path: dir })).status).toBe(401);
    expect((await post(`${base}/api/project/open`, { path: "relative/dir" }, auth())).status).toBe(400);
    expect((await post(`${base}/api/project/open`, { path: path.join(dir, "nope") }, auth())).status).toBe(404);
    expect((await post(`${base}/api/project/open`, { path: path.join(dir, "package.json") }, auth())).status).toBe(400);
    expect((await post(`${base}/api/project/open`, { path: os.homedir() }, auth())).status).toBe(400);

    const other = await fs.mkdtemp(path.join(os.tmpdir(), "lens-other-"));
    await fs.writeFile(path.join(other, "main.py"), "def hello():\n    return 1\n");
    const r = await post(`${base}/api/project/open`, { path: other }, auth());
    expect(r.status).toBe(200);
    const meta = JSON.parse((await get(`${base}/api/meta`, auth())).body);
    expect(meta.root).toBe(await fs.realpath(other));
    // Files from the old project are no longer served.
    expect((await get(`${base}/api/file?path=src/server.ts`, auth())).status).toBe(403);
    expect((await get(`${base}/api/file?path=main.py`, auth())).status).toBe(200);
  });

  it("runs the domain agent through Claude Code and merges its patch", async () => {
    const fake = path.join(os.tmpdir(), `fake-claude-${process.pid}.mjs`);
    await fs.writeFile(
      fake,
      `#!/usr/bin/env node
import fs from "node:fs";
const prompt = process.argv[process.argv.indexOf("-p") + 1];
const out = /Output: (.+)/.exec(prompt)[1].trim();
const budget = process.argv[process.argv.indexOf("--max-budget-usd") + 1];
console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: process.cwd() + "/main.py" } }] } }));
fs.writeFileSync(out, JSON.stringify({ domains: [{ name: "Greetings", summary: "Says hello.", entities: [], businessRules: [], flows: [{ name: "Hello", summary: "Returns one.", entryPoint: "hello", entryType: "manual", steps: [{ name: "Answer", summary: "Returns 1.", nodeIds: ["function:main.py:hello"] }, { name: "Ghost", summary: "x", nodeIds: ["function:nope.py:ghost"] }] }] }] }));
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0.0123, budget }));
`,
    );
    await fs.chmod(fake, 0o755);
    process.env.LENS_CLAUDE_BIN = fake;
    try {
      expect((await post(`${base}/api/enrich/domain`, {})).status).toBe(401);
      // Clients can't set the spending limit; the server derives it from project size.
      const meta = JSON.parse((await get(`${base}/api/meta`, auth())).body);
      for (const t of ["domain", "audit", "review", "summaries"]) {
        const e = meta.enrichEstimates[t];
        expect(e.low).toBeLessThanOrEqual(e.high);
        expect(e.limit).toBeGreaterThanOrEqual(e.high);
        expect(e.limit).toBeLessThanOrEqual(20);
      }
      expect((await post(`${base}/api/enrich/domain`, { budgetUsd: 1.5 }, auth())).status).toBe(202);
      let job: { state: string; costUsd?: number; result?: { domains: number }; progress: string[]; error?: string } = { state: "running", progress: [] };
      for (let i = 0; i < 100 && job.state === "running"; i++) {
        await new Promise((r) => setTimeout(r, 50));
        job = JSON.parse((await get(`${base}/api/enrich/status`, auth())).body);
      }
      expect(job.error).toBeUndefined();
      expect(job.state).toBe("done");
      expect(job.costUsd).toBeCloseTo(0.0123);
      expect(job.result?.domains).toBe(1);
      expect(job.progress).toContain("Reading main.py");
      const graph = JSON.parse((await get(`${base}/api/graph`, auth())).body) as { nodes: Array<{ kind: string; name: string }> };
      expect(graph.nodes.some((n) => n.kind === "domain" && n.name === "Greetings")).toBe(true);
    } finally {
      delete process.env.LENS_CLAUDE_BIN;
    }
  });

  it("runs a read-only AI audit and stores validated checklist verdicts", async () => {
    const fake = path.join(os.tmpdir(), `fake-auditor-${process.pid}.mjs`);
    const argsLog = path.join(os.tmpdir(), `fake-auditor-args-${process.pid}.json`);
    await fs.writeFile(
      fake,
      `#!/usr/bin/env node
import fs from "node:fs";
const prompt = process.argv[process.argv.indexOf("-p") + 1];
const get = (k) => new RegExp(k + ": (.+)").exec(prompt)[1].trim();
fs.writeFileSync(${JSON.stringify(argsLog)}, JSON.stringify(process.argv.slice(2)));
fs.writeFileSync(get("Report path"), "# Security audit\\n");
fs.writeFileSync(get("Verdicts path"), JSON.stringify({ summary: "Fine for launch.", items: [
  { id: "t2-errors", status: "pass", evidence: ["main.py:1 generic error handler"] },
  { id: "t9-bogus", status: "fail", evidence: [] }
] }));
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0.5 }));
`,
    );
    await fs.chmod(fake, 0o755);
    process.env.LENS_CLAUDE_BIN = fake;
    try {
      expect((await post(`${base}/api/enrich/audit`, {})).status).toBe(401);
      expect((await post(`${base}/api/enrich/audit`, {}, auth())).status).toBe(202);
      let job: { state: string; error?: string; audit?: { items: number } } = { state: "running" };
      for (let i = 0; i < 100 && job.state === "running"; i++) {
        await new Promise((r) => setTimeout(r, 50));
        job = JSON.parse((await get(`${base}/api/enrich/status`, auth())).body);
      }
      expect(job.error).toBeUndefined();
      expect(job.state).toBe("done");
      expect(job.audit?.items).toBe(1); // unknown id dropped
      const { audit } = JSON.parse((await get(`${base}/api/audit`, auth())).body);
      expect(audit.items).toEqual([{ id: "t2-errors", status: "pass", evidence: ["main.py:1 generic error handler"] }]);
      expect(audit.costUsd).toBe(0.5);
      const args = JSON.parse(await fs.readFile(argsLog, "utf8")) as string[];
      const tools = args.slice(args.indexOf("--allowedTools") + 1);
      expect(tools).not.toContain("Edit");
      expect(tools.some((t) => t.startsWith("Bash"))).toBe(false);
      expect(tools).not.toContain("Write");
      // Claude Code path rules only work as Edit(...); Write(...) rules are refused.
      expect(tools).toContain("Edit(./SECURITY_AUDIT.md)");
      expect(tools.some((t) => t.startsWith("Write("))).toBe(false);
    } finally {
      delete process.env.LENS_CLAUDE_BIN;
    }
  });

  it("recovers audit output from the final message when writes are refused", async () => {
    const fake = path.join(os.tmpdir(), `fake-auditor2-${process.pid}.mjs`);
    const verdicts = JSON.stringify({ items: [{ id: "t3-logs", status: "fail", evidence: ["main.py:1 logs headers"], fix: "Redact them." }] });
    const text = "Writes were refused.\n```markdown\n# Recovered report\n```\n```json\n" + verdicts + "\n```";
    await fs.writeFile(fake, `#!/usr/bin/env node\nconsole.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0.2, result: ${JSON.stringify(text)} }));\n`);
    await fs.chmod(fake, 0o755);
    process.env.LENS_CLAUDE_BIN = fake;
    try {
      expect((await post(`${base}/api/enrich/audit`, {}, auth())).status).toBe(202);
      let job: { state: string; error?: string } = { state: "running" };
      for (let i = 0; i < 100 && job.state === "running"; i++) {
        await new Promise((r) => setTimeout(r, 50));
        job = JSON.parse((await get(`${base}/api/enrich/status`, auth())).body);
      }
      expect(job.error).toBeUndefined();
      const { audit } = JSON.parse((await get(`${base}/api/audit`, auth())).body);
      expect(audit.items[0]).toMatchObject({ id: "t3-logs", status: "fail" });
      const meta = JSON.parse((await get(`${base}/api/meta`, auth())).body);
      expect(await fs.readFile(path.join(meta.root, "SECURITY_AUDIT.md"), "utf8")).toContain("Recovered report");
    } finally {
      delete process.env.LENS_CLAUDE_BIN;
    }
  });

  it("summarizes pending files batch by batch and merges them", async () => {
    const fake = path.join(os.tmpdir(), `fake-summarizer-${process.pid}.mjs`);
    const argsLog = path.join(os.tmpdir(), `fake-summarizer-args-${process.pid}.json`);
    await fs.writeFile(
      fake,
      `#!/usr/bin/env node
import fs from "node:fs";
const prompt = process.argv[process.argv.indexOf("-p") + 1];
fs.writeFileSync(${JSON.stringify(argsLog)}, JSON.stringify(process.argv.slice(2)));
for (const m of prompt.matchAll(/input (\\S+) -> output (\\S+)/g)) {
  const batch = JSON.parse(fs.readFileSync(m[1], "utf8"));
  fs.writeFileSync(m[2], JSON.stringify({ nodes: batch.files.map((f) => ({ id: f.id, summary: "Written by the fake analyzer for " + f.path + "." })) }));
}
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0.3 }));
`,
    );
    await fs.chmod(fake, 0o755);
    process.env.LENS_CLAUDE_BIN = fake;
    try {
      expect((await post(`${base}/api/enrich/summaries`, {}, auth())).status).toBe(202);
      let job: { state: string; error?: string; summaries?: { files: number; batchesDone: number; batchesTotal: number } } = { state: "running" };
      for (let i = 0; i < 100 && job.state === "running"; i++) {
        await new Promise((r) => setTimeout(r, 50));
        job = JSON.parse((await get(`${base}/api/enrich/status`, auth())).body);
      }
      expect(job.error).toBeUndefined();
      expect(job.state).toBe("done");
      expect(job.summaries?.files).toBeGreaterThan(0);
      expect(job.summaries?.batchesDone).toBe(job.summaries?.batchesTotal);
      const graph = JSON.parse((await get(`${base}/api/graph`, auth())).body) as { nodes: Array<{ id: string; summary: string; summarySource: string }> };
      const main = graph.nodes.find((n) => n.id === "file:main.py")!;
      expect(main.summarySource).toBe("llm");
      expect(main.summary).toContain("fake analyzer");
      const args = JSON.parse(await fs.readFile(argsLog, "utf8")) as string[];
      expect(args[args.indexOf("--model") + 1]).toBe("sonnet");
      expect(args).toContain("Edit(./.lens/intermediate/enrich-*.json)");

      // Nothing left to do: a second run finishes immediately without calling Claude.
      await fs.rm(argsLog);
      expect((await post(`${base}/api/enrich/summaries`, {}, auth())).status).toBe(202);
      for (let i = 0; i < 50; i++) {
        job = JSON.parse((await get(`${base}/api/enrich/status`, auth())).body);
        if (job.state !== "running") break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(job.summaries?.batchesTotal).toBe(0);
      await expect(fs.stat(argsLog)).rejects.toThrow();
    } finally {
      delete process.env.LENS_CLAUDE_BIN;
    }
  });

  it("runs a read-only senior review and stores its findings", async () => {
    const fake = path.join(os.tmpdir(), `fake-reviewer-${process.pid}.mjs`);
    const argsLog = path.join(os.tmpdir(), `fake-reviewer-args-${process.pid}.json`);
    await fs.writeFile(
      fake,
      `#!/usr/bin/env node
import fs from "node:fs";
const prompt = process.argv[process.argv.indexOf("-p") + 1];
const get = (k) => new RegExp(k + ": (.+)").exec(prompt)[1].trim();
fs.writeFileSync(${JSON.stringify(argsLog)}, JSON.stringify(process.argv.slice(2)));
const ctx = JSON.parse(fs.readFileSync(get("Context"), "utf8"));
if (!ctx.files?.length) throw new Error("no files in context");
const prior = ctx.priorFindings.find((f) => f.title === "Logic in the entry file");
fs.writeFileSync(get("Findings path"), JSON.stringify({ findings: [
  { title: "Logic in the entry file", severity: "low", category: "design", path: "main.py", line: 1, detail: "Everything lives in main.py.", fix: "Split when it grows.", ...(prior ? { priorId: prior.id } : {}) }
] }));
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0.4 }));
`,
    );
    await fs.chmod(fake, 0o755);
    process.env.LENS_CLAUDE_BIN = fake;
    try {
      expect((await post(`${base}/api/enrich/review`, {})).status).toBe(401);
      expect((await post(`${base}/api/enrich/review`, {}, auth())).status).toBe(202);
      let job: { state: string; error?: string; review?: { findings: number } } = { state: "running" };
      for (let i = 0; i < 100 && job.state === "running"; i++) {
        await new Promise((r) => setTimeout(r, 50));
        job = JSON.parse((await get(`${base}/api/enrich/status`, auth())).body);
      }
      expect(job.error).toBeUndefined();
      expect(job.review?.findings).toBe(1);
      const { review } = JSON.parse((await get(`${base}/api/review`, auth())).body);
      expect(review.findings[0]).toMatchObject({ title: "Logic in the entry file", category: "design" });
      // "Fix Issues" on the Health page starts from the review's open findings.
      const rem = JSON.parse((await get(`${base}/api/remediation`, auth())).body);
      expect(rem.healthItems).toBeGreaterThanOrEqual(1);
      const args = JSON.parse(await fs.readFile(argsLog, "utf8")) as string[];
      const tools = args.slice(args.indexOf("--allowedTools") + 1);
      expect(tools).toEqual(["Read", "Grep", "Glob", "Edit(./.lens/intermediate/review.json)"]);
      // Every file was reviewed, so nothing is pending and a second run finds no new findings.
      const after = JSON.parse((await get(`${base}/api/meta`, auth())).body);
      expect(after.reviewPending.files).toBe(0);
      expect((await post(`${base}/api/enrich/review`, {}, auth())).status).toBe(202);
      job = { state: "running" };
      for (let i = 0; i < 100 && job.state === "running"; i++) {
        await new Promise((r) => setTimeout(r, 50));
        job = JSON.parse((await get(`${base}/api/enrich/status`, auth())).body);
      }
      expect(job.review?.findings).toBe(0);
      expect(JSON.parse((await get(`${base}/api/review`, auth())).body).review.findings).toHaveLength(1);
    } finally {
      delete process.env.LENS_CLAUDE_BIN;
    }
  });

  it("fixes what passes validation, refuses the rest, and undoes exactly", async () => {
    const { audit } = JSON.parse((await get(`${base}/api/audit`, auth())).body);
    expect(audit.items.some((i: { status: string }) => i.status === "fail")).toBe(true); // t3-logs from the earlier audit test
    const meta = JSON.parse((await get(`${base}/api/meta`, auth())).body);
    const root = meta.root as string;
    const original = await fs.readFile(path.join(root, "main.py"), "utf8");
    const fake = path.join(os.tmpdir(), `fake-remediator-${process.pid}.mjs`);
    await fs.writeFile(fake, `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
const prompt = process.argv[process.argv.indexOf("-p") + 1];
const ws = /Project copy \\(edit files here\\): (.+)/.exec(prompt)[1].trim();
const out = /Report path: (.+)/.exec(prompt)[1].trim();
const main = path.join(ws, "main.py");
fs.writeFileSync(main, fs.readFileSync(main, "utf8").replace("return 1", "return 2"));
fs.writeFileSync(path.join(ws, ".env"), "KEY=1");
fs.mkdirSync(path.join(ws, ".git"), { recursive: true });
fs.writeFileSync(path.join(ws, ".git", "HEAD"), "x");
fs.writeFileSync(out, JSON.stringify({
  summary: "One fix.",
  fixes: [
    { itemId: "t3-logs", title: "Return 2", explanation: "Demo.", files: ["main.py", ".env"] },
    { itemId: "t3-logs", title: "Claimed", explanation: "Demo.", files: [] },
  ],
  skipped: [{ itemId: "t1-env", reason: "Outside code: needs a hosting setting." }],
}));
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0.3 }));
`);
    await fs.chmod(fake, 0o755);
    process.env.LENS_CLAUDE_BIN = fake;
    try {
      expect((await post(`${base}/api/enrich/remediate`, { source: "audit" }, auth())).status).toBe(202);
      let job: { state: string; error?: string; remediation?: { proposed: number; invalid: number } } = { state: "running" };
      for (let i = 0; i < 100 && job.state === "running"; i++) {
        await new Promise((r) => setTimeout(r, 50));
        job = JSON.parse((await get(`${base}/api/enrich/status`, auth())).body);
      }
      expect(job.error).toBeUndefined();
      expect(job.remediation).toMatchObject({ proposed: 1, invalid: 0, applied: 1 });
      const remediation = JSON.parse((await get(`${base}/api/remediation`, auth())).body).records.audit;
      expect(remediation.edits).toBeUndefined(); // raw edits never leave the server
      const good = remediation.fixes.find((f: { title: string }) => f.title === "Return 2");
      expect(good.files.map((f: { path: string }) => f.path)).toEqual(["main.py"]);
      expect(good.files[0].diff).toContain("+    return 2");
      expect(remediation.skipped.some((x: { reason: string }) => x.reason.includes("changed no files"))).toBe(true);
      expect(good.status).toBe("applied"); // Fix applies valid edits itself
      expect(await fs.readFile(path.join(root, "main.py"), "utf8")).toContain("return 2");
      await expect(fs.stat(path.join(root, ".env"))).rejects.toThrow();

      expect((await post(`${base}/api/remediation/apply`, { ids: [good.id], source: "audit" })).status).toBe(401);
      const again = JSON.parse((await post(`${base}/api/remediation/apply`, { ids: [good.id], source: "audit" }, auth())).body);
      expect(again.failed.map((f: { id: string }) => f.id)).toEqual([good.id]);

      expect((await post(`${base}/api/remediation/undo`, { id: good.id, source: "audit" }, auth())).status).toBe(200);
      expect(await fs.readFile(path.join(root, "main.py"), "utf8")).toBe(original);
    } finally {
      delete process.env.LENS_CLAUDE_BIN;
    }
  });

  it("Fix on Health loops until nothing is left, deletes stale docs, and can undo", async () => {
    const meta = JSON.parse((await get(`${base}/api/meta`, auth())).body);
    const root = meta.root as string;
    const doc = path.join(root, "IMPLEMENTATION_SUMMARY.md");
    await fs.writeFile(doc, "# Done\n\nChanged `src/old/a.ts` and `src/old/b.ts`.\n");
    expect((await post(`${base}/api/project/open`, { path: root }, auth())).status).toBe(200); // rescan
    const fake = path.join(os.tmpdir(), `fake-fixall-${process.pid}.mjs`);
    await fs.writeFile(fake, `#!/usr/bin/env node
import fs from "node:fs";
const prompt = process.argv[process.argv.indexOf("-p") + 1];
const items = JSON.parse(fs.readFileSync(/Items: (.+)/.exec(prompt)[1].trim(), "utf8")).items;
const ws = /Project copy \\(edit files here\\): (.+)/.exec(prompt)[1].trim();
const out = /Report path: (.+)/.exec(prompt)[1].trim();
const fixes = [], skipped = [];
for (const it of items) {
  if (it.evidence[0].startsWith("IMPLEMENTATION_SUMMARY.md")) {
    fs.writeFileSync(ws + "/IMPLEMENTATION_SUMMARY.md", "");
    fixes.push({ itemId: it.id, title: "Delete stale summary", explanation: "Nothing links to it.", files: ["IMPLEMENTATION_SUMMARY.md"] });
  }
  else skipped.push({ itemId: it.id, reason: "Not something to change here." });
}
fs.writeFileSync(out, JSON.stringify({ fixes, skipped }));
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0.05 }));
`);
    await fs.chmod(fake, 0o755);
    process.env.LENS_CLAUDE_BIN = fake;
    try {
      expect((await post(`${base}/api/enrich/remediate`, { source: "health" }, auth())).status).toBe(202);
      let job: { state: string; error?: string; fixAll?: { fixed: number; batches: number }; costUsd?: number } = { state: "running" };
      for (let i = 0; i < 200 && job.state === "running"; i++) {
        await new Promise((r) => setTimeout(r, 50));
        job = JSON.parse((await get(`${base}/api/enrich/status`, auth())).body);
      }
      expect(job.error).toBeUndefined();
      expect(job.state).toBe("done");
      expect(job.fixAll?.fixed).toBe(1);
      expect(job.costUsd).toBeCloseTo(0.05 * (job.fixAll?.batches ?? 1)); // costs add up across batches
      await expect(fs.stat(doc)).rejects.toThrow();
      const rec = JSON.parse((await get(`${base}/api/remediation`, auth())).body).records.health;
      const del = rec.fixes.find((f: { status: string }) => f.status === "applied");
      expect(del.files[0].deleted).toBe(true);
      expect((await post(`${base}/api/remediation/undo`, { id: del.id, source: "health" }, auth())).status).toBe(200);
      expect(await fs.readFile(doc, "utf8")).toContain("Changed `src/old/a.ts`");
    } finally {
      delete process.env.LENS_CLAUDE_BIN;
    }
  });
});
