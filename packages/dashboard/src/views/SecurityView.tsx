import { Fragment, useMemo, useState } from "react";
import { findingItemId, type Finding, type Severity } from "@lens/core/browser";
import { Checklist } from "../components/Checklist";
import { GraphCanvas } from "../components/GraphCanvas";
import { IconChevronDown, IconChevronRight, IconChevronUp, IconDroplet, IconShield } from "../components/icons";
import { EmptyState, SeverityBadge, cx } from "../components/ui";
import { FixAllButton } from "../components/Remediation";
import { useStore } from "../store";
import { AUTH_COLOR, SEVERITIES, SEVERITY_COLOR } from "../utils/colors";
import { appliedFixItemIds, buildSecurity, endpointCounts, filterFindings, inputPath, isClosedFinding, mergeChecklist, splitFindings, traceLimitsText } from "../utils/security";
import { useCompiledFilters, useModel, useOverlayInput } from "./hooks";

const STATUSES: Finding["status"][] = ["open", "confirmed", "false_positive", "accepted"];
const PUBLIC_RULES = new Set(["unauthenticated-mutation", "server-action-no-auth"]);
/** What the status means for the owner, not the triage term. */
function statusLabel(f: Pick<Finding, "status" | "rule">, fixed = false): string {
  if (fixed) return "Fixed";
  if (f.status === "accepted") return PUBLIC_RULES.has(f.rule) ? "No Fix Needed" : "Won't Fix";
  if (f.status === "false_positive") return "No Fix Needed";
  return f.status === "confirmed" ? "Confirmed" : "Open";
}
const ROUTE = /^(GET|POST|PUT|PATCH|DELETE)\s+\S+/;
/** Plain-language meaning per rule. Falls back to the scanner message. */
const PLAIN: Record<string, string> = {
  "unauthenticated-mutation": "Anyone can call this route without signing in.",
  "server-action-no-auth": "Anyone can run this server action without signing in.",
};
function decision(f: Finding, fixed: boolean): { text: string; todo: string } {
  if (fixed) return { text: "Lens fixed this. The change is in your fixes.", todo: "Nothing." };
  if (f.status === "accepted" && PUBLIC_RULES.has(f.rule))
    return { text: "Marked public. People use this route before they have an account, so it can't require a login.", todo: "Nothing." };
  if (f.status === "accepted") return { text: "Marked Won't Fix.", todo: "Nothing." };
  if (f.status === "false_positive") return { text: "Checked. The code already handles this.", todo: "Nothing." };
  return { text: "Not fixed yet.", todo: "Run Remediate, or open the code and fix it." };
}
const STATUS_OPTION: Record<Finding["status"], string> = { open: "Open", confirmed: "Confirmed", false_positive: "No Fix Needed", accepted: "Won't Fix" };

let lastPanel: "findings" | "checklist" = "findings";

