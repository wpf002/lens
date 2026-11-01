/**
 * Layout engine. Pure orchestration over an injected ELK instance so it runs
 * the same in the browser (ELK in a web worker) and in tests (bundled ELK).
 *
 * Containers are laid out bottom-up: each group's children are placed first
 * (layered when they have internal edges, packed in a grid when they don't),
 * then the group is treated as a fixed-size box one level up. Edges that cross
 * containers are lifted to the nearest siblings for layout purposes only;
 * React Flow still draws them between the real endpoints.
 */
import type { Position, Positions } from "../types";

export interface LayoutNode {
  id: string;
  w: number;
  h: number;
  parent?: string;
}
export interface LayoutEdge {
  source: string;
  target: string;
}
export interface LayoutRequest {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  direction?: "RIGHT" | "DOWN";
  /** Allow wrapping very wide layered graphs into rows. */
  wrap?: boolean;
  /** Target width/height ratio used when wrapping long layered graphs. */
  aspectRatio?: number;
}

export interface ElkLikeNode {
  id: string;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  children?: ElkLikeNode[];
  edges?: Array<{ id: string; sources: string[]; targets: string[] }>;
  layoutOptions?: Record<string, string>;
}
export interface ElkLike {
  layout(graph: ElkLikeNode): Promise<ElkLikeNode>;
}

export const GROUP_PAD = { top: 38, side: 14, bottom: 14 };
const GAP = 48;

