import { useEffect, useRef } from "react";
import { useStore } from "../../store";
import { useModel } from "../../views/hooks";
import { IconChevronLeft, IconChevronRight, IconPlay, IconStop } from "../icons";
import { Button, Kbd, KindBadge, cx } from "../ui";

export function TourPanel() {
  const model = useModel();
  const tour = useStore((s) => s.tour);
  const startTour = useStore((s) => s.startTour);
  const stopTour = useStore((s) => s.stopTour);
  const step = useStore((s) => s.tourStep);
  const navigateTo = useStore((s) => s.navigateTo);
  const steps = model.graph.tour;
  const activeRef = useRef<HTMLLIElement>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [tour.index, tour.active]);

  if (!steps.length) {
    return <p className="p-4 text-[12.5px] text-muted">No guided tour in this graph. Run <code className="font-mono text-fg">/lens</code> to generate one in dependency order.</p>;
  }
  const cur = steps[tour.index];
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        {tour.active ? (
          <>
            <Button size="sm" onClick={() => step(-1)} disabled={tour.index === 0} aria-label="Previous step">
              <IconChevronLeft size={14} /> Prev
            </Button>
            <Button size="sm" variant="accent" onClick={() => step(1)} disabled={tour.index >= steps.length - 1} aria-label="Next step">
              Next <IconChevronRight size={14} />
            </Button>
            <span className="ml-1 font-mono text-[11px] text-muted tabular">
              {tour.index + 1}/{steps.length}
            </span>
            <Button size="sm" variant="ghost" className="ml-auto" onClick={stopTour}>
              <IconStop size={11} /> End
            </Button>
          </>
        ) : (
          <>
            <Button size="sm" variant="accent" onClick={() => startTour(tour.index)}>
              <IconPlay size={12} /> {tour.index > 0 ? "Resume Tour" : "Start Tour"}
            </Button>
            <span className="ml-auto flex items-center gap-1 text-[11px] text-muted">
              <Kbd>←</Kbd>
              <Kbd>→</Kbd> to step
            </span>
          </>
        )}
      </div>
      <div className="h-[2px] bg-raised" aria-hidden>
        <div className="h-full bg-accent transition-[width]" style={{ width: `${((tour.index + 1) / steps.length) * 100}%` }} />
      </div>
      <ol className="flex-1 overflow-auto py-2">
        {steps.map((s, i) => {
          const active = i === tour.index;
          return (
            <li key={s.order} ref={active ? activeRef : undefined} className={cx("mx-2 rounded-lg", active && tour.active && "bg-panel-2 ring-1 ring-line")}>
              <button type="button" className="flex w-full gap-3 px-2.5 py-2.5 text-left" onClick={() => startTour(i)} aria-current={active ? "step" : undefined}>
                <span
                  className={cx(
                    "mt-[1px] flex h-5 w-5 shrink-0 items-center justify-center rounded-full border font-mono text-[10.5px] tabular",
                    active ? "border-accent bg-accent text-accent-fg" : i < tour.index ? "border-accent text-accent" : "border-line text-muted",
                  )}
                >
                  {i + 1}
                </span>
                <span className="min-w-0">
                  <span className={cx("block text-[13px] font-medium", active ? "text-fg" : "text-fg/85")}>{s.title}</span>
                  {(active || !tour.active) && <span className="mt-0.5 block text-[12px] leading-relaxed text-muted">{s.description}</span>}
                </span>
              </button>
              {active && tour.active && (
                <div className="px-2.5 pb-3 pl-[42px]">
                  {s.lesson && (
                    <div className="mb-2.5 rounded-md border-l-2 border-accent bg-accent-soft px-2.5 py-2 text-[12px] leading-relaxed">
                      <span className="eyebrow mb-0.5 block !text-accent">Lesson</span>
                      {s.lesson}
                    </div>
                  )}
                  <ul className="space-y-px">
                    {s.nodeIds.map((id) => {
                      const n = model.idx.nodes.get(id);
                      return (
                        <li key={id}>
                          <button type="button" className="flex w-full items-center gap-1.5 rounded px-1.5 py-[3px] text-left hover:bg-raised" onClick={() => navigateTo(id)}>
                            <KindBadge kind={n?.kind} />
                            <span className="truncate text-[12px]">{n?.name ?? id}</span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
            </li>
          );
        })}
      </ol>
      {cur && !tour.active && <div className="sr-only">Current step {cur.title}</div>}
    </div>
  );
}
