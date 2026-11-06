/** Graph traversal helpers. Browser-safe. */
import type { EdgeKind, Finding, GraphEdge, GraphNode, KnowledgeGraph } from "./types.js";

export interface GraphIndex {
  nodes: Map<string, GraphNode>;
  out: Map<string, GraphEdge[]>;
  in: Map<string, GraphEdge[]>;
  children: Map<string, string[]>;
  parent: Map<string, string>;
}

export function indexGraph(g: Pick<KnowledgeGraph, "nodes" | "edges">): GraphIndex {
  const idx: GraphIndex = { nodes: new Map(), out: new Map(), in: new Map(), children: new Map(), parent: new Map() };
  for (const n of g.nodes) idx.nodes.set(n.id, n);
  for (const e of g.edges) {
    if (!idx.nodes.has(e.source) || !idx.nodes.has(e.target)) continue;
    push(idx.out, e.source, e);
    push(idx.in, e.target, e);
    if (e.kind === "contains") {
      push(idx.children, e.source, e.target);
      idx.parent.set(e.target, e.source);
    }
  }
  return idx;
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V) {
  const a = m.get(k);
  if (a) a.push(v);
  else m.set(k, [v]);
}

/** Walk up `contains` edges to the owning file node (or self). */
export function fileOf(idx: GraphIndex, id: string): string | undefined {
  let cur: string | undefined = id;
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const n = idx.nodes.get(cur);
    if (n && n.kind !== "function" && n.kind !== "class" && n.kind !== "endpoint" && n.kind !== "table") return cur;
    cur = idx.parent.get(cur);
  }
  return undefined;
}

export interface Neighbor {
  id: string;
  distance: number;
  via: EdgeKind;
  direction: "out" | "in";
}

export function neighbors(
  idx: GraphIndex,
  start: string,
  opts: { depth?: number; kinds?: EdgeKind[]; direction?: "out" | "in" | "both"; limit?: number } = {},
): Neighbor[] {
  const depth = opts.depth ?? 1;
  const kinds = opts.kinds ? new Set(opts.kinds) : null;
  const dir = opts.direction ?? "both";
  const seen = new Map<string, Neighbor>();
  let frontier = [start];
  for (let d = 1; d <= depth && frontier.length; d++) {
    const next: string[] = [];
    for (const id of frontier) {
      const steps: Array<[GraphEdge, "out" | "in"]> = [];
      if (dir !== "in") for (const e of idx.out.get(id) ?? []) steps.push([e, "out"]);
      if (dir !== "out") for (const e of idx.in.get(id) ?? []) steps.push([e, "in"]);
      for (const [e, dr] of steps) {
        if (kinds && !kinds.has(e.kind)) continue;
        const other = dr === "out" ? e.target : e.source;
        if (other === start || seen.has(other)) continue;
        seen.set(other, { id: other, distance: d, via: e.kind, direction: dr });
        next.push(other);
        if (opts.limit && seen.size >= opts.limit) return [...seen.values()];
      }
    }
    frontier = next;
  }
  return [...seen.values()];
}

/** Undirected BFS shortest path, ignoring `contains` unless allowed. */
export function shortestPath(
  idx: GraphIndex,
  from: string,
  to: string,
  opts: { allowContains?: boolean; directed?: boolean; kinds?: EdgeKind[] } = {},
): string[] | null {
  if (from === to) return [from];
  const kinds = opts.kinds ? new Set(opts.kinds) : null;
  const prev = new Map<string, string>();
  const q = [from];
  prev.set(from, "");
  while (q.length) {
    const id = q.shift()!;
    const edges: Array<[GraphEdge, string]> = [];
    for (const e of idx.out.get(id) ?? []) edges.push([e, e.target]);
    if (!opts.directed) for (const e of idx.in.get(id) ?? []) edges.push([e, e.source]);
    for (const [e, other] of edges) {
      if (!opts.allowContains && e.kind === "contains") continue;
      if (kinds && !kinds.has(e.kind)) continue;
      if (prev.has(other)) continue;
      prev.set(other, id);
      if (other === to) {
        const path = [to];
        let c = id;
        while (c) {
          path.push(c);
          c = prev.get(c)!;
        }
        return path.reverse();
      }
      q.push(other);
    }
  }
  if (!opts.allowContains) return shortestPath(idx, from, to, { ...opts, allowContains: true });
  return null;
}

/** Directory of a posix path ("" for root files). */
export function dirOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
}

export function ancestorsOfDir(dir: string): string[] {
  if (!dir) return [];
  const parts = dir.split("/");
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}

const NO_AUTH_RULES = new Set(["unauthenticated-mutation", "server-action-no-auth"]);

/** `path:line` of endpoints whose missing-auth finding was triaged as public by design. */
export function publicByTriage(findings: Finding[]): Set<string> {
  return new Set(findings.filter((f) => NO_AUTH_RULES.has(f.rule) && (f.status === "accepted" || f.status === "false_positive")).map((f) => `${f.path}:${f.line}`));
}

/** An unguarded endpoint that triage marked public by design counts as public. */
export function effectiveAuth(n: GraphNode, triagedPublic: Set<string>): NonNullable<GraphNode["endpoint"]>["auth"] | undefined {
  const auth = n.endpoint?.auth;
  return auth === "unguarded" && triagedPublic.has(`${n.path}:${n.lines?.[0]}`) ? "public" : auth;
}

/**
 * Remediation id for a finding. Finding ids are renumbered on every scan, so this
 * hashes what stays put (rule, file, message) to keep fixes tied to the same finding.
 * Supply-chain messages quote the registry's current versions, so those hash the
 * manifest line instead and keep their id when a new release ships.
 */
export function findingItemId(f: Pick<Finding, "rule" | "path" | "message"> & Partial<Pick<Finding, "category" | "snippet">>): string {
  const anchor = f.category === "supply-chain" && f.snippet ? f.snippet : f.message;
  return `finding-${fnv(`${f.rule}|${f.path}|${anchor}`)}`;
}

function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, "0");
}

/**
 * Stable remediation ids for a health check's hits, in hit order. Hashes check, file and detail
 * (plus a counter for repeats in one file) so ids survive rescans and line shifts.
 */
export function checkHitIds(c: { id: string; hits: Array<{ path: string; detail: string }> }): string[] {
  const seen = new Map<string, number>();
  return c.hits.map((h) => {
    const key = `${c.id}|${h.path}|${h.detail}`;
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    return `${c.id}~${fnv(`${key}|${n}`)}`;
  });
}

/** Stable key for a Senior Review finding. Its `review-<i>` id is positional and changes per review. */
export function reviewKey(f: { title: string; path: string }): string {
  return `rv-${fnv(`${f.title}|${f.path}`)}`;
}
