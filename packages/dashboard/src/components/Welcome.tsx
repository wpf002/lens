import { useEffect, useMemo, type KeyboardEvent, type ReactNode } from "react";
import { useStore } from "../store";
import type { ViewId } from "../types";
import { plural } from "../utils/format";
import { savePrefs } from "../utils/storage";
import { useModel } from "../views/hooks";
import { OwlPixels } from "./Mascot";
import { Button, cx } from "./ui";

/** Deterministic PRNG so the codebase tangle looks the same on every open. */
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CY = 230; // main path baseline
const STEPS = [
  { x: 370, n: 1, label: "SCAN" },
  { x: 470, n: 2, label: "MAP" },
  { x: 570, n: 3, label: "TEACH" },
  { x: 670, n: 4, label: "GUARD" },
];
const HUB = STEPS[3]!.x;
const ROWS = { tree: 56, chain: 170, mesh: 280, attack: 384 };

function useTangle() {
  return useMemo(() => {
    const r = mulberry32(1104);
    // Random point inside the codebase ellipse.
    const pt = (bias = 0) => {
      const a = r() * Math.PI * 2;
      const d = Math.sqrt(r());
      return { x: 165 + Math.cos(a) * 130 * d + bias, y: CY + Math.sin(a) * 165 * d };
    };
    const f = (n: number) => n.toFixed(1);
    const strands = Array.from({ length: 52 }, () => {
      const [a, b, c, d] = [pt(), pt(), pt(), pt()];
      return `M${f(a.x)} ${f(a.y)} C${f(b.x)} ${f(b.y)} ${f(c.x)} ${f(c.y)} ${f(d.x)} ${f(d.y)}`;
    });
    const funnel = Array.from({ length: 18 }, () => {
      const a = pt(40);
      const c = pt(60);
      return `M${f(a.x)} ${f(a.y)} C${f(c.x)} ${f(c.y)} 280 ${CY} 318 ${CY}`;
    });
    const files = Array.from({ length: 22 }, () => {
      const p = pt();
      return { x: p.x - 7, y: p.y - 9, code: r() > 0.6 };
    });
    return { strands, funnel, files };
  }, []);
}

function Dot({ x, y, r = 5, hot }: { x: number; y: number; r?: number; hot?: boolean }) {
  return <circle cx={x} cy={y} r={r} fill={hot ? "var(--sev-high)" : "#f3b453"} stroke={hot ? "#ffb38a" : "#ffe2a8"} strokeWidth={1.2} filter="url(#lw-glow)" />;
}

function Dest({ label, x, y, labelDy = 38, onPick, disabled, children, tag }: { label: string; x: number; y: number; labelDy?: number; onPick: () => void; disabled?: boolean; children: ReactNode; tag?: string }) {
  const onKey = (e: KeyboardEvent<SVGGElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onPick();
    }
  };
  return (
    <g
      className={cx("lens-dest", disabled && "is-disabled")}
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled || undefined}
      aria-label={`${label}${disabled ? " (not available for this graph)" : ""}`}
      onClick={disabled ? undefined : onPick}
      onKeyDown={disabled ? undefined : onKey}
    >
      <rect x={748} y={y - 44} width={250} height={labelDy + 52} rx={10} className="lens-dest-hit" />
      {children}
      <text x={x} y={y + labelDy} textAnchor="middle" className="lens-dest-label">
        {label}
      </text>
      {tag && (
        <g transform={`translate(${x + label.length * 4.4 + 10} ${y + labelDy - 10})`}>
          <rect width={30} height={14} rx={7} fill="var(--sev-high)" opacity={0.9} />
          <text x={15} y={10.2} textAnchor="middle" className="lens-dest-tag">
            {tag}
          </text>
        </g>
      )}
    </g>
  );
}

