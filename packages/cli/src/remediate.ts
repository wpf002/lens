/**
 * Proposed fixes: validation, diffs, apply, and undo. The remediator agent only
 * proposes text replacements; nothing here runs until the user approves a fix.
 * Every applied file is backed up first so Undo restores the exact bytes.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { paths, readJson, writeJsonAtomic, type Remediation } from "@lens/core";
import { lockTargets, regenerateLockfile } from "./lockfile.js";

export interface ProposedFix {
  id: string;
  itemId: string;
  title: string;
  explanation: string;
  files: Array<{ path: string; diff: string; created: boolean; deleted?: boolean }>;
  /** Why Lens refused to offer it (e.g. the text to replace isn't in the file anymore). */
  invalid?: string;
  status: "proposed" | "applied" | "undone" | "discarded";
}

export interface RemediationRecord {
  generatedAt: string;
  source: RemediationSource;
  /** For source "health": the automatic check the hits came from. */
  checkId?: string;
  costUsd?: number;
  summary?: string;
  fixes: ProposedFix[];
  skipped: Remediation["skipped"];
  /** Written before per-source files: review item ids counted only high/medium findings, from 1. */
  legacyIds?: boolean;
  /** Edits kept server-side for apply; the dashboard only sees diffs. */
  edits: Record<string, Remediation["fixes"][number]["edits"]>;
}

export type RemediationSource = "audit" | "review" | "health";
export const SOURCES: RemediationSource[] = ["audit", "review", "health"];

/** One proposal file per report, so a run on one can't erase Undo for another. */
export const remediationPath = (root: string, source: RemediationSource) => path.join(paths(root).dir, `remediation-${source}.json`);
const legacyPath = (root: string) => path.join(paths(root).dir, "remediation.json");
function backupDir(root: string, source: RemediationSource, id: string): string {
  const dir = path.join(paths(root).dir, "remediation-backup", source, id);
  const legacy = path.join(paths(root).dir, "remediation-backup", id);
  return !existsSync(dir) && existsSync(path.join(legacy, "manifest.json")) ? legacy : dir;
}

const FORBIDDEN = /(^|\/)(\.git|node_modules|\.lens)(\/|$)|(^|\/)\.env(\.|$)|(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|poetry\.lock|uv\.lock|pdm\.lock|Cargo\.lock|go\.sum)$/;

/** Resolve a repo-relative path, refusing anything outside the project or on the forbidden list. */
export function safeTarget(root: string, rel: string): string {
  if (!rel || path.isAbsolute(rel) || rel.includes("\0")) throw new Error(`bad path: ${rel}`);
  const norm = path.normalize(rel).replace(/\\/g, "/");
  if (norm.startsWith("..") || FORBIDDEN.test(norm)) throw new Error(`not allowed to edit ${rel}`);
  const abs = path.join(root, norm);
  // Resolve symlinks on the deepest part of the path that exists, so a link can't point outside.
  let probe = abs;
  while (!existsSync(probe)) probe = path.dirname(probe);
  const real = path.join(realpathSync(probe), path.relative(probe, abs));
  const realRoot = realpathSync(root);
  if (!real.startsWith(realRoot + path.sep)) throw new Error(`${rel} is outside the project`);
  return abs;
}

/** Apply edits in memory. Throws when a `find` isn't present exactly once. */
/** `after: null` means the file is deleted. */
export function applyEditsInMemory(root: string, edits: Remediation["fixes"][number]["edits"]): Map<string, { before: string | null; after: string | null }> {
  const out = new Map<string, { before: string | null; after: string | null }>();
  for (const e of edits) {
    const abs = safeTarget(root, e.path);
    const cur = out.get(e.path) ?? { before: existsSync(abs) ? readFileSync(abs, "utf8") : null, after: "" as string | null };
    const text = out.has(e.path) ? cur.after : cur.before;
    if (e.delete) {
      if (text === null) throw new Error(`${e.path} doesn't exist`);
      cur.after = null;
    } else if (e.find === "") {
      if (cur.before !== null || out.has(e.path)) throw new Error(`${e.path} already exists`);
      cur.after = e.replace;
    } else {
      if (text === null) throw new Error(`${e.path} doesn't exist`);
      const n = text.split(e.find).length - 1;
      if (n !== 1) throw new Error(n === 0 ? `the text to change in ${e.path} isn't there anymore` : `the text to change appears ${n} times in ${e.path}`);
      cur.after = text.replace(e.find, () => e.replace);
    }
    out.set(e.path, cur);
  }
  return out;
}

