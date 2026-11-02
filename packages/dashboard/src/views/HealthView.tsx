import { useEffect, useMemo, useState } from "react";
import type { HealthCheck, Severity } from "@lens/core/browser";
import type { ReviewRecord } from "../api";
import { Evidence } from "../components/Checklist";
import { IconChevronDown, IconChevronRight } from "../components/icons";
import { Mascot } from "../components/Mascot";
import { FixAllButton, Remediation } from "../components/Remediation";
import { Button, EmptyState, SeverityBadge, Spinner, cx, renderInlineCode } from "../components/ui";
import { useStore } from "../store";
import { SEVERITY_COLOR } from "../utils/colors";
import { costRange } from "../utils/format";
import { useModel } from "./hooks";

const SEV_ORDER = { high: 0, medium: 1, low: 2 } as const;
const usd = (n: number) => `$${n < 0.1 ? n.toFixed(3) : n.toFixed(2)}`;

function useElapsed(since?: number, running?: boolean): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);
  if (!since) return "";
  const s = Math.max(0, Math.round((now - since) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function Hit({ path, line, detail }: { path: string; line?: number; detail: string }) {
  const openCode = useStore((s) => s.openCode);
  if (!path || path === ".") return <>{renderInlineCode(detail)}</>;
  if (line) return <Evidence text={`${path}:${line} ${detail}`} />;
  return (
    <>
      <button type="button" className="font-mono text-accent hover:underline" onClick={() => openCode(path)}>
        {path}
      </button>
      {detail && <span> {renderInlineCode(detail)}</span>}
    </>
  );
}

function CheckRow({ c, manual }: { c: HealthCheck; manual: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="border-b border-line last:border-b-0">
      <button type="button" className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left hover:bg-raised" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {open ? <IconChevronDown size={13} className="shrink-0 text-faint" /> : <IconChevronRight size={13} className="shrink-0 text-faint" />}
        <SeverityBadge severity={c.severity as Severity} className="w-[68px] justify-center" />
        <span className="min-w-0 flex-1 text-[13px] text-fg">{c.title}</span>
        {manual && (
          <span className="shrink-0 rounded border border-line px-1.5 font-mono text-[10px] text-faint" title="Needs tests or a refactor; Fix leaves these to you">
            Manual
          </span>
        )}
        <span className="font-mono text-[12px] text-muted tabular">{c.count}</span>
      </button>
      {open && (
        <div className="space-y-2 pb-3 pl-[118px] pr-4 text-[12px] text-muted">
          <ul className="space-y-0.5">
            {c.hits.map((h, i) => (
              <li key={i}>
                <Hit {...h} />
              </li>
            ))}
            {c.count > c.hits.length && <li className="text-faint">+{c.count - c.hits.length} more</li>}
          </ul>
          <div className="flex flex-wrap items-center gap-3">
            <p className="min-w-0 flex-1 text-fg">
              <span className="text-faint">Fix: </span>
              {renderInlineCode(c.fix)}
            </p>
          </div>
        </div>
      )}
    </li>
  );
}

function FindingRow({ f, fixed }: { f: ReviewRecord["findings"][number]; fixed: boolean }) {
  const [open, setOpen] = useState(f.severity === "high" && !fixed);
  return (
    <li className="border-b border-line last:border-b-0">
      <button type="button" className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left hover:bg-raised" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {open ? <IconChevronDown size={13} className="shrink-0 text-faint" /> : <IconChevronRight size={13} className="shrink-0 text-faint" />}
        <SeverityBadge severity={f.severity as Severity} className="w-[68px] justify-center" />
        <span className={cx("min-w-0 flex-1 text-[13px]", fixed ? "text-muted line-through" : "text-fg")}>{f.title}</span>
        {fixed && <span className="shrink-0 rounded border border-guarded/40 px-1.5 font-mono text-[10px] text-guarded">Fixed</span>}
        <span className="hidden shrink-0 font-mono text-[11px] text-faint md:block">{f.category.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}</span>
      </button>
      {open && (
        <div className="space-y-1.5 pb-3 pl-[118px] pr-4 text-[12px] text-muted">
          <p>
            <Hit path={f.path} line={f.line} detail="" />
          </p>
          <p>{renderInlineCode(f.detail)}</p>
          <div className="flex flex-wrap items-center gap-3">
            {f.fix && (
              <p className="min-w-0 flex-1 text-fg">
                <span className="text-faint">Fix: </span>
                {renderInlineCode(f.fix)}
              </p>
            )}
          </div>
        </div>
      )}
    </li>
  );
}

/** Progress, confirm, results, and errors for the AI review. Entry point is the header button. */
function ReviewPanel() {
  const meta = useStore((s) => s.meta);
  const job = useStore((s) => s.enrichJob);
  const review = useStore((s) => s.review);
  const confirming = useStore((s) => s.reviewConfirm);
  const run = useStore((s) => s.runAI);
  const cancel = useStore((s) => s.cancelAI);
  const openCode = useStore((s) => s.openCode);
  const estimate = costRange(meta?.enrichEstimates?.review);
  const mine = job.task === "review";
  const running = mine && job.state === "running";
  const failed = mine && job.state === "error";
  const elapsed = useElapsed(job.startedAt, running);
  const setConfirming = (v: boolean) => useStore.setState({ reviewConfirm: v });
  const box = "mx-4 mt-3 rounded-lg border border-line bg-panel-2 px-3 py-2.5 text-[12px]";

  if (running)
    return (
      <div className={box} role="status">
        <div className="flex items-center gap-2 text-[12.5px] text-fg">
          <Spinner size={14} /> Reviewing… <span className="font-mono text-muted tabular">{elapsed}</span>
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => void cancel()}>
            Cancel
          </Button>
        </div>
        <ul className="mt-1.5 space-y-0.5 font-mono text-[11px]">
          {(job.progress ?? []).slice(-4).map((p, i, a) => (
            <li key={`${i}:${p}`} className={i === a.length - 1 ? "text-muted" : "text-faint"}>
              {i === a.length - 1 ? "› " : "  "}
              {p}
            </li>
          ))}
        </ul>
      </div>
    );
  if (confirming)
    return (
      <div className={cx(box, "flex flex-wrap items-center gap-2 text-muted")}>
        <span className="min-w-0 flex-1">Lens rescans every file, then Claude reviews the riskiest ones as a senior engineer would. Read-only. Usually {estimate}.</span>
        <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
          Cancel
        </Button>
        <Button
          size="sm"
          variant="accent"
          autoFocus
          onClick={() => {
            setConfirming(false);
            void run("review");
          }}
        >
          Run
        </Button>
      </div>
    );
  if (failed) return <p className={cx(box, "text-critical")}>{renderInlineCode(job.error ?? "The review failed.")}</p>;
  if (!review) return null;
  return (
    <div className={cx(box, "flex flex-wrap items-start gap-3")}>
      <Mascot size={28} className="shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="text-fg">
          {new Date(review.generatedAt).toLocaleDateString()} · {review.findings.length} findings{review.costUsd ? <span className="text-muted"> · {usd(review.costUsd)}</span> : null}
        </p>
        {review.summary && <p className="mt-0.5 text-muted">{review.summary}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-3 text-[11.5px]">
        <button type="button" className="text-accent hover:underline" onClick={() => openCode(review.report, { title: "Code review" })}>
          Open Report
        </button>
      </div>
    </div>
  );
}

export function HealthView() {
  const model = useModel();
  const mode = useStore((s) => s.mode);
  const meta = useStore((s) => s.meta);
  const review = useStore((s) => s.review);
  const reviewFixes = useStore((s) => s.remediation.review);
  const healthFixes = useStore((s) => s.remediation.health);
  const fixableChecks = useStore((s) => s.fixable.checks);
  const health = model.graph.health;

  const { issues, clean, counts } = useMemo(() => {
    const checks = health?.checks ?? [];
    const issues = checks.filter((c) => c.count > 0).sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity] || b.count - a.count);
    const clean = checks.filter((c) => c.count === 0);
    const counts = { high: 0, medium: 0, low: 0 };
    for (const c of issues) counts[c.severity] += c.count;
    const fixed = new Set([...(reviewFixes?.fixes ?? []), ...(healthFixes?.fixes ?? [])].filter((x) => x.status === "applied").map((x) => x.itemId));
    (review?.findings ?? []).forEach((f, i) => {
      if (!fixed.has(`review-${i}`)) counts[f.severity] += 1;
    });
    return { issues, clean, counts };
  }, [health, review, reviewFixes, healthFixes]);

  if (!health) {
    return <EmptyState title="No health report" body="Rescan this project with the current version of Lens to run the code health checks." />;
  }
  const score = health.score;
  // Keep each finding's index: remediation ties fixes to findings as review-<index>.
  const fixedIdx = new Set([...(reviewFixes?.fixes ?? []), ...(healthFixes?.fixes ?? [])].filter((x) => x.status === "applied").map((x) => Number(/^review-(\d+)$/.exec(x.itemId)?.[1] ?? -1)));
  // Fixed findings drop out of the list; the fixes panel keeps the record.
  const findings = (review?.findings ?? [])
    .map((f, i) => ({ f, i, fixed: fixedIdx.has(i) }))
    .filter((x) => !x.fixed)
    .sort((a, b) => SEV_ORDER[a.f.severity] - SEV_ORDER[b.f.severity]);
  const canReview = mode === "server" && !!meta?.canEnrich;

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 border-b border-line bg-panel px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="relative h-10 w-10">
            <svg viewBox="0 0 36 36" className="h-10 w-10 -rotate-90" aria-hidden>
              <circle cx="18" cy="18" r="15" fill="none" stroke="var(--border)" strokeWidth="3.5" />
              <circle cx="18" cy="18" r="15" fill="none" stroke={score >= 80 ? "var(--auth-guarded)" : score >= 50 ? "var(--sev-medium)" : "var(--sev-high)"} strokeWidth="3.5" strokeDasharray={`${(score / 100) * 94.2} 94.2`} strokeLinecap="round" />
            </svg>
            <span className="absolute inset-0 flex items-center justify-center font-mono text-[12px] font-semibold tabular">{score}</span>
          </div>
          <div className="eyebrow">Health</div>
        </div>
        <div className="flex items-center gap-4 text-[12px]">
          {(["high", "medium", "low"] as const).map((s) => (
            <span key={s} className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full" style={{ background: SEVERITY_COLOR[s] }} />
              <span className="font-mono font-semibold tabular">{counts[s]}</span>
              <span className="capitalize text-muted">{s}</span>
            </span>
          ))}
        </div>
        {canReview && (
          <div className="ml-auto flex items-center gap-2">
            <FixAllButton source="health" />
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto pb-6">
        <ReviewPanel />
        <div className="mx-1">
          <Remediation source="health" />
        </div>
        {findings.length > 0 && (
          <section className="mt-3">
            <h3 className="eyebrow border-b border-line px-4 py-1.5">Senior Review</h3>
            <ul>
              {findings.map(({ f, i, fixed }) => (
                <FindingRow key={i} f={f} fixed={fixed} />
              ))}
            </ul>
          </section>
        )}
        <section className="mt-3">
          <h3 className="eyebrow border-b border-line px-4 py-1.5">Automatic Checks</h3>
          {issues.length ? (
            <ul>
              {issues.map((c) => (
                <CheckRow key={c.id} c={c} manual={canReview && fixableChecks.length > 0 && !fixableChecks.includes(c.id)} />
              ))}
            </ul>
          ) : (
            <p className="px-4 py-3 text-[12.5px] text-muted">No issues found.</p>
          )}
          {clean.length > 0 && (
            <p className="px-4 pt-3 text-[11.5px] text-faint">
              <span className="text-muted">No issues: </span>
              {clean.map((c) => c.title).join(" · ")}
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
