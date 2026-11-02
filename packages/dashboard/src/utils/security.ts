import { effectiveAuth, publicByTriage, type ChecklistItem, type EndpointMeta, type Finding, type GraphNode, type Severity } from "@lens/core/browser";
import type { AuditRecord } from "../api";
import type { VEdge, VNode, ViewModel } from "../types";
import { SEVERITY_RANK, layerColor } from "./colors";
import type { CompiledFilters } from "./filters";
import { columnLayout } from "./layout";
import type { GraphModel } from "./model";

export interface SecurityFilter {
  severities: Severity[];
  categories: string[];
  statuses: Finding["status"][];
}
export const DEFAULT_SECURITY_FILTER: SecurityFilter = { severities: [], categories: [], statuses: [] };

export function filterFindings(findings: Finding[], f: SecurityFilter): Finding[] {
  return findings.filter(
    (x) =>
      (!f.severities.length || f.severities.includes(x.severity)) &&
      (!f.categories.length || f.categories.includes(x.category)) &&
      (!f.statuses.length || f.statuses.includes(x.status)),
  );
}

export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      Number(!!b.tainted) - Number(!!a.tainted) ||
      b.reachableFrom.length - a.reachableFrom.length ||
      a.path.localeCompare(b.path) ||
      a.line - b.line,
  );
}

const AUTH_ORDER: Record<EndpointMeta["auth"], number> = { unguarded: 0, unknown: 1, public: 2, guarded: 3 };
export const SINK_PREFIX = "finding:";
const SIZE = {
  entry: { w: 252, h: 56 },
  mid: { w: 214, h: 42 },
  sink: { w: 264, h: 62 },
};
const MAX_ENDPOINTS = 150;
const MAX_FINDINGS = 150;

export function endpointsOf(model: GraphModel): GraphNode[] {
  const ids = new Set<string>(model.graph.security?.entryPoints ?? []);
  for (const n of model.graph.nodes ?? []) if (n.kind === "endpoint" || n.endpoint) ids.add(n.id);
  return [...ids].map((id) => model.idx.nodes.get(id)).filter((n): n is GraphNode => !!n);
}

export type MergedCheck = ChecklistItem & { ai?: boolean; by?: "you" };

/** Scanner checklist with AI audit verdicts and the owner's own decisions laid over it. */
export function mergeChecklist(base: ChecklistItem[], audit: AuditRecord | null): MergedCheck[] {
  const ai = new Map((audit?.items ?? []).map((i) => [i.id, i]));
  return base.map((c) => {
    const v = ai.get(c.id);
    // The audit can't settle manual items; only the owner can.
    if (!v || (c.status === "manual" && v.by !== "you")) return c;
    return { ...c, status: v.status, evidence: v.evidence.length ? v.evidence : c.evidence, fix: v.fix ?? (v.status === "fail" ? c.fix : undefined), ai: v.by !== "you", by: v.by };
  });
}

/**
 * Unguarded routes whose missing-auth finding was triaged as accepted count as public.
 * When the auth check passed (audit or owner), the remaining unguarded routes are public too.
 */
export function endpointCounts(model: GraphModel, checks: MergedCheck[] = []) {
  const c = { guarded: 0, unguarded: 0, public: 0, unknown: 0 };
  const triaged = publicByTriage(model.graph.security?.findings ?? []);
  const authOk = checks.some((x) => x.id === "t1-auth" && (x.status === "pass" || x.status === "clear" || x.status === "na"));
  for (const n of endpointsOf(model)) {
    const a = effectiveAuth(n, triaged) ?? "unknown";
    c[a === "unguarded" && authOk ? "public" : a]++;
  }
  return c;
}

/** Graph node ids along every exposure path of a finding, plus the sink marker. */
export function findingFocus(model: GraphModel, findingId: string): string[] {
  const out = new Set<string>([SINK_PREFIX + findingId]);
  const f = model.findingById.get(findingId);
  if (f) out.add(f.nodeId);
  for (const x of model.graph.security?.exposure ?? []) if (x.findingId === findingId) for (const id of x.path) out.add(id);
  return [...out];
}

