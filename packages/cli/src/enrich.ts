/**
 * Runs an LLM enrichment step from the dashboard by driving Claude Code headless
 * (`claude -p`). Same pipeline as the /lens-domain skill: build the context file,
 * let one agent write a patch, then validate and merge it with applyPatch, so the
 * agent still never writes the graph directly.
 *
 * Cost control: every run passes --max-budget-usd, and the actual cost from the
 * final stream-json result is reported back to the dashboard.
 */
import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { promises as fs, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyFixes, buildRecord, loadRemediation, remediationPath, type RemediationSource } from "./remediate.js";
import { AuditVerdictsSchema, PatchValidationError, RemediationSchema, ReviewFindingsSchema, type ReviewFindings, applyPatch, buildBatches, checkHitIds, reviewKey, findingItemId, scanAndSave, domainContext, formatZodError, loadGraph, loadMeta, paths, readJson, saveGraph, saveMeta, writeJsonAtomic, type AuditVerdicts } from "@lens/core";

export type EnrichTask = "domain" | "audit" | "summaries" | "review" | "remediate";

/** Stored at .lens/review.json; survives rescans. */
export interface ReviewRecord {
  generatedAt: string;
  costUsd?: number;
  summary?: string;
  report: string;
  findings: ReviewFindings["findings"];
}

/** Stored at .lens/audit.json; survives rescans. */
export interface AuditRecord {
  generatedAt: string;
  costUsd?: number;
  summary?: string;
  report: string;
  items: AuditVerdicts["items"];
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
  review?: { findings: number; report: string };
  remediation?: { source: RemediationSource; proposed: number; invalid: number; skipped: number; applied?: number };
  /** Cost of earlier Claude runs in this job (Fix runs several batches). */
  costBase?: number;
  /** Fix-everything progress. */
  fixAll?: { attempted: number; total: number; fixed: number; batches: number; stopped?: string };
  /** Which report a remediate run works from (and, for "health", which check). */
  source?: RemediationSource;
  checkId?: string;
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
    : task === "review" ? [0.6 + 0.004 * f, 1.5 + 0.008 * f]
    : task === "remediate" ? [0.3 + 0.12 * Math.min(files, 30), 0.8 + 0.25 * Math.min(files, 30)]
    : [0.3 + 0.003 * f, 0.8 + 0.007 * f];
  const r = (n: number) => Math.round(n * 100) / 100;
  return { low: r(Math.max(0.05, low)), high: r(Math.max(0.2, high)), limit: r(Math.min(MAX_BUDGET_USD, Math.max(0.5, high * 2))) };
}
/** Fix everything with no size limit per fix, with a limit at 1.5x the high end. */
export function estimateFixAll(items: number): CostEstimate {
  const low = Math.max(0.3, 0.15 * items);
  const high = Math.max(0.8, 0.4 * items);
  return { low: Math.round(low * 100) / 100, high: Math.round(high * 100) / 100, limit: Math.round(Math.min(150, high * 1.5) * 100) / 100 };
}

/** Sonnet handles all four jobs well at a fraction of the cost of the largest model. */
const MODEL_ARGS = ["--model", "sonnet"];
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
const TIMEOUT_MS = 20 * 60_000;

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
      return `Searching for "${String(input.pattern ?? "").slice(0, 60)}"`;
    case "Glob":
      return `Listing ${String(input.pattern ?? "")}`;
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

export class EnrichRunner {
  job: EnrichJob | null = null;
  private child: ChildProcess | null = null;

  get running(): boolean {
    return this.job?.state === "running";
  }

  start(task: EnrichTask, root: string, budgetUsd: number, opts: { source?: RemediationSource; checkId?: string; note?: string } = {}): EnrichJob {
    if (this.running) throw new Error("an AI run is already in progress");
    const job: EnrichJob = { task, root, state: "running", startedAt: Date.now(), budgetUsd, progress: ["Preparing context"], ...(task === "remediate" ? { source: opts.source ?? "audit", checkId: opts.checkId } : {}) };
    this.job = job;
    console.log(`[ai] start ${task}${job.source ? `/${job.source}` : ""} in ${path.basename(root)}, limit $${budgetUsd}`);
    (task === "audit" ? this.runAudit(job) : task === "summaries" ? this.runSummaries(job) : task === "review" ? this.runReview(job) : task === "remediate" ? this.runRemediate(job, opts.source ?? "audit", opts.checkId, opts.note) : this.runDomain(job)).catch((e: unknown) => this.finish(job, "error", (e as Error).message));
    return job;
  }

