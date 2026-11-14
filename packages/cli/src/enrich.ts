/**
 * Runs an LLM enrichment step from the dashboard by driving Claude Code headless
 * (`claude -p`). Same pipeline as the /lens-domain skill: build the context file,
 * let one agent write a patch, then validate and merge it with applyPatch, so the
 * agent still never writes the graph directly.
 *
 * Cost control: every run passes --max-budget-usd, and the actual cost from the
 * final stream-json result is reported back to the dashboard.
 */
import { inRepairScope, loadRepairItems } from "./ci.js";
import { BATCH_MAX_FILES, coveredFiles, hashFiles, keepReviewed, loadCoverage, mergeReview, pendingReview, planBatches, priorFindingsFor, renderReport, reviewIndex, saveCoverage, type ReviewFile, type ReviewRecord } from "./review-ledger.js";
import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { promises as fs, existsSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { fileURLToPath } from "node:url";
import { applyFixes, buildRecord, confineFixes, loadRemediation, markUnaddressed, remediationPath, type FixSource, type RemediationRecord, type RemediationSource } from "./remediate.js";
import { collectChanges, makeWorkspace, NO_CHANGE_REASON } from "./workspace.js";
import { buildPlanRecord, loadLayoutPlan, moveFiles, planContext, saveLayoutPlan, usableMoves } from "./layout-plan.js";
import { itemRate, loadFixCosts, recordFixCost, type ItemRate } from "./fix-costs.js";
import { actionPinFix } from "./action-pins.js";
import { AuditVerdictsSchema, LayoutPlanSchema, PatchValidationError, WorkspaceReportSchema, type Remediation, ReviewFindingsSchema, applyPatch, buildBatches, checkHitIds, reviewKey, findingItemId, scanAndSave, domainContext, formatZodError, loadGraph, loadMeta, paths, readJson, renameScannedPaths, saveGraph, saveMeta, writeJsonAtomic, type AuditVerdicts, type Finding, type KnowledgeGraph } from "@lens/core";

export type EnrichTask = "domain" | "audit" | "summaries" | "review" | "remediate" | "architecture";

export type { ReviewRecord } from "./review-ledger.js";

/** Stored at .lens/audit.json; survives rescans. */
export interface AuditRecord {
  generatedAt: string;
  costUsd?: number;
  summary?: string;
  report: string;
  items: AuditVerdicts["items"];
}

export interface FixAllProgress {
  attempted: number;
  total: number;
  fixed: number;
  batches: number;
  stopped?: string;
  /** What the running batch fixes: a check's title, or "Mixed Issues". */
  current?: string;
  /** Claude runs still to go after the running one, at the current batch sizes. */
  runsLeft?: number;
  /** Wall-clock time per finished batch, so batches running side by side shorten it. */
  msPerRun?: number;
}

export interface EnrichJob {
  task: EnrichTask;
  root: string;
  state: "running" | "done" | "error" | "cancelled";
  startedAt: number;
  finishedAt?: number;
  budgetUsd: number;
  /** Most recent agent actions, newest last. */
  progress: string[];
  costUsd?: number;
  error?: string;
  result?: { domains: number; flows: number; dropped: number };
  audit?: { items: number; failing: number; report: string };
  summaries?: { batchesDone: number; batchesTotal: number; files: number; stoppedEarly?: string };
  review?: { findings: number; report: string; batchesDone?: number; batchesTotal?: number; stoppedEarly?: string };
  remediation?: { source: RemediationSource; proposed: number; invalid: number; skipped: number; applied?: number };
  /** Cost of earlier Claude runs in this job (Fix runs several batches). */
  costBase?: number;
  /** Fix-everything progress. */
  fixAll?: FixAllProgress;
  /** Which report a remediate run works from (and, for "health", which check). */
  source?: RemediationSource;
  checkId?: string;
  /** Architecture: the plan's size, or the area being moved. */
  architecture?: { areas: number; moves: number; areaId?: string };
  /** The audit or review currently running, with its usual duration from past runs. */
  step?: { kind: "audit" | "review"; startedAt: number; typicalMs?: number };
}

export const DEFAULT_BUDGET_USD = 2;
/**
 * Expected cost of a run for a project this size (Sonnet, from observed runs), and a
 * hard safety limit at about twice the high estimate so a runaway run can't burn credits.
 */
export interface CostEstimate {
  low: number;
  high: number;
  limit: number;
}
export function estimateCost(task: EnrichTask, files: number): CostEstimate {
  // Summaries read every pending file; the other runs read a bounded set of key files,
  // so their cost flattens out past ~200 files.
  const f = Math.min(files, 200);
  const [low, high] =
    task === "summaries" ? [0.008 * files, 0.02 * files]
    : task === "audit" ? [0.5 + 0.005 * f, 1.2 + 0.01 * f]
    : task === "remediate" ? [0.3 + 0.15 * Math.min(files, 30), 0.8 + 0.4 * Math.min(files, 30)]
    : [0.3 + 0.003 * f, 0.8 + 0.007 * f];
  const r = (n: number) => Math.round(n * 100) / 100;
  // Fixes have no size limit, so a single large refactor gets more room.
  const room = task === "remediate" ? Math.max(3, high * 2.5) : Math.max(0.5, high * 2);
  return { low: r(Math.max(0.05, low)), high: r(Math.max(0.2, high)), limit: r(Math.min(MAX_BUDGET_USD, room)) };
}
/** A review of `batches` batches of new or changed files (Sonnet, ~25 files or 4000 lines each). */
export function reviewEstimate(batches: number): CostEstimate {
  const r = (n: number) => Math.round(n * 100) / 100;
  if (!batches) return { low: 0, high: 0, limit: 0 };
  const high = REVIEW_BATCH_HIGH_USD * batches;
  return { low: r(REVIEW_BATCH_LOW_USD * batches), high: r(high), limit: r(Math.min(MAX_REVIEW_USD, Math.max(1, high * 1.5))) };
}
const REVIEW_BATCH_LOW_USD = 0.35;
const REVIEW_BATCH_HIGH_USD = 0.9;
const MAX_REVIEW_USD = 150;
/** Per-batch cap passed to Claude, so one batch can't take the whole review's budget. */
const REVIEW_BATCH_LIMIT_USD = 2;
/** One thing for Claude to fix, as items.json lists it. */
interface RemediationItem {
  id: string;
  title: string;
  evidence: string[];
  fix?: string;
}
/** Added to an item's evidence when Lens retries a fix that changed no files. */
const NO_CHANGE_NOTE = "An earlier attempt reported this fixed but changed no files. Make the edit this time, or skip it with the reason no change is needed.";
/** Below this, a Claude run can't do useful work. */
const MIN_RUN_USD = 0.3;
/** Spend allowed per review batch when checking Lens's own changes, and for fixing what it finds. */
const FIX_CHECK_LIMIT_USD = 1.5;
/** One batch's allowance for every batch of changed files, so a large fix run checks all of them. */
export const fixCheckLimit = (changedFiles: number) => FIX_CHECK_LIMIT_USD * Math.max(1, Math.ceil(changedFiles / BATCH_MAX_FILES));
const FIX_CHECK_DIFF_CHARS = 30_000;
/** Budget added to every Fix run for that check: one review pass and one repair round. */
export const FIX_CHECK_RESERVE_USD = 2 * FIX_CHECK_LIMIT_USD;
/** Budget left below which Fix All skips the re-audit; an audit costs roughly this much. */
const MIN_REAUDIT_USD = 1.5;

/** Per-item cost of a batch fix before any runs are logged for the project. */
const DEFAULT_BATCH_ITEM_RATE: ItemRate = { low: 0.15, high: 0.4 };

/** Fix everything with no size limit per fix, with a limit at 1.5x the high end. */
export function estimateFixAll(items: number, rate: ItemRate = DEFAULT_BATCH_ITEM_RATE): CostEstimate {
  const low = Math.max(0.3, rate.low * items);
  const high = Math.max(0.8, rate.high * items);
  return { low: Math.round(low * 100) / 100, high: Math.round(high * 100) / 100, limit: Math.round(Math.min(150, high * 1.5) * 100) / 100 };
}

/** Sonnet handles all four jobs well at a fraction of the cost of the largest model. */
const MODEL_ARGS = ["--model", "sonnet"];
/** Review batches cover disjoint files, so several Claude runs can work at once. */
const REVIEW_CONCURRENCY = 4;

interface ClaudeRunOptions {
  /** Spend cap for this one process; defaults to the job's limit. */
  budgetUsd?: number;
  /** Receives this process's running cost; without it the cost is added to `job.costBase`. */
  onCost?: (usd: number) => void;
  /** False when the caller handles a timed-out run itself, so one slow batch doesn't end the job. */
  timeoutEndsJob?: boolean;
}
export const REVIEW_REPORT = "CODE_REVIEW.md";
export const reviewPath = (root: string) => path.join(paths(root).dir, "review.json");
export const AUDIT_REPORT = "SECURITY_AUDIT.md";
export const auditPath = (root: string) => path.join(paths(root).dir, "audit.json");
const decisionsPath = (root: string) => path.join(paths(root).dir, "checklist-decisions.json");
export type Decision = "pass" | "fail" | "na";
/** Checklist items the owner marked by hand. They override the scanner and the AI audit. */
export async function loadDecisions(root: string): Promise<Record<string, Decision>> {
  return (await readJson<Record<string, Decision>>(decisionsPath(root)).catch(() => null)) ?? {};
}
export async function saveDecision(root: string, id: string, status: Decision | null) {
  const all = await loadDecisions(root);
  if (status) all[id] = status;
  else delete all[id];
  await writeJsonAtomic(decisionsPath(root), all, true);
}
const wontFixPath = (root: string) => path.join(paths(root).dir, "wont-fix.json");
/** Health and review items the owner closed as Won't Fix, keyed by stable id (check-hit id or reviewKey). */
export async function loadWontFix(root: string): Promise<string[]> {
  const v = await readJson<unknown>(wontFixPath(root)).catch(() => null);
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}
export async function setWontFix(root: string, id: string, on: boolean) {
  const all = new Set(await loadWontFix(root));
  if (on) all.add(id);
  else all.delete(id);
  await writeJsonAtomic(wontFixPath(root), [...all].slice(-2000), true);
}
/** The audit record with the owner's decisions laid over it. */
export async function auditWithDecisions(root: string): Promise<(AuditRecord & { items: Array<AuditRecord["items"][number] & { by?: "you" }> }) | null> {
  const audit = await readJson<AuditRecord>(auditPath(root));
  const decisions = await loadDecisions(root);
  if (!audit && !Object.keys(decisions).length) return null;
  const items: Array<AuditRecord["items"][number] & { by?: "you" }> = (audit?.items ?? []).filter((i) => !(i.id in decisions));
  for (const [id, status] of Object.entries(decisions)) items.push({ id, status, evidence: ["Marked by you."], by: "you" });
  return { generatedAt: audit?.generatedAt ?? "", costUsd: audit?.costUsd, summary: audit?.summary, report: audit?.report ?? "", items };
}
const runTimesPath = (root: string) => path.join(paths(root).dir, "run-times.json");
type RunTimes = Partial<Record<"audit" | "review", number[]>>;

/** Median of the last five successful runs of this kind, or undefined before the first. */
async function typicalDuration(root: string, kind: "audit" | "review"): Promise<number | undefined> {
  const times = ((await readJson<RunTimes>(runTimesPath(root)).catch(() => null)) ?? {})[kind] ?? [];
  if (!times.length) return undefined;
  const sorted = [...times].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}
async function recordDuration(root: string, kind: "audit" | "review", ms: number) {
  const all = (await readJson<RunTimes>(runTimesPath(root)).catch(() => null)) ?? {};
  all[kind] = [...(all[kind] ?? []), Math.round(ms)].slice(-5);
  await writeJsonAtomic(runTimesPath(root), all, true);
}
export const MAX_BUDGET_USD = 20;
const MINUTE_MS = 60_000;
const SECOND_MS = 1000;
const DEFAULT_TIMEOUT_MS = 45 * MINUTE_MS;
const TimeoutSchema = z.coerce.number().int().positive();
/** LENS_CLAUDE_TIMEOUT_MS shortens the per-run limit so tests can hit it. */
function claudeTimeoutMs(): number {
  const raw = process.env.LENS_CLAUDE_TIMEOUT_MS;
  return raw === undefined ? DEFAULT_TIMEOUT_MS : TimeoutSchema.parse(raw);
}
const timeoutLabel = (ms: number) => (ms >= MINUTE_MS ? `${Math.round(ms / MINUTE_MS)} minutes` : `${Math.round(ms / SECOND_MS)} seconds`);
/** Checks whose fixes are refactors: each item gets its own Claude run and a larger cap. */
export const REFACTOR_CHECKS = new Set(["oversized", "hotspots", "import-cycles", "layer-violations", "fragmented"]);
export const REFACTOR_ITEM_LIMIT_USD = 8;
const DEFAULT_REFACTOR_ITEM_RATE: ItemRate = { low: 1, high: 4 };
/** Ceiling for one Remediate run over a whole project, review included. */
const MAX_FIX_ALL_USD = 400;
const REFACTOR_JOB_LIMIT_USD = 60;
export const isRefactorItem = (id: string) => REFACTOR_CHECKS.has(id.split("~")[0]!);
/** Spending cap for a Fix run on one check or one item, plus room to review and repair Lens's own changes. */
export function remediateLimit(checkId: string | undefined, items: number): number {
  const fixes = checkId && isRefactorItem(checkId) ? Math.min(REFACTOR_JOB_LIMIT_USD, Math.max(1, items) * REFACTOR_ITEM_LIMIT_USD) : estimateCost("remediate", items).limit;
  return Math.round((fixes + FIX_CHECK_RESERVE_USD) * 100) / 100;
}

/** Lens checkout root (holds agents/ and bin/lens), from packages/cli/{src,dist}. */
function repoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../..");
}

