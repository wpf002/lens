import { useMemo, useState } from "react";
import { checkHitIds, healthScore, reviewKey, type HealthCheck, type ScoreGroup, type Severity } from "@lens/core/browser";
import type { ReviewRecord } from "../api";
import { Evidence } from "../components/Checklist";
import { IconChevronDown, IconChevronRight } from "../components/icons";
import { Mascot } from "../components/Mascot";
import { Elapsed, FixAllButton, ProgressBar, Remediation, SAFE } from "../components/Remediation";

const DECISION = /^decision:\s*/i;
/** Refactor checks run one item per Claude session; each costs more than a small fix. */
const REFACTOR_CHECKS = new Set(["oversized", "layer-violations"]);
const isRefactor = (id: string) => REFACTOR_CHECKS.has(id.split("~")[0]!);
import { Button, EmptyState, SeverityBadge, Spinner, cx, renderInlineCode } from "../components/ui";
import { useStore } from "../store";
import { SEVERITY_COLOR } from "../utils/colors";
import { costRange } from "../utils/format";
import { compareIssues, isNewFinding, type IssueOrder } from "../utils/health";
import { useModel } from "./hooks";

type Row = IssueOrder & { key: string; closed: boolean } & (
  | { kind: "finding"; f: ReviewRecord["findings"][number]; i: number; st: ItemStatus }
  | { kind: "check"; c: HealthCheck }
);
const usd = (n: number) => `$${n < 0.1 ? n.toFixed(3) : n.toFixed(2)}`;

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

const needsYou = (st: ItemStatus) => st.kind === "open" && !!st.reason;
const rank = (st: ItemStatus) => (st.kind !== "open" ? 2 : st.reason ? 0 : 1);

/** Open hits left in a check (hits past the listed ones count as open) and how many need the owner. */
function checkCounts(c: HealthCheck, statusOf: (id: string) => ItemStatus) {
  const states = checkHitIds(c).map(statusOf);
  return { left: c.count - states.filter((st) => st.kind !== "open").length, asks: states.filter(needsYou).length };
}

function CheckRow({ c, statusOf, canFix }: { c: HealthCheck; statusOf: (id: string) => ItemStatus; canFix: boolean }) {
  const [open, setOpen] = useState(false);
  const ids = checkHitIds(c);
  const rows = c.hits.map((h, k) => ({ h, id: ids[k]!, st: statusOf(ids[k]!) })).sort((a, b) => rank(a.st) - rank(b.st));
  const { left, asks } = checkCounts(c, statusOf);
  return (
    <li className="border-b border-line last:border-b-0">
      <div className="flex items-center gap-3 pr-4 hover:bg-raised">
      <button type="button" className="flex min-w-0 flex-1 items-center gap-2.5 py-2.5 pl-4 text-left" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {open ? <IconChevronDown size={13} className="shrink-0 text-faint" /> : <IconChevronRight size={13} className="shrink-0 text-faint" />}
        <SeverityBadge severity={c.severity as Severity} className="w-[68px] justify-center" />
        <span className={cx("min-w-0 flex-1 text-[13px]", left > 0 ? "text-fg" : "text-muted")}>{c.title}</span>
        {asks > 0 ? <StatusTag st={{ kind: "open", reason: "x" }} count={asks} /> : left > 0 ? <span className="font-mono text-[12px] text-muted tabular">{left} Open</span> : <StatusTag st={{ kind: "fixed", label: "Closed" }} />}
      </button>
      {open && canFix && left > 0 && <FixCheck id={c.id} open={Math.min(left, c.hits.length)} />}
      </div>
      {open && (
        <div className="pb-3 pl-[118px] pr-4 text-[12px] text-muted">
          <p className="pb-2 text-fg">
            <span className="text-faint">Fix: </span>
            {renderInlineCode(c.fix)}
          </p>
          <ul className="divide-y divide-line border-y border-line">
            {rows.map(({ h, id, st }) => (
              <HitRow key={id} h={h} id={id} checkId={c.id} st={st} canFix={canFix} />
            ))}
          </ul>
          {c.count > c.hits.length && <p className="pt-1.5 text-faint">+{c.count - c.hits.length} more after these are closed</p>}
        </div>
      )}
    </li>
  );
}

