import { useEffect, useRef, useState } from "react";
import { getViewportForBounds } from "@xyflow/react";
import { toPng, toSvg } from "html-to-image";
import { useStore } from "../store";
import { canvasRegistry } from "../utils/canvasRegistry";
import { copyText, download } from "../utils/format";
import { toMermaid } from "../utils/mermaid";
import { IconDownload } from "./icons";
import { IconButton, cx } from "./ui";

async function exportImage(kind: "png" | "svg"): Promise<string> {
  const { element, getBounds } = canvasRegistry.get();
  const viewport = element?.querySelector<HTMLElement>(".react-flow__viewport");
  const bounds = getBounds();
  if (!viewport || !bounds) throw new Error("Nothing to export");
  const pad = 48;
  const scale = Math.min(2, 4000 / Math.max(bounds.width + pad * 2, bounds.height + pad * 2));
  const width = Math.round((bounds.width + pad * 2) * Math.max(scale, 0.25));
  const height = Math.round((bounds.height + pad * 2) * Math.max(scale, 0.25));
  const vp = getViewportForBounds(bounds, width, height, 0.02, 4, 0.08);
  const bg = getComputedStyle(document.body).backgroundColor;
  const opts = {
    backgroundColor: bg,
    width,
    height,
    style: { width: `${width}px`, height: `${height}px`, transform: `translate(${vp.x}px, ${vp.y}px) scale(${vp.zoom})` },
    filter: (node: Node) => !(node instanceof HTMLElement && node.classList.contains("react-flow__handle")),
  };
  return kind === "png" ? toPng(viewport, { ...opts, pixelRatio: 1 }) : toSvg(viewport, opts);
}

export function ExportMenu() {
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const model = useStore((s) => s.model);
  const view = useStore((s) => s.view);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const flash = (m: string) => {
    setMsg(m);
    setTimeout(() => setMsg(null), 2200);
  };
  const base = `${model?.graph.project.name || "lens"}-${view}`;

  const run = async (kind: "png" | "svg" | "json" | "mermaid") => {
    setOpen(false);
    try {
      if (kind === "json") {
        if (!model) return;
        download(`${model.graph.project.name || "lens"}.knowledge-graph.json`, JSON.stringify(model.graph, null, 2), "application/json");
        return flash("Graph JSON downloaded");
      }
      if (kind === "mermaid") {
        const vm = canvasRegistry.get().vm;
        if (!vm) throw new Error("Nothing to export");
        const text = toMermaid(vm.nodes, vm.edges);
        const copied = await copyText(text);
        download(`${base}.mmd`, text, "text/plain");
        return flash(copied ? "Mermaid copied & downloaded" : "Mermaid downloaded");
      }
      const url = await exportImage(kind);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${base}.${kind}`;
      a.click();
      flash(`${kind.toUpperCase()} exported`);
    } catch (e) {
      flash(e instanceof Error ? e.message : "Export failed");
    }
  };

  const items: Array<{ id: "png" | "svg" | "json" | "mermaid"; label: string; hint: string }> = [
    { id: "png", label: "PNG image", hint: "current canvas" },
    { id: "svg", label: "SVG image", hint: "current canvas" },
    { id: "mermaid", label: "Mermaid", hint: "copy + .mmd" },
    { id: "json", label: "Graph JSON", hint: "full graph" },
  ];
  return (
    <div className="relative" ref={ref}>
      <IconButton label="Export" aria-haspopup="menu" aria-expanded={open} active={open} onClick={() => setOpen((o) => !o)}>
        <IconDownload size={16} />
      </IconButton>
      {open && (
        <div role="menu" className="lens-rise absolute right-0 top-[calc(100%+6px)] z-50 w-52 overflow-hidden rounded-lg border border-line bg-panel py-1 shadow-[var(--shadow)]">
          <div className="eyebrow px-3 pb-1 pt-1.5">Export</div>
          {items.map((it) => (
            <button key={it.id} type="button" role="menuitem" onClick={() => void run(it.id)} className="flex w-full items-baseline justify-between px-3 py-1.5 text-left text-[12.5px] hover:bg-raised">
              {it.label}
              <span className="text-[11px] text-faint">{it.hint}</span>
            </button>
          ))}
        </div>
      )}
      <div aria-live="polite" className={cx("pointer-events-none absolute right-0 top-[calc(100%+6px)] z-50 whitespace-nowrap rounded-md border border-line bg-panel px-2.5 py-1 text-[12px] shadow-[var(--shadow)] transition-opacity", msg ? "opacity-100" : "opacity-0")}>
        {msg}
      </div>
    </div>
  );
}
