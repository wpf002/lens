import type { ChecklistItem } from "./security/checklist.js";
import type { HealthReport } from "./quality/health.js";
/**
 * Lens knowledge graph contract. Browser-safe: no Node imports in this file.
 * Schema id: "lens/1".
 */

export const SCHEMA_VERSION = "lens/1" as const;

export const CODE_KINDS = ["file", "function", "class", "module", "concept"] as const;
export const NONCODE_KINDS = [
  "config", "document", "service", "table", "endpoint", "pipeline", "schema", "resource",
] as const;
export const DOMAIN_KINDS = ["domain", "flow", "step"] as const;
export const KNOWLEDGE_KINDS = ["article", "entity", "topic", "claim", "source"] as const;

export const NODE_KINDS = [...CODE_KINDS, ...NONCODE_KINDS, ...DOMAIN_KINDS, ...KNOWLEDGE_KINDS] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

export const EDGE_KINDS = [
  // structural
  "contains", "imports", "exports", "inherits", "implements",
  // behavioral
  "calls", "subscribes", "publishes", "middleware",
  // data flow
  "reads_from", "writes_to", "transforms", "validates",
  // dependencies
  "depends_on", "tested_by", "configures",
  // semantic
  "related", "similar_to",
  // infra
  "deploys", "serves", "provisions", "triggers",
  // schema / routing
  "migrates", "documents", "routes", "defines_schema",
  // domain
  "contains_flow", "flow_step", "cross_domain", "implemented_by",
  // knowledge
  "links_to", "cites", "contradicts", "builds_on", "categorized_under",
] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];

/** Edge kinds an LLM agent is allowed to add during enrichment. */
export const SEMANTIC_EDGE_KINDS = [
  "calls", "subscribes", "publishes", "middleware", "reads_from", "writes_to",
  "transforms", "validates", "depends_on", "configures", "related", "similar_to",
  "deploys", "serves", "triggers", "documents", "routes",
] as const satisfies readonly EdgeKind[];

export const DEFAULT_EDGE_WEIGHT: Partial<Record<EdgeKind, number>> = {
  contains: 1, inherits: 0.9, implements: 0.9, calls: 0.8, exports: 0.8,
  defines_schema: 0.8, imports: 0.7, deploys: 0.7, migrates: 0.7,
  depends_on: 0.6, configures: 0.6, triggers: 0.6,
};

export type Complexity = "simple" | "moderate" | "complex";
export type SummarySource = "heuristic" | "llm";

export interface NodeMetrics {
  loc?: number;
  fanIn?: number;
  fanOut?: number;
  /** Cyclomatic-ish branch count for functions. */
  branches?: number;
}

export interface EndpointMeta {
  method?: string;
  route: string;
  framework?: string;
  /** Result of the auth-guard detector. */
  auth: "guarded" | "unguarded" | "public" | "unknown";
  authEvidence?: string;
  entryType: "http" | "rpc" | "cli" | "event" | "cron" | "webhook" | "server-action";
  handlerId?: string;
}

export interface DomainMeta {
  entities?: string[];
  businessRules?: string[];
  entryPoint?: string;
  entryType?: "http" | "cli" | "event" | "cron" | "manual";
}

export interface KnowledgeMeta {
  wikilinks?: string[];
  backlinks?: string[];
  category?: string;
  frontmatter?: Record<string, string>;
}

export interface GraphNode {
  /** Stable id: "<kind>:<path>[:<symbol>]" for code, "<kind>:<slug>" otherwise. */
  id: string;
  kind: NodeKind;
  name: string;
  path?: string;
  /** 1-based inclusive line range. */
  lines?: [number, number];
  language?: string;
  summary: string;
  summarySource: SummarySource;
  tags: string[];
  complexity: Complexity;
  /** Layer id, assigned by heuristics or the architecture agent. */
  layer?: string;
  signature?: string;
  exported?: boolean;
  /** Idiom/framework note for learners. */
  notes?: string;
  metrics?: NodeMetrics;
  endpoint?: EndpointMeta;
  domain?: DomainMeta;
  knowledge?: KnowledgeMeta;
  /** True when the node's source changed since its last LLM enrichment. */
  stale?: boolean;
}

export interface Evidence {
  path: string;
  line?: number;
}

export interface GraphEdge {
  source: string;
  target: string;
  kind: EdgeKind;
  weight: number;
  label?: string;
  evidence?: Evidence;
  /** "static" = parsed from code, "llm" = inferred by an agent, "heuristic" = convention. */
  origin: "static" | "llm" | "heuristic";
}

export interface Layer {
  id: string;
  name: string;
  description: string;
  color?: string;
  /** Lower = closer to the user (UI=0). Used for layered layout. */
  rank: number;
  nodeIds: string[];
}

