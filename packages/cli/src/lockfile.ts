/**
 * Agents may not edit lockfiles, so when a fix changes a package.json Lens
 * regenerates the matching lockfile itself. Otherwise `npm ci` / frozen installs
 * fail on the pushed branch.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const LOCK_TIMEOUT_MS = 180_000;

interface Locker {
  file: string;
  command: string;
  args: string[];
}

const LOCKERS: Locker[] = [
  { file: "package-lock.json", command: "npm", args: ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"] },
  { file: "pnpm-lock.yaml", command: "pnpm", args: ["install", "--lockfile-only", "--ignore-scripts"] },
];

export interface LockTarget {
  /** Lockfile path relative to the project root. */
  lockRel: string;
  locker: Locker;
}

const isManifest = (rel: string) => path.posix.basename(rel) === "package.json";

/** The lockfile that covers a manifest: the nearest one at or above its folder, inside root. */
export function lockfileFor(root: string, manifestRel: string): LockTarget | null {
  if (!isManifest(manifestRel)) return null;
  let dir = path.posix.dirname(manifestRel);
  for (;;) {
    for (const locker of LOCKERS) {
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
  try {
    execFileSync(target.locker.command, target.locker.args, {
      cwd,
      stdio: "pipe",
      timeout: LOCK_TIMEOUT_MS,
      env: { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: "0", CI: "true" },
    });
  } catch (e) {
    const err = e as { stderr?: Buffer; message: string };
    const detail = err.stderr?.toString().trim().split("\n").slice(-3).join(" ") || err.message;
    throw new Error(`couldn't update ${target.lockRel}: ${detail}`.slice(0, 600));
  }
}
