/**
 * Local dashboard server. Threat model: other local processes and web pages in
 * the user's browser. So:
 *  - binds 127.0.0.1 by default
 *  - every /api call needs a random per-run token (header, constant-time compare)
 *  - Host header must be a loopback name (blocks DNS rebinding)
 *  - /api/file serves only paths that are file nodes in the graph, re-checked
 *    with realpath so symlinks can't escape the project
 *  - strict CSP and no CORS headers
 *  - switching projects (/api/project/*) needs the token too, and only opens
 *    directories; the native picker is spawned with an argv array, no shell
 */
import http from "node:http";
import { execFile } from "node:child_process";
import os from "node:os";
import { promises as fs, statSync, realpathSync } from "node:fs";
import path from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { authorizeUrl, disconnectGithub, ensureGithubLoaded, finishOAuth, githubLogin, githubToken, listGithubRepos, loadGithub, oauthAvailable } from "./github.js";
import { cloneOrUpdate, commitFilesAndPush, createPullRequest, fixesPatch, listRepos, mergePullRequest, parseRepo, pullRequestFiles, pushFixes, pushPending, pushState, reposDir, type PushInfo } from "./cloud.js";
import { MAX_TEST_REPAIRS, gateNeedsWork, recordRepairAttempt, repairItems, saveRepairItems, type TestGate } from "./ci.js";
import { grantCheckPermissions } from "./ci-permissions.js";
import type { AppliedFix } from "./commit-text.js";
import { SOURCES, applyFixes, loadRemediation, undoFix, type RemediationSource } from "./remediate.js";
import { EnrichRunner, HEALTH_BATCH, markVerifiedSafe, auditPath, auditWithDecisions, saveDecision, loadWontFix, setWontFix, estimateCost, reviewEstimate, reviewPlan, type CostEstimate, fixAllPlan, remediateLimit, remediationItems, TEST_REPAIR_ID, checkClaudeAuth, reviewPath, type AuditRecord, type EnrichTask, type ReviewRecord } from "./enrich.js";
import {
  buildBatches, diffImpact, isGitRepo, loadGraph, paths, readJson, scanAndSave, EmbeddingIndex, isFileKind,
  type EmbeddingStore, type KnowledgeGraph,
} from "@lens/core";

export interface ServeOptions {
  root: string;
  port: number;
  host: string;
  token?: string;
  graphFile?: string;
  /** Hosted mode: projects are GitHub repos cloned under this workspace folder. */
  cloud?: { workspace: string; login: { username: string; password: string } | null };
}

const MAX_FILE_BYTES = 2_000_000;
/** How often the test watcher asks GitHub about a pull request's CI. */
const TEST_POLL_MS = 30_000;
const JOB_POLL_MS = 5_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function dashboardHtmlPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.join(here, "dashboard.html"), path.resolve(here, "../../dashboard/dist/index.html")];
  for (const c of candidates) {
    try {
      statSync(c);
      return c;
    } catch { /* next */ }
  }
  throw new Error("Dashboard build not found. Run `pnpm build` in the Lens repo.");
}

const CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src blob:",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

