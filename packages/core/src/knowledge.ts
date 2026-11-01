/** Knowledge-base mode: a folder of markdown (Obsidian / LLM-wiki style) → article graph. */
import { promises as fs } from "node:fs";
import path from "node:path";
import posix from "node:path/posix";
import type { GraphEdge, GraphNode, KnowledgeGraph } from "./types.js";
import { SCHEMA_VERSION } from "./types.js";
import { walk } from "./walk.js";
import { parseNonCode } from "./noncode.js";

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export async function buildKnowledgeGraph(rootIn: string, opts: { exclude?: string[] } = {}): Promise<KnowledgeGraph> {
  const root = path.resolve(rootIn);
  const { files } = await walk(root, { exclude: opts.exclude });
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const titleIndex = new Map<string, string>(); // lowercased title / basename → id
  const docs: Array<{ id: string; rel: string; info: ReturnType<typeof parseNonCode> }> = [];

  for (const f of files) {
    const isMd = f.lang.id === "markdown";
    const isSource = /(^|\/)(raw|sources?|references?|papers|clippings)\//i.test(f.path);
    if (!isMd && !isSource) continue;
    const src = await fs.readFile(f.abs, "utf8").catch(() => "");
    const kind = isSource && !isMd ? "source" : isSource ? "source" : "article";
    const id = `${kind}:${f.path}`;
    const info = isMd ? parseNonCode(f.path, "markdown", src) : { children: [], refs: [], tags: [] };
    const title = info.frontmatter?.title ?? info.headings?.[0] ?? posix.basename(f.path).replace(/\.[^.]+$/, "");
    const words = src.split(/\s+/).length;
    nodes.set(id, {
      id, kind, name: title, path: f.path, lines: [1, src.split("\n").length], language: f.lang.id,
      summary: info.summary ?? title, summarySource: "heuristic",
      tags: [...new Set([...(info.frontmatter?.tags?.split(/,\s*/) ?? []).map((t) => t.replace(/^#/, "")), ...[...src.matchAll(/(?:^|\s)#([a-zA-Z][\w/-]{1,30})\b/g)].map((m) => m[1]!)])].slice(0, 12),
      complexity: words < 400 ? "simple" : words < 1500 ? "moderate" : "complex",
      metrics: { loc: src.split("\n").length },
      knowledge: { wikilinks: info.wikilinks, frontmatter: info.frontmatter, category: info.frontmatter?.category ?? info.frontmatter?.type },
    });
    titleIndex.set(title.toLowerCase(), id);
    titleIndex.set(posix.basename(f.path).replace(/\.[^.]+$/, "").toLowerCase(), id);
    titleIndex.set(f.path.replace(/\.[^.]+$/, "").toLowerCase(), id);
    docs.push({ id, rel: f.path, info });
  }

  const backlinks = new Map<string, string[]>();
  const link = (source: string, target: string, kind: GraphEdge["kind"]) => {
    if (source === target) return;
    edges.push({ source, target, kind, weight: kind === "cites" ? 0.6 : 0.5, origin: "static" });
    const s = nodes.get(source)!;
    (backlinks.get(target) ?? backlinks.set(target, []).get(target)!).push(s.name);
  };
  for (const d of docs) {
    for (const w of d.info.wikilinks ?? []) {
      const t = titleIndex.get(w.toLowerCase()) ?? titleIndex.get(w.toLowerCase().replace(/\.md$/, ""));
      if (t) link(d.id, t, nodes.get(t)!.kind === "source" ? "cites" : "links_to");
      else {
        // dangling wikilink → entity placeholder, a hallmark of wikis worth surfacing
        const eid = `entity:${slug(w)}`;
        if (!nodes.has(eid)) nodes.set(eid, { id: eid, kind: "entity", name: w, summary: `Referenced but has no page yet.`, summarySource: "heuristic", tags: ["missing-page"], complexity: "simple" });
        link(d.id, eid, "links_to");
      }
    }
    for (const l of d.info.links ?? []) {
      const target = posix.normalize(posix.join(posix.dirname(d.rel), decodeURI(l)));
      const t = [...nodes.values()].find((n) => n.path === target || n.path === target + ".md");
      if (t) link(d.id, t.id, t.kind === "source" ? "cites" : "links_to");
    }
    // topic from category or top folder
    const n = nodes.get(d.id)!;
    const topicName = n.knowledge?.category ?? (d.rel.includes("/") ? d.rel.split("/")[0] : undefined);
    if (topicName) {
      const tid = `topic:${slug(topicName)}`;
      if (!nodes.has(tid)) nodes.set(tid, { id: tid, kind: "topic", name: topicName, summary: `Topic grouping for ${topicName}.`, summarySource: "heuristic", tags: ["topic"], complexity: "simple" });
      edges.push({ source: d.id, target: tid, kind: "categorized_under", weight: 0.4, origin: "heuristic" });
    }
  }
  for (const [id, names] of backlinks) {
    const n = nodes.get(id);
    if (n) n.knowledge = { ...n.knowledge, backlinks: [...new Set(names)] };
  }
  // topic summaries with member counts
  for (const n of nodes.values()) {
    if (n.kind !== "topic") continue;
    const members = edges.filter((e) => e.target === n.id).length;
    n.summary = `${members} pages under ${n.name}.`;
  }
  const nodeList = [...nodes.values()];
  const readme = nodeList.find((n) => /(^|\/)(index|readme|home)\.md$/i.test(n.path ?? ""));
  const hubs = nodeList.filter((n) => n.kind === "article").sort((a, b) => (b.knowledge?.backlinks?.length ?? 0) - (a.knowledge?.backlinks?.length ?? 0));
  const topics = nodeList.filter((n) => n.kind === "topic");
  return {
    schema: SCHEMA_VERSION,
    kind: "knowledge",
    project: { name: path.basename(root), description: readme?.summary ?? "", languages: ["markdown"], frameworks: [], analyzedAt: new Date().toISOString() },
    nodes: nodeList,
    edges,
    layers: topics.map((t, i) => ({ id: slug(t.name) || `t${i}`, name: t.name, description: t.summary, rank: i, nodeIds: edges.filter((e) => e.target === t.id).map((e) => e.source) })),
    tour: [
      ...(readme ? [{ order: 1, title: "Start here", description: "The index page.", nodeIds: [readme.id] }] : []),
      { order: 2, title: "Most linked pages", description: "Hubs that the rest of the wiki points to.", nodeIds: hubs.slice(0, 5).map((n) => n.id) },
      ...(topics.length ? [{ order: 3, title: "Topics", description: "How the knowledge base is organized.", nodeIds: topics.slice(0, 6).map((n) => n.id) }] : []),
    ].filter((s) => s.nodeIds.length).map((s, i) => ({ ...s, order: i + 1 })),
    stats: {
      files: docs.length, nodes: nodeList.length, edges: edges.length, loc: nodeList.reduce((a, n) => a + (n.metrics?.loc ?? 0), 0),
      byKind: nodeList.reduce<Record<string, number>>((a, n) => ((a[n.kind] = (a[n.kind] ?? 0) + 1), a), {}), enrichedNodes: 0,
    },
  };
}
