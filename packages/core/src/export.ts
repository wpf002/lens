/** Graph exports: Mermaid, Graphviz DOT, markdown onboarding guide, static HTML embedding. */
import type { GraphNode, KnowledgeGraph, ImpactReport } from "./types.js";
import { fileRank, isFileKind } from "./heuristics.js";

const esc = (s: string) => s.replace(/["[\]{}()<>|]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);

function pickFiles(g: KnowledgeGraph, max: number): GraphNode[] {
  const rank = fileRank(g);
  return g.nodes.filter(isFileKind).sort((a, b) => (rank.get(b.id) ?? 0) - (rank.get(a.id) ?? 0)).slice(0, max);
}

/** File-level dependency flowchart, grouped by layer. */
export function toMermaid(g: KnowledgeGraph, max = 80): string {
  const files = pickFiles(g, max);
  const ids = new Map(files.map((f, i) => [f.id, `n${i}`]));
  const lines = ["flowchart LR"];
  const byLayer = new Map<string, GraphNode[]>();
  for (const f of files) (byLayer.get(f.layer ?? "other") ?? byLayer.set(f.layer ?? "other", []).get(f.layer ?? "other")!).push(f);
  for (const [layer, fs] of byLayer) {
    const L = g.layers.find((x) => x.id === layer);
    lines.push(`  subgraph ${layer.replace(/\W/g, "_")}["${esc(L?.name ?? layer)}"]`);
    for (const f of fs) lines.push(`    ${ids.get(f.id)}["${esc(f.name)}"]`);
    lines.push("  end");
  }
  const seen = new Set<string>();
  for (const e of g.edges) {
    const a = ids.get(e.source);
    const b = ids.get(e.target);
    if (!a || !b || a === b || e.kind === "contains") continue;
    const k = `${a}-${b}`;
    if (seen.has(k)) continue;
    seen.add(k);
    lines.push(`  ${a} -->${e.kind === "imports" ? "" : `|${e.kind}|`} ${b}`);
  }
  return lines.join("\n") + "\n";
}

export function toDot(g: KnowledgeGraph, max = 300): string {
  const files = pickFiles(g, max);
  const keep = new Set(files.map((f) => f.id));
  const q = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  const lines = ["digraph lens {", "  rankdir=LR; node [shape=box, fontname=Helvetica, fontsize=10];"];
  for (const L of g.layers) {
    const members = L.nodeIds.filter((id) => keep.has(id));
    if (!members.length) continue;
    lines.push(`  subgraph ${q("cluster_" + L.id)} { label=${q(L.name)}; color=${q(L.color ?? "#999999")};`);
    for (const id of members) lines.push(`    ${q(id)} [label=${q(g.nodes.find((n) => n.id === id)!.name)}];`);
    lines.push("  }");
  }
  for (const e of g.edges) if (keep.has(e.source) && keep.has(e.target) && e.kind !== "contains" && e.source !== e.target) lines.push(`  ${q(e.source)} -> ${q(e.target)} [label=${q(e.kind === "imports" ? "" : e.kind)}];`);
  lines.push("}");
  return lines.join("\n") + "\n";
}

/** Replace the dashboard's `<!--LENS_DATA-->` marker with inline data. JSON is escaped against `</script>` breakout. */
export function embedInDashboard(html: string, data: { graph?: KnowledgeGraph; diff?: ImpactReport; config?: Record<string, unknown> }): string {
  const safe = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c").replace(/[\u2028\u2029]/g, (c) => (c === "\u2028" ? "\\u2028" : "\\u2029"));
  const parts: string[] = [];
  if (data.graph) parts.push(`window.__LENS_GRAPH__=${safe(data.graph)};`);
  if (data.diff) parts.push(`window.__LENS_DIFF__=${safe(data.diff)};`);
  if (data.config) parts.push(`window.__LENS_CONFIG__=${safe(data.config)};`);
  const tag = parts.length ? `<script>${parts.join("")}</script>` : "";
  if (!html.includes("<!--LENS_DATA-->")) throw new Error("Dashboard build is missing the <!--LENS_DATA--> marker.");
  return html.replace("<!--LENS_DATA-->", () => tag);
}

/** Deterministic onboarding guide; the /lens-onboard skill polishes it. */
export function onboardingMarkdown(g: KnowledgeGraph): string {
  const out: string[] = [];
  const p = g.project;
  out.push(`# Onboarding: ${p.name}`, "");
  if (p.description) out.push(p.description, "");
  out.push(`**Languages:** ${p.languages.join(", ") || "n/a"}  `, `**Frameworks:** ${p.frameworks.join(", ") || "n/a"}  `, `**Size:** ${g.stats.files} files, ${g.stats.loc.toLocaleString("en-US")} lines, ${g.stats.nodes} graph nodes`, "");
  out.push("## Architecture", "");
  for (const L of [...g.layers].sort((a, b) => a.rank - b.rank)) {
    out.push(`### ${L.name} (${L.nodeIds.length} files)`, "", L.description, "");
    const rank = fileRank(g);
    const top = L.nodeIds.map((id) => g.nodes.find((n) => n.id === id)!).filter(Boolean).sort((a, b) => (rank.get(b.id) ?? 0) - (rank.get(a.id) ?? 0)).slice(0, 5);
    for (const n of top) out.push(`- \`${n.path}\`: ${n.summary.split(/(?<=\.)\s/)[0]}`);
    out.push("");
  }
  if (g.tour.length) {
    out.push("## Guided reading order", "");
    for (const s of g.tour) {
      out.push(`${s.order}. **${s.title}**: ${s.description}`);
      for (const id of s.nodeIds) {
        const n = g.nodes.find((x) => x.id === id);
        if (n) out.push(`   - \`${n.path ?? n.name}\``);
      }
    }
    out.push("");
  }
  const endpoints = g.nodes.filter((n) => n.kind === "endpoint" && n.endpoint?.entryType !== "cli");
  if (endpoints.length) {
    out.push("## API surface", "", "| Route | Auth | Location |", "|---|---|---|");
    for (const e of endpoints.slice(0, 60)) out.push(`| \`${e.name}\` | ${e.endpoint?.auth} | \`${e.path}:${e.lines?.[0]}\` |`);
    out.push("");
  }
  const sec = g.security;
  if (sec?.findings.length) {
    const open = sec.findings.filter((f) => f.status === "open" || f.status === "confirmed");
    out.push("## Security notes", "", `Risk score ${sec.summary.riskScore}/100. ${open.length} open findings.`, "");
    for (const f of open.filter((f) => f.severity === "critical" || f.severity === "high").slice(0, 10)) out.push(`- **${f.severity}** ${f.title} at \`${f.path}:${f.line}\``);
    out.push("");
  }
  const hot = g.nodes.filter((n) => n.kind === "function" && n.complexity === "complex").sort((a, b) => (b.metrics?.fanIn ?? 0) - (a.metrics?.fanIn ?? 0)).slice(0, 8);
  if (hot.length) {
    out.push("## Complex, heavily used code", "", "Read these carefully before changing them.", "");
    for (const n of hot) out.push(`- \`${n.name}\` in \`${n.path}:${n.lines?.[0]}\` (called from ${n.metrics?.fanIn} places)`);
    out.push("");
  }
  out.push("---", `Generated by Lens from \`.lens/knowledge-graph.json\` at ${p.analyzedAt}${p.gitCommit ? ` (commit ${p.gitCommit.slice(0, 8)})` : ""}.`);
  return out.join("\n") + "\n";
}