export function buildSecurity(model: GraphModel, cf: CompiledFilters, sf: SecurityFilter): ViewModel {
  const sec = model.graph.security;
  if (!sec) {
    return {
      nodes: [], edges: [], layout: "preset", rep: () => undefined,
      empty: { title: "No security report", body: "This graph has no security section. Run `lens scan` (or `/lens-security` in Claude Code) to map endpoints to dangerous sinks." },
    };
  }
  const findings = sortFindings(filterFindings(sec.findings ?? [], sf)).slice(0, MAX_FINDINGS);
  const findingIds = new Set(findings.map((f) => f.id));
  const exposure = (sec.exposure ?? []).filter((x) => findingIds.has(x.findingId));

  const col = new Map<string, number>();
  const onPath = new Set<string>();
  const endpoints = endpointsOf(model).filter((n) => cf.node(n));
  const endpointIds = new Set(endpoints.map((n) => n.id));
  for (const x of exposure) {
    x.path.forEach((id, i) => {
      if (!model.idx.nodes.has(id)) return;
      onPath.add(id);
      if (i === 0 || endpointIds.has(id)) col.set(id, 0);
      else col.set(id, Math.min(col.get(id) ?? Infinity, i));
    });
  }
  for (const f of findings) {
    if (!col.has(f.nodeId) && model.idx.nodes.has(f.nodeId)) col.set(f.nodeId, endpointIds.has(f.nodeId) ? 0 : 1);
  }
  endpoints.sort(
    (a, b) =>
      Number(onPath.has(b.id)) - Number(onPath.has(a.id)) ||
      AUTH_ORDER[a.endpoint?.auth ?? "unknown"] - AUTH_ORDER[b.endpoint?.auth ?? "unknown"] ||
      a.name.localeCompare(b.name),
  );
  for (const e of endpoints.slice(0, MAX_ENDPOINTS)) col.set(e.id, 0);

  const maxMid = Math.max(1, ...[...col.values()]);
  const sinkCol = maxMid + 1;
  const columns: string[][] = Array.from({ length: sinkCol + 1 }, () => []);
  const nodes: VNode[] = [];
  const vid = new Map<string, string>();
  for (const [id, c] of col) {
    const n = model.idx.nodes.get(id)!;
    const isEntry = c === 0;
    const v: VNode = isEntry
      ? {
          id: `en:${id}`, type: "entry", label: n.endpoint?.route ?? n.name, method: n.endpoint?.method ?? n.endpoint?.entryType?.toUpperCase(),
          auth: n.endpoint?.auth ?? "unknown", sub: n.endpoint?.authEvidence ?? n.path, graphId: id, kind: n.kind,
          w: SIZE.entry.w, h: SIZE.entry.h,
        }
      : {
          id: `mid:${id}`, type: "symbol", label: n.name, graphId: id, kind: n.kind,
          sub: n.path?.split("/").pop(), color: layerColor(model.layerById.get(model.layerOf.get(id) ?? ""), model.layerOf.get(id)),
          w: SIZE.mid.w, h: SIZE.mid.h,
        };
    nodes.push(v);
    vid.set(id, v.id);
    columns[c]!.push(v.id);
  }
  for (const f of findings) {
    const id = `sink:${f.id}`;
    nodes.push({
      id, type: "sink", label: f.title, sub: `${f.cwe ?? f.rule} · ${f.path.split("/").pop()}:${f.line}`,
      severity: f.severity, findingId: f.id, graphId: f.nodeId, status: f.status, tainted: f.tainted,
      w: SIZE.sink.w, h: SIZE.sink.h,
    });
    vid.set(SINK_PREFIX + f.id, id);
    columns[sinkCol]!.push(id);
  }

  const edgeMap = new Map<string, VEdge>();
  const addEdge = (s: string | undefined, t: string | undefined, kind: VEdge["kinds"][number]) => {
    if (!s || !t || s === t) return;
    const key = `${s}->${t}`;
    const e = edgeMap.get(key);
    if (e) e.count++;
    else edgeMap.set(key, { id: `sec:${key}`, source: s, target: t, count: 1, kinds: [kind], variant: "agg" });
  };
  for (const x of exposure) {
    for (let i = 0; i + 1 < x.path.length; i++) addEdge(vid.get(x.path[i]!), vid.get(x.path[i + 1]!), i === 0 ? "routes" : "calls");
    addEdge(vid.get(x.path[x.path.length - 1]!), vid.get(SINK_PREFIX + x.findingId), "calls");
  }
  for (const f of findings) addEdge(vid.get(f.nodeId), vid.get(SINK_PREFIX + f.id), "calls");
  const edges = [...edgeMap.values()];

  const sizeOf = new Map(nodes.map((n) => [n.id, { w: n.w, h: n.h }]));
  const pos = columnLayout(columns, edges, (id) => sizeOf.get(id)!, { colGap: 110, rowGap: 12 });
  for (const n of nodes) {
    const p = pos[n.id];
    if (p) {
      n.x = p.x;
      n.y = p.y;
    }
  }
  // Column captions
  const titles = columns.map((_, i) => (i === 0 ? "Entry points" : i === sinkCol ? "Findings" : i === 1 ? "Handlers & calls" : ""));
  columns.forEach((c, i) => {
    if (!c.length) return;
    const ps = c.map((id) => pos[id]!).filter(Boolean);
    const minX = Math.min(...ps.map((p) => p.x));
    const maxX = Math.max(...ps.map((p) => p.x + p.w));
    const minY = Math.min(...ps.map((p) => p.y));
    nodes.push({
      id: `label:${i}`, type: "label", label: titles[i] ?? "", sub: titles[i] ? String(c.length) : undefined,
      w: maxX - minX, h: 24, x: minX, y: minY - 40,
    });
  });
  return {
    nodes,
    edges,
    layout: "preset",
    rep: (id) => vid.get(id),
    empty: nodes.length ? undefined : { title: "Nothing to show", body: "No endpoints or findings match the current filters." },
  };
}
