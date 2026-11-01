import { useEffect, useState } from "react";
import { useStore } from "../store";
import { costRange } from "../utils/format";
import { Mascot } from "./Mascot";
import { Button, Spinner, renderInlineCode } from "./ui";

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

/** Banner above the checklist: run, watch, and summarize the read-only AI audit. */
export function AuditAI({ unresolved }: { unresolved: number }) {
  const meta = useStore((s) => s.meta);
  const mode = useStore((s) => s.mode);
  const job = useStore((s) => s.enrichJob);
  const audit = useStore((s) => s.audit);
  const run = useStore((s) => s.runAI);
  const cancel = useStore((s) => s.cancelAI);
  const openCode = useStore((s) => s.openCode);
  const confirming = useStore((s) => s.auditConfirm);
  const setConfirming = (v: boolean) => useStore.setState({ auditConfirm: v });
  const estimate = costRange(meta?.enrichEstimates?.audit);
  const mine = job.task === "audit";
  const running = mine && job.state === "running";
  const busyElsewhere = !mine && job.state === "running";
  const elapsed = useElapsed(job.startedAt, running);

  if (mode !== "server" || !meta?.canEnrich) return null;

  const box = "mx-3 my-2.5 rounded-lg border border-line bg-panel-2 px-3 py-2.5";
  if (running) {
    return (
      <div className={box} role="status">
        <div className="flex items-center gap-2 text-[12.5px] text-fg">
          <Spinner size={14} /> Claude is auditing the code… <span className="font-mono text-muted tabular">{elapsed}</span>
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
  }

  const failed = mine && job.state === "error";
  // Idle with nothing to report: the header's Audit with AI button is the only entry point.
  if (!audit && !failed && !confirming && !busyElsewhere) return null;
  return (
    <div className={box}>
      <div className="flex flex-wrap items-start gap-3">
        <Mascot size={30} className="shrink-0" />
        <div className="min-w-0 flex-1 text-[12px]">
          {audit ? (
            <>
              <p className="text-fg">
                AI audit · {new Date(audit.generatedAt).toLocaleDateString()} · {audit.items.length} items reviewed
                {audit.costUsd ? <span className="text-muted"> · {usd(audit.costUsd)}</span> : null}
              </p>
              {audit.summary && <p className="mt-0.5 text-muted">{audit.summary}</p>}
            </>
          ) : (
            <p className="text-muted">
              <span className="text-fg">{unresolved} items need code review.</span> Claude reads the code (read-only), decides each one with file:line evidence, and writes{" "}
              <span className="font-mono">SECURITY_AUDIT.md</span>.
            </p>
          )}
          {failed && (
            <p className="mt-1.5 text-critical" role="alert">
              {renderInlineCode(job.error ?? "The audit failed.")}
            </p>
          )}
          {busyElsewhere && <p className="mt-1.5 text-muted">Another AI run is in progress.</p>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {audit && (
            <>
              <button type="button" className="text-[11.5px] text-accent hover:underline" onClick={() => openCode(audit.report, { title: "Security audit" })}>
                Open Report
              </button>
            </>
          )}
        </div>
      </div>
      {confirming && (
        <div className="mt-2.5 flex flex-wrap items-center gap-2 border-t border-line pt-2.5 text-[12px] text-muted">
          <span className="min-w-0 flex-1">
            Read-only. Writes <span className="font-mono">SECURITY_AUDIT.md</span>. Usually {estimate}.
          </span>
          <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant="accent"
            autoFocus
            onClick={() => {
              setConfirming(false);
              void run("audit");
            }}
          >
            Run
          </Button>
        </div>
      )}
    </div>
  );
}
