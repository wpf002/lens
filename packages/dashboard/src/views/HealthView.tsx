import { useEffect, useMemo, useState } from "react";
import { checkHitIds, reviewKey, type HealthCheck, type Severity } from "@lens/core/browser";
import type { ReviewRecord } from "../api";
import { Evidence } from "../components/Checklist";
import { IconChevronDown, IconChevronRight } from "../components/icons";
import { Mascot } from "../components/Mascot";
import { FixAllButton, Remediation, SAFE } from "../components/Remediation";
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

function CheckRow({ c: raw, manual, closed }: { c: HealthCheck; manual: boolean; closed: Set<string> }) {
  const [open, setOpen] = useState(false);
  const ids = checkHitIds(raw);
  const hits = raw.hits.filter((_, k) => !closed.has(ids[k]!));
  const c = { ...raw, hits, count: raw.count - (raw.hits.length - hits.length) };
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

type ItemStatus = { kind: "open"; reason?: string } | { kind: "fixed"; label: string } | { kind: "safe"; reason: string } | { kind: "wontfix" };

function StatusTag({ st }: { st: ItemStatus }) {
  const label = st.kind === "fixed" ? st.label : st.kind === "safe" ? "No Fix Needed" : st.kind === "wontfix" ? "Won't Fix" : "Open";
  const tone = st.kind === "open" ? "text-fg" : st.kind === "wontfix" ? "text-muted" : "text-guarded";
  const dot = st.kind === "open" ? "bg-[var(--sev-medium)]" : st.kind === "wontfix" ? "bg-faint" : "bg-guarded";
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
        <span className="text-[11px] text-faint">~$0.40–1</span>
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

function FindingRow({ f, i, st, canFix }: { f: ReviewRecord["findings"][number]; i: number; st: ItemStatus; canFix: boolean }) {
  const [open, setOpen] = useState(false);
  const reopen = useStore((s) => s.toggleWontFix);
  const closed = st.kind !== "open";
  return (
    <li className="border-b border-line last:border-b-0">
      <button type="button" className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left hover:bg-raised" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {open ? <IconChevronDown size={13} className="shrink-0 text-faint" /> : <IconChevronRight size={13} className="shrink-0 text-faint" />}
        <SeverityBadge severity={f.severity as Severity} className="w-[68px] justify-center" />
        <span className={cx("min-w-0 flex-1 text-[13px]", closed ? "text-muted" : "text-fg")}>{f.title}</span>
        <StatusTag st={st} />
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
              <span className="text-faint">Last Try: </span>
              {renderInlineCode(st.reason)}
            </p>
          )}
          {st.kind === "safe" && <p className="text-fg">{renderInlineCode(st.reason)}</p>}
          {st.kind === "open" && canFix && <ItemActions source="review" itemId={`review-${i}`} stableId={reviewKey(f)} />}
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
  const wontFixList = useStore((s) => s.wontFix);
  const push = useStore((s) => s.push);
  const [showClosed, setShowClosed] = useState(false);
  const health = model.graph.health;

  const { issues, clean, counts, closed, manual, fixed, safe, wontFix } = useMemo(() => {
    // Review ids are positions (review-<i>), so only trust records newer than the review. Check-hit ids are content hashes.
    const closed = new Set<string>(wontFixList);
    const fixed = new Set<string>();
    const safe = new Map<string, string>();
    const wontFix = new Set(wontFixList);
    const manual = new Map<string, string>();
    for (const rec of [reviewFixes, healthFixes]) {
      if (!rec) continue;
      const fresh = (id: string) => !id.startsWith("review-") || !review || rec.generatedAt >= review.generatedAt;
      for (const f of rec.fixes) if (f.status === "applied" && fresh(f.itemId)) (closed.add(f.itemId), fixed.add(f.itemId));
      for (const x of rec.skipped) {
        if (!fresh(x.itemId)) continue;
        if (SAFE.test(x.reason)) (closed.add(x.itemId), safe.set(x.itemId, x.reason.replace(/^scanner was wrong[:.,]?\s*/i, "")));
        else manual.set(x.itemId, x.reason);
      }
      for (const f of rec.fixes) if (f.status === "proposed" && f.invalid && fresh(f.itemId)) manual.set(f.itemId, `Couldn't apply: ${f.invalid}`);
    }
    const checks = (health?.checks ?? []).map((c) => {
      const left = checkHitIds(c).filter((id) => !closed.has(id)).length;
      return { c, count: c.count - (c.hits.length - left) };
    });
    const issues = checks.filter((x) => x.count > 0).map((x) => x.c).sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity] || b.count - a.count);
    const clean = checks.filter((x) => x.count <= 0).map((x) => x.c);
    const counts = { high: 0, medium: 0, low: 0 };
    for (const x of checks) if (x.count > 0) counts[x.c.severity] += x.count;
    (review?.findings ?? []).forEach((f, i) => {
      if (!closed.has(`review-${i}`) && !wontFix.has(reviewKey(f))) counts[f.severity] += 1;
    });
    return { issues, clean, counts, closed, manual, fixed, safe, wontFix };
  }, [health, review, reviewFixes, healthFixes, wontFixList]);

  if (!health) {
    return <EmptyState title="No health report" body="Rescan this project with the current version of Lens to run the code health checks." />;
  }
  const score = health.score;
  const fixedLabel = push?.pr?.state === "merged" && !push.dirty ? "Merged" : push?.pr?.state === "open" ? `In PR #${push.pr.number}` : "Fixed";
  const statusOf = (f: ReviewRecord["findings"][number], i: number): ItemStatus => {
    const id = `review-${i}`;
    if (wontFix.has(reviewKey(f))) return { kind: "wontfix" };
    if (fixed.has(id)) return { kind: "fixed", label: fixedLabel };
    if (safe.has(id)) return { kind: "safe", reason: safe.get(id)! };
    return { kind: "open", reason: manual.get(id) };
  };
  const findings = (review?.findings ?? []).map((f, i) => ({ f, i, st: statusOf(f, i) })).sort((a, b) => SEV_ORDER[a.f.severity] - SEV_ORDER[b.f.severity]);
  const openFindings = findings.filter((x) => x.st.kind === "open");
  const closedFindings = findings.filter((x) => x.st.kind !== "open");
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
            <h3 className="eyebrow flex items-center gap-3 border-b border-line px-4 py-1.5">
              Senior Review
              <span className="font-mono normal-case tracking-normal text-faint">
                {openFindings.length} Open · {closedFindings.length} Closed
              </span>
            </h3>
            <ul>
              {openFindings.map(({ f, i, st }) => (
                <FindingRow key={i} f={f} i={i} st={st} canFix={canReview} />
              ))}
            </ul>
            {!openFindings.length && <p className="px-4 py-3 text-[12.5px] text-guarded">All closed.</p>}
            {closedFindings.length > 0 && (
              <>
                <button type="button" className="eyebrow flex w-full items-center gap-1 border-t border-line px-4 py-2 hover:!text-fg" onClick={() => setShowClosed((v) => !v)} aria-expanded={showClosed}>
                  {showClosed ? <IconChevronDown size={11} /> : <IconChevronRight size={11} />} Closed <span className="font-mono text-faint">{closedFindings.length}</span>
                </button>
                {showClosed && (
                  <ul className="border-t border-line">
                    {closedFindings.map(({ f, i, st }) => (
                      <FindingRow key={i} f={f} i={i} st={st} canFix={canReview} />
                    ))}
                  </ul>
                )}
              </>
            )}
          </section>
        )}
        <section className="mt-3">
          <h3 className="eyebrow border-b border-line px-4 py-1.5">Automatic Checks</h3>
          {issues.length ? (
            <ul>
              {issues.map((c) => (
                <CheckRow key={c.id} c={c} manual={canReview && fixableChecks.length > 0 && !fixableChecks.includes(c.id)} closed={closed} />
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
