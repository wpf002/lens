/**
 * Architecture plans: the target layout an agent proposes from Lens's layout checks,
 * stored at .lens/layout-plan.json. Each area is a set of file moves that ships as one
 * pull request. Lens makes the moves itself; the agent only fixes the references.
 */
import { promises as fs, existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { isFileKind, paths, readJson, renameScannedPaths, writeJsonAtomic, type KnowledgeGraph, type LayoutPlan } from "@lens/core";
import { loadRemediation, safeTarget } from "./remediate.js";
import { isBinary } from "./workspace.js";

export type AreaStatus = "planned" | "applied";
export type LayoutMove = LayoutPlan["areas"][number]["moves"][number];

export interface LayoutArea {
  id: string;
  title: string;
  reason: string;
  moves: LayoutMove[];
  status: AreaStatus;
  /** Moves dropped because the source was missing, the target taken, or the path unsafe. */
  dropped: number;
}

export interface LayoutPlanRecord {
  generatedAt: string;
  costUsd?: number;
  summary: string;
  areas: LayoutArea[];
}

/** Most paths the plan context lists, so a huge repo still fits in the agent's context. */
const MAX_CONTEXT_FILES = 6000;

export const layoutPlanPath = (root: string) => path.join(paths(root).dir, "layout-plan.json");

export async function loadLayoutPlan(root: string): Promise<LayoutPlanRecord | null> {
  return readJson<LayoutPlanRecord>(layoutPlanPath(root));
}

export async function saveLayoutPlan(root: string, record: LayoutPlanRecord): Promise<void> {
  await writeJsonAtomic(layoutPlanPath(root), record, true);
}

function isSafe(root: string, rel: string): boolean {
  try {
    safeTarget(root, rel);
    return true;
  } catch {
    return false;
  }
}

const normalize = (p: string) => path.posix.normalize(p.replace(/\\/g, "/")).replace(/^\.\//, "");

/**
 * Keep only moves that can be made: the source is a text file, the target is free and unclaimed, both inside the project.
 * Fixes record text edits, so a binary or empty file could be deleted but not recreated at its new path.
 */
export function usableMoves(root: string, moves: LayoutMove[], claimed = new Set<string>()): LayoutMove[] {
  const out: LayoutMove[] = [];
  for (const raw of moves) {
    const move = { from: normalize(raw.from), to: normalize(raw.to) };
    if (move.from === move.to || claimed.has(move.from) || claimed.has(move.to)) continue;
    if (!isSafe(root, move.from) || !isSafe(root, move.to)) continue;
    const source = path.join(root, move.from);
    if (!existsSync(source) || !statSync(source).isFile() || existsSync(path.join(root, move.to))) continue;
    const content = readFileSync(source);
    if (!content.length || isBinary(content)) continue;
    claimed.add(move.from);
    claimed.add(move.to);
    out.push(move);
  }
  return out;
}

/** Turn the agent's plan into a stored record. A file claimed by an earlier area stays there. */
export function buildPlanRecord(root: string, plan: LayoutPlan, costUsd?: number): LayoutPlanRecord {
  const claimed = new Set<string>();
  const areas = plan.areas
    .map((a) => {
      const moves = usableMoves(root, a.moves, claimed);
      return { id: a.id, title: a.title, reason: a.reason, moves, status: "planned" as const, dropped: a.moves.length - moves.length };
    })
    .filter((a) => a.moves.length > 0);
  return { generatedAt: new Date().toISOString(), costUsd, summary: plan.summary, areas };
}

/** What the architect agent reads: the layout findings, the frameworks, and every file path. */
export function planContext(graph: KnowledgeGraph): Record<string, unknown> {
  const files = graph.nodes.filter((n) => isFileKind(n) && n.path).map((n) => n.path!);
  const unique = [...new Set(files)].sort();
  return {
    project: { name: graph.project.name, languages: graph.project.languages, frameworks: graph.project.frameworks },
    findings: (graph.layout?.checks ?? []).map((c) => ({ id: c.id, title: c.title, count: c.count, fix: c.fix, hits: c.hits })),
    files: unique.slice(0, MAX_CONTEXT_FILES),
    ...(unique.length > MAX_CONTEXT_FILES ? { truncated: unique.length - MAX_CONTEXT_FILES } : {}),
  };
}

/** Make the moves in a project copy and remove the folders they leave empty. */
export async function moveFiles(workspace: string, moves: LayoutMove[]): Promise<void> {
  for (const move of moves) {
    const target = path.join(workspace, move.to);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.rename(path.join(workspace, move.from), target);
  }
  for (const move of moves) await removeEmptyParents(workspace, path.dirname(path.join(workspace, move.from)));
}

async function removeEmptyParents(workspace: string, dir: string): Promise<void> {
  let current = dir;
  while (current.startsWith(workspace + path.sep) && (await fs.readdir(current).catch(() => ["missing"])).length === 0) {
    await fs.rmdir(current);
    current = path.dirname(current);
  }
}

/** After Undo of an area's moves, offer that area again. */
export async function reopenLayoutArea(root: string, fixId: string): Promise<void> {
  const fix = (await loadRemediation(root, "layout"))?.fixes.find((f) => f.id === fixId);
  const plan = await loadLayoutPlan(root);
  const area = fix && plan?.areas.find((a) => `layout-${a.id}` === fix.itemId);
  if (!plan || !area) return;
  area.status = "planned";
  await saveLayoutPlan(root, plan);
  await renameScannedPaths(root, area.moves.map((m) => ({ from: m.to, to: m.from })));
}
