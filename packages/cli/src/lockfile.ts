/**
 * Agents may not edit lockfiles, so when a fix changes a manifest Lens
 * regenerates the matching lockfile itself. Otherwise `npm ci` / frozen installs
 * fail on the pushed branch.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const LOCK_TIMEOUT_MS = 180_000;
const NPM_MANIFEST = "package.json";
const PY_MANIFEST = "pyproject.toml";
/** Yarn Berry lockfiles start with this key; Classic ones don't have it. */
const YARN_BERRY_MARKER = /^__metadata:/m;

/** One way to run a lock tool. `withTemp` gets a scratch folder outside the project, removed afterwards. */
type LockCommand = { args: string[]; withTemp?: (tmp: string) => string[] };

interface Locker {
  file: string;
  /** Manifest basename this lockfile covers. */
  manifest: string;
  command: string;
  /** Commands to try in order; the first that succeeds wins (tool versions differ in flags). */
  attempts: (lockAbs: string) => LockCommand[];
}

const LOCKERS: Locker[] = [
  {
    file: "package-lock.json", manifest: NPM_MANIFEST, command: "npm",
    attempts: () => [{ args: ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"] }],
  },
  {
    file: "pnpm-lock.yaml", manifest: NPM_MANIFEST, command: "pnpm",
    attempts: () => [{ args: ["install", "--lockfile-only", "--ignore-scripts"] }],
  },
  {
    file: "yarn.lock", manifest: NPM_MANIFEST, command: "yarn",
    attempts: (lockAbs) => YARN_BERRY_MARKER.test(readFileSync(lockAbs, "utf8"))
      ? [{ args: ["install", "--mode=update-lockfile"] }]
      // Classic has no lockfile-only mode; install into a throwaway folder so the project's node_modules is untouched.
      : [{ args: ["install", "--ignore-scripts", "--non-interactive", "--no-progress"], withTemp: (tmp) => ["--modules-folder", tmp] }],
  },
  {
    file: "bun.lock", manifest: NPM_MANIFEST, command: "bun",
    attempts: () => [{ args: ["install", "--lockfile-only", "--ignore-scripts"] }],
  },
  {
    file: "bun.lockb", manifest: NPM_MANIFEST, command: "bun",
    attempts: () => [{ args: ["install", "--lockfile-only", "--ignore-scripts"] }],
  },
  {
    file: "uv.lock", manifest: PY_MANIFEST, command: "uv",
    attempts: () => [{ args: ["lock"] }],
  },
  {
    // Poetry 1 needs --no-update to keep other pins; Poetry 2 removed the flag and keeps them by default.
    file: "poetry.lock", manifest: PY_MANIFEST, command: "poetry",
    attempts: () => [{ args: ["lock", "--no-update"] }, { args: ["lock"] }],
  },
  {
    file: "pdm.lock", manifest: PY_MANIFEST, command: "pdm",
    attempts: () => [{ args: ["lock", "--update-reuse"] }],
  },
];

export interface LockTarget {
  /** Lockfile path relative to the project root. */
  lockRel: string;
  locker: Locker;
}

/** The lockfile that covers a manifest: the nearest one at or above its folder, inside root. */
export function lockfileFor(root: string, manifestRel: string): LockTarget | null {
  const lockers = LOCKERS.filter((l) => l.manifest === path.posix.basename(manifestRel));
  if (!lockers.length) return null;
  let dir = path.posix.dirname(manifestRel);
  for (;;) {
    for (const locker of lockers) {
      const lockRel = dir === "." ? locker.file : `${dir}/${locker.file}`;
      if (existsSync(path.join(root, lockRel))) return { lockRel, locker };
    }
    if (dir === ".") return null;
    dir = path.posix.dirname(dir);
  }
}

/** Distinct lockfiles affected by a set of changed paths. */
export function lockTargets(root: string, changedRels: Iterable<string>): LockTarget[] {
  const byLock = new Map<string, LockTarget>();
  for (const rel of changedRels) {
    const target = lockfileFor(root, rel);
    if (target) byLock.set(target.lockRel, target);
  }
  return [...byLock.values()];
}

/** Rewrite one lockfile to match its manifests. Throws with the tool's output on failure. */
export function regenerateLockfile(root: string, target: LockTarget): void {
  const cwd = path.join(root, path.posix.dirname(target.lockRel));
  const attempts = target.locker.attempts(path.join(root, target.lockRel));
  let lastError = "";
  for (const attempt of attempts) {
    const tmp = attempt.withTemp ? mkdtempSync(path.join(os.tmpdir(), "lens-lock-")) : undefined;
    try {
      execFileSync(target.locker.command, [...attempt.args, ...(tmp && attempt.withTemp ? attempt.withTemp(tmp) : [])], {
        cwd,
        stdio: "pipe",
        timeout: LOCK_TIMEOUT_MS,
        env: { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: "0", CI: "true" },
      });
      return;
    } catch (e) {
      const err = e as { stderr?: Buffer; message: string };
      lastError = err.stderr?.toString().trim().split("\n").slice(-3).join(" ") || err.message;
    } finally {
      if (tmp) rmSync(tmp, { recursive: true, force: true });
    }
  }
  throw new Error(`couldn't update ${target.lockRel}: ${lastError}`.slice(0, 600));
}
