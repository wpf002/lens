import { useMemo } from "react";
import { dirOf } from "@lens/core/browser";
import { GraphCanvas } from "../components/GraphCanvas";
import { IconChevronRight, IconGrid, IconTree } from "../components/icons";
import { cx } from "../components/ui";
import { useStore } from "../store";
import type { VNode } from "../types";
import { buildStructure } from "../utils/aggregate";
import { plural } from "../utils/format";
import { useCompiledFilters, useModel, useOverlayInput } from "./hooks";

export function StructureView() {
  const model = useModel();
  const cf = useCompiledFilters();
  const dir = useStore((s) => s.structureDir);
  const flat = useStore((s) => s.structureFlat);
  const expanded = useStore((s) => s.expanded);
  const setDir = useStore((s) => s.setDir);
  const setFlat = useStore((s) => s.setFlat);
  const overlay = useOverlayInput();

  const vm = useMemo(() => buildStructure(model, cf, { dir, flat, expanded: new Set(expanded) }), [model, cf, dir, flat, expanded]);
  const crumbs = dir ? dir.split("/") : [];

  const onDouble = (v: VNode) => {
    if (v.type === "folder" && v.dir !== undefined) setDir(v.dir);
    else if (v.type === "external") setDir(dirOf(dir));
    else if (v.type === "file" && v.graphId) useStore.getState().toggleExpanded(v.graphId);
  };

  return (
    <div className="relative h-full w-full">
      <GraphCanvas vm={vm} overlay={overlay} onNodeDoubleClick={onDouble} fitKey={`${flat}:${dir}`} wrap />
      <div className="pointer-events-none absolute inset-x-3 top-3 z-10 flex flex-wrap items-start gap-2">
        <div className="pointer-events-auto flex h-8 items-center rounded-md border border-line bg-panel p-0.5" role="group" aria-label="Structure mode">
          <button
            type="button"
            className={cx("inline-flex h-7 items-center gap-1.5 rounded px-2 text-[12px]", !flat ? "bg-raised text-fg" : "text-muted hover:text-fg")}
            aria-pressed={!flat}
            onClick={() => setFlat(false)}
          >
            <IconTree size={14} /> Drill-Down
          </button>
          <button
            type="button"
            className={cx("inline-flex h-7 items-center gap-1.5 rounded px-2 text-[12px]", flat ? "bg-raised text-fg" : "text-muted hover:text-fg")}
            aria-pressed={flat}
            onClick={() => setFlat(true)}
          >
            <IconGrid size={14} /> All Files
          </button>
        </div>
        {!flat && (
          <nav aria-label="Directory" className="pointer-events-auto flex h-8 min-w-0 max-w-full items-center overflow-x-auto rounded-md border border-line bg-panel px-1 font-mono text-[12px]">
            <button type="button" className={cx("shrink-0 rounded px-1.5 py-0.5 hover:bg-raised", dir ? "text-muted" : "text-fg")} onClick={() => setDir("")}>
              {model.graph.project.name || "root"}
            </button>
            {crumbs.map((c, i) => {
              const path = crumbs.slice(0, i + 1).join("/");
              const last = i === crumbs.length - 1;
              return (
                <span key={path} className="flex shrink-0 items-center">
                  <IconChevronRight size={12} className="text-faint" />
                  <button type="button" className={cx("rounded px-1.5 py-0.5 hover:bg-raised", last ? "text-fg" : "text-muted")} aria-current={last ? "page" : undefined} onClick={() => setDir(path)}>
                    {c}
                  </button>
                </span>
              );
            })}
          </nav>
        )}
        {!!vm.truncated && (
          <span className="pointer-events-auto rounded-md border border-line bg-panel px-2 py-1.5 text-[11.5px] text-muted">
            Showing the top {plural(vm.nodes.filter((n) => n.type === "file").length, "file")}; {vm.truncated} more collapsed
          </span>
        )}
      </div>
    </div>
  );
}
