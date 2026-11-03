import { useEffect, useState } from "react";
import { createPullRequest, fixesPatch, mergePullRequest, type ProposedFix, type RemediationSource, type PullRequest } from "../api";
import { useStore } from "../store";
import { costRange } from "../utils/format";
import { IconChevronDown, IconChevronRight } from "./icons";
import { Mascot } from "./Mascot";
import { checkHitIds, findingItemId, type Severity } from "@lens/core/browser";
import { useModel } from "../views/hooks";
import { Button, SeverityBadge, Spinner, cx, renderInlineCode } from "./ui";

type Source = RemediationSource;

/** The one entry point on Security and Health: find problems if needed, then fix them. */
const CHECKS_POLL_MS = 20_000;

export function FixAllButton({ source, onOpen }: { source: "audit" | "health"; onOpen?: () => void }) {
  const aiRunning = useStore((s) => s.enrichJob.state === "running");
  const plan = useStore((s) => s.fixable.plans?.[source]);
  const nothing = !!plan && !plan.items && !plan.first;
  return (
    <Button
      size="sm"
      variant="accent"
      disabled={aiRunning || nothing}
      title={nothing ? "Nothing left to fix" : undefined}
      onClick={() => {
        onOpen?.();
        useStore.setState({ remediateConfirm: { source }, auditConfirm: false, reviewConfirm: false });
      }}
    >
      <Mascot size={16} /> {aiRunning ? "Running…" : "Fix All"}
    </Button>
  );
}

function Diff({ text }: { text: string }) {
  return (
    <pre className="max-h-72 overflow-auto rounded-md border border-line bg-[var(--code-bg)] px-2.5 py-2 font-mono text-[11px] leading-[1.55]">
      {text.split("\n").map((l, i) => (
        <div
          key={i}
          className={cx(
            l.startsWith("+") && !l.startsWith("+++") && "bg-[color-mix(in_srgb,var(--auth-guarded)_14%,transparent)] text-fg",
            l.startsWith("-") && !l.startsWith("---") && "bg-[color-mix(in_srgb,var(--sev-critical)_14%,transparent)] text-fg",
            l.startsWith("@@") && "text-faint",
            (l.startsWith("+++") || l.startsWith("---")) && "text-muted",
          )}
        >
          {l || " "}
        </div>
      ))}
    </pre>
  );
}

function FixRow({ fix, source }: { fix: ProposedFix; source: Source }) {
  const [open, setOpen] = useState(false);
  const undo = useStore((s) => s.undoFix);
  const busy = useStore((s) => s.fixOp.busy);
  return (
    <li className="border-b border-line last:border-b-0">
      <div className="flex items-start gap-2.5 px-3 py-2">
        <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          <div className="flex items-center gap-1.5">
            {open ? <IconChevronDown size={12} className="shrink-0 text-faint" /> : <IconChevronRight size={12} className="shrink-0 text-faint" />}
            <span className={cx("text-[12.5px]", fix.invalid ? "text-muted line-through" : "text-fg")}>{fix.title}</span>
            {fix.status === "applied" && <span className="rounded border border-guarded/40 px-1 font-mono text-[9.5px] text-guarded">Applied</span>}
            {fix.status === "undone" && <span className="rounded border border-line px-1 font-mono text-[9.5px] text-faint">Undone</span>}
          </div>
          <p className="mt-0.5 text-[11.5px] text-muted">{fix.invalid ? `Can't apply: ${fix.invalid}` : fix.files.map((f) => `${f.path}${f.created ? " (new)" : ""}`).join(", ")}</p>
        </button>
        {fix.status === "applied" && (
          <button type="button" className="text-[11.5px] text-muted hover:text-fg hover:underline" disabled={busy} onClick={() => void undo(source, fix.id)}>
            Undo
          </button>
        )}
      </div>
      {open && (
        <div className="space-y-2 pb-3 pl-9 pr-3 text-[12px] text-muted">
          <p>{renderInlineCode(fix.explanation)}</p>
          {fix.files.map((f) => (
            <Diff key={f.path} text={f.diff} />
          ))}
        </div>
      )}
    </li>
  );
}

