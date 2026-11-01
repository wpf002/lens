import {
  GraphSearch,
  dirOf,
  indexGraph,
  type Finding,
  type GraphIndex,
  type GraphNode,
  type KnowledgeGraph,
  type Layer,
  type NodeKind,
  type Severity,
} from "@lens/core/browser";
import { SEVERITY_RANK, SEVERITY_WEIGHT } from "./colors";

/** Node kinds that live at a file path and appear in the file tree / Structure view. */
export const FILE_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>([
  "file", "config", "document", "service", "pipeline", "schema", "resource",
]);
export const KNOWLEDGE_NODE_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>(["article", "entity", "topic", "claim", "source"]);
export const DOMAIN_NODE_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>(["domain", "flow", "step"]);

export interface FileInfo {
  id: string;
  path: string;
  dir: string;
  name: string;
  kind: NodeKind;
  loc: number;
  layer?: string;
  degree: number;
}

export interface DirInfo {
  path: string;
  name: string;
  parent: string | null;
  childDirs: string[];
  files: string[];
}

export interface GraphModel {
  graph: KnowledgeGraph;
  idx: GraphIndex;
  search: GraphSearch;
  files: FileInfo[];
  fileById: Map<string, FileInfo>;
  fileByPath: Map<string, string>;
  /** node id -> owning file id */
  owner: Map<string, string>;
  /** node id -> layer id */
  layerOf: Map<string, string>;
  layerById: Map<string, Layer>;
  layersSorted: Layer[];
  dirs: Map<string, DirInfo>;
  findingsByNode: Map<string, Finding[]>;
  findingsByFile: Map<string, Finding[]>;
  findingById: Map<string, Finding>;
  /** Max open-ish severity of findings inside a file. */
  riskByFile: Map<string, Severity>;
  riskScoreByFile: Map<string, number>;
  hasKnowledge: boolean;
  hasDomain: boolean;
  hasSecurity: boolean;
  staleCount: number;
  totalFiles: number;
}

export function isActiveFinding(f: Finding): boolean {
  return f.status !== "false_positive";
}

export function maxSeverity(a: Severity | undefined, b: Severity | undefined): Severity | undefined {
  if (!a) return b;
  if (!b) return a;
  return SEVERITY_RANK[a] <= SEVERITY_RANK[b] ? a : b;
}

function isCanonicalFile(n: GraphNode): boolean {
  return FILE_KINDS.has(n.kind) && (!n.path || n.id === `${n.kind}:${n.path}`);
}