export async function computeLayout(req: LayoutRequest, elk: ElkLike): Promise<Positions> {
  const byId = new Map(req.nodes.map((n) => [n.id, n]));
  const children = new Map<string, string[]>();
  const ROOT = "\u0000root";
  for (const n of req.nodes) {
    const p = n.parent && byId.has(n.parent) ? n.parent : ROOT;
    (children.get(p) ?? children.set(p, []).get(p)!).push(n.id);
  }
  const parentOf = (id: string): string => {
    const p = byId.get(id)?.parent;
    return p && byId.has(p) ? p : ROOT;
  };
  const chain = (id: string): string[] => {
    const out = [id];
    let cur = id;
    const seen = new Set([id]);
    while (parentOf(cur) !== ROOT) {
      cur = parentOf(cur);
      if (seen.has(cur)) break;
      seen.add(cur);
      out.push(cur);
    }
    out.push(ROOT);
    return out;
  };
  // For each edge, find the container where both ends meet and the two sibling representatives.
  const liftedByContainer = new Map<string, Array<[string, string]>>();
  for (const e of req.edges) {
    if (!byId.has(e.source) || !byId.has(e.target)) continue;
    const a = chain(e.source);
    const b = chain(e.target);
    const bset = new Set(b);
    let lcaIdx = a.findIndex((x) => bset.has(x));
    if (lcaIdx < 0) continue;
    const lca = a[lcaIdx]!;
    const sa = a[lcaIdx - 1];
    const sb = b[b.indexOf(lca) - 1];
    if (!sa || !sb || sa === sb) continue;
    (liftedByContainer.get(lca) ?? liftedByContainer.set(lca, []).get(lca)!).push([sa, sb]);
  }

  const pos: Positions = {};
  const size = new Map<string, { w: number; h: number }>();

  async function layoutContainer(cid: string): Promise<{ w: number; h: number }> {
    const kids = children.get(cid) ?? [];
    for (const k of kids) {
      if (children.has(k)) {
        const inner = await layoutContainer(k);
        size.set(k, { w: inner.w + GROUP_PAD.side * 2, h: inner.h + GROUP_PAD.top + GROUP_PAD.bottom });
      } else {
        const n = byId.get(k)!;
        size.set(k, { w: n.w, h: n.h });
      }
    }
    const lifted = liftedByContainer.get(cid) ?? [];
    const connected = new Set<string>();
    for (const [s, t] of lifted) {
      connected.add(s);
      connected.add(t);
    }
    const conn = kids.filter((k) => connected.has(k));
    const iso = kids.filter((k) => !connected.has(k));
    const local: Record<string, { x: number; y: number }> = {};
    let cw = 0;
    let ch = 0;
    if (conn.length) {
      const seen = new Set<string>();
      const edges: NonNullable<ElkLikeNode["edges"]> = [];
      for (const [s, t] of lifted) {
        const key = `${s}\u0000${t}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({ id: `le${edges.length}`, sources: [s], targets: [t] });
      }
      const baseOptions: Record<string, string> = {
        "elk.algorithm": "layered",
        "elk.direction": req.direction ?? "RIGHT",
        "elk.spacing.nodeNode": "22",
        "elk.layered.spacing.nodeNodeBetweenLayers": "84",
        "elk.spacing.componentComponent": "40",
        "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
        "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
        "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
        "elk.edgeRouting": "SPLINES",
      };
      const graphFor = (options: Record<string, string>): ElkLikeNode => ({
        id: "root",
        layoutOptions: options,
        children: conn.map((k) => ({ id: k, width: size.get(k)!.w, height: size.get(k)!.h })),
        edges,
      });
      let res = await elk.layout(graphFor(baseOptions));
      // Long left-to-right chains: re-run wrapped into rows instead of one very wide strip.
      const ext = extent(res);
      if (req.wrap && conn.length > 12 && ext.w > ext.h * 2.6) {
        res = await elk.layout(
          graphFor({
            ...baseOptions,
            "elk.layered.wrapping.strategy": "MULTI_EDGE",
            "elk.layered.wrapping.additionalEdgeSpacing": "24",
            "elk.aspectRatio": String(req.aspectRatio ?? 1.7),
          }),
        );
      }
      for (const c of res.children ?? []) {
        local[c.id] = { x: c.x ?? 0, y: c.y ?? 0 };
        cw = Math.max(cw, (c.x ?? 0) + (c.width ?? size.get(c.id)?.w ?? 0));
        ch = Math.max(ch, (c.y ?? 0) + (c.height ?? size.get(c.id)?.h ?? 0));
      }
    }
    if (iso.length) {
      const sizes = iso.map((k) => size.get(k)!);
      const area = sizes.reduce((a, s) => a + (s.w + 16) * (s.h + 16), 0);
      const ideal = Math.sqrt(area * 1.9);
      const widest = Math.max(...sizes.map((s) => s.w));
      const beside = conn.length > 0 && ch > cw * 1.15;
      const target = Math.max(widest, conn.length && !beside ? Math.max(cw, ideal) : ideal);
      const packed = shelfPack(iso, sizes, target, 16);
      const ox = conn.length && beside ? cw + GAP : 0;
      const oy = conn.length && !beside ? ch + GAP : 0;
      for (const [id, p] of Object.entries(packed.pos)) local[id] = { x: p.x + ox, y: p.y + oy };
      cw = Math.max(cw, ox + packed.w);
      ch = Math.max(ch, oy + packed.h);
    }
    const isRoot = cid === ROOT;
    for (const k of kids) {
      const l = local[k] ?? { x: 0, y: 0 };
      const s = size.get(k)!;
      pos[k] = {
        x: l.x + (isRoot ? 0 : GROUP_PAD.side),
        y: l.y + (isRoot ? 0 : GROUP_PAD.top),
        w: s.w,
        h: s.h,
      };
    }
    return { w: Math.max(cw, 1), h: Math.max(ch, 1) };
  }

  await layoutContainer(ROOT);
  return pos;
}

function extent(n: ElkLikeNode): { w: number; h: number } {
  let w = 0;
  let h = 0;
  for (const c of n.children ?? []) {
    w = Math.max(w, (c.x ?? 0) + (c.width ?? 0));
    h = Math.max(h, (c.y ?? 0) + (c.height ?? 0));
  }
  return { w, h };
}

/** Row-based packing, preserving input order. */
export function shelfPack(ids: string[], sizes: Array<{ w: number; h: number }>, maxWidth: number, gap: number) {
  const pos: Record<string, { x: number; y: number }> = {};
  let x = 0;
  let y = 0;
  let rowH = 0;
  let w = 0;
  ids.forEach((id, i) => {
    const s = sizes[i]!;
    if (x > 0 && x + s.w > maxWidth) {
      x = 0;
      y += rowH + gap;
      rowH = 0;
    }
    pos[id] = { x, y };
    x += s.w + gap;
    w = Math.max(w, x - gap);
    rowH = Math.max(rowH, s.h);
  });
  return { pos, w, h: y + rowH };
}

/**
 * Column layout with barycenter ordering, for views whose columns carry meaning
 * (security: entry -> hops -> sinks). Deterministic and cheap.
 */
export function columnLayout(
  columns: string[][],
  edges: LayoutEdge[],
  sizeOf: (id: string) => { w: number; h: number },
  opts: { colGap?: number; rowGap?: number; sweeps?: number } = {},
): Positions {
  const colGap = opts.colGap ?? 120;
  const rowGap = opts.rowGap ?? 14;
  const cols = columns.map((c) => [...c]);
  const colOf = new Map<string, number>();
  cols.forEach((c, i) => c.forEach((id) => colOf.set(id, i)));
  const nbrs = new Map<string, string[]>();
  for (const e of edges) {
    if (!colOf.has(e.source) || !colOf.has(e.target)) continue;
    (nbrs.get(e.source) ?? nbrs.set(e.source, []).get(e.source)!).push(e.target);
    (nbrs.get(e.target) ?? nbrs.set(e.target, []).get(e.target)!).push(e.source);
  }
  const order = new Map<string, number>();
  const reindex = () => cols.forEach((c) => c.forEach((id, i) => order.set(id, i)));
  reindex();
  const sweeps = opts.sweeps ?? 4;
  for (let s = 0; s < sweeps; s++) {
    const forward = s % 2 === 0;
    const range = forward ? cols.map((_, i) => i).slice(1) : cols.map((_, i) => i).reverse().slice(1);
    for (const ci of range) {
      const ref = forward ? ci - 1 : ci + 1;
      const bary = new Map<string, number>();
      for (const id of cols[ci]!) {
        const ns = (nbrs.get(id) ?? []).filter((n) => colOf.get(n) === ref);
        bary.set(id, ns.length ? ns.reduce((a, n) => a + order.get(n)!, 0) / ns.length : order.get(id)!);
      }
      cols[ci]!.sort((a, b) => bary.get(a)! - bary.get(b)!);
      reindex();
    }
  }
  const pos: Positions = {};
  let x = 0;
  const heights = cols.map((c) => c.reduce((a, id) => a + sizeOf(id).h + rowGap, -rowGap));
  const maxH = Math.max(0, ...heights);
  cols.forEach((c, ci) => {
    const w = Math.max(0, ...c.map((id) => sizeOf(id).w));
    let y = (maxH - heights[ci]!) / 2;
    for (const id of c) {
      const s = sizeOf(id);
      pos[id] = { x: x + (w - s.w) / 2, y, w: s.w, h: s.h } satisfies Position;
      y += s.h + rowGap;
    }
    x += w + colGap;
  });
  return pos;
}

/**
 * Minimal layered layout (longest-path ranks), used when the ELK worker is
 * unavailable. Implements the subset of ELK's JSON contract computeLayout uses.
 */
export const fallbackElk: ElkLike = {
  async layout(graph) {
    const kids = graph.children ?? [];
    const ids = kids.map((k) => k.id);
    const out = new Map<string, string[]>();
    const indeg = new Map<string, number>(ids.map((id) => [id, 0]));
    for (const e of graph.edges ?? []) {
      const s = e.sources[0]!;
      const t = e.targets[0]!;
      if (!indeg.has(s) || !indeg.has(t) || s === t) continue;
      (out.get(s) ?? out.set(s, []).get(s)!).push(t);
      indeg.set(t, indeg.get(t)! + 1);
    }
    // Kahn with cycle breaking: when stuck, release the lowest in-degree node.
    const rank = new Map<string, number>();
    const remaining = new Set(ids);
    const deg = new Map(indeg);
    while (remaining.size) {
      let ready = [...remaining].filter((id) => deg.get(id) === 0);
      if (!ready.length) {
        const pick = [...remaining].sort((a, b) => deg.get(a)! - deg.get(b)!)[0]!;
        ready = [pick];
      }
      for (const id of ready) {
        remaining.delete(id);
        const r = rank.get(id) ?? 0;
        rank.set(id, r);
        for (const t of out.get(id) ?? []) {
          if (!remaining.has(t)) continue;
          rank.set(t, Math.max(rank.get(t) ?? 0, r + 1));
          deg.set(t, deg.get(t)! - 1);
        }
      }
    }
    const columns: string[][] = [];
    for (const id of ids) {
      const r = rank.get(id) ?? 0;
      (columns[r] ??= []).push(id);
    }
    const sizes = new Map(kids.map((k) => [k.id, { w: k.width ?? 100, h: k.height ?? 40 }]));
    const edges = (graph.edges ?? []).map((e) => ({ source: e.sources[0]!, target: e.targets[0]! }));
    const pos = columnLayout(columns.filter(Boolean), edges, (id) => sizes.get(id)!, { colGap: 84, rowGap: 22 });
    return {
      ...graph,
      children: kids.map((k) => ({ ...k, x: pos[k.id]?.x ?? 0, y: pos[k.id]?.y ?? 0 })),
    };
  },
};

/** Absolute bounding box of a set of positioned nodes (resolving parents). */
export function absolutePosition(id: string, pos: Positions, parentOf: (id: string) => string | undefined): Position | undefined {
  const p = pos[id];
  if (!p) return undefined;
  let x = p.x;
  let y = p.y;
  let cur = parentOf(id);
  const seen = new Set<string>([id]);
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const q = pos[cur];
    if (!q) break;
    x += q.x;
    y += q.y;
    cur = parentOf(cur);
  }
  return { x, y, w: p.w, h: p.h };
}