/** Confirm, progress, and results of a Fix run for one report. */
export function Remediation({ source }: { source: Source }) {
  const job = useStore((s) => s.enrichJob);
  const mine = useStore((s) => s.remediation[source] ?? null);
  // The Health page shows one Fixes panel; fold in earlier review-only runs.
  const extra = useStore((s) => (source === "health" ? s.remediation.review ?? null : null));
  const info = useItemInfo();
  const estimates = useStore((s) => s.remediationEstimates);
  const confirm = useStore((s) => (s.remediateConfirm?.source === source ? s.remediateConfirm : null));
  const checkTitle = useStore((s) => s.model?.graph.health?.checks.find((c) => c.id === (confirm?.checkId ?? mine?.checkId))?.title);
  const batch = useStore((s) => s.fixable.batch);
  const plans = useStore((s) => s.fixable.plans);
  const run = useStore((s) => s.runAI);
  const cancel = useStore((s) => s.cancelAI);
  const apply = useStore((s) => s.applyFixes);
  const op = useStore((s) => s.fixOp);
  const [showChanges, setShowChanges] = useState(false);
  const [showManual, setShowManual] = useState(false);
  const [showSafe, setShowSafe] = useState(false);
  const cloud = useStore((s) => !!s.meta?.cloud);
  const canPush = useStore((s) => !!s.meta?.canPush);
  const downloadPatch = async () => {
    try {
      const { name, patch } = await fixesPatch();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([patch], { type: "text/x-patch" }));
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } catch (e) {
      setPush({ busy: null, error: e instanceof Error ? e.message : String(e) });
    }
  };
  const [push, setPush] = useState<{ busy: string | null; error?: string }>({ busy: null });
  const pushed = useStore((s) => s.push);
  const refreshPush = useStore((s) => s.refreshPush);
  // GitHub doesn't push check results to us; poll while they're running or haven't started yet.
  const c = pushed?.pr?.checks;
  const checksRunning = pushed?.pr?.state === "open" && (!c || c.pending > 0 || c.passing + c.failing === 0);
  useEffect(() => {
    if (!checksRunning) return;
    const t = setInterval(() => void refreshPush(), CHECKS_POLL_MS);
    return () => clearInterval(t);
  }, [checksRunning, refreshPush]);
  const step = async (label: string, fn: () => Promise<PullRequest>, reload = false) => {
    setPush({ busy: label });
    try {
      const pr = await fn();
      // Show the result right away; the refetch below only adds detail.
      useStore.setState((st) => ({ push: { branch: st.push?.branch ?? null, dirty: false, pr } }));
      if (reload) await useStore.getState().reloadProject();
      else await refreshPush();
      setPush({ busy: null });
    } catch (e) {
      setPush({ busy: null, error: e instanceof Error ? e.message : String(e) });
    }
  };
  // The Health panel also covers single-item runs on review findings.
  const ours = (s?: string) => s === source || (source === "health" && s === "review");
  const running = job.task === "remediate" && ours(job.source) && job.state === "running";
  const failed = job.task === "remediate" && ours(job.source) && job.state === "error";
  const box = "mx-3 my-2.5 rounded-lg border border-line bg-panel-2 text-[12px]";

  if (running) {
    const fa = job.fixAll;
    const pct = fa && fa.total ? Math.min(100, Math.round((Math.min(fa.attempted, fa.total) / fa.total) * 100)) : null;
    return (
      <div className={cx(box, "overflow-hidden text-[12.5px] text-fg")} role="status">
        <div className="flex items-center gap-2 px-3 pb-2 pt-2.5">
          <Spinner size={14} />
          <span className="shrink-0 font-medium">
            {fa ? (
              <>
                Fixing <span className="font-mono tabular">{Math.min(fa.attempted, fa.total)}/{fa.total}</span>
                <span className="font-normal text-muted"> · {fa.fixed} Fixed{job.costUsd ? ` · $${job.costUsd.toFixed(2)}` : ""}</span>
              </>
            ) : job.progress?.some((p) => p.startsWith("Auditing")) ? "Auditing" : job.progress?.some((p) => p.startsWith("Reviewing")) ? "Reviewing" : "Fixing"}
          </span>
          <span className="min-w-0 flex-1 truncate text-[11.5px] text-faint">{(job.progress ?? []).at(-1)}</span>
          <Elapsed since={job.step?.startedAt ?? job.startedAt} typicalMs={job.step?.typicalMs} />
          <Button size="sm" variant="ghost" onClick={() => void cancel()}>
            Cancel
          </Button>
        </div>
        <div className="relative h-[3px] bg-line">
          {pct === null ? (
            <div className="lens-scanbar !absolute !inset-0 !h-full !w-full !rounded-none !bg-transparent" />
          ) : (
            <div className="h-full bg-accent transition-[width] duration-500" style={{ width: `${pct}%` }} />
          )}
        </div>
      </div>
    );
  }

  if (confirm) {
    const fixAll = source !== "review" && !confirm.checkId;
    const plan = fixAll ? plans?.[source as "audit" | "health"] : undefined;
    const label = plan
      ? `${plan.first === "audit" ? "Audit, Then Fix" : plan.first === "review" ? "Review, Then Fix" : `Fix ${plan.items} Issue${plan.items === 1 ? "" : "s"}`}`
      : source === "review" ? "Fix Review Findings" : `Fix ${batch} ${checkTitle ?? "Hits"}`;
    return (
      <div className={cx(box, "flex flex-wrap items-center gap-2 px-3 py-2.5 text-muted")}>
        <span className="min-w-0 flex-1">
          <span className="text-fg">{label}</span> · {costRange(estimates[source])}
        </span>
        <Button size="sm" variant="ghost" onClick={() => useStore.setState({ remediateConfirm: null })}>
          Cancel
        </Button>
        <Button
          size="sm"
          variant="accent"
          autoFocus
          onClick={() => {
            useStore.setState({ remediateConfirm: null });
            void run("remediate", { source, checkId: confirm.checkId });
          }}
        >
          Fix
        </Button>
      </div>
    );
  }

  if (failed) return <p className={cx(box, "px-3 py-2.5 text-critical")}>{renderInlineCode(job.error ?? "Fix failed.")}</p>;
  if (!mine && !extra) return null;
  const rec = mine ?? { ...extra!, fixes: [], skipped: [] };
  const appliedBySource = [
    ...rec.fixes.filter((f) => f.status === "applied").map((f) => ({ f, src: source })),
    ...(extra?.fixes ?? []).filter((f) => f.status === "applied").map((f) => ({ f, src: "review" as Source })),
  ];
  const applied = appliedBySource.map((x) => x.f);
  const changedFiles = [...new Set(applied.flatMap((f) => f.files.map((x) => x.path)))];
  // Valid edits left from an older run that predates auto-apply.
  const ready = rec.fixes.filter((f) => f.status === "proposed" && !f.invalid);
  const notFixed = rec.fixes.filter((f) => f.status === "proposed" && f.invalid);
  const safe = rec.skipped.filter((x) => SAFE.test(x.reason));
  const todo = rec.skipped.filter((x) => !SAFE.test(x.reason));
  if (!applied.length && !ready.length && (source === "health" || (!notFixed.length && !rec.skipped.length))) return null;
  const undoAll = async () => {
    for (const { f, src } of appliedBySource) await useStore.getState().undoFix(src, f.id);
  };
  const cost = (mine?.costUsd ?? 0) + (extra?.costUsd ?? 0);
  const pr = pushed?.pr ?? null;
  const merged = pr?.state === "merged" && !pushed?.dirty;
  const inPr = pr?.state === "open";

  return (
    <div className={box}>
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <span className="eyebrow !text-fg">{source === "health" && checkTitle ? `Fixes · ${checkTitle}` : "Fixes"}</span>
        {cost ? <span className="text-[11px] text-faint">${cost.toFixed(2)}</span> : null}
        {ready.length > 0 && (
          <Button size="sm" variant="accent" className="ml-auto" disabled={op.busy} onClick={() => void apply(source, ready.map((f) => f.id))}>
            {op.busy ? "Applying…" : `Apply ${ready.length} Ready`}
          </Button>
        )}
      </div>
      {applied.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-line bg-[color-mix(in_srgb,var(--auth-guarded)_8%,transparent)] px-3 py-2 text-[12px]">
          <button type="button" className="font-medium text-guarded hover:underline" title={changedFiles.join("\n")} onClick={() => setShowChanges((v) => !v)}>
            ✓ {applied.length} Change{applied.length === 1 ? "" : "s"} · {changedFiles.length} File{changedFiles.length === 1 ? "" : "s"}
          </button>
          <span className="ml-auto flex items-center gap-3 text-[11.5px]">
            {merged ? (
              <a className="font-medium text-guarded hover:underline" href={pr.url} target="_blank" rel="noreferrer noopener">
                Merged · #{pr.number}
              </a>
            ) : inPr ? (
              <>
                <a className="text-muted hover:text-fg hover:underline" href={pr.url} target="_blank" rel="noreferrer noopener">
                  Pull Request #{pr.number}
                </a>
                <ChecksLink pr={pr} />
                {pushed?.dirty ? (
                  <Button size="sm" variant="accent" disabled={!!push.busy || op.busy} onClick={() => void step("Updating…", createPullRequest)}>
                    {push.busy ?? "Update Pull Request"}
                  </Button>
                ) : (
                  <Button size="sm" variant="accent" disabled={!!push.busy || op.busy} onClick={() => void step("Merging…", mergePullRequest, true)}>
                    {push.busy ?? (pr.checks?.failing ? "Merge Anyway" : "Merge")}
                  </Button>
                )}
              </>
            ) : (
              <>
                <button type="button" className="text-muted hover:text-fg hover:underline disabled:opacity-50" disabled={op.busy} onClick={() => void undoAll()}>
                  Undo
                </button>
                {cloud && !canPush && (
                  <Button size="sm" variant="accent" disabled={op.busy} onClick={() => void downloadPatch()}>
                    Download Patch
                  </Button>
                )}
                {canPush && (
                  <Button size="sm" variant="accent" disabled={!!push.busy || op.busy} onClick={() => void step("Creating…", createPullRequest)}>
                    {push.busy ?? "Create Pull Request"}
                  </Button>
                )}
              </>
            )}
          </span>
        </div>
      )}
      {op.error && <p className="border-b border-line px-3 py-1.5 text-critical">{op.error}</p>}
      {push.error && <p className="border-b border-line px-3 py-1.5 text-critical">{push.error}</p>}
      {showChanges && (
        <ul className="border-b border-line">
          {appliedBySource.map(({ f, src }) => (
            <FixRow key={`${src}:${f.id}`} fix={f} source={src} />
          ))}
        </ul>
      )}
      {ready.length > 0 && (
        <ul className="border-b border-line">
          {ready.map((f) => (
            <FixRow key={f.id} fix={f} source={source} />
          ))}
        </ul>
      )}
      {source !== "health" && (notFixed.length > 0 || todo.length > 0) && (
        <div className="px-3 py-2">
          <button type="button" className="eyebrow flex items-center gap-1 hover:!text-fg" onClick={() => setShowManual((v) => !v)} aria-expanded={showManual}>
            {showManual ? <IconChevronDown size={11} /> : <IconChevronRight size={11} />} Manual <span className="font-mono text-faint">{notFixed.length + todo.length}</span>
          </button>
          {showManual && (
            <ItemList
              info={info}
              items={sortBySeverity(info, [...notFixed.map((f) => ({ itemId: f.itemId, reason: `Couldn't apply: ${f.invalid}`, title: f.title })), ...todo])}
            />
          )}
        </div>
      )}
      {source !== "health" && safe.length > 0 && (
        <div className="border-t border-line px-3 py-2">
          <button type="button" className="eyebrow flex items-center gap-1 hover:!text-fg" onClick={() => setShowSafe((v) => !v)} aria-expanded={showSafe}>
            {showSafe ? <IconChevronDown size={11} /> : <IconChevronRight size={11} />} No Fix Needed <span className="font-mono text-faint">{safe.length}</span>
          </button>
          {showSafe && <ItemList info={info} items={sortBySeverity(info, safe.map((x) => ({ ...x, reason: x.reason.replace(SAFE_PREFIX, "") })))} />}
        </div>
      )}
    </div>
  );
}