export function unifiedDiff(rel: string, before: string | null, after: string | null): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "lens-diff-"));
  try {
    const a = path.join(dir, "a");
    const b = path.join(dir, "b");
    writeFileSync(a, before ?? "");
    writeFileSync(b, after ?? "");
    let out = "";
    try {
      out = execFileSync("git", ["diff", "--no-index", "--no-color", "-U3", a, b], { encoding: "utf8" });
    } catch (e) {
      out = String((e as { stdout?: string }).stdout ?? "");
    }
    const lines = out.split("\n");
    const start = lines.findIndex((l) => l.startsWith("@@"));
    const text = `--- a/${rel}\n+++ ${after === null ? "/dev/null (deleted)" : `b/${rel}`}\n${start >= 0 ? lines.slice(start).join("\n") : ""}`;
    return text.length > 40_000 ? text.slice(0, 40_000) + "\n… (diff truncated)" : text;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Turn the agent's proposal into a record the dashboard can show. */
export function buildRecord(root: string, source: RemediationSource, data: Remediation, costUsd?: number, checkId?: string, idPrefix = "fix"): RemediationRecord {
  const edits: RemediationRecord["edits"] = {};
  const fixes: ProposedFix[] = data.fixes.map((f, i) => {
    const id = `${idPrefix}-${i + 1}`;
    edits[id] = f.edits;
    const base = { id, itemId: f.itemId, title: f.title, explanation: f.explanation, status: "proposed" as const };
    try {
      const changed = applyEditsInMemory(root, f.edits);
      return { ...base, files: [...changed].map(([p, c]) => ({ path: p, diff: unifiedDiff(p, c.before, c.after), created: c.before === null, deleted: c.after === null })) };
    } catch (e) {
      return { ...base, files: [], invalid: (e as Error).message };
    }
  });
  return { generatedAt: new Date().toISOString(), source, checkId, costUsd, summary: data.summary, fixes, skipped: data.skipped, edits };
}

/** Lens couldn't fix it, or stopped first. */
export const UNADDRESSED_REASON = "Lens couldn't fix this.";

/**
 * Give every item Lens sent to Claude an outcome. An item with no fix and no skip
 * would otherwise show as plain Open after a run that was meant to settle it.
 */
export function markUnaddressed(rec: Pick<RemediationRecord, "fixes" | "skipped">, itemIds: string[], reason = UNADDRESSED_REASON): number {
  const settled = new Set([...rec.fixes.filter((f) => f.status === "applied" || f.invalid).map((f) => f.itemId), ...rec.skipped.map((x) => x.itemId)]);
  const missing = [...new Set(itemIds)].filter((id) => !settled.has(id));
  rec.skipped.push(...missing.map((itemId) => ({ itemId, reason })));
  return missing.length;
}

export async function loadRemediation(root: string, source: RemediationSource): Promise<RemediationRecord | null> {
  const rec = await readJson<RemediationRecord>(remediationPath(root, source));
  if (rec) return rec;
  const legacy = await readJson<RemediationRecord>(legacyPath(root)); // written before per-source files
  return legacy?.source === source ? { ...legacy, legacyIds: true } : null;
}

interface BackupEntry {
  path: string;
  existed: boolean;
  /** Regenerated by Lens, not edited by the agent, so safeTarget's lockfile ban doesn't apply. */
  lockfile?: boolean;
}

function backUp(dir: string, rel: string, bytes: string | Buffer): void {
  const target = path.join(dir, rel);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, bytes);
}

function lockfileTarget(root: string, rel: string): string {
  const norm = path.posix.normalize(rel.replace(/\\/g, "/"));
  if (norm.startsWith("..") || path.posix.isAbsolute(norm)) throw new Error(`not allowed to restore ${rel}`);
  return path.join(root, norm);
}

/** Put every backed-up file back and drop the backup. */
function restoreBackup(root: string, dir: string, manifest: BackupEntry[]): void {
  for (const m of manifest) {
    const abs = m.lockfile ? lockfileTarget(root, m.path) : safeTarget(root, m.path);
    if (m.existed) writeFileSync(abs, readFileSync(path.join(dir, m.path)));
    else rmSync(abs, { force: true });
  }
  rmSync(dir, { recursive: true, force: true });
}

/** Apply approved fixes. Each fix is all-or-nothing; originals are backed up for Undo. */
export async function applyFixes(root: string, source: RemediationSource, ids: string[]): Promise<{ applied: string[]; failed: Array<{ id: string; error: string }> }> {
  const rec = await loadRemediation(root, source);
  if (!rec) throw new Error("no proposed fixes");
  const applied: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];
  for (const id of ids) {
    const fix = rec.fixes.find((f) => f.id === id);
    if (!fix || fix.status !== "proposed" || fix.invalid) {
      failed.push({ id, error: "not available to apply" });
      continue;
    }
    try {
      const changed = applyEditsInMemory(root, rec.edits[id] ?? []);
      const dir = path.join(paths(root).dir, "remediation-backup", source, id);
      mkdirSync(dir, { recursive: true });
      const locks = lockTargets(root, changed.keys());
      const lockBefore = new Map(locks.map((l) => [l.lockRel, readFileSync(path.join(root, l.lockRel))]));
      const manifest: BackupEntry[] = [];
      for (const [rel, c] of changed) {
        manifest.push({ path: rel, existed: c.before !== null });
        if (c.before !== null) backUp(dir, rel, c.before);
      }
      for (const [rel, bytes] of lockBefore) {
        manifest.push({ path: rel, existed: true, lockfile: true });
        backUp(dir, rel, bytes);
      }
      writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest));
      for (const [rel, c] of changed) {
        const abs = safeTarget(root, rel);
        mkdirSync(path.dirname(abs), { recursive: true });
        if (c.after === null) rmSync(abs, { force: true });
        else writeFileSync(abs, c.after);
      }
      try {
        for (const lock of locks) regenerateLockfile(root, lock);
      } catch (e) {
        restoreBackup(root, dir, manifest);
        throw e;
      }
      fix.status = "applied";
      applied.push(id);
    } catch (e) {
      failed.push({ id, error: (e as Error).message });
      // Recorded so the item shows why it's still open.
      fix.invalid = (e as Error).message.slice(0, 600);
    }
  }
  await writeJsonAtomic(remediationPath(root, source), rec, true);
  return { applied, failed };
}

/** Restore the exact pre-apply bytes of an applied fix. */
export async function undoFix(root: string, source: RemediationSource, id: string): Promise<void> {
  const rec = await loadRemediation(root, source);
  const fix = rec?.fixes.find((f) => f.id === id);
  if (!rec || !fix || fix.status !== "applied") throw new Error("that fix isn't applied");
  const dir = backupDir(root, source, id);
  const manifest = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8")) as BackupEntry[];
  restoreBackup(root, dir, manifest);
  fix.status = "undone";
  await writeJsonAtomic(remediationPath(root, source), rec, true);
}
