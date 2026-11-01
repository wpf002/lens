import type { ImpactReport } from "@lens/core/browser";
import type { ViewModel } from "../types";

export interface OverlayInput {
  /** Graph node ids to spotlight (tour step, search results, path, finding path). */
  focus?: string[] | null;
  /** View node ids to spotlight directly (e.g. an isolated layer). */
  focusV?: ReadonlySet<string> | null;
  diff?: ImpactReport | null;
  selected?: string | null;
}

export interface Overlay {
  dim: Set<string>;
  hl: Set<string>;
  changed: Set<string>;
  /** view node id -> min hop distance */
  impacted: Map<string, number>;
  edgeHl: Set<string>;
  edgeDim: Set<string>;
  selectedV?: string;
  active: boolean;
}

/** Map graph-level highlight state onto the view's nodes and edges. */
export function computeOverlay(vm: ViewModel, input: OverlayInput): Overlay {
  const o: Overlay = { dim: new Set(), hl: new Set(), changed: new Set(), impacted: new Map(), edgeHl: new Set(), edgeDim: new Set(), active: false };
  const parentOf = new Map<string, string>();
  for (const n of vm.nodes) if (n.parent) parentOf.set(n.id, n.parent);

  let focus: Set<string> | null = null;
  if (input.focusV && input.focusV.size) focus = new Set(input.focusV);
  if (input.focus && input.focus.length) {
    focus ??= new Set();
    for (const id of input.focus) {
      const v = vm.rep(id);
      if (v) focus.add(v);
    }
  }

  if (input.diff) {
    for (const id of input.diff.changed ?? []) {
      const v = vm.rep(id);
      if (v) o.changed.add(v);
    }
    for (const x of input.diff.impacted ?? []) {
      const v = vm.rep(x.id);
      if (!v || o.changed.has(v)) continue;
      o.impacted.set(v, Math.min(o.impacted.get(v) ?? Infinity, x.distance));
    }
  }

  const keep = focus ?? (input.diff ? new Set([...o.changed, ...o.impacted.keys()]) : null);
  if (keep) {
    o.active = true;
    // Containers of kept nodes stay visible.
    const keepAll = new Set(keep);
    for (const id of keep) {
      let p = parentOf.get(id);
      while (p && !keepAll.has(p)) {
        keepAll.add(p);
        p = parentOf.get(p);
      }
    }
    for (const n of vm.nodes) {
      if (n.type === "label") continue;
      if (keepAll.has(n.id)) {
        if (focus?.has(n.id)) o.hl.add(n.id);
      } else o.dim.add(n.id);
    }
    for (const e of vm.edges) {
      if (keep.has(e.source) && keep.has(e.target)) o.edgeHl.add(e.id);
      else o.edgeDim.add(e.id);
    }
  }

  if (input.selected) {
    const v = vm.rep(input.selected);
    if (v) {
      o.selectedV = v;
      o.dim.delete(v);
      for (const e of vm.edges) {
        if (e.source === v || e.target === v) {
          o.edgeHl.add(e.id);
          o.edgeDim.delete(e.id);
        }
      }
    }
  }
  return o;
}
