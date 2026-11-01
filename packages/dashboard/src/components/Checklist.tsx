import { useMemo, useState, type ReactNode } from "react";
import type { ChecklistItem, CheckStatus } from "@lens/core/browser";
import { useStore } from "../store";
import { useModel } from "../views/hooks";
import { AuditAI } from "./AuditAI";
import { Remediation } from "./Remediation";
import { IconChevronDown, IconChevronRight } from "./icons";
import { cx, renderInlineCode } from "./ui";

export const STATUS_META: Record<CheckStatus, { label: string; color: string; hint: string }> = {
  fail: { label: "Fail", color: "var(--sev-critical)", hint: "Evidence of a gap" },
  unverified: { label: "Unverified", color: "var(--sev-medium)", hint: "Needs code review (AI audit or you)" },
  manual: { label: "Manual", color: "var(--sev-low)", hint: "Outside the repo: a to-do for you" },
  clear: { label: "Clear", color: "var(--muted)", hint: "Scanner looked and found nothing wrong (not proof)" },
  pass: { label: "Pass", color: "var(--auth-guarded)", hint: "Positive evidence the control exists" },
  na: { label: "N/A", color: "var(--faint)", hint: "Doesn't apply to this project" },
};
const ORDER: CheckStatus[] = ["fail", "unverified", "manual", "clear", "pass", "na"];
const TIERS: Array<{ tier: 1 | 2 | 3; name: string }> = [
  { tier: 1, name: "Tier 1" },
  { tier: 2, name: "Tier 2" },
  { tier: 3, name: "Tier 3" },
];

export function StatusPill({ status }: { status: CheckStatus }) {
  const m = STATUS_META[status];
  return (
    <span
      className="inline-flex h-5 w-[78px] shrink-0 items-center justify-center rounded border font-mono text-[10.5px] font-semibold uppercase tracking-wide"
      style={{ color: m.color, borderColor: `color-mix(in srgb, ${m.color} 45%, transparent)`, background: `color-mix(in srgb, ${m.color} 10%, transparent)` }}
      title={m.hint}
    >
      {m.label}
    </span>
  );
}

/** `path/to/file.py:12 rest…` evidence becomes a link that opens the source viewer. */
export function Evidence({ text }: { text: string }) {
  const openCode = useStore((s) => s.openCode);
  const m = /^([\w./@[\]-]+\.[\w]+):(\d+)(.*)$/.exec(text);
  if (!m) return <>{renderInlineCode(text)}</>;
  const [, p, line, rest] = m as unknown as [string, string, string, string];
  return (
    <>
      <button type="button" className="font-mono text-accent hover:underline" onClick={() => openCode(p, { focusLine: Number(line), lines: [Number(line), Number(line)] })}>
        {p}:{line}
      </button>
      {rest && <span>{renderInlineCode(rest)}</span>}
    </>
  );
}

type Merged = ChecklistItem & { ai?: boolean };

function Row({ item, extra }: { item: Merged; extra?: ReactNode }) {
  const [open, setOpen] = useState(item.status === "fail");
  return (
    <li className="border-b border-line last:border-b-0">
      <button type="button" className="flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-raised" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {open ? <IconChevronDown size={13} className="shrink-0 text-faint" /> : <IconChevronRight size={13} className="shrink-0 text-faint" />}
        <StatusPill status={item.status} />
        <span className={cx("min-w-0 flex-1 text-[12.5px]", item.status === "na" ? "text-muted" : "text-fg")}>{item.title}</span>
        {item.ai && (
          <span className="shrink-0 rounded border border-accent/40 px-1 font-mono text-[9.5px] text-accent" title="Status from the AI audit">
            AI
          </span>
        )}
        {!open && <span className="hidden min-w-0 max-w-[40%] truncate text-[11.5px] text-faint md:block">{item.evidence[0]}</span>}
      </button>
      {open && (
        <div className="space-y-1.5 pb-3 pl-[118px] pr-3 text-[12px] text-muted">
          <ul className="space-y-0.5">
            {item.evidence.map((e, i) => (
              <li key={i}>
                <Evidence text={e} />
              </li>
            ))}
          </ul>
          {item.fix && (
            <p className="text-fg">
              <span className="text-faint">Fix: </span>
              {renderInlineCode(item.fix)}
            </p>
          )}
          {extra}
        </div>
      )}
    </li>
  );
}

export function Checklist() {
  const model = useModel();
  const audit = useStore((s) => s.audit);
  const items: Merged[] = useMemo(() => {
    const base = model.graph.security?.checklist ?? [];
    const ai = new Map((audit?.items ?? []).map((i) => [i.id, i]));
    // The audit confirms or overturns scanner results; manual items stay the owner's.
    return base.map((c) => {
      const v = ai.get(c.id);
      return v && c.status !== "manual" ? { ...c, status: v.status, evidence: v.evidence.length ? v.evidence : c.evidence, fix: v.fix ?? (v.status === "fail" ? c.fix : undefined), ai: true } : c;
    });
  }, [model, audit]);
  const counts = useMemo(() => {
    const c = new Map<CheckStatus, number>();
    for (const i of items) c.set(i.status, (c.get(i.status) ?? 0) + 1);
    return c;
  }, [items]);

  if (!items.length) {
    return <p className="p-4 text-[12.5px] text-muted">No checklist in this graph. Rescan with the current version of Lens to build it.</p>;
  }
  const shown = (tier: number) =>
    items
      .filter((i) => i.tier === tier)
      .sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status));

  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-3 py-2">
        {ORDER.map((s) => (
          <span key={s} className="flex items-center gap-1.5 text-[12px]" title={STATUS_META[s].hint}>
            <span className="h-2 w-2 rounded-full" style={{ background: STATUS_META[s].color }} />
            <span className="font-mono font-semibold tabular">{counts.get(s) ?? 0}</span>
            <span className="text-muted">{STATUS_META[s].label}</span>
          </span>
        ))}
      </div>
      <AuditAI unresolved={counts.get("unverified") ?? 0} />
      <Remediation source="audit" />
      {TIERS.map(({ tier, name }) => {
        const list = shown(tier);
        if (!list.length) return null;
        return (
          <section key={tier}>
            <h3 className="eyebrow sticky top-0 z-[1] border-b border-line bg-panel px-3 py-1.5">{name}</h3>
            <ul>
              {list.map((i) => (
                <Row key={i.id} item={i} />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