export async function startServer(opts: ServeOptions): Promise<{ url: string; token: string; close: () => Promise<void> }> {
  const token = opts.token ?? randomBytes(24).toString("base64url");
  const tokenBuf = Buffer.from(token);
  const html = await fs.readFile(dashboardHtmlPath(), "utf8");

  // Everything tied to the project being shown. Replaced wholesale on /api/project/open.
  interface Project {
    root: string;
    graphPath: string;
    graphFile?: string;
    cache: { mtime: number; graph: KnowledgeGraph; allowed: Set<string> } | null;
    embeddings: EmbeddingIndex | null;
    git: boolean;
  }
  const loadProject = async (dir: string, graphFile?: string): Promise<Project> => {
    const root = realpathSync(path.resolve(dir));
    const store = await readJson<EmbeddingStore>(paths(root).embeddings);
    return {
      root,
      graphFile,
      graphPath: graphFile ? path.resolve(graphFile) : paths(root).graph,
      cache: null,
      embeddings: store && Object.keys(store.vectors).length ? new EmbeddingIndex(store) : null,
      git: isGitRepo(root),
    };
  };
  /** `owner/name` when `root` is a repo cloned into the cloud workspace. */
  const repoName = (root: string): string | null => {
    if (!opts.cloud) return null;
    const rel = path.relative(realpathSync(reposDir(opts.cloud.workspace)), root);
    const parts = rel.split(path.sep);
    return parts.length === 2 && !rel.startsWith("..") ? parts.join("/") : null;
  };
  let proj = await loadProject(opts.root, opts.graphFile);

  const getGraph = async (p: Project = proj) => {
    const st = await fs.stat(p.graphPath);
    if (!p.cache || p.cache.mtime !== st.mtimeMs) {
      const g = p.graphFile ? await readJson<KnowledgeGraph>(p.graphPath) : await loadGraph(p.root);
      if (!g) throw new Error("Could not read graph");
      const allowed = new Set(g.nodes.filter((n) => n.path && (isFileKind(n) || n.kind === "article" || n.kind === "source")).map((n) => n.path!));
      p.cache = { mtime: st.mtimeMs, graph: g, allowed };
    }
    return p.cache;
  };
  await getGraph(); // fail fast

  const enrich = new EnrichRunner();
  // After Lens opens or updates a pull request, wait for its CI. Tests Lens broke get a repair
  // run, and the repair is pushed to the same pull request, up to MAX_TEST_REPAIRS times.
  let watchingTests: string | null = null;
  const permissionTries = new Set<string>();
  /** A check refused a GITHUB_TOKEN permission: grant it in the workflow and push. Once per head commit. */
  const grantRefusedPermissions = async (root: string, gate: TestGate): Promise<boolean> => {
    const key = `${root}#${gate.pr}@${gate.sha}`;
    if (permissionTries.has(key)) return false;
    permissionTries.add(key);
    const files = new Set<string>();
    const granted: string[] = [];
    for (const check of gate.broken.filter((b) => b.permissions?.length)) {
      const file = await grantCheckPermissions(root, check.name, check.permissions!);
      if (!file) continue;
      files.add(file);
      granted.push(`${check.name} (${check.permissions!.join(", ")})`);
    }
    if (!files.size) return false;
    console.log(`[tests] PR #${gate.pr}: granting workflow permissions to ${granted.join("; ")}`);
    await commitFilesAndPush(root, [...files], `Grant CI jobs the GitHub token permissions they need\n\n${granted.join("\n")}`);
    return true;
  };
  const repairingTests = () => enrich.running && enrich.job?.checkId === TEST_REPAIR_ID;
  const withRepairFlag = (st: PushInfo | null): PushInfo | null =>
    st?.pr?.tests && repairingTests() ? { ...st, pr: { ...st.pr, tests: { ...st.pr.tests, repairing: true } } } : st;
  const watchTests = async (root: string) => {
    if (watchingTests === root) return;
    watchingTests = root;
    try {
      while (proj.root === root) {
        if (enrich.running) {
          await sleep(TEST_POLL_MS);
          continue;
        }
        const st = await pushState(root);
        const gate = st?.pr?.state === "open" ? st.pr.tests : undefined;
        if (!gate || st?.dirty) return;
        if (gate.state === "running") {
          await sleep(TEST_POLL_MS);
          continue;
        }
        if (gate.state !== "broken") return;
        if (await grantRefusedPermissions(root, gate)) continue;
        if (gate.attempts >= MAX_TEST_REPAIRS) return;
        const authProblem = await checkClaudeAuth();
        if (authProblem) return console.error(`[tests] can't repair: ${authProblem}`);
        const items = repairItems(gate, await pullRequestFiles(root, gate.pr).catch(() => []));
        await saveRepairItems(root, items);
        await recordRepairAttempt(root, gate.pr);
        console.log(`[tests] PR #${gate.pr} broke ${items.length} check(s); repair ${gate.attempts + 1} of ${MAX_TEST_REPAIRS}`);
        const job = enrich.start("remediate", root, remediateLimit(TEST_REPAIR_ID, items.length), { source: "health", checkId: TEST_REPAIR_ID });
        while (job.state === "running") await sleep(JOB_POLL_MS);
        if (job.state !== "done" || !job.remediation?.applied) return console.error(`[tests] repair made no changes${job.error ? `: ${job.error}` : ""}`);
        await pushPending(root, await appliedFixes(root));
      }
    } catch (e) {
      console.error(`[tests] ${e instanceof Error ? e.message : e}`);
    } finally {
      watchingTests = null;
    }
  };
  let switching = false;
  /** Scan `dir` (incremental when it already has a graph) and make it the served project. */
  const openProject = async (dir: string) => {
    let real: string;
    try {
      real = realpathSync(path.resolve(dir));
    } catch {
      throw new HttpFail(404, "folder not found");
    }
    if (!statSync(real).isDirectory()) throw new HttpFail(400, "not a folder");
    if (real === path.parse(real).root || real === os.homedir()) throw new HttpFail(400, "pick a project folder, not your whole disk or home folder");
    if (switching) throw new HttpFail(409, "already opening a project");
    if (enrich.running) throw new HttpFail(409, "wait for the AI run to finish before switching projects");
    switching = true;
    try {
      await scanAndSave(real);
      await markVerifiedSafe(real);
      const next = await loadProject(real);
      await getGraph(next);
      proj = next;
      return { root: real, project: next.cache!.graph.project };
    } finally {
      switching = false;
    }
  };

  const send = (res: http.ServerResponse, status: number, body: unknown, type = "application/json; charset=utf-8") => {
    const data = typeof body === "string" ? body : JSON.stringify(body);
    res.writeHead(status, {
      "content-type": type,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "cross-origin-opener-policy": "same-origin",
      "cross-origin-resource-policy": "same-origin",
      ...(type.startsWith("text/html") ? { "content-security-policy": CSP, "x-frame-options": "DENY" } : {}),
    });
    res.end(data);
  };

  if (opts.cloud) await loadGithub(opts.cloud.workspace);
  /** OAuth callback on this host, as the browser sees it behind Railway's proxy. */
  const callbackUrl = (req: http.IncomingMessage) => {
    const first = (h: string | string[] | undefined) => (Array.isArray(h) ? h[0] : h)?.split(",")[0]?.trim();
    const proto = first(req.headers["x-forwarded-proto"]) ?? "http";
    const host = first(req.headers["x-forwarded-host"]) ?? req.headers.host ?? "localhost";
    return `${proto}://${host}/github/callback`;
  };

  const authed = (req: http.IncomingMessage) => {
    const h = req.headers["x-lens-token"];
    const v = Buffer.from(Array.isArray(h) ? h[0] ?? "" : h ?? "");
    return v.length === tokenBuf.length && timingSafeEqual(v, tokenBuf);
  };

  const server = http.createServer(async (req, res) => {
    try {
      const hostHeader = (req.headers.host ?? "").replace(/:\d+$/, "");
      if (!LOOPBACK.has(hostHeader) && opts.host !== "0.0.0.0" && !opts.cloud) return send(res, 421, { error: "bad host" });
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) return send(res, 200, html, "text/html; charset=utf-8");
      if (opts.cloud && url.pathname.startsWith("/api/")) await ensureGithubLoaded();
      if (req.method === "GET" && url.pathname === "/favicon.ico") return send(res, 204, "");
      if (opts.cloud && req.method === "GET" && url.pathname === "/github/callback") {
        try {
          await finishOAuth(url.searchParams.get("code") ?? "", url.searchParams.get("state") ?? "", callbackUrl(req));
        } catch (e) {
          return send(res, 400, `GitHub sign-in failed: ${(e as Error).message}\n`, "text/plain; charset=utf-8");
        }
        res.writeHead(302, { location: "/" });
        return res.end();
      }
      if (!url.pathname.startsWith("/api/")) return send(res, 404, { error: "not found" });
      if (req.method === "GET" && url.pathname === "/api/auth") return send(res, 200, { login: !!opts.cloud });
      if (opts.cloud && req.method === "POST" && url.pathname === "/api/login") {
        const login = opts.cloud.login;
        if (!login) return send(res, 503, { error: "Login isn't set up. Add LENS_USERNAME and LENS_PASSWORD in Railway." });
        let body: { username?: unknown; password?: unknown } = {};
        try {
          body = JSON.parse(await readBody(req, 2_000)) as typeof body;
        } catch {
          /* falls through to a failed login */
        }
        const same = (a: unknown, b: string) =>
          typeof a === "string" && timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
        const userOk = same(body.username, login.username);
        const passOk = same(body.password, login.password);
        if (!userOk || !passOk) {
          await new Promise((r) => setTimeout(r, 750));
          return send(res, 403, { error: "Wrong username or password." });
        }
        return send(res, 200, { token });
      }
      if (!authed(req)) {
        // Slows token guessing on a public host.
        if (opts.cloud) await new Promise((r) => setTimeout(r, 750));
        return send(res, 401, { error: "missing or invalid token" });
      }

      if (req.method === "GET" && url.pathname === "/api/meta") {
        const { graph } = await getGraph();
        return send(res, 200, { project: graph.project, hasEmbeddings: !!proj.embeddings, git: proj.git, root: proj.root, canPick: !opts.cloud && process.platform === "darwin", cloud: !!opts.cloud, canPush: !!opts.cloud && !!githubToken(), github: opts.cloud ? { available: oauthAvailable(), login: githubLogin() } : undefined, repo: repoName(proj.root), canEnrich: !proj.graphFile, ...(await estimatesFor(proj.root, graph, !proj.graphFile)) });
      }
      if (req.method === "GET" && url.pathname === "/api/graph") {
        const { graph } = await getGraph();
        return send(res, 200, graph);
      }
      if (req.method === "GET" && url.pathname === "/api/file") {
        const rel = url.searchParams.get("path") ?? "";
        const { allowed } = await getGraph();
        if (!rel || !allowed.has(rel) || rel.includes("\0")) return send(res, 403, { error: "path not in graph" });
        const { root } = proj;
        const abs = path.resolve(root, rel);
        let real: string;
        try {
          real = realpathSync(abs);
        } catch {
          return send(res, 404, { error: "file not found" });
        }
        if (!real.startsWith(root + path.sep)) return send(res, 403, { error: "path escapes project" });
        const st = await fs.stat(real);
        if (st.size > MAX_FILE_BYTES) return send(res, 413, { error: "file too large" });
        const content = await fs.readFile(real, "utf8");
        const node = (await getGraph()).graph.nodes.find((n) => n.path === rel && isFileKind(n));
        return send(res, 200, { path: rel, language: node?.language ?? "text", content });
      }
      if (req.method === "GET" && url.pathname === "/api/diff") {
        if (!proj.git) return send(res, 409, { error: "not a git repository" });
        const base = url.searchParams.get("base") ?? undefined;
        const { graph } = await getGraph();
        try {
          return send(res, 200, diffImpact(proj.root, graph, { base }));
        } catch (e) {
          return send(res, 400, { error: (e as Error).message.split("\n")[0] });
        }
      }
      if (req.method === "POST" && url.pathname === "/api/search/embed") {
        const { embeddings } = proj;
        if (!embeddings) return send(res, 404, { error: "no embeddings; run `lens embed`" });
        const body = await readBody(req, 10_000);
        const q = (JSON.parse(body) as { q?: unknown }).q;
        if (typeof q !== "string" || !q.trim() || q.length > 500) return send(res, 400, { error: "q must be a non-empty string" });
        return send(res, 200, { results: await embeddings.query(q, 40) });
      }
      const enrichMatch = /^\/api\/enrich\/(domain|audit|summaries|review|remediate)$/.exec(url.pathname);
      if (req.method === "POST" && enrichMatch) {
        const task = enrichMatch[1] as EnrichTask;
        if (proj.graphFile) return send(res, 409, { error: "AI runs need a scanned project, not --graph" });
        const body = await readBody(req, 2_000); // the server sets the limit; clients can't raise it
        const opts = JSON.parse(body || "{}") as { source?: unknown; checkId?: unknown; note?: unknown; fixNew?: unknown };
        const note = typeof opts.note === "string" && opts.note.trim() ? opts.note.trim().slice(0, 600) : undefined;
        const source: RemediationSource = SOURCES.includes(opts.source as RemediationSource) ? (opts.source as RemediationSource) : "audit";
        const checkId = typeof opts.checkId === "string" ? opts.checkId : undefined;
        const budget =
          task === "remediate" && source !== "review" && !checkId
            ? (await fixAllPlan(proj.root, source)).estimate.limit
            : task === "remediate"
              ? remediateLimit(checkId, (await remediationItems(proj.root, source, checkId)).length) : (await estimatesFor(proj.root, (await getGraph()).graph, true)).enrichEstimates[task as Exclude<EnrichTask, "remediate">].limit;
        if (enrich.running) return send(res, 409, { error: "an AI run is already in progress" });
        const authProblem = await checkClaudeAuth();
        if (authProblem) return send(res, 412, { error: authProblem });
        return send(res, 202, enrich.start(task, proj.root, budget, { source, checkId, note, fixNew: task === "review" && opts.fixNew === true }));
      }
      if (req.method === "GET" && url.pathname === "/api/audit") {
        if (proj.graphFile) return send(res, 200, { audit: null });
        return send(res, 200, { audit: await auditWithDecisions(proj.root) });
      }
      if (req.method === "POST" && url.pathname === "/api/checklist/decide") {
        if (proj.graphFile) return send(res, 400, { error: "read-only graph" });
        let body: { id?: unknown; status?: unknown } = {};
        try {
          body = JSON.parse((await readBody(req, 1_000)) || "{}") as typeof body;
        } catch {
          return send(res, 400, { error: "bad JSON" });
        }
        const graph = await loadGraph(proj.root);
        const known = new Set((graph?.security?.checklist ?? []).map((c) => c.id));
        if (typeof body.id !== "string" || !known.has(body.id)) return send(res, 400, { error: "unknown checklist item" });
        if (body.status !== null && body.status !== "pass" && body.status !== "fail" && body.status !== "na") return send(res, 400, { error: "status must be pass, fail, na or null" });
        await saveDecision(proj.root, body.id, body.status as "pass" | "fail" | "na" | null);
        return send(res, 200, { audit: await auditWithDecisions(proj.root) });
      }
      if (req.method === "GET" && url.pathname === "/api/review") {
        if (proj.graphFile) return send(res, 200, { review: null });
        return send(res, 200, { review: await readJson<ReviewRecord>(reviewPath(proj.root)) });
      }
      if (req.method === "GET" && url.pathname === "/api/remediation") {
        if (proj.graphFile) return send(res, 200, { remediation: null });
        // Edits stay server-side; the dashboard gets diffs.
        const records: Record<string, unknown> = {};
        for (const s of SOURCES) {
          const rec = await loadRemediation(proj.root, s);
          if (rec?.legacyIds && s === "review") {
            const ids = (await remediationItems(proj.root, "review")).map((i) => i.id); // high/medium, in order
            for (const f of rec.fixes) {
              const k = /^review-(\d+)$/.exec(f.itemId);
              if (k && ids[Number(k[1]) - 1]) f.itemId = ids[Number(k[1]) - 1]!;
            }
          }
          records[s] = rec && { ...rec, edits: undefined, legacyIds: undefined };
        }
        const audit = await fixAllPlan(proj.root, "audit");
        const health = await fixAllPlan(proj.root, "health");
        const review = estimateCost("remediate", (await remediationItems(proj.root, "review")).length);
        return send(res, 200, {
          records,
          estimates: { audit: audit.estimate, review, health: health.estimate },
          fixAll: { audit: { items: audit.items, first: audit.first }, health: { items: health.items, first: health.first } },
          healthBatch: HEALTH_BATCH,
          healthItems: health.items,
          wontFix: await loadWontFix(proj.root),
        });
      }
      if (req.method === "POST" && url.pathname === "/api/items/wontfix") {
        if (proj.graphFile) return send(res, 400, { error: "read-only graph" });
        const { id, on } = JSON.parse((await readBody(req, 1_000)) || "{}") as { id?: unknown; on?: unknown };
        if (typeof id !== "string" || !/^[\w.~-]{1,120}$/.test(id) || typeof on !== "boolean") return send(res, 400, { error: "id and on are required" });
        await setWontFix(proj.root, id, on);
        return send(res, 200, { wontFix: await loadWontFix(proj.root) });
      }
      if (req.method === "POST" && url.pathname === "/api/remediation/apply") {
        if (enrich.running) return send(res, 409, { error: "wait for the AI run to finish" });
        const { ids, source } = JSON.parse((await readBody(req, 10_000)) || "{}") as { ids?: unknown; source?: unknown };
        if (!Array.isArray(ids) || !ids.length || ids.length > 30 || !ids.every((x) => typeof x === "string")) return send(res, 400, { error: "ids must be a non-empty list" });
        if (!SOURCES.includes(source as RemediationSource)) return send(res, 400, { error: "source must be audit, review, or health" });
        const result = await applyFixes(proj.root, source as RemediationSource, ids as string[]);
        if (result.applied.length) await scanAndSave(proj.root);
        return send(res, 200, result);
      }
      if (req.method === "POST" && url.pathname === "/api/remediation/undo") {
        const { id, source } = JSON.parse((await readBody(req, 1_000)) || "{}") as { id?: unknown; source?: unknown };
        if (typeof id !== "string" || !SOURCES.includes(source as RemediationSource)) return send(res, 400, { error: "id and source required" });
        await undoFix(proj.root, source as RemediationSource, id);
        await scanAndSave(proj.root);
        return send(res, 200, { ok: true });
      }
      if (req.method === "GET" && url.pathname === "/api/enrich/status") {
        return send(res, 200, enrich.job && enrich.job.root === proj.root ? enrich.job : { state: "idle" });
      }
      if (req.method === "POST" && url.pathname === "/api/enrich/cancel") {
        enrich.cancel();
        return send(res, 200, enrich.job ?? { state: "idle" });
      }
      if (opts.cloud && req.method === "GET" && url.pathname === "/api/github/connect") {
        if (!oauthAvailable()) return send(res, 400, { error: "Add GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET in Railway." });
        return send(res, 200, { url: authorizeUrl(callbackUrl(req)) });
      }
      if (opts.cloud && req.method === "POST" && url.pathname === "/api/github/disconnect") {
        await disconnectGithub();
        return send(res, 200, { ok: true });
      }
      if (opts.cloud && req.method === "GET" && url.pathname === "/api/github/repos") {
        try {
          return send(res, 200, { repos: await listGithubRepos() });
        } catch (e) {
          return send(res, 502, { error: (e as Error).message });
        }
      }
      if (opts.cloud && req.method === "GET" && url.pathname === "/api/project/repos") {
        return send(res, 200, { repos: await listRepos(opts.cloud.workspace) });
      }
      if (opts.cloud && req.method === "GET" && url.pathname === "/api/project/patch") {
        if (!repoName(proj.root)) return send(res, 400, { error: "this project isn't a cloned repo" });
        const patch = await fixesPatch(proj.root);
        if (!patch) return send(res, 400, { error: "No changes to download." });
        return send(res, 200, { name: `${repoName(proj.root)!.replace("/", "-")}-lens-fixes.patch`, patch });
      }
      if (opts.cloud && req.method === "GET" && url.pathname === "/api/project/push") {
        const st = repoName(proj.root) ? await pushState(proj.root) : null;
        const tests = st?.pr?.state === "open" ? st.pr.tests : undefined;
        if (tests && gateNeedsWork(tests)) void watchTests(proj.root);
        return send(res, 200, { state: withRepairFlag(st) });
      }
      if (opts.cloud && req.method === "POST" && url.pathname === "/api/project/push") {
        if (!githubToken()) return send(res, 400, { error: "Connect GitHub to push, or use Download Patch." });
        if (enrich.running) return send(res, 409, { error: "wait for the AI run to finish" });
        if (!repoName(proj.root)) return send(res, 400, { error: "this project isn't a cloned repo" });
        return send(res, 200, await pushFixes(proj.root, await appliedFixes(proj.root)));
      }
      if (opts.cloud && req.method === "POST" && (url.pathname === "/api/project/pr" || url.pathname === "/api/project/merge")) {
        if (!githubToken()) return send(res, 400, { error: "Connect GitHub first." });
        if (enrich.running) return send(res, 409, { error: "wait for the AI run to finish" });
        if (!repoName(proj.root)) return send(res, 400, { error: "this project isn't a cloned repo" });
        if (url.pathname === "/api/project/merge") {
          const pr = await mergePullRequest(proj.root);
          await scanAndSave(proj.root);
          return send(res, 200, { pr });
        }
        const pr = await createPullRequest(proj.root, await appliedFixes(proj.root));
        void watchTests(proj.root);
        return send(res, 200, { pr });
      }
      if (req.method === "POST" && url.pathname === "/api/project/pick") {
        if (opts.cloud) return send(res, 501, { error: "enter a GitHub repo instead" });
        if (process.platform !== "darwin") return send(res, 501, { error: "the folder picker is only available on macOS; type a path instead" });
        const picked = await pickFolder(path.dirname(proj.root));
        if (!picked) return send(res, 200, { cancelled: true });
        return send(res, 200, await openProject(picked));
      }
      if (req.method === "POST" && url.pathname === "/api/project/open") {
        const body = await readBody(req, 10_000);
        if (opts.cloud) {
          const spec = (JSON.parse(body) as { repo?: unknown; path?: unknown });
          const raw = typeof spec.repo === "string" ? spec.repo : typeof spec.path === "string" ? spec.path : "";
          const r = raw.length <= 300 ? parseRepo(raw) : null;
          if (!r) return send(res, 400, { error: "enter a GitHub repo, like owner/name" });
          if (enrich.running) return send(res, 409, { error: "wait for the AI run to finish before switching projects" });
          const dir = await cloneOrUpdate(opts.cloud.workspace, r);
          const opened = await openProject(dir);
          await fs.writeFile(path.join(opts.cloud.workspace, "last-repo"), `${r.owner}/${r.name}\n`).catch(() => undefined);
          return send(res, 200, opened);
        }
        const dir = (JSON.parse(body) as { path?: unknown }).path;
        if (typeof dir !== "string" || !dir.trim() || dir.length > 4096 || dir.includes("\0")) return send(res, 400, { error: "path must be a non-empty string" });
        const expanded = dir.trim().replace(/^~(?=$|\/)/, os.homedir());
        if (!path.isAbsolute(expanded)) return send(res, 400, { error: "use an absolute path (or ~/...)" });
        return send(res, 200, await openProject(expanded));
      }
      return send(res, 404, { error: "not found" });
    } catch (e) {
      if (e instanceof HttpFail) return send(res, e.status, { error: e.message });
      return send(res, 500, { error: (e as Error).message.slice(0, 200) });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host, () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : opts.port;
  const hostForUrl = opts.host === "0.0.0.0" || opts.host === "127.0.0.1" ? "127.0.0.1" : opts.host;
  return {
    url: `http://${hostForUrl}:${port}/#token=${token}`,
    token,
    close: () => {
      enrich.cancel();
      return new Promise((r) => server.close(() => r()));
    },
  };
}

class HttpFail extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** macOS "Choose Folder" dialog. Resolves null when the user cancels. */
function pickFolder(startIn: string): Promise<string | null> {
  const script = [
    "on run argv",
    "tell me to activate",
    'set p to choose folder with prompt "Choose a project for Lens" default location (POSIX file (item 1 of argv))',
    "return POSIX path of p",
    "end run",
  ];
  const args = script.flatMap((l) => ["-e", l]).concat(startIn);
  return new Promise((resolve, reject) => {
    execFile("osascript", args, { timeout: 10 * 60_000 }, (err, stdout, stderr) => {
      if (err) {
        // -128 is "User canceled."
        if (/-128/.test(stderr) || /-128/.test(err.message)) return resolve(null);
        return reject(new Error(`folder picker failed: ${stderr.trim() || err.message}`));
      }
      const p = stdout.trim();
      resolve(p ? p.replace(/\/$/, "") || "/" : null);
    });
  });
}

/** Per-task cost estimates for the project being served, and the files waiting for review. */
/** Applied fixes across every source, for commit messages and pull request text. */
async function appliedFixes(root: string): Promise<AppliedFix[]> {
  const fixes: AppliedFix[] = [];
  for (const src of SOURCES) {
    for (const f of (await loadRemediation(root, src))?.fixes ?? []) if (f.status === "applied") fixes.push({ title: f.title, files: f.files.map((file) => file.path) });
  }
  return fixes;
}

async function estimatesFor(root: string, g: KnowledgeGraph, hasSource: boolean) {
  const files = g.nodes.filter((n) => isFileKind(n) && n.path).length;
  const pending = buildBatches(g, { pendingOnly: true }).reduce((a, b) => a + b.files.length, 0);
  const review = hasSource ? await reviewPlan(root, g) : { files: 0, batches: 0, estimate: reviewEstimate(0) };
  const enrichEstimates: Record<Exclude<EnrichTask, "remediate">, CostEstimate> = {
    domain: estimateCost("domain", files),
    audit: estimateCost("audit", files),
    review: review.estimate,
    summaries: estimateCost("summaries", Math.max(1, pending)),
  };
  return { enrichEstimates, reviewPending: { files: review.files, batches: review.batches } };
}

function readBody(req: http.IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