export interface TourStep {
  order: number;
  title: string;
  description: string;
  nodeIds: string[];
  /** Short note on a language/framework idiom shown in this step. */
  lesson?: string;
}

export type Severity = "critical" | "high" | "medium" | "low" | "info";
export type Confidence = "high" | "medium" | "low";

export interface Finding {
  id: string;
  rule: string;
  title: string;
  category:
    | "injection" | "command-exec" | "code-exec" | "xss" | "ssrf" | "path-traversal"
    | "deserialization" | "secrets" | "crypto" | "tls" | "auth" | "config"
    | "redirect" | "mass-assignment" | "dependency" | "supply-chain";
  cwe?: string;
  severity: Severity;
  confidence: Confidence;
  path: string;
  line: number;
  /** Innermost graph node containing the finding (function/class/file). */
  nodeId: string;
  message: string;
  /** Code line with secrets masked. */
  snippet?: string;
  /** True when user-controlled input appears near the sink. */
  tainted?: boolean;
  /** Endpoint ids that can reach this finding through calls/imports. */
  reachableFrom: string[];
  status: "open" | "confirmed" | "false_positive" | "accepted";
  triageNote?: string;
}

export interface ExposurePath {
  findingId: string;
  entryId: string;
  /** Node ids from entry to finding node, inclusive. */
  path: string[];
}

export interface SecurityReport {
  generatedAt: string;
  rulesVersion: string;
  entryPoints: string[];
  findings: Finding[];
  exposure: ExposurePath[];
  summary: {
    bySeverity: Record<Severity, number>;
    unguardedEndpoints: number;
    guardedEndpoints: number;
    publicEndpoints: number;
    riskScore: number;
  };
  /** Pre-launch checklist (see security/checklist.ts). */
  checklist?: ChecklistItem[];
}

export interface ProjectMeta {
  name: string;
  description: string;
  languages: string[];
  frameworks: string[];
  analyzedAt: string;
  gitCommit?: string;
  root?: string;
  /** The project's public website, when the repo says where it lives. */
  homepage?: string;
}

export interface GraphStats {
  files: number;
  nodes: number;
  edges: number;
  loc: number;
  byKind: Partial<Record<NodeKind, number>>;
  enrichedNodes: number;
}

export interface KnowledgeGraph {
  schema: typeof SCHEMA_VERSION;
  kind: "codebase" | "knowledge";
  project: ProjectMeta;
  nodes: GraphNode[];
  edges: GraphEdge[];
  layers: Layer[];
  tour: TourStep[];
  security?: SecurityReport;
  /** Deterministic code-health checks (see quality/health.ts). */
  health?: HealthReport;
  stats: GraphStats;
}

/** Diff impact report, written to .lens/diff.json and served at /api/diff. */
export interface ImpactReport {
  base: string;
  head: string;
  generatedAt: string;
  changedFiles: Array<{ path: string; status: "A" | "M" | "D" | "R"; hunks: Array<[number, number]> }>;
  /** Nodes whose own lines changed. */
  changed: string[];
  /** Nodes affected transitively, with hop distance. */
  impacted: Array<{ id: string; distance: number; via: EdgeKind }>;
  affectedLayers: string[];
  affectedEndpoints: string[];
  testsToRun: string[];
  securityRelevant: string[];
  risk: "low" | "medium" | "high";
  unknownFiles: string[];
}

/* ---------- Agent patch formats (validated by lens apply) ---------- */

export interface EnrichPatch {
  nodes: Array<{
    id: string;
    summary: string;
    tags?: string[];
    complexity?: Complexity;
    notes?: string;
  }>;
  edges?: Array<{ source: string; target: string; kind: EdgeKind; label?: string }>;
  concepts?: Array<{ name: string; summary: string; nodeIds: string[] }>;
}

export interface LayersPatch {
  layers: Array<{ id: string; name: string; description: string; rank: number; color?: string; nodeIds: string[] }>;
}

export interface TourPatch {
  tour: TourStep[];
}

export interface DomainPatch {
  domains: Array<{
    name: string;
    summary: string;
    entities?: string[];
    businessRules?: string[];
    flows: Array<{
      name: string;
      summary: string;
      entryPoint?: string;
      entryType?: DomainMeta["entryType"];
      steps: Array<{ name: string; summary: string; nodeIds: string[] }>;
    }>;
  }>;
  crossDomain?: Array<{ from: string; to: string; label: string }>;
}

export interface TriagePatch {
  findings: Array<{
    id: string;
    status: Finding["status"];
    severity?: Severity;
    note: string;
  }>;
  added?: Array<Omit<Finding, "id" | "reachableFrom" | "status" | "nodeId"> & { nodeId?: string }>;
}
