import type { ImpactReport, KnowledgeGraph, ProjectMeta } from "@lens/core/browser";
import { sessionGet, sessionSet } from "./utils/storage";

declare global {
  interface Window {
    __LENS_GRAPH__?: unknown;
    __LENS_DIFF__?: unknown;
  }
}

export type DataMode = "embedded" | "server" | "dev";

export interface Meta {
  project: ProjectMeta;
  hasEmbeddings: boolean;
  git: boolean;
  /** Absolute folder being served (server mode only). */
  root?: string;
  /** The server can open the native folder picker (macOS). */
  canPick?: boolean;
  /** Hosted server: projects are GitHub repos and fixes leave as a pushed branch. */
  cloud?: boolean;
  /** Hosted server: GitHub sign-in state. */
  github?: { available: boolean; login: string | null };
  /** Hosted server can push fix branches. */
  canPush?: boolean;
  /** `owner/name` of the repo being shown (hosted server only). */
  repo?: string | null;
  /** The server can run Claude Code to enrich the graph. */
  canEnrich?: boolean;
  /** Expected cost per AI run for this project, and the server's safety limit. */
  enrichEstimates?: Record<"domain" | "audit" | "summaries" | "review", { low: number; high: number; limit: number }>;
}

export interface AuditRecord {
  generatedAt: string;
  costUsd?: number;
  summary?: string;
  report: string;
  items: Array<{ id: string; status: "pass" | "fail" | "unverified" | "na"; evidence: string[]; fix?: string; by?: "you" }>;
}

export interface EnrichJob {
  task?: "domain" | "audit" | "summaries" | "review" | "remediate";
  state: "idle" | "running" | "done" | "error" | "cancelled";
  startedAt?: number;
  finishedAt?: number;
  budgetUsd?: number;
  progress?: string[];
  costUsd?: number;
  error?: string;
  result?: { domains: number; flows: number; dropped: number };
  audit?: { items: number; failing: number; report: string };
  summaries?: { batchesDone: number; batchesTotal: number; files: number; stoppedEarly?: string };
  review?: { findings: number; report: string };
  remediation?: { source: RemediationSource; proposed: number; invalid: number; skipped: number };
  source?: RemediationSource;
  checkId?: string;
  fixAll?: { attempted: number; total: number; fixed: number; batches: number; stopped?: string };
  step?: { kind: "audit" | "review"; startedAt: number; typicalMs?: number };
}

export interface ProposedFix {
  id: string;
  itemId: string;
  title: string;
  explanation: string;
  files: Array<{ path: string; diff: string; created: boolean }>;
  invalid?: string;
  status: "proposed" | "applied" | "undone" | "discarded";
}
export type RemediationSource = "audit" | "review" | "health";
export interface RemediationRecord {
  generatedAt: string;
  source: RemediationSource;
  checkId?: string;
  costUsd?: number;
  summary?: string;
  fixes: ProposedFix[];
  skipped: Array<{ itemId: string; reason: string }>;
}
export type CostEstimate = { low: number; high: number; limit: number };

export interface ReviewRecord {
  generatedAt: string;
  costUsd?: number;
  summary?: string;
  report: string;
  findings: Array<{ title: string; severity: "high" | "medium" | "low"; category: string; path: string; line?: number; detail: string; fix?: string }>;
}

export interface FilePayload {
  path: string;
  language: string;
  content: string;
}

export class UnauthorizedError extends Error {
  constructor() {
    super("Unauthorized");
    this.name = "UnauthorizedError";
  }
}
export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "HttpError";
  }
}
export class SourceUnavailableError extends Error {
  constructor(message = "Source not available in static export") {
    super(message);
    this.name = "SourceUnavailableError";
  }
}

const TOKEN_KEY = "lens.token";
let token: string | null = null;