  cancel(): void {
    if (!this.running || !this.job) return;
    this.child?.kill("SIGTERM");
    this.finish(this.job, "cancelled", "cancelled");
  }

  private finish(job: EnrichJob, state: EnrichJob["state"], error?: string) {
    if (job.state !== "running") return;
    job.state = state;
    const secs = Math.round((Date.now() - job.startedAt) / 1000);
    console.log(`[ai] ${state} ${job.task} after ${secs}s, $${(job.costUsd ?? 0).toFixed(2)}${error ? `: ${error.slice(0, 300)}` : ""}`);
    job.finishedAt = Date.now();
    if (error && state !== "done") job.error = friendlyError(error).slice(0, 400);
    this.child = null;
  }

  private push(job: EnrichJob, line: string) {
    if (job.progress[job.progress.length - 1] === line) return;
    job.progress.push(line);
    if (job.progress.length > 30) job.progress.splice(0, job.progress.length - 30);
  }

  /** Spawn Claude Code, stream its tool calls into the job's progress, resolve on exit. */
  private async runClaude(job: EnrichJob, prompt: string, tools: string[], extraArgs: string[] = []): Promise<{ code: number | null; stderr: string; resultError?: string; resultText: string }> {
    const args = [
      "-p", prompt,
      "--output-format", "stream-json", "--verbose",
      "--no-session-persistence",
      "--max-budget-usd", String(job.budgetUsd),
      ...extraArgs,
      "--allowedTools", ...tools,
    ];
    this.push(job, "Starting Claude Code");
    const child = spawn(claudeBin(), args, { cwd: job.root, stdio: ["ignore", "pipe", "pipe"], env: childEnv() });
    this.child = child;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      this.finish(job, "error", "timed out after 20 minutes");
    }, TIMEOUT_MS);

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
          for (const c of msg.message?.content ?? []) if (c.type === "tool_use" && c.name) this.push(job, describeTool(c.name, c.input ?? {}, job.root));
        } else if (msg.type === "result") {
          if (typeof msg.total_cost_usd === "number") job.costUsd = (job.costBase ?? 0) + msg.total_cost_usd;
          if (typeof msg.result === "string") resultText = msg.result;
          if (msg.is_error || (msg.subtype && msg.subtype !== "success")) {
            resultError = msg.subtype === "error_max_budget_usd" ? `stopped at the $${job.budgetUsd.toFixed(2)} safety limit` : String(msg.result ?? msg.subtype ?? "Claude Code reported an error");
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
    return { code, stderr, resultError, resultText };
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

  /** Runs an audit or review step and records how long it took. */
  private async timed(job: EnrichJob, kind: "audit" | "review"): Promise<boolean> {
    const step = { kind, startedAt: Date.now(), typicalMs: await typicalDuration(job.root, kind) };
    job.step = step;
    const ok = kind === "audit" ? await this.auditStep(job) : await this.reviewStep(job);
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
  private async runReview(job: EnrichJob) {
    if (await this.timed(job, "review")) this.finish(job, "done");
  }

  /** Runs the review and saves it. False when the job stopped. */
  private async reviewStep(job: EnrichJob): Promise<boolean> {
    const { root } = job;
    // Remediate finds everything: refresh the automatic checks first (free), then review.
    this.push(job, "Rescanning");
    await scanAndSave(root);
    const g = await loadGraph(root);
    if (!g) throw new Error("no graph for this project; scan it first");
    const dir = paths(root).intermediate;
    await fs.mkdir(dir, { recursive: true });
    const ctxPath = path.join(dir, "context-health.json");
    const outPath = path.join(dir, "review.json");
    const reportPath = path.join(root, REVIEW_REPORT);
    const files = g.nodes.filter((n) => n.kind === "file" && n.path).map((n) => ({ path: n.path!, loc: n.metrics?.loc ?? 0, layer: n.layer, complexity: n.complexity }));
    // Point the reviewer at the riskiest files so it doesn't read the whole repo.
    const hitsByFile = new Map<string, number>();
    for (const c of g.health?.checks ?? []) for (const h of c.hits) if (h.path) hitsByFile.set(h.path, (hitsByFile.get(h.path) ?? 0) + 1);
    const fanIn = new Map<string, number>();
    for (const e of g.edges) if (e.kind === "imports") fanIn.set(e.target, (fanIn.get(e.target) ?? 0) + 1);
    const focus = files
      .filter((f) => !/(^|\/)(tests?|__tests__)\/|\.(test|spec)\./.test(f.path))
      .map((f) => ({ path: f.path, score: (hitsByFile.get(f.path) ?? 0) * 2 + (f.complexity === "complex" ? 3 : f.complexity === "moderate" ? 1 : 0) + (fanIn.get(`file:${f.path}`) ?? 0) * 0.5 + Math.min(f.loc, 2000) / 400 }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 30)
      .map((f) => f.path);
    const health = g.health && { ...g.health, checks: g.health.checks.map((c) => ({ ...c, hits: c.hits.slice(0, 10) })) };
    await writeJsonAtomic(ctxPath, { project: g.project, focus, health, files }, true);
    await fs.rm(outPath, { force: true });
    const mtime = () => {
      try {
        return statSync(reportPath).mtimeMs;
      } catch {
        return 0;
      }
    };
    const reportBefore = mtime();
    const instructions = agentInstructions("code-reviewer");
    if (!existsSync(instructions)) throw new Error(`missing ${instructions}`);
    const prompt = [
      `Follow the agent instructions in ${instructions} (read that file first).`,
      `Project root: ${root}`,
      `Health report: ${ctxPath}`,
      `Report path: ${reportPath}`,
      `Findings path: ${outPath}`,
      "Start with the files listed under `focus` in the health report (the riskiest ~30). Read other files only to confirm or trace a finding, and keep it to roughly 40 file reads in total.",
      "Read-only: write those two files and nothing else.",
      "If a write is refused, put the full report in your final message inside a ```markdown fence and the findings inside a ```json fence instead.",
    ].join("\n");
    const tools = ["Read", "Grep", "Glob", `Edit(./${REVIEW_REPORT})`, "Edit(./.lens/intermediate/review.json)"];
    const { code, stderr, resultError, resultText } = await this.runClaude(job, prompt, tools, MODEL_ARGS);
    if (job.state !== "running") return false;

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
    if (!raw) throw new Error(resultError ?? (code ? `Claude Code exited with code ${code}: ${stderr.trim().split("\n").pop() ?? ""}` : "the reviewer did not write its findings"));
    const parsed = ReviewFindingsSchema.safeParse(raw);
    if (!parsed.success) throw new Error(`review findings failed validation:\n${formatZodError(parsed.error)}`);
    const record: ReviewRecord = { generatedAt: new Date().toISOString(), costUsd: job.costUsd, summary: parsed.data.summary, report: REVIEW_REPORT, findings: parsed.data.findings };
    await writeJsonAtomic(reviewPath(root), record, true);
    await fs.rm(outPath, { force: true });
    job.review = { findings: record.findings.length, report: REVIEW_REPORT };
    this.push(job, "Rescanning");
    await scanAndSave(root);
    return true;
  }

  /** Draft fixes as exact text replacements. Writes only its proposal file; the user approves edits. */
  private async runRemediate(job: EnrichJob, source: RemediationSource, checkId?: string, note?: string) {
    if (!checkId && source !== "review") return this.runFixAll(job, source);
    const { root } = job;
    // One item the owner picked: no size limit, and their note rides along as data.
    const single = !!checkId && (/^review-\d+$/.test(checkId) || checkId.includes("~"));
    const items = (await remediationItems(root, source, checkId)).map((i) => (single && note ? { ...i, ownerNote: note.slice(0, 600) } : i));
    if (!items.length) throw new Error(source === "audit" ? "nothing in the checklist is failing" : source === "health" ? "that check has nothing to fix" : "the review has no high or medium findings");
    const dir = paths(root).intermediate;
    await fs.mkdir(dir, { recursive: true });
    const itemsPath = path.join(dir, "remediation-items.json");
    const outPath = path.join(dir, "remediation.json");
    await writeJsonAtomic(itemsPath, { items }, true);
    await fs.rm(outPath, { force: true });
    const instructions = agentInstructions("remediator");
    if (!existsSync(instructions)) throw new Error(`missing ${instructions}`);
    const prompt = [
      `Follow the agent instructions in ${instructions} (read that file first).`,
      `Project root: ${root}`,
      `Items: ${itemsPath}`,
      `Output path: ${outPath}`,
      "Do not edit project files. Write only the output file.",
      "If the write is refused, put the JSON in your final message inside a ```json fence instead.",
      ...(single
        ? [
            "The owner picked this one item to fix. If it has an ownerNote, that is the owner's decision on how to fix it. Follow it.",
          ]
        : []),
    ].join("\n");
    const { code, stderr, resultError, resultText } = await this.runClaude(job, prompt, ["Read", "Grep", "Glob", "Edit(./.lens/intermediate/remediation.json)"], MODEL_ARGS);
    if (job.state !== "running") return;
    let raw = await readJson<unknown>(outPath);
    if (!raw) {
      try {
        raw = JSON.parse(new RegExp("```json\\s*\\n([\\s\\S]*?)\\n```").exec(resultText)?.[1] ?? "null");
      } catch {
        raw = null;
      }
    }
    if (!raw) throw new Error(resultError ?? (code ? `Claude Code exited with code ${code}: ${stderr.trim().split("\n").pop() ?? ""}` : "no fixes were proposed"));
    const parsed = RemediationSchema.safeParse(raw);
    if (!parsed.success) throw new Error(`proposed fixes failed validation:\n${formatZodError(parsed.error)}`);
    this.push(job, "Checking each edit against the code");
    const record = buildRecord(root, source, parsed.data, job.costUsd, checkId, `s${Date.now().toString(36)}`);
    // Keep earlier results (and their Undo edits); this run replaces only its own items.
    const prior = await loadRemediation(root, source);
    const review = source === "review" ? await readJson<ReviewRecord>(reviewPath(root)) : null;
    const keepPrior = prior && !prior.legacyIds && (!review || prior.generatedAt >= review.generatedAt);
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
    await fs.rm(outPath, { force: true });
    // Fix means fix: apply every edit that passed validation. Each file is backed up first, so Undo restores it.
    const valid = record.fixes.filter((f) => !f.invalid).map((f) => f.id);
    let applied = 0;
    if (valid.length) {
      this.push(job, `Applying ${valid.length} fix${valid.length === 1 ? "" : "es"}`);
      applied = (await applyFixes(root, source, valid)).applied.length;
      this.push(job, "Rescanning");
      await scanAndSave(root);
    }
    job.remediation = { source, proposed: valid.length, invalid: record.fixes.filter((f) => f.invalid).length, skipped: record.skipped.length, applied };
    this.finish(job, "done");
  }

  /**
   * Fix everything fixable on the Health page: batches of FIX_ALL_BATCH until nothing is
   * left, applying and rescanning after each so fixed hits drop out of the next batch.
   * Stops on cancel, at the job's spending limit, or when a batch makes no progress.
   */
  private async runFixAll(job: EnrichJob, source: "audit" | "health") {
    const { root } = job;
    // Find problems first when that report hasn't been run yet.
    const plan = await fixAllPlan(root, source);
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
    const total = await fixableCount(root, source);
    if (!total) {
      job.remediation = { source, proposed: 0, invalid: 0, skipped: 0, applied: 0 };
      return this.finish(job, "done");
    }
    const progress = { attempted: 0, total, fixed: 0, batches: 0 } as NonNullable<EnrichJob["fixAll"]>;
    job.fixAll = progress;
    const tried = new Set<string>();
    const runTag = Date.now().toString(36);
    // Keep earlier applied fixes (for Undo and the FIXED badge) and skips that found the code already safe.
    // Review ids (review-<i>) renumber per review, so only stable ids carry over.
    const prior = await loadRemediation(root, source);
    const stable = (id: string) => !id.startsWith("review-");
    const kept = (prior?.fixes ?? []).filter((f) => f.status === "applied" && stable(f.itemId));
    const merged: Awaited<ReturnType<typeof buildRecord>> = {
      generatedAt: new Date().toISOString(),
      source,
      fixes: kept,
      skipped: (prior?.skipped ?? []).filter((x) => ALREADY_SAFE.test(x.reason) && stable(x.itemId)),
      edits: Object.fromEntries(kept.map((f) => [f.id, prior?.edits?.[f.id] ?? []])),
    };
    const dir = paths(root).intermediate;
    await fs.mkdir(dir, { recursive: true });
    const instructions = agentInstructions("remediator");
    if (!existsSync(instructions)) throw new Error(`missing ${instructions}`);

    while (job.state === "running") {
      const items = (await remediationItems(root, source, undefined, Infinity)).filter((i) => !tried.has(`${i.title}|${i.evidence[0]}`)).slice(0, FIX_ALL_BATCH);
      if (!items.length) break;
      const remaining = job.budgetUsd - (job.costUsd ?? 0);
      if (remaining < 0.3) {
        progress.stopped = "reached the spending limit";
        break;
      }
      for (const i of items) tried.add(`${i.title}|${i.evidence[0]}`);
      progress.batches++;
      this.push(job, `Batch ${progress.batches}: ${items.length} issues`);
      const itemsPath = path.join(dir, "remediation-items.json");
      const outPath = path.join(dir, "remediation.json");
      await writeJsonAtomic(itemsPath, { items }, true);
      await fs.rm(outPath, { force: true });
      const prompt = [
        `Follow the agent instructions in ${instructions} (read that file first).`,
        `Project root: ${root}`,
        `Items: ${itemsPath}`,
        `Output path: ${outPath}`,
        "Do not edit project files. Write only the output file.",
        "If the write is refused, put the JSON in your final message inside a ```json fence instead.",
      ].join("\n");
      job.costBase = job.costUsd ?? 0;
      const batchBudget = Math.min(remaining, estimateCost("remediate", items.length).limit);
      const saved = job.budgetUsd;
      job.budgetUsd = Math.round(batchBudget * 100) / 100; // per-run cap passed to Claude
      const { resultError, resultText } = await this.runClaude(job, prompt, ["Read", "Grep", "Glob", "Edit(./.lens/intermediate/remediation.json)"], MODEL_ARGS);
      job.budgetUsd = saved;
      if (job.state !== "running") break;
      let raw = await readJson<unknown>(outPath);
      if (!raw) {
        try {
          raw = JSON.parse(new RegExp("```json\\s*\\n([\\s\\S]*?)\\n```").exec(resultText)?.[1] ?? "null");
        } catch {
          raw = null;
        }
      }
      const parsed = raw ? RemediationSchema.safeParse(raw) : null;
      progress.attempted += items.length;
      if (!parsed?.success) {
        this.push(job, `Batch ${progress.batches} produced no usable fixes${resultError ? `: ${resultError}` : ""}`);
        if (resultError?.includes("spending") || resultError?.includes("safety limit")) break;
        continue;
      }
      const rec = buildRecord(root, source, parsed.data, undefined, undefined, `${runTag}b${progress.batches}`);
      merged.fixes.push(...rec.fixes);
      merged.skipped.push(...rec.skipped);
      Object.assign(merged.edits, rec.edits);
      merged.costUsd = job.costUsd;
      await writeJsonAtomic(remediationPath(root, source), merged, true);
      await fs.rm(outPath, { force: true });
      const valid = rec.fixes.filter((f) => !f.invalid).map((f) => f.id);
      let applied: string[] = [];
      if (valid.length) {
        applied = (await applyFixes(root, source, valid)).applied;
        // applyFixes updated statuses on disk; keep the in-memory record in step.
        for (const f of merged.fixes) if (applied.includes(f.id)) f.status = "applied";
        this.push(job, `Applied ${applied.length}; rescanning`);
        await scanAndSave(root);
      }
      progress.fixed += applied.length;
      if (!applied.length && progress.batches >= 3 && progress.fixed === 0) {
        progress.stopped = "three batches in a row produced nothing to apply";
        break;
      }
    }
    merged.costUsd = job.costUsd;
    await writeJsonAtomic(remediationPath(root, source), merged, true);
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

/** Accepted findings stay as designed; Fix hardens them instead. */
function acceptedFix(rule: string): string {
  return rule === "unauthenticated-mutation" || rule === "server-action-no-auth"
    ? "This route is public by design. Do not add login. Harden it: per-IP rate limiting, strict input validation, and for confirm/unsubscribe/share links a signed, expiring token instead of a guessable id. Skip if the project already does this."
    : "Triaged as accepted risk. Reduce it where that's possible without changing behavior; skip if it isn't.";
}

export async function fixAllPlan(root: string, source: "audit" | "health"): Promise<{ first: "audit" | "review" | null; firstLimit: number; items: number; estimate: CostEstimate }> {
  const g = await loadGraph(root);
  const files = g?.nodes.filter((n) => n.kind === "file" && n.path).length ?? 0;
  // Run the audit or review again when it's missing or older than the latest commit.
  const report = source === "audit" ? auditPath(root) : reviewPath(root);
  const at = Date.parse((await readJson<{ generatedAt?: string }>(report))?.generatedAt ?? "") || 0;
  const first = at && at >= headCommitTime(root) ? null : source === "audit" ? "audit" : "review";
  const pre = first ? estimateCost(first, files) : { low: 0, high: 0, limit: 0 };
  const items = await fixableCount(root, source);
  // Before the first run, assume about ten more items will turn up.
  const fix = estimateFixAll(Math.max(1, items + (first ? 10 : 0)));
  const r = (n: number) => Math.round(n * 100) / 100;
  return { first, firstLimit: pre.limit, items, estimate: { low: r(pre.low + fix.low), high: r(pre.high + fix.high), limit: r(Math.min(150, pre.limit + fix.limit)) } };
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
export async function fixableCount(root: string, source: "audit" | "health" = "health"): Promise<number> {
  if (source === "audit") return (await remediationItems(root, "audit", undefined, Infinity)).length;
  const g = await loadGraph(root);
  const checks = (g?.health?.checks ?? []).filter((c) => FIXABLE_CHECKS.has(c.id)).reduce((a, c) => a + c.count, 0);
  const review = (await remediationItems(root, "health", undefined, Infinity)).filter((i) => i.id.startsWith("review-")).length;
  return checks + review;
}

/** Failing checklist items (scanner + AI audit merged) or the review's high/medium findings. */
/** Automatic checks a code change can fix. Refactors, deletions, and new tests aren't offered. */
export const FIXABLE_CHECKS = new Set(["swallowed-errors", "debug-leftovers", "stubs", "mock-data", "type-escapes", "duplicates", "dead-functions", "unused-deps", "dead-files", "stale-docs"]);
/** Hits handed to one run, so a check with hundreds of hits doesn't become one huge bill. */
export const HEALTH_BATCH = 15;
/** "Fix Issues" on the Health page: one run over the highest-priority items. */
export const FIX_ALL_LIMIT = 20;
/** Items per Fix All run. Small, since fixes have no size limit. */
const FIX_ALL_BATCH = 5;
const SEV_RANK = { high: 0, medium: 1, low: 2 } as const;

export async function remediationItems(root: string, source: RemediationSource, checkId?: string, limit = FIX_ALL_LIMIT): Promise<Array<{ id: string; title: string; evidence: string[]; fix?: string }>> {
  if (source === "review") {
    const rec = await readJson<ReviewRecord>(reviewPath(root));
    // ids keep the finding's position in the review so the dashboard can mark it fixed.
    // checkId "review-<n>" narrows the run to one finding (any severity).
    const only = checkId ? Number(/^review-(\d+)$/.exec(checkId)?.[1] ?? -1) : null;
    const skip = new Set(await loadWontFix(root));
    return (rec?.findings ?? [])
      .map((f, i) => ({ f, i }))
      .filter(({ f, i }) => (only === null ? f.severity !== "low" && !skip.has(reviewKey(f)) : i === only))
      .map(({ f, i }) => ({ id: `review-${i}`, title: f.title, evidence: [`${f.path}${f.line ? `:${f.line}` : ""} ${f.detail}`], fix: f.fix }));
  }
  if (source === "health" && !checkId) {
    // Review findings not fixed yet, then the worst fixable automatic-check hits, up to FIX_ALL_LIMIT.
    const applied = new Set<string>();
    for (const s of ["review", "health"] as const) {
      const r = await loadRemediation(root, s);
      for (const f of r?.fixes ?? []) if (f.status === "applied") applied.add(f.itemId);
      for (const x of r?.skipped ?? []) if (ALREADY_SAFE.test(x.reason)) applied.add(x.itemId);
    }
    const wontFix = new Set(await loadWontFix(root));
    const out: Array<{ id: string; title: string; evidence: string[]; fix?: string }> = [];
    const rec = await readJson<ReviewRecord>(reviewPath(root));
    (rec?.findings ?? [])
      .map((f, i) => ({ f, i }))
      .filter(({ f, i }) => !applied.has(`review-${i}`) && !wontFix.has(reviewKey(f)))
      .sort((a, b) => SEV_RANK[a.f.severity] - SEV_RANK[b.f.severity])
      .forEach(({ f, i }) => out.push({ id: `review-${i}`, title: f.title, evidence: [`${f.path}${f.line ? `:${f.line}` : ""} ${f.detail}`], fix: f.fix }));
    const g = await loadGraph(root);
    const checks = (g?.health?.checks ?? []).filter((c) => FIXABLE_CHECKS.has(c.id) && c.count > 0).sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity] || b.count - a.count);
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
    const g = await loadGraph(root);
    const check = g?.health?.checks.find((c) => c.id === checkId);
    if (!check || !FIXABLE_CHECKS.has(check.id)) return [];
    const ids = checkHitIds(check);
    return check.hits.slice(0, HEALTH_BATCH).map((h, i) => ({ id: ids[i]!, title: check.title, evidence: [`${h.path}${h.line ? `:${h.line}` : ""} ${h.detail}`], fix: check.fix }));
  }
  const g = await loadGraph(root);
  const audit = await auditWithDecisions(root);
  const ai = new Map((audit?.items ?? []).map((i) => [i.id, i]));
  const rem = await loadRemediation(root, "audit");
  const applied = new Set([...(rem?.fixes ?? []).filter((f) => f.status === "applied").map((f) => f.itemId), ...(rem?.skipped ?? []).filter((x) => ALREADY_SAFE.test(x.reason)).map((x) => x.itemId)]);
  const FINDING_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2 };
  const findings = (g?.security?.findings ?? [])
    .filter((f) => f.status !== "false_positive" && f.severity in FINDING_RANK)
    .sort((a, b) => FINDING_RANK[a.severity]! - FINDING_RANK[b.severity]!)
    .map((f) => ({ id: findingItemId(f), title: f.title, evidence: [`${f.path}:${f.line} ${f.message}`], fix: f.status === "accepted" ? acceptedFix(f.rule) : undefined }));
  const checks = (g?.security?.checklist ?? [])
    .filter((c) => c.status !== "manual" && c.source !== "manual")
    .map((c) => {
      const v = ai.get(c.id);
      return v ? { ...c, status: v.status, evidence: v.evidence.length ? v.evidence : c.evidence, fix: v.fix ?? c.fix } : c;
    })
    .filter((c) => c.status === "fail")
    .map((c) => ({ id: c.id, title: c.title, evidence: c.evidence, fix: c.fix }));
  return [...checks, ...findings].filter((i) => !applied.has(i.id)).slice(0, limit);
}
