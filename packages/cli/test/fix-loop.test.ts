import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { scanAndSave } from "@lens/core";

/**
 * The whole loop the owner relies on, with GitHub and Claude replaced by fakes:
 * Fix All, open a pull request, CI fails on the fix, Lens repairs it unprompted, CI passes, merge, nothing left pending.
 */

const OWNER = "octo";
const NAME = "app";
const BROKEN_LINE = "const BROKEN = true;";
const LOOP_TIMEOUT_MS = 60_000;
const STEP_MS = 50;

const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function request(method: string, url: string, token: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({ method, host: u.hostname, port: u.port, path: u.pathname + u.search, headers: { "x-lens-token": token, ...(data ? { "Content-Type": "application/json" } : {}) } }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode!, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} }));
    });
    req.on("error", reject);
    req.end(data);
  });
}

async function until<T>(what: string, read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + LOOP_TIMEOUT_MS;
  let last = await read();
  while (!done(last)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; last: ${JSON.stringify(last).slice(0, 1500)}`);
    await new Promise((r) => setTimeout(r, STEP_MS));
    last = await read();
  }
  return last;
}

interface FakePr {
  number: number;
  head: string;
  state: "open" | "closed";
  mergedAt: string | null;
  updatedAt: string;
}

/** GitHub's REST API over a local bare repo. CI fails any commit whose src/app.js still has BROKEN_LINE. */
function fakeGithub(bare: string) {
  const prs: FakePr[] = [];
  const runs = new Map<number, string>();
  const unknown: string[] = [];
  const sha = (ref: string) => git(bare, ["rev-parse", ref]);
  const ciFails = (commit: string) => {
    const file = execFileSync("git", ["show", `${commit}:src/app.js`], { cwd: bare, encoding: "utf8" });
    return file.includes(BROKEN_LINE);
  };
  const prRow = (p: FakePr) => ({ number: p.number, html_url: `https://github.com/${OWNER}/${NAME}/pull/${p.number}`, state: p.state, merged_at: p.mergedAt, updated_at: p.updatedAt, head: { sha: sha(`refs/heads/${p.head}`) }, base: { sha: sha("refs/heads/main") } });
  const squash = (p: FakePr) => {
    const tree = git(bare, ["merge-tree", "--write-tree", "refs/heads/main", `refs/heads/${p.head}`]).split("\n")[0]!;
    const commit = git(bare, ["-c", "user.name=GitHub", "-c", "user.email=noreply@github.com", "commit-tree", tree, "-p", "refs/heads/main", "-m", `Merge #${p.number}`]);
    git(bare, ["update-ref", "refs/heads/main", commit]);
  };
  const route = (method: string, p: string, body: Record<string, unknown>): unknown => {
    const repo = `/repos/${OWNER}/${NAME}`;
    if (method === "GET" && p === "/user") return { id: 1, login: OWNER, name: "Octo" };
    if (method === "GET" && p.startsWith(`${repo}/pulls?`)) {
      const head = decodeURIComponent(new URL(`https://x${p}`).searchParams.get("head")!).split(":")[1];
      return prs.filter((x) => x.head === head).reverse().map(prRow);
    }
    if (method === "POST" && p === `${repo}/pulls`) {
      const pr: FakePr = { number: prs.length + 1, head: String(body.head), state: "open", mergedAt: null, updatedAt: new Date().toISOString() };
      prs.push(pr);
      return prRow(pr);
    }
    const one = /^\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)(\/files.*|\/merge)?$/.exec(p.split("?")[0]!);
    if (one) {
      const pr = prs[Number(one[1]) - 1]!;
      if (!one[2]) return { ...prRow(pr), mergeable: true, mergeable_state: "clean" };
      if (one[2].startsWith("/files")) return git(bare, ["diff", "--name-only", `refs/heads/main...refs/heads/${pr.head}`]).split("\n").filter(Boolean).map((filename) => ({ filename }));
      squash(pr);
      pr.state = "closed";
      pr.mergedAt = new Date().toISOString();
      return { merged: true };
    }
    const checks = /\/commits\/([0-9a-f]+)\/check-runs/.exec(p);
    if (checks) {
      const id = runs.size + 1;
      runs.set(id, checks[1]!);
      return { check_runs: [{ id, name: "test", status: "completed", conclusion: ciFails(checks[1]!) ? "failure" : "success", completed_at: new Date().toISOString() }] };
    }
    const logs = /\/actions\/jobs\/(\d+)\/logs$/.exec(p);
    if (logs) return " FAIL  src/app.test.js\n  × total adds tax\nError: BROKEN is set in src/app.js\n";
    if (method === "DELETE" && p.startsWith(`${repo}/git/refs/heads/`)) {
      git(bare, ["update-ref", "-d", `refs/heads/${decodeURIComponent(p.slice(`${repo}/git/refs/heads/`.length))}`]);
      return null;
    }
    unknown.push(`${method} ${p}`);
    return undefined;
  };
  const realFetch = globalThis.fetch;
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith("https://api.github.com")) return realFetch(input, init);
    const p = url.slice("https://api.github.com".length);
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    const out = route(method, p, body);
    if (out === undefined) return new Response(JSON.stringify({ message: "not in the fake" }), { status: 404 });
    if (typeof out === "string") return new Response(out, { status: 200 });
    return out === null ? new Response(null, { status: 204 }) : new Response(JSON.stringify(out), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  return { fetch, prs, unknown };
}

