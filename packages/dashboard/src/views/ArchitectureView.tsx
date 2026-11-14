import { useEffect, useState } from "react";
import { healthScore, type HealthCheck, type Severity } from "@lens/core/browser";
import { fetchArchitecture, type ArchitectureState, type CostEstimate, type LayoutArea } from "../api";
import { IconChevronDown, IconChevronRight } from "../components/icons";
import { Elapsed, ProgressBar, Remediation } from "../components/Remediation";
import { Button, EmptyState, SeverityBadge, Spinner, cx, renderInlineCode } from "../components/ui";
import { useStore } from "../store";
import { SEVERITY_COLOR } from "../utils/colors";
import { costRange } from "../utils/format";
import { useModel } from "./hooks";

const SEVERITIES = ["high", "medium", "low"] as const;
/** Moves listed under an open area before the rest are summed up. */
const MOVES_SHOWN = 40;
/** Checks whose hits name a folder, which the code viewer can't open. */
const FOLDER_CHECKS = new Set(["crowded-folder", "mixed-file-naming"]);

function ScoreRing({ score }: { score: number }) {
  const color = score >= 80 ? "var(--auth-guarded)" : score >= 50 ? "var(--sev-medium)" : "var(--sev-high)";
  return (
    <div className="relative h-10 w-10">
      <svg viewBox="0 0 36 36" className="h-10 w-10 -rotate-90" aria-hidden>
        <circle cx="18" cy="18" r="15" fill="none" stroke="var(--border)" strokeWidth="3.5" />
        <circle cx="18" cy="18" r="15" fill="none" stroke={color} strokeWidth="3.5" strokeDasharray={`${(score / 100) * 94.2} 94.2`} strokeLinecap="round" />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center font-mono text-[12px] font-semibold tabular">{score}</span>
    </div>
  );
}

/** A button that shows the cost and asks once before starting a run. */
function ConfirmRun({ label, estimate, disabled, onRun }: { label: string; estimate?: CostEstimate; disabled: boolean; onRun: () => void }) {
  const [asking, setAsking] = useState(false);
  if (!asking)
    return (
      <Button size="sm" variant="accent" className="shrink-0" disabled={disabled} onClick={() => setAsking(true)}>
        {label}
      </Button>
    );
  return (
    <div className="lens-rise flex shrink-0 items-center gap-2" role="group" aria-label={`Confirm ${label}`}>
      {estimate && (
        <span className="flex items-baseline gap-1.5 rounded-md border border-line bg-panel-2 px-2 py-1" title={`Stops at $${estimate.limit.toFixed(2)}`}>
          <span className="text-[11px] text-muted">Est. Cost</span>
          <span className="font-mono text-[12.5px] font-medium text-fg tabular">{costRange(estimate)}</span>
        </span>
      )}
      <Button size="sm" variant="ghost" onClick={() => setAsking(false)}>
        Cancel
      </Button>
      <Button
        size="sm"
        variant="accent"
        autoFocus
        disabled={disabled}
        onClick={() => {
          setAsking(false);
          onRun();
        }}
      >
        Confirm {label}
      </Button>
    </div>
  );
}

function RunStatus({ areas }: { areas: LayoutArea[] }) {
  const job = useStore((s) => s.enrichJob);
  const cancel = useStore((s) => s.cancelAI);
  if (job.task !== "architecture") return null;
  const box = "mx-4 mt-3 rounded-lg border border-line bg-panel-2 text-[12.5px]";
  if (job.state === "error") return <p className={cx(box, "px-3 py-2.5 text-critical")}>{renderInlineCode(job.error ?? "Run failed.")}</p>;
  if (job.state !== "running") return null;
  const area = areas.find((a) => a.id === job.architecture?.areaId);
  return (
    <div className={cx(box, "overflow-hidden")} role="status">
      <div className="flex items-center gap-2 px-3 pb-2 pt-2.5">
        <Spinner size={14} />
        <span className="shrink-0 font-medium">{area ? `Moving · ${area.title}` : "Planning"}</span>
        <span className="min-w-0 flex-1 truncate text-[11.5px] text-faint" title={(job.progress ?? []).at(-1)}>
          {(job.progress ?? []).at(-1)}
        </span>
        <Elapsed since={job.startedAt} />
        <Button size="sm" variant="ghost" onClick={() => void cancel()}>
          Cancel
        </Button>
      </div>
      <ProgressBar pct={null} />
    </div>
  );
}

