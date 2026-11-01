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
import { randomBytes, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { cloneOrUpdate, listRepos, parseRepo, pushFixes, reposDir } from "./cloud.js";
import { SOURCES, applyFixes, loadRemediation, undoFix, type RemediationSource } from "./remediate.js";
import { EnrichRunner, FIXABLE_CHECKS, HEALTH_BATCH, auditPath, estimateCost, estimateFixAll, fixableCount, remediationItems, checkClaudeAuth, reviewPath, type AuditRecord, type EnrichTask, type ReviewRecord } from "./enrich.js";
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
  cloud?: { workspace: string };
}

const MAX_FILE_BYTES = 2_000_000;
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
      if (req.method === "GET" && url.pathname === "/favicon.ico") return send(res, 204, "");
      if (!url.pathname.startsWith("/api/")) return send(res, 404, { error: "not found" });
      if (!authed(req)) {
        // Slows token guessing on a public host.
        if (opts.cloud) await new Promise((r) => setTimeout(r, 750));
        return send(res, 401, { error: "missing or invalid token" });
      }

      if (req.method === "GET" && url.pathname === "/api/meta") {
        const { graph } = await getGraph();
        return send(res, 200, { project: graph.project, hasEmbeddings: !!proj.embeddings, git: proj.git, root: proj.root, canPick: !opts.cloud && process.platform === "darwin", cloud: !!opts.cloud, repo: repoName(proj.root), canEnrich: !proj.graphFile, enrichEstimates: estimatesFor(graph) });
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
        const body = await readBody(req, 1_000); // the server sets the limit; clients can't raise it
        const opts = JSON.parse(body || "{}") as { source?: unknown; checkId?: unknown };
        const source: RemediationSource = SOURCES.includes(opts.source as RemediationSource) ? (opts.source as RemediationSource) : "audit";
        const checkId = typeof opts.checkId === "string" ? opts.checkId : undefined;
        const budget =
          task === "remediate" && source === "health" && !checkId
            ? estimateFixAll(await fixableCount(proj.root)).limit
            : task === "remediate"
              ? estimateCost("remediate", (await remediationItems(proj.root, source, checkId)).length).limit : estimatesFor((await getGraph()).graph)[task as Exclude<EnrichTask, "remediate">].limit;
        if (enrich.running) return send(res, 409, { error: "an AI run is already in progress" });
        const authProblem = await checkClaudeAuth();
        if (authProblem) return send(res, 412, { error: authProblem });
        return send(res, 202, enrich.start(task, proj.root, budget, { source, checkId }));
      }
      if (req.method === "GET" && url.pathname === "/api/audit") {
        if (proj.graphFile) return send(res, 200, { audit: null });
        const audit = await readJson<AuditRecord>(auditPath(proj.root));
        return send(res, 200, { audit });
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
        const estimate = async (s: RemediationSource) => estimateCost("remediate", (await remediationItems(proj.root, s)).length);
        const healthItems = await fixableCount(proj.root);
        return send(res, 200, { records, estimates: { audit: await estimate("audit"), review: await estimate("review"), health: estimateFixAll(Math.max(1, healthItems)) }, fixableChecks: [...FIXABLE_CHECKS], healthBatch: HEALTH_BATCH, healthItems });
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
      if (opts.cloud && req.method === "GET" && url.pathname === "/api/project/repos") {
        return send(res, 200, { repos: await listRepos(opts.cloud.workspace) });
      }
      if (opts.cloud && req.method === "POST" && url.pathname === "/api/project/push") {
        if (enrich.running) return send(res, 409, { error: "wait for the AI run to finish" });
        if (!repoName(proj.root)) return send(res, 400, { error: "this project isn't a cloned repo" });
        return send(res, 200, await pushFixes(proj.root));
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

/** Per-task cost estimates for the project being served. */
function estimatesFor(g: KnowledgeGraph): Record<Exclude<EnrichTask, "remediate">, ReturnType<typeof estimateCost>> {
  const files = g.nodes.filter((n) => isFileKind(n) && n.path).length;
  const pending = buildBatches(g, { pendingOnly: true }).reduce((a, b) => a + b.files.length, 0);
  return {
    domain: estimateCost("domain", files),
    audit: estimateCost("audit", files),
    review: estimateCost("review", files),
    summaries: estimateCost("summaries", Math.max(1, pending)),
  };
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
