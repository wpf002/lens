import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { SearchHit } from "@lens/core/browser";
import { embedSearch } from "../api";
import { useStore } from "../store";
import { useModel } from "../views/hooks";
import { IconSearch, IconSpark, IconX } from "./icons";
import { KindBadge, Kbd, cx } from "./ui";

export type SearchMode = "fuzzy" | "semantic" | "embeddings";

/** Runs graph search for a query; embeddings mode calls the server and blends results. */
export function useSearch(q: string, mode: SearchMode, limit = 20): { hits: SearchHit[]; loading: boolean; error?: string } {
  const model = useModel();
  const [emb, setEmb] = useState<{ q: string; hits: SearchHit[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const local = useMemo(() => {
    const query = q.trim();
    if (!query) return [];
    return mode === "fuzzy" ? model.search.fuzzy(query, { limit }) : model.search.hybrid(query, { limit });
  }, [model, q, mode, limit]);

  useEffect(() => {
    if (mode !== "embeddings" || !q.trim()) return;
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    const t = setTimeout(() => {
      embedSearch(q.trim())
        .then((sims) => {
          if (!cancelled) setEmb({ q, hits: model.search.withEmbeddings(q.trim(), sims, { limit }) });
        })
        .catch((e: unknown) => {
          if (!cancelled) setError(e instanceof Error ? e.message : String(e));
        })
        .finally(() => !cancelled && setLoading(false));
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [q, mode, model, limit]);

  if (mode === "embeddings") return { hits: emb && emb.q === q ? emb.hits : local, loading, error };
  return { hits: local, loading: false };
}

function snippet(s: string, n = 90): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export function ResultList({ hits, active, onPick, onHover, listId }: { hits: SearchHit[]; active: number; onPick: (h: SearchHit) => void; onHover: (i: number) => void; listId: string }) {
  const ref = useRef<HTMLUListElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);
  return (
    <ul ref={ref} id={listId} role="listbox" className="max-h-[min(60vh,440px)] overflow-auto py-1">
      {hits.map((h, i) => (
        <li
          key={h.id}
          id={`${listId}-${i}`}
          data-idx={i}
          role="option"
          aria-selected={i === active}
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(h);
          }}
          onMouseMove={() => onHover(i)}
          className={cx("mx-1 cursor-pointer rounded-md px-2.5 py-1.5", i === active && "bg-raised")}
        >
          <div className="flex items-center gap-2">
            <KindBadge kind={h.node.kind} />
            <span className="min-w-0 truncate text-[12.5px] font-medium">{h.node.name}</span>
            {h.node.path && <span className="ml-auto min-w-0 max-w-[50%] shrink truncate font-mono text-[10.5px] text-faint">{h.node.path}</span>}
          </div>
          {h.node.summary && <div className="mt-0.5 truncate pl-[1px] text-[11.5px] text-muted">{snippet(h.node.summary)}</div>}
        </li>
      ))}
    </ul>
  );
}

export function SearchBox({ className, autoFocus, onDone }: { className?: string; autoFocus?: boolean; onDone?: () => void }) {
  const meta = useStore((s) => s.meta);
  const navigateTo = useStore((s) => s.navigateTo);
  const setHighlight = useStore((s) => s.setSearchHighlight);
  const focusNonce = useStore((s) => s.searchFocusNonce);
  const [q, setQ] = useState("");
  const [mode, setMode] = useState<SearchMode>("fuzzy");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  const { hits, loading, error } = useSearch(q, mode);

  useEffect(() => {
    if (focusNonce) {
      input.current?.focus();
      input.current?.select();
    }
  }, [focusNonce]);
  useEffect(() => setActive(0), [q, mode]);

  const modes: Array<{ id: SearchMode; label: string; title: string }> = [
    { id: "fuzzy", label: "Fuzzy", title: "Typo-tolerant match on names, paths and tags" },
    { id: "semantic", label: "Semantic", title: "Concept search (hybrid TF-IDF + synonyms + neighbors)" },
    ...(meta?.hasEmbeddings ? [{ id: "embeddings" as const, label: "Embeddings", title: "Vector similarity from the lens server" }] : []),
  ];

  const pick = (h: { id: string }) => {
    navigateTo(h.id);
    setOpen(false);
    input.current?.blur();
    onDone?.();
  };

  return (
    <div className={cx("relative", className)}>
      <div className={cx("flex h-8 items-center gap-1.5 rounded-md border bg-panel-2 pl-2.5 pr-1 transition-colors", open ? "border-accent" : "border-line hover:border-line-strong")}>
        <IconSearch size={14} className="shrink-0 text-muted" />
        <input
          ref={input}
          autoFocus={autoFocus}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
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
            } else if (e.key === "Enter") {
              const h = hits[active];
              if (h) pick(h);
            } else if (e.key === "Escape") {
              e.stopPropagation();
              if (q) setQ("");
              else input.current?.blur();
            }
          }}
          placeholder="Search nodes…"
          aria-label="Search the graph"
          role="combobox"
          aria-expanded={open && hits.length > 0}
          aria-controls={listId}
          aria-activedescendant={open && hits[active] ? `${listId}-${active}` : undefined}
          className="h-full min-w-0 flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-faint"
        />
        {q ? (
          <button type="button" aria-label="Clear search" className="rounded p-1 text-muted hover:text-fg" onMouseDown={(e) => e.preventDefault()} onClick={() => setQ("")}>
            <IconX size={12} />
          </button>
        ) : (
          <span className="hidden gap-0.5 pr-1 lg:flex">
            <Kbd>/</Kbd>
          </span>
        )}
      </div>
      {open && (
        <div className="lens-rise absolute left-0 right-0 top-[calc(100%+6px)] z-50 min-w-[320px] overflow-hidden rounded-lg border border-line bg-panel shadow-[var(--shadow)]" onMouseDown={(e) => e.preventDefault()}>
          <div className="flex items-center gap-1 border-b border-line px-2 py-1.5" role="radiogroup" aria-label="Search mode">
            {modes.map((m) => (
              <button
                key={m.id}
                type="button"
                role="radio"
                aria-checked={mode === m.id}
                title={m.title}
                onClick={() => setMode(m.id)}
                className={cx("inline-flex h-6 items-center gap-1 rounded px-2 text-[11.5px]", mode === m.id ? "bg-accent-soft text-accent" : "text-muted hover:text-fg")}
              >
                {m.id !== "fuzzy" && <IconSpark size={11} />}
                {m.label}
              </button>
            ))}
            {loading && <span className="ml-auto text-[11px] text-muted">searching…</span>}
          </div>
          {q.trim() ? (
            hits.length ? (
              <ResultList hits={hits} active={active} onPick={pick} onHover={setActive} listId={listId} />
            ) : (
              <p className="px-3 py-4 text-[12px] text-muted">{error ? `Embedding search failed: ${error}` : "No matches."}</p>
            )
          ) : (
            <p className="px-3 py-3 text-[12px] text-muted">
              Try a name, a path, or a question like <em className="text-fg">“where is auth handled”</em> in Semantic mode.
            </p>
          )}
          {hits.length > 0 && (
            <div className="flex items-center justify-between border-t border-line px-3 py-1.5 text-[11px] text-muted">
              <span>
                <Kbd>↑</Kbd> <Kbd>↓</Kbd> navigate · <Kbd>↵</Kbd> open
              </span>
              <button
                type="button"
                className="text-accent hover:underline"
                onClick={() => {
                  setHighlight({ query: q, ids: hits.map((h) => h.id) });
                  setOpen(false);
                  input.current?.blur();
                  onDone?.();
                }}
              >
                Highlight all {hits.length}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
