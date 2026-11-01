import { useMemo, useState } from "react";
import type { EdgeKind, GraphNode } from "@lens/core/browser";
import { useStore } from "../../store";
import { AUTH_COLOR, METHOD_COLOR, layerColor } from "../../utils/colors";
import { fmtNum } from "../../utils/format";
import { findingsWithin } from "../../utils/model";
import { useModel } from "../../views/hooks";
import { IconCode, IconDroplet, IconRoute, IconTarget } from "../icons";
import { Button, Chip, KindBadge, Section, SeverityBadge, cx } from "../ui";

const IN_LABEL: Partial<Record<EdgeKind, string>> = {
  contains: "contained in",
  imports: "imported by",
  exports: "exported by",
  inherits: "inherited by",
  implements: "implemented by",
  calls: "called by",
  subscribes: "subscribed by",
  publishes: "published by",
  middleware: "middleware of",
  reads_from: "read by",
  writes_to: "written by",
  transforms: "transformed by",
  validates: "validated by",
  depends_on: "depended on by",
  tested_by: "tests",
  configures: "configured by",
  related: "related",
  similar_to: "similar to",
  deploys: "deployed by",
  serves: "served by",
  provisions: "provisioned by",
  triggers: "triggered by",
  migrates: "migrated by",
  documents: "documented by",
  routes: "routed from",
  defines_schema: "schema defined by",
  contains_flow: "flow of",
  flow_step: "step of",
  cross_domain: "used by domain",
  implemented_by: "implements",
  links_to: "linked from",
  cites: "cited by",
  contradicts: "contradicted by",
  builds_on: "built on by",
  categorized_under: "categorizes",
};

interface RelGroup {
  key: string;
  label: string;
  ids: string[];
}

