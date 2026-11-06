/**
 * Merge agent patches into the graph. Every patch is schema-validated, every
 * id is checked against the graph, and anything that doesn't line up is
 * dropped with a reason. Agents can't corrupt the graph, only fail to improve it.
 */
import type { EdgeKind, Finding, GraphEdge, GraphNode, KnowledgeGraph, Layer } from "./types.js";
import { PATCH_SCHEMAS, formatZodError, type PatchKind } from "./schema.js";
import { heuristicLayer, isFileKind } from "./heuristics.js";
import { summarize } from "./security/analyze.js";
import { indexGraph } from "./graph-utils.js";
import type { LensMeta } from "./persistence.js";

export interface ApplyReport {
  kind: PatchKind;
  applied: number;
  dropped: string[];
}

export class PatchValidationError extends Error {}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "x";

/** Map a possibly sloppy id from an agent onto a real node id. */
export function makeIdResolver(g: KnowledgeGraph): (raw: string) => string | undefined {
  const ids = new Set(g.nodes.map((n) => n.id));
  const byPath = new Map<string, string>();
  const byPathName = new Map<string, string>();
  for (const n of g.nodes) {
    if (n.path && isFileKind(n)) byPath.set(n.path, n.id);
    if (n.path && !isFileKind(n)) byPathName.set(`${n.path}:${n.name}`, n.id);
  }
  return (raw) => {
    const id = raw.trim().replace(/^`|`$/g, "");
    if (ids.has(id)) return id;
    if (byPath.has(id)) return byPath.get(id);
    const m = /^(\w+):(.+)$/.exec(id);
    if (m) {
      const rest = m[2]!.replace(/^\.\//, "");
      if (byPath.has(rest)) return byPath.get(rest);
      if (byPathName.has(rest)) return byPathName.get(rest);
      for (const k of ["file", "config", "document", "service", "pipeline", "schema", "resource", "function", "class"]) {
        if (ids.has(`${k}:${rest}`)) return `${k}:${rest}`;
      }
    }
    return undefined;
  };
}

export function applyPatch(g: KnowledgeGraph, meta: LensMeta, kind: PatchKind, data: unknown): ApplyReport {
  const parsed = PATCH_SCHEMAS[kind].safeParse(data);
  if (!parsed.success) throw new PatchValidationError(`Invalid ${kind} patch:\n${formatZodError(parsed.error)}`);
  const report: ApplyReport = { kind, applied: 0, dropped: [] };
  const resolve = makeIdResolver(g);
  const nodeById = new Map(g.nodes.map((n) => [n.id, n]));

  switch (kind) {
    case "enrich": {
      const p = PATCH_SCHEMAS.enrich.parse(data);
      for (const u of p.nodes) {
        const id = resolve(u.id);
        const n = id ? nodeById.get(id) : undefined;
        if (!n) {
          report.dropped.push(`node ${u.id}: not in graph`);
          continue;
        }
        n.summary = u.summary;
        n.summarySource = "llm";
        if (u.tags) n.tags = [...new Set([...n.tags, ...u.tags.map((t) => t.toLowerCase())])].slice(0, 14);
        if (u.complexity) n.complexity = u.complexity;
        if (u.notes) n.notes = u.notes;
        delete n.stale;
        report.applied++;
      }
      const existing = new Set(g.edges.map((e) => `${e.source}|${e.target}|${e.kind}`));
      for (const e of p.edges ?? []) {
        const s = resolve(e.source);
        const t = resolve(e.target);
        if (!s || !t) {
          report.dropped.push(`edge ${e.source} -> ${e.target}: endpoint not in graph`);
          continue;
        }
        if (s === t) continue;
        const k = `${s}|${t}|${e.kind}`;
        if (existing.has(k)) continue;
        existing.add(k);
        g.edges.push({ source: s, target: t, kind: e.kind as EdgeKind, weight: 0.5, label: e.label, origin: "llm" });
        report.applied++;
      }
      for (const c of p.concepts ?? []) {
        const members = c.nodeIds.map(resolve).filter(Boolean) as string[];
        if (members.length < 2) {
          report.dropped.push(`concept ${c.name}: fewer than 2 known members`);
          continue;
        }
        const id = `concept:${slug(c.name)}`;
        if (!nodeById.has(id)) {
          const node: GraphNode = { id, kind: "concept", name: c.name, summary: c.summary, summarySource: "llm", tags: ["concept"], complexity: "moderate" };
          g.nodes.push(node);
          nodeById.set(id, node);
        }
        for (const m of members) g.edges.push({ source: id, target: m, kind: "related", weight: 0.4, origin: "llm" });
        report.applied++;
      }
      meta.enrichedAt = new Date().toISOString();
      break;
    }

    case "layers": {
      const p = PATCH_SCHEMAS.layers.parse(data);
      const assigned = new Map<string, string>();
      const layers: Layer[] = p.layers.map((L) => ({ ...L, nodeIds: [] as string[] }));
      const fileNodes = g.nodes.filter(isFileKind);
      p.layers.forEach((L, i) => {
        const expanded: string[] = [];
        for (const raw of L.nodeIds) {
          // "glob:src/components/**" assigns whole directories (large repos)
          if (raw.startsWith("glob:")) {
            const re = globToRegExp(raw.slice(5));
            const hits = fileNodes.filter((n) => re.test(n.path!)).map((n) => n.id);
            if (!hits.length) report.dropped.push(`layer ${L.id}: ${raw} matched no files`);
            expanded.push(...hits);
          } else expanded.push(raw);
        }
        for (const raw of expanded) {
          const id = resolve(raw);
          const n = id ? nodeById.get(id) : undefined;
          if (!n || !isFileKind(n)) {
            report.dropped.push(`layer ${L.id}: ${raw} is not a file node`);
            continue;
          }
          if (assigned.has(n.id)) continue;
          assigned.set(n.id, L.id);
          layers[i]!.nodeIds.push(n.id);
        }
      });
      // Files the agent forgot: same-id heuristic layer, else the layer holding most of their directory.
      for (const n of g.nodes) {
        if (!isFileKind(n) || assigned.has(n.id)) continue;
        const h = heuristicLayer(n);
        let target = layers.find((L) => L.id === h);
        if (!target) {
          const dir = n.path!.split("/").slice(0, -1).join("/");
          const counts = layers.map((L) => L.nodeIds.filter((id) => nodeById.get(id)!.path!.startsWith(dir + "/")).length);
          const best = counts.indexOf(Math.max(...counts));
          target = counts[best]! > 0 ? layers[best] : layers[layers.length - 1];
        }
        target!.nodeIds.push(n.id);
        assigned.set(n.id, target!.id);
      }
      for (const n of g.nodes) {
        if (assigned.has(n.id)) n.layer = assigned.get(n.id);
        else if (n.path) {
          const fileId = g.nodes.find((f) => f.path === n.path && isFileKind(f))?.id;
          if (fileId && assigned.has(fileId)) n.layer = assigned.get(fileId);
        }
      }
      g.layers = layers.filter((L) => L.nodeIds.length);
      meta.layersSource = "llm";
      report.applied = g.layers.length;
      break;
    }

    case "tour": {
      const p = PATCH_SCHEMAS.tour.parse(data);
      const steps = p.tour
        .sort((a, b) => a.order - b.order)
        .map((s) => {
          const ids = s.nodeIds.map((raw) => {
            const id = resolve(raw);
            if (!id) report.dropped.push(`tour "${s.title}": ${raw} not in graph`);
            return id;
          }).filter(Boolean) as string[];
          return { ...s, nodeIds: [...new Set(ids)] };
        })
        .filter((s) => s.nodeIds.length)
        .map((s, i) => ({ ...s, order: i + 1 }));
      if (steps.length < 2) throw new PatchValidationError("Tour patch has fewer than 2 steps that reference real nodes.");
      g.tour = steps;
      meta.tourSource = "llm";
      report.applied = steps.length;
      break;
    }

    case "domain": {
      const p = PATCH_SCHEMAS.domain.parse(data);
      const drop = new Set(g.nodes.filter((n) => n.kind === "domain" || n.kind === "flow" || n.kind === "step").map((n) => n.id));
      g.nodes = g.nodes.filter((n) => !drop.has(n.id));
      g.edges = g.edges.filter((e) => !drop.has(e.source) && !drop.has(e.target));
      const add = (n: GraphNode) => {
        g.nodes.push(n);
        nodeById.set(n.id, n);
      };
      const push = (e: Omit<GraphEdge, "weight" | "origin"> & { weight?: number }) => g.edges.push({ weight: 0.6, origin: "llm", ...e });
      const domainIds = new Map<string, string>();
      for (const d of p.domains) {
        const did = `domain:${slug(d.name)}`;
        domainIds.set(d.name.toLowerCase(), did);
        add({ id: did, kind: "domain", name: d.name, summary: d.summary, summarySource: "llm", tags: ["domain"], complexity: "moderate", domain: { entities: d.entities, businessRules: d.businessRules } });
        for (const f of d.flows) {
          const fid = `flow:${slug(d.name)}/${slug(f.name)}`;
          add({ id: fid, kind: "flow", name: f.name, summary: f.summary, summarySource: "llm", tags: ["flow"], complexity: "moderate", domain: { entryPoint: f.entryPoint, entryType: f.entryType } });
          push({ source: did, target: fid, kind: "contains_flow", weight: 1 });
          f.steps.forEach((s, i) => {
            const sid = `step:${slug(d.name)}/${slug(f.name)}/${i + 1}-${slug(s.name)}`;
            add({ id: sid, kind: "step", name: s.name, summary: s.summary, summarySource: "llm", tags: ["step"], complexity: "simple" });
            push({ source: fid, target: sid, kind: "flow_step", label: String(i + 1), weight: 1 });
            for (const raw of s.nodeIds) {
              const t = resolve(raw);
              if (t && !drop.has(t)) push({ source: sid, target: t, kind: "implemented_by" });
              else report.dropped.push(`step "${s.name}": ${raw} not in graph`);
            }
          });
          report.applied++;
        }
      }
      for (const x of p.crossDomain ?? []) {
        const a = domainIds.get(x.from.toLowerCase()) ?? (nodeById.has(x.from) ? x.from : undefined);
        const b = domainIds.get(x.to.toLowerCase()) ?? (nodeById.has(x.to) ? x.to : undefined);
        if (a && b && a !== b) push({ source: a, target: b, kind: "cross_domain", label: x.label, weight: 0.5 });
        else report.dropped.push(`crossDomain ${x.from} -> ${x.to}: unknown domain`);
      }
      meta.domainSource = "llm";
      break;
    }

    case "triage": {
      const p = PATCH_SCHEMAS.triage.parse(data);
      if (!g.security) throw new PatchValidationError("Graph has no security report. Run `lens scan` first.");
      const byId = new Map(g.security.findings.map((f) => [f.id, f]));
      for (const t of p.findings) {
        const f = byId.get(t.id);
        if (!f) {
          report.dropped.push(`finding ${t.id}: unknown id`);
          continue;
        }
        f.status = t.status;
        f.triageNote = t.note;
        if (t.severity) f.severity = t.severity;
        report.applied++;
      }
      const idx = indexGraph(g);
      let next = 9000 + g.security.findings.filter((f) => f.id.startsWith("F9")).length;
      for (const a of p.added ?? []) {
        const nodeId = (a.nodeId && resolve(a.nodeId)) || locateNode(g, a.path, a.line);
        if (!nodeId) {
          report.dropped.push(`added finding ${a.rule}: ${a.path} not in graph`);
          continue;
        }
        const f: Finding = { ...a, id: `F${++next}`, nodeId, reachableFrom: reverseReach(idx, nodeId), status: "confirmed", triageNote: "Added by security triage agent." };
        g.security.findings.push(f);
        report.applied++;
      }
      resortAndSummarize(g);
      break;
    }
  }
  recomputeStats(g);
  return report;
}

export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*") {
      re += ".*";
      i++;
      if (glob[i + 1] === "/") i++;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

const SEVERITY_ORDER = ["critical", "high", "medium", "low", "info"];

/** Re-sort findings by severity and recompute the summary after findings change. */
export function resortAndSummarize(g: KnowledgeGraph): void {
  if (!g.security) return;
  g.security.findings.sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) || a.path.localeCompare(b.path) || a.line - b.line);
  g.security.summary = summarize(g.security.findings, g.nodes.filter((n) => n.kind === "endpoint"));
}

