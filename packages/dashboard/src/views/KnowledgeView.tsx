import { useMemo } from "react";
import { GraphCanvas } from "../components/GraphCanvas";
import { buildKnowledge } from "../utils/knowledge";
import { useCompiledFilters, useModel, useOverlayInput } from "./hooks";

export function KnowledgeView() {
  const model = useModel();
  const cf = useCompiledFilters();
  const overlay = useOverlayInput();
  const vm = useMemo(() => buildKnowledge(model, cf), [model, cf]);
  const topics = useMemo(() => vm.nodes.filter((n) => n.kind === "topic"), [vm]);
  return (
    <div className="relative h-full w-full">
      <GraphCanvas vm={vm} overlay={overlay} fitKey="knowledge" />
      {topics.length > 0 && (
        <div className="absolute left-3 top-3 z-10 max-w-[240px] rounded-lg border border-line bg-panel px-3 py-2">
          <div className="eyebrow mb-1.5">Topics</div>
          <ul className="space-y-1">
            {topics.map((t) => (
              <li key={t.id} className="flex items-center gap-2 text-[12px]">
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: t.color }} />
                <span className="truncate">{t.label}</span>
                <span className="ml-auto font-mono text-[11px] text-muted">{t.count}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
