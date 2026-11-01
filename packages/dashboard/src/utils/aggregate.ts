import type { EdgeKind, GraphNode } from "@lens/core/browser";
import type { VEdge, VNode, ViewModel } from "../types";
import { colorForLayerId, layerColor } from "./colors";
import type { CompiledFilters } from "./filters";
import { FILE_KINDS, commonDir, isUnder, maxSeverity, nodeRisk, type FileInfo, type GraphModel } from "./model";

export const SIZES = {
  file: { w: 212, h: 50 },
  folder: { w: 224, h: 76 },
  symbol: { w: 196, h: 34 },
  more: { w: 180, h: 44 },
  external: { w: 196, h: 50 },
  layerHeader: { w: 212, h: 64 },
} as const;

/** Never render more than this many leaf nodes in one view. */
export const MAX_VISIBLE = 380;
/** Repos at or below this size default to the flat grouped Structure view. */
export const FLAT_THRESHOLD = 150;
const MAX_SYMBOLS_PER_FILE = 60;

export interface EdgeAccumulator {
  add(source: string, target: string, kind: EdgeKind, label?: string): void;
  edges(): VEdge[];
}

/** Collapses many graph edges into one view edge per (source, target) pair with a count. */
export function edgeAccumulator(prefix = "e"): EdgeAccumulator {
  const map = new Map<string, { s: string; t: string; count: number; kinds: Map<EdgeKind, number>; label?: string }>();
  return {
    add(s, t, kind, label) {
      if (s === t) return;
      const key = `${s}\u0000${t}`;
      let a = map.get(key);
      if (!a) {
        a = { s, t, count: 0, kinds: new Map(), label };
        map.set(key, a);
      }
      a.count++;
      a.kinds.set(kind, (a.kinds.get(kind) ?? 0) + 1);
    },
    edges() {
      let i = 0;
      return [...map.values()].map((a) => ({
        id: `${prefix}${i++}:${a.s}->${a.t}`,
        source: a.s,
        target: a.t,
        count: a.count,
        kinds: [...a.kinds.entries()].sort((x, y) => y[1] - x[1]).map(([k]) => k),
        label: a.label,
        variant: "agg" as const,
      }));
    },
  };
}

function fileRank(model: GraphModel, a: FileInfo, b: FileInfo): number {
  const ra = model.riskScoreByFile.get(a.id) ?? 0;
  const rb = model.riskScoreByFile.get(b.id) ?? 0;
  return rb - ra || b.degree - a.degree || b.loc - a.loc || a.path.localeCompare(b.path);
}

function fileVNode(model: GraphModel, f: FileInfo, extra: Partial<VNode> = {}): VNode {
  const n = model.idx.nodes.get(f.id);
  const layer = f.layer ? model.layerById.get(f.layer) : undefined;
  return {
    id: `f:${f.id}`,
    type: "file",
    label: f.name,
    sub: f.dir || "/",
    graphId: f.id,
    kind: f.kind,
    color: f.layer ? layerColor(layer, f.layer) : undefined,
    risk: model.riskByFile.get(f.id),
    w: SIZES.file.w,
    h: SIZES.file.h,
    loc: f.loc,
    expandable: (model.idx.children.get(f.id)?.length ?? 0) > 0,
    stale: n?.stale,
    heuristic: n?.summarySource === "heuristic",
    ...extra,
  };
}

function layerMix(model: GraphModel, files: FileInfo[]): VNode["layerMix"] {
  const counts = new Map<string, number>();
  for (const f of files) {
    const k = f.layer ?? "";
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id, n]) => {
      const layer = id ? model.layerById.get(id) : undefined;
      return { color: id ? layerColor(layer, id) : "var(--faint)", n, name: layer?.name ?? (id || "unassigned") };
    });
}

export interface StructureOptions {
  dir: string;
  flat: boolean;
  expanded: ReadonlySet<string>;
}

export function visibleFiles(model: GraphModel, cf: CompiledFilters): FileInfo[] {
  return model.files.filter((f) => {
    const n = model.idx.nodes.get(f.id);
    return !!n && cf.node(n);
  });
}

/** Where a folder bucket should drill to: skip single-child directory chains. */
function compactDir(childDir: string, files: FileInfo[]): string {
  const common = commonDir(files.map((f) => f.path));
  return common.length > childDir.length && isUnder(common, childDir) ? common : childDir;
}