export function SecurityView() {
  const model = useModel();
  const cf = useCompiledFilters();
  const sf = useStore((s) => s.secFilter);
  const setSf = useStore((s) => s.setSecFilter);
  const selected = useStore((s) => s.selectedFinding);
  const selectFinding = useStore((s) => s.selectFinding);
  const openCode = useStore((s) => s.openCode);
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
  const fixed = useMemo(() => appliedFixItemIds(remediation), [remediation]);
  const isFixed = (f: Finding) => fixed.has(findingItemId(f));
  const sec = model.graph.security;
  const vm = useMemo(() => buildSecurity(model, cf, sf), [model, cf, sf]);
  const all = useMemo(() => sec?.findings ?? [], [sec]);
  const [showClosed, setShowClosed] = useState(false);
  const rows = useMemo(() => splitFindings(filterFindings(all, sf), fixed), [all, sf, fixed]);
  const openFindings = useMemo(() => all.filter((f) => !isClosedFinding(f, fixed)), [all, fixed]);
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
  const bySev = SEVERITIES.reduce((a, s) => ({ ...a, [s]: openFindings.filter((f) => f.severity === s).length }), {} as Record<Severity, number>);
  const toggleSev = (s: Severity) => setSf({ severities: sf.severities.includes(s) ? sf.severities.filter((x) => x !== s) : [...sf.severities, s] });
  const risk = sec.summary?.riskScore ?? 0;
  const renderRow = (f: Finding) => {
    const on = selected === f.id;
    const fixedNow = isFixed(f);
    const closed = fixedNow || f.status === "accepted" || f.status === "false_positive";
    const route = ROUTE.exec(f.message)?.[0];
    const d = decision(f, fixedNow);
    const traced = on ? inputPath(sec.exposure, f.id, (id) => model.idx.nodes.get(id)?.name ?? id) : null;
    return (
      <Fragment key={f.id}>
        <tr
          onClick={() => selectFinding(on ? null : f.id, { code: false })}
          className={cx("cursor-pointer border-t border-line align-top hover:bg-raised", on && "bg-raised", closed && !on && "opacity-70")}
          aria-expanded={on}
        >
          <td className="px-3 py-2.5">
            <SeverityBadge severity={f.severity} />
          </td>
          <td className="max-w-[380px] px-2 py-2.5">
            <div className="text-[12.5px] font-medium text-fg">{route ? <span className="font-mono">{route}</span> : f.title}</div>
            <div className="mt-0.5 line-clamp-1 text-[11.5px] text-muted">{route ? f.title : f.message}</div>
          </td>
          <td className="px-2 py-2.5 font-mono text-[11px]" title={f.path}>
            <span className="text-fg">{f.path.split("/").pop()}</span>
            <span className="text-faint">:{f.line}</span>
          </td>
          <td className="px-2 py-2.5 text-right font-mono tabular">{f.reachableFrom.length || <span className="text-faint">0</span>}</td>
          <td className="px-2 py-2.5">
            {f.tainted ? (
              <span className="inline-flex items-center gap-1 text-accent" title="User-controlled input reaches this sink">
                <IconDroplet size={12} /> Yes
              </span>
            ) : (
              <span className="text-faint">—</span>
            )}
          </td>
          <td className="px-3 py-2.5">
            <span className={cx("inline-flex items-center gap-1.5 whitespace-nowrap text-[11.5px] font-medium", f.status === "confirmed" ? "text-[var(--sev-critical)]" : closed ? "text-guarded" : "text-fg")}>
              <span className={cx("h-1.5 w-1.5 rounded-full", f.status === "confirmed" ? "bg-[var(--sev-critical)]" : closed ? "bg-guarded" : "bg-[var(--sev-medium)]")} />
              {statusLabel(f, fixedNow)}
            </span>
          </td>
        </tr>
        {on && (
          <tr className="bg-raised">
            <td />
            <td colSpan={5} className="px-2 pb-3.5 pt-0">
              <dl className="grid max-w-[640px] grid-cols-[110px_1fr] gap-x-4 gap-y-1.5 text-[12.5px]">
                <dt className="text-muted">Issue</dt>
                <dd className="text-fg">{PLAIN[f.rule] ?? f.message}</dd>
                {traced && (
                  <>
                    <dt className="text-muted">Input Path</dt>
                    <dd className="font-mono text-[11.5px] text-fg">
                      {traced.steps.join(" → ")}
                      {traced.more > 0 && <span className="text-muted" title={`${traced.more} more endpoints pass input here`}> +{traced.more}</span>}
                    </dd>
                  </>
                )}
                <dt className="text-muted">Decision</dt>
                <dd className="text-fg">{d.text}</dd>
                <dt className="text-muted">Next Step</dt>
                <dd className={d.todo === "Nothing." ? "text-guarded" : "text-fg"}>{d.todo}</dd>
              </dl>
              <div className="mt-2.5 flex items-center gap-3 text-[11.5px]">
                <button type="button" className="font-medium text-accent hover:underline" onClick={() => openCode(f.path, { focusLine: f.line, lines: [f.line, f.line], title: f.title })}>
                  View Code
                </button>
                <span className="font-mono text-faint">{f.path}:{f.line}{f.cwe ? ` · ${f.cwe}` : ""}</span>
              </div>
            </td>
          </tr>
        )}
      </Fragment>
    );
  };

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
        {sec.taint?.truncated && (
          <div className="flex items-center">
            <span className="inline-flex items-center gap-1 rounded-md border border-line px-2 py-1 text-[11.5px] text-muted" title={traceLimitsText(sec.taint.limits)}>
              <IconDroplet size={12} /> Trace Partial
            </span>
          </div>
        )}
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
                {openFindings.length}
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
                    {STATUS_OPTION[s]}
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
            <table className="w-full min-w-[680px] border-collapse text-[12px]">
              <thead className="sticky top-0 z-[1] bg-panel text-left">
                <tr className="text-[11px] text-muted">
                  <th className="px-3 py-1.5 font-semibold">Severity</th>
                  <th className="px-2 py-1.5 font-semibold">Finding</th>
                  <th className="px-2 py-1.5 font-semibold">Location</th>
                  <th className="px-2 py-1.5 text-right font-semibold" title="Entry points that reach this finding">Entry Points</th>
                  <th className="px-2 py-1.5 font-semibold" title="User-controlled input reaches this code">User Input</th>
                  <th className="px-3 py-1.5 font-semibold">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.open.map(renderRow)}
                {rows.closed.length > 0 && (
                  <tr className="border-t border-line">
                    <td colSpan={6} className="px-3 py-1.5">
                      <button type="button" className="eyebrow flex items-center gap-1 hover:!text-fg" onClick={() => setShowClosed((v) => !v)} aria-expanded={showClosed}>
                        {showClosed ? <IconChevronDown size={11} /> : <IconChevronRight size={11} />} Closed <span className="font-mono text-faint">{rows.closed.length}</span>
                      </button>
                    </td>
                  </tr>
                )}
                {showClosed && rows.closed.map(renderRow)}
                {!rows.open.length && !rows.closed.length && (
                  <tr>
                    <td colSpan={6} className="px-3 py-6 text-center text-muted">
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