export function Welcome() {
  const model = useModel();
  const meta = useStore((s) => s.meta);
  const { strands, funnel, files } = useTangle();
  const g = model.graph;
  const sec = g.security?.summary;
  const endpoints = sec ? sec.guardedEndpoints + sec.unguardedEndpoints + sec.publicEndpoints : 0;
  const findings = g.security?.findings.length ?? 0;
  const hasTour = g.tour.length > 0;

  useEffect(() => {
    savePrefs({ introSeen: true });
  }, []);

  const s = useStore.getState;
  const close = () => s().setModal(null);
  const go = (v: ViewId) => () => {
    close();
    s().setView(v);
  };
  const chips: Array<{ label: string; run: () => void; disabled?: boolean }> = [
    { label: "Guided Tour", run: () => (close(), s().startTour()), disabled: !hasTour },
    { label: "Semantic Search", run: () => (close(), s().focusSearch()) },
    { label: "Diff Impact", run: () => (close(), void s().toggleDiff(true)), disabled: !meta?.git },
    { label: "Layer View", run: go("layers") },
    { label: "Path Finder", run: () => s().openPathFinder() },
    { label: "Security Map", run: go("security") },
  ];

  return (
    <div
      className="lens-welcome-backdrop fixed inset-0 z-50 flex items-start justify-center overflow-auto p-3 sm:items-center sm:p-6"
      onMouseDown={(e) => e.target === e.currentTarget && close()}
    >
      <div role="dialog" aria-modal="true" aria-labelledby="lens-welcome-title" className="lens-welcome lens-rise relative w-full max-w-[1040px] rounded-2xl border border-line px-4 pb-5 pt-6 sm:px-8">
        <div className="text-center">
          <div className="eyebrow font-mono">
            {g.project.name || "your project"}
            {g.project.homepage && (
              <>
                {" · "}
                <a href={g.project.homepage} target="_blank" rel="noopener noreferrer" className="normal-case text-accent hover:underline">
                  {g.project.homepage.replace(/^https?:\/\//, "")}
                </a>
              </>
            )}
          </div>
          <h1 id="lens-welcome-title" className="lens-title mt-1 font-serif text-[40px] leading-none sm:text-[52px]">
            Lens
          </h1>
          <p className="mt-2 font-serif text-[16px] text-fg sm:text-[18px]">Map it. Learn it. Guard it.</p>
          <p className="mt-1.5 font-mono text-[11.5px] text-muted tabular">
            {plural(model.totalFiles, "file")} · {plural(g.nodes.length, "node")} · {plural(endpoints, "endpoint")} · {plural(findings, "finding")}
          </p>
        </div>

        <svg viewBox="0 0 1000 430" className="mt-2 block h-auto w-full" role="img" aria-label="Lens scans your codebase, maps it, teaches it, and guards it">
          <defs>
            <filter id="lw-glow" x="-60%" y="-60%" width="220%" height="220%">
              <feGaussianBlur stdDeviation="3.2" result="b" />
              <feMerge>
                <feMergeNode in="b" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
            <linearGradient id="lw-strand" x1="0" x2="1">
              <stop offset="0" stopColor="#f3b453" stopOpacity="0" />
              <stop offset="1" stopColor="#f3b453" stopOpacity="0.9" />
            </linearGradient>
          </defs>

          {/* Your codebase: a tangle of files and imports */}
          <text x={40} y={40} className="lens-svg-eyebrow">
            YOUR CODEBASE
          </text>
          <g stroke="var(--faint)" strokeWidth={0.8} fill="none" opacity={0.55}>
            {strands.map((d, i) => (
              <path key={i} d={d} />
            ))}
          </g>
          {files.map((f, i) => (
            <g key={i} transform={`translate(${f.x.toFixed(1)} ${f.y.toFixed(1)})`}>
              <path d="M0 0h10l4 4v14H0z" fill="var(--panel-2)" stroke="var(--border-strong)" strokeWidth={0.9} />
              {f.code ? (
                <path d="M4 8 2 10.5 4 13M10 8l2 2.5-2 2.5" stroke="var(--muted)" strokeWidth={0.9} fill="none" />
              ) : (
                <path d="M3 7h8M3 10h8M3 13h5" stroke="var(--faint)" strokeWidth={0.9} />
              )}
            </g>
          ))}
          <g stroke="url(#lw-strand)" strokeWidth={1.1} fill="none" filter="url(#lw-glow)">
            {funnel.map((d, i) => (
              <path key={i} d={d} />
            ))}
          </g>

          {/* Scan -> Map -> Teach -> Guard */}
          <path d={`M318 ${CY} Q 344 ${CY - 8} 370 ${CY} T 470 ${CY} T 570 ${CY} T 670 ${CY}`} stroke="#f3b453" strokeWidth={2.4} fill="none" filter="url(#lw-glow)" />
          <path d={`M318 ${CY} Q 344 ${CY - 8} 370 ${CY} T 470 ${CY} T 570 ${CY} T 670 ${CY}`} className="lens-flow" stroke="#fff1cf" strokeWidth={2} fill="none" />

          {/* Branches out to what you get */}
          <g stroke="#f3b453" strokeWidth={1.8} fill="none" filter="url(#lw-glow)">
            {Object.values(ROWS).map((y) => (
              <path key={y} d={`M${HUB} ${CY} C ${HUB + 50} ${CY}, ${HUB + 40} ${y}, 790 ${y}`} />
            ))}
          </g>

          {STEPS.map((st) => (
            <g key={st.n}>
              <text x={st.x} y={CY - 30} textAnchor="middle" className="lens-step-label">
                {st.n} · {st.label}
              </text>
              <circle cx={st.x} cy={CY} r={15} fill="#1a1208" stroke={st.n === 4 ? "#ff9d5c" : "#f3b453"} strokeWidth={2.2} filter="url(#lw-glow)" />
              <text x={st.x} y={CY + 5.5} textAnchor="middle" className="lens-step-num">
                {st.n}
              </text>
            </g>
          ))}

          {/* Iris, pointing her wand at the new fourth step */}
          <g className="lens-float">
            <ellipse cx={470} cy={345} rx={34} ry={5} fill="#000" opacity={0.35} />
            <g transform="translate(430 262) scale(5)">
              <OwlPixels />
            </g>
            <path d="M505 312 L636 250" stroke="#b07a33" strokeWidth={3} strokeLinecap="round" />
            <path className="lens-twinkle" d="M640 238 l3 7 7 3 -7 3 -3 7 -3 -7 -7 -3 7 -3z" fill="#ffe2a8" filter="url(#lw-glow)" />
          </g>

          {/* Code structure: a tree */}
          <Dest label="CODE STRUCTURE" x={875} y={ROWS.tree} labelDy={52} onPick={go("structure")}>
            <g stroke="#f3b453" strokeWidth={1.2} opacity={0.75}>
              {[-24, 0, 24].map((dy) => (
                <line key={dy} x1={790} y1={ROWS.tree} x2={850} y2={ROWS.tree + dy} />
              ))}
              <line x1={850} y1={ROWS.tree - 24} x2={910} y2={ROWS.tree - 32} />
              <line x1={850} y1={ROWS.tree - 24} x2={910} y2={ROWS.tree - 14} />
              <line x1={850} y1={ROWS.tree} x2={910} y2={ROWS.tree} />
              <line x1={910} y1={ROWS.tree} x2={960} y2={ROWS.tree} />
              <line x1={850} y1={ROWS.tree + 24} x2={910} y2={ROWS.tree + 16} />
              <line x1={850} y1={ROWS.tree + 24} x2={910} y2={ROWS.tree + 32} />
            </g>
            <Dot x={790} y={ROWS.tree} r={6} />
            {[-24, 0, 24].map((dy) => (
              <Dot key={dy} x={850} y={ROWS.tree + dy} r={4.5} />
            ))}
            {[-32, -14, 0, 16, 32].map((dy) => (
              <Dot key={dy} x={910} y={ROWS.tree + dy} r={3.5} />
            ))}
            <Dot x={960} y={ROWS.tree} r={3.5} />
          </Dest>

          {/* Business logic: a flow */}
          <Dest label="BUSINESS LOGIC" x={875} y={ROWS.chain} onPick={go("domain")}>
            <line x1={790} y1={ROWS.chain} x2={960} y2={ROWS.chain} stroke="#f3b453" strokeWidth={1.4} opacity={0.75} />
            {[790, 832, 875, 918, 960].map((x) => (
              <Dot key={x} x={x} y={ROWS.chain} r={6} />
            ))}
          </Dest>

          {/* Knowledge base: a mesh */}
          <Dest label="KNOWLEDGE BASE" x={875} y={ROWS.mesh} labelDy={44} onPick={go("knowledge")} disabled={!model.hasKnowledge}>
            {(() => {
              const y = ROWS.mesh;
              const p = [
                [790, y],
                [832, y - 22],
                [880, y - 8],
                [930, y - 24],
                [962, y + 6],
                [905, y + 22],
                [845, y + 18],
              ] as const;
              const e = [
                [0, 1],
                [1, 2],
                [2, 3],
                [3, 4],
                [4, 5],
                [5, 6],
                [6, 0],
                [2, 5],
                [1, 6],
                [2, 4],
              ] as const;
              return (
                <>
                  <g stroke="#f3b453" strokeWidth={1.2} opacity={0.7}>
                    {e.map(([a, b]) => (
                      <line key={`${a}-${b}`} x1={p[a][0]} y1={p[a][1]} x2={p[b][0]} y2={p[b][1]} />
                    ))}
                  </g>
                  {p.map(([x, yy], i) => (
                    <Dot key={i} x={x} y={yy} r={i === 0 ? 6 : 4.5} />
                  ))}
                </>
              );
            })()}
          </Dest>

          {/* Attack surface: the step Lens adds */}
          <Dest label="ATTACK SURFACE" x={875} y={ROWS.attack} onPick={go("security")} tag="NEW">
            <path d={`M790 ${ROWS.attack} L960 ${ROWS.attack}`} stroke="#f3b453" strokeWidth={1.4} opacity={0.75} strokeDasharray="4 4" />
            <path
              d={`M790 ${ROWS.attack - 12} l10 4 v7 c0 6 -4 9 -10 12 c-6 -3 -10 -6 -10 -12 v-7z`}
              fill="#1a1208"
              stroke="#f3b453"
              strokeWidth={1.6}
              filter="url(#lw-glow)"
            />
            <Dot x={850} y={ROWS.attack} r={5} />
            <Dot x={905} y={ROWS.attack} r={5} />
            <circle className="lens-pulse" cx={960} cy={ROWS.attack} r={7} fill="none" stroke="var(--sev-high)" strokeWidth={1.5} />
            <Dot x={960} y={ROWS.attack} r={6} hot />
          </Dest>
        </svg>

        <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
          {chips.map((c) => (
            <button key={c.label} type="button" className="lens-chip" disabled={c.disabled} onClick={c.run}>
              {c.label}
            </button>
          ))}
        </div>

        <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
          {hasTour && (
            <Button
              onClick={() => {
                close();
                s().startTour();
              }}
            >
              Take the {g.tour.length}-Step Tour
            </Button>
          )}
          <Button variant="accent" autoFocus onClick={close}>
            Start Exploring
          </Button>
        </div>
        <p className="mt-3 text-center text-[11.5px] text-faint">
          Click any branch to jump there. Press <span className="font-mono text-muted">?</span> for shortcuts.
        </p>
      </div>
    </div>
  );
}
