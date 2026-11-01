import { useEffect, useState } from "react";
import { useStore } from "../store";
import { useModel } from "../views/hooks";
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

/** Empty-state panel for the Business view: run the domain analyzer via Claude Code. */
export function DomainAI() {
  const model = useModel();
  const meta = useStore((s) => s.meta);
  const mode = useStore((s) => s.mode);
  const job = useStore((s) => s.enrichJob);
  const run = useStore((s) => s.runAI);
  const cancel = useStore((s) => s.cancelAI);
  const [confirming, setConfirming] = useState(false);
  const estimate = costRange(meta?.enrichEstimates?.domain);
  const mine = job.task === "domain";
  const running = job.state === "running" && job.task === "domain";
  const busyElsewhere = job.state === "running" && job.task !== "domain";
  const elapsed = useElapsed(job.startedAt, running);

  if (mode !== "server" || !meta?.canEnrich) {
    return (
      <p className="text-[12.5px] text-muted">
        Run <code className="rounded bg-raised px-1 font-mono text-fg">/lens-domain</code> in Claude Code, or open this project with <code className="rounded bg-raised px-1 font-mono text-fg">lens serve</code> to run it from here.
      </p>
    );
  }

  if (running) {
    const steps = job.progress ?? [];
    return (
      <div className="flex flex-col items-center gap-3" role="status">
        <div className="lens-scanbar" aria-hidden />
        <div className="flex items-center gap-2 text-[12.5px] text-fg">
          <Spinner size={14} /> Claude is mapping the business… <span className="font-mono text-muted tabular">{elapsed}</span>
        </div>
        <ul className="w-full max-w-sm space-y-0.5 text-left font-mono text-[11px]">
          {steps.slice(-5).map((p, i, a) => (
            <li key={`${i}:${p}`} className={i === a.length - 1 ? "text-muted" : "text-faint"}>
              {i === a.length - 1 ? "› " : "  "}
              {p}
            </li>
          ))}
        </ul>
        <Button size="sm" variant="ghost" onClick={() => void cancel()}>
          Cancel
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-3">
      {busyElsewhere && <p className="text-[12px] text-muted">Another AI run is in progress. Start this when it finishes.</p>}
      {mine && job.state === "error" && (
        <p className="max-w-sm rounded-md border border-critical/40 bg-critical/10 px-2.5 py-2 text-[12px] text-fg" role="alert">
          {renderInlineCode(job.error ?? "The run failed.")}
          {!!job.costUsd && <span className="text-muted"> Spent {usd(job.costUsd)}.</span>}
        </p>
      )}
      {mine && job.state === "done" && job.result && (
        <p className="text-[12px] text-muted">
          Found {job.result.domains} business areas but none match the current filters.
        </p>
      )}
      {confirming ? (
        <div className="w-full max-w-sm rounded-lg border border-line bg-panel p-3 text-left">
          <p className="text-[12.5px] text-fg">
            This runs Claude Code on <span className="font-mono">{model.graph.project.name}</span> using your Claude account.
          </p>
          <p className="mt-1 text-[12px] text-muted">
            Claude reads the routes, services, and data models, then writes the business map. Usually {estimate}.
          </p>
          <div className="mt-3 flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="accent"
              autoFocus
              onClick={() => {
                setConfirming(false);
                void run("domain");
              }}
            >
              Run
            </Button>
          </div>
        </div>
      ) : (
        <Button variant="accent" className="h-9 px-4 text-[13px]" disabled={busyElsewhere} onClick={() => setConfirming(true)}>
          <Mascot size={18} /> {mine && (job.state === "error" || job.state === "cancelled") ? "Try Again" : "Generate Business Map with AI"}
        </Button>
      )}
    </div>
  );
}