export function locateNode(g: KnowledgeGraph, path: string, line: number): string | undefined {
  const inner = g.nodes
    .filter((n) => n.path === path && (n.kind === "function" || n.kind === "class") && n.lines && n.lines[0] <= line && n.lines[1] >= line)
    .sort((a, b) => b.lines![0] - a.lines![0])[0];
  return inner?.id ?? g.nodes.find((n) => n.path === path && isFileKind(n))?.id;
}

/** Endpoints that can reach `nodeId` over routes/calls/middleware (reverse BFS). */
export function reverseReach(idx: ReturnType<typeof indexGraph>, nodeId: string): string[] {
  const FOLLOW = new Set(["routes", "calls", "middleware"]);
  const seen = new Set([nodeId]);
  const parent = idx.parent.get(nodeId);
  if (parent && idx.nodes.get(parent)?.kind === "function") seen.add(parent);
  let frontier = [...seen];
  const out: string[] = [];
  for (let d = 0; d < 12 && frontier.length; d++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const e of idx.in.get(id) ?? []) {
        if (!FOLLOW.has(e.kind) || seen.has(e.source)) continue;
        seen.add(e.source);
        if (idx.nodes.get(e.source)?.kind === "endpoint") out.push(e.source);
        next.push(e.source);
      }
    }
    frontier = next;
  }
  return out;
}