export function buildStructure(model: GraphModel, cf: CompiledFilters, opts: StructureOptions): ViewModel {
  const files = visibleFiles(model, cf);
  const nodes: VNode[] = [];
  const fileRep = new Map<string, string>();
  let truncated = 0;

  if (opts.flat) {
    const byDir = new Map<string, FileInfo[]>();
    for (const f of files) (byDir.get(f.dir) ?? byDir.set(f.dir, []).get(f.dir)!).push(f);
    const dirsSorted = [...byDir.keys()].sort();
    let budget = MAX_VISIBLE;
    for (const dir of dirsSorted) {
      const list = byDir.get(dir)!.sort((a, b) => a.name.localeCompare(b.name));
      const gid = `g:${dir}`;
      nodes.push({ id: gid, type: "group", label: dir || "/", dir, w: 0, h: 0, fileCount: list.length, risk: undefined });
      for (const f of list) {
        if (budget-- <= 0) {
          truncated++;
          continue;
        }
        const v = fileVNode(model, f, { parent: gid, sub: undefined });
        nodes.push(v);
        fileRep.set(f.id, v.id);
      }
    }
  } else {
    const D = opts.dir;
    const direct: FileInfo[] = [];
    const buckets = new Map<string, FileInfo[]>();
    const outside: FileInfo[] = [];
    for (const f of files) {
      if (f.dir === D) direct.push(f);
      else if (isUnder(f.path, D) && f.path !== D) {
        const rest = D ? f.path.slice(D.length + 1) : f.path;
        const seg = rest.split("/")[0]!;
        const child = D ? `${D}/${seg}` : seg;
        (buckets.get(child) ?? buckets.set(child, []).get(child)!).push(f);
      } else outside.push(f);
    }
    // folders
    const folderEntries = [...buckets.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    const maxFolders = 120;
    const moreFolders = folderEntries.slice(maxFolders);
    for (const [child, list] of folderEntries.slice(0, maxFolders)) {
      const target = compactDir(child, list);
      const id = `d:${target}`;
      const label = D ? target.slice(D.length + 1) : target;
      let risk: VNode["risk"];
      let loc = 0;
      for (const f of list) {
        loc += f.loc;
        risk = maxSeverity(risk, model.riskByFile.get(f.id));
        fileRep.set(f.id, id);
      }
      nodes.push({
        id, type: "folder", label, dir: target, w: SIZES.folder.w, h: SIZES.folder.h,
        fileCount: list.length, loc, layerMix: layerMix(model, list), risk,
      });
    }
    if (moreFolders.length) {
      const id = "more:folders";
      nodes.push({ id, type: "more", label: `+${moreFolders.length} more folders`, w: SIZES.more.w, h: SIZES.more.h, count: moreFolders.length });
      for (const [, list] of moreFolders) for (const f of list) fileRep.set(f.id, id);
    }
    // direct files (capped)
    direct.sort((a, b) => fileRank(model, a, b));
    const cap = Math.max(40, MAX_VISIBLE - nodes.length);
    const shown = direct.slice(0, cap).sort((a, b) => a.name.localeCompare(b.name));
    for (const f of shown) {
      const v = fileVNode(model, f, { sub: undefined });
      nodes.push(v);
      fileRep.set(f.id, v.id);
    }
    if (direct.length > cap) {
      truncated = direct.length - cap;
      const id = "more:files";
      nodes.push({ id, type: "more", label: `+${truncated} more files`, w: SIZES.more.w, h: SIZES.more.h, count: truncated });
      for (const f of direct.slice(cap)) fileRep.set(f.id, id);
    }
    if (D && outside.length) {
      const id = "x:outside";
      nodes.push({ id, type: "external", label: "Outside this folder", sub: `${outside.length} files`, w: SIZES.external.w, h: SIZES.external.h, count: outside.length });
      for (const f of outside) fileRep.set(f.id, id);
    }
  }

  // Expanded files -> symbol children
  const symbolIds = new Set<string>();
  for (const v of nodes) {
    if (v.type !== "file" || !v.graphId || !opts.expanded.has(v.graphId)) continue;
    const kids = (model.idx.children.get(v.graphId) ?? [])
      .map((id) => model.idx.nodes.get(id))
      .filter((n): n is GraphNode => !!n && !FILE_KINDS.has(n.kind) && cf.node(n))
      .sort((a, b) => (a.lines?.[0] ?? 0) - (b.lines?.[0] ?? 0))
      .slice(0, MAX_SYMBOLS_PER_FILE);
    if (!kids.length) continue;
    v.expanded = true;
    for (const k of kids) {
      symbolIds.add(k.id);
      const members = model.idx.children.get(k.id)?.length ?? 0;
      nodes.push({
        id: `s:${k.id}`, type: "symbol", label: k.name, graphId: k.id, kind: k.kind, parent: v.id,
        sub: members ? `${members} members` : undefined,
        color: v.color, risk: nodeRisk(model, k.id), w: SIZES.symbol.w, h: SIZES.symbol.h,
        stale: k.stale, heuristic: k.summarySource === "heuristic",
      });
    }
  }

  const rep = (id: string): string | undefined => {
    const owner = model.owner.get(id);
    if (!owner) return undefined;
    const fv = fileRep.get(owner);
    if (!fv) return undefined;
    if (symbolIds.size && opts.expanded.has(owner)) {
      let cur: string | undefined = id;
      const seen = new Set<string>();
      while (cur && cur !== owner && !seen.has(cur)) {
        if (symbolIds.has(cur)) return `s:${cur}`;
        seen.add(cur);
        cur = model.idx.parent.get(cur);
      }
    }
    return fv;
  };

  const acc = edgeAccumulator();
  for (const e of model.graph.edges ?? []) {
    if (e.kind === "contains" || !cf.edge(e)) continue;
    const s = rep(e.source);
    if (!s) continue;
    const t = rep(e.target);
    if (!t || s === t) continue;
    acc.add(s, t, e.kind);
  }

  return { nodes, edges: acc.edges(), layout: "elk", rep, truncated };
}

/* ------------------------------ Layers view ------------------------------ */

export interface LayerColumn {
  id: string;
  name: string;
  color: string;
  rank: number;
  total: number;
}

export function layerColumns(model: GraphModel, files: FileInfo[], hidden: ReadonlySet<string>): LayerColumn[] {
  const counts = new Map<string, number>();
  for (const f of files) counts.set(f.layer ?? "", (counts.get(f.layer ?? "") ?? 0) + 1);
  const cols: LayerColumn[] = model.layersSorted
    .filter((l) => !hidden.has(l.id))
    .map((l) => ({ id: l.id, name: l.name, color: layerColor(l), rank: l.rank, total: counts.get(l.id) ?? 0 }));
  // layers referenced by nodes but missing from graph.layers
  for (const [id, n] of counts) {
    if (!id || model.layerById.has(id) || hidden.has(id)) continue;
    cols.push({ id, name: id, color: colorForLayerId(id), rank: 999, total: n });
  }
  if (counts.get("")) cols.push({ id: "", name: "Unassigned", color: "var(--faint)", rank: 1000, total: counts.get("")! });
  return cols.sort((a, b) => a.rank - b.rank);
}

export function buildLayers(model: GraphModel, cf: CompiledFilters, opts: { selectedId?: string | null }): ViewModel {
  const files = visibleFiles(model, cf);
  const cols = layerColumns(model, files, new Set(cf.raw.hiddenLayers));
  const byLayer = new Map<string, FileInfo[]>();
  for (const f of files) (byLayer.get(f.layer ?? "") ?? byLayer.set(f.layer ?? "", []).get(f.layer ?? "")!).push(f);
  const total = files.length;
  const nodes: VNode[] = [];
  const fileRep = new Map<string, string>();
  const colIndex = new Map<string, number>();
  // Rows per sub-column chosen so the whole grid lands near a 1.6:1 aspect ratio.
  const ROWS = Math.max(14, Math.min(40, Math.ceil(Math.sqrt(Math.min(total, MAX_VISIBLE) * 2.35))));
  const COL_GAP = 72;
  const SUB_GAP = 14;
  const ROW_H = SIZES.file.h + 10;
  const TOP = SIZES.layerHeader.h + 36;
  let x = 0;
  let truncated = 0;
  cols.forEach((c, ci) => {
    colIndex.set(c.id, ci);
    const list = (byLayer.get(c.id) ?? []).sort((a, b) => fileRank(model, a, b));
    const allowance = total > MAX_VISIBLE ? Math.max(10, Math.floor((MAX_VISIBLE * list.length) / total)) : list.length;
    const shown = list.slice(0, allowance).sort((a, b) => a.path.localeCompare(b.path));
    const overflow = list.length - shown.length;
    const slots = shown.length + (overflow ? 1 : 0);
    const subCols = Math.max(1, Math.ceil(slots / ROWS));
    const rowsUsed = Math.ceil(slots / subCols);
    const width = subCols * SIZES.file.w + (subCols - 1) * SUB_GAP;
    const hid = `lh:${c.id}`;
    nodes.push({
      id: hid, type: "layerHeader", label: c.name, sub: `${c.total} file${c.total === 1 ? "" : "s"}`,
      color: c.color, w: width, h: SIZES.layerHeader.h, x, y: 0, count: c.total, dir: c.id,
    });
    shown.forEach((f, i) => {
      const sc = Math.floor(i / rowsUsed);
      const row = i % rowsUsed;
      const v = fileVNode(model, f, { x: x + sc * (SIZES.file.w + SUB_GAP), y: TOP + row * ROW_H });
      nodes.push(v);
      fileRep.set(f.id, v.id);
    });
    if (overflow) {
      truncated += overflow;
      const i = shown.length;
      const id = `more:${c.id}`;
      nodes.push({
        id, type: "more", label: `+${overflow} more`, w: SIZES.file.w, h: SIZES.file.h, count: overflow,
        x: x + Math.floor(i / rowsUsed) * (SIZES.file.w + SUB_GAP), y: TOP + (i % rowsUsed) * ROW_H,
      });
      for (const f of list.slice(allowance)) fileRep.set(f.id, id);
    }
    x += width + COL_GAP;
  });

  const layerOfFile = (fid: string) => model.fileById.get(fid)?.layer ?? "";
  const acc = new Map<string, { s: number; t: number; count: number; kinds: Map<EdgeKind, number> }>();
  const sel = opts.selectedId ? model.owner.get(opts.selectedId) : undefined;
  const selAcc = edgeAccumulator("sel");
  for (const e of model.graph.edges ?? []) {
    if (e.kind === "contains" || !cf.edge(e)) continue;
    const fs = model.owner.get(e.source);
    const ft = model.owner.get(e.target);
    if (!fs || !ft || fs === ft || !fileRep.has(fs) || !fileRep.has(ft)) continue;
    if (sel && (fs === sel || ft === sel)) selAcc.add(fileRep.get(fs)!, fileRep.get(ft)!, e.kind);
    const ls = colIndex.get(layerOfFile(fs));
    const lt = colIndex.get(layerOfFile(ft));
    if (ls === undefined || lt === undefined || ls === lt) continue;
    const key = `${ls}:${lt}`;
    let a = acc.get(key);
    if (!a) acc.set(key, (a = { s: ls, t: lt, count: 0, kinds: new Map() }));
    a.count++;
    a.kinds.set(e.kind, (a.kinds.get(e.kind) ?? 0) + 1);
  }
  const edges: VEdge[] = [...acc.values()].map((a) => {
    const span = Math.abs(a.t - a.s);
    return {
      id: `arc:${a.s}->${a.t}`,
      source: `lh:${cols[a.s]!.id}`,
      target: `lh:${cols[a.t]!.id}`,
      count: a.count,
      kinds: [...a.kinds.entries()].sort((x, y) => y[1] - x[1]).map(([k]) => k),
      variant: "arc",
      reverse: a.s > a.t,
      lift: 26 + span * 24 + (a.s > a.t ? 12 : 0) + (a.s % 3) * 5,
    };
  });
  // Invisible spacer so fit-to-view leaves room for the tallest arc above the headers.
  const maxLift = Math.max(0, ...edges.map((e) => e.lift ?? 0));
  if (maxLift && x > 0) nodes.push({ id: "label:spacer", type: "label", label: "", w: 1, h: 1, x: 0, y: -maxLift * 1.05 });
  edges.push(...selAcc.edges());

  const rep = (id: string) => {
    const owner = model.owner.get(id);
    return owner ? fileRep.get(owner) : undefined;
  };
  return { nodes, edges, layout: "preset", rep, truncated };
}
