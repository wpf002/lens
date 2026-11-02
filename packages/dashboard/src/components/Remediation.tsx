import { useEffect, useState } from "react";
import { fixesPatch, pushFixesBranch, type ProposedFix, type RemediationSource } from "../api";
import { useStore } from "../store";
import { costRange } from "../utils/format";
import { IconChevronDown, IconChevronRight } from "./icons";
import { Mascot } from "./Mascot";
import { Button, Spinner, cx, renderInlineCode } from "./ui";

type Source = RemediationSource;

/** The one entry point on Security and Health: find problems if needed, then fix them. */
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
      <Mascot size={16} /> {aiRunning ? "Running…" : "Remediate"}
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
      setPush({ busy: false, error: e instanceof Error ? e.message : String(e) });
    }
  };
  const [push, setPush] = useState<{ busy: boolean; error?: string; url?: string | null; branch?: string; count?: number }>({ busy: false });
  const doPush = async (count: number) => {
    setPush({ busy: true });
    try {
      const r = await pushFixesBranch();
      setPush({ busy: false, url: r.compareUrl, branch: r.branch, count });
    } catch (e) {
      setPush({ busy: false, error: e instanceof Error ? e.message : String(e) });
    }
  };
  const running = job.task === "remediate" && job.source === source && job.state === "running";
  const failed = job.task === "remediate" && job.source === source && job.state === "error";
  const box = "mx-3 my-2.5 rounded-lg border border-line bg-panel-2 text-[12px]";

  if (running) {
    const fa = job.fixAll;
    const pct = fa && fa.total ? Math.min(100, Math.round((Math.min(fa.attempted, fa.total) / fa.total) * 100)) : null;
    return (
      <div className={cx(box, "overflow-hidden text-[12.5px] text-fg")} role="status">
        <div className="flex items-center gap-2 px-3 pb-2 pt-2.5">
          <Spinner size={14} />
          {fa ? (
            <span>
              Fixing… <span className="font-mono tabular">{Math.min(fa.attempted, fa.total)} of {fa.total}</span> · {fa.fixed} fixed
              {job.costUsd ? <span className="text-faint"> · ${job.costUsd.toFixed(2)}</span> : null}
            </span>
          ) : (
            job.progress?.some((p) => p.startsWith("Auditing")) ? "Auditing…" : job.progress?.some((p) => p.startsWith("Reviewing")) ? "Reviewing…" : "Fixing…"
          )}
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-faint">{(job.progress ?? []).at(-1)}</span>
          <Elapsed since={job.startedAt} />
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
          <span className="text-fg">{label}</span> · {costRange(estimates[source])} · Undo Anytime
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
  if (!applied.length && !ready.length && !notFixed.length && !rec.skipped.length) return null;
  const undoAll = async () => {
    for (const { f, src } of appliedBySource) await useStore.getState().undoFix(src, f.id);
  };
  const cost = (mine?.costUsd ?? 0) + (extra?.costUsd ?? 0);

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
            <button type="button" className="text-muted hover:text-fg hover:underline disabled:opacity-50" disabled={op.busy} onClick={() => void undoAll()}>
              Undo
            </button>
            {cloud && !canPush && (
              <Button size="sm" variant="accent" disabled={op.busy} onClick={() => void downloadPatch()}>
                Download Patch
              </Button>
            )}
            {canPush &&
              (push.branch && push.count === applied.length ? (
                push.url ? (
                  <a className="font-medium text-accent hover:underline" href={push.url} target="_blank" rel="noreferrer noopener">
                    Open Pull Request
                  </a>
                ) : (
                  <span className="font-mono text-[11px] text-faint">{push.branch}</span>
                )
              ) : (
                <Button size="sm" variant="accent" disabled={push.busy || op.busy} onClick={() => void doPush(applied.length)}>
                  {push.busy ? "Pushing…" : "Push Branch"}
                </Button>
              ))}
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
      {(notFixed.length > 0 || rec.skipped.length > 0) && (
        <div className="px-3 py-2">
          <button type="button" className="eyebrow flex items-center gap-1 hover:!text-fg" onClick={() => setShowManual((v) => !v)} aria-expanded={showManual}>
            {showManual ? <IconChevronDown size={11} /> : <IconChevronRight size={11} />} Do Yourself · {notFixed.length + rec.skipped.length}
          </button>
          {showManual && <ul className="mt-1 space-y-1 text-muted">
            {notFixed.map((f) => (
              <li key={f.id}>
                <span className="text-fg">{f.title}</span> <span className="text-faint">· couldn't apply: {f.invalid}</span>
              </li>
            ))}
            {rec.skipped.map((s, i) => (
              <li key={i}>
                <span className="font-mono text-[11px] text-faint">{s.itemId}</span> {renderInlineCode(s.reason)}
              </li>
            ))}
          </ul>}
        </div>
      )}
    </div>
  );
}

function Elapsed({ since }: { since?: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  if (!since) return null;
  const sec = Math.max(0, Math.floor((now - since) / 1000));
  return <span className="font-mono text-[11px] tabular text-faint">{Math.floor(sec / 60)}:{String(sec % 60).padStart(2, "0")}</span>;
}
