/**
 * Test gate for Lens pull requests. The project's own GitHub CI runs the tests (running a
 * reviewed repo's scripts on the Lens server would expose server secrets to that code).
 * Lens compares failing tests on the PR against the base commit, so only failures its
 * changes introduced count as broken.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { paths, readJson, writeJsonAtomic } from "@lens/core";
import { githubApi, githubText } from "./github.js";

export type TestState = "running" | "passed" | "broken" | "none";
export interface BrokenCheck {
  name: string;
  /** Tests failing on the PR that pass on the base commit. Empty when the whole check is new breakage. */
  tests: string[];
  excerpt: string;
}
export interface TestGate {
  pr: number;
  sha: string;
  state: TestState;
  broken: BrokenCheck[];
  /** Checks that also fail on the base commit, so Lens didn't cause them. */
  preexisting: number;
  /** Automatic repair runs for this pull request. */
  attempts: number;
  /** Set by the server while a repair run is going. */
  repairing?: boolean;
  /** When Lens asked GitHub to re-run stale base-commit checks for this head commit. */
  baseRerunAt?: number;
}
export interface RunResult {
  name: string;
  failed: boolean;
  tests: string[];
  excerpt: string;
}
export interface RepairItem {
  id: string;
  title: string;
  evidence: string[];
  fix: string;
}

export const MAX_TEST_REPAIRS = 2;
/** After a push, how long missing check runs mean "CI hasn't started yet" rather than "no CI". */
const CI_START_GRACE_MS = 10 * 60_000;
const MAX_TESTS_LISTED = 50;
const EXCERPT_CHARS = 3_000;
/** A base-commit pass older than this may hide drift (a new package release, an expired cert), so it's re-run before Lens is blamed. */
const BASE_STALE_MS = 6 * 60 * 60_000;
/** How long to wait for those re-runs before comparing anyway. */
const BASE_RERUN_WAIT_MS = 30 * 60_000;
const FAILED_CONCLUSIONS = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure"]);

const gatePath = (root: string) => path.join(paths(root).dir, "test-gate.json");
export const repairItemsPath = (root: string) => path.join(paths(root).dir, "test-repair.json");

