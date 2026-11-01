import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type SimulationNodeDatum } from "d3-force";
import type { GraphNode } from "@lens/core/browser";
import type { Positions, VNode, ViewModel } from "../types";
import type { EdgeAccumulator } from "./aggregate";
import { edgeAccumulator, MAX_VISIBLE } from "./aggregate";
import type { CompiledFilters } from "./filters";
import { KNOWLEDGE_NODE_KINDS, type GraphModel } from "./model";

const TOPIC_PALETTE = ["#d4a15a", "#60a5fa", "#34d399", "#c084fc", "#f472b6", "#22d3ee", "#fbbf24", "#f87171", "#a3e635", "#94a3b8"];

export function buildKnowledge(model: GraphModel, cf: CompiledFilters): ViewModel {
  const all = model.graph.nodes ?? [];
  // A knowledge graph shows everything; a codebase graph shows only its knowledge-kind nodes (e.g. docs).
  const candidates = all.filter((n) => (model.graph.kind === "knowledge" || KNOWLEDGE_NODE_KINDS.has(n.kind)) && cf.node(n));
  const degree = (n: GraphNode) => (model.idx.out.get(n.id)?.length ?? 0) + (model.idx.in.get(n.id)?.length ?? 0);
  const chosen = [...candidates].sort((a, b) => Number(b.kind === "topic") - Number(a.kind === "topic") || degree(b) - degree(a)).slice(0, MAX_VISIBLE);
  const inView = new Set(chosen.map((n) => n.id));
  if (!chosen.length) {
    return {
      nodes: [], edges: [], layout: "force", rep: () => undefined,
      empty: { title: "No knowledge nodes", body: "Run `lens knowledge` or `/lens-knowledge` on a folder of markdown notes to build a knowledge graph." },
    };
  }
  // topic assignment
  const topics = chosen.filter((n) => n.kind === "topic");
  const topicColor = new Map<string, string>();
  topics.forEach((t, i) => topicColor.set(t.id, TOPIC_PALETTE[i % TOPIC_PALETTE.length]!));
  const topicOf = (n: GraphNode): string | undefined => {
    if (n.kind === "topic") return n.id;
    const e = (model.idx.out.get(n.id) ?? []).find((x) => x.kind === "categorized_under" && topicColor.has(x.target));
    return e?.target;
  };
  const nodes: VNode[] = chosen.map((n) => {
    const t = topicOf(n);
    const big = n.kind === "topic";
    return {
      id: `k:${n.id}`, type: "knode", label: n.name, graphId: n.id, kind: n.kind,
      color: t ? topicColor.get(t) : "var(--muted)", w: big ? 150 : 128, h: big ? 50 : 42, count: degree(n),
      sub: t && t !== n.id ? model.idx.nodes.get(t)?.name : undefined,
    };
  });
  const acc: EdgeAccumulator = edgeAccumulator("k");
  for (const e of model.graph.edges ?? []) {
    if (e.kind === "contains" || !cf.edge(e) || !inView.has(e.source) || !inView.has(e.target)) continue;
    acc.add(`k:${e.source}`, `k:${e.target}`, e.kind);
  }
  const edges = acc.edges().map((e) => ({ ...e, variant: "straight" as const }));
  return { nodes, edges, layout: "force", rep: (id) => (inView.has(id) ? `k:${id}` : undefined) };
}

interface SimNode extends SimulationNodeDatum {
  id: string;
  r: number;
}

/** Synchronous force layout; returns top-left positions. Deterministic for a given input. */
export function forceLayout(vm: Pick<ViewModel, "nodes" | "edges">, ticks = 300): Positions {
  const n = vm.nodes.length;
  const sim: SimNode[] = vm.nodes.map((v, i) => {
    // phyllotaxis seed -> deterministic
    const a = i * 2.399963;
    const rad = 14 * Math.sqrt(i + 1);
    return { id: v.id, r: Math.max(v.w, v.h) / 2, x: Math.cos(a) * rad, y: Math.sin(a) * rad };
  });
  const byId = new Map(sim.map((s) => [s.id, s]));
  const links = vm.edges
    .filter((e) => byId.has(e.source) && byId.has(e.target))
    .map((e) => ({ source: e.source, target: e.target }));
  const simulation = forceSimulation(sim)
    .force("link", forceLink<SimNode, { source: string; target: string }>(links).id((d) => d.id).distance(110).strength(0.5))
    .force("charge", forceManyBody().strength(n > 200 ? -140 : -320))
    .force("collide", forceCollide<SimNode>().radius((d) => d.r + 10))
    .force("x", forceX(0).strength(0.04))
    .force("y", forceY(0).strength(0.06))
    .stop();
  for (let i = 0; i < ticks; i++) simulation.tick();
  const pos: Positions = {};
  vm.nodes.forEach((v, i) => {
    const s = sim[i]!;
    pos[v.id] = { x: (s.x ?? 0) - v.w / 2, y: (s.y ?? 0) - v.h / 2, w: v.w, h: v.h };
  });
  return pos;
}
