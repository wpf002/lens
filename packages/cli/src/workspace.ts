/**
 * Fix runs edit a throwaway copy of the project. Lens then diffs the copy against the
 * project and turns each changed file into a whole-file edit, so refactors of any size
 * go through the same validate → back up → apply → Undo path as small fixes.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Remediation, WorkspaceReport } from "@lens/core";
import { safeTarget } from "./remediate.js";

const SKIP_DIRS = new Set([".git", "node_modules", ".lens", "dist", "build", "out", ".next", ".nuxt", ".svelte-kit", ".turbo", ".cache", "coverage", ".venv", "venv", "__pycache__", "target", ".gradle", ".idea"]);
const ENV = /^\.env(\..*)?$/;
const MAX_FILE = 2_000_000;

function skipName(name: string, dir: boolean): boolean {
  return dir ? SKIP_DIRS.has(name) : ENV.test(name);
}

/** Every regular file Lens will copy and compare, relative to `root`, with its size under the cap. */
async function listFiles(root: string): Promise<Set<string>> {
  const out = new Set<string>();
  async function walk(rel: string) {
    const entries = await fs.readdir(path.join(root, rel), { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (skipName(e.name, e.isDirectory())) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(r);
      else if (e.isFile() && (await fs.stat(path.join(root, r))).size <= MAX_FILE) out.add(r);
    }
  }
  await walk("");
  return out;
}

export async function makeWorkspace(root: string): Promise<string> {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "lens-fix-"));
  for (const rel of await listFiles(root)) {
    const dst = path.join(ws, rel);
    await fs.mkdir(path.dirname(dst), { recursive: true });
    await fs.copyFile(path.join(root, rel), dst);
  }
  return ws;
}

export const isBinary = (b: Buffer) => b.subarray(0, 8000).includes(0);

/**
 * Turn the agent's edits in `ws` into a Remediation. Each changed file goes to the first
 * fix that lists it (else the first fix). A fix whose files all went to an earlier fix
 * keeps no edits and is applied with it. A fix that changed nothing becomes a skip.
 * A file the agent emptied is deleted.
 */
/** Skip reason for a fix Claude reported without editing anything; Lens retries these once. */
export const NO_CHANGE_REASON = "Claude reported a fix but changed no files.";

export async function collectChanges(root: string, ws: string, report: WorkspaceReport): Promise<{ data: Remediation; ignored: string[] }> {
  const [before, after] = await Promise.all([listFiles(root), listFiles(ws)]);
  const changed: Array<{ rel: string; old: string | null; now: string | null }> = [];
  const ignored: string[] = [];
  for (const rel of new Set([...before, ...after])) {
    const a = before.has(rel) ? await fs.readFile(path.join(root, rel)) : null;
    const b = after.has(rel) ? await fs.readFile(path.join(ws, rel)) : null;
    if ((a && b && a.equals(b)) || (!a && b?.length === 0)) continue;
    if ((a && isBinary(a)) || (b && isBinary(b)) || (a && a.length === 0 && b)) {
      ignored.push(rel);
      continue;
    }
    try {
      safeTarget(root, rel);
    } catch {
      ignored.push(rel);
      continue;
    }
    // The agent has no shell, so an emptied file means delete it.
    changed.push({ rel, old: a?.toString("utf8") ?? null, now: b && b.length > 0 ? b.toString("utf8") : null });
  }
  const norm = (p: string) => path.normalize(p).replace(/\\/g, "/").replace(/^\.\//, "");
  const owner = new Map<string, number>();
  for (const c of changed) {
    const i = report.fixes.findIndex((f) => f.files.some((p) => norm(p) === c.rel));
    owner.set(c.rel, i >= 0 ? i : 0);
  }
  const touched = new Set(changed.map((c) => c.rel));
  const fixes: Remediation["fixes"] = [];
  const skipped = [...report.skipped];
  report.fixes.forEach((f, i) => {
    const edits = changed
      .filter((c) => owner.get(c.rel) === i)
      .map((c) => (c.now === null ? { path: c.rel, find: "", replace: "", delete: true } : { path: c.rel, find: c.old ?? "", replace: c.now }));
    if (!edits.length && !f.files.some((p) => touched.has(norm(p)))) skipped.push({ itemId: f.itemId, reason: NO_CHANGE_REASON });
    else fixes.push({ itemId: f.itemId, title: f.title, explanation: f.explanation, edits });
  });
  return { data: { summary: report.summary, fixes, skipped }, ignored };
}