function agentInstructions(name: string): string {
  const file = path.join(repoRoot(), "agents", `${name}.md`);
  return file;
}

/** One-line description of a tool call for the progress feed. */
function describeTool(name: string, input: Record<string, unknown>, root: string): string {
  const rel = (p: unknown) => (typeof p === "string" ? path.relative(root, p) || p : "");
  switch (name) {
    case "Read":
      return `Reading ${rel(input.file_path)}`;
    case "Grep":
      return input.path ? `Searching ${rel(input.path)}` : "Searching the code";
    case "Glob":
      return "Listing files";
    case "Write":
    case "Edit": {
      const f = String(input.file_path ?? "");
      const batch = /enrich-(\d+)\.json$/.exec(f);
      if (batch) return `Saving summaries (batch ${Number(batch[1]) + 1})`;
      if (f.endsWith(REVIEW_REPORT)) return "Writing the review";
      if (f.endsWith("remediation.json")) return "Writing proposed fixes";
      if (f.endsWith("review.json")) return "Recording findings";
      return f.endsWith(".md") ? "Writing the audit report" : f.includes("audit") ? "Recording checklist verdicts" : "Writing the domain map";
    }
    case "Bash": {
      const cmd = String(input.command ?? "");
      if (cmd.includes(" apply ")) return "Checking the domain map against the graph";
      if (cmd.includes(" query ")) return "Tracing calls through the graph";
      return "Running a Lens command";
    }
    default:
      return name;
  }
}

const claudeBin = () => process.env.LENS_CLAUDE_BIN || "claude";
/** The agent doesn't need Lens's own secrets. */
function childEnv(): NodeJS.ProcessEnv {
  const { LENS_TOKEN: _t, LENS_PASSWORD: _p, GITHUB_TOKEN: _g, GITHUB_CLIENT_SECRET: _s, ...rest } = process.env;
  return rest;
}
export const LOGIN_HELP = process.env.LENS_WORKSPACE
  ? "Claude isn't configured on this server. Set CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`) or ANTHROPIC_API_KEY in Railway's variables, then try again."
  : "Claude Code isn't signed in on this computer. Run `claude auth login` in a terminal, then try again.";

/** Fails fast with a fixable message instead of a raw OAuth error from inside the run. */
export function checkClaudeAuth(): Promise<string | null> {
  if (process.env.LENS_CLAUDE_BIN) return Promise.resolve(null); // test double
  if (process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(claudeBin(), ["auth", "status"], { timeout: 15_000 }, (err, stdout) => {
      if (err && (err as NodeJS.ErrnoException).code === "ENOENT") return resolve("Claude Code CLI (`claude`) is not installed or not on PATH.");
      try {
        const s = JSON.parse(stdout) as { loggedIn?: boolean };
        resolve(s.loggedIn === false ? LOGIN_HELP : null);
      } catch {
        resolve(null); // unknown format: let the run report its own error
      }
    });
  });
}

function friendlyError(msg: string): string {
  return /authenticat|oauth|log ?in|401|invalid api key/i.test(msg) ? LOGIN_HELP : msg;
}

/** Spend tracking for review batches that run in parallel under one limit. */
class BatchBudget {
  /** Cost per batch: finished batches keep their final cost, running ones their latest report. */
  private readonly cost = new Map<number, number>();
  /** Spend caps of running batches, so parallel batches can't overrun the limit together. */
  private readonly reserved = new Map<number, number>();
  constructor(private readonly limitUsd: number) {}

  record(batch: number, usd: number): void {
    this.cost.set(batch, usd);
  }

  release(batch: number): void {
    this.reserved.delete(batch);
  }

  spent(): number {
    return [...this.cost.values()].reduce((a, b) => a + b, 0);
  }

  available(): number {
    return this.limitUsd - this.spent() - [...this.reserved.entries()].reduce((a, [n, cap]) => a + cap - (this.cost.get(n) ?? 0), 0);
  }

  /** Runs batches REVIEW_CONCURRENCY at a time. Returns true when it stopped for lack of budget. */
  async run(count: number, running: () => boolean, reviewBatch: (n: number, cap: number) => Promise<void>): Promise<boolean> {
    let next = 0;
    let outOfBudget = false;
    const worker = async () => {
      while (next < count && running()) {
        const room = this.available();
        if (room < MIN_RUN_USD) {
          outOfBudget = true;
          return;
        }
        const n = next++;
        const cap = Math.round(Math.min(room, REVIEW_BATCH_LIMIT_USD) * 100) / 100;
        this.reserved.set(n, cap);
        await reviewBatch(n, cap);
      }
    };
    await Promise.all(Array.from({ length: Math.min(REVIEW_CONCURRENCY, count) }, worker));
    return outOfBudget;
  }
}

/** A job's cost while several Claude runs report their own running totals at once. */
class ParallelCost {
  private readonly live = new Map<number, number>();
  private done: number;
  constructor(private readonly job: EnrichJob) {
    this.done = job.costUsd ?? 0;
  }
  update(run: number, usd: number) {
    this.live.set(run, usd);
    this.job.costUsd = this.done + [...this.live.values()].reduce((a, b) => a + b, 0);
  }
  settle(run: number) {
    this.done += this.live.get(run) ?? 0;
    this.live.delete(run);
  }
  settled(): number {
    return this.done;
  }
}

function serialQueue(): (task: () => Promise<void>) => Promise<void> {
  let chain: Promise<void> = Promise.resolve();
  return (task) => {
    const run = chain.then(task);
    chain = run;
    return run;
  };
}

async function reviewTargets(root: string, scope: { paths: string[] } | undefined) {
  const g = await loadGraph(root);
  if (!g) throw new Error("no graph for this project; scan it first");
  const files = reviewFiles(g);
  const hashes = await hashFiles(root, files.map((f) => f.path));
  const coverage = await loadCoverage(root);
  const inScope = new Set(scope?.paths ?? []);
  const targets = scope ? files.filter((f) => inScope.has(f.path)) : pendingReview(files, hashes, coverage);
  return { g, files, hashes, coverage, targets };
}

async function clearReviewIntermediates(root: string): Promise<string> {
  const dir = paths(root).intermediate;
  await fs.mkdir(dir, { recursive: true });
  for (const f of await fs.readdir(dir)) if (/^(context-health|review)-\d+\.json$/.test(f)) await fs.rm(path.join(dir, f), { force: true });
  return dir;
}

type ReviewGraph = NonNullable<Awaited<ReturnType<typeof loadGraph>>>;

async function writeBatchContext(ctxPath: string, root: string, g: ReviewGraph, batch: ReturnType<typeof reviewFiles>, closed: Awaited<ReturnType<typeof reviewClosed>>, scoped: boolean): Promise<void> {
  const batchPaths = new Set(batch.map((f) => f.path));
  const ledger = await loadReview(root);
  const health = (g.health?.checks ?? []).map((c) => ({ id: c.id, title: c.title, hits: c.hits.filter((h) => h.path && batchPaths.has(h.path)).slice(0, 10) })).filter((c) => c.hits.length);
  await writeJsonAtomic(ctxPath, { project: g.project, mode: scoped ? "changes" : "full", files: batch, priorFindings: priorFindingsFor(ledger.findings, batchPaths, closed), health, ...(scoped ? { diff: gitDiff(root, [...batchPaths]) } : {}) }, true);
}

function reviewerPrompt(instructions: string, root: string, ctxPath: string, outPath: string): string {
  return [
    `Follow the agent instructions in ${instructions} (read that file first).`,
    `Project root: ${root}`,
    `Context: ${ctxPath}`,
    `Findings path: ${outPath}`,
    "Read-only: write the findings file and nothing else.",
    "If the write is refused, put the findings inside a ```json fence in your final message instead.",
  ].join("\n");
}

function batchFailure(code: number | null, stderr: string, error: Parameters<typeof formatZodError>[0]): string {
  return code ? `Claude Code exited with code ${code}: ${stderr.trim().split("\n").pop() ?? ""}` : `review findings failed validation:\n${formatZodError(error)}`;
}

export class EnrichRunner {
  job: EnrichJob | null = null;
  private children = new Set<ChildProcess>();

  get running(): boolean {
    return this.job?.state === "running";
  }

  start(task: EnrichTask, root: string, budgetUsd: number, opts: { source?: FixSource; checkId?: string; note?: string; fixNew?: boolean; areaId?: string } = {}): EnrichJob {
    if (this.running) throw new Error("an AI run is already in progress");
    const job: EnrichJob = { task, root, state: "running", startedAt: Date.now(), budgetUsd, progress: ["Preparing context"], ...(task === "remediate" ? { source: opts.source ?? "audit", checkId: opts.checkId } : {}) };
    this.job = job;
    console.log(`[ai] start ${task}${job.source ? `/${job.source}` : ""} in ${path.basename(root)}, limit $${budgetUsd}`);
    (task === "audit" ? this.runAudit(job) : task === "summaries" ? this.runSummaries(job) : task === "review" ? this.runReview(job, !!opts.fixNew) : task === "remediate" ? this.runRemediate(job, opts.source ?? "audit", opts.checkId, opts.note) : task === "architecture" ? (opts.areaId ? this.moveArea(job, opts.areaId) : this.planLayout(job)) : this.runDomain(job)).catch((e: unknown) => {
      // The message alone doesn't say which step failed (a WASM trap reads "memory access out of bounds").
      if (e instanceof Error && e.stack) console.error(`[ai] ${task} failed: ${e.stack}`);
      this.finish(job, "error", e instanceof Error ? e.message : String(e));
    });
    return job;
  }

