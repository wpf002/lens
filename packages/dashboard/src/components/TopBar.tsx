import { useStore } from "../store";
import { VIEW_GROUPS, VIEW_LABEL, VIEW_ORDER, type ViewId } from "../types";
import { useMemo } from "react";
import { activeFilterCount } from "../utils/filters";
import { appliedFixItemIds, urgentOpenCount } from "../utils/security";
import { useModel } from "../views/hooks";
import { ExportMenu } from "./ExportMenu";
import { IconDiff, IconFilter, IconHelp, IconLayers, IconFolder, IconMenu, IconRoute, IconX, LensMark } from "./icons";
import { SearchBox } from "./SearchBox";
import { Button, IconButton, cx } from "./ui";

export function useVisibleViews(): ViewId[] {
  const model = useModel();
  return VIEW_ORDER.filter((v) => v !== "knowledge" || model.hasKnowledge);
}

function ViewTabs({ vertical }: { vertical?: boolean }) {
  const model = useModel();
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const views = useVisibleViews();
  const auditFixes = useStore((s) => s.remediation.audit);
  const hot = useMemo(() => urgentOpenCount(model.graph.security?.findings ?? [], appliedFixItemIds(auditFixes)), [model, auditFixes]);
  return (
    <div className={cx("flex", vertical ? "flex-col gap-3" : "items-center gap-2")}>
      {VIEW_GROUPS.map((group) => {
        const shown = group.views.filter((v) => views.includes(v));
        return (
          <div key={group.label} role="tablist" aria-label={group.label} className={cx("flex", vertical ? "flex-col gap-0.5" : "h-8 items-center gap-0.5 rounded-md border border-line bg-panel-2 p-0.5")}>
            <span aria-hidden className={vertical ? "eyebrow mb-1 px-3" : "hidden border-r border-line pl-2 pr-2.5 text-[11.5px] font-medium leading-5 text-muted 2xl:block"}>
              {group.label}
            </span>
            {shown.map((v) => {
              const active = view === v;
              return (
                <button
                  key={v}
                  role="tab"
                  type="button"
                  aria-selected={active}
                  onClick={() => setView(v)}
                  title={`${VIEW_LABEL[v]} (${VIEW_ORDER.indexOf(v) + 1})`}
                  className={cx(
                    "relative inline-flex items-center gap-1.5 rounded text-[12.5px] transition-colors",
                    vertical ? "h-9 w-full px-3 text-left" : "h-7 px-2.5",
                    active ? "bg-raised text-fg shadow-[inset_0_0_0_1px_var(--border-strong)]" : "text-muted hover:text-fg",
                  )}
                >
                  {VIEW_LABEL[v]}
                  {v === "security" && hot > 0 && (
                    <span className="rounded-full px-1.5 font-mono text-[10px] leading-[15px]" style={{ color: "var(--sev-critical)", background: "color-mix(in srgb, var(--sev-critical) 16%, transparent)" }}>
                      {hot}
                    </span>
                  )}
                  {vertical && <span className="ml-auto font-mono text-[10.5px] text-faint">{VIEW_ORDER.indexOf(v) + 1}</span>}
                </button>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

function Actions({ inMenu }: { inMenu?: boolean }) {
  const diffOn = useStore((s) => s.diffOn);
  const toggleDiff = useStore((s) => s.toggleDiff);
  const meta = useStore((s) => s.meta);
  const mode = useStore((s) => s.mode);
  const diffAvailable = mode === "dev" || !!meta?.git || !!useStore.getState().diff;
  const filters = useStore((s) => s.filters);
  const setModal = useStore((s) => s.setModal);
  const openPath = useStore((s) => s.openPathFinder);
  const canOpen = mode === "server";
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const setSidebar = useStore((s) => s.setSidebar);
  const nf = activeFilterCount(filters);

  if (inMenu) {
    const row = "flex h-10 w-full items-center gap-2.5 rounded-md px-3 text-left text-[13px] hover:bg-raised";
    return (
      <div className="flex flex-col gap-0.5">
        {diffAvailable && (
          <button type="button" className={cx(row, diffOn && "text-accent")} onClick={() => void toggleDiff()} aria-pressed={diffOn}>
            <IconDiff size={16} /> Diff Impact {diffOn ? "On" : "Off"}
          </button>
        )}
        <button type="button" className={row} onClick={() => setModal("filters")}>
          <IconFilter size={16} /> Filters {nf > 0 && <span className="text-accent">({nf})</span>}
        </button>
        <button type="button" className={row} onClick={() => openPath()}>
          <IconRoute size={16} /> Path Finder
        </button>
        <button type="button" className={row} onClick={() => setSidebar(!sidebarOpen)}>
          <IconLayers size={16} /> {sidebarOpen ? "Hide" : "Show"} Details Panel
        </button>
        {canOpen && (
          <button type="button" className={row} onClick={() => setModal("project")}>
            <IconFolder size={16} /> Open Project
          </button>
        )}
        <button type="button" className={row} onClick={() => setModal("help")}>
          <IconHelp size={16} /> Keyboard Shortcuts
        </button>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-0.5">
      {diffAvailable && (
        <Button size="sm" variant="outline" active={diffOn} onClick={() => void toggleDiff()} aria-pressed={diffOn} title="Overlay the impact of current changes">
          <IconDiff size={14} /> Diff
        </Button>
      )}
      <IconButton label={nf ? `Filters (${nf} active)` : "Filters"} active={nf > 0} onClick={() => setModal("filters")} className="relative ml-1">
        <IconFilter size={16} />
        {nf > 0 && <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-accent" />}
      </IconButton>
      <IconButton label="Path Finder" onClick={() => openPath()}>
        <IconRoute size={16} />
      </IconButton>
      <ExportMenu />
      {canOpen && (
        <Button size="sm" variant="outline" className="ml-1" onClick={() => setModal("project")} title="Look at a different folder on this computer">
          <IconFolder size={14} /> Open Project
        </Button>
      )}
      <IconButton label="Keyboard Shortcuts (?)" onClick={() => setModal("help")}>
        <IconHelp size={16} />
      </IconButton>
      <IconButton label={sidebarOpen ? "Hide Details Panel" : "Show Details Panel"} active={sidebarOpen} onClick={() => setSidebar(!sidebarOpen)}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden>
          <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
          <path d="M14.5 4.5v15" />
        </svg>
      </IconButton>
    </div>
  );
}

function Brand() {
  const model = useModel();
  return (
    <div className="flex min-w-0 shrink items-center gap-2">
      <LensMark size={20} />
      <span className="font-serif text-[18px] tracking-tight text-fg">Lens</span>
      <span aria-hidden className="h-4 w-px bg-line" />
      <span className="min-w-0 truncate font-mono text-[12px] text-muted" title={model.graph.project.description}>
        {model.graph.project.name}
      </span>
    </div>
  );
}

export function TopBar({ compact }: { compact: boolean }) {
  const menuOpen = useStore((s) => s.menuOpen);
  const setMenu = useStore((s) => s.setMenu);
  if (compact) {
    return (
      <>
        <header className="relative z-40 flex h-12 shrink-0 items-center gap-2 border-b border-line bg-panel px-3">
          <div className="flex shrink-0 items-center gap-1.5">
            <LensMark size={18} />
            <span className="font-serif text-[16px]">Lens</span>
          </div>
          <SearchBox className="min-w-0 flex-1" />
          <IconButton label={menuOpen ? "Close menu" : "Open menu"} aria-expanded={menuOpen} onClick={() => setMenu(!menuOpen)}>
            {menuOpen ? <IconX size={18} /> : <IconMenu size={18} />}
          </IconButton>
        </header>
        {menuOpen && (
          <div className="fixed inset-0 top-12 z-40 bg-black/40" onMouseDown={(e) => e.target === e.currentTarget && setMenu(false)}>
            <nav aria-label="Menu" className="lens-rise max-h-full overflow-auto border-b border-line bg-panel p-3 shadow-[var(--shadow)]">
              <MenuProject />
              <div className="eyebrow mb-1.5 mt-3 px-1">Views</div>
              <ViewTabs vertical />
              <div className="eyebrow mb-1.5 mt-3 px-1">Tools</div>
              <Actions inMenu />
              <div className="mt-2 flex items-center justify-between border-t border-line px-1 pt-2">
                <span className="text-[12px] text-muted">Export</span>
                <ExportMenu />
              </div>
            </nav>
          </div>
        )}
      </>
    );
  }
  return (
    <header className="relative z-40 flex h-12 shrink-0 items-center gap-3 border-b border-line bg-panel px-3">
      <Brand />
      <ViewTabs />
      <SearchBox className="ml-auto w-[clamp(180px,22vw,340px)]" />
      <Actions />
    </header>
  );
}

function MenuProject() {
  const model = useModel();
  return (
    <div className="px-1">
      <div className="font-mono text-[12px] text-muted">{model.graph.project.name}</div>
    </div>
  );
}