const ANSI = /\x1b\[[0-9;]*m/g;
const TIMESTAMP = /^\d{4}-\d\d-\d\dT[\d:.]+Z ?/;
const cleanLines = (log: string) => log.split(/\r?\n/).map((l) => l.replace(TIMESTAMP, "").replace(ANSI, ""));

const TEST_PATTERNS: RegExp[] = [
  /^(?:FAILED|ERROR) (\S+?)(?: - .*)?$/, // pytest summary
  /^\s*FAIL\s+(\S+\.(?:[cm]?[jt]sx?|vue|svelte))\b/, // jest / vitest file
  /^\s*[×✕✗]\s+(.+?)(?:\s+\d+(?:\.\d+)?\s*m?s)?$/, // vitest / jest test
  /^\s*--- FAIL: (\S+)/, // go
  /^test (\S+) \.\.\. FAILED$/, // cargo
];

/** Failing test names in a CI log, from the common runners' summary lines. */
export function failedTests(log: string): string[] {
  const out = new Set<string>();
  for (const line of cleanLines(log)) {
    for (const re of TEST_PATTERNS) {
      const m = re.exec(line);
      if (m?.[1]) {
        out.add(m[1].trim());
        break;
      }
    }
    if (out.size >= MAX_TESTS_LISTED) break;
  }
  return [...out];
}

const ERROR_LINE = /error|fail|assert|exception|traceback|[×✕✗]/i;

/** The error lines of a log with a little context, ending at the last error. */
export function errorExcerpt(log: string): string {
  const lines = cleanLines(log);
  const keep = new Set<number>();
  lines.forEach((l, i) => {
    if (!ERROR_LINE.test(l)) return;
    for (let k = Math.max(0, i - 2); k <= Math.min(lines.length - 1, i + 2); k++) keep.add(k);
  });
  const text = [...keep].sort((a, b) => a - b).map((i) => lines[i]).join("\n");
  return text.length > EXCERPT_CHARS ? text.slice(-EXCERPT_CHARS) : text;
}

/** Failures on the PR that aren't failing on the base commit too. */
export function compareRuns(head: RunResult[], base: RunResult[]): { broken: BrokenCheck[]; preexisting: number } {
  const broken: BrokenCheck[] = [];
  let preexisting = 0;
  for (const run of head.filter((r) => r.failed)) {
    const before = base.find((b) => b.name === run.name);
    if (!before?.failed) {
      broken.push({ name: run.name, tests: run.tests, excerpt: run.excerpt });
      continue;
    }
    const known = new Set(before.tests);
    const fresh = run.tests.filter((t) => !known.has(t));
    if (fresh.length) broken.push({ name: run.name, tests: fresh, excerpt: run.excerpt });
    else preexisting++;
  }
  return { broken, preexisting };
}

type CheckRun = { id: number; name: string; status: string; conclusion: string | null; completed_at?: string | null; output?: { title?: string | null; summary?: string | null; text?: string | null } };

/** Base-commit runs that passed long enough ago that a failure on the PR may be drift, not Lens. */
export function staleBaseRuns<T extends { name: string; completed_at?: string | null }>(broken: BrokenCheck[], baseRuns: T[], now: number): T[] {
  return baseRuns.filter((r) => broken.some((b) => b.name === r.name) && !!r.completed_at && now - Date.parse(r.completed_at) > BASE_STALE_MS);
}

async function checkRuns(repo: string, sha: string): Promise<CheckRun[]> {
  const res = (await githubApi(`/repos/${repo}/commits/${sha}/check-runs?per_page=100`)) as { check_runs: CheckRun[] };
  return res.check_runs;
}

/** An Actions check run's id is its job id, so its log comes from the jobs endpoint. */
async function runResult(repo: string, run: CheckRun): Promise<RunResult> {
  const failed = !!run.conclusion && FAILED_CONCLUSIONS.has(run.conclusion);
  if (!failed) return { name: run.name, failed, tests: [], excerpt: "" };
  const log = (await githubText(`/repos/${repo}/actions/jobs/${run.id}/logs`).catch(() => null)) ?? [run.output?.title, run.output?.summary, run.output?.text].filter(Boolean).join("\n");
  return { name: run.name, failed, tests: failedTests(log), excerpt: errorExcerpt(log) };
}

export interface GateInput {
  repo: string;
  pr: number;
  headSha: string;
  baseSha: string;
  /** When the head commit was pushed, for telling "not started" from "no CI". */
  pushedAt?: number;
}

/** Test results for the PR's head commit. Finished results are cached per commit. */
export async function testGate(root: string, input: GateInput, now = Date.now()): Promise<TestGate> {
  const saved = await readJson<TestGate>(gatePath(root));
  const attempts = saved?.pr === input.pr ? saved.attempts : 0;
  if (saved && saved.pr === input.pr && saved.sha === input.headSha && saved.state !== "running") return saved;
  const runs = await checkRuns(input.repo, input.headSha);
  const base: TestGate = { pr: input.pr, sha: input.headSha, state: "running", broken: [], preexisting: 0, attempts };
  if (!runs.length) {
    const hasCi = existsSync(path.join(root, ".github", "workflows"));
    const fresh = input.pushedAt !== undefined && now - input.pushedAt < CI_START_GRACE_MS;
    return hasCi && fresh ? base : save(root, { ...base, state: "none" });
  }
  if (runs.some((r) => r.status !== "completed")) return base;
  const head = await Promise.all(runs.map((r) => runResult(input.repo, r)));
  const failedNames = new Set(head.filter((r) => r.failed).map((r) => r.name));
  const allBase = failedNames.size ? (await checkRuns(input.repo, input.baseSha).catch(() => [])).filter((r) => failedNames.has(r.name)) : [];
  const requested = saved?.pr === input.pr && saved.sha === input.headSha ? saved.baseRerunAt : undefined;
  // Re-runs requested for this head commit are still going.
  if (requested && now - requested < BASE_RERUN_WAIT_MS && allBase.some((r) => r.status !== "completed")) return base;
  const baseRuns = allBase.filter((r) => r.status === "completed");
  const before = await Promise.all(baseRuns.map((r) => runResult(input.repo, r)));
  const { broken, preexisting } = compareRuns(head, before);
  const stale = requested ? [] : staleBaseRuns(broken, baseRuns, now);
  if (stale.length) {
    // Check runs from Actions are jobs, so each re-runs on its own. Without permission to re-run, compare as before.
    const asked = await Promise.all(stale.map((r) => githubApi(`/repos/${input.repo}/actions/jobs/${r.id}/rerun`, "POST").then(() => true, () => false)));
    if (asked.some(Boolean)) return save(root, { ...base, baseRerunAt: now });
  }
  return save(root, { ...base, state: broken.length ? "broken" : "passed", broken, preexisting, ...(requested ? { baseRerunAt: requested } : {}) });
}

async function save(root: string, gate: TestGate): Promise<TestGate> {
  await writeJsonAtomic(gatePath(root), gate, true);
  return gate;
}

export async function recordRepairAttempt(root: string, pr: number): Promise<void> {
  const saved = await readJson<TestGate>(gatePath(root));
  if (saved?.pr === pr) await save(root, { ...saved, attempts: saved.attempts + 1 });
}

/** What the remediator gets: each broken check with its failing tests, log excerpt, and the PR's files. */
export function repairItems(gate: TestGate, changedFiles: string[]): RepairItem[] {
  const files = changedFiles.slice(0, 100).join(", ");
  return gate.broken.map((b, i) => ({
    id: `tests-${i + 1}`,
    title: `Lens's changes broke ${b.name}`.slice(0, 200),
    evidence: [
      ...(b.tests.length ? [`Failing tests that pass on the base branch: ${b.tests.join(", ")}`] : [`The ${b.name} check passes on the base branch and fails on this pull request.`]),
      `CI log:\n${b.excerpt}`,
      `Files this pull request changed: ${files}`,
    ],
    fix: "Find which change in this pull request broke these tests and fix that code so they pass. Don't delete, skip, or loosen tests unless a test checks behavior the fix intentionally and correctly changed.",
  }));
}

export async function saveRepairItems(root: string, items: RepairItem[]): Promise<void> {
  await writeJsonAtomic(repairItemsPath(root), items, true);
}

export async function loadRepairItems(root: string): Promise<RepairItem[]> {
  return (await readJson<RepairItem[]>(repairItemsPath(root))) ?? [];
}

export const brokenCount = (gate: TestGate) => gate.broken.reduce((n, b) => n + Math.max(1, b.tests.length), 0);