export function recomputeStats(g: KnowledgeGraph): void {
  g.stats = {
    ...g.stats,
    nodes: g.nodes.length,
    edges: g.edges.length,
    byKind: g.nodes.reduce<Record<string, number>>((a, n) => ((a[n.kind] = (a[n.kind] ?? 0) + 1), a), {}),
    enrichedNodes: g.nodes.filter((n) => n.summarySource === "llm").length,
  };
}

/** Referential integrity + schema check. Returns human-readable problems. */
export function validateGraph(g: unknown): { ok: boolean; errors: string[]; warnings: string[] } {
  // Imported lazily to keep the apply path light.
  const errors: string[] = [];
  const warnings: string[] = [];
  const gg = g as KnowledgeGraph;
  if (!gg || gg.schema !== "lens/1") return { ok: false, errors: ["schema is not lens/1"], warnings };
  const ids = new Set<string>();
  for (const n of gg.nodes) {
    if (ids.has(n.id)) errors.push(`duplicate node id ${n.id}`);
    ids.add(n.id);
  }
  let dangling = 0;
  for (const e of gg.edges) if (!ids.has(e.source) || !ids.has(e.target)) dangling++;
  if (dangling) errors.push(`${dangling} edges reference missing nodes`);
  for (const L of gg.layers) for (const id of L.nodeIds) if (!ids.has(id)) warnings.push(`layer ${L.id} references missing ${id}`);
  for (const s of gg.tour) for (const id of s.nodeIds) if (!ids.has(id)) warnings.push(`tour step ${s.order} references missing ${id}`);
  for (const f of gg.security?.findings ?? []) if (!ids.has(f.nodeId)) warnings.push(`finding ${f.id} anchored to missing ${f.nodeId}`);
  const stale = gg.nodes.filter((n) => n.stale).length;
  if (stale) warnings.push(`${stale} nodes changed since their LLM summary was written`);
  return { ok: errors.length === 0, errors, warnings: warnings.slice(0, 50) };
}
