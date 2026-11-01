import type { EdgeKind, NodeKind, Severity } from "@lens/core/browser";
import type { Auth } from "./utils/colors";

export type ViewId = "structure" | "layers" | "domain" | "security" | "health" | "knowledge";

export const VIEW_ORDER: ViewId[] = ["structure", "layers", "domain", "security", "health", "knowledge"];
export const VIEW_LABEL: Record<ViewId, string> = {
  structure: "Structure",
  layers: "Layers",
  domain: "Business",
  security: "Security",
  health: "Health",
  knowledge: "Knowledge",
};

export type VNodeType =
  | "file"
  | "folder"
  | "symbol"
  | "group"
  | "more"
  | "external"
  | "layerHeader"
  | "entry"
  | "sink"
  | "domain"
  | "flow"
  | "step"
  | "knode"
  | "label";

/** A node in a rendered view. Views are derived from the graph; one VNode can stand for many graph nodes. */
export interface VNode {
  id: string;
  type: VNodeType;
  label: string;
  sub?: string;
  /** Underlying graph node, when the view node maps 1:1. */
  graphId?: string;
  kind?: NodeKind;
  color?: string;
  risk?: Severity;
  w: number;
  h: number;
  parent?: string;
  /** Preset position (relative to parent) for views that lay out themselves. */
  x?: number;
  y?: number;
  // type-specific payload
  dir?: string;
  fileCount?: number;
  loc?: number;
  layerMix?: Array<{ color: string; n: number; name: string }>;
  expandable?: boolean;
  expanded?: boolean;
  auth?: Auth;
  method?: string;
  severity?: Severity;
  findingId?: string;
  count?: number;
  status?: string;
  tainted?: boolean;
  stale?: boolean;
  heuristic?: boolean;
}

export interface VEdge {
  id: string;
  source: string;
  target: string;
  count: number;
  kinds: EdgeKind[];
  label?: string;
  variant?: "agg" | "arc" | "straight";
  /** Arc edges that point against layer order. */
  reverse?: boolean;
  /** Arc height for arc edges. */
  lift?: number;
  /** Drawn, but ignored by the layout engine (e.g. cross-domain links). */
  noLayout?: boolean;
}

export interface ViewModel {
  nodes: VNode[];
  edges: VEdge[];
  layout: "elk" | "preset" | "force";
  /** Map a graph node id to the view node representing it (if any). */
  rep: (graphId: string) => string | undefined;
  truncated?: number;
  empty?: { title: string; body: string };
}

export interface Position {
  x: number;
  y: number;
  w: number;
  h: number;
}
export type Positions = Record<string, Position>;
