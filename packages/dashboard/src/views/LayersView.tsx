import { useMemo, useState } from "react";
import { GraphCanvas } from "../components/GraphCanvas";
import { IconChevronDown, IconChevronUp } from "../components/icons";
import { cx } from "../components/ui";
import { useStore } from "../store";
import type { VNode } from "../types";
import { buildLayers, layerColumns, visibleFiles } from "../utils/aggregate";
import { useCompiledFilters, useModel, useOverlayInput } from "./hooks";

export function LayersView() {
  const model = useModel();
  const cf = useCompiledFilters();
  const selectedId = useStore((s) => s.selectedId);
  const isolate = useStore((s) => s.layerIsolate);
  const setIsolate = useStore((s) => s.setLayerIsolate);
  const requestFocus = useStore((s) => s.requestFocus);
  const [legendOpen, setLegendOpen] = useState(() => window.innerWidth >= 640);

  // Only the selected file's own edges depend on selection; keep that cheap.
  const selOwner = selectedId ? model.owner.get(selectedId) ?? null : null;
  const vm = useMemo(() => buildLayers(model, cf, { selectedId: selOwner }), [model, cf, selOwner]);
  const cols = useMemo(() => layerColumns(model, visibleFiles(model, cf), new Set(cf.raw.hiddenLayers)), [model, cf]);

  const focusV = useMemo(() => {
    if (isolate === null) return null;
    const s = new Set<string>([`lh:${isolate}`, `more:${isolate}`]);
    for (const n of vm.nodes) if (n.type === "file" && n.graphId && (model.fileById.get(n.graphId)?.layer ?? "") === isolate) s.add(n.id);
    return s;
  }, [isolate, vm, model]);
  const overlay = useOverlayInput(focusV);

  const isolateLayer = (id: string) => {
    setIsolate(id);
    const next = useStore.getState().layerIsolate;
    if (next !== null) {
      const ids = vm.nodes.filter((n) => n.type === "file" && (model.fileById.get(n.graphId ?? "")?.layer ?? "") === next).map((n) => n.graphId!);
      if (ids.length) requestFocus(ids);
    }
  };

  const onClick = (v: VNode) => {
    if (v.type === "layerHeader" && v.dir !== undefined) {
      isolateLayer(v.dir);
      return true;
    }
    return false;
  };

  const max = Math.max(1, ...cols.map((c) => c.total));
  return (
    <div className="relative h-full w-full">
      <GraphCanvas vm={vm} overlay={overlay} onNodeClick={onClick} fitKey="layers" />
      <div className="absolute right-3 top-3 z-10 w-[236px] max-w-[calc(100%-24px)] rounded-lg border border-line bg-panel shadow-[var(--shadow)]">
        <button type="button" className="flex w-full items-center justify-between px-3 py-2" onClick={() => setLegendOpen((o) => !o)} aria-expanded={legendOpen}>
          <span className="eyebrow">Layers</span>
          <span className="flex items-center gap-2 text-[11px] text-muted">
            {isolate !== null && <span className="text-accent">isolated</span>}
            {legendOpen ? <IconChevronUp size={14} /> : <IconChevronDown size={14} />}
          </span>
        </button>
        {legendOpen && (
          <ul className="max-h-[50vh] overflow-auto px-1.5 pb-2">
            {cols.map((c) => {
              const active = isolate === c.id;
              return (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => isolateLayer(c.id)}
                    aria-pressed={active}
                    className={cx("group flex w-full items-center gap-2 rounded px-1.5 py-1 text-left hover:bg-raised", active && "bg-accent-soft", isolate !== null && !active && "opacity-50")}
                  >
                    <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: c.color }} />
                    <span className="min-w-0 flex-1 truncate text-[12px]">{c.name}</span>
                    <span className="h-1 w-12 overflow-hidden rounded-full bg-raised">
                      <span className="block h-full rounded-full" style={{ width: `${(c.total / max) * 100}%`, background: c.color }} />
                    </span>
                    <span className="w-6 text-right font-mono text-[11px] text-muted tabular">{c.total}</span>
                  </button>
                </li>
              );
            })}
            <li className="mt-1.5 flex items-center gap-2 border-t border-line px-1.5 pt-2 text-[10.5px] text-muted">
              <svg width="26" height="8" aria-hidden><path d="M1 4h24" stroke="color-mix(in srgb, var(--sev-high) 60%, var(--edge))" strokeWidth="1.6" strokeDasharray="4 3" /></svg>
              dependency against layer order
            </li>
          </ul>
        )}
      </div>
    </div>
  );
}
