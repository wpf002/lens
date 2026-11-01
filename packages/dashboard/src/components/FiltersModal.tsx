import { useMemo, type ReactNode } from "react";
import type { Complexity, EdgeKind, NodeKind } from "@lens/core/browser";
import { useStore } from "../store";
import { layerColor } from "../utils/colors";
import { activeFilterCount } from "../utils/filters";
import { useModel } from "../views/hooks";
import { Button, Modal, cx } from "./ui";

/** "tested_by" -> "Tested By" */
const title = (s: string) => s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

function Toggle({ on, onClick, children, count, color }: { on: boolean; onClick: () => void; children: ReactNode; count?: number; color?: string }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={on}
      onClick={onClick}
      className={cx(
        "inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-[12px] transition-colors",
        on ? "border-line-strong bg-raised text-fg" : "border-line text-faint line-through decoration-faint/60 hover:text-muted",
      )}
    >
      {color && <span className={cx("h-2 w-2 rounded-sm", !on && "opacity-40")} style={{ background: color }} />}
      {children}
      {count !== undefined && <span className="font-mono text-[10.5px] text-muted tabular">{count}</span>}
    </button>
  );
}

function Switch({ on, onChange, label, hint }: { on: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="flex cursor-pointer items-start gap-3 py-1">
      <button
        type="button"
        role="switch"
        aria-checked={on}
        onClick={() => onChange(!on)}
        className={cx("relative mt-0.5 h-[18px] w-8 shrink-0 rounded-full border transition-colors", on ? "border-accent bg-accent" : "border-line-strong bg-raised")}
      >
        <span className={cx("absolute top-[2px] h-3 w-3 rounded-full transition-all", on ? "left-[16px] bg-accent-fg" : "left-[2px] bg-muted")} />
      </button>
      <span>
        <span className="block text-[12.5px]">{label}</span>
        {hint && <span className="block text-[11.5px] text-muted">{hint}</span>}
      </span>
    </label>
  );
}

export function FiltersModal() {
  const model = useModel();
  const filters = useStore((s) => s.filters);
  const setFilters = useStore((s) => s.setFilters);
  const reset = useStore((s) => s.resetFilters);
  const close = () => useStore.getState().setModal(null);

  const nodeKinds = useMemo(() => {
    const m = new Map<NodeKind, number>();
    for (const n of model.graph.nodes) m.set(n.kind, (m.get(n.kind) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [model]);
  const edgeKinds = useMemo(() => {
    const m = new Map<EdgeKind, number>();
    for (const e of model.graph.edges) if (e.kind !== "contains") m.set(e.kind, (m.get(e.kind) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [model]);

  const flip = <T,>(list: T[], v: T): T[] => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const n = activeFilterCount(filters);

  return (
    <Modal
      title="Filters"
      onClose={close}
      wide
      footer={
        <>
          <span className="mr-auto text-[12px] text-muted">{n ? `${n} active` : "Showing everything"}</span>
          <Button variant="ghost" onClick={reset} disabled={!n}>
            Reset
          </Button>
          <Button variant="accent" onClick={close}>
            Done
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <div className="space-y-1">
          <Switch on={filters.hideTests} onChange={(v) => setFilters({ hideTests: v })} label="Hide Tests" hint="Test files, specs and the test layer." />
          <Switch on={filters.onlyFindings} onChange={(v) => setFilters({ onlyFindings: v })} label="Only Nodes with Findings" hint="Keep files and symbols that contain security findings." />
        </div>
        <fieldset>
          <legend className="eyebrow mb-2">Node kinds</legend>
          <div className="flex flex-wrap gap-1.5">
            {nodeKinds.map(([k, c]) => (
              <Toggle key={k} on={!filters.hiddenNodeKinds.includes(k)} onClick={() => setFilters({ hiddenNodeKinds: flip(filters.hiddenNodeKinds, k) })} count={c}>
                {title(k)}
              </Toggle>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend className="eyebrow mb-2">Edge kinds</legend>
          <div className="flex flex-wrap gap-1.5">
            {edgeKinds.map(([k, c]) => (
              <Toggle key={k} on={!filters.hiddenEdgeKinds.includes(k)} onClick={() => setFilters({ hiddenEdgeKinds: flip(filters.hiddenEdgeKinds, k) })} count={c}>
                {title(k)}
              </Toggle>
            ))}
          </div>
        </fieldset>
        {model.layersSorted.length > 0 && (
          <fieldset>
            <legend className="eyebrow mb-2">Layers</legend>
            <div className="flex flex-wrap gap-1.5">
              {model.layersSorted.map((l) => (
                <Toggle key={l.id} on={!filters.hiddenLayers.includes(l.id)} onClick={() => setFilters({ hiddenLayers: flip(filters.hiddenLayers, l.id) })} color={layerColor(l)}>
                  {l.name}
                </Toggle>
              ))}
            </div>
          </fieldset>
        )}
        <fieldset>
          <legend className="eyebrow mb-2">Complexity</legend>
          <div className="flex flex-wrap gap-1.5">
            {(["simple", "moderate", "complex"] as Complexity[]).map((c) => (
              <Toggle key={c} on={!filters.hiddenComplexity.includes(c)} onClick={() => setFilters({ hiddenComplexity: flip(filters.hiddenComplexity, c) })}>
                {title(c)}
              </Toggle>
            ))}
          </div>
        </fieldset>
      </div>
    </Modal>
  );
}