/** Pick up `#token=...`, persist it for the tab session, and strip it from the URL. */
export function initToken(): string | null {
  const m = /(?:^#|&)token=([^&]+)/.exec(window.location.hash);
  if (m) {
    token = decodeURIComponent(m[1]!);
    sessionSet(TOKEN_KEY, token);
    const rest = window.location.hash.replace(/(^#|&)token=[^&]+/, "$1").replace(/^#&/, "#");
    try {
      const url = window.location.pathname + window.location.search + (rest === "#" ? "" : rest);
      window.history.replaceState(null, "", url);
    } catch {
      /* file:// or sandboxed */
    }
  } else {
    token = sessionGet(TOKEN_KEY);
  }
  return token;
}

export function setToken(t: string | null): void {
  token = t && t.trim() ? t.trim() : null;
  sessionSet(TOKEN_KEY, token);
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (token) headers.set("X-Lens-Token", token);
  headers.set("Accept", "application/json");
  const res = await fetch(path, { ...init, headers, credentials: "same-origin" });
  if (res.status === 401) throw new UnauthorizedError();
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) msg = body.error;
    } catch {
      /* not json */
    }
    throw new HttpError(res.status, msg);
  }
  const type = res.headers.get("content-type") ?? "";
  if (!type.includes("json")) throw new HttpError(res.status, `Expected JSON from ${path}`);
  return (await res.json()) as T;
}

export function detectMode(): DataMode {
  if (window.__LENS_GRAPH__ && typeof window.__LENS_GRAPH__ === "object") return "embedded";
  if (import.meta.env.DEV && !token) return "dev";
  return "server";
}

export interface InitialData {
  mode: DataMode;
  graph: unknown;
  meta: Meta | null;
  diff: ImpactReport | null;
}

export async function loadInitial(mode: DataMode): Promise<InitialData> {
  if (mode === "embedded") {
    const diff = window.__LENS_DIFF__ && typeof window.__LENS_DIFF__ === "object" ? (window.__LENS_DIFF__ as ImpactReport) : null;
    return { mode, graph: window.__LENS_GRAPH__, meta: null, diff };
  }
  if (mode === "dev") {
    const res = await fetch("/sample-graph.json");
    if (!res.ok) throw new HttpError(res.status, "Could not load public/sample-graph.json");
    return { mode, graph: await res.json(), meta: null, diff: null };
  }
  const [meta, graph] = await Promise.all([request<Meta>("/api/meta"), request<KnowledgeGraph>("/api/graph")]);
  return { mode, graph, meta, diff: null };
}

const fileCache = new Map<string, Promise<FilePayload>>();

export function fetchFile(mode: DataMode, path: string): Promise<FilePayload> {
  if (mode !== "server") {
    return Promise.reject(new SourceUnavailableError(mode === "dev" ? "Source not available with the dev fixture (run `lens serve`)" : undefined));
  }
  let p = fileCache.get(path);
  if (!p) {
    p = request<FilePayload>(`/api/file?path=${encodeURIComponent(path)}`);
    fileCache.set(path, p);
    p.catch(() => fileCache.delete(path));
  }
  return p;
}

export function clearFileCache(): void {
  fileCache.clear();
}

type OpenResult = { root: string; project: ProjectMeta };

/** Opens the native folder dialog on the machine running `lens serve`, then scans the pick. */
export function pickProjectFolder(): Promise<OpenResult | { cancelled: true }> {
  return request("/api/project/pick", { method: "POST" });
}

