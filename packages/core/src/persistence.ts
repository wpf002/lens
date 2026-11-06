/** .lens/ data directory: graph, meta, fingerprints, config, scratch. Atomic writes. */
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { KnowledgeGraph, ImpactReport } from "./types.js";

export const DATA_DIR = ".lens";

export interface LensMeta {
  version: string;
  analyzedAt: string;
  gitCommit?: string;
  analyzedFiles: number;
  layersSource: "heuristic" | "llm";
  tourSource: "heuristic" | "llm";
  domainSource?: "llm";
  enrichedAt?: string;
}

export interface LensConfig {
  autoUpdate?: boolean;
  outputLanguage?: string;
  exclude?: string[];
  embedProvider?: "openai" | "voyage" | "ollama";
  embedModel?: string;
}

export const paths = (root: string) => {
  const dir = path.join(root, DATA_DIR);
  return {
    dir,
    graph: path.join(dir, "knowledge-graph.json"),
    meta: path.join(dir, "meta.json"),
    config: path.join(dir, "config.json"),
    fingerprints: path.join(dir, "fingerprints.json"),
    embeddings: path.join(dir, "embeddings.json"),
    diff: path.join(dir, "diff.json"),
    ignore: path.join(dir, ".lensignore"),
    intermediate: path.join(dir, "intermediate"),
    registryCache: path.join(dir, "registry-cache.json"),
  };
};

export async function writeJsonAtomic(file: string, data: unknown, pretty = false): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, pretty ? 2 : undefined) + "\n", "utf8");
  await fs.rename(tmp, file);
}

export async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

export async function loadGraph(root: string): Promise<KnowledgeGraph | null> {
  return readJson<KnowledgeGraph>(paths(root).graph);
}

/** Graph is written with one node/edge per line: diffable in git, still valid JSON. */
export async function saveGraph(root: string, g: KnowledgeGraph): Promise<void> {
  const file = paths(root).graph;
  const { nodes, edges, ...head } = g;
  const lines = [
    "{",
    ...Object.entries(head).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)},`),
    `"nodes": [`,
    nodes.map((n) => "  " + JSON.stringify(n)).join(",\n"),
    `],`,
    `"edges": [`,
    edges.map((e) => "  " + JSON.stringify(e)).join(",\n"),
    `]`,
    "}",
  ];
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  await fs.writeFile(tmp, lines.join("\n") + "\n", "utf8");
  await fs.rename(tmp, file);
}

export const loadMeta = (root: string) => readJson<LensMeta>(paths(root).meta);
export const saveMeta = (root: string, m: LensMeta) => writeJsonAtomic(paths(root).meta, m, true);
export const loadConfig = async (root: string) => (await readJson<LensConfig>(paths(root).config)) ?? {};
export const saveConfig = (root: string, c: LensConfig) => writeJsonAtomic(paths(root).config, c, true);
export const loadFingerprints = async (root: string) => (await readJson<Record<string, string>>(paths(root).fingerprints)) ?? {};
export const saveFingerprints = (root: string, f: Record<string, string>) => writeJsonAtomic(paths(root).fingerprints, f);
export const saveDiff = (root: string, d: ImpactReport) => writeJsonAtomic(paths(root).diff, d, true);

/** Resolve a user path inside root; throws on escape. */
export function safeJoin(root: string, rel: string): string {
  const abs = path.resolve(root, rel);
  const r = path.resolve(root);
  if (abs !== r && !abs.startsWith(r + path.sep)) throw new Error(`Path escapes project root: ${rel}`);
  return abs;
}
