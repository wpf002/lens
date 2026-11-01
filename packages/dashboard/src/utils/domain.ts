import type { GraphNode } from "@lens/core/browser";
import type { VEdge, VNode, ViewModel } from "../types";
import { hashColor, layerColor } from "./colors";
import type { CompiledFilters } from "./filters";
import type { GraphModel } from "./model";

const SIZE = {
  domain: { w: 236, h: 74 },
  flow: { w: 216, h: 56 },
  step: { w: 204, h: 48 },
  impl: { w: 200, h: 36 },
};

/** Implementing code nodes for a step (edges step -implemented_by-> code). */
export function implementationsOf(model: GraphModel, stepId: string): GraphNode[] {
  return (model.idx.out.get(stepId) ?? [])
    .filter((e) => e.kind === "implemented_by")
    .map((e) => model.idx.nodes.get(e.target))
    .filter((n): n is GraphNode => !!n);
}

export function buildDomain(model: GraphModel, cf: CompiledFilters, opts: { expandedStep?: string | null }): ViewModel {
  const nodes: VNode[] = [];
  const vid = new Map<string, string>();
  const all = model.graph.nodes ?? [];
  const domains = all.filter((n) => n.kind === "domain" && cf.node(n));
  if (!domains.length) {
    return {
      nodes, edges: [], layout: "elk", rep: () => undefined,
      empty: {
        title: "No business map yet",
        body: "The Business view groups code by what it does: business areas contain flows, flows contain steps, and steps link to the code that implements them. Run `/lens-domain` in Claude Code to create it.",
      },
    };
  }
  const domainColor = new Map<string, string>();
  for (const d of domains) {
    const color = hashColor(d.id);
    domainColor.set(d.id, color);
    const flows = (model.idx.out.get(d.id) ?? []).filter((e) => e.kind === "contains_flow").length;
    const v: VNode = { id: `dm:${d.id}`, type: "domain", label: d.name, sub: `${flows} flow${flows === 1 ? "" : "s"}`, graphId: d.id, kind: "domain", color, w: SIZE.domain.w, h: SIZE.domain.h };
    nodes.push(v);
    vid.set(d.id, v.id);
  }
  const edges: VEdge[] = [];
  const add = (s: string, t: string, kind: VEdge["kinds"][number], label?: string) =>
    edges.push({ id: `dom:${s}->${t}:${kind}`, source: s, target: t, count: 1, kinds: [kind], label, variant: "agg", noLayout: kind === "cross_domain" });

  for (const d of domains) {
    for (const e of model.idx.out.get(d.id) ?? []) {
      if (e.kind !== "contains_flow") continue;
      const f = model.idx.nodes.get(e.target);
      if (!f || !cf.node(f) || vid.has(f.id)) continue;
      const steps = (model.idx.out.get(f.id) ?? []).filter((x) => x.kind === "flow_step");
      const v: VNode = { id: `fl:${f.id}`, type: "flow", label: f.name, sub: f.domain?.entryType ? `${f.domain.entryType} · ${steps.length} steps` : `${steps.length} steps`, graphId: f.id, kind: "flow", color: domainColor.get(d.id), w: SIZE.flow.w, h: SIZE.flow.h };
      nodes.push(v);
      vid.set(f.id, v.id);
      add(`dm:${d.id}`, v.id, "contains_flow");
      steps.forEach((se, i) => {
        const s = model.idx.nodes.get(se.target);
        if (!s || !cf.node(s)) return;
        const impls = implementationsOf(model, s.id).length;
        let sv = vid.get(s.id);
        if (!sv) {
          sv = `st:${s.id}`;
          nodes.push({ id: sv, type: "step", label: s.name, sub: `${i + 1} · ${impls} impl`, graphId: s.id, kind: "step", color: domainColor.get(d.id), w: SIZE.step.w, h: SIZE.step.h, count: impls, expanded: opts.expandedStep === s.id });
          vid.set(s.id, sv);
        }
        add(v.id, sv, "flow_step");
      });
    }
  }
  for (const d of domains) {
    for (const e of model.idx.out.get(d.id) ?? []) {
      if (e.kind !== "cross_domain") continue;
      const t = vid.get(e.target);
      if (t) add(`dm:${d.id}`, t, "cross_domain", e.label);
    }
  }
  if (opts.expandedStep && vid.has(opts.expandedStep)) {
    for (const n of implementationsOf(model, opts.expandedStep)) {
      if (!cf.node(n)) continue;
      const id = `impl:${n.id}`;
      if (!vid.has(n.id)) {
        const layer = model.layerOf.get(n.id);
        nodes.push({ id, type: "symbol", label: n.name, sub: n.path?.split("/").pop(), graphId: n.id, kind: n.kind, color: layer ? layerColor(model.layerById.get(layer), layer) : undefined, w: SIZE.impl.w, h: SIZE.impl.h });
        vid.set(n.id, id);
      }
      add(vid.get(opts.expandedStep)!, vid.get(n.id)!, "implemented_by");
    }
  }
  return { nodes, edges, layout: "elk", rep: (id) => vid.get(id) };
}