/** Build every derived index the views need, once per graph load. */
export function buildModel(graph: KnowledgeGraph): GraphModel {
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph.edges) ? graph.edges : [];
  const layers = Array.isArray(graph.layers) ? graph.layers : [];
  const safe = { nodes, edges };
  const idx = indexGraph(safe);
  const search = new GraphSearch(safe);

  // Files: canonical file-ish nodes. A second file-ish node at the same path
  // (e.g. a compose service) is treated as a member of the canonical file.
  const fileByPath = new Map<string, string>();
  const files: FileInfo[] = [];
  const fileById = new Map<string, FileInfo>();
  const pending: GraphNode[] = [];
  for (const n of nodes) {
    if (!FILE_KINDS.has(n.kind)) continue;
    if (isCanonicalFile(n)) pending.unshift(n);
    else pending.push(n);
  }
  for (const n of pending) {
    const path = n.path ?? n.name;
    if (n.path && fileByPath.has(path)) continue;
    fileByPath.set(path, n.id);
    const degree = (idx.out.get(n.id)?.length ?? 0) + (idx.in.get(n.id)?.length ?? 0);
    const info: FileInfo = {
      id: n.id,
      path,
      dir: dirOf(path),
      name: path.split("/").pop() || n.name,
      kind: n.kind,
      loc: n.metrics?.loc ?? (n.lines ? n.lines[1] - n.lines[0] + 1 : 0),
      layer: n.layer,
      degree,
    };
    files.push(info);
    fileById.set(n.id, info);
  }
  files.sort((a, b) => a.path.localeCompare(b.path));

  // Owner file for every node.
  const owner = new Map<string, string>();
  for (const n of nodes) {
    if (fileById.has(n.id)) {
      owner.set(n.id, n.id);
      continue;
    }
    let cur = idx.parent.get(n.id);
    const seen = new Set<string>([n.id]);
    let found: string | undefined;
    while (cur && !seen.has(cur)) {
      if (fileById.has(cur)) {
        found = cur;
        break;
      }
      seen.add(cur);
      cur = idx.parent.get(cur);
    }
    if (!found && n.path && !DOMAIN_NODE_KINDS.has(n.kind) && !KNOWLEDGE_NODE_KINDS.has(n.kind)) found = fileByPath.get(n.path);
    if (found) owner.set(n.id, found);
  }

  // Layers
  const layerById = new Map<string, Layer>();
  for (const l of layers) layerById.set(l.id, l);
  const layersSorted = [...layers].sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
  const layerOf = new Map<string, string>();
  for (const l of layers) for (const id of l.nodeIds ?? []) layerOf.set(id, l.id);
  for (const n of nodes) if (n.layer && !layerOf.has(n.id)) layerOf.set(n.id, n.layer);
  // Files without a layer inherit the most common layer of their members.
  const memberLayers = new Map<string, Map<string, number>>();
  for (const [id, f] of owner) {
    if (id === f) continue;
    const l = layerOf.get(id);
    if (!l) continue;
    const m = memberLayers.get(f) ?? new Map<string, number>();
    m.set(l, (m.get(l) ?? 0) + 1);
    memberLayers.set(f, m);
  }
  for (const f of files) {
    if (!layerOf.has(f.id)) {
      const m = memberLayers.get(f.id);
      if (m) {
        const best = [...m.entries()].sort((a, b) => b[1] - a[1])[0];
        if (best) layerOf.set(f.id, best[0]);
      }
    }
    f.layer = layerOf.get(f.id);
  }

  // Directory tree
  const dirs = new Map<string, DirInfo>();
  const ensureDir = (path: string): DirInfo => {
    let d = dirs.get(path);
    if (d) return d;
    const parent = path === "" ? null : dirOf(path);
    d = { path, name: path === "" ? "/" : path.split("/").pop()!, parent, childDirs: [], files: [] };
    dirs.set(path, d);
    if (parent !== null) ensureDir(parent).childDirs.push(path);
    return d;
  };
  ensureDir("");
  for (const f of files) ensureDir(f.dir).files.push(f.id);
  for (const d of dirs.values()) d.childDirs.sort();

  // Findings
  const findingsByNode = new Map<string, Finding[]>();
  const findingsByFile = new Map<string, Finding[]>();
  const findingById = new Map<string, Finding>();
  const riskByFile = new Map<string, Severity>();
  const riskScoreByFile = new Map<string, number>();
  const findings = graph.security?.findings ?? [];
  for (const f of findings) {
    findingById.set(f.id, f);
    push(findingsByNode, f.nodeId, f);
    const file = owner.get(f.nodeId) ?? fileByPath.get(f.path);
    if (file) {
      push(findingsByFile, file, f);
      if (isActiveFinding(f)) {
        riskByFile.set(file, maxSeverity(riskByFile.get(file), f.severity)!);
        riskScoreByFile.set(file, (riskScoreByFile.get(file) ?? 0) + SEVERITY_WEIGHT[f.severity] * (f.tainted ? 1.5 : 1));
      }
    }
  }

  let staleCount = 0;
  let hasKnowledge = graph.kind === "knowledge";
  let hasDomain = false;
  for (const n of nodes) {
    if (n.stale) staleCount++;
    if (KNOWLEDGE_NODE_KINDS.has(n.kind)) hasKnowledge = true;
    if (n.kind === "domain") hasDomain = true;
  }

  return {
    graph,
    idx,
    search,
    files,
    fileById,
    fileByPath,
    owner,
    layerOf,
    layerById,
    layersSorted,
    dirs,
    findingsByNode,
    findingsByFile,
    findingById,
    riskByFile,
    riskScoreByFile,
    hasKnowledge,
    hasDomain,
    hasSecurity: !!graph.security,
    staleCount,
    totalFiles: files.length,
  };
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V) {
  const a = m.get(k);
  if (a) a.push(v);
  else m.set(k, [v]);
}

/** Max active finding severity for a node and everything it contains. */
export function nodeRisk(model: GraphModel, id: string): Severity | undefined {
  if (model.fileById.has(id)) return model.riskByFile.get(id);
  let risk: Severity | undefined;
  const stack = [id];
  const seen = new Set<string>();
  while (stack.length) {
    const cur = stack.pop()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const f of model.findingsByNode.get(cur) ?? []) if (isActiveFinding(f)) risk = maxSeverity(risk, f.severity);
    for (const c of model.idx.children.get(cur) ?? []) stack.push(c);
  }
  return risk;
}

/** All findings in a node or its descendants. */
export function findingsWithin(model: GraphModel, id: string): Finding[] {
  if (model.fileById.has(id)) return model.findingsByFile.get(id) ?? [];
  const out: Finding[] = [];
  const stack = [id];
  const seen = new Set<string>();
  while (stack.length) {
    const cur = stack.pop()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    out.push(...(model.findingsByNode.get(cur) ?? []));
    for (const c of model.idx.children.get(cur) ?? []) stack.push(c);
  }
  return out;
}

export function isUnder(path: string, dir: string): boolean {
  return dir === "" || path === dir || path.startsWith(dir + "/");
}

/** Deepest directory containing all given paths. */
export function commonDir(paths: string[]): string {
  if (!paths.length) return "";
  let parts = dirOf(paths[0]!).split("/").filter(Boolean);
  for (const p of paths.slice(1)) {
    const q = dirOf(p).split("/").filter(Boolean);
    let i = 0;
    while (i < parts.length && i < q.length && parts[i] === q[i]) i++;
    parts = parts.slice(0, i);
  }
  return parts.join("/");
}