  cancel(): void {
    if (!this.running || !this.job) return;
    this.finish(this.job, "cancelled", "cancelled");
  }

  private finish(job: EnrichJob, state: EnrichJob["state"], error?: string) {
    if (job.state !== "running") return;
    job.state = state;
    const secs = Math.round((Date.now() - job.startedAt) / 1000);
    console.log(`[ai] ${state} ${job.task} after ${secs}s, $${(job.costUsd ?? 0).toFixed(2)}${error ? `: ${error.slice(0, 300)}` : ""}`);
    job.finishedAt = Date.now();
    if (error && state !== "done") job.error = friendlyError(error).slice(0, 400);
    // Parallel review batches may still be running; a finished job owns none of them.
    for (const child of this.children) child.kill("SIGTERM");
    this.children.clear();
  }

  private push(job: EnrichJob, line: string) {
    if (job.progress[job.progress.length - 1] === line) return;
    job.progress.push(line);
    if (job.progress.length > 30) job.progress.splice(0, job.progress.length - 30);
  }

  /** Spawn Claude Code, stream its tool calls into the job's progress, resolve on exit. */
  private async runClaude(job: EnrichJob, prompt: string, tools: string[], extraArgs: string[] = [], cwd = job.root, run: ClaudeRunOptions = {}): Promise<{ code: number | null; stderr: string; resultError?: string; resultText: string; timedOut: boolean }> {
    const args = [
      "-p", prompt,
      "--output-format", "stream-json", "--verbose",
      "--no-session-persistence",
      "--max-budget-usd", String(run.budgetUsd ?? job.budgetUsd),
      ...extraArgs,
      "--allowedTools", ...tools,
    ];
    this.push(job, "Starting Claude Code");
    const child = spawn(claudeBin(), args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: childEnv() });
    this.children.add(child);
    let timedOut = false;
    const timeoutMs = claudeTimeoutMs();
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      if (run.timeoutEndsJob !== false) this.finish(job, "error", `timed out after ${timeoutLabel(timeoutMs)}`);
    }, timeoutMs);

    let buf = "";
    let stderr = "";
    let resultError: string | undefined;
    let resultText = "";
    child.stdout!.on("data", (c: Buffer) => {
      buf += c.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg: { type?: string; subtype?: string; is_error?: boolean; total_cost_usd?: number; result?: string; message?: { content?: Array<{ type: string; name?: string; input?: Record<string, unknown> }> } };
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.type === "assistant") {
          for (const c of msg.message?.content ?? []) if (c.type === "tool_use" && c.name) this.push(job, describeTool(c.name, c.input ?? {}, cwd));
        } else if (msg.type === "result") {
          if (typeof msg.total_cost_usd === "number") {
            if (run.onCost) run.onCost(msg.total_cost_usd);
            else job.costUsd = (job.costBase ?? 0) + msg.total_cost_usd;
          }
          if (typeof msg.result === "string") resultText = msg.result;
          if (msg.is_error || (msg.subtype && msg.subtype !== "success")) {
            resultError = msg.subtype === "error_max_budget_usd" ? `stopped at the $${(run.budgetUsd ?? job.budgetUsd).toFixed(2)} safety limit` : String(msg.result ?? msg.subtype ?? "Claude Code reported an error");
          }
        }
      }
    });
    child.stderr!.on("data", (c: Buffer) => {
      stderr = (stderr + c.toString("utf8")).slice(-2000);
    });

    const code = await new Promise<number | null>((resolve) => {
      child.on("error", (e: NodeJS.ErrnoException) => {
        resultError = e.code === "ENOENT" ? "Claude Code CLI (`claude`) not found on PATH" : e.message;
        resolve(null);
      });
      child.on("close", (c) => resolve(c));
    });
    clearTimeout(timer);
    this.children.delete(child);
    if (timedOut) resultError = `ran past ${timeoutLabel(timeoutMs)}`;
    return { code, stderr, resultError, resultText, timedOut };
  }

  private async runDomain(job: EnrichJob) {
    const { root } = job;
    const g = await loadGraph(root);
    if (!g) throw new Error("no graph for this project; scan it first");
    const dir = paths(root).intermediate;
    await fs.mkdir(dir, { recursive: true });
    const ctxPath = path.join(dir, "context-domain.json");
    const outPath = path.join(dir, "domain.json");
    await writeJsonAtomic(ctxPath, domainContext(g), true);
    await fs.rm(outPath, { force: true });

    const lens = path.join(repoRoot(), "bin", "lens");
    const instructions = agentInstructions("domain-analyzer");
    if (!existsSync(instructions)) throw new Error(`missing ${instructions}`);
    const prompt = [
      `Follow the agent instructions in ${instructions} (read that file first).`,
      `Context: ${ctxPath}`,
      `Output: ${outPath}`,
      `Project root: ${root}`,
      `Lens CLI: ${lens} (call it unquoted, exactly as written)`,
      "Create the output file with the Write tool. Bash only runs the Lens CLI; heredocs, cd, and redirects are blocked.",
      "Only write the output file. When the dry-run apply succeeds, stop.",
    ].join("\n");
    const { code, stderr, resultError, resultText } = await this.runClaude(job, prompt, ["Read", "Grep", "Glob", "Edit(./.lens/intermediate/domain.json)", `Bash(${lens}:*)`], MODEL_ARGS);
    if (job.state !== "running") return; // cancelled or timed out

    const patch = await readJson<unknown>(outPath);
    if (!patch) {
      const said = resultText.trim().split("\n")[0]?.slice(0, 200);
      throw new Error(resultError ?? (code ? `Claude Code exited with code ${code}: ${stderr.trim().split("\n").pop() ?? ""}` : `the agent did not write a domain map${said ? `: ${said}` : ""}`));
    }
    this.push(job, "Merging into the graph");
    // Re-load: the graph may have been rescanned while the agent ran.
    const fresh = (await loadGraph(root))!;
    const meta = (await loadMeta(root)) ?? { version: "lens/1", analyzedAt: fresh.project.analyzedAt, analyzedFiles: fresh.stats.files, layersSource: "heuristic" as const, tourSource: "heuristic" as const };
    const r = applyPatch(fresh, meta, "domain", patch);
    await saveGraph(root, fresh);
    await saveMeta(root, meta);
    await fs.rm(outPath, { force: true });
    job.result = {
      domains: fresh.nodes.filter((n) => n.kind === "domain").length,
      flows: fresh.nodes.filter((n) => n.kind === "flow").length,
      dropped: r.dropped.length,
    };
    this.finish(job, "done");
  }

  private async runAudit(job: EnrichJob) {
    if (await this.timed(job, "audit")) this.finish(job, "done");
  }

  /**
   * Re-runs the audit after Lens fixed checklist checks, so a check that still fails somewhere
   * else comes back for another pass. False when no check was fixed or the audit didn't finish.
   */
  private async reauditFixedChecks(job: EnrichJob, record: RemediationRecord, fixIds: string[]): Promise<boolean> {
    const checkIds = new Set((await loadGraph(job.root))?.security?.checklist?.map((c) => c.id) ?? []);
    const fixedChecks = record.fixes.some((f) => fixIds.includes(f.id) && checkIds.has(f.itemId));
    if (!fixedChecks || job.budgetUsd - (job.costUsd ?? 0) < MIN_REAUDIT_USD) return false;
    this.push(job, "Re-auditing the checks Lens fixed");
    return this.timed(job, "audit");
  }

  /** Runs an audit or review step and records how long it took. */
  private async timed(job: EnrichJob, kind: "audit" | "review", added: number[] = []): Promise<boolean> {
    const step = { kind, startedAt: Date.now(), typicalMs: await typicalDuration(job.root, kind) };
    job.step = step;
    const found = kind === "review" ? await this.reviewStep(job, { limitUsd: job.budgetUsd - (job.costUsd ?? 0) }) : null;
    if (found) added.push(...found);
    const ok = kind === "audit" ? await this.auditStep(job) : found !== null;
    job.step = undefined;
    if (ok) await recordDuration(job.root, kind, Date.now() - step.startedAt).catch(() => undefined);
    return ok;
  }

  /** Runs the audit and saves it. False when the job stopped (cancel, timeout). */
  private async auditStep(job: EnrichJob): Promise<boolean> {
    const { root } = job;
    const g = await loadGraph(root);
    const checklist = g?.security?.checklist;
    if (!g || !checklist?.length) throw new Error("no checklist for this project; rescan it first");
    const dir = paths(root).intermediate;
    await fs.mkdir(dir, { recursive: true });
    const ctxPath = path.join(dir, "context-checklist.json");
    const outPath = path.join(dir, "audit.json");
    const reportPath = path.join(root, AUDIT_REPORT);
    await writeJsonAtomic(ctxPath, { project: g.project, checklist, findings: g.security!.findings.map(({ id, rule, title, severity, path: p, line, status, triageNote }) => ({ id, rule, title, severity, path: p, line, status, triageNote })) }, true);
    await fs.rm(outPath, { force: true });

    const mtime = () => {
      try {
        return statSync(reportPath).mtimeMs;
      } catch {
        return 0;
      }
    };
    const reportBefore = mtime();
    const instructions = agentInstructions("security-auditor");
    if (!existsSync(instructions)) throw new Error(`missing ${instructions}`);
    const prompt = [
      `Follow the agent instructions in ${instructions} (read that file first).`,
      `Project root: ${root}`,
      `Checklist: ${ctxPath}`,
      `Report path: ${reportPath}`,
      `Verdicts path: ${outPath}`,
      "Read-only: write those two files and nothing else.",
      "If a write is refused, put the full report in your final message inside a ```markdown fence and the verdicts inside a ```json fence instead.",
    ].join("\n");
    // Writes are scoped to the two output files (Claude Code path rules use Edit(...),
    // which covers the Write tool too); no Bash.
    const tools = ["Read", "Grep", "Glob", `Edit(./${AUDIT_REPORT})`, "Edit(./.lens/intermediate/audit.json)"];
    const { code, stderr, resultError, resultText } = await this.runClaude(job, prompt, tools, MODEL_ARGS);
    if (job.state !== "running") return false;

    // Fallback: recover output from the final message so a refused write doesn't waste a paid run.
    const fenced = (lang: string) => new RegExp("```" + lang + "\\s*\\n([\\s\\S]*?)\\n```").exec(resultText)?.[1];
    if (mtime() === reportBefore) {
      const md = fenced("markdown");
      if (md) await fs.writeFile(reportPath, md);
    }
    let raw = await readJson<unknown>(outPath);
    if (!raw) {
      try {
        raw = JSON.parse(fenced("json") ?? "null");
      } catch {
        raw = null;
      }
    }
    if (!raw) throw new Error(resultError ?? (code ? `Claude Code exited with code ${code}: ${stderr.trim().split("\n").pop() ?? ""}` : "the auditor did not write its verdicts"));
    const parsed = AuditVerdictsSchema.safeParse(raw);
    if (!parsed.success) throw new Error(`audit verdicts failed validation:\n${formatZodError(parsed.error)}`);
    const ids = new Set(checklist.map((c) => c.id));
    const items = parsed.data.items.filter((i) => ids.has(i.id));
    const record: AuditRecord = { generatedAt: new Date().toISOString(), costUsd: job.costUsd, summary: parsed.data.summary, report: AUDIT_REPORT, items };
    await writeJsonAtomic(auditPath(root), record, true);
    await fs.rm(outPath, { force: true });
    job.audit = { items: items.length, failing: items.filter((i) => i.status === "fail").length, report: AUDIT_REPORT };
    // Rescan so SECURITY_AUDIT.md shows up in the graph and opens in the source viewer.
    this.push(job, "Rescanning");
    await scanAndSave(root);
    return true;
  }

  /** Claude-written summaries for every file that still has an automatic one (or a stale one). */
  private async runSummaries(job: EnrichJob) {
    const { root } = job;
    const g = await loadGraph(root);
    if (!g) throw new Error("no graph for this project; scan it first");
    const batches = buildBatches(g, { pendingOnly: true });
    const progress = { batchesDone: 0, batchesTotal: batches.length, files: 0 };
    job.summaries = progress;
    if (!batches.length) {
      this.finish(job, "done");
      return;
    }
    const dir = paths(root).intermediate;
    await fs.mkdir(dir, { recursive: true });
    for (const f of await fs.readdir(dir)) if (/^(batch|enrich)-\d+\.json$/.test(f)) await fs.rm(path.join(dir, f), { force: true });
    const io = batches.map((b) => ({ b, input: path.join(dir, `batch-${b.index}.json`), output: path.join(dir, `enrich-${b.index}.json`) }));
    for (const x of io) await writeJsonAtomic(x.input, x.b, true);

    const lens = path.join(repoRoot(), "bin", "lens");
    const instructions = agentInstructions("file-analyzer");
    if (!existsSync(instructions)) throw new Error(`missing ${instructions}`);
    const prompt = [
      `Follow the agent instructions in ${instructions} (read that file first).`,
      `Project root: ${root}`,
      `Lens CLI: ${lens} (call it unquoted, exactly as written)`,
      "Output language: English",
      `There are ${io.length} batches. Process them in order, one at a time, and write each output before starting the next:`,
      ...io.map((x) => `- batch ${x.b.index + 1}: input ${x.input} -> output ${x.output}`),
      "Write only those output files.",
    ].join("\n");

    // Count finished batches while Claude works, for the progress line.
    const poll = setInterval(() => {
      progress.batchesDone = io.filter((x) => existsSync(x.output)).length;
    }, 1500);
    let outcome: Awaited<ReturnType<EnrichRunner["runClaude"]>>;
    try {
      // Sonnet: one-paragraph summaries don't need the largest model, and it costs far less.
      outcome = await this.runClaude(job, prompt, ["Read", "Grep", "Glob", "Edit(./.lens/intermediate/enrich-*.json)", `Bash(${lens}:*)`], MODEL_ARGS);
    } finally {
      clearInterval(poll);
    }

    // Merge every batch that finished, even if the run stopped early (budget cap, cancel):
    // the next run only picks up files that still need summaries.
    this.push(job, "Merging summaries into the graph");
    const fresh = await loadGraph(root);
    if (!fresh) throw new Error("the graph disappeared during the run");
    const meta = (await loadMeta(root)) ?? { version: "lens/1", analyzedAt: fresh.project.analyzedAt, analyzedFiles: fresh.stats.files, layersSource: "heuristic" as const, tourSource: "heuristic" as const };
    let applied = 0;
    const done = new Set<string>();
    for (const x of io) {
      const data = await readJson<unknown>(x.output);
      if (!data) continue;
      try {
        applyPatch(fresh, meta, "enrich", data);
        applied++;
        for (const f of x.b.files) done.add(f.path);
      } catch (e) {
        if (!(e instanceof PatchValidationError)) throw e;
      }
    }
    if (applied) {
      await saveGraph(root, fresh);
      await saveMeta(root, meta);
    }
    for (const x of io) {
      await fs.rm(x.input, { force: true });
      await fs.rm(x.output, { force: true });
    }
    progress.batchesDone = applied;
    progress.files = done.size;
    if (job.state !== "running") return; // cancelled or timed out; finished batches are kept
    const { code, stderr, resultError } = outcome;
    if (!applied) throw new Error(resultError ?? (code ? `Claude Code exited with code ${code}: ${stderr.trim().split("\n").pop() ?? ""}` : "Claude didn't finish any batch"));
    if (applied < io.length) job.summaries.stoppedEarly = resultError ?? "stopped before the last batch";
    this.finish(job, "done");
  }

  /** Read-only senior-engineer review: CODE_REVIEW.md plus validated findings for the Health view. */
  /** With `fixNew` (the re-review after a merge), the findings it adds go straight to Fix. */
  private async runReview(job: EnrichJob, fixNew: boolean) {
    const added: number[] = [];
    if (!(await this.timed(job, "review", added))) return;
    if (!fixNew || !added.length) return this.finish(job, "done");
    // The review's own limit is spent; Fix gets the same cap a Fix run on these items would.
    job.budgetUsd = Math.round(((job.costUsd ?? 0) + remediateLimit(undefined, added.length)) * 100) / 100;
    const ids = new Set(added.map((i) => `review-${i}`));
    return this.runFixAll(job, "health", (id) => ids.has(id));
  }

  /**
   * Reviews every code file that is new or changed since its last review, in batches, and
   * folds the findings into the ledger after each batch so a stopped run keeps its progress.
   * With `scope`, reviews only the files a fix run just changed, each batch against its own diff.
   * Returns the indexes of new findings, or null when the job stopped.
   */
  private async reviewStep(job: EnrichJob, opts: { limitUsd: number; scope?: { paths: string[] } }): Promise<number[] | null> {
    const { root } = job;
    const scoped = !!opts.scope;
    this.push(job, "Rescanning");
    await scanAndSave(root);
    const { g, files, hashes, coverage, targets } = await reviewTargets(root, opts.scope);
    const batches = planBatches(targets);
    const progress = { findings: 0, report: REVIEW_REPORT, batchesDone: 0, batchesTotal: batches.length } as NonNullable<EnrichJob["review"]>;
    if (!scoped) job.review = progress;
    if (!batches.length) {
      // Every file is covered at its current hash, so the existing findings are current as of now.
      if (!scoped) await markReviewCurrent(root);
      this.push(job, "No new or changed files to review");
      return [];
    }
    if (!scoped) await saveReview(root, { ...(await loadReview(root)), runStartedAt: new Date().toISOString() });
    const dir = await clearReviewIntermediates(root);
    const instructions = agentInstructions("code-reviewer");
    if (!existsSync(instructions)) throw new Error(`missing ${instructions}`);
    const existing = new Set(files.map((f) => f.path));
    const startCost = job.costUsd ?? 0;
    const added: number[] = [];
    let lastError: string | undefined;

    const budget = new BatchBudget(opts.limitUsd);
    // Ledger and coverage writes run one at a time; batches finish in any order.
    const serially = serialQueue();

    const reviewBatch = async (n: number, cap: number) => {
      const batch = batches[n]!;
      const ctxPath = path.join(dir, `context-health-${n}.json`);
      const outPath = path.join(dir, `review-${n}.json`);
      this.push(job, batches.length > 1 ? `Batch ${n + 1} of ${batches.length}: ${batch.length} files` : `Reviewing ${batch.length} files`);
      const batchPaths = new Set(batch.map((f) => f.path));
      const closed = await reviewClosed(root);
      await writeBatchContext(ctxPath, root, g, batch, closed, scoped);
      const prompt = reviewerPrompt(instructions, root, ctxPath, outPath);
      const onCost = (usd: number) => {
        budget.record(n, usd);
        job.costUsd = startCost + budget.spent();
      };
      const tools = ["Read", "Grep", "Glob", `Edit(./.lens/intermediate/review-${n}.json)`];
      const { code, stderr, resultError, resultText } = await this.runClaude(job, prompt, tools, MODEL_ARGS, root, { budgetUsd: cap, onCost });
      budget.release(n);
      if (job.state !== "running") return;

      const parsed = ReviewFindingsSchema.safeParse((await readJson<unknown>(outPath)) ?? fencedJson(resultText));
      await fs.rm(ctxPath, { force: true });
      await fs.rm(outPath, { force: true });
      if (!parsed.success) {
        lastError = resultError ?? batchFailure(code, stderr, parsed.error);
        this.push(job, `Batch ${n + 1} failed: ${lastError.split("\n")[0]}`);
        return;
      }
      await serially(async () => {
        const now = new Date().toISOString();
        const current = await loadReview(root);
        const merged = mergeReview(current.findings, parsed.data, { ...closed, reviewed: batchPaths, existing, now, byFix: scoped });
        const record: ReviewRecord = { ...current, generatedAt: now, costUsd: (job.costUsd ?? 0) - startCost, summary: undefined, findings: merged.findings };
        await saveReview(root, record);
        // reviewOwnChanges keeps Lens-edited files reviewed; a scoped check reads only the diff.
        if (!scoped) {
          for (const f of batch) coverage[f.path] = hashes.get(f.path)!;
          await saveCoverage(root, coverage);
        }
        added.push(...merged.added);
        progress.findings += merged.added.length;
        progress.batchesDone = (progress.batchesDone ?? 0) + 1;
      });
    };

    const outOfBudget = await budget.run(batches.length, () => job.state === "running", reviewBatch);
    if (outOfBudget) progress.stoppedEarly = "reached the spending limit; the next review continues from here";
    if (job.state !== "running") return null;
    if (!progress.batchesDone && lastError) throw new Error(lastError);
    if (!scoped) {
      this.push(job, "Rescanning");
      await scanAndSave(root);
    }
    return added;
  }

  /**
   * Fixes shouldn't create new issues: review the files Lens just changed against their diff.
   * Files that were fully reviewed before the edit stay reviewed, so Lens's own edits don't
   * queue them for the next review. Returns the indexes of new findings.
   */
  private async reviewOwnChanges(job: EnrichJob, changed: string[], covered: Set<string>): Promise<number[]> {
    const { root } = job;
    // Lens's own edits don't send a file back for a full review; this check reads their diff instead.
    await keepReviewed(root, changed, covered);
    if (!changed.length || job.state !== "running") return [];
    const allowance = Math.min(fixCheckLimit(changed.length), job.budgetUsd - (job.costUsd ?? 0));
    if (allowance < MIN_RUN_USD) {
      this.push(job, "Skipped checking Lens's changes: spending limit reached.");
      return [];
    }
    this.push(job, `Checking Lens's changes to ${changed.length} file${changed.length === 1 ? "" : "s"}`);
    // The fixes are already applied; a failed check leaves their files pending for the next review instead of failing the run.
    const added = await this.reviewStep(job, { limitUsd: allowance, scope: { paths: changed } }).catch((e: unknown) => {
      const reason = e instanceof Error ? e.message.split("\n")[0]! : String(e);
      console.error(`[ai] check of Lens's changes failed in ${path.basename(root)}: ${reason}`);
      this.push(job, `Couldn't check Lens's changes: ${reason}`);
      return null;
    });
    return added ?? [];
  }

  /**
   * Fix what the check of Lens's own changes found, then check those fixes, until a check
   * comes back clean. The run's budget stops it, and a round that changes nothing ends it.
   */
  private async fixOwnFindings(job: EnrichJob, source: RemediationSource, added: number[], covered: Set<string>): Promise<void> {
    let found = added;
    while (found.length && job.state === "running") {
      const changed = await this.fixFindings(job, source, found);
      if (!changed.length) return;
      found = await this.reviewOwnChanges(job, changed, covered);
    }
  }

  /** One fix round for problems the check found in Lens's own changes. Returns the files it changed. */
  private async fixFindings(job: EnrichJob, source: RemediationSource, added: number[]): Promise<string[]> {
    const { root } = job;
    const ledger = await loadReview(root);
    const items = added.map((i) => ({ i, f: ledger.findings[i]! })).map(({ i, f }) => ({ id: `review-${i}`, title: f.title, evidence: [`${f.path}${f.line ? `:${f.line}` : ""} ${f.detail}`], fix: f.fix }));
    if (!items.length) return [];
    const first = await this.fixRound(job, source, items);
    const retry = items.filter((i) => first?.noChange.includes(i.id)).map((i) => ({ ...i, evidence: [...i.evidence, NO_CHANGE_NOTE] }));
    const second = retry.length && job.state === "running" ? await this.fixRound(job, source, retry, true) : null;
    await this.settleItems(root, source, items.map((i) => i.id));
    return [...new Set([...(first?.changed ?? []), ...(second?.changed ?? [])])];
  }

  /** Draft and apply fixes for these items. A retry replaces the attempt that changed no files. */
  private async fixRound(job: EnrichJob, source: RemediationSource, items: RemediationItem[], retry = false): Promise<{ changed: string[]; noChange: string[] } | null> {
    const { root } = job;
    const ids = items.map((i) => i.id);
    const remaining = job.budgetUsd - (job.costUsd ?? 0);
    if (remaining < MIN_RUN_USD) {
      await this.settleItems(root, source, ids, "Lens stopped first: reached the spending limit.");
      return null;
    }
    const plural = items.length === 1 ? "" : "s";
    this.push(job, retry ? `Retrying ${items.length} fix${plural === "s" ? "es" : ""} that changed no files` : `Fixing ${items.length} problem${plural} in Lens's changes`);
    const saved = job.budgetUsd;
    job.costBase = job.costUsd ?? 0;
    job.budgetUsd = Math.round(Math.min(remaining, estimateCost("remediate", items.length).limit) * 100) / 100;
    const { data, error } = await this.draftFixes(job, items, false);
    job.budgetUsd = saved;
    if (job.state !== "running") return null;
    if (!data) {
      this.push(job, `No fix for the problems in Lens's changes${error ? `: ${error.split("\n")[0]}` : ""}`);
      await this.settleItems(root, source, ids, error?.split("\n")[0]?.slice(0, 600));
      return null;
    }
    const rec = buildRecord(root, source, data, undefined, undefined, `c${Date.now().toString(36)}`);
    const prior = await loadRemediation(root, source);
    const mine = new Set(ids);
    const priorSkipped = (prior?.skipped ?? []).filter((x) => !(retry && mine.has(x.itemId) && x.reason === NO_CHANGE_REASON));
    const merged = prior ? { ...prior, generatedAt: rec.generatedAt, costUsd: job.costUsd, fixes: [...prior.fixes, ...rec.fixes], skipped: [...priorSkipped, ...rec.skipped], edits: { ...prior.edits, ...rec.edits } } : rec;
    await writeJsonAtomic(remediationPath(root, source), merged, true);
    const valid = rec.fixes.filter((f) => !f.invalid).map((f) => f.id);
    let applied: string[] = [];
    if (valid.length) {
      applied = (await applyFixes(root, source, valid)).applied;
      if (job.remediation) job.remediation.applied = (job.remediation.applied ?? 0) + applied.length;
      this.push(job, "Rescanning");
      await scanAndSave(root);
    }
    const fixedNow = new Set(rec.fixes.filter((f) => !f.invalid).map((f) => f.itemId));
    return { changed: changedPaths(rec, applied), noChange: rec.skipped.filter((x) => x.reason === NO_CHANGE_REASON && !fixedNow.has(x.itemId)).map((x) => x.itemId) };
  }

  /** Every item a run sent to Claude ends fixed or with a reason on the row. */
  private async settleItems(root: string, source: RemediationSource, itemIds: string[], reason?: string): Promise<void> {
    const rec = await loadRemediation(root, source);
    if (rec && markUnaddressed(rec, itemIds, reason || undefined)) await writeJsonAtomic(remediationPath(root, source), rec, true);
  }

  /**
   * Let Claude edit a copy of the project, then diff the copy into whole-file edits.
   * The project itself is untouched until applyFixes, which backs files up for Undo.
   */
  private async draftFixes(job: EnrichJob, items: Array<{ id: string }>, single: boolean, run: Pick<ClaudeRunOptions, "budgetUsd" | "onCost"> = {}): Promise<{ data: Remediation | null; error?: string; timedOut?: boolean }> {
    const instructions = agentInstructions("remediator");
    if (!existsSync(instructions)) throw new Error(`missing ${instructions}`);
    this.push(job, "Copying the project");
    const ws = await makeWorkspace(job.root);
    try {
      const itemsPath = path.join(ws, ".lens", "items.json");
      const outPath = path.join(ws, ".lens", "report.json");
      await writeJsonAtomic(itemsPath, { items }, true);
      const prompt = [
        `Follow the agent instructions in ${instructions} (read that file first).`,
        `Project copy (edit files here): ${ws}`,
        `Items: ${itemsPath}`,
        `Report path: ${outPath}`,
        "If the report write is refused, put the JSON in your final message inside a ```json fence instead.",
        ...(single ? ["The owner picked this one item to fix. If it has an ownerNote, that is the owner's decision on how to fix it. Follow it."] : []),
      ].join("\n");
      const costBefore = job.costUsd ?? 0;
      let spent = 0;
      const onCost = (usd: number) => {
        spent = usd;
        if (run.onCost) run.onCost(usd);
        else job.costUsd = costBefore + usd;
      };
      const { code, stderr, resultError, resultText, timedOut } = await this.runClaude(job, prompt, ["Read", "Grep", "Glob", "Edit", "Write"], MODEL_ARGS, ws, { timeoutEndsJob: false, budgetUsd: run.budgetUsd, onCost });
      if (items.length) await recordFixCost(job.root, items.every((i) => isRefactorItem(i.id)) ? "refactor" : "batch", { items: items.length, usd: spent });
      if (job.state !== "running") return { data: null };
      if (timedOut) return { data: null, error: resultError, timedOut };
      const raw = (await readJson<unknown>(outPath)) ?? fencedJson(resultText);
      if (!raw) return { data: null, error: resultError ?? (code ? `Claude Code exited with code ${code}: ${stderr.trim().split("\n").pop() ?? ""}` : "Claude didn't report what it changed") };
      const parsed = WorkspaceReportSchema.safeParse(raw);
      if (!parsed.success) return { data: null, error: `the fix report failed validation:\n${formatZodError(parsed.error)}` };
      this.push(job, "Checking the changes");
      const { data, ignored } = await collectChanges(job.root, ws, parsed.data);
      if (ignored.length) this.push(job, `Ignored changes to ${ignored.slice(0, 3).join(", ")}${ignored.length > 3 ? "…" : ""}`);
      return { data };
    } finally {
      await fs.rm(ws, { recursive: true, force: true });
    }
  }

  /** Ask the architect agent for a target layout, read-only, and store it as areas of file moves. */
  private async planLayout(job: EnrichJob) {
    const { root } = job;
    const g = await loadGraph(root);
    if (!g?.layout) throw new Error("no layout report for this project; rescan it first");
    const instructions = agentInstructions("architect");
    if (!existsSync(instructions)) throw new Error(`missing ${instructions}`);
    const dir = paths(root).intermediate;
    await fs.mkdir(dir, { recursive: true });
    const ctxPath = path.join(dir, "context-layout.json");
    const outPath = path.join(dir, "layout-plan.json");
    await writeJsonAtomic(ctxPath, planContext(g), true);
    await fs.rm(outPath, { force: true });
    const prompt = [
      `Follow the agent instructions in ${instructions} (read that file first).`,
      `Project root: ${root}`,
      `Context: ${ctxPath}`,
      `Plan path: ${outPath}`,
      "Read-only: write the plan file and nothing else.",
    ].join("\n");
    const tools = ["Read", "Grep", "Glob", "Edit(./.lens/intermediate/layout-plan.json)"];
    const { code, stderr, resultError, resultText } = await this.runClaude(job, prompt, tools, MODEL_ARGS);
    if (job.state !== "running") return;
    const raw = (await readJson<unknown>(outPath)) ?? fencedJson(resultText);
    if (!raw) throw new Error(resultError ?? (code ? `Claude Code exited with code ${code}: ${stderr.trim().split("\n").pop() ?? ""}` : "the architect did not write a plan"));
    const parsed = LayoutPlanSchema.safeParse(raw);
    if (!parsed.success) throw new Error(`the layout plan failed validation:\n${formatZodError(parsed.error)}`);
    const record = buildPlanRecord(root, parsed.data, job.costUsd);
    if (!record.areas.length) throw new Error("the plan had no moves Lens can make");
    await saveLayoutPlan(root, record);
    await fs.rm(outPath, { force: true });
    job.architecture = { areas: record.areas.length, moves: record.areas.reduce((n, a) => n + a.moves.length, 0) };
    this.finish(job, "done");
  }

  /**
   * Move one area's files in a copy of the project, let the layout-mover agent fix every reference,
   * then apply the diff as one "layout" fix with a backup for Undo.
   */
  private async moveArea(job: EnrichJob, areaId: string) {
    const { root } = job;
    const plan = await loadLayoutPlan(root);
    const area = plan?.areas.find((a) => a.id === areaId);
    if (!plan || !area) throw new Error("that area is not in the layout plan");
    if (area.status === "applied") throw new Error("that area is already moved");
    const moves = usableMoves(root, area.moves);
    if (!moves.length) throw new Error("none of this area's moves can be made now; plan again");
    job.architecture = { areas: 1, moves: moves.length, areaId };
    const instructions = agentInstructions("layout-mover");
    if (!existsSync(instructions)) throw new Error(`missing ${instructions}`);
    this.push(job, "Copying the project");
    const ws = await makeWorkspace(root);
    let data: Remediation;
    try {
      this.push(job, `Moving ${moves.length} file${moves.length === 1 ? "" : "s"}`);
      await moveFiles(ws, moves);
      const movesPath = path.join(ws, ".lens", "moves.json");
      await writeJsonAtomic(movesPath, { area: { title: area.title, reason: area.reason }, moves }, true);
      const prompt = [
        `Follow the agent instructions in ${instructions} (read that file first).`,
        `Project copy (edit files here): ${ws}`,
        `Moves: ${movesPath}`,
      ].join("\n");
      const { code, stderr, resultError } = await this.runClaude(job, prompt, ["Read", "Grep", "Glob", "Edit", "Write"], MODEL_ARGS, ws);
      if (job.state !== "running") return;
      // A run that stopped partway leaves some imports pointing at old paths, so nothing from it is applied.
      if (resultError || code) throw new Error(resultError ?? `Claude Code exited with code ${code}: ${stderr.trim().split("\n").pop() ?? ""}`);
      this.push(job, "Checking the changes");
      const report = { summary: area.title, fixes: [{ itemId: `layout-${area.id}`, title: area.title, explanation: area.reason, files: [] }], skipped: [] };
      ({ data } = await collectChanges(root, ws, report));
    } finally {
      await fs.rm(ws, { recursive: true, force: true });
    }
    const record = buildRecord(root, "layout", data, job.costUsd, undefined, `${area.id}-${Date.now().toString(36)}`);
    const prior = await loadRemediation(root, "layout");
    const merged = prior
      ? { ...record, costUsd: (prior.costUsd ?? 0) + (job.costUsd ?? 0), fixes: [...prior.fixes, ...record.fixes], skipped: [...prior.skipped, ...record.skipped], edits: { ...prior.edits, ...record.edits } }
      : record;
    await writeJsonAtomic(remediationPath(root, "layout"), merged, true);
    const fix = record.fixes[0];
    if (!fix || fix.invalid) throw new Error(fix?.invalid ? `the moves could not be applied: ${fix.invalid}` : "the moves changed no files");
    this.push(job, "Applying the moves");
    const { applied, failed } = await applyFixes(root, "layout", [fix.id]);
    if (!applied.length) throw new Error(`the moves could not be applied: ${failed[0]?.error ?? "unknown error"}`);
    area.status = "applied";
    await saveLayoutPlan(root, plan);
    this.push(job, "Rescanning");
    await renameScannedPaths(root, area.moves);
    await scanAndSave(root);
    job.remediation = { source: "layout", proposed: 1, invalid: 0, skipped: 0, applied: 1 };
    this.finish(job, "done");
  }

  /** Fix items in a copy of the project, then apply every valid change with a backup for Undo. */
  private async runRemediate(job: EnrichJob, source: FixSource, checkId?: string, note?: string) {
    if (!checkId && source !== "review") return this.runFixAll(job, source);
    if (source === "health" && checkId && REFACTOR_CHECKS.has(checkId)) return this.runFixAll(job, source, (id) => id.startsWith(`${checkId}~`));
    const { root } = job;
    // One item the owner picked: no size limit, and their note rides along as data.
    const single = !!checkId && (/^review-\d+$/.test(checkId) || checkId.includes("~"));
    const items = (await remediationItems(root, source, checkId)).map((i) => (single && note ? { ...i, ownerNote: note.slice(0, 600) } : i));
    if (!items.length) throw new Error(source === "audit" ? "nothing in the checklist is failing" : source === "health" ? "that check has nothing to fix" : "the review has no high or medium findings");
    const covered = await coveredFiles(root);
    const { data, error } = await this.draftFixes(job, items, single);
    if (job.state !== "running") return;
    if (!data) throw new Error(error ?? "no fixes were proposed");
    this.push(job, "Checking each edit against the code");
    const record = buildRecord(root, source, data, job.costUsd, checkId, `s${Date.now().toString(36)}`);
    const testRepair = source === "health" && checkId === TEST_REPAIR_ID;
    if (testRepair) {
      const scope = await loadRepairItems(root);
      const refused = confineFixes(record, (file) => inRepairScope(scope, file));
      if (refused) this.push(job, `Refused ${refused} fix${refused === 1 ? "" : "es"} outside the pull request's files`);
    }
    // Keep earlier results (and their Undo edits); this run replaces only its own items.
    const prior = await loadRemediation(root, source);
    const review = source === "review" ? await readJson<ReviewRecord>(reviewPath(root)) : null;
    // Review ids are stable since the ledger started; records older than that used other numbering.
    const keepPrior = prior && !prior.legacyIds && (!review || prior.generatedAt >= (review.stableSince ?? review.generatedAt));
    if (keepPrior) {
      const mine = new Set(items.map((i) => i.id));
      const merged = {
        ...record,
        checkId: prior.checkId === checkId ? checkId : undefined,
        costUsd: (prior.costUsd ?? 0) + (job.costUsd ?? 0),
        fixes: [...prior.fixes.filter((f) => !mine.has(f.itemId) || f.status === "applied"), ...record.fixes],
        skipped: [...prior.skipped.filter((x) => !mine.has(x.itemId)), ...record.skipped],
        edits: { ...prior.edits, ...record.edits },
      };
      await writeJsonAtomic(remediationPath(root, source), merged, true);
    } else await writeJsonAtomic(remediationPath(root, source), record, true);
    // Fix means fix: apply every edit that passed validation. Each file is backed up first, so Undo restores it.
    const valid = record.fixes.filter((f) => !f.invalid).map((f) => f.id);
    let applied = 0;
    if (valid.length) {
      this.push(job, `Applying ${valid.length} fix${valid.length === 1 ? "" : "es"}`);
      applied = (await applyFixes(root, source, valid)).applied.length;
      this.push(job, "Rescanning");
      await scanAndSave(root);
    }
    await this.settleItems(root, source, items.map((i) => i.id));
    job.remediation = { source, proposed: valid.length, invalid: record.fixes.filter((f) => f.invalid).length, skipped: record.skipped.length, applied };
    // A test repair stays inside the pull request's files; reviewing its own edits would widen it.
    if (!testRepair) await this.fixOwnFindings(job, source, await this.reviewOwnChanges(job, changedPaths(record, valid), covered), covered);
    this.finish(job, "done");
  }

  /**
   * Fix everything fixable on the Health page: batches of FIX_ALL_BATCH until nothing is
   * left, applying and rescanning after each so fixed hits drop out of the next batch.
   * Stops on cancel, at the job's spending limit, or when a batch makes no progress.
   */
  private async runFixAll(job: EnrichJob, source: "audit" | "health", only?: (itemId: string) => boolean) {
    const { root } = job;
    // Findings from checking Lens's own changes are always in scope, even when `only` narrows the run.
    const ownFindings = new Set<string>();
    const pending = async () => (await remediationItems(root, source, undefined, Infinity)).filter((i) => !only || only(i.id) || ownFindings.has(i.id));
    // Find problems first when that report hasn't been run yet.
    const plan = only ? { first: undefined, firstLimit: 0 } : await fixAllPlan(root, source);
    if (plan.first) {
      const saved = job.budgetUsd;
      job.budgetUsd = Math.min(saved, plan.firstLimit);
      this.push(job, plan.first === "audit" ? "Auditing the code" : "Reviewing the code");
      const ok = await this.timed(job, plan.first);
      job.budgetUsd = saved;
      if (!ok) return;
      job.audit = undefined;
      job.review = undefined;
    }
    const total = only ? (await pending()).length : await fixableCount(root, source);
    const progress: FixAllProgress = { attempted: 0, total, fixed: 0, batches: 0 };
    // Items from a batch that ran out of time, retried one per run.
    const alone = new Set<string>();
    // Runs that finished, so a timed-out batch doesn't count toward the average or the no-progress stop.
    let finishedRuns = 0;
    const EMPTY_RUNS_BEFORE_STOP = 3;
    job.fixAll = progress;
    const tried = new Set<string>();
    // Items whose fix changed no files get one more attempt, told so.
    const retried = new Set<string>();
    const runTag = Date.now().toString(36);
    // Keep earlier applied fixes (for Undo and the FIXED badge) and skips that found the code already safe.
    // Review ids (review-<i>) are stable since the ledger started; older records used other numbering.
    const prior = await loadRemediation(root, source);
    const since = (await readJson<ReviewRecord>(reviewPath(root)))?.stableSince;
    const stable = (id: string) => !id.startsWith("review-") || (!!since && !!prior && prior.generatedAt >= since);
    const kept = (prior?.fixes ?? []).filter((f) => f.status === "applied" && stable(f.itemId));
    const merged: Awaited<ReturnType<typeof buildRecord>> = {
      generatedAt: new Date().toISOString(),
      source,
      fixes: kept,
      skipped: (prior?.skipped ?? []).filter((x) => ALREADY_SAFE.test(x.reason) && stable(x.itemId)),
      edits: Object.fromEntries(kept.map((f) => [f.id, prior?.edits?.[f.id] ?? []])),
    };
    const key = (i: { title: string; evidence: string[] }) => `${i.title}|${i.evidence[0]}`;
    let cost = new ParallelCost(job);
    const applyInOrder = serialQueue();
    const startedAt = Date.now();
    // Drafts one batch on its own copy of the project, then applies it while no other batch is applying.
    const runBatch = async (items: RemediationItem[], batch: number, budgetUsd: number) => {
      const { data, error, timedOut } = await this.draftFixes(job, items, false, { budgetUsd, onCost: (usd) => cost.update(batch, usd) });
      cost.settle(batch);
      if (job.state !== "running") return;
      if (timedOut && items.length > 1) {
        this.push(job, `Batch ${batch} ran past ${timeoutLabel(claudeTimeoutMs())}. Retrying its ${items.length} issues one at a time`);
        for (const i of items) {
          alone.add(i.id);
          tried.delete(key(i));
        }
        return;
      }
      progress.attempted += items.length;
      finishedRuns++;
      progress.msPerRun = Math.round((Date.now() - startedAt) / finishedRuns);
      await applyInOrder(async () => {
        if (job.state !== "running") return;
        if (!data) {
          this.push(job, `Batch ${batch} produced no usable fixes${error ? `: ${error}` : ""}`);
          markUnaddressed(merged, items.map((i) => i.id), error?.slice(0, 600) || undefined);
          await writeJsonAtomic(remediationPath(root, source), merged, true);
          if (error?.includes("spending") || error?.includes("safety limit")) progress.stopped ??= "reached the spending limit";
          return;
        }
        const rec = buildRecord(root, source, data, undefined, undefined, `${runTag}b${batch}`);
        merged.fixes.push(...rec.fixes);
        merged.skipped.push(...rec.skipped);
        Object.assign(merged.edits, rec.edits);
        merged.costUsd = job.costUsd;
        await writeJsonAtomic(remediationPath(root, source), merged, true);
        const valid = rec.fixes.filter((f) => !f.invalid).map((f) => f.id);
        let applied: string[] = [];
        if (valid.length) {
          const result = await applyFixes(root, source, valid);
          applied = result.applied;
          // applyFixes updated statuses on disk; keep the in-memory record in step.
          for (const f of merged.fixes) if (applied.includes(f.id)) f.status = "applied";
          for (const { id, error } of result.failed) {
            const f = merged.fixes.find((x) => x.id === id);
            if (f && !f.invalid) f.invalid = error.slice(0, 600);
          }
          this.push(job, `Applied ${applied.length}; rescanning`);
          await scanAndSave(root);
        }
        progress.fixed += applied.length;
        if (!applied.length && finishedRuns >= EMPTY_RUNS_BEFORE_STOP && progress.fixed === 0) progress.stopped ??= "three batches in a row produced nothing to apply";
        const fixedNow = new Set(rec.fixes.filter((f) => !f.invalid).map((f) => f.itemId));
        const retry = new Set(rec.skipped.filter((x) => x.reason === NO_CHANGE_REASON && !fixedNow.has(x.itemId) && !retried.has(x.itemId)).map((x) => x.itemId));
        if (retry.size) {
          merged.skipped = merged.skipped.filter((x) => !(retry.has(x.itemId) && x.reason === NO_CHANGE_REASON));
          for (const i of items) if (retry.has(i.id)) tried.delete(key(i));
          for (const id of retry) retried.add(id);
          await writeJsonAtomic(remediationPath(root, source), merged, true);
        }
        markUnaddressed(merged, items.map((i) => i.id).filter((id) => !retry.has(id)));
      });
    };
    // One pass over every untried open item: up to FIX_ALL_CONCURRENCY batches at once, none sharing a file.
    const fixPending = async () => {
      const running = new Map<Promise<void>, { items: RemediationItem[]; budgetUsd: number }>();
      // Reviews between passes add to the job's cost, so each pass starts from the current total.
      cost = new ParallelCost(job);
      while (job.state === "running" && !progress.stopped) {
        const busy = [...running.values()].flatMap((r) => r.items);
        const busyIds = new Set(busy.map((i) => i.id));
        const left = (await pending())
          .filter((i) => !tried.has(key(i)) && !busyIds.has(i.id))
          .map((i) => (retried.has(i.id) ? { ...i, evidence: [...i.evidence, NO_CHANGE_NOTE] } : i));
        const items = running.size >= FIX_ALL_CONCURRENCY ? [] : pickFixBatch(left, busy, alone);
        const reserved = [...running.values()].reduce((sum, r) => sum + r.budgetUsd, 0);
        const remaining = job.budgetUsd - cost.settled() - reserved;
        if (items.length && remaining < MIN_RUN_USD && !running.size) progress.stopped = "reached the spending limit";
        if (!items.length || remaining < MIN_RUN_USD) {
          if (!running.size) break;
          await Promise.race(running.keys());
          continue;
        }
        for (const i of items) tried.add(key(i));
        const batch = ++progress.batches;
        progress.current = items.every((i) => i.title === items[0]!.title) ? items[0]!.title : "Mixed Issues";
        const picked = new Set(items.map((i) => i.id));
        progress.runsLeft = countFixRuns(left.filter((i) => !picked.has(i.id)), alone);
        this.push(job, `Batch ${batch}: ${items.length} issues`);
        const budgetUsd = Math.round(Math.min(remaining, isRefactorItem(items[0]!.id) ? REFACTOR_ITEM_LIMIT_USD : estimateCost("remediate", items.length).limit) * 100) / 100;
        const task: Promise<void> = runBatch(items, batch, budgetUsd).finally(() => running.delete(task));
        running.set(task, { items, budgetUsd });
      }
      await Promise.all(running.keys());
    };
    const covered = await coveredFiles(root);
    // Fix everything, check Lens's changes, fix what the check found, until a check comes back clean.
    // No round limit: the run's budget stops it, and a round that applies nothing ends it.
    while (job.state === "running" && !progress.stopped) {
      const before = new Set(merged.fixes.filter((f) => f.status === "applied").map((f) => f.id));
      await fixPending();
      const appliedNow = merged.fixes.filter((f) => f.status === "applied" && !before.has(f.id)).map((f) => f.id);
      if (!appliedNow.length) break;
      const reaudited = source === "audit" && (await this.reauditFixedChecks(job, merged, appliedNow));
      const added = await this.reviewOwnChanges(job, changedPaths(merged, appliedNow), covered);
      if (!added.length && !reaudited) break;
      for (const i of added) ownFindings.add(`review-${i}`);
      progress.total += added.length;
    }
    // Anything still open after the run says why: Lens stopped first, or couldn't fix it.
    if (job.state === "running") {
      const left = (await pending()).map((i) => i.id);
      markUnaddressed(merged, left, progress.stopped ? `Lens stopped first: ${progress.stopped}.` : undefined);
    }
    merged.costUsd = job.costUsd;
    await writeJsonAtomic(remediationPath(root, source), merged, true);
    if (source === "audit") await markVerifiedSafe(root);
    job.remediation = { source, proposed: merged.fixes.filter((f) => !f.invalid).length, invalid: merged.fixes.filter((f) => f.invalid).length, skipped: merged.skipped.length, applied: progress.fixed };
    this.finish(job, "done");
  }
}