/** Fix every open hit of one check in one run. */
function FixCheck({ id, open }: { id: string; open: number }) {
  const busy = useStore((s) => s.enrichJob.state === "running");
  const run = useStore((s) => s.runAI);
  const [asking, setAsking] = useState(false);
  const n = Math.min(open, 15);
  const est = isRefactor(id) ? `~$${n}–${4 * n}` : `~$${Math.max(0.3, 0.15 * n).toFixed(2)}–${Math.max(0.8, 0.4 * n).toFixed(2)}`;
  if (asking)
    return (
      <div className="flex shrink-0 items-center gap-2">
        <span className="text-[11px] text-faint">{est}</span>
        <Button size="sm" variant="ghost" onClick={() => setAsking(false)}>
          Cancel
        </Button>
        <Button
          size="sm"
          variant="accent"
          disabled={busy}
          onClick={() => {
            setAsking(false);
            void run("remediate", { source: "health", checkId: id });
          }}
        >
          Fix {n}
        </Button>
      </div>
    );
  return (
    <Button size="sm" variant="accent" className="shrink-0" disabled={busy} onClick={() => setAsking(true)}>
      Fix {n}
    </Button>
  );
}

function HitRow({ h, id, checkId, st, canFix }: { h: HealthCheck["hits"][number]; id: string; checkId: string; st: ItemStatus; canFix: boolean }) {
  const reopen = useStore((s) => s.toggleWontFix);
  const fixing = useStore((s) => s.enrichJob.state === "running" && s.enrichJob.task === "remediate" && (s.enrichJob.checkId === id || (s.enrichJob.checkId === checkId && st.kind === "open")));
  return (
    <li className="py-1.5">
      <div className="flex items-start gap-3">
        <span className={cx("min-w-0 flex-1", st.kind !== "open" && "opacity-60")}>
          <Hit {...h} />
        </span>
        {fixing ? <span className="shrink-0 animate-pulse text-[11.5px] font-medium text-accent">Fixing…</span> : <StatusTag st={st} />}
      </div>
      {st.kind === "open" && st.reason && <p className="pt-0.5 text-[11.5px] text-muted">{renderInlineCode(st.reason)}</p>}
      {st.kind === "open" && canFix && !fixing && <ItemActions source="health" itemId={id} stableId={id} />}
      {st.kind === "wontfix" && (
        <button type="button" className="text-[11.5px] text-accent hover:underline" onClick={() => void reopen(id, false)}>
          Reopen
        </button>
      )}
    </li>
  );
}

/** An open item with a reason needs the owner: Lens tried and couldn't fix it. */
type ItemStatus = { kind: "open"; reason?: string } | { kind: "fixed"; label: string } | { kind: "safe"; reason: string } | { kind: "wontfix" };

function StatusTag({ st, count }: { st: ItemStatus; count?: number }) {
  const ask = needsYou(st);
  const label = st.kind === "fixed" ? st.label : st.kind === "safe" ? "No Fix Needed" : st.kind === "wontfix" ? "Won't Fix" : ask ? (count && count > 1 ? `${count} Need You` : "Needs You") : "Open";
  const tone = ask ? "text-accent" : st.kind === "open" ? "text-fg" : st.kind === "wontfix" ? "text-muted" : "text-guarded";
  const dot = ask ? "bg-accent" : st.kind === "open" ? "bg-[var(--sev-medium)]" : st.kind === "wontfix" ? "bg-faint" : "bg-guarded";
  return (
    <span className={cx("inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-[11.5px] font-medium", tone)}>
      <span className={cx("h-1.5 w-1.5 rounded-full", dot)} />
      {label}
    </span>
  );
}

/** Fix one item with Claude (no size limit, optional decision note), or close it as Won't Fix. */
function ItemActions({ source, itemId, stableId }: { source: "review" | "health"; itemId: string; stableId: string }) {
  const job = useStore((s) => s.enrichJob);
  const run = useStore((s) => s.runAI);
  const wontFix = useStore((s) => s.toggleWontFix);
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState("");
  const busy = job.state === "running";
  if (asking)
    return (
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <input
          autoFocus
          maxLength={600}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Decision For Claude (Optional)"
          className="h-7 min-w-[220px] flex-1 rounded border border-line bg-panel px-2 text-[12px] text-fg placeholder:text-faint"
        />
        <span className="text-[11px] text-faint">{isRefactor(itemId) ? "~$1–4" : "~$0.45–1.20"}</span>
        <Button size="sm" variant="ghost" onClick={() => setAsking(false)}>
          Cancel
        </Button>
        <Button
          size="sm"
          variant="accent"
          disabled={busy}
          onClick={() => {
            setAsking(false);
            void run("remediate", { source, checkId: itemId, note: note.trim() || undefined });
          }}
        >
          Fix
        </Button>
      </div>
    );
  return (
    <div className="flex items-center gap-2 pt-1">
      <Button size="sm" variant="accent" disabled={busy} onClick={() => setAsking(true)}>
        Fix
      </Button>
      <Button size="sm" variant="ghost" onClick={() => void wontFix(stableId, true)}>
        Won't Fix
      </Button>
    </div>
  );
}