/** Skips where the agent found the code already handles the issue. Nothing for the owner to do. */
export const SAFE = /^(scanner was wrong|already (safe|hardened|handled|fixed))\b/i;
const SAFE_PREFIX = /^scanner was wrong[:.,]?\s*/i;

function Elapsed({ since, typicalMs }: { since?: number; typicalMs?: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  if (!since) return null;
  const sec = Math.max(0, Math.floor((now - since) / 1000));
  const typical = typicalMs ? Math.max(1, Math.round(typicalMs / 60_000)) : null;
  return (
    <span className="whitespace-nowrap font-mono text-[11px] tabular text-faint">
      {Math.floor(sec / 60)}:{String(sec % 60).padStart(2, "0")}
      {typical && <> / ~{typical}:00</>}
    </span>
  );
}

type ItemInfo = (id: string) => { title: string; severity?: Severity; where?: string } | undefined;
const SEV_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

/** Title and severity for a remediation item id (review-<i>, <check>-<k>, or a finding hash). */
function useItemInfo(): ItemInfo {
  const model = useModel();
  const review = useStore((s) => s.review);
  const findings = model.graph.security?.findings ?? [];
  const checks = model.graph.health?.checks ?? [];
  return (id) => {
    const r = /^review-(\d+)$/.exec(id);
    if (r) {
      const f = review?.findings[Number(r[1])];
      return f && { title: f.title, severity: f.severity as Severity, where: `${f.path}${f.line ? `:${f.line}` : ""}` };
    }
    for (const c of checks) {
      if (!id.startsWith(`${c.id}~`)) continue;
      const h = c.hits[checkHitIds(c).indexOf(id)];
      if (h) return { title: c.title, severity: c.severity as Severity, where: `${h.path}${h.line ? `:${h.line}` : ""}` };
    }
    const f = findings.find((x) => findingItemId(x) === id);
    return f && { title: f.title, severity: f.severity as Severity, where: `${f.path}:${f.line}` };
  };
}

function sortBySeverity<T extends { itemId: string }>(info: ItemInfo, items: T[]): T[] {
  return [...items].sort((a, b) => (SEV_RANK[info(a.itemId)?.severity ?? "info"] ?? 4) - (SEV_RANK[info(b.itemId)?.severity ?? "info"] ?? 4));
}

/** Reasons read better with a capital and with review-<n> swapped for that finding's title. */
function tidy(info: ItemInfo, reason: string): string {
  const s = reason.replace(/\breview-\d+\b/g, (id) => {
    const t = info(id)?.title;
    return t ? `"${t}"` : "a related finding";
  });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function ItemList({ info, items }: { info: ItemInfo; items: Array<{ itemId: string; reason: string; title?: string }> }) {
  return (
    <ul className="mt-2 divide-y divide-line rounded-md border border-line">
      {items.map((x, i) => {
        const it = info(x.itemId);
        return (
          <li key={i} className="grid grid-cols-[64px_1fr] gap-x-3 gap-y-0.5 px-3 py-2">
            <span className="pt-px">{it?.severity && <SeverityBadge severity={it.severity} className="w-[60px] justify-center" />}</span>
            <div className="min-w-0">
              <div className="flex items-baseline gap-2">
                <span className="min-w-0 truncate text-[12.5px] text-fg">{it?.title ?? x.title ?? x.itemId}</span>
                {it?.where && <span className="hidden shrink-0 truncate font-mono text-[11px] text-faint sm:inline">{it.where}</span>}
              </div>
              <p className="text-[12px] leading-relaxed text-muted">{renderInlineCode(tidy(info, x.reason))}</p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** GitHub CI status for an open fixes PR. */
function ChecksLink({ pr }: { pr: PullRequest }) {
  const c = pr.checks;
  if (!c || c.passing + c.failing + c.pending === 0) return null;
  const [label, tone] = c.failing ? [`${c.failing} Check${c.failing === 1 ? "" : "s"} Failing`, "text-critical"] : c.pending ? ["Checks Running", "text-muted"] : ["Checks Passed", "text-guarded"];
  return (
    <a className={cx("hover:underline", tone)} href={`${pr.url}/checks`} target="_blank" rel="noreferrer noopener">
      {label}
    </a>
  );
}