export function NodePanel() {
  const model = useModel();
  const id = useStore((s) => s.selectedId);
  const navigateTo = useStore((s) => s.navigateTo);
  const openCode = useStore((s) => s.openCode);
  const openPath = useStore((s) => s.openPathFinder);
  const selectFinding = useStore((s) => s.selectFinding);
  const requestFocus = useStore((s) => s.requestFocus);
  const [expandedRel, setExpandedRel] = useState<Record<string, boolean>>({});
  const node = id ? model.idx.nodes.get(id) : undefined;

  const groups = useMemo<RelGroup[]>(() => {
    if (!node) return [];
    const out = new Map<string, RelGroup>();
    const add = (key: string, label: string, other: string) => {
      const g = out.get(key) ?? { key, label, ids: [] };
      if (!g.ids.includes(other)) g.ids.push(other);
      out.set(key, g);
    };
    for (const e of model.idx.out.get(node.id) ?? []) add(`out:${e.kind}`, e.kind.replace(/_/g, " "), e.target);
    for (const e of model.idx.in.get(node.id) ?? []) add(`in:${e.kind}`, IN_LABEL[e.kind] ?? `← ${e.kind.replace(/_/g, " ")}`, e.source);
    const order = (k: string) => (k.includes("contains") ? 2 : k.startsWith("out:") ? 0 : 1);
    return [...out.values()].sort((a, b) => order(a.key) - order(b.key) || b.ids.length - a.ids.length);
  }, [model, node]);

  if (!node) {
    return <p className="p-4 text-[12.5px] text-muted">Select a node on the canvas, in search, or in the file tree to see its details.</p>;
  }
  const layerId = model.layerOf.get(node.id);
  const layer = layerId ? model.layerById.get(layerId) : undefined;
  const findings = findingsWithin(model, node.id);
  const ep = node.endpoint;
  const filePath = node.path ?? model.fileById.get(model.owner.get(node.id) ?? "")?.path;
  const location = node.path ? `${node.path}${node.lines ? `:${node.lines[0]}–${node.lines[1]}` : ""}` : undefined;

  return (
    <div>
      <div className="border-b border-line px-4 pb-4 pt-4">
        <div className="flex items-center gap-2">
          <KindBadge kind={node.kind} />
          {layer && (
            <span className="inline-flex items-center gap-1 text-[11px] text-muted">
              <span className="h-2 w-2 rounded-sm" style={{ background: layerColor(layer) }} />
              {layer.name}
            </span>
          )}
          <span className={cx("ml-auto text-[11px]", node.complexity === "complex" ? "text-[var(--sev-high)]" : node.complexity === "moderate" ? "text-[var(--sev-medium)]" : "text-muted")}>{node.complexity}</span>
        </div>
        <h2 className="mt-1.5 break-words font-serif text-[20px] leading-tight">{node.name}</h2>
        {location && (
          <div className="mt-1 break-all font-mono text-[11px] text-muted" title={node.id}>
            {location}
          </div>
        )}
        {node.summary && (
          <p className="mt-2.5 text-[12.5px] leading-relaxed text-fg">
            {node.summary}
            {node.summarySource === "heuristic" && <span className="ml-1.5 whitespace-nowrap text-[10.5px] italic text-faint">Automatic summary</span>}
          </p>
        )}
        {node.stale && <p className="mt-1.5 text-[11px] text-accent">Source changed since this summary was written.</p>}
        <div className="mt-3 flex flex-wrap gap-1.5">
          {filePath && (
            <Button size="sm" onClick={() => openCode(filePath, { lines: node.lines, focusLine: node.lines?.[0], title: node.name })}>
              <IconCode size={13} /> Open source
            </Button>
          )}
          <Button size="sm" onClick={() => openPath(node.id)}>
            <IconRoute size={13} /> Find path from here
          </Button>
          <Button size="sm" variant="ghost" onClick={() => requestFocus([node.id])}>
            <IconTarget size={13} /> Center
          </Button>
        </div>
      </div>

      {node.notes && (
        <Section title="Notes">
          <p className="rounded-md border-l-2 border-accent bg-accent-soft px-3 py-2 text-[12px] leading-relaxed">{node.notes}</p>
        </Section>
      )}

      {ep && (
        <Section title="Endpoint">
          <div className="flex items-center gap-2">
            {ep.method && (
              <span className="rounded px-1.5 font-mono text-[11px] font-bold" style={{ color: METHOD_COLOR[ep.method] ?? "var(--muted)", background: `color-mix(in srgb, ${METHOD_COLOR[ep.method] ?? "var(--muted)"} 14%, transparent)` }}>
                {ep.method}
              </span>
            )}
            <span className="break-all font-mono text-[12px]">{ep.route}</span>
          </div>
          <dl className="mt-2 grid grid-cols-[72px_1fr] gap-y-1 text-[12px]">
            <dt className="text-muted">Auth</dt>
            <dd className="font-medium" style={{ color: AUTH_COLOR[ep.auth] }}>
              {ep.auth}
            </dd>
            {ep.authEvidence && (
              <>
                <dt className="text-muted">Evidence</dt>
                <dd className="text-muted">{ep.authEvidence}</dd>
              </>
            )}
            <dt className="text-muted">Type</dt>
            <dd>
              {ep.entryType}
              {ep.framework ? ` · ${ep.framework}` : ""}
            </dd>
            {ep.handlerId && (
              <>
                <dt className="text-muted">Handler</dt>
                <dd>
                  <button type="button" className="break-all text-left font-mono text-[11.5px] text-accent hover:underline" onClick={() => navigateTo(ep.handlerId!)}>
                    {model.idx.nodes.get(ep.handlerId)?.name ?? ep.handlerId}
                  </button>
                </dd>
              </>
            )}
          </dl>
        </Section>
      )}

      {findings.length > 0 && (
        <Section title={`Findings · ${findings.length}`}>
          <ul className="space-y-1.5">
            {findings.map((f) => (
              <li key={f.id}>
                <button type="button" onClick={() => selectFinding(f.id)} className="w-full rounded-md border border-line px-2.5 py-2 text-left hover:border-line-strong hover:bg-raised">
                  <div className="flex items-center gap-2">
                    <SeverityBadge severity={f.severity} />
                    <span className={cx("min-w-0 flex-1 truncate text-[12px] font-medium", f.status === "false_positive" && "text-muted line-through")}>{f.title}</span>
                    {f.tainted && <IconDroplet size={12} className="shrink-0 text-accent" aria-label="tainted" />}
                  </div>
                  <div className="mt-1 font-mono text-[10.5px] text-muted">
                    {f.cwe ? `${f.cwe} · ` : ""}line {f.line} · {f.status.replace("_", " ")}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {(node.signature || node.tags.length > 0 || node.metrics) && (
        <Section title="Details">
          {node.signature && <pre className="mb-2.5 overflow-x-auto whitespace-pre-wrap break-words rounded-md border border-line bg-panel-2 px-2.5 py-2 font-mono text-[11.5px] leading-relaxed">{node.signature}</pre>}
          {node.tags.length > 0 && (
            <div className="mb-2.5 flex flex-wrap gap-1">
              {node.tags.map((t) => (
                <Chip key={t}>#{t}</Chip>
              ))}
            </div>
          )}
          {node.metrics && <Metrics node={node} />}
        </Section>
      )}

      <Section title="Relations" className="border-b-0">
        {groups.length === 0 && <p className="text-[12px] text-muted">No relations.</p>}
        <ul className="space-y-2">
          {groups.map((g) => {
            const open = expandedRel[g.key] ?? g.ids.length <= 6;
            const shown = open ? g.ids : g.ids.slice(0, 4);
            return (
              <li key={g.key}>
                <div className="mb-1 flex items-baseline gap-1.5 text-[11.5px]">
                  <span className="font-medium text-fg">{g.label}</span>
                  <span className="font-mono text-muted tabular">{g.ids.length}</span>
                </div>
                <ul className="space-y-px">
                  {shown.map((oid) => (
                    <RelItem key={oid} n={model.idx.nodes.get(oid)} id={oid} onClick={() => navigateTo(oid)} />
                  ))}
                </ul>
                {g.ids.length > shown.length && (
                  <button type="button" className="mt-0.5 pl-1.5 text-[11px] text-accent hover:underline" onClick={() => setExpandedRel((s) => ({ ...s, [g.key]: true }))}>
                    Show {g.ids.length - shown.length} more
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      </Section>
    </div>
  );
}

function RelItem({ n, id, onClick }: { n?: GraphNode; id: string; onClick: () => void }) {
  return (
    <li>
      <button type="button" onClick={onClick} className="flex w-full items-center gap-1.5 rounded px-1.5 py-[3px] text-left hover:bg-raised">
        <KindBadge kind={n?.kind} />
        <span className="min-w-0 flex-1 truncate text-[12px]">{n?.name ?? id}</span>
        {n?.path && <span className="max-w-[45%] truncate font-mono text-[10px] text-faint">{n.path.split("/").pop()}</span>}
      </button>
    </li>
  );
}

function Metrics({ node }: { node: GraphNode }) {
  const m = node.metrics!;
  const items: Array<[string, number | undefined]> = [
    ["LOC", m.loc],
    ["Fan in", m.fanIn],
    ["Fan out", m.fanOut],
    ["Branches", m.branches],
  ];
  return (
    <dl className="grid grid-cols-4 gap-1.5">
      {items
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => (
          <div key={k} className="rounded border border-line bg-panel-2 px-2 py-1">
            <dt className="text-[10px] text-muted">{k}</dt>
            <dd className="font-mono text-[13px] tabular">{fmtNum(v)}</dd>
          </div>
        ))}
    </dl>
  );
}