/**
 * Fix All on one page: the report to run first (when it hasn't been run), items to fix
 * now, and the expected cost of both. Items found by that first run aren't counted yet.
 */
/** A skip where the agent found the code already handles the issue. Not offered again. */
export const ALREADY_SAFE = /^(scanner was wrong|already (safe|hardened|handled|fixed))\b/i;
/** Rule id for an action referenced by tag or branch instead of a commit SHA. */
const GHA_UNPINNED = "gha-unpinned-action";
/** Same cap the triage patch puts on a finding's note. */
const FINDING_NOTE_MAX = 800;

/**
 * Mark findings Remediate checked and found already safe as No Fix Needed, then rescan so the
 * risk score drops. Without this they stay Open in the Security table forever, since Remediate
 * won't offer them again. Returns how many findings changed.
 */
export async function markVerifiedSafe(root: string): Promise<number> {
  const g = await loadGraph(root);
  const rec = await loadRemediation(root, "audit");
  if (!g?.security || !rec) return 0;
  const reasons = new Map(rec.skipped.filter((x) => ALREADY_SAFE.test(x.reason)).map((x) => [x.itemId, x.reason]));
  let changed = 0;
  for (const f of g.security.findings) {
    const reason = reasons.get(findingItemId(f));
    if (!reason || f.status === "false_positive" || f.status === "accepted") continue;
    f.status = "false_positive";
    f.triageNote = reason.replace(/^scanner was wrong[:.,]?\s*/i, "").slice(0, FINDING_NOTE_MAX);
    changed++;
  }
  if (!changed) return 0;
  await saveGraph(root, g);
  await scanAndSave(root);
  return changed;
}