function AreaRow({ area, estimate, canRun, busy }: { area: LayoutArea; estimate?: CostEstimate; canRun: boolean; busy: boolean }) {
  const [open, setOpen] = useState(false);
  const run = useStore((s) => s.runAI);
  const applied = area.status === "applied";
  return (
    <li className="border-b border-line last:border-b-0">
      <div className="flex items-center gap-3 pr-4 hover:bg-raised">
        <button type="button" className="flex min-w-0 flex-1 items-center gap-2.5 py-2.5 pl-4 text-left" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {open ? <IconChevronDown size={13} className="shrink-0 text-faint" /> : <IconChevronRight size={13} className="shrink-0 text-faint" />}
          <span className={cx("min-w-0 flex-1 text-[13px]", applied ? "text-muted" : "text-fg")}>{area.title}</span>
          <span className="font-mono text-[12px] text-muted tabular">{area.moves.length} Moves</span>
          {applied && <span className="rounded border border-guarded/40 px-1 font-mono text-[9.5px] text-guarded">Moved</span>}
        </button>
        {canRun && !applied && <ConfirmRun label="Move" estimate={estimate} disabled={busy} onRun={() => void run("architecture", { areaId: area.id })} />}
      </div>
      {open && (
        <div className="pb-3 pl-[42px] pr-4 text-[12px] text-muted">
          <p className="pb-2 text-fg">{renderInlineCode(area.reason)}</p>
          <ul className="divide-y divide-line border-y border-line font-mono text-[11.5px]">
            {area.moves.slice(0, MOVES_SHOWN).map((m) => (
              <li key={m.from} className="flex flex-wrap gap-x-2 py-1">
                <span>{m.from}</span>
                <span className="text-faint">→</span>
                <span className="text-fg">{m.to}</span>
              </li>
            ))}
          </ul>
          {area.moves.length > MOVES_SHOWN && <p className="pt-1.5 text-faint">+{area.moves.length - MOVES_SHOWN} more</p>}
          {area.dropped > 0 && <p className="pt-1.5 text-faint">{area.dropped} skipped: missing, taken or binary</p>}
        </div>
      )}
    </li>
  );
}

function FindingRow({ c }: { c: HealthCheck }) {
  const [open, setOpen] = useState(false);
  const openCode = useStore((s) => s.openCode);
  return (
    <li className="border-b border-line last:border-b-0">
      <button type="button" className="flex w-full items-center gap-2.5 py-2.5 pl-4 pr-4 text-left hover:bg-raised" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {open ? <IconChevronDown size={13} className="shrink-0 text-faint" /> : <IconChevronRight size={13} className="shrink-0 text-faint" />}
        <SeverityBadge severity={c.severity as Severity} className="w-[68px] justify-center" />
        <span className="min-w-0 flex-1 text-[13px] text-fg">{c.title}</span>
        <span className="font-mono text-[12px] text-muted tabular">{c.count}</span>
      </button>
      {open && (
        <div className="pb-3 pl-[118px] pr-4 text-[12px] text-muted">
          <p className="pb-2 text-fg">
            <span className="text-faint">Fix: </span>
            {renderInlineCode(c.fix)}
          </p>
          <ul className="divide-y divide-line border-y border-line">
            {c.hits.map((h) => (
              <li key={h.path} className="py-1">
                {!FOLDER_CHECKS.has(c.id) ? (
                  <button type="button" className="font-mono text-accent hover:underline" onClick={() => openCode(h.path)}>
                    {h.path}
                  </button>
                ) : (
                  <span className="font-mono text-fg">{h.path}</span>
                )}
                <span> {renderInlineCode(h.detail)}</span>
              </li>
            ))}
          </ul>
          {c.count > c.hits.length && <p className="pt-1.5 text-faint">+{c.count - c.hits.length} more</p>}
        </div>
      )}
    </li>
  );
}

