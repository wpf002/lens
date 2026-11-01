import type { VEdge, VNode } from "../types";

function esc(s: string): string {
  return s.replace(/"/g, "#quot;").replace(/[<>]/g, (c) => (c === "<" ? "#lt;" : "#gt;")).replace(/[\r\n]+/g, " ");
}

function shape(n: VNode, id: string): string {
  const label = esc(n.type === "folder" ? `${n.label}/` : n.type === "entry" && n.method ? `${n.method} ${n.label}` : n.label);
  switch (n.type) {
    case "folder":
      return `${id}[["${label}"]]`;
    case "entry":
      return `${id}>"${label}"]`;
    case "sink":
      return `${id}{{"${label}"}}`;
    case "domain":
      return `${id}(["${label}"])`;
    case "knode":
      return `${id}(("${label}"))`;
    case "symbol":
    case "step":
      return `${id}("${label}")`;
    default:
      return `${id}["${label}"]`;
  }
}

/** Mermaid flowchart of the currently visible view nodes/edges. Groups become subgraphs. */
export function toMermaid(nodes: VNode[], edges: VEdge[], direction: "LR" | "TB" = "LR"): string {
  const ids = new Map<string, string>();
  nodes.forEach((n, i) => ids.set(n.id, `n${i}`));
  const kids = new Map<string, VNode[]>();
  const roots: VNode[] = [];
  for (const n of nodes) {
    if (n.type === "label") continue;
    if (n.parent && ids.has(n.parent)) (kids.get(n.parent) ?? kids.set(n.parent, []).get(n.parent)!).push(n);
    else roots.push(n);
  }
  const lines = [`flowchart ${direction}`];
  const emit = (n: VNode, depth: number) => {
    const pad = "  ".repeat(depth);
    const id = ids.get(n.id)!;
    const children = kids.get(n.id);
    if (children?.length) {
      lines.push(`${pad}subgraph ${id}["${esc(n.label)}"]`);
      for (const c of children) emit(c, depth + 1);
      lines.push(`${pad}end`);
    } else if (n.type !== "layerHeader") {
      lines.push(pad + shape(n, id));
    } else {
      lines.push(`${pad}${id}[/"${esc(n.label)}"/]`);
    }
  };
  for (const r of roots) emit(r, 1);
  for (const e of edges) {
    const s = ids.get(e.source);
    const t = ids.get(e.target);
    if (!s || !t) continue;
    const label = e.label ?? (e.count > 1 ? `${e.kinds[0] ?? ""} ×${e.count}` : e.kinds[0] ?? "");
    lines.push(label ? `  ${s} -->|"${esc(label)}"| ${t}` : `  ${s} --> ${t}`);
  }
  return lines.join("\n") + "\n";
}