/**
 * One item per finding id. Findings of the same rule in the same file share an id, and a fix
 * for that id closes all of them, so Claude gets every line, not just the first.
 */
export async function findingItems(findings: Finding[]): Promise<RemediationItem[]> {
  const byId = new Map<string, { id: string; title: string; evidence: string[]; fix?: string }>();
  for (const f of findings) {
    const id = findingItemId(f);
    const pin = f.rule === GHA_UNPINNED ? await actionPinFix(f.snippet ?? "") : undefined;
    const fix = [f.status === "accepted" ? acceptedFix(f.rule) : undefined, pin].filter(Boolean).join(" ") || undefined;
    const item = byId.get(id);
    if (!item) {
      byId.set(id, { id, title: f.title, evidence: [`${f.path}:${f.line} ${f.message}`], fix });
      continue;
    }
    item.evidence.push(`${f.path}:${f.line} ${f.message}`);
    if (fix && !item.fix?.includes(fix)) item.fix = item.fix ? `${item.fix} ${fix}` : fix;
  }
  return [...byId.values()];
}

/** Accepted findings stay as designed; Fix hardens them instead. */
function acceptedFix(rule: string): string {
  return rule === "unauthenticated-mutation" || rule === "server-action-no-auth"
    ? "This route is public by design. Do not add login. Harden it: per-IP rate limiting, strict input validation, and for confirm/unsubscribe/share links a signed, expiring token instead of a guessable id. Skip if the project already does this."
    : "Triaged as accepted risk. Reduce it where that's possible without changing behavior; skip if it isn't.";
}

