import { useMemo } from "react";
import { DomainAI } from "../components/DomainAI";
import { GraphCanvas } from "../components/GraphCanvas";
import { EmptyState } from "../components/ui";
import { useStore } from "../store";
import type { VNode } from "../types";
import { buildDomain } from "../utils/domain";
import { useCompiledFilters, useModel, useOverlayInput } from "./hooks";

export function DomainView() {
  const model = useModel();
  const cf = useCompiledFilters();
  const expandedStep = useStore((s) => s.expandedStep);
  const setExpandedStep = useStore((s) => s.setExpandedStep);
  const select = useStore((s) => s.select);
  const overlay = useOverlayInput();
  const job = useStore((s) => s.enrichJob);
  const vm = useMemo(() => buildDomain(model, cf, { expandedStep }), [model, cf, expandedStep]);

  const onClick = (v: VNode) => {
    if (v.type === "step" && v.graphId) {
      setExpandedStep(expandedStep === v.graphId ? null : v.graphId);
      select(v.graphId);
      return true;
    }
    return false;
  };
  const hasDomains = useMemo(() => model.graph.nodes.some((n) => n.kind === "domain"), [model]);
  if (!hasDomains) {
    return (
      <EmptyState
        title="No business map yet"
        body="The Business view groups code by what it does: business areas contain flows, flows contain steps, and steps link to the code that implements them."
        action={<DomainAI />}
      />
    );
  }
  return (
    <div className="relative h-full w-full">
      <GraphCanvas vm={vm} overlay={overlay} onNodeClick={onClick} fitKey={`domain:${expandedStep ?? ""}`} />
      {vm.nodes.length > 0 && (
        <div className="pointer-events-none absolute left-3 top-3 z-10 rounded-md border border-line bg-panel px-2.5 py-1.5 text-[11.5px] text-muted">
          Business area → flow → step. Click a step to reveal the code that implements it.
          {job.state === "done" && job.costUsd !== undefined && <span className="ml-2 text-faint">· Claude run cost ${job.costUsd.toFixed(2)}</span>}
        </div>
      )}
    </div>
  );
}
