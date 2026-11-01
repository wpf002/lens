import { useId, useMemo, useState } from "react";
import type { GraphEdge } from "@lens/core/browser";
import { useStore } from "../store";
import { useModel } from "../views/hooks";
import { IconRoute, IconX } from "./icons";
import { ResultList, useSearch } from "./SearchBox";
import { Button, KindBadge, Modal } from "./ui";

function NodePicker({ label, value, onChange }: { label: string; value: string | null; onChange: (id: string | null) => void }) {
  const model = useModel();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const { hits } = useSearch(q, "fuzzy", 12);
  const listId = useId();
  const inputId = useId();
  const node = value ? model.idx.nodes.get(value) : undefined;
  return (
    <div>
      <label htmlFor={inputId} className="eyebrow mb-1.5 block">
        {label}
      </label>
      {node ? (
        <div className="flex h-9 items-center gap-2 rounded-md border border-line bg-panel-2 px-2.5">
          <KindBadge kind={node.kind} />
          <span className="min-w-0 flex-1 truncate text-[12.5px]">{node.name}</span>
          {node.path && <span className="hidden max-w-[40%] truncate font-mono text-[10.5px] text-faint sm:inline">{node.path}</span>}
          <button type="button" aria-label={`Clear ${label}`} onClick={() => onChange(null)} className="rounded p-1 text-muted hover:text-fg">
            <IconX size={12} />
          </button>
        </div>
      ) : (
        <div className="relative">
          <input
            id={inputId}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setOpen(true);
              setActive(0);
            }}
            onFocus={() => setOpen(true)}
            onBlur={() => setTimeout(() => setOpen(false), 120)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((a) => Math.min(hits.length - 1, a + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((a) => Math.max(0, a - 1));
              } else if (e.key === "Enter" && hits[active]) {
                e.preventDefault();
                onChange(hits[active]!.id);
                setQ("");
              }
            }}
            role="combobox"
            aria-expanded={open && hits.length > 0}
            aria-controls={listId}
            placeholder="Search for a node…"
            className="h-9 w-full rounded-md border border-line bg-panel-2 px-2.5 text-[12.5px] outline-none placeholder:text-faint focus:border-accent"
          />
          {open && hits.length > 0 && (
            <div className="absolute inset-x-0 top-[calc(100%+4px)] z-10 overflow-hidden rounded-lg border border-line bg-panel shadow-[var(--shadow)]">
              <ResultList
                hits={hits}
                active={active}
                listId={listId}
                onHover={setActive}
                onPick={(h) => {
                  onChange(h.id);
                  setQ("");
                }}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function edgeBetween(out: Map<string, GraphEdge[]>, inn: Map<string, GraphEdge[]>, a: string, b: string): { kind: string; dir: "→" | "←" } | null {
  const fwd = (out.get(a) ?? []).find((e) => e.target === b);
  if (fwd) return { kind: fwd.kind, dir: "→" };
  const back = (inn.get(a) ?? []).find((e) => e.source === b);
  if (back) return { kind: back.kind, dir: "←" };
  return null;
}

export function PathFinder() {
  const model = useModel();
  const ps = useStore((s) => s.pathState);
  const setEnds = useStore((s) => s.setPathEnds);
  const run = useStore((s) => s.runPath);
  const clear = useStore((s) => s.clearPath);
  const navigateTo = useStore((s) => s.navigateTo);
  const close = () => useStore.getState().setModal(null);

  const hops = useMemo(() => {
    if (!ps.path) return [];
    return ps.path.map((id, i) => ({
      id,
      node: model.idx.nodes.get(id),
      edge: i > 0 ? edgeBetween(model.idx.out, model.idx.in, ps.path![i - 1]!, id) : null,
    }));
  }, [ps.path, model]);

  return (
    <Modal
      title={
        <span className="flex items-center gap-2">
          <IconRoute size={16} className="text-accent" /> Path Finder
        </span>
      }
      onClose={close}
      footer={
        <>
          {ps.path && (
            <Button variant="ghost" className="mr-auto" onClick={clear}>
              Clear
            </Button>
          )}
          {ps.path ? (
            <Button variant="accent" onClick={close}>
              Show on canvas
            </Button>
          ) : (
            <Button variant="accent" disabled={!ps.from || !ps.to} onClick={run}>
              Find shortest path
            </Button>
          )}
        </>
      }
    >
      <div className="grid gap-3">
        <NodePicker label="From" value={ps.from} onChange={(id) => setEnds({ from: id })} />
        <div className="-my-1 flex justify-center">
          <button
            type="button"
            className="rounded-full border border-line px-2 py-0.5 text-[11px] text-muted hover:text-fg"
            onClick={() => setEnds({ from: ps.to, to: ps.from })}
            disabled={!ps.from && !ps.to}
          >
            ⇅ swap
          </button>
        </div>
        <NodePicker label="To" value={ps.to} onChange={(id) => setEnds({ to: id })} />
      </div>
      {ps.searched && !ps.path && <p className="mt-4 rounded-md border border-line bg-panel-2 px-3 py-2.5 text-[12.5px] text-muted">No path connects these nodes.</p>}
      {ps.path && (
        <div className="mt-5">
          <div className="eyebrow mb-2">
            {ps.path.length - 1} hop{ps.path.length === 2 ? "" : "s"}
          </div>
          <ol className="relative ml-2 border-l border-line pl-4">
            {hops.map((h, i) => (
              <li key={h.id} className="relative pb-2.5 last:pb-0">
                <span className="absolute -left-[21px] top-[7px] h-2.5 w-2.5 rounded-full border-2 border-accent bg-panel" />
                {h.edge && (
                  <div className="mb-1 font-mono text-[10.5px] text-muted">
                    {h.edge.dir === "→" ? `${h.edge.kind} →` : `← ${h.edge.kind}`}
                  </div>
                )}
                <button type="button" onClick={() => navigateTo(h.id)} className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left hover:bg-raised">
                  <span className="font-mono text-[10.5px] text-faint">{i}</span>
                  <KindBadge kind={h.node?.kind} />
                  <span className="min-w-0 flex-1 truncate text-[12.5px]">{h.node?.name ?? h.id}</span>
                  {h.node?.path && <span className="max-w-[40%] truncate font-mono text-[10.5px] text-faint">{h.node.path.split("/").pop()}</span>}
                </button>
              </li>
            ))}
          </ol>
        </div>
      )}
    </Modal>
  );
}
