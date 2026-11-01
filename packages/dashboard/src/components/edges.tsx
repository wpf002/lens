import { memo } from "react";
import { BaseEdge, EdgeLabelRenderer, Position, getBezierPath, getStraightPath, useInternalNode, type Edge, type EdgeProps, type InternalNode } from "@xyflow/react";
import type { EdgeKind } from "@lens/core/browser";

export interface LensEdgeData extends Record<string, unknown> {
  count: number;
  kinds: EdgeKind[];
  label?: string;
  hl?: boolean;
  lift?: number;
  reverse?: boolean;
}
export type LensEdge = Edge<LensEdgeData>;

function strokeWidth(count: number, hl?: boolean): number {
  return Math.min(6, 1.1 + Math.log2(Math.max(1, count)) * 0.9) + (hl ? 0.4 : 0);
}

function Label({ x, y, text, hl, warn }: { x: number; y: number; text: string; hl?: boolean; warn?: boolean }) {
  return (
    <EdgeLabelRenderer>
      <div
        className="nodrag nopan pointer-events-none absolute rounded-full border px-1.5 font-mono text-[10px] leading-[16px] tabular"
        style={{
          transform: `translate(-50%, -50%) translate(${x}px, ${y}px)`,
          background: "var(--panel)",
          borderColor: hl ? "var(--accent)" : warn ? "color-mix(in srgb, var(--sev-high) 60%, var(--border))" : "var(--border)",
          color: hl ? "var(--accent)" : warn ? "var(--sev-high)" : "var(--muted)",
        }}
      >
        {text}
      </div>
    </EdgeLabelRenderer>
  );
}

const title = (d?: LensEdgeData) => (d ? `${d.kinds.join(", ")}${d.count > 1 ? ` · ${d.count} edges` : ""}` : "");

function box(n: InternalNode) {
  const { x, y } = n.internals.positionAbsolute;
  return { x, y, w: n.measured.width ?? n.width ?? 0, h: n.measured.height ?? n.height ?? 0 };
}

/**
 * Picks card sides from where the two nodes actually are, so edges never loop
 * back through the cards they connect:
 *  - target to the right: right side -> left side
 *  - target to the left:  left side -> right side
 *  - same column:         a bracket out through the right-hand gutter
 */
function routeEdge(p: EdgeProps<LensEdge>, s?: InternalNode, t?: InternalNode): [string, number, number] {
  if (!s || !t) {
    const [path, lx, ly] = getBezierPath({ ...p, curvature: 0.3 });
    return [path, lx, ly];
  }
  const a = box(s);
  const b = box(t);
  const acx = a.x + a.w / 2;
  const bcx = b.x + b.w / 2;
  const sy = a.y + a.h / 2;
  const ty = b.y + b.h / 2;
  if (Math.abs(acx - bcx) < Math.min(a.w, b.w) / 2) {
    const sx = a.x + a.w;
    const tx = b.x + b.w;
    const out = Math.max(sx, tx) + 18 + Math.min(42, Math.abs(ty - sy) * 0.12);
    return [`M ${sx} ${sy} C ${out} ${sy}, ${out} ${ty}, ${tx + 2} ${ty}`, out - 6, (sy + ty) / 2];
  }
  const forward = bcx > acx;
  const [path, lx, ly] = getBezierPath({
    sourceX: forward ? a.x + a.w : a.x,
    sourceY: sy,
    sourcePosition: forward ? Position.Right : Position.Left,
    targetX: forward ? b.x : b.x + b.w,
    targetY: ty,
    targetPosition: forward ? Position.Left : Position.Right,
    curvature: 0.3,
  });
  return [path, lx, ly];
}

export const AggEdge = memo(function AggEdge(p: EdgeProps<LensEdge>) {
  const src = useInternalNode(p.source);
  const tgt = useInternalNode(p.target);
  const [path, lx, ly] = routeEdge(p, src, tgt);
  const d = p.data;
  const hl = d?.hl || p.selected;
  const showLabel = !!d?.label || (d && d.count > 2) || (hl && d && d.count > 1);
  return (
    <>
      <BaseEdge
        id={p.id}
        path={path}
        markerEnd={hl ? "url(#lens-arrow-hl)" : "url(#lens-arrow)"}
        style={{ stroke: hl ? "var(--accent)" : "var(--edge)", strokeWidth: strokeWidth(d?.count ?? 1, hl), fill: "none" }}
        interactionWidth={12}
      />
      <title>{title(d)}</title>
      {showLabel && d && <Label x={lx} y={ly} text={d.label ?? `${d.count}`} hl={hl} />}
    </>
  );
});

export const StraightEdge = memo(function StraightEdge(p: EdgeProps<LensEdge>) {
  const [path] = getStraightPath(p);
  const hl = p.data?.hl || p.selected;
  return <BaseEdge id={p.id} path={path} style={{ stroke: hl ? "var(--accent)" : "var(--edge)", strokeWidth: hl ? 1.8 : 1.1, fill: "none" }} />;
});

/** Arc above layer headers: an arc diagram of inter-layer dependencies. Reverse arcs (against rank order) are flagged. */
export const ArcEdge = memo(function ArcEdge(p: EdgeProps<LensEdge>) {
  const d = p.data;
  const lift = d?.lift ?? 40;
  const sx = p.sourceX + (d?.reverse ? -8 : 8);
  const tx = p.targetX + (d?.reverse ? 8 : -8);
  const sy = p.sourceY;
  const ty = p.targetY;
  const path = `M ${sx} ${sy} C ${sx} ${sy - lift * 1.33}, ${tx} ${ty - lift * 1.33}, ${tx} ${ty}`;
  const hl = d?.hl || p.selected;
  const color = hl ? "var(--accent)" : d?.reverse ? "color-mix(in srgb, var(--sev-high) 55%, var(--edge))" : "var(--edge-strong)";
  return (
    <>
      <BaseEdge
        id={p.id}
        path={path}
        markerEnd={hl ? "url(#lens-arrow-hl)" : d?.reverse ? "url(#lens-arrow-warn)" : "url(#lens-arrow-strong)"}
        style={{ stroke: color, strokeWidth: strokeWidth(d?.count ?? 1, hl), fill: "none", strokeDasharray: d?.reverse ? "5 4" : undefined }}
      />
      <title>{`${title(d)}${d?.reverse ? " · points against layer order" : ""}`}</title>
      {d && (hl || d.count >= 3) && <Label x={(sx + tx) / 2} y={Math.min(sy, ty) - lift} text={`${d.count}`} hl={hl} warn={d.reverse} />}
    </>
  );
});

export const edgeTypes = { agg: AggEdge, straight: StraightEdge, arc: ArcEdge };

/** Arrow markers, rendered inside the viewport so exports include them. */
export function EdgeMarkers() {
  const marker = (id: string, color: string) => (
    <marker id={id} viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
      <path d="M 0 1 L 9 5 L 0 9 z" style={{ fill: color }} />
    </marker>
  );
  return (
    <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden>
      <defs>
        {marker("lens-arrow", "var(--edge-strong)")}
        {marker("lens-arrow-strong", "var(--edge-strong)")}
        {marker("lens-arrow-hl", "var(--accent)")}
        {marker("lens-arrow-warn", "var(--sev-high)")}
      </defs>
    </svg>
  );
}
