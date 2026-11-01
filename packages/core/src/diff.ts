/** Diff impact: git changes → changed nodes → transitive dependents. */
import { execFileSync } from "node:child_process";
import type { EdgeKind, ImpactReport, KnowledgeGraph } from "./types.js";
import { indexGraph, fileOf } from "./graph-utils.js";
import { isFileKind } from "./heuristics.js";
import { isTestPath } from "./languages.js";

export interface DiffOptions {
  /** Compare against this ref (merge-base with HEAD). Default: working tree vs HEAD. */
  base?: string;
  staged?: boolean;
  depth?: number;
}

function git(root: string, args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 }).toString();
}

export function isGitRepo(root: string): boolean {
  try {
    return git(root, ["rev-parse", "--is-inside-work-tree"]).trim() === "true";
  } catch {
    return false;
  }
}

/** Refs are passed as argv (no shell), but still restricted to sane characters. */
function checkRef(ref: string): string {
  if (!/^[\w./~^@{}-]{1,200}$/.test(ref) || ref.startsWith("-")) throw new Error(`Refusing suspicious git ref: ${ref}`);
  return ref;
}

export function parseUnifiedDiff(text: string): ImpactReport["changedFiles"] {
  const out: ImpactReport["changedFiles"] = [];
  let cur: ImpactReport["changedFiles"][number] | null = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      cur = { path: m?.[2] ?? "", status: "M", hunks: [] };
      out.push(cur);
    } else if (!cur) continue;
    else if (line.startsWith("new file mode")) cur.status = "A";
    else if (line.startsWith("deleted file mode")) cur.status = "D";
    else if (line.startsWith("rename from ")) cur.status = "R";
    else if (line.startsWith("+++ b/")) cur.path = line.slice(6);
    else if (line.startsWith("@@")) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m) {
        const start = Number(m[3]);
        const len = m[4] === undefined ? 1 : Number(m[4]);
        // pure deletions: mark the line where content was removed
        cur.hunks.push([start, Math.max(start, start + len - 1)]);
      }
    }
  }
  return out.filter((f) => f.path);
}

export function gitChanges(root: string, opts: DiffOptions = {}): { base: string; head: string; files: ImpactReport["changedFiles"] } {
  const head = git(root, ["rev-parse", "--short", "HEAD"]).trim();
  let args: string[];
  let base = "HEAD";
  if (opts.base) {
    const mb = git(root, ["merge-base", checkRef(opts.base), "HEAD"]).trim();
    base = `${opts.base}@${mb.slice(0, 7)}`;
    args = ["diff", "--unified=0", "--no-color", "-M", mb];
  } else if (opts.staged) {
    args = ["diff", "--unified=0", "--no-color", "-M", "--cached"];
    base = "HEAD (staged)";
  } else args = ["diff", "--unified=0", "--no-color", "-M", "HEAD"];
  const files = parseUnifiedDiff(git(root, args));
  if (!opts.base && !opts.staged) {
    // untracked files count as additions
    for (const p of git(root, ["ls-files", "--others", "--exclude-standard"]).split("\n").filter(Boolean)) {
      if (!files.some((f) => f.path === p)) files.push({ path: p, status: "A", hunks: [] });
    }
  }
  // Lens's own output is never part of the change set.
  return { base, head, files: files.filter((f) => !f.path.startsWith(".lens/")) };
}

const IMPACT_EDGES: EdgeKind[] = ["imports", "calls", "inherits", "implements", "exports", "routes", "middleware", "configures", "depends_on", "deploys", "reads_from", "writes_to", "triggers"];

