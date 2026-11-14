/**
 * Runs the project's own tests before Lens pushes, so a fix that breaks a test never reaches
 * GitHub. Only the changed packages are tested, and the run without Lens's edits happens only
 * when something fails, which keeps the usual clean push to one short test run.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { paths, readJson, writeJsonAtomic } from "@lens/core";
import { errorExcerpt, failedTests } from "./ci.js";

const TEST_TIMEOUT_MS = 10 * 60_000;
const INSTALL_TIMEOUT_MS = 10 * 60_000;
const GIT_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const LOCKFILES = { "pnpm-lock.yaml": "pnpm", "yarn.lock": "yarn", "package-lock.json": "npm" } as const;
type PackageManager = (typeof LOCKFILES)[keyof typeof LOCKFILES];

export interface TestPlan {
  manager: PackageManager;
  lockfile: string | null;
  /** argv for the test run, with the package manager first. */
  run: string[];
}

export type LocalTestResult =
  | { state: "passed" }
  | { state: "skipped"; reason: string }
  | { state: "broken"; tests: string[]; excerpt: string };

/** Thrown by a push whose edits break tests that pass without them. */
export class TestsBroken extends Error {
  constructor(readonly result: Extract<LocalTestResult, { state: "broken" }>) {
    super(result.tests.length ? `Lens's changes break ${result.tests.length} test${result.tests.length === 1 ? "" : "s"}: ${result.tests.slice(0, 5).join(", ")}` : "Lens's changes break the tests.");
  }
}

interface RunOutcome {
  ok: boolean;
  log: string;
  timedOut: boolean;
}

/**
 * Tests run the repo's own code, so they get no server secrets: only what a package manager needs.
 */
function testEnv(): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, HOME: process.env.HOME ?? os.homedir(), CI: "true", NODE_ENV: "test", COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" };
}

function run(cwd: string, argv: string[], timeout: number): Promise<RunOutcome> {
  return new Promise((resolve) => {
    execFile(argv[0]!, argv.slice(1), { cwd, timeout, env: testEnv(), maxBuffer: MAX_OUTPUT_BYTES }, (error, stdout, stderr) => {
      const timedOut = !!error && (error as NodeJS.ErrnoException & { killed?: boolean }).killed === true;
      resolve({ ok: !error, log: `${stdout}\n${stderr}`, timedOut });
    });
  });
}

async function git(cwd: string, args: string[]): Promise<string> {
  const outcome = await run(cwd, ["git", ...args], GIT_TIMEOUT_MS);
  if (!outcome.ok) throw new Error(`git ${args[0]} failed: ${outcome.log.trim().slice(0, 300)}`);
  return outcome.log.trim();
}

/** The folder of the nearest package.json above `file`, relative to root; "." for the root package. */
function packageDirOf(root: string, file: string): string {
  for (let dir = path.posix.dirname(file); dir !== "."; dir = path.posix.dirname(dir)) if (existsSync(path.join(root, dir, "package.json"))) return dir;
  return ".";
}

/** How to test what `changed` touches, or null when the project has no test script Lens can run. */
export async function testPlan(root: string, changed: string[]): Promise<TestPlan | null> {
  const manifest = await readJson<{ scripts?: Record<string, string> }>(path.join(root, "package.json"));
  if (!manifest) return null;
  const found = Object.entries(LOCKFILES).find(([file]) => existsSync(path.join(root, file)));
  const manager: PackageManager = found?.[1] ?? "npm";
  const lockfile = found?.[0] ?? null;
  if (manager === "pnpm" && existsSync(path.join(root, "pnpm-workspace.yaml"))) {
    const dirs = [...new Set(changed.map((file) => packageDirOf(root, file)))];
    // A root file can affect every package; otherwise only changed packages and the ones depending on them.
    const filters = dirs.includes(".") ? [] : dirs.flatMap((dir) => ["--filter", `...{./${dir}}`]);
    return { manager, lockfile, run: ["pnpm", ...filters, "-r", "--no-bail", "run", "--if-present", "test"] };
  }
  if (!manifest.scripts?.test) return null;
  return { manager, lockfile, run: manager === "npm" ? ["npm", "test"] : [manager, "test"] };
}

