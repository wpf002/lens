import { useMemo } from "react";
import { useStore } from "../../store";
import { layerColor, SEVERITY_WEIGHT } from "../../utils/colors";
import { fmtDate, fmtNum, pct } from "../../utils/format";
import { useModel } from "../../views/hooks";
import { IconGlobe, IconPlay } from "../icons";
import { SummarizeAI } from "../SummarizeAI";
import { Button, Chip, RiskDot, Section } from "../ui";

export function OverviewPanel() {
  const model = useModel();
  const navigateTo = useStore((s) => s.navigateTo);
  const startTour = useStore((s) => s.startTour);
  const g = model.graph;
  const p = g.project;

  const stats = useMemo(() => {
    const nodes = g.nodes.length;
    const llm = g.nodes.filter((n) => n.summarySource === "llm").length;
    const loc = g.stats?.loc || model.files.reduce((a, f) => a + f.loc, 0);
    return { files: model.files.length || g.stats?.files || 0, nodes, edges: g.edges.length, loc, llm, heuristic: nodes - llm };
  }, [g, model]);

  const layerRows = useMemo(() => {
    const counts = new Map<string, number>();
    for (const f of model.files) counts.set(f.layer ?? "", (counts.get(f.layer ?? "") ?? 0) + 1);
    // Knowledge graphs have no file nodes; fall back to the layer's own membership.
    const rows = model.layersSorted.map((l) => ({ id: l.id, name: l.name, color: layerColor(l), n: counts.get(l.id) ?? l.nodeIds.length }));
    if (counts.get("")) rows.push({ id: "", name: "Unassigned", color: "var(--faint)", n: counts.get("")! });
    return rows;
  }, [model]);
  const maxLayer = Math.max(1, ...layerRows.map((r) => r.n));

  const risky = useMemo(() => {
    const scored = model.files.map((f) => {
      const findings = (model.findingsByFile.get(f.id) ?? []).filter((x) => x.status !== "false_positive");
      const node = model.idx.nodes.get(f.id);
      const cx = node?.complexity === "complex" ? 1.5 : node?.complexity === "moderate" ? 0.5 : 0;
      const score = (model.riskScoreByFile.get(f.id) ?? 0) + cx * 0.5 + Math.log2(1 + f.degree) * 0.1;
      return { f, findings, score, top: findings.reduce((a, x) => (SEVERITY_WEIGHT[x.severity] > SEVERITY_WEIGHT[a] ? x.severity : a), findings[0]?.severity ?? "info") };
    });
    return scored.sort((a, b) => b.score - a.score).slice(0, 5);
  }, [model]);

  return (
    <div>
      <div className="border-b border-line px-4 pb-4 pt-4">
        <div className="eyebrow">Project</div>
        <h2 className="mt-1 font-serif text-[22px] leading-tight text-fg">{p.name}</h2>
        {p.homepage && (
          <a href={p.homepage} target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex items-center gap-1.5 font-mono text-[12px] text-accent hover:underline">
            <IconGlobe size={13} /> {p.homepage.replace(/^https?:\/\//, "")}
          </a>
        )}
        {p.description && <p className="mt-1.5 text-[12.5px] leading-relaxed text-muted">{p.description}</p>}
        <div className="mt-3 flex flex-wrap gap-1.5">
          {p.languages.map((l) => (
            <Chip key={l}>{l}</Chip>
          ))}
          {p.frameworks.map((f) => (
            <Chip key={f} className="!border-accent/40 !text-accent">
              {f}
            </Chip>
          ))}
        </div>
        {g.tour.length > 0 && (
          <Button variant="accent" size="sm" className="mt-3.5" onClick={() => startTour(0)}>
            <IconPlay size={12} /> Take the {g.tour.length}-Step Tour
          </Button>
        )}
      </div>

      <Section title="Stats">
        <dl className="grid grid-cols-4 gap-2">
          {(
            [
              ["Files", stats.files],
              ["Nodes", stats.nodes],
              ["Edges", stats.edges],
              ["LOC", stats.loc],
            ] as const
          ).map(([k, v]) => (
            <div key={k} className="rounded-md border border-line bg-panel-2 px-2 py-1.5">
              <dt className="text-[10.5px] text-muted">{k}</dt>
              <dd className="font-mono text-[15px] font-semibold tabular">{fmtNum(v)}</dd>
            </div>
          ))}
        </dl>
        <div className="mt-3">
          <div className="mb-1 flex justify-between text-[11px] text-muted">
            <span>
              <span className="text-accent">●</span> Written by Claude {pct(stats.llm, stats.nodes)}
            </span>
            <span>Automatic {pct(stats.heuristic, stats.nodes)}</span>
          </div>
          <div className="flex h-1.5 overflow-hidden rounded-full bg-raised" role="img" aria-label={`${pct(stats.llm, stats.nodes)} of summaries written by Claude`}>
            <span className="bg-accent" style={{ width: pct(stats.llm, stats.nodes) }} />
          </div>
          <SummarizeAI />
        </div>
      </Section>

      <Section title="Layers">
        <ul className="space-y-1.5">
          {layerRows.map((r) => (
            <li key={r.id} className="flex items-center gap-2 text-[12px]">
              <span className="w-[72px] shrink-0 truncate">{r.name}</span>
              <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-raised">
                <span className="block h-full rounded-full" style={{ width: `${(r.n / maxLayer) * 100}%`, background: r.color }} />
              </span>
              <span className="w-7 text-right font-mono text-[11px] text-muted tabular">{r.n}</span>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Riskiest files">
        <ol className="space-y-0.5">
          {risky.map(({ f, findings, top }, i) => (
            <li key={f.id}>
              <button type="button" onClick={() => navigateTo(f.id)} className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left hover:bg-raised">
                <span className="w-3 font-mono text-[11px] text-faint">{i + 1}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12.5px]">{f.name}</span>
                  <span className="block truncate font-mono text-[10.5px] text-muted">{f.dir || "/"}</span>
                </span>
                {findings.length > 0 ? (
                  <span className="flex items-center gap-1.5 text-[11px] text-muted">
                    <RiskDot severity={top} />
                    {findings.length}
                  </span>
                ) : (
                  <span className="text-[11px] text-faint">{fmtNum(f.loc)} loc</span>
                )}
              </button>
            </li>
          ))}
        </ol>
      </Section>

      <Section title="Snapshot" className="border-b-0">
        <dl className="grid grid-cols-[88px_1fr] gap-y-1 text-[12px]">
          <dt className="text-muted">Commit</dt>
          <dd className="font-mono">{p.gitCommit ? p.gitCommit.slice(0, 12) : "—"}</dd>
          <dt className="text-muted">Analyzed</dt>
          <dd>{fmtDate(p.analyzedAt)}</dd>
          <dt className="text-muted">Schema</dt>
          <dd className="font-mono">{g.schema}</dd>
        </dl>
      </Section>
    </div>
  );
}