/** Code files the review covers. */
function reviewFiles(g: KnowledgeGraph): ReviewFile[] {
  return g.nodes.filter((n) => n.kind === "file" && n.path).map((n) => ({ path: n.path!, loc: n.metrics?.loc ?? 0 }));
}

/** The ledger, with the time its ids became stable filled in for a review saved before the ledger. */
async function loadReview(root: string): Promise<ReviewRecord> {
  const rec = await readJson<ReviewRecord>(reviewPath(root));
  const now = new Date().toISOString();
  if (!rec) return { generatedAt: now, report: REVIEW_REPORT, findings: [], stableSince: now };
  return { ...rec, stableSince: rec.stableSince ?? rec.generatedAt };
}

/** Stamp an existing review as up to date, so a merge with nothing left to review stops showing "Before #N". */
export async function markReviewCurrent(root: string, now = new Date().toISOString()): Promise<void> {
  const rec = await readJson<ReviewRecord>(reviewPath(root));
  if (!rec) return;
  await writeJsonAtomic(reviewPath(root), { ...rec, stableSince: rec.stableSince ?? rec.generatedAt, generatedAt: now }, true);
}

async function saveReview(root: string, record: ReviewRecord): Promise<void> {
  await writeJsonAtomic(reviewPath(root), record, true);
  await fs.writeFile(path.join(root, REVIEW_REPORT), renderReport(record, await reviewClosed(root)));
}

