import { useMemo, useState, type ReactNode } from "react";
import type { CheckStatus } from "@lens/core/browser";
import { decideCheck } from "../api";
import { checkGroup, checkPrompt, mergeChecklist, type CheckGroup, type MergedCheck } from "../utils/security";
import { useStore } from "../store";
import { useModel } from "../views/hooks";
import { AuditAI } from "./AuditAI";
import { Remediation } from "./Remediation";
import { IconChevronDown, IconChevronRight } from "./icons";
import { cx, renderInlineCode } from "./ui";

const ORDER: CheckStatus[] = ["fail", "unverified", "manual", "clear", "pass", "na"];
const GROUPS: Array<{ group: CheckGroup; name: string }> = [
  { group: "fix", name: "To Fix" },
  { group: "you", name: "Needs You" },
  { group: "done", name: "Done" },
];

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

type Merged = MergedCheck;

/** Copies a Claude Code prompt for these checks. */
function CopyPrompt({ group, items, label }: { group: Exclude<CheckGroup, "done">; items: Merged[]; label: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(checkPrompt(group, items, TODO, items.map((i) => i.id)));
      setState("copied");
    } catch (e) {
      console.error("Copy failed", e);
      setState("failed");
    }
    setTimeout(() => setState("idle"), 2000);
  };
  return (
    <button type="button" className="text-[11.5px] text-accent hover:underline" title="Paste into Claude Code" onClick={() => void copy()}>
      {state === "copied" ? "Copied" : state === "failed" ? "Copy Failed" : label}
    </button>
  );
}

function Row({ item, extra }: { item: Merged; extra?: ReactNode }) {
  const [open, setOpen] = useState(item.status === "fail");
  return (
    <li className="border-b border-line last:border-b-0">
      <button type="button" className="flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-raised" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {open ? <IconChevronDown size={13} className="shrink-0 text-faint" /> : <IconChevronRight size={13} className="shrink-0 text-faint" />}
        <span className={cx("min-w-0 flex-1 text-[12.5px]", item.status === "na" ? "text-muted" : "text-fg")}>{item.title}</span>
        {item.status === "na" && <span className="shrink-0 text-[11px] text-faint">N/A</span>}
        {item.ai && (
          <span className="shrink-0 rounded border border-accent/40 px-1 font-mono text-[9.5px] text-accent" title="Status from the AI audit">
            AI
          </span>
        )}
        {item.by === "you" && (
          <span className="shrink-0 rounded border border-line px-1 font-mono text-[9.5px] text-muted" title="Marked by you">
            YOU
          </span>
        )}
        {!open && <span className="hidden min-w-0 max-w-[40%] truncate text-[11.5px] text-faint md:block">{item.evidence[0]}</span>}
      </button>
      {open && (
        <div className="space-y-1.5 pb-3 pl-[34px] pr-3 text-[12px] text-muted">
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
          {(decidable(item) || item.by === "you") && <Decide item={item} />}
          {checkGroup(item.status) !== "done" && <CopyPrompt group={checkGroup(item.status) as "fix" | "you"} items={[item]} label="Copy Prompt" />}
        </div>
      )}
    </li>
  );
}

const decidable = (i: Merged) => checkGroup(i.status) === "you";

const CHOICES = [
  { status: "pass", label: "Done" },
  { status: "na", label: "Doesn't Apply" },
] as const;

/** What to do for checks Lens can't settle from the code. */
const TODO: Record<string, string> = {
  "t1-git-secrets": "Rotate each key listed. It stays in git history after it's deleted.",
  "t1-spend": "Set a monthly limit in each AI provider's billing console.",
  "t1-env": "Gitignore .env, add .env.example, and add a gitleaks pre-commit hook.",
  "t1-stripe": "Take prices from the server and grant access only in the verified webhook.",
  "t2-prodcreds": "Keep production keys in your host's settings, not in local files.",
  "t2-staging": "Give staging and previews their own database and keys.",
  "t2-storage": "Make buckets private and serve files through signed URLs.",
  "t3-realdeps": "Confirm every package in the manifest exists, is maintained, and is spelled right.",
  "t3-agentcfg": "Read CLAUDE.md, skills and MCP configs for secrets or risky commands.",
  "t3-rls": "Keep clients off the database, or turn on row-level security for every table.",
  "t3-logs": "Keep auth headers, cookies, tokens, passwords and personal data out of logs.",
  "t3-auditlog": "Log logins, permission changes, deletes, exports and payments.",
  "t3-backups": "Turn on backups and test a restore.",
};

function Decide({ item }: { item: Merged }) {
  const mode = useStore((s) => s.mode);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (mode !== "server") return null;
  const choose = async (status: "pass" | "fail" | "na" | null) => {
    setBusy(true);
    setErr(null);
    try {
      useStore.setState({ audit: await decideCheck(item.id, status) });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
    {TODO[item.id] && <p className="pt-1 text-fg">{renderInlineCode(TODO[item.id]!)}</p>}
    <div className="flex flex-wrap items-center gap-1.5 pt-1">
      {CHOICES.map((c) => (
        <button
          key={c.status}
          type="button"
          disabled={busy}
          onClick={() => void choose(c.status)}
          className={cx("rounded border px-2 py-0.5 text-[11.5px] disabled:opacity-50", item.by === "you" && item.status === c.status ? "border-accent text-accent" : "border-line text-fg hover:bg-raised")}
        >
          {c.label}
        </button>
      ))}
      {item.by === "you" && (
        <button type="button" disabled={busy} onClick={() => void choose(null)} className="px-1 text-[11.5px] text-muted hover:text-fg disabled:opacity-50">
          Reset
        </button>
      )}
      {err && <span className="text-critical">{err}</span>}
    </div>
    </>
  );
}

export function Checklist() {
  const model = useModel();
  const audit = useStore((s) => s.audit);
  const items: Merged[] = useMemo(() => mergeChecklist(model.graph.security?.checklist ?? [], audit), [model, audit]);
  const [showDone, setShowDone] = useState(false);

  if (!items.length) {
    return <p className="p-4 text-[12.5px] text-muted">No checklist in this graph. Rescan with the current version of Lens to build it.</p>;
  }
  const inGroup = (group: CheckGroup) =>
    items.filter((i) => checkGroup(i.status) === group).sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || a.tier - b.tier);
  const unverified = items.filter((i) => i.status === "unverified").length;

  return (
    <div>
      <AuditAI unresolved={unverified} />
      <Remediation source="audit" />
      {GROUPS.map(({ group, name }) => {
        const list = inGroup(group);
        if (!list.length) return null;
        const collapsed = group === "done" && !showDone;
        return (
          <section key={group}>
            <h3 className="sticky top-0 z-[1] flex items-center border-b border-line bg-panel px-3 py-1.5">
              <button type="button" className="eyebrow flex items-center gap-1.5 hover:!text-fg" disabled={group !== "done"} onClick={() => setShowDone((v) => !v)} aria-expanded={!collapsed}>
                {group === "done" && (collapsed ? <IconChevronRight size={11} /> : <IconChevronDown size={11} />)}
                {name}
                <span className={cx("font-mono", group === "fix" ? "text-critical" : "text-faint")}>{list.length}</span>
              </button>
              {group !== "done" && <span className="ml-auto"><CopyPrompt group={group} items={list} label="Copy All" /></span>}
            </h3>
            {!collapsed && (
              <ul>
                {list.map((i) => (
                  <Row key={i.id} item={i} />
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}
