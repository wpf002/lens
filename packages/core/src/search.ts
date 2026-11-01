/**
 * Graph search. Browser-safe.
 *  - fuzzy: MiniSearch over name/path/tags/summary with typo tolerance and prefix match.
 *  - semantic: TF-IDF cosine with identifier splitting, light stemming, and
 *    synonym expansion, plus one hop of neighbor score propagation so
 *    "which parts handle auth" also surfaces the middleware a login route calls.
 *  - hybrid: normalized blend of both.
 * Optional real embeddings are layered on top by the CLI server (see embeddings.ts).
 */
import MiniSearch from "minisearch";
import type { GraphNode, KnowledgeGraph, NodeKind } from "./types.js";

export interface SearchHit {
  id: string;
  score: number;
  node: GraphNode;
  /** Which terms matched, for highlighting. */
  terms?: string[];
}

export interface SearchOptions {
  limit?: number;
  kinds?: NodeKind[];
}

const STOP = new Set(
  "a an and are as at be by does do for from how i in is it of on or that the this to what where which who why with parts part code handle handles handling deal deals thing things file files".split(" "),
);

/** Concept groups: any term in a group expands to the rest at reduced weight. */
export const SYNONYMS: string[][] = [
  ["auth", "authentication", "authenticate", "authorization", "authorize", "login", "logout", "signin", "signup", "session", "jwt", "token", "oauth", "password", "credential", "passport", "permission", "role", "guard", "sso", "saml", "clerk", "cookie"],
  ["db", "database", "sql", "query", "orm", "prisma", "model", "schema", "table", "migration", "repository", "postgres", "mysql", "sqlite", "mongo", "persistence", "store", "storage"],
  ["api", "endpoint", "route", "router", "handler", "controller", "rest", "http", "request", "response", "graphql", "rpc", "server"],
  ["ui", "component", "view", "page", "screen", "render", "frontend", "react", "button", "form", "layout", "style", "css"],
  ["test", "tests", "spec", "fixture", "mock", "assert", "vitest", "jest", "pytest"],
  ["config", "configuration", "settings", "env", "environment", "option", "flag", "setup"],
  ["error", "exception", "failure", "retry", "fallback", "throw", "catch"],
  ["log", "logging", "logger", "trace", "metric", "telemetry", "monitor", "observability"],
  ["cache", "caching", "memoize", "redis", "ttl"],
  ["queue", "job", "worker", "task", "cron", "schedule", "background", "consumer", "producer", "event", "pubsub", "kafka"],
  ["pay", "payment", "billing", "invoice", "stripe", "checkout", "subscription", "charge", "price"],
  ["user", "account", "profile", "member", "customer"],
  ["deploy", "deployment", "docker", "container", "kubernetes", "k8s", "ci", "pipeline", "workflow", "infra", "terraform"],
  ["parse", "parser", "lexer", "tokenize", "ast", "syntax", "grammar"],
  ["security", "vulnerability", "injection", "xss", "csrf", "sanitize", "escape", "secret", "encrypt", "hash", "crypto"],
  ["file", "fs", "filesystem", "upload", "download", "path", "stream", "blob"],
  ["search", "index", "lookup", "find", "filter", "rank", "fuzzy", "embedding"],
  ["email", "mail", "smtp", "notification", "notify", "sms", "push", "message"],
  ["validate", "validation", "validator", "zod", "check", "verify", "sanitize"],
];

const SYN_INDEX = new Map<string, string[]>();
for (const group of SYNONYMS) {
  for (const w of group) {
    const s = stem(w);
    const rest = group.filter((g) => g !== w).map(stem);
    SYN_INDEX.set(s, [...new Set([...(SYN_INDEX.get(s) ?? []), ...rest])]);
  }
}

