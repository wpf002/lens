import { useEffect, useMemo, useState } from "react";
import { useStore } from "../store";
import { FILE_KINDS } from "../utils/model";
import { costRange } from "../utils/format";
import { useModel } from "../views/hooks";
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

/** Compact control under the "Written by Claude" bar in the Overview. */
export function SummarizeAI() {
  const model = useModel();
  const meta = useStore((s) => s.meta);
  const mode = useStore((s) => s.mode);
  const job = useStore((s) => s.enrichJob);
  const run = useStore((s) => s.runAI);
  const cancel = useStore((s) => s.cancelAI);
  const [confirming, setConfirming] = useState(false);
  const estimate = costRange(meta?.enrichEstimates?.summaries);
  const mine = job.task === "summaries";
  const running = mine && job.state === "running";
  const busyElsewhere = !mine && job.state === "running";
  const elapsed = useElapsed(job.startedAt, running);

  // Same nodes and rule as the server's pending batches, counted as unique paths.
  const pending = useMemo(() => {
    const paths = new Set<string>();
    for (const n of model.graph.nodes) {
      if (!n.path || !(FILE_KINDS.has(n.kind) || n.kind === "article" || n.kind === "source")) continue;
      const todo = n.summarySource !== "llm" || n.stale || (model.idx.children.get(n.id) ?? []).some((c) => model.idx.nodes.get(c)?.stale);
      if (todo) paths.add(n.path);
    }
    return paths.size;
  }, [model]);

  if (mode !== "server" || !meta?.canEnrich) return null;

  if (running) {
    const p = job.summaries;
    return (
      <div className="mt-2 flex items-center gap-2 text-[11.5px] text-muted" role="status">
        <Spinner size={12} />
        <span className="min-w-0 truncate">
          Summarizing{p?.batchesTotal ? ` · batch ${Math.min(p.batchesDone + 1, p.batchesTotal)} of ${p.batchesTotal}` : ""} · <span className="font-mono tabular">{elapsed}</span>
        </span>
        <button type="button" className="ml-auto shrink-0 text-faint hover:text-fg" onClick={() => void cancel()}>
          Cancel
        </button>
      </div>
    );
  }

  if (confirming) {
    return (
      <div className="mt-2.5 rounded-md border border-line bg-panel-2 p-2.5 text-[12px] text-muted">
        <p>
          Claude reads {pending} file{pending === 1 ? "" : "s"} and writes a summary of each. Usually {estimate}.
        </p>
        <div className="mt-2 flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant="accent"
            autoFocus
            onClick={() => {
              setConfirming(false);
              void run("summaries");
            }}
          >
            Run
          </Button>
        </div>
      </div>
    );
  }

  const done = mine && job.state === "done" ? job.summaries : undefined;
  const failed = mine && job.state === "error";
  return (
    <div className="mt-2 space-y-1 text-[11.5px]">
      {failed && <p className="text-critical">{renderInlineCode(job.error ?? "The run failed.")}</p>}
      {done && done.files > 0 && (
        <p className="text-faint">
          Summarized {done.files} file{done.files === 1 ? "" : "s"}
          {job.costUsd ? ` · ${usd(job.costUsd)}` : ""}
          {done.stoppedEarly ? ` · stopped after ${done.batchesDone} of ${done.batchesTotal} batches` : ""}
        </p>
      )}
      {pending > 0 && (
        <button
          type="button"
          disabled={busyElsewhere}
          title={busyElsewhere ? "Another AI run is in progress" : undefined}
          className="inline-flex items-center gap-1.5 text-[12px] text-accent hover:underline disabled:opacity-50 disabled:hover:no-underline"
          onClick={() => setConfirming(true)}
        >
          <Mascot size={14} /> {failed ? "Try Again" : done?.stoppedEarly ? "Continue Summarizing" : "Summarize with AI"}
          <span className="text-muted">· {pending} file{pending === 1 ? "" : "s"}</span>
        </button>
      )}
    </div>
  );
}
