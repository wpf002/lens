import type { ReactNode } from "react";
import { useStore } from "../../store";
import { useModel } from "../../views/hooks";
import { KindBadge, Section, Spinner, SeverityBadge, cx } from "../ui";

export function DiffPanel() {
  const model = useModel();
  const diff = useStore((s) => s.diff);
  const status = useStore((s) => s.diffStatus);
  const error = useStore((s) => s.diffError);
  const navigateTo = useStore((s) => s.navigateTo);
  const selectFinding = useStore((s) => s.selectFinding);

  if (status === "loading") {
    return (
      <div className="flex items-center gap-2 p-4 text-[12.5px] text-muted">
        <Spinner size={14} /> Computing impact…
      </div>
    );
  }
  if (status === "error" || !diff) {
    return (
      <div className="p-4 text-[12.5px] text-muted">
        <p className="font-medium text-fg">Diff unavailable</p>
        <p className="mt-1">{error ?? "No diff loaded."}</p>
        <p className="mt-2">Diff impact needs a git repository. Run <code className="font-mono text-fg">lens diff</code> or <code className="font-mono text-fg">/lens-diff</code>.</p>
      </div>
    );
  }
  const riskColor = diff.risk === "high" ? "var(--sev-critical)" : diff.risk === "medium" ? "var(--sev-medium)" : "var(--auth-guarded)";
  const list = (ids: string[], extra?: (id: string) => ReactNode) => (
    <ul className="space-y-px">
      {ids.map((id) => {
        const n = model.idx.nodes.get(id);
        return (
          <li key={id}>
            <button type="button" onClick={() => navigateTo(id)} className="flex w-full items-center gap-1.5 rounded px-1.5 py-[3px] text-left hover:bg-raised">
              <KindBadge kind={n?.kind} />
              <span className="min-w-0 flex-1 truncate text-[12px]">{n?.name ?? id}</span>
              {extra?.(id)}
            </button>
          </li>
        );
      })}
    </ul>
  );
  const impacted = [...diff.impacted].sort((a, b) => a.distance - b.distance);
  return (
    <div>
      <div className="border-b border-line px-4 py-3.5">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[12px]">
            {diff.base} → {diff.head}
          </span>
          <span className="ml-auto rounded px-2 py-[1px] text-[11px] font-semibold uppercase tracking-wide" style={{ color: riskColor, background: `color-mix(in srgb, ${riskColor} 14%, transparent)` }}>
            {diff.risk} risk
          </span>
        </div>
        <div className="mt-2.5 grid grid-cols-3 gap-2 text-center">
          {(
            [
              ["files", diff.changedFiles.length],
              ["changed", diff.changed.length],
              ["impacted", diff.impacted.length],
            ] as const
          ).map(([k, v]) => (
            <div key={k} className="rounded-md border border-line bg-panel-2 py-1.5">
              <div className="font-mono text-[15px] font-semibold tabular">{v}</div>
              <div className="text-[10.5px] text-muted">{k}</div>
            </div>
          ))}
        </div>
        <div className="mt-3 flex items-center gap-3 text-[11px] text-muted">
          <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm border-2 border-accent" /> changed</span>
          <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm border-2 border-dashed border-accent" /> impacted</span>
        </div>
      </div>
      <Section title="Changed files">
        <ul className="space-y-1">
          {diff.changedFiles.map((f) => {
            const id = model.fileByPath.get(f.path);
            return (
              <li key={f.path} className="flex items-center gap-2 text-[12px]">
                <span className={cx("w-4 text-center font-mono text-[11px] font-bold", f.status === "A" ? "text-[var(--auth-guarded)]" : f.status === "D" ? "text-[var(--sev-critical)]" : "text-accent")}>{f.status}</span>
                {id ? (
                  <button type="button" className="min-w-0 flex-1 truncate text-left font-mono text-[11.5px] hover:text-accent" onClick={() => navigateTo(id)}>
                    {f.path}
                  </button>
                ) : (
                  <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-muted">{f.path}</span>
                )}
                <span className="font-mono text-[10.5px] text-faint">{f.hunks.length} hunk{f.hunks.length === 1 ? "" : "s"}</span>
              </li>
            );
          })}
        </ul>
      </Section>
      <Section title={`Changed nodes · ${diff.changed.length}`}>{list(diff.changed)}</Section>
      <Section title={`Impacted · ${diff.impacted.length}`}>
        {list(
          impacted.map((x) => x.id),
          (id) => {
            const x = diff.impacted.find((i) => i.id === id)!;
            return (
              <span className="shrink-0 font-mono text-[10px] text-faint">
                {x.via} · {x.distance} hop{x.distance === 1 ? "" : "s"}
              </span>
            );
          },
        )}
      </Section>
      {diff.affectedEndpoints.length > 0 && <Section title="Affected endpoints">{list(diff.affectedEndpoints)}</Section>}
      {diff.testsToRun.length > 0 && <Section title="Tests to run">{list(diff.testsToRun)}</Section>}
      {diff.securityRelevant.length > 0 && (
        <Section title="Security-relevant" className="border-b-0">
          <ul className="space-y-1">
            {diff.securityRelevant.map((id) => {
              const f = model.findingById.get(id);
              if (!f) return list([id]);
              return (
                <li key={id}>
                  <button type="button" onClick={() => selectFinding(id)} className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left hover:bg-raised">
                    <SeverityBadge severity={f.severity} />
                    <span className="truncate text-[12px]">{f.title}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </Section>
      )}
      {diff.unknownFiles.length > 0 && (
        <Section title="Not in graph" className="border-b-0">
          <ul className="font-mono text-[11px] text-muted">{diff.unknownFiles.map((p) => <li key={p}>{p}</li>)}</ul>
        </Section>
      )}
    </div>
  );
}