export function splitIdentifier(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

export function stem(w: string): string {
  if (w.length <= 4) return w;
  for (const suf of ["ations", "ation", "ing", "ers", "ies", "ed", "er", "es", "ly", "s"]) {
    if (w.endsWith(suf) && w.length - suf.length >= 3) {
      return suf === "ies" ? w.slice(0, -3) + "y" : w.slice(0, -suf.length);
    }
  }
  return w;
}

export function tokenize(text: string): string[] {
  return splitIdentifier(text).filter((t) => !STOP.has(t) && t.length > 1).map(stem);
}

function nodeText(n: GraphNode): string {
  return [n.name, n.name, n.path ?? "", n.tags.join(" "), n.summary, n.notes ?? "", n.kind, n.layer ?? "", n.endpoint?.route ?? ""].join(" ");
}

type Vec = Map<string, number>;

export class GraphSearch {
  private mini: MiniSearch<{ id: string; name: string; path: string; tags: string; summary: string }>;
  private byId = new Map<string, GraphNode>();
  private vecs = new Map<string, Vec>();
  private norms = new Map<string, number>();
  private idf = new Map<string, number>();
  private adj = new Map<string, string[]>();

  constructor(graph: Pick<KnowledgeGraph, "nodes" | "edges">) {
    this.mini = new MiniSearch({
      fields: ["name", "path", "tags", "summary"],
      storeFields: ["id"],
      searchOptions: { boost: { name: 4, path: 2, tags: 2, summary: 1 }, fuzzy: 0.2, prefix: true },
      tokenize: (s) => [...new Set([...s.toLowerCase().split(/[^a-z0-9_]+/), ...splitIdentifier(s)])].filter(Boolean),
    });
    const docs = graph.nodes.map((n) => ({
      id: n.id, name: n.name, path: n.path ?? "", tags: n.tags.join(" "), summary: n.summary,
    }));
    this.mini.addAll(docs);

    const df = new Map<string, number>();
    const tfs = new Map<string, Map<string, number>>();
    for (const n of graph.nodes) {
      this.byId.set(n.id, n);
      const tf = new Map<string, number>();
      for (const t of tokenize(nodeText(n))) tf.set(t, (tf.get(t) ?? 0) + 1);
      tfs.set(n.id, tf);
      for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    }
    const N = Math.max(graph.nodes.length, 1);
    for (const [t, d] of df) this.idf.set(t, Math.log(1 + N / d));
    for (const [id, tf] of tfs) {
      const v: Vec = new Map();
      let sq = 0;
      for (const [t, c] of tf) {
        const w = (1 + Math.log(c)) * (this.idf.get(t) ?? 0);
        v.set(t, w);
        sq += w * w;
      }
      this.vecs.set(id, v);
      this.norms.set(id, Math.sqrt(sq) || 1);
    }
    for (const e of graph.edges) {
      if (e.kind === "contains") continue;
      (this.adj.get(e.source) ?? this.adj.set(e.source, []).get(e.source)!).push(e.target);
      (this.adj.get(e.target) ?? this.adj.set(e.target, []).get(e.target)!).push(e.source);
    }
  }

  node(id: string): GraphNode | undefined {
    return this.byId.get(id);
  }

  fuzzy(q: string, opts: SearchOptions = {}): SearchHit[] {
    if (!q.trim()) return [];
    const kinds = opts.kinds ? new Set(opts.kinds) : null;
    return this.mini
      .search(q)
      .filter((r) => !kinds || kinds.has(this.byId.get(r.id as string)!.kind))
      .slice(0, opts.limit ?? 30)
      .map((r) => ({ id: r.id as string, score: r.score, node: this.byId.get(r.id as string)!, terms: r.terms }));
  }

  /** Expand a query into weighted stems. */
  expand(q: string): Map<string, number> {
    const out = new Map<string, number>();
    for (const t of tokenize(q)) {
      out.set(t, Math.max(out.get(t) ?? 0, 1));
      for (const s of SYN_INDEX.get(t) ?? []) out.set(s, Math.max(out.get(s) ?? 0, 0.45));
    }
    return out;
  }

  semantic(q: string, opts: SearchOptions = {}): SearchHit[] {
    const qv = this.expand(q);
    if (qv.size === 0) return [];
    let qsq = 0;
    for (const [t, w] of qv) {
      const x = w * (this.idf.get(t) ?? 0);
      qsq += x * x;
    }
    const qn = Math.sqrt(qsq) || 1;
    const raw = new Map<string, number>();
    for (const [id, v] of this.vecs) {
      let dot = 0;
      for (const [t, w] of qv) {
        const dv = v.get(t);
        if (dv) dot += dv * w * (this.idf.get(t) ?? 0);
      }
      if (dot > 0) raw.set(id, dot / (qn * this.norms.get(id)!));
    }
    // One hop propagation: neighbors of strong hits get a share.
    const scores = new Map(raw);
    for (const [id, s] of raw) {
      for (const nb of this.adj.get(id) ?? []) scores.set(nb, (scores.get(nb) ?? 0) + s * 0.15);
    }
    const kinds = opts.kinds ? new Set(opts.kinds) : null;
    return [...scores.entries()]
      .filter(([id]) => !kinds || kinds.has(this.byId.get(id)!.kind))
      .sort((a, b) => b[1] - a[1])
      .slice(0, opts.limit ?? 30)
      .map(([id, score]) => ({ id, score, node: this.byId.get(id)! }));
  }

  hybrid(q: string, opts: SearchOptions = {}): SearchHit[] {
    const limit = opts.limit ?? 30;
    // Natural-language questions: drop filler words before fuzzy matching ("which parts handle auth").
    const fq = q.split(/\s+/).filter((w) => !STOP.has(w.toLowerCase())).join(" ") || q;
    const f = this.fuzzy(fq, { ...opts, limit: limit * 2 });
    const s = this.semantic(q, { ...opts, limit: limit * 2 });
    const fmax = f[0]?.score || 1;
    const smax = s[0]?.score || 1;
    const merged = new Map<string, SearchHit>();
    for (const h of f) merged.set(h.id, { ...h, score: (h.score / fmax) * 0.55 });
    for (const h of s) {
      const prev = merged.get(h.id);
      const add = (h.score / smax) * 0.45;
      merged.set(h.id, prev ? { ...prev, score: prev.score + add } : { ...h, score: add });
    }
    return [...merged.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /** Blend externally computed embedding similarities into a result list. */
  withEmbeddings(q: string, sims: Array<{ id: string; score: number }>, opts: SearchOptions = {}): SearchHit[] {
    const base = this.hybrid(q, { ...opts, limit: (opts.limit ?? 30) * 2 });
    const m = new Map(base.map((h) => [h.id, h]));
    const smax = Math.max(...sims.map((x) => x.score), 1e-9);
    for (const { id, score } of sims) {
      const node = this.byId.get(id);
      if (!node) continue;
      const add = (score / smax) * 0.6;
      const prev = m.get(id);
      m.set(id, prev ? { ...prev, score: prev.score * 0.4 + add } : { id, node, score: add });
    }
    return [...m.values()].sort((a, b) => b.score - a.score).slice(0, opts.limit ?? 30);
  }
}