function FindingRow({ f, i, st, canFix, isNew }: { f: ReviewRecord["findings"][number]; i: number; st: ItemStatus; canFix: boolean; isNew: boolean }) {
  const [open, setOpen] = useState(false);
  const reopen = useStore((s) => s.toggleWontFix);
  const fixing = useStore((s) => s.enrichJob.state === "running" && s.enrichJob.task === "remediate" && s.enrichJob.checkId === `review-${i}`);
  const closed = st.kind !== "open";
  return (
    <li className="border-b border-line last:border-b-0">
      <button type="button" className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left hover:bg-raised" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {open ? <IconChevronDown size={13} className="shrink-0 text-faint" /> : <IconChevronRight size={13} className="shrink-0 text-faint" />}
        <SeverityBadge severity={f.severity as Severity} className="w-[68px] justify-center" />
        <span className={cx("min-w-0 flex-1 text-[13px]", closed ? "text-muted" : "text-fg")}>
          {f.title}
          {!closed && f.regressionOf !== undefined && <span className="ml-2 text-[11px] font-medium text-critical">Regressed</span>}
          {!closed && f.regressionOf === undefined && isNew && <span className="ml-2 text-[11px] font-medium text-accent">New</span>}
          {st.kind === "open" && st.reason && <span className="block truncate text-[11.5px] text-muted">{st.reason}</span>}
        </span>
        {fixing ? <span className="shrink-0 animate-pulse text-[11.5px] font-medium text-accent">Fixing…</span> : <StatusTag st={st} />}
      </button>
      {open && (
        <div className="space-y-1.5 pb-3 pl-[118px] pr-4 text-[12px] text-muted">
          <p>
            <Hit path={f.path} line={f.line} detail="" />
          </p>
          <p>{renderInlineCode(f.detail)}</p>
          {f.fix && st.kind === "open" && (
            <p className="text-fg">
              <span className="text-faint">Fix: </span>
              {renderInlineCode(f.fix)}
            </p>
          )}
          {st.kind === "open" && st.reason && (
            <p className="text-fg">
              <span className="text-faint">Why: </span>
              {renderInlineCode(st.reason)}
            </p>
          )}
          {st.kind === "safe" && <p className="text-fg">{renderInlineCode(st.reason)}</p>}
          {st.kind === "open" && canFix && !fixing && <ItemActions source="review" itemId={`review-${i}`} stableId={reviewKey(f)} />}
          {st.kind === "wontfix" && (
            <button type="button" className="text-[11.5px] text-accent hover:underline" onClick={() => void reopen(reviewKey(f), false)}>
              Reopen
            </button>
          )}
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
  const push = useStore((s) => s.push);
  const confirming = useStore((s) => s.reviewConfirm);
  const run = useStore((s) => s.runAI);
  const cancel = useStore((s) => s.cancelAI);
  const openCode = useStore((s) => s.openCode);
  const estimate = costRange(meta?.enrichEstimates?.review);
  const pending = meta?.reviewPending;
  const mine = job.task === "review";
  const running = mine && job.state === "running";
  const failed = mine && job.state === "error";
  const setConfirming = (v: boolean) => useStore.setState({ reviewConfirm: v });
  const box = "mx-4 mt-3 rounded-lg border border-line bg-panel-2 px-3 py-2.5 text-[12px]";
  const mergedPr = push?.pr?.state === "merged" ? push.pr : null;
  const outdated = !!review && !!mergedPr?.mergedAt && mergedPr.mergedAt > review.generatedAt;

  if (running) {
    const done = job.review?.batchesDone ?? 0;
    const total = job.review?.batchesTotal ?? 0;
    const pct = !job.fixAll && total ? Math.min(100, Math.round((done / total) * 100)) : null;
    return (
      <div className="mx-4 mt-3 overflow-hidden rounded-lg border border-line bg-panel-2 text-[12.5px] text-fg" role="status">
        <div className="flex items-center gap-2 px-3 pb-2 pt-2.5">
          <Spinner size={14} />
          <span className="shrink-0 font-medium">
            {job.fixAll ? "Fixing" : "Reviewing"}
            {pct !== null && <span className="font-mono tabular"> {done}/{total}</span>}
            {job.costUsd ? <span className="font-normal text-muted"> · ${job.costUsd.toFixed(2)}</span> : null}
          </span>
          <span className="min-w-0 flex-1 truncate text-[11.5px] text-faint">{(job.progress ?? []).at(-1)}</span>
          <Elapsed since={job.step?.startedAt ?? job.startedAt} typicalMs={job.step?.typicalMs} />
          <Button size="sm" variant="ghost" onClick={() => void cancel()}>
            Cancel
          </Button>
        </div>
        <ProgressBar pct={pct} />
      </div>
    );
  }
  if (confirming)
    return (
      <div className={cx(box, "flex flex-wrap items-center gap-2 text-muted")}>
        <span className="min-w-0 flex-1">{pending && pending.files > 0 ? `Reviews ${pending.files} new or changed files in ${pending.batches} ${pending.batches === 1 ? "batch" : "batches"}. Read-only. Usually ${estimate}.` : "Every file is reviewed. Nothing has changed since."}</span>
        <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
          Cancel
        </Button>
        <Button
          size="sm"
          variant="accent"
          autoFocus
          onClick={() => {
            setConfirming(false);
            // After a merge, the findings the re-review adds go straight to Fix.
            void run("review", outdated ? { fixNew: true } : {});
          }}
        >
          Run
        </Button>
      </div>
    );
  if (failed) return <p className={cx(box, "text-critical")}>{renderInlineCode(job.error ?? "The review failed.")}</p>;
  if (!review) return null;
  return (
    <div className={cx(box, "flex flex-wrap items-center gap-3")}>
      <Mascot size={22} className="shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="text-muted">
          <span className="text-fg">Reviewed {new Date(review.generatedAt).toLocaleDateString()}</span>{pending?.files ? ` · ${pending.files} Files Pending` : ""}{review.costUsd ? <span className="text-muted"> · {usd(review.costUsd)}</span> : null}
          {outdated && <span className="text-faint" title="The code changed after this review. Run it again to see the current state."> · Before #{mergedPr!.number}</span>}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-3 text-[11.5px]">
        {(outdated || !!pending?.files) && (
          <button type="button" className="text-accent hover:underline" onClick={() => setConfirming(true)}>
            Review Again
          </button>
        )}
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
  const wontFixList = useStore((s) => s.wontFix);
  const push = useStore((s) => s.push);
  const [showClosed, setShowClosed] = useState(false);
  const health = model.graph.health;

  const { checks, counts, score, manual, fixed, safe, wontFix } = useMemo(() => {
    // Review ids are stable since stableSince; older records used other numbering. Check-hit ids are content hashes.
    const closed = new Set<string>(wontFixList);
    const fixed = new Set<string>();
    const safe = new Map<string, string>();
    const wontFix = new Set(wontFixList);
    const manual = new Map<string, string>();
    for (const rec of [reviewFixes, healthFixes]) {
      if (!rec) continue;
      const fresh = (id: string) => !id.startsWith("review-") || !review || rec.generatedAt >= (review.stableSince ?? review.generatedAt);
      for (const f of rec.fixes) {
        if (!fresh(f.itemId)) continue;
        if (f.status === "applied") (closed.add(f.itemId), fixed.add(f.itemId));
        else if (f.invalid) manual.set(f.itemId, `Couldn't apply. ${f.invalid}`);
      }
      for (const x of rec.skipped) {
        if (!fresh(x.itemId)) continue;
        if (SAFE.test(x.reason)) (closed.add(x.itemId), safe.set(x.itemId, x.reason.replace(/^scanner was wrong[:.,]?\s*/i, "")));
        // Lens tried and stopped: the owner decides. Remediate retries these on its next run.
        else manual.set(x.itemId, x.reason.replace(DECISION, ""));
      }
    }
    const checks = (health?.checks ?? []).filter((c) => c.count > 0);
    const counts = { high: 0, medium: 0, low: 0 };
    const open: ScoreGroup[] = [];
    for (const c of checks) {
      const hits = Math.max(0, c.count - checkHitIds(c).filter((id) => closed.has(id)).length);
      counts[c.severity] += hits;
      open.push({ severity: c.severity, open: hits });
    }
    (review?.findings ?? []).forEach((f, i) => {
      if (f.resolvedAt || closed.has(`review-${i}`) || wontFix.has(reviewKey(f))) return;
      counts[f.severity] += 1;
      open.push({ severity: f.severity, open: 1 });
    });
    // Scored from open rows, so fixes and review findings move it. The scan-time score only saw automatic checks.
    return { checks, counts, score: healthScore(open), manual, fixed, safe, wontFix };
  }, [health, review, reviewFixes, healthFixes, wontFixList]);

  if (!health) {
    return <EmptyState title="No health report" body="Rescan this project with the current version of Lens to run the code health checks." />;
  }
  const fixedLabel = push?.pr?.state === "merged" && !push.dirty ? "Merged" : push?.pr?.state === "open" ? `In PR #${push.pr.number}` : "Fixed";
  const statusOf = (f: ReviewRecord["findings"][number], i: number): ItemStatus => {
    const id = `review-${i}`;
    if (wontFix.has(reviewKey(f))) return { kind: "wontfix" };
    if (fixed.has(id)) return { kind: "fixed", label: fixedLabel };
    if (f.resolvedAt) return { kind: "fixed", label: "Fixed" };
    if (safe.has(id)) return { kind: "safe", reason: safe.get(id)! };
    return { kind: "open", reason: manual.get(id) };
  };
  const hitStatus = (id: string): ItemStatus =>
    wontFix.has(id) ? { kind: "wontfix" } : fixed.has(id) ? { kind: "fixed", label: fixedLabel } : safe.has(id) ? { kind: "safe", reason: safe.get(id)! } : { kind: "open", reason: manual.get(id) };
  const findings = (review?.findings ?? []).map((f, i) => ({ f, i, st: statusOf(f, i) }));
  const canReview = mode === "server" && !!meta?.canEnrich;
  // One list: review findings and automatic checks, by severity, new findings first within each.
  const rows: Row[] = [
    ...findings.map(({ f, i, st }): Row => ({ kind: "finding", key: `f${i}`, severity: f.severity, closed: st.kind !== "open", asks: needsYou(st), fresh: !!review && isNewFinding(f.foundAt, review), f, i, st })),
    ...checks.map((c): Row => {
      const { left, asks } = checkCounts(c, hitStatus);
      return { kind: "check", key: `c${c.id}`, severity: c.severity, closed: left <= 0, asks: asks > 0, fresh: false, c };
    }),
  ].sort(compareIssues);
  const openRows = rows.filter((r) => !r.closed);
  const closedRows = rows.filter((r) => r.closed);
  const asking = openRows.filter((r) => r.asks).length;
  const renderRow = (r: Row) =>
    r.kind === "finding" ? (
      <FindingRow key={r.key} f={r.f} i={r.i} st={r.st} canFix={canReview} isNew={r.fresh} />
    ) : (
      <CheckRow key={r.key} c={r.c} statusOf={hitStatus} canFix={canReview} />
    );

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
        {rows.length > 0 ? (
          <section className="mt-3">
            <h3 className="eyebrow flex items-center gap-3 border-b border-line px-5 py-2">
              Issues
              <span className="font-mono normal-case tracking-normal text-faint">
                {asking > 0 && <span className="text-accent">{asking} Need You · </span>}
                {openRows.length - asking} Open · {closedRows.length} Closed
              </span>
            </h3>
            <ul>{openRows.map(renderRow)}</ul>
            {!openRows.length && <p className="px-4 py-3 text-[12.5px] text-guarded">All closed.</p>}
            {closedRows.length > 0 && (
              <>
                <button type="button" className="eyebrow flex w-full items-center gap-1 border-t border-line px-5 py-2 hover:!text-fg" onClick={() => setShowClosed((v) => !v)} aria-expanded={showClosed}>
                  {showClosed ? <IconChevronDown size={11} /> : <IconChevronRight size={11} />} Closed <span className="font-mono text-faint">{closedRows.length}</span>
                </button>
                {showClosed && <ul className="border-t border-line">{closedRows.map(renderRow)}</ul>}
              </>
            )}
          </section>
        ) : (
          <p className="px-4 py-3 text-[12.5px] text-muted">No issues found.</p>
        )}
      </div>
    </div>
  );
}
