import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  ViewportPortal,
  getViewportForBounds,
  useReactFlow,
  type NodeMouseHandler,
} from "@xyflow/react";
import type { Positions, VNode, ViewModel } from "../types";
import { absolutePosition } from "../utils/layout";
import { runLayout } from "../utils/layoutClient";
import { forceLayout } from "../utils/knowledge";
import { computeOverlay, type OverlayInput } from "../utils/overlay";
import { canvasRegistry } from "../utils/canvasRegistry";
import { useStore } from "../store";
import { EdgeMarkers, edgeTypes, type LensEdge } from "./edges";
import { nodeTypes, type LensNode } from "./nodes";
import { EmptyState, Spinner } from "./ui";

interface Props {
  vm: ViewModel;
  overlay: OverlayInput;
  /** Return true when the view handled the click itself. */
  onNodeClick?: (v: VNode) => boolean | void;
  onNodeDoubleClick?: (v: VNode) => void;
  /** Stable key: layout re-fits when it changes (e.g. directory). */
  fitKey?: string;
  direction?: "RIGHT" | "DOWN";
  /** Let ELK wrap very wide graphs into rows. */
  wrap?: boolean;
  minimap?: boolean;
}

interface Laid {
  vm: ViewModel;
  pos: Positions;
}

function presetPositions(vm: ViewModel): Positions {
  const pos: Positions = {};
  for (const n of vm.nodes) pos[n.id] = { x: n.x ?? 0, y: n.y ?? 0, w: n.w, h: n.h };
  return pos;
}

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 2.5;

interface FitOpts {
  ids?: string[];
  padding: number;
  maxZoom?: number;
  duration?: number;
}

/**
 * Fit from our own layout positions and the wrapper's measured size. React Flow's
 * queued fitView can resolve before the container is measured, which yields a NaN
 * viewport (canvas stuck at scale 1) or bounds from a stale layout.
 */
function viewportFor(laid: Laid, el: HTMLElement | null, o: FitOpts) {
  const w = el?.clientWidth ?? 0;
  const h = el?.clientHeight ?? 0;
  if (!w || !h) return null;
  const parents = new Map(laid.vm.nodes.map((n) => [n.id, n.parent]));
  const parentOf = (id: string) => {
    const p = parents.get(id);
    return p && laid.pos[p] ? p : undefined;
  };
  const ids = o.ids ?? laid.vm.nodes.filter((n) => !parentOf(n.id)).map((n) => n.id);
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const id of ids) {
    const p = absolutePosition(id, laid.pos, parentOf);
    if (!p) continue;
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x + p.w);
    y1 = Math.max(y1, p.y + p.h);
  }
  if (![x0, y0, x1, y1].every(Number.isFinite) || x1 <= x0 || y1 <= y0) return null;
  const vp = getViewportForBounds({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, w, h, MIN_ZOOM, o.maxZoom ?? MAX_ZOOM, o.padding);
  return [vp.x, vp.y, vp.zoom].every(Number.isFinite) ? vp : null;
}

function rfType(v: VNode): string {
  return v.type === "group" ? "lensgroup" : v.type;
}

