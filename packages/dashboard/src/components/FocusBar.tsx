import { useStore } from "../store";
import { useModel } from "../views/hooks";
import { IconX } from "./icons";

/** Floating status pill that explains the current spotlight and lets the user clear it. */
export function FocusBar() {
  const model = useModel();
  const path = useStore((s) => s.pathState.path);
  const finding = useStore((s) => s.selectedFinding);
  const tour = useStore((s) => s.tour);
  const search = useStore((s) => s.searchHighlight);
  const diffOn = useStore((s) => s.diffOn);
  const diff = useStore((s) => s.diff);

  let text: string | null = null;
  let clear: (() => void) | null = null;
  if (path?.length) {
    text = `Path · ${path.length - 1} hop${path.length === 2 ? "" : "s"}: ${model.idx.nodes.get(path[0]!)?.name ?? ""} → ${model.idx.nodes.get(path[path.length - 1]!)?.name ?? ""}`;
    clear = () => useStore.getState().clearPath();
  } else if (finding) {
    const f = model.findingById.get(finding);
    text = `Exposure path · ${f?.title ?? finding}`;
    clear = () => useStore.getState().selectFinding(null);
  } else if (tour.active) {
    const s = model.graph.tour[tour.index];
    text = `Tour ${tour.index + 1}/${model.graph.tour.length} · ${s?.title ?? ""}`;
    clear = () => useStore.getState().stopTour();
  } else if (search) {
    text = `Highlighting ${search.ids.length} results for “${search.query}”`;
    clear = () => useStore.getState().setSearchHighlight(null);
  } else if (diffOn && diff) {
    text = `Diff impact · ${diff.changed.length} changed, ${diff.impacted.length} impacted`;
    clear = () => void useStore.getState().toggleDiff(false);
  }
  if (!text || !clear) return null;
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-3 z-10 flex justify-center px-14">
      <div className="lens-rise pointer-events-auto flex min-w-0 max-w-full items-center gap-2 rounded-full border border-accent/60 bg-panel py-1 pl-3 pr-1 text-[12px] shadow-[var(--shadow)]">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
        <span className="min-w-0 truncate">{text}</span>
        <button type="button" onClick={clear} aria-label="Clear highlight" className="rounded-full p-1 text-muted hover:bg-raised hover:text-fg">
          <IconX size={12} />
        </button>
      </div>
    </div>
  );
}