const INSTALL: Record<PackageManager, string[]> = {
  pnpm: ["pnpm", "install", "--frozen-lockfile", "--prefer-offline"],
  yarn: ["yarn", "install", "--frozen-lockfile"],
  npm: ["npm", "ci", "--no-audit", "--no-fund"],
};

/** Install dependencies only when the lockfile changed since the last install, since installing is most of a run's time. */
async function ensureInstalled(root: string, plan: TestPlan): Promise<string | null> {
  // Without a lockfile there's nothing to install reproducibly; the tests run on what's there.
  if (!plan.lockfile) return null;
  const stampPath = path.join(paths(root).dir, "deps-installed.json");
  const lock = await fs.readFile(path.join(root, plan.lockfile));
  const hash = createHash("sha256").update(lock).digest("hex");
  const stamp = await readJson<{ hash: string }>(stampPath);
  if (stamp?.hash === hash && existsSync(path.join(root, "node_modules"))) return null;
  const outcome = await run(root, INSTALL[plan.manager], INSTALL_TIMEOUT_MS);
  if (!outcome.ok) return `installing dependencies failed: ${errorExcerpt(outcome.log).slice(0, 300)}`;
  await writeJsonAtomic(stampPath, { hash }, true);
  return null;
}

/** A clean copy of HEAD that reuses the project's installed node_modules, so testing it needs no install. */
async function headCopy(root: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lens-base-tests-"));
  await git(root, ["worktree", "add", "-q", "--detach", dir, "HEAD"]);
  const manifests = (await git(root, ["ls-files", "package.json", "**/package.json"])).split("\n").filter(Boolean);
  for (const manifest of manifests) {
    const modules = path.join(root, path.dirname(manifest), "node_modules");
    if (existsSync(modules)) await fs.symlink(modules, path.join(dir, path.dirname(manifest), "node_modules"), "dir");
  }
  return dir;
}

async function removeHeadCopy(root: string, dir: string): Promise<void> {
  await git(root, ["worktree", "remove", "--force", dir]).catch((e: unknown) => console.error(`[tests] couldn't remove ${dir}: ${e instanceof Error ? e.message : e}`));
  await fs.rm(dir, { recursive: true, force: true });
}

/** Tests failing with Lens's edits that pass without them. Exported for tests. */
export function newFailures(withEdits: RunOutcome, withoutEdits: RunOutcome): LocalTestResult {
  if (withoutEdits.timedOut) return { state: "skipped", reason: "the tests time out without Lens's changes too" };
  const before = new Set(failedTests(withoutEdits.log));
  const broken = failedTests(withEdits.log).filter((t) => !before.has(t));
  if (broken.length) return { state: "broken", tests: broken, excerpt: errorExcerpt(withEdits.log) };
  // A failure with no test names (a build or type error) counts only when the base run was clean.
  if (withoutEdits.ok) return { state: "broken", tests: [], excerpt: errorExcerpt(withEdits.log) };
  return { state: "passed" };
}

/** Paths the working tree changes against HEAD, Lens's own output left out. */
async function uncommitted(root: string): Promise<string[]> {
  const status = await git(root, ["status", "--porcelain", "--untracked-files=all", "--", ".", ":(exclude).lens"]);
  return status.split("\n").filter(Boolean).map((line) => line.slice(3).split(" -> ").at(-1)!);
}

/** Run the tests of what Lens's uncommitted edits touch, and report what those edits break. */
export async function checkLocalTests(root: string): Promise<LocalTestResult> {
  const changed = await uncommitted(root);
  if (!changed.length) return { state: "passed" };
  const plan = await testPlan(root, changed);
  if (!plan) return { state: "skipped", reason: "no test script" };
  const installProblem = await ensureInstalled(root, plan);
  if (installProblem) return { state: "skipped", reason: installProblem };
  const withEdits = await run(root, plan.run, TEST_TIMEOUT_MS);
  if (withEdits.ok) return { state: "passed" };
  if (withEdits.timedOut) return { state: "broken", tests: [], excerpt: `The tests ran past ${TEST_TIMEOUT_MS / 60_000} minutes.` };
  const base = await headCopy(root);
  try {
    return newFailures(withEdits, await run(base, plan.run, TEST_TIMEOUT_MS));
  } finally {
    await removeHeadCopy(root, base);
  }
}
