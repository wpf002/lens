/** Read-side helpers used by the CLI `query` / `explain` commands and the chat skill. */
import type { GraphNode, KnowledgeGraph } from "./types.js";
import { indexGraph, neighbors } from "./graph-utils.js";
import { isFileKind } from "./heuristics.js";

export function findNode(g: KnowledgeGraph, ref: string): GraphNode | undefined {
  const r = ref.trim().replace(/^\.\//, "");
  const exact = g.nodes.find((n) => n.id === r);
  if (exact) return exact;
  const [p, sym] = r.split(/[#:](?=[^/]*$)/);
  if (sym && p) {
    const hit = g.nodes.find((n) => n.path === p && (n.name === sym || n.name.endsWith(`.${sym}`)));
    if (hit) return hit;
  }
  return g.nodes.find((n) => n.path === r && isFileKind(n)) ?? g.nodes.find((n) => n.name === r) ?? g.nodes.find((n) => n.path?.endsWith(r) && isFileKind(n));
}

export function explain(g: KnowledgeGraph, ref: string) {
  const n = findNode(g, ref);
  if (!n) return null;
  const idx = indexGraph(g);
  const rel = (dir: "out" | "in") => {
    const es = (dir === "out" ? idx.out : idx.in).get(n.id) ?? [];
    const group: Record<string, Array<{ id: string; name: string; summary: string }>> = {};
    for (const e of es) {
      const other = idx.nodes.get(dir === "out" ? e.target : e.source);
      if (!other) continue;
      const key = dir === "out" ? e.kind : `${e.kind} (incoming)`;
      (group[key] ??= []).push({ id: other.id, name: other.name, summary: other.summary.slice(0, 140) });
    }
    return group;
  };
  const findings = (g.security?.findings ?? []).filter((f) => f.nodeId === n.id || idx.parent.get(f.nodeId) === n.id || (isFileKind(n) && f.path === n.path));
  const tourSteps = g.tour.filter((s) => s.nodeIds.includes(n.id)).map((s) => `${s.order}. ${s.title}`);
  const endpoints = g.nodes.filter((e) => e.kind === "endpoint" && (e.endpoint?.handlerId === n.id || (isFileKind(n) && e.path === n.path)));
  return {
    node: n,
    layer: g.layers.find((L) => L.id === n.layer)?.name,
    outgoing: rel("out"),
    incoming: rel("in"),
    endpoints: endpoints.map((e) => ({ id: e.id, name: e.name, auth: e.endpoint?.auth })),
    findings: findings.map((f) => ({ id: f.id, severity: f.severity, title: f.title, line: f.line, status: f.status })),
    tourSteps,
    blastRadius: neighbors(idx, n.id, { depth: 3, direction: "in", kinds: ["imports", "calls", "inherits", "implements", "routes"] }).length,
  };
}

export function graphStats(g: KnowledgeGraph) {
  const idx = indexGraph(g);
  const topFanIn = g.nodes.filter((n) => n.kind === "function" || n.kind === "class").sort((a, b) => (b.metrics?.fanIn ?? 0) - (a.metrics?.fanIn ?? 0)).slice(0, 10);
  const orphans = g.nodes.filter((n) => n.kind === "file" && !(idx.in.get(n.id) ?? []).some((e) => e.kind !== "contains") && !(idx.out.get(n.id) ?? []).some((e) => e.kind !== "contains"));
  return {
    project: g.project,
    stats: g.stats,
    layers: g.layers.map((L) => ({ id: L.id, name: L.name, files: L.nodeIds.length })),
    mostDependedOn: topFanIn.map((n) => ({ id: n.id, fanIn: n.metrics?.fanIn })),
    isolatedFiles: orphans.length,
    security: g.security?.summary,
  };
}