/** Review findings Lens fixed or found already safe, and the owner's Won't Fix keys. */
export async function reviewClosed(root: string): Promise<{ fixed: Set<number>; wontFix: Set<string> }> {
  const review = await readJson<ReviewRecord>(reviewPath(root));
  const since = review?.stableSince ?? review?.generatedAt;
  const fixed = new Set<number>();
  for (const source of ["review", "health"] as const) {
    const rec = await loadRemediation(root, source);
    if (!rec || !since || rec.generatedAt < since) continue;
    const ids = [...rec.fixes.filter((f) => f.status === "applied").map((f) => f.itemId), ...rec.skipped.filter((x) => ALREADY_SAFE.test(x.reason)).map((x) => x.itemId)];
    for (const id of ids) {
      const i = reviewIndex(id);
      if (i !== undefined) fixed.add(i);
    }
  }
  return { fixed, wontFix: new Set(await loadWontFix(root)) };
}

/** Files waiting for review (new or changed since their last review) and what reviewing them costs. */
export async function reviewPlan(root: string, graph?: KnowledgeGraph | null): Promise<{ files: number; batches: number; estimate: CostEstimate }> {
  const g = graph ?? (await loadGraph(root));
  const files = g ? reviewFiles(g) : [];
  const pending = pendingReview(files, await hashFiles(root, files.map((f) => f.path)), await loadCoverage(root));
  const batches = planBatches(pending).length;
  return { files: pending.length, batches, estimate: reviewEstimate(batches) };
}

const fencedJson = (text: string): unknown => {
  try {
    return JSON.parse(new RegExp("```json\\s*\\n([\\s\\S]*?)\\n```").exec(text)?.[1] ?? "null");
  } catch {
    return null;
  }
};

export async function fixAllPlan(root: string, source: "audit" | "health"): Promise<{ first: "audit" | "review" | null; firstLimit: number; items: number; estimate: CostEstimate }> {
  const g = await loadGraph(root);
  const files = g?.nodes.filter((n) => n.kind === "file" && n.path).length ?? 0;
  // The audit runs again when it's missing or older than the latest commit. The review runs whenever a file is new or changed since it was reviewed.
  const auditAt = source === "audit" ? Date.parse((await readJson<{ generatedAt?: string }>(auditPath(root)))?.generatedAt ?? "") || 0 : 0;
  const review = source === "health" ? await reviewPlan(root, g) : null;
  const first = review ? (review.batches ? "review" : null) : auditAt && auditAt >= headCommitTime(root) ? null : "audit";
  const pre = !first ? { low: 0, high: 0, limit: 0 } : review ? review.estimate : estimateCost("audit", files);
  const open = await remediationItems(root, source, undefined, Infinity);
  const items = open.length;
  // Refactors each get their own run and cap, so they're priced apart from batch fixes.
  const refactors = source === "health" ? open.filter((i) => isRefactorItem(i.id)).length : 0;
  // Price from what this project's fixes have cost so far.
  const costs = await loadFixCosts(root);
  const refactorRate = itemRate(costs.refactor, DEFAULT_REFACTOR_ITEM_RATE);
  // Before the first run, assume about ten more items will turn up.
  const batch = estimateFixAll(Math.max(1, items - refactors + (first ? 10 : 0)), itemRate(costs.batch, DEFAULT_BATCH_ITEM_RATE));
  // Fixing a checklist check means auditing again to confirm it passes.
  const reaudit = source === "audit" && open.some((i) => !i.id.startsWith("finding-")) ? estimateCost("audit", files) : { low: 0, high: 0, limit: 0 };
  const fix = {
    low: batch.low + refactors * refactorRate.low + reaudit.low,
    high: batch.high + refactors * refactorRate.high + reaudit.high,
    limit: batch.limit + refactors * REFACTOR_ITEM_LIMIT_USD + reaudit.limit,
  };
  const r = (n: number) => Math.round(n * 100) / 100;
  // The run stops at the limit, so no end of the range can sit above it.
  const limit = r(Math.min(MAX_FIX_ALL_USD, pre.limit + fix.limit + FIX_CHECK_RESERVE_USD));
  return { first, firstLimit: pre.limit, items, estimate: { low: Math.min(limit, r(pre.low + fix.low)), high: Math.min(limit, r(pre.high + fix.high)), limit } };
}