export function ArchitectureView() {
  const model = useModel();
  const mode = useStore((s) => s.mode);
  const canEnrich = useStore((s) => !!s.meta?.canEnrich);
  const job = useStore((s) => s.enrichJob);
  const run = useStore((s) => s.runAI);
  const [state, setState] = useState<ArchitectureState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const live = mode === "server";
  const graph = model.graph;

  useEffect(() => {
    if (!live || job.state === "running") return;
    fetchArchitecture()
      .then((s) => (setState(s), setLoadError(null)))
      .catch((e: unknown) => setLoadError(e instanceof Error ? e.message : String(e)));
  }, [live, graph, job.state]);

  const layout = graph.layout;
  if (!layout) return <EmptyState title="No Layout Report" body="Rescan this project with the current version of Lens to run the layout checks." />;
  const checks = layout.checks.filter((c) => c.count > 0).sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) || b.count - a.count);
  const counts = { high: 0, medium: 0, low: 0 };
  for (const c of checks) counts[c.severity] += c.count;
  const score = healthScore(checks.map((c) => ({ severity: c.severity, open: c.count })));
  const areas = state?.plan?.areas ?? [];
  const canRun = live && canEnrich;
  const busy = job.state === "running";

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 border-b border-line bg-panel px-4 py-3">
        <div className="flex items-center gap-3">
          <ScoreRing score={score} />
          <div className="eyebrow">Architecture</div>
        </div>
        <div className="flex items-center gap-4 text-[12px]">
          {SEVERITIES.map((s) => (
            <span key={s} className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full" style={{ background: SEVERITY_COLOR[s] }} />
              <span className="font-mono font-semibold tabular">{counts[s]}</span>
              <span className="capitalize text-muted">{s}</span>
            </span>
          ))}
        </div>
        {canRun && checks.length > 0 && (
          <div className="ml-auto">
            <ConfirmRun label={state?.plan ? "Plan Again" : "Plan"} estimate={state?.estimates?.plan} disabled={busy} onRun={() => void run("architecture")} />
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto pb-6">
        {loadError && <p className="px-4 pt-3 text-[12.5px] text-critical">{loadError}</p>}
        <RunStatus areas={areas} />
        <div className="mx-1">
          <Remediation source="layout" />
        </div>
        {areas.length > 0 && (
          <section className="mt-3">
            <h3 className="eyebrow flex items-center gap-3 border-b border-line px-5 py-2">
              Plan
              <span className="font-mono normal-case tracking-normal text-faint">
                {areas.filter((a) => a.status === "applied").length} of {areas.length} Moved
              </span>
            </h3>
            {state?.plan?.summary && <p className="border-b border-line px-5 py-2 text-[12px] text-muted">{renderInlineCode(state.plan.summary)}</p>}
            <ul>
              {areas.map((a) => (
                <AreaRow key={a.id} area={a} estimate={state?.estimates?.areas[a.id]} canRun={canRun} busy={busy} />
              ))}
            </ul>
          </section>
        )}
        <section className="mt-3">
          <h3 className="eyebrow border-b border-line px-5 py-2">Findings</h3>
          {checks.length > 0 ? (
            <ul>
              {checks.map((c) => (
                <FindingRow key={c.id} c={c} />
              ))}
            </ul>
          ) : (
            <p className="px-4 py-3 text-[12.5px] text-guarded">No layout issues.</p>
          )}
        </section>
      </div>
    </div>
  );
}
