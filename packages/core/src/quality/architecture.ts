/**
 * Layer rules: imports that point the wrong way through the project's layers
 * (UI reaching the database, data code importing request handlers). Built-in
 * rules cover the common breaks; .lens/architecture.json adds, drops, or skips.
 */
import type { GraphEdge, GraphNode } from "../types.js";
import type { ArchitectureConfig } from "../schema.js";
import { LAYER_DEFS } from "../heuristics.js";
import { globToRegExp } from "../apply.js";
import type { HealthCheck, HealthFile } from "./health.js";
import { ENTRY_RE, GENERATED, push } from "./shared.js";

export interface LayerRule {
  from: string;
  to: string;
  reason: string;
  builtIn: boolean;
}

export const DEFAULT_LAYER_RULES: ReadonlyArray<Omit<LayerRule, "builtIn">> = [
  { from: "ui", to: "data", reason: "UI reaches the database directly" },
  { from: "data", to: "api", reason: "data code depends on request handlers" },
  { from: "data", to: "ui", reason: "data code depends on UI" },
  { from: "service", to: "api", reason: "business logic depends on request handlers" },
  { from: "service", to: "ui", reason: "business logic depends on UI" },
  { from: "utility", to: "api", reason: "a shared helper depends on request handlers" },
];

/** Packages that mean a file talks to a database. */
const DB_PACKAGE = /^(@prisma\/client|prisma|drizzle-orm|pg|postgres|mysql2?|mongoose|mongodb|typeorm|sequelize|knex|kysely|better-sqlite3|sqlite3?|ioredis|redis|@supabase\/supabase-js|sqlalchemy|psycopg2?|asyncpg|pymongo|peewee|django\.db|tortoise|sqlmodel)(\/|\.|$)/;
const DB_PATH = /(^|\/)(db|database|repositor(y|ies)|dao|migrations?|persistence|orm|prisma|sql)(\/|$)|Repository\.|\.repository\./;
/** Framework files that render on the server, where reading the database is the documented pattern. */
const SERVER_ROUTE_FILE = /(^|\/)(app|pages|routes)\/|\.server\.[jt]sx?$/;
const CLIENT_DIRECTIVE = /^\s*["']use client["']/m;
const TYPE_ONLY_IMPORT = /^\s*(import|export)\s+type\b/;

const layerName = (id: string) => LAYER_DEFS.find((d) => d.id === id)?.name ?? id;

/** True when the path itself names this layer, rather than landing in it as the fallback. */
function pathNamesLayer(filePath: string, layerId: string): boolean {
  const def = LAYER_DEFS.find((d) => d.id === layerId);
  if (!def) return false;
  const segs = filePath.split("/");
  return segs.some((_, depth) => def.match.test(segs.slice(depth).join("/")));
}

export function resolveLayerRules(config: ArchitectureConfig | undefined): LayerRule[] {
  const allowed = new Set((config?.allow ?? []).map((p) => `${p.from}>${p.to}`));
  const builtIn = config?.defaults === false ? [] : DEFAULT_LAYER_RULES.filter((r) => !allowed.has(`${r.from}>${r.to}`)).map((r) => ({ ...r, builtIn: true }));
  const owner = (config?.rules ?? []).map((r) => ({ from: r.from, to: r.to, reason: r.reason ?? `${layerName(r.from)} may not import ${layerName(r.to)}`, builtIn: false }));
  return [...builtIn, ...owner];
}

/**
 * Built-in rules guess layers from paths, so they skip the cases where the guess
 * misleads: composition roots, files that only fell into Service by default,
 * server-rendered pages reading data, and "data" files that are only types or stores.
 */
function builtInRuleApplies(rule: LayerRule, source: HealthFile, target: HealthFile): boolean {
  if (ENTRY_RE.test(source.path)) return false;
  if (rule.from === "service" && !pathNamesLayer(source.path, "service")) return false;
  if (rule.to === "data") {
    const talksToDb = DB_PATH.test(target.path) || target.imports.some((i) => DB_PACKAGE.test(i.source));
    if (!talksToDb) return false;
    if (SERVER_ROUTE_FILE.test(source.path) && !CLIENT_DIRECTIVE.test(source.src)) return false;
  }
  return true;
}

export interface LayerCheckInput {
  files: HealthFile[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  config?: ArchitectureConfig;
}

export function buildLayerCheck({ files, nodes, edges, config }: LayerCheckInput): Omit<HealthCheck, "source"> {
  const rules = resolveLayerRules(config);
  const ignore = (config?.ignore ?? []).map(globToRegExp);
  const skipped = (p: string) => GENERATED.test(p) || ignore.some((re) => re.test(p));
  const fileById = new Map<string, { node: GraphNode; file: HealthFile }>();
  const fileByPath = new Map(files.map((f) => [f.path, f]));
  for (const n of nodes) {
    const f = n.path && n.id === `${n.kind}:${n.path}` ? fileByPath.get(n.path) : undefined;
    if (f && !f.isTest) fileById.set(n.id, { node: n, file: f });
  }
  const hits: HealthCheck["hits"] = [];
  let count = 0;
  const seen = new Set<string>();
  for (const e of edges) {
    if (e.kind !== "imports" && e.kind !== "exports") continue;
    const s = fileById.get(e.source);
    const t = fileById.get(e.target);
    if (!s || !t || s === t || skipped(s.file.path) || skipped(t.file.path)) continue;
    const line = e.evidence?.line;
    if (line && TYPE_ONLY_IMPORT.test(s.file.src.split("\n")[line - 1] ?? "")) continue;
    const rule = rules.find((r) => r.from === s.node.layer && r.to === t.node.layer);
    if (!rule || (rule.builtIn && !builtInRuleApplies(rule, s.file, t.file))) continue;
    const key = `${s.file.path}>${t.file.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    count++;
    push(hits, { path: s.file.path, line, detail: `${layerName(rule.from)} → ${layerName(rule.to)}: imports ${t.file.path} (${rule.reason})` });
  }
  return {
    id: "layer-violations",
    title: "Layer Violations",
    category: "architecture",
    severity: "medium",
    hits,
    count,
    fix: "Route the dependency through the layer between them: UI calls an API or service, services and data code return plain values and never import handlers or components. Move shared types into a Utility module both sides import.",
  };
}