/** Stands in for Claude Code. Reviews find nothing; fixes edit the project copy; the first fix also breaks CI; a test repair removes the break. */
const FAKE_CLAUDE = `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
const prompt = process.argv[process.argv.indexOf("-p") + 1];
const field = (k) => (new RegExp(k + ": (.+)").exec(prompt) ?? [])[1]?.trim();
const done = () => console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0.01 }));
const log = process.env.FAKE_CLAUDE_LOG;
if (field("Findings path")) {
  fs.appendFileSync(log, "review\\n");
  fs.writeFileSync(field("Findings path"), JSON.stringify({ findings: [] }));
  done();
  process.exit(0);
}
const ws = field("Project copy \\\\(edit files here\\\\)");
const { items } = JSON.parse(fs.readFileSync(field("Items"), "utf8"));
const app = path.join(ws, "src/app.js");
let code = fs.readFileSync(app, "utf8");
const fixes = [];
const skipped = [];
for (const item of items) {
  const kind = item.id.split("~")[0];
  fs.appendFileSync(log, "fix " + kind + "\\n");
  if (kind === "debug-leftovers") {
    code = code.replace(/^.*console\\.log.*\\n/m, "") + ${JSON.stringify(BROKEN_LINE + "\n")};
  } else if (kind === "magic-numbers") {
    code = "const TAX_MULTIPLIER = 1.0825;\\n" + code.replace("price * 1.0825", "price * TAX_MULTIPLIER");
  } else if (kind === "untested") {
    fs.writeFileSync(path.join(ws, "src/app.test.js"), 'import { total } from "./app.js";\\nif (total(100) !== 108.25) throw new Error("total adds tax");\\n');
    fixes.push({ itemId: item.id, title: "Add a test", explanation: "Covers total.", files: ["src/app.test.js"] });
    continue;
  } else if (item.id.startsWith("tests-")) {
    code = code.replace(${JSON.stringify(BROKEN_LINE + "\n")}, "");
  } else {
    skipped.push({ itemId: item.id, reason: "The fake fixer doesn't handle this check." });
    continue;
  }
  fixes.push({ itemId: item.id, title: "Fix " + kind, explanation: "Edited src/app.js.", files: ["src/app.js"] });
}
fs.writeFileSync(app, code);
fs.writeFileSync(field("Report path"), JSON.stringify({ fixes, skipped }));
done();
`;