export function openProjectPath(path: string): Promise<OpenResult> {
  return request("/api/project/open", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
}

export function startAIJob(task: NonNullable<EnrichJob["task"]>, opts: { source?: RemediationSource; checkId?: string; note?: string } = {}): Promise<EnrichJob> {
  return request(`/api/enrich/${task}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(opts) });
}
export type FixAllPlans = Record<"audit" | "health", { items: number; first: "audit" | "review" | null }>;
export const fetchRemediation = () =>
  request<{ records: Record<RemediationSource, RemediationRecord | null>; estimates: Record<RemediationSource, CostEstimate>; fixAll: FixAllPlans; fixableChecks: string[]; healthBatch: number; healthItems: number; wontFix?: string[] }>("/api/remediation");
export const applyRemediation = (source: RemediationSource, ids: string[]) =>
  request<{ applied: string[]; failed: Array<{ id: string; error: string }> }>("/api/remediation/apply", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source, ids }) });
export const undoRemediation = (source: RemediationSource, id: string) =>
  request<{ ok: true }>("/api/remediation/undo", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source, id }) });
export const fetchReview = () => request<{ review: ReviewRecord | null }>("/api/review").then((r) => r.review);
export const fetchAudit = () => request<{ audit: AuditRecord | null }>("/api/audit").then((r) => r.audit);
export const decideCheck = (id: string, status: "pass" | "fail" | "na" | null) =>
  request<{ audit: AuditRecord | null }>("/api/checklist/decide", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, status }) }).then((r) => r.audit);
export const fetchEnrichStatus = () => request<EnrichJob>("/api/enrich/status");
export const cancelEnrichJob = () => request<EnrichJob>("/api/enrich/cancel", { method: "POST" });

export async function fetchDiff(mode: DataMode, base?: string): Promise<ImpactReport> {
  if (mode === "embedded") {
    if (window.__LENS_DIFF__ && typeof window.__LENS_DIFF__ === "object") return window.__LENS_DIFF__ as ImpactReport;
    throw new HttpError(404, "No diff embedded in this export");
  }
  if (mode === "dev") {
    const res = await fetch("/sample-diff.json");
    if (!res.ok) throw new HttpError(res.status, "Could not load public/sample-diff.json");
    return (await res.json()) as ImpactReport;
  }
  return request<ImpactReport>(`/api/diff${base ? `?base=${encodeURIComponent(base)}` : ""}`);
}

export async function embedSearch(q: string): Promise<Array<{ id: string; score: number }>> {
  const res = await request<{ results: Array<{ id: string; score: number }> }>("/api/search/embed", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ q }),
  });
  return Array.isArray(res.results) ? res.results : [];
}

/** Hosted server: repos already cloned on the server. */
export function listCloudRepos(): Promise<{ repos: string[] }> {
  return request("/api/project/repos");
}

export type CheckCounts = { passing: number; failing: number; pending: number };
export type PullRequest = { number: number; url: string; state: "open" | "merged" | "closed"; mergedAt?: string; checks?: CheckCounts };
export type PushState = { branch: string | null; dirty: boolean; pr: PullRequest | null } | null;
export const createPullRequest = () => request<{ pr: PullRequest }>("/api/project/pr", { method: "POST" }).then((r) => r.pr);
export const mergePullRequest = () => request<{ pr: PullRequest }>("/api/project/merge", { method: "POST" }).then((r) => r.pr);
export const setWontFix = (id: string, on: boolean) =>
  request<{ wontFix: string[] }>("/api/items/wontfix", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, on }) }).then((r) => r.wontFix);
export const fetchPushState = () => request<{ state: PushState }>("/api/project/push").then((r) => r.state);

/** Hosted server: commit applied fixes to a `lens/fixes-*` branch and push it. */
export function pushFixesBranch(): Promise<{ branch: string; compareUrl: string | null; files: number }> {
  return request("/api/project/push", { method: "POST" });
}

/** Hosted server: applied fixes as a git patch. */
export function fixesPatch(): Promise<{ name: string; patch: string }> {
  return request("/api/project/patch");
}

/** Whether this server signs in with a username and password. Needs no session. */
export async function authMode(): Promise<{ login: boolean }> {
  try {
    const res = await fetch("/api/auth", { credentials: "same-origin" });
    return res.ok ? ((await res.json()) as { login: boolean }) : { login: false };
  } catch {
    return { login: false };
  }
}

/** Hosted server: exchange a username and password for a session. */
export async function signIn(username: string, password: string): Promise<string> {
  const res = await fetch("/api/login", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const body = (await res.json().catch(() => ({}))) as { token?: string; error?: string };
  if (!res.ok || !body.token) throw new Error(body.error ?? "Sign-in failed.");
  return body.token;
}

export interface GithubRepo {
  name: string;
  private: boolean;
  pushedAt: string;
}

/** Hosted server: the GitHub authorize URL to send the browser to. */
export function githubConnectUrl(): Promise<{ url: string }> {
  return request("/api/github/connect");
}

export function githubDisconnect(): Promise<{ ok: true }> {
  return request("/api/github/disconnect", { method: "POST" });
}

/** Hosted server: repos the connected GitHub account can read. */
export function githubRepos(): Promise<{ repos: GithubRepo[] }> {
  return request("/api/github/repos");
}
