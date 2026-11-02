import { useMemo, useState } from "react";
import { findingItemId, type Finding, type Severity } from "@lens/core/browser";
import { Checklist } from "../components/Checklist";
import { GraphCanvas } from "../components/GraphCanvas";
import { IconChevronDown, IconChevronUp, IconDroplet, IconShield } from "../components/icons";
import { EmptyState, SeverityBadge, cx } from "../components/ui";
import { FixAllButton } from "../components/Remediation";
import { useStore } from "../store";
import { AUTH_COLOR, SEVERITIES, SEVERITY_COLOR } from "../utils/colors";
import { buildSecurity, endpointCounts, filterFindings, mergeChecklist, sortFindings } from "../utils/security";
import { useCompiledFilters, useModel, useOverlayInput } from "./hooks";

const STATUSES: Finding["status"][] = ["open", "confirmed", "false_positive", "accepted"];

let lastPanel: "findings" | "checklist" = "findings";

export function SecurityView() {
  const model = useModel();
  const cf = useCompiledFilters();
  const sf = useStore((s) => s.secFilter);
  const setSf = useStore((s) => s.setSecFilter);
  const selected = useStore((s) => s.selectedFinding);
  const selectFinding = useStore((s) => s.selectFinding);
  const overlay = useOverlayInput();
  const [tableOpen, setTableOpen] = useState(true);
  // Survives the remount when the graph reloads after an AI run.
  const [panel, setPanelState] = useState<"findings" | "checklist">(lastPanel);
  const setPanel = (p: "findings" | "checklist") => {
    lastPanel = p;
    setPanelState(p);
  };
  const audit = useStore((s) => s.audit);
  const remediation = useStore((s) => s.remediation.audit);
  const checklist = useMemo(() => mergeChecklist(model.graph.security?.checklist ?? [], audit), [model, audit]);
  const gaps = checklist.filter((c) => c.status === "fail").length;
  const fixed = useMemo(() => new Set((remediation?.fixes ?? []).filter((f) => f.status === "applied").map((f) => f.itemId)), [remediation]);
  const isFixed = (f: Finding) => fixed.has(findingItemId(f));
  const sec = model.graph.security;
  const vm = useMemo(() => buildSecurity(model, cf, sf), [model, cf, sf]);
  const all = useMemo(() => sec?.findings ?? [], [sec]);
  const rows = useMemo(() => sortFindings(filterFindings(all, sf)), [all, sf]);
  const categories = useMemo(() => [...new Set(all.map((f) => f.category))].sort(), [all]);
  const counts = useMemo(() => endpointCounts(model, checklist), [model, checklist]);

  if (!sec) {
    return (
      <EmptyState
        icon={<IconShield size={22} />}
        title="No security report"
        body="This graph has no security section. Run `lens scan` to detect entry points, auth guards and dangerous sinks, then `/lens-security` for agent triage."
      />
    );
  }
  const bySev = sec.summary?.bySeverity ?? SEVERITIES.reduce((a, s) => ({ ...a, [s]: all.filter((f) => f.severity === s).length }), {} as Record<Severity, number>);
  const toggleSev = (s: Severity) => setSf({ severities: sf.severities.includes(s) ? sf.severities.filter((x) => x !== s) : [...sf.severities, s] });
  const risk = sec.summary?.riskScore ?? 0;

  return (
    <div className="flex h-full w-full flex-col">
      {/* Summary strip */}
      <div className="flex shrink-0 flex-wrap items-stretch gap-x-5 gap-y-2 border-b border-line bg-panel px-4 py-2.5">
        <div className="flex items-center gap-3">
          <div className="relative h-10 w-10" role="img" aria-label={`Risk score ${risk} of 100`}>
            <svg viewBox="0 0 36 36" className="h-10 w-10 -rotate-90">
              <circle cx="18" cy="18" r="15" fill="none" stroke="var(--raised)" strokeWidth="3.5" />
              <circle cx="18" cy="18" r="15" fill="none" stroke={risk >= 70 ? "var(--sev-critical)" : risk >= 40 ? "var(--sev-high)" : "var(--sev-medium)"} strokeWidth="3.5" strokeDasharray={`${(risk / 100) * 94.2} 94.2`} strokeLinecap="round" />
            </svg>
            <span className="absolute inset-0 flex items-center justify-center font-mono text-[12px] font-semibold tabular">{risk}</span>
          </div>
          <div>
            <div className="eyebrow">Risk score</div>
          </div>
        </div>
        <div className="flex items-center gap-1.5" role="group" aria-label="Filter by severity">
          {SEVERITIES.map((s) => {
            const on = sf.severities.includes(s);
            return (
              <button
                key={s}
                type="button"
                aria-pressed={on}
                onClick={() => toggleSev(s)}
                className={cx("flex min-w-[54px] flex-col items-start rounded-md border px-2 py-1 transition-colors", on ? "border-accent bg-accent-soft" : "border-line hover:border-line-strong")}
              >
                <span className="font-mono text-[15px] font-semibold leading-tight tabular" style={{ color: bySev[s] ? SEVERITY_COLOR[s] : "var(--faint)" }}>
                  {bySev[s] ?? 0}
                </span>
                <span className="text-[10px] uppercase tracking-wide text-muted">{s}</span>
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-4 text-[12px]">
          {(["unguarded", "unknown", "public", "guarded"] as const).filter((a) => counts[a] > 0).map((a) => (
            <div key={a} className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full" style={{ background: AUTH_COLOR[a] }} />
              <span className="font-mono font-semibold tabular">{counts[a]}</span>
              <span className="text-muted capitalize">{a}</span>
            </div>
          ))}
        </div>
        {checklist.length > 0 && (
          <div className="ml-auto flex items-center gap-2">
            <FixAllButton
              source="audit"
              onOpen={() => {
                setPanel("checklist");
                setTableOpen(true);
              }}
            />
          </div>
        )}
      </div>

      <div className="relative min-h-[220px] flex-1">
        <GraphCanvas vm={vm} overlay={overlay} minimap={false} fitKey={`sec:${sf.severities.join()}:${sf.categories.join()}:${sf.statuses.join()}`} />
      </div>

      {/* Findings table */}
      <div className={cx("flex shrink-0 flex-col border-t border-line bg-panel", tableOpen ? "h-[42%] min-h-[180px]" : "h-auto")}>
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
          <button type="button" className="flex items-center" onClick={() => setTableOpen((o) => !o)} aria-expanded={tableOpen} aria-label={tableOpen ? "Collapse panel" : "Expand panel"}>
            {tableOpen ? <IconChevronDown size={14} /> : <IconChevronUp size={14} />}
          </button>
          <div className="flex items-center gap-1" role="tablist">
            <button type="button" role="tab" aria-selected={panel === "findings"} className={cx("flex items-center gap-1.5 rounded px-2 py-1", panel === "findings" ? "bg-raised" : "hover:bg-raised")} onClick={() => (setPanel("findings"), setTableOpen(true))}>
              <span className={cx("eyebrow", panel === "findings" && "!text-fg")}>Findings</span>
              <span className="font-mono text-[11px] text-muted">
                {all.filter((f) => f.status !== "false_positive" && f.status !== "accepted" && !isFixed(f)).length}
              </span>
            </button>
            <button type="button" role="tab" aria-selected={panel === "checklist"} className={cx("flex items-center gap-1.5 rounded px-2 py-1", panel === "checklist" ? "bg-raised" : "hover:bg-raised")} onClick={() => (setPanel("checklist"), setTableOpen(true))}>
              <span className={cx("eyebrow", panel === "checklist" && "!text-fg")}>Pre-Launch Checklist</span>
              {gaps > 0 && <span className="rounded-full bg-critical/15 px-1.5 font-mono text-[10.5px] text-critical">{gaps}</span>}
            </button>
          </div>
          <div className={cx("ml-auto flex flex-wrap items-center gap-2", panel !== "findings" && "hidden")}>
            <label className="flex items-center gap-1 text-[11.5px] text-muted">
              Category
              <select
                className="h-7 rounded border border-line bg-panel-2 px-1.5 text-[12px] text-fg"
                value={sf.categories[0] ?? ""}
                onChange={(e) => setSf({ categories: e.target.value ? [e.target.value] : [] })}
              >
                <option value="">All</option>
                {categories.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1 text-[11.5px] text-muted">
              Status
              <select
                className="h-7 rounded border border-line bg-panel-2 px-1.5 text-[12px] text-fg"
                value={sf.statuses[0] ?? ""}
                onChange={(e) => setSf({ statuses: e.target.value ? [e.target.value as Finding["status"]] : [] })}
              >
                <option value="">All</option>
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s.replace("_", " ")}
                  </option>
                ))}
              </select>
            </label>
            {(sf.severities.length > 0 || sf.categories.length > 0 || sf.statuses.length > 0) && (
              <button type="button" className="text-[11.5px] text-accent hover:underline" onClick={() => setSf({ severities: [], categories: [], statuses: [] })}>
                Clear
              </button>
            )}
          </div>
        </div>
        {tableOpen && panel === "checklist" && (
          <div className="min-h-0 flex-1 overflow-auto">
            <Checklist />
          </div>
        )}
        {tableOpen && panel === "findings" && (
          <div className="min-h-0 flex-1 overflow-auto">
            <table className="w-full min-w-[760px] border-collapse text-[12px]">
              <thead className="sticky top-0 z-[1] bg-panel text-left">
                <tr className="text-[10.5px] uppercase tracking-wide text-muted">
                  <th className="px-3 py-1.5 font-semibold">Severity</th>
                  <th className="px-2 py-1.5 font-semibold">Finding</th>
                  <th className="px-2 py-1.5 font-semibold">Rule</th>
                  <th className="px-2 py-1.5 font-semibold">Location</th>
                  <th className="px-2 py-1.5 text-right font-semibold" title="Entry points that reach this finding">Entry Points</th>
                  <th className="px-2 py-1.5 font-semibold" title="User-controlled input reaches this code">User Input</th>
                  <th className="px-3 py-1.5 font-semibold">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((f) => {
                  const on = selected === f.id;
                  return (
                    <tr
                      key={f.id}
                      onClick={() => selectFinding(on ? null : f.id)}
                      className={cx("cursor-pointer border-t border-line align-top hover:bg-raised", on && "bg-accent-soft hover:bg-accent-soft")}
                    >
                      <td className="px-3 py-2">
                        <SeverityBadge severity={f.severity} />
                      </td>
                      <td className="max-w-[340px] px-2 py-2">
                        <button
                          type="button"
                          className={cx("text-left font-medium hover:text-accent", f.status === "false_positive" && "text-muted line-through")}
                          onClick={(e) => {
                            e.stopPropagation();
                            selectFinding(on ? null : f.id);
                          }}
                          aria-pressed={on}
                        >
                          {f.title}
                        </button>
                        <div className="mt-0.5 line-clamp-1 text-[11px] text-muted">{f.message}</div>
                      </td>
                      <td className="px-2 py-2 font-mono text-[11px] text-muted">
                        <div className="text-fg">{f.cwe ?? "—"}</div>
                        <div className="max-w-[180px] truncate" title={f.rule}>
                          {f.rule}
                        </div>
                      </td>
                      <td className="px-2 py-2 font-mono text-[11px]">
                        <span className="text-muted">{f.path.split("/").slice(0, -1).join("/")}/</span>
                        {f.path.split("/").pop()}:{f.line}
                      </td>
                      <td className="px-2 py-2 text-right font-mono tabular">{f.reachableFrom.length || <span className="text-faint">0</span>}</td>
                      <td className="px-2 py-2">
                        {f.tainted ? (
                          <span className="inline-flex items-center gap-1 text-accent" title="User-controlled input reaches this sink">
                            <IconDroplet size={12} /> Yes
                          </span>
                        ) : (
                          <span className="text-faint">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <span className={cx("rounded border px-1.5 py-[1px] text-[10.5px] font-semibold uppercase tracking-wider", f.status === "confirmed" ? "border-[color-mix(in_srgb,var(--sev-critical)_50%,var(--border))] text-[var(--sev-critical)]" : "border-line text-muted")}>
                          {isFixed(f) ? "fixed" : f.status.replace("_", " ")}
                        </span>
                      </td>
                    </tr>
                  );
                })}
                {!rows.length && (
                  <tr>
                    <td colSpan={7} className="px-3 py-6 text-center text-muted">
                      No findings match these filters.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