export function computeImpact(g: KnowledgeGraph, changedFiles: ImpactReport["changedFiles"], meta: { base: string; head: string }, opts: DiffOptions = {}): ImpactReport {
  const depth = opts.depth ?? 3;
  const idx = indexGraph(g);
  const byPath = new Map<string, string>();
  const symbolsByPath = new Map<string, string[]>();
  for (const n of g.nodes) {
    if (!n.path) continue;
    if (isFileKind(n)) byPath.set(n.path, n.id);
    else (symbolsByPath.get(n.path) ?? symbolsByPath.set(n.path, []).get(n.path)!).push(n.id);
  }
  const changed = new Set<string>();
  const unknownFiles: string[] = [];
  for (const f of changedFiles) {
    const fid = byPath.get(f.path);
    if (!fid) {
      unknownFiles.push(f.path);
      continue;
    }
    changed.add(fid);
    const syms = symbolsByPath.get(f.path) ?? [];
    if (f.status === "A" || f.status === "D" || !f.hunks.length) continue;
    for (const sid of syms) {
      const n = idx.nodes.get(sid)!;
      if (!n.lines) continue;
      if (f.hunks.some(([a, b]) => a <= n.lines![1] && b >= n.lines![0])) changed.add(sid);
    }
  }
  // Reverse traversal: who depends on what changed.
  const impacted = new Map<string, { distance: number; via: EdgeKind }>();
  let frontier = [...changed];
  for (let d = 1; d <= depth && frontier.length; d++) {
    const next: string[] = [];
    for (const id of frontier) {
      // a changed symbol affects its file's importers too
      const ids = [id];
      const fid = fileOf(idx, id);
      if (fid && fid !== id) ids.push(fid);
      for (const x of ids) {
        for (const e of idx.in.get(x) ?? []) {
          if (!IMPACT_EDGES.includes(e.kind)) continue;
          const s = e.source;
          if (changed.has(s) || impacted.has(s)) continue;
          impacted.set(s, { distance: d, via: e.kind });
          next.push(s);
        }
        // tests covering the node
        for (const e of idx.out.get(x) ?? []) {
          if (e.kind === "tested_by" && !changed.has(e.target) && !impacted.has(e.target)) impacted.set(e.target, { distance: d, via: "tested_by" });
        }
      }
    }
    frontier = next;
  }
  const all = [...changed, ...impacted.keys()];
  const affectedLayers = [...new Set(all.map((id) => idx.nodes.get(id)?.layer).filter(Boolean) as string[])];
  const affectedEndpoints = all.filter((id) => idx.nodes.get(id)?.kind === "endpoint");
  // endpoints whose handler was touched
  for (const n of g.nodes) {
    if (n.kind === "endpoint" && n.endpoint?.handlerId && all.includes(n.endpoint.handlerId) && !affectedEndpoints.includes(n.id)) affectedEndpoints.push(n.id);
  }
  const testsToRun = [...new Set(all.map((id) => fileOf(idx, id) ?? id).filter((id) => isTestPath(idx.nodes.get(id)?.path ?? "")))];
  const findingsNodes = new Set((g.security?.findings ?? []).filter((f) => f.status !== "false_positive").map((f) => f.nodeId));
  const securityRelevant = all.filter((id) => {
    const n = idx.nodes.get(id);
    return findingsNodes.has(id) || n?.tags.includes("reads-input") || (n?.kind === "endpoint" && n.endpoint?.auth !== "guarded") || /auth|session|token|crypto|password|permission/i.test(n?.name ?? "");
  });
  const directFiles = changedFiles.length;
  const risk: ImpactReport["risk"] =
    impacted.size > 60 || affectedEndpoints.length > 8 || securityRelevant.length > 5 ? "high" : impacted.size > 15 || affectedEndpoints.length > 0 || securityRelevant.length > 0 || directFiles > 15 ? "medium" : "low";
  return {
    base: meta.base,
    head: meta.head,
    generatedAt: new Date().toISOString(),
    changedFiles,
    changed: [...changed],
    impacted: [...impacted.entries()].map(([id, v]) => ({ id, ...v })).sort((a, b) => a.distance - b.distance),
    affectedLayers,
    affectedEndpoints,
    testsToRun,
    securityRelevant,
    risk,
    unknownFiles,
  };
}

export function diffImpact(root: string, g: KnowledgeGraph, opts: DiffOptions = {}): ImpactReport {
  const { base, head, files } = gitChanges(root, opts);
  return computeImpact(g, files, { base, head }, opts);
}