/** Files the given fixes changed, without deletions. */
function changedPaths(record: { edits: Record<string, Array<{ path: string; delete?: boolean }>> }, fixIds: string[]): string[] {
  return [...new Set(fixIds.flatMap((id) => (record.edits[id] ?? []).filter((e) => !e.delete).map((e) => e.path)))];
}

/** The working-tree diff of these files against HEAD, truncated. Empty outside a git repo. */
function gitDiff(root: string, files: string[]): string {
  try {
    return execFileSync("git", ["diff", "HEAD", "--", ...files], { cwd: root, encoding: "utf8", timeout: 10_000, maxBuffer: 10_000_000 }).slice(0, FIX_CHECK_DIFF_CHARS);
  } catch {
    return "";
  }
}

/** Last commit time in ms, or 0 outside a git repo. */
function headCommitTime(root: string): number {
  try {
    return Number(execFileSync("git", ["log", "-1", "--format=%ct"], { cwd: root, encoding: "utf8", timeout: 10_000 }).trim()) * 1000 || 0;
  } catch {
    return 0;
  }
}

/** Everything Fix All can work on for a page. */
/** Open rows a Fix All run would send: the same set the page lists as open, without Fixed, safe, or Won't Fix rows. */
export async function fixableCount(root: string, source: "audit" | "health" = "health"): Promise<number> {
  return (await remediationItems(root, source, undefined, Infinity)).length;
}

/** Failing checklist items (scanner + AI audit merged) or the review's high/medium findings. */
/** Hits handed to one run, so a check with hundreds of hits doesn't become one huge bill. */
export const HEALTH_BATCH = 15;
/** checkId for a run that repairs tests a Lens pull request broke. */
export const TEST_REPAIR_ID = "tests";
/** "Fix Issues" on the Health page: one run over the highest-priority items. */
export const FIX_ALL_LIMIT = 20;
/** Items per Fix All run when they come from different checks or the review. Small, since fixes have no size limit. */
const FIX_ALL_BATCH = 5;
/** Fix All batches drafted at once. Each edits its own copy; applying still happens one batch at a time. */
const FIX_ALL_CONCURRENCY = 4;
/** Hits of one Health check per Fix All run. They share one fix, so one run can take more of them. */
export const SAME_CHECK_BATCH = 25;
/** The Health check a hit belongs to, or undefined for review findings and audit items. */
const healthCheckOf = (id: string) => (id.includes("~") ? id.split("~")[0] : undefined);

/**
 * The next Fix All run's items. A refactor runs alone so Claude has the whole budget and time for it.
 * Hits of the same check go together, since each Claude run pays to load the project before it fixes anything.
 */
/** Claude runs needed for these items: one per item already marked to run alone, then batches as nextFixBatch picks them. */
export function countFixRuns(items: Array<{ id: string }>, alone: ReadonlySet<string> = new Set()): number {
  let rest = items.filter((i) => !alone.has(i.id));
  let runs = items.length - rest.length;
  while (rest.length) {
    const batch = new Set(nextFixBatch(rest));
    if (!batch.size) break;
    rest = rest.filter((i) => !batch.has(i));
    runs++;
  }
  return runs;
}

/** The file an item's evidence points at: "path:line detail" or "path detail". */
export function itemFile(item: { evidence: string[] }): string {
  return (item.evidence[0] ?? "").split(" ")[0]!.replace(/:\d+$/, "");
}

/**
 * The next batch to start beside the ones running. Items in a running batch's files wait, so two
 * batches never edit the same file. A refactor or a timed-out item waits until nothing else runs.
 */
export function pickFixBatch<T extends { id: string; evidence: string[] }>(left: T[], running: Array<{ id: string; evidence: string[] }>, alone: ReadonlySet<string>): T[] {
  const solo = left.find((i) => alone.has(i.id));
  const exclusive = solo ?? (left[0] && isRefactorItem(left[0].id) ? left[0] : undefined);
  if (exclusive) return running.length ? [] : [exclusive];
  if (running.some((i) => isRefactorItem(i.id) || alone.has(i.id))) return [];
  const busyFiles = new Set(running.map(itemFile));
  return nextFixBatch(left.filter((i) => !busyFiles.has(itemFile(i))));
}

export function nextFixBatch<T extends { id: string }>(left: T[]): T[] {
  if (left[0] && isRefactorItem(left[0].id)) return [left[0]];
  const fixes = left.filter((i) => !isRefactorItem(i.id));
  const check = fixes[0] && healthCheckOf(fixes[0].id);
  const sameCheck = check ? fixes.filter((i) => healthCheckOf(i.id) === check).slice(0, SAME_CHECK_BATCH) : [];
  if (sameCheck.length >= FIX_ALL_BATCH) return sameCheck;
  return fixes.slice(0, FIX_ALL_BATCH);
}
const SEV_RANK = { high: 0, medium: 1, low: 2 } as const;

export async function remediationItems(root: string, source: RemediationSource, checkId?: string, limit = FIX_ALL_LIMIT): Promise<RemediationItem[]> {
  if (source === "review") {
    const rec = await readJson<ReviewRecord>(reviewPath(root));
    // ids keep the finding's position in the review so the dashboard can mark it fixed.
    // checkId "review-<n>" narrows the run to one finding (any severity).
    const only = checkId ? Number(/^review-(\d+)$/.exec(checkId)?.[1] ?? -1) : null;
    const skip = new Set(await loadWontFix(root));
    return (rec?.findings ?? [])
      .map((f, i) => ({ f, i }))
      .filter(({ f, i }) => (only === null ? f.severity !== "low" && !f.resolvedAt && !skip.has(reviewKey(f)) : i === only))
      .map(({ f, i }) => ({ id: `review-${i}`, title: f.title, evidence: [`${f.path}${f.line ? `:${f.line}` : ""} ${f.detail}`], fix: f.fix }));
  }
  if (source === "health" && !checkId) {
    // Review findings not fixed yet, then every check's open hits (refactors included), up to FIX_ALL_LIMIT.
    // Review ids count only from records newer than the ledger's stable ids, as the dashboard does.
    // An older record's "review-3" names a different finding, and trusting it hid that finding from every run.
    const applied = new Set<string>([...(await reviewClosed(root)).fixed].map((i) => `review-${i}`));
    for (const s of ["review", "health"] as const) {
      const r = await loadRemediation(root, s);
      for (const f of r?.fixes ?? []) if (f.status === "applied" && !f.itemId.startsWith("review-")) applied.add(f.itemId);
      for (const x of r?.skipped ?? []) if (ALREADY_SAFE.test(x.reason) && !x.itemId.startsWith("review-")) applied.add(x.itemId);
    }
    const wontFix = new Set(await loadWontFix(root));
    const out: Array<{ id: string; title: string; evidence: string[]; fix?: string }> = [];
    const rec = await readJson<ReviewRecord>(reviewPath(root));
    (rec?.findings ?? [])
      .map((f, i) => ({ f, i }))
      .filter(({ f, i }) => !f.resolvedAt && !applied.has(`review-${i}`) && !wontFix.has(reviewKey(f)))
      .sort((a, b) => SEV_RANK[a.f.severity] - SEV_RANK[b.f.severity])
      .forEach(({ f, i }) => out.push({ id: `review-${i}`, title: f.title, evidence: [`${f.path}${f.line ? `:${f.line}` : ""} ${f.detail}`], fix: f.fix }));
    const g = await loadGraph(root);
    const checks = (g?.health?.checks ?? []).filter((c) => c.count > 0).sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity] || b.count - a.count);
    // Round-robin across checks so one noisy check doesn't take every slot.
    const open = checks.map((c) => {
      const ids = checkHitIds(c);
      return { c, hits: c.hits.map((h, k) => ({ h, id: ids[k]! })).filter((x) => !applied.has(x.id) && !wontFix.has(x.id)) };
    });
    for (let k = 0; out.length < limit && open.some((x) => x.hits[k]); k++)
      for (const { c, hits } of open) {
        const x = hits[k];
        if (!x || out.length >= limit) continue;
        out.push({ id: x.id, title: c.title, evidence: [`${x.h.path}${x.h.line ? `:${x.h.line}` : ""} ${x.h.detail}`], fix: c.fix });
      }
    return out.slice(0, limit);
  }
  // Tests a Lens pull request broke, written by the server's test watcher from the CI logs.
  if (source === "health" && checkId === TEST_REPAIR_ID) return loadRepairItems(root);
  if (source === "health" && checkId?.includes("~")) {
    // One hit, picked by the owner. Any check, not just the batch-fixable ones.
    const g = await loadGraph(root);
    const check = g?.health?.checks.find((c) => c.id === checkId.split("~")[0]);
    if (!check) return [];
    const k = checkHitIds(check).indexOf(checkId);
    const h = check.hits[k];
    return h ? [{ id: checkId, title: check.title, evidence: [`${h.path}${h.line ? `:${h.line}` : ""} ${h.detail}`], fix: check.fix }] : [];
  }
  if (source === "health") {
    // Every open hit of one check, picked by the owner.
    const g = await loadGraph(root);
    const check = g?.health?.checks.find((c) => c.id === checkId);
    if (!check) return [];
    const closed = new Set(await loadWontFix(root));
    const r = await loadRemediation(root, "health");
    for (const f of r?.fixes ?? []) if (f.status === "applied") closed.add(f.itemId);
    for (const x of r?.skipped ?? []) if (ALREADY_SAFE.test(x.reason)) closed.add(x.itemId);
    const ids = checkHitIds(check);
    return check.hits
      .map((h, i) => ({ id: ids[i]!, title: check.title, evidence: [`${h.path}${h.line ? `:${h.line}` : ""} ${h.detail}`], fix: check.fix }))
      .filter((x) => !closed.has(x.id))
      .slice(0, HEALTH_BATCH);
  }
  const g = await loadGraph(root);
  const audit = await auditWithDecisions(root);
  const ai = new Map((audit?.items ?? []).map((i) => [i.id, i]));
  const rem = await loadRemediation(root, "audit");
  const applied = new Set([...(rem?.fixes ?? []).filter((f) => f.status === "applied").map((f) => f.itemId), ...(rem?.skipped ?? []).filter((x) => ALREADY_SAFE.test(x.reason)).map((x) => x.itemId)]);
  const FINDING_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  const findings = await findingItems((g?.security?.findings ?? []).filter((f) => f.status !== "false_positive" && f.severity in FINDING_RANK).sort((a, b) => FINDING_RANK[a.severity]! - FINDING_RANK[b.severity]!));
  const checks = (g?.security?.checklist ?? [])
    .filter((c) => c.status !== "manual" && c.source !== "manual")
    .map((c) => {
      const v = ai.get(c.id);
      return v ? { ...c, status: v.status, evidence: v.evidence.length ? v.evidence : c.evidence, fix: v.fix ?? c.fix } : c;
    })
    .filter((c) => c.status === "fail")
    .map((c) => ({ id: c.id, title: c.title, evidence: c.evidence, fix: c.fix }));
  // The audit decides when a check is done. A fix or "already safe" skip hides a check only until the
  // next audit re-checks it; one fix rarely covers every place a check fails.
  const awaitingAudit = (Date.parse(rem?.generatedAt ?? "") || 0) > (Date.parse(audit?.generatedAt ?? "") || 0);
  const openChecks = checks.filter((c) => !(awaitingAudit && applied.has(c.id)));
  return [...openChecks, ...findings.filter((f) => !applied.has(f.id))].slice(0, limit);
}