function Inner({ vm, overlay, onNodeClick, onNodeDoubleClick, fitKey, direction, wrap, minimap = true }: Props) {
  const rf = useReactFlow<LensNode, LensEdge>();
  const [laid, setLaid] = useState<Laid | null>(null);
  const [busy, setBusy] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);
  const select = useStore((s) => s.select);
  const selectFinding = useStore((s) => s.selectFinding);
  const setDir = useStore((s) => s.setDir);
  const focus = useStore((s) => s.focus);
  const fitNonce = useStore((s) => s.fitNonce);
  const appliedFocus = useRef(0);
  const lastFitKey = useRef<string | undefined>(undefined);
  const laidRef = useRef<Laid | null>(null);
  laidRef.current = laid;

  const fit = useCallback(
    (o: FitOpts): boolean => {
      const l = laidRef.current;
      const vp = l && viewportFor(l, wrapper.current, o);
      if (!vp) return false;
      void rf.setViewport(vp, { duration: o.duration });
      return true;
    },
    [rf],
  );

  // Layout (off the main thread for ELK; force layout is synchronous but deferred a frame).
  useEffect(() => {
    let cancelled = false;
    if (!vm.nodes.length) {
      setLaid({ vm, pos: {} });
      setBusy(false);
      return;
    }
    if (vm.layout === "preset") {
      setLaid({ vm, pos: presetPositions(vm) });
      setBusy(false);
      return;
    }
    setBusy(true);
    const run = async () => {
      const pos =
        vm.layout === "force"
          ? await new Promise<Positions>((r) => setTimeout(() => r(forceLayout(vm)), 16))
          : await runLayout({
              nodes: vm.nodes.map((n) => ({ id: n.id, w: n.w, h: n.h, parent: n.parent })),
              edges: vm.edges.filter((e) => !e.noLayout).map((e) => ({ source: e.source, target: e.target })),
              direction,
              wrap,
            });
      if (!cancelled) {
        setLaid({ vm, pos });
        setBusy(false);
      }
    };
    run().catch((err: unknown) => {
      console.error("[lens] layout failed", err);
      if (!cancelled) setBusy(false);
    });
    return () => {
      cancelled = true;
    };
  }, [vm, direction, wrap]);

  const ov = useMemo(() => (laid ? computeOverlay(laid.vm, overlay) : null), [laid, overlay]);

  const nodes: LensNode[] = useMemo(() => {
    if (!laid || !ov) return [];
    const out: LensNode[] = [];
    for (const v of laid.vm.nodes) {
      const p = laid.pos[v.id];
      if (!p) continue;
      const state = ov.changed.has(v.id) ? "changed" : ov.impacted.has(v.id) ? "impacted" : ov.hl.has(v.id) ? "hl" : undefined;
      const isGroup = v.type === "group" || (v.type === "file" && v.expanded);
      out.push({
        id: v.id,
        type: rfType(v),
        position: { x: p.x, y: p.y },
        parentId: v.parent && laid.pos[v.parent] ? v.parent : undefined,
        width: p.w,
        height: p.h,
        style: { width: p.w, height: p.h },
        data: { v, state, impact: ov.impacted.get(v.id), selected: ov.selectedV === v.id },
        className: ov.dim.has(v.id) ? "is-dim" : undefined,
        selectable: v.type !== "group" && v.type !== "label",
        draggable: !isGroup && v.type !== "label",
        focusable: v.type !== "label" && v.type !== "group",
        zIndex: isGroup ? 0 : 2,
        ariaLabel: `${v.kind ?? v.type} ${v.label}`,
      });
    }
    return out;
  }, [laid, ov]);

  const edges: LensEdge[] = useMemo(() => {
    if (!laid || !ov) return [];
    return laid.vm.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      type: e.variant ?? "agg",
      sourceHandle: e.variant === "arc" ? "top" : undefined,
      targetHandle: e.variant === "arc" ? "top" : undefined,
      data: { count: e.count, kinds: e.kinds, label: e.label, hl: ov.edgeHl.has(e.id), lift: e.lift, reverse: e.reverse },
      className: ov.edgeDim.has(e.id) ? "is-dim" : undefined,
      zIndex: ov.edgeHl.has(e.id) ? 1 : 0,
      focusable: false,
    }));
  }, [laid, ov]);

  // Expose the current canvas for exports.
  useEffect(() => {
    canvasRegistry.set({
      vm: laid?.vm ?? null,
      element: wrapper.current,
      getBounds: () => {
        const ns = rf.getNodes();
        return ns.length ? rf.getNodesBounds(ns) : null;
      },
    });
    return () => canvasRegistry.set({ vm: null, element: null, getBounds: () => null });
  }, [laid, rf]);

  // Fit on new layout, or honor a pending focus request.
  useEffect(() => {
    // Only act on the layout of the current view model (not a stale one mid-relayout).
    if (!laid || busy || laid.vm !== vm) return;
    const f = focus;
    let frame = 0;
    let tries = 0;
    const run = () => {
      if (f && f.nonce !== appliedFocus.current) {
        const ids = [...new Set(f.ids.map((id) => laid.vm.rep(id)).filter((x): x is string => !!x && !!laid.pos[x]))];
        if (ids.length) {
          if (!fit({ ids, duration: 450, padding: 0.35, maxZoom: 1.25 })) return retry();
          appliedFocus.current = f.nonce;
          lastFitKey.current = fitKey;
          return;
        }
        appliedFocus.current = f.nonce;
      }
      if (lastFitKey.current !== fitKey || !lastFitKey.current) {
        // First fit is instant; later ones (view changes) animate.
        if (!fit({ duration: lastFitKey.current ? 250 : 0, padding: 0.12, maxZoom: 1.1 })) return retry();
        lastFitKey.current = fitKey ?? "_";
      }
    };
    // The wrapper can still be unmeasured for a few frames after mount.
    const retry = () => {
      if (tries++ < 30) frame = requestAnimationFrame(run);
    };
    frame = requestAnimationFrame(run);
    return () => cancelAnimationFrame(frame);
  }, [laid, vm, busy, focus, fitKey, fit]);

  const firstFit = useRef(true);
  useEffect(() => {
    if (firstFit.current) {
      firstFit.current = false;
      return;
    }
    fit({ duration: 300, padding: 0.12 });
  }, [fitNonce, fit]);

  const handleClick: NodeMouseHandler<LensNode> = useCallback(
    (_e, node) => {
      const v = node.data.v;
      if (onNodeClick?.(v)) return;
      if (v.type === "sink" && v.findingId) selectFinding(v.findingId);
      else if (v.graphId) select(v.graphId);
    },
    [onNodeClick, select, selectFinding],
  );
  const handleDouble: NodeMouseHandler<LensNode> = useCallback(
    (_e, node) => {
      const v = node.data.v;
      if (onNodeDoubleClick) return onNodeDoubleClick(v);
      if (v.type === "folder" && v.dir !== undefined) setDir(v.dir);
    },
    [onNodeDoubleClick, setDir],
  );

  if (laid && !laid.vm.nodes.length && !busy) {
    const e = laid.vm.empty ?? { title: "Nothing to show", body: "No nodes match the current filters." };
    return <EmptyState title={e.title} body={e.body} />;
  }

  const narrow = typeof window !== "undefined" && window.innerWidth < 768;
  return (
    <div ref={wrapper} className="relative h-full w-full">
      <ReactFlow<LensNode, LensEdge>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodeClick={handleClick}
        onNodeDoubleClick={handleDouble}
        onPaneClick={() => select(null)}
        minZoom={MIN_ZOOM}
        maxZoom={MAX_ZOOM}
        zoomOnDoubleClick={false}
        nodesConnectable={false}
        elevateNodesOnSelect={false}
        proOptions={{ hideAttribution: true }}
        onlyRenderVisibleElements={nodes.length > 250}
      >
        <ViewportPortal>
          <EdgeMarkers />
        </ViewportPortal>
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.1} color="var(--grid)" />
        <Controls showInteractive={false} position="bottom-left" />
        {!narrow && minimap && (
          <MiniMap
            position="bottom-right"
            pannable
            zoomable
            nodeStrokeWidth={0}
            nodeBorderRadius={3}
            nodeColor={(n) => {
              const v = (n.data as LensNode["data"]).v;
              if (v.type === "group" || v.type === "label" || (v.type === "file" && v.expanded)) return "transparent";
              return v.color ?? "var(--border-strong)";
            }}
            maskColor="var(--xy-minimap-mask-background-color)"
            style={{ width: 168, height: 112 }}
          />
        )}
      </ReactFlow>
      {busy && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="flex items-center gap-2 rounded-full border border-line bg-panel px-3 py-1.5 text-[12px] text-muted shadow-[var(--shadow)]">
            <Spinner size={14} /> Laying out {vm.nodes.length} nodes…
          </div>
        </div>
      )}
    </div>
  );
}

export function GraphCanvas(props: Props) {
  return (
    <ReactFlowProvider>
      <Inner {...props} />
    </ReactFlowProvider>
  );
}
