import { useStore, type SidebarTab } from "../store";
import { IconX } from "./icons";
import { cx, IconButton } from "./ui";
import { DiffPanel } from "./sidebar/DiffPanel";
import { FilesPanel } from "./sidebar/FilesPanel";
import { NodePanel } from "./sidebar/NodePanel";
import { OverviewPanel } from "./sidebar/OverviewPanel";
import { TourPanel } from "./sidebar/TourPanel";

export function Sidebar({ narrow }: { narrow: boolean }) {
  const open = useStore((s) => s.sidebarOpen);
  const tab = useStore((s) => s.sidebarTab);
  const setTab = useStore((s) => s.setSidebarTab);
  const setSidebar = useStore((s) => s.setSidebar);
  const selectedId = useStore((s) => s.selectedId);
  const diffOn = useStore((s) => s.diffOn);

  const tabs: Array<{ id: SidebarTab; label: string; hidden?: boolean }> = [
    { id: "overview", label: "Overview" },
    { id: "node", label: "Node", hidden: !selectedId },
    { id: "tour", label: "Tour" },
    { id: "files", label: "Files" },
    { id: "diff", label: "Diff", hidden: !diffOn },
  ];
  const current = tabs.find((t) => t.id === tab && !t.hidden) ? tab : "overview";

  if (!open) return null;
  return (
    <aside
      aria-label="Details"
      className={cx(
        "z-30 flex flex-col bg-panel",
        narrow
          ? "lens-rise fixed inset-x-0 bottom-0 h-[62vh] rounded-t-2xl border-t border-line shadow-[var(--shadow)]"
          : "relative w-[380px] shrink-0 border-l border-line",
      )}
    >
      {narrow && <div aria-hidden className="mx-auto mt-2 h-1 w-10 rounded-full bg-line-strong" />}
      <div className="flex h-10 shrink-0 items-center gap-0.5 border-b border-line px-2" role="tablist" aria-label="Sidebar">
        {tabs
          .filter((t) => !t.hidden)
          .map((t) => (
            <button
              key={t.id}
              role="tab"
              type="button"
              aria-selected={current === t.id}
              onClick={() => setTab(t.id)}
              className={cx(
                "relative h-10 px-2.5 text-[12.5px] transition-colors",
                current === t.id ? "text-fg after:absolute after:inset-x-2 after:-bottom-px after:h-[2px] after:rounded-full after:bg-accent" : "text-muted hover:text-fg",
              )}
            >
              {t.label}
            </button>
          ))}
        <IconButton label="Close panel" className="ml-auto" onClick={() => setSidebar(false)}>
          <IconX size={15} />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden" role="tabpanel">
        {current === "overview" && <OverviewPanel />}
        {current === "node" && <NodePanel />}
        {current === "tour" && <TourPanel />}
        {current === "files" && <FilesPanel />}
        {current === "diff" && <DiffPanel />}
      </div>
    </aside>
  );
}