describe("the fix loop", () => {
  let workspace: string;
  let root: string;
  let bare: string;
  let claudeLog: string;
  let api: string;
  let token: string;
  let close: () => Promise<void>;
  let github: ReturnType<typeof fakeGithub>;

  beforeAll(async () => {
    workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "lens-loop-")));
    bare = path.join(workspace, "remote.git");
    root = path.join(workspace, "repos", OWNER, NAME);
    const seed = path.join(workspace, "seed");
    await fs.mkdir(path.join(seed, "src"), { recursive: true });
    await fs.writeFile(path.join(seed, "src/app.js"), 'export function total(price) {\n  console.log("total", price);\n  return price * 1.0825;\n}\n');
    git(seed, ["init", "-q", "-b", "main"]);
    git(seed, ["add", "-A"]);
    git(seed, ["-c", "user.name=Octo", "-c", "user.email=octo@example.com", "commit", "-q", "-m", "Initial"]);
    git(workspace, ["clone", "-q", "--bare", seed, bare]);
    await fs.mkdir(path.dirname(root), { recursive: true });
    git(workspace, ["clone", "-q", bare, root]);
    const githubUrl = `https://github.com/${OWNER}/${NAME}.git`;
    git(root, ["remote", "set-url", "origin", githubUrl]);
    // Pushes and fetches to the GitHub URL land in the local bare repo.
    git(root, ["config", `url.${bare}.insteadOf`, githubUrl]);
    await fs.appendFile(path.join(root, ".git", "info", "exclude"), "\n.lens/\n");
    await fs.writeFile(path.join(workspace, "github.json"), JSON.stringify({ token: "fake-token", login: OWNER }));

    const fakeClaude = path.join(workspace, "fake-claude.mjs");
    await fs.writeFile(fakeClaude, FAKE_CLAUDE);
    await fs.chmod(fakeClaude, 0o755);
    claudeLog = path.join(workspace, "claude.log");
    await fs.writeFile(claudeLog, "");
    vi.stubEnv("LENS_CLAUDE_BIN", fakeClaude);
    vi.stubEnv("FAKE_CLAUDE_LOG", claudeLog);
    vi.stubEnv("LENS_POLL_MS", "50");
    github = fakeGithub(bare);
    vi.stubGlobal("fetch", github.fetch);

    const { loadGithub } = await import("../src/github.js");
    await loadGithub(workspace);
    await scanAndSave(root, { full: true });
    const { startServer } = await import("../src/server.js");
    const s = await startServer({ root, port: 0, host: "127.0.0.1", cloud: { workspace, login: null } });
    api = s.url.split("/#")[0]!;
    token = s.token;
    close = s.close;
  });

  afterAll(async () => {
    await close?.();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("fixes every item, repairs the broken CI unprompted, merges, and leaves nothing pending", { timeout: LOOP_TIMEOUT_MS * 3 }, async () => {
    const call = (method: string, p: string, body?: unknown) => request(method, `${api}${p}`, token, body);

    expect((await call("POST", "/api/enrich/remediate", { source: "health" })).status).toBe(202);
    const job = await until("the Fix All run", () => call("GET", "/api/enrich/status"), (r) => r.json.state !== "running");
    expect(job.json.error).toBeUndefined();
    expect(job.json.state).toBe("done");
    const fixed = await fs.readFile(path.join(root, "src/app.js"), "utf8");
    expect(fixed).not.toContain("console.log");
    expect(fixed).toContain("TAX_MULTIPLIER");

    const opened = await call("POST", "/api/project/pr");
    expect(opened.status, JSON.stringify(opened.json)).toBe(200);

    type PushState = { state: { branch: string | null; dirty: boolean; pr: { state: string; tests?: { state: string; attempts: number; sha: string } } | null } | null };
    const passed = await until(
      "CI to pass after the automatic repair",
      async () => (await call("GET", "/api/project/push")).json as unknown as PushState,
      (r) => r.state?.pr?.tests?.state === "passed",
    );
    expect(passed.state?.pr?.tests?.attempts).toBe(1);
    const log = (await fs.readFile(claudeLog, "utf8")).split("\n");
    expect(log.filter((l) => l === "fix tests-1")).toHaveLength(1);

    const merged = await call("POST", "/api/project/merge");
    expect(merged.status, JSON.stringify(merged.json)).toBe(200);
    const main = execFileSync("git", ["show", "refs/heads/main:src/app.js"], { cwd: bare, encoding: "utf8" });
    expect(main).not.toContain("console.log");
    expect(main).not.toContain(BROKEN_LINE);
    expect(main).toContain("TAX_MULTIPLIER");

    const after = (await call("GET", "/api/project/push")).json as unknown as PushState;
    expect(after.state).toMatchObject({ branch: null, dirty: false, pr: { state: "merged" } });
    const remediation = (await call("GET", "/api/remediation")).json as { records: Record<string, { fixes: Array<{ itemId: string; mergedIn?: number; undone?: boolean; invalid?: boolean }> } | null> };
    const pending = (remediation.records.health?.fixes ?? []).filter((f) => !f.undone && !f.invalid && f.mergedIn === undefined);
    expect(pending).toEqual([]);
    expect(github.unknown).toEqual([]);
  });
});
