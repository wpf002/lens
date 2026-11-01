import { SCHEMA_VERSION, type KnowledgeGraph } from "@lens/core/browser";

/** Loose structural check. Returns human-readable problems; the app still renders what it can. */
export function validateGraph(raw: unknown): { graph: KnowledgeGraph; warnings: string[] } {
  const warnings: string[] = [];
  const g = (raw && typeof raw === "object" ? raw : {}) as Partial<KnowledgeGraph> & Record<string, unknown>;
  if (g.schema !== SCHEMA_VERSION) warnings.push(`Unexpected schema "${String(g.schema ?? "missing")}" (expected "${SCHEMA_VERSION}").`);
  for (const key of ["nodes", "edges", "layers", "tour"] as const) {
    if (!Array.isArray(g[key])) warnings.push(`Missing required array "${key}".`);
  }
  if (!g.project || typeof g.project !== "object") warnings.push(`Missing "project" metadata.`);
  const nodes = Array.isArray(g.nodes) ? g.nodes.filter((n) => n && typeof n === "object" && typeof n.id === "string") : [];
  if (Array.isArray(g.nodes) && nodes.length !== g.nodes.length) warnings.push(`${g.nodes.length - nodes.length} malformed nodes were skipped.`);
  const normNodes = nodes.map((n) => ({
    ...n,
    name: typeof n.name === "string" ? n.name : n.id,
    kind: n.kind ?? "file",
    summary: typeof n.summary === "string" ? n.summary : "",
    summarySource: n.summarySource ?? "heuristic",
    tags: Array.isArray(n.tags) ? n.tags : [],
    complexity: n.complexity ?? "simple",
  }));
  const edges = Array.isArray(g.edges) ? g.edges.filter((e) => e && typeof e.source === "string" && typeof e.target === "string") : [];
  const project = g.project && typeof g.project === "object" ? g.project : { name: "Untitled", description: "", languages: [], frameworks: [], analyzedAt: "" };
  const graph: KnowledgeGraph = {
    schema: SCHEMA_VERSION,
    kind: g.kind === "knowledge" ? "knowledge" : "codebase",
    project: {
      ...project,
      name: project.name ?? "Untitled",
      description: project.description ?? "",
      languages: Array.isArray(project.languages) ? project.languages : [],
      frameworks: Array.isArray(project.frameworks) ? project.frameworks : [],
      analyzedAt: project.analyzedAt ?? "",
    },
    nodes: normNodes,
    edges: edges.map((e) => ({ ...e, weight: typeof e.weight === "number" ? e.weight : 0.5, origin: e.origin ?? "static" })),
    layers: Array.isArray(g.layers) ? g.layers.map((l) => ({ ...l, nodeIds: Array.isArray(l.nodeIds) ? l.nodeIds : [] })) : [],
    tour: Array.isArray(g.tour) ? [...g.tour].map((t) => ({ ...t, nodeIds: Array.isArray(t.nodeIds) ? t.nodeIds : [] })).sort((a, b) => a.order - b.order) : [],
    security: g.security && typeof g.security === "object" ? { ...g.security, findings: g.security.findings ?? [], exposure: g.security.exposure ?? [], entryPoints: g.security.entryPoints ?? [] } : undefined,
    health: g.health && typeof g.health === "object" && Array.isArray(g.health.checks) ? g.health : undefined,
    stats: g.stats ?? { files: 0, nodes: normNodes.length, edges: edges.length, loc: 0, byKind: {}, enrichedNodes: 0 },
  };
  return { graph, warnings };
}
