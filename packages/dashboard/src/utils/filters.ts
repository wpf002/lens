import type { Complexity, EdgeKind, GraphEdge, GraphNode, NodeKind } from "@lens/core/browser";
import { findingsWithin, type GraphModel } from "./model";

/** Filters are stored as exclusions so new kinds show up by default. */
export interface Filters {
  hiddenNodeKinds: NodeKind[];
  hiddenEdgeKinds: EdgeKind[];
  hiddenLayers: string[];
  hiddenComplexity: Complexity[];
  hideTests: boolean;
  onlyFindings: boolean;
}

export const DEFAULT_FILTERS: Filters = {
  hiddenNodeKinds: [],
  hiddenEdgeKinds: [],
  hiddenLayers: [],
  hiddenComplexity: [],
  hideTests: false,
  onlyFindings: false,
};

export function activeFilterCount(f: Filters): number {
  return (
    f.hiddenNodeKinds.length +
    f.hiddenEdgeKinds.length +
    f.hiddenLayers.length +
    f.hiddenComplexity.length +
    (f.hideTests ? 1 : 0) +
    (f.onlyFindings ? 1 : 0)
  );
}

/** Coerce anything read from storage into a valid Filters object. */
export function sanitizeFilters(raw: unknown): Filters {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const arr = <T extends string>(v: unknown): T[] => (Array.isArray(v) ? v.filter((x): x is T => typeof x === "string") : []);
  return {
    hiddenNodeKinds: arr<NodeKind>(r.hiddenNodeKinds),
    hiddenEdgeKinds: arr<EdgeKind>(r.hiddenEdgeKinds),
    hiddenLayers: arr<string>(r.hiddenLayers),
    hiddenComplexity: arr<Complexity>(r.hiddenComplexity),
    hideTests: r.hideTests === true,
    onlyFindings: r.onlyFindings === true,
  };
}

const TEST_PATH = /(^|\/)(__tests__|tests?|spec|specs|e2e)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py)$|(^|\/)test_[^/]+\.py$/;

export function isTestNode(n: GraphNode, layer?: string): boolean {
  if (layer === "test" || n.layer === "test") return true;
  if (n.tags.includes("test")) return true;
  return !!n.path && TEST_PATH.test(n.path);
}

export interface CompiledFilters {
  node: (n: GraphNode) => boolean;
  edge: (e: GraphEdge) => boolean;
  raw: Filters;
}

/** Precompile a filter set into fast predicates (memoize per model+filters). */
export function compileFilters(model: GraphModel, f: Filters): CompiledFilters {
  const kinds = new Set(f.hiddenNodeKinds);
  const edgeKinds = new Set(f.hiddenEdgeKinds);
  const layers = new Set(f.hiddenLayers);
  const cx = new Set(f.hiddenComplexity);
  const findingCache = new Map<string, boolean>();
  const hasFindings = (id: string): boolean => {
    let v = findingCache.get(id);
    if (v === undefined) {
      v = findingsWithin(model, id).length > 0;
      findingCache.set(id, v);
    }
    return v;
  };
  const node = (n: GraphNode): boolean => {
    if (kinds.has(n.kind)) return false;
    const layer = model.layerOf.get(n.id);
    if (layers.size && layer && layers.has(layer)) return false;
    if (cx.has(n.complexity)) return false;
    if (f.hideTests && isTestNode(n, layer)) return false;
    if (f.onlyFindings && !hasFindings(n.id)) return false;
    return true;
  };
  const edge = (e: GraphEdge): boolean => !edgeKinds.has(e.kind);
  return { node, edge, raw: f };
}
