import { memo, type CSSProperties } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import type { VNode } from "../types";
import { AUTH_COLOR, METHOD_COLOR, SEVERITY_COLOR } from "../utils/colors";
import { fmtNum } from "../utils/format";
import { useStore } from "../store";
import { IconArrowUp, IconChevronRight, IconCollapse, IconDroplet, IconFolder, IconGlobe, IconLock, IconUnlock } from "./icons";
import { KindBadge, RiskDot, cx } from "./ui";

export interface LensNodeData extends Record<string, unknown> {
  v: VNode;
  state?: "hl" | "changed" | "impacted";
  impact?: number;
  selected?: boolean;
}
export type LensNode = Node<LensNodeData>;

function stateClass(d: LensNodeData): string {
  return cx(d.selected && "is-selected", d.state === "hl" && "is-hl", d.state === "changed" && "is-changed", d.state === "impacted" && "is-impacted");
}
function stateStyle(d: LensNodeData): CSSProperties | undefined {
  if (d.state !== "impacted") return undefined;
  const alpha = d.impact === 1 ? 100 : d.impact === 2 ? 70 : 45;
  return { outlineColor: `color-mix(in srgb, var(--accent) ${alpha}%, transparent)` };
}

function LRHandles() {
  return (
    <>
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </>
  );
}

function Stripe({ color }: { color?: string }) {
  return <span aria-hidden className="w-[3px] shrink-0 self-stretch rounded-l-[7px]" style={{ background: color ?? "var(--border-strong)" }} />;
}

export const FileNode = memo(function FileNode({ data }: NodeProps<LensNode>) {
  const v = data.v;
  const toggle = useStore((s) => s.toggleExpanded);
  if (v.expanded) {
    return (
      <div className={cx("lens-node h-full w-full !bg-[color-mix(in_srgb,var(--panel)_70%,transparent)]", stateClass(data))} style={stateStyle(data)}>
        <div className="flex h-[30px] items-center gap-1.5 border-b border-line px-2.5">
          <span aria-hidden className="h-3 w-[3px] rounded-full" style={{ background: v.color ?? "var(--border-strong)" }} />
          <KindBadge kind={v.kind} />
          <span className="min-w-0 flex-1 truncate text-[12px] font-medium">{v.label}</span>
          <RiskDot severity={v.risk} />
          <button
            type="button"
            className="nodrag inline-flex h-5 w-5 items-center justify-center rounded text-muted hover:bg-raised hover:text-fg"
            aria-label={`Collapse ${v.label}`}
            title="Collapse symbols"
            onClick={(e) => {
              e.stopPropagation();
              if (v.graphId) toggle(v.graphId);
            }}
          >
            <IconCollapse size={12} />
          </button>
        </div>
        <LRHandles />
      </div>
    );
  }
  return (
    <div className={cx("lens-node flex h-full w-full items-stretch", stateClass(data))} style={stateStyle(data)} title={v.graphId}>
      <Stripe color={v.color} />
      <div className="flex min-w-0 flex-1 flex-col justify-center px-2.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <KindBadge kind={v.kind} />
          <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium leading-tight">{v.label}</span>
          {v.stale && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" title="Summary out of date" aria-label="stale" />}
          <RiskDot severity={v.risk} />
        </div>
        <div className="mt-[3px] truncate font-mono text-[10px] text-muted tabular">{v.sub ?? (v.loc ? `${fmtNum(v.loc)} lines` : v.kind)}</div>
      </div>
      {v.expandable && (
        <button
          type="button"
          className="nodrag my-auto mr-1.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded border border-transparent text-muted hover:border-line hover:bg-raised hover:text-fg"
          aria-label={`Show symbols in ${v.label}`}
          title="Show functions & classes"
          onClick={(e) => {
            e.stopPropagation();
            if (v.graphId) toggle(v.graphId);
          }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
        </button>
      )}
      <LRHandles />
    </div>
  );
});

export const FolderNode = memo(function FolderNode({ data }: NodeProps<LensNode>) {
  const v = data.v;
  const setDir = useStore((s) => s.setDir);
  const total = (v.layerMix ?? []).reduce((a, m) => a + m.n, 0) || 1;
  return (
    <div className={cx("lens-node flex h-full w-full flex-col justify-between !bg-panel-2 px-3 pb-2.5 pt-2", stateClass(data))} style={stateStyle(data)} title="Double-click to open">
      <span aria-hidden className="absolute -top-[5px] left-2.5 h-[5px] w-10 rounded-t-[4px] border border-b-0 border-line bg-panel-2" />
      <div className="flex min-w-0 items-center gap-1.5">
        <IconFolder size={14} className="shrink-0 text-accent" />
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold">{v.label}</span>
        <RiskDot severity={v.risk} />
        <button
          type="button"
          className="nodrag -mr-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted hover:bg-raised hover:text-fg"
          aria-label={`Open folder ${v.label}`}
          onClick={(e) => {
            e.stopPropagation();
            if (v.dir !== undefined) setDir(v.dir);
          }}
        >
          <IconChevronRight size={14} />
        </button>
      </div>
      <div className="font-mono text-[10.5px] text-muted tabular">
        {fmtNum(v.fileCount)} files · {fmtNum(v.loc)} lines
      </div>
      <div className="flex h-[5px] w-full overflow-hidden rounded-full bg-raised" role="img" aria-label={(v.layerMix ?? []).map((m) => `${m.name} ${m.n}`).join(", ")}>
        {(v.layerMix ?? []).map((m) => (
          <span key={m.name} title={`${m.name}: ${m.n}`} style={{ width: `${(m.n / total) * 100}%`, background: m.color }} />
        ))}
      </div>
      <LRHandles />
    </div>
  );
});

export const GroupNode = memo(function GroupNode({ data }: NodeProps<LensNode>) {
  const v = data.v;
  return (
    <div className={cx("h-full w-full rounded-xl border border-line", data.state === "changed" && "border-accent")} style={{ background: "color-mix(in srgb, var(--panel) 42%, transparent)" }}>
      <div className="flex h-[30px] items-center gap-1.5 px-3 font-mono text-[11px] text-muted">
        <IconFolder size={12} className="shrink-0" />
        <span className="truncate">{v.label}</span>
        <span className="ml-auto shrink-0 tabular text-faint">{v.fileCount}</span>
      </div>
    </div>
  );
});

export const SymbolNode = memo(function SymbolNode({ data }: NodeProps<LensNode>) {
  const v = data.v;
  return (
    <div className={cx("lens-node flex h-full w-full items-center gap-1.5 !rounded-md px-2", stateClass(data))} style={stateStyle(data)} title={v.graphId}>
      <span aria-hidden className="h-3 w-[3px] shrink-0 rounded-full" style={{ background: v.color ?? "var(--border-strong)" }} />
      <KindBadge kind={v.kind} />
      <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]">{v.label}</span>
      {v.sub && <span className="max-w-[40%] shrink-0 truncate text-[10px] text-faint">{v.sub}</span>}
      <RiskDot severity={v.risk} />
      <LRHandles />
    </div>
  );
});

export const MoreNode = memo(function MoreNode({ data }: NodeProps<LensNode>) {
  return (
    <div className="flex h-full w-full items-center justify-center rounded-lg border border-dashed border-line-strong text-[12px] text-muted">
      {data.v.label}
      <LRHandles />
    </div>
  );
});

export const ExternalNode = memo(function ExternalNode({ data }: NodeProps<LensNode>) {
  const v = data.v;
  return (
    <div className={cx("flex h-full w-full items-center gap-2 rounded-lg border border-dashed border-line-strong px-3 text-muted", data.state === "hl" && "border-accent")} title="Double-click to go up">
      <IconArrowUp size={14} />
      <div className="min-w-0">
        <div className="truncate text-[12px] text-fg">{v.label}</div>
        <div className="font-mono text-[10.5px]">{v.sub}</div>
      </div>
      <LRHandles />
    </div>
  );
});

export const LayerHeaderNode = memo(function LayerHeaderNode({ data }: NodeProps<LensNode>) {
  const v = data.v;
  return (
    <div
      className={cx("lens-node flex h-full w-full cursor-pointer flex-col justify-center overflow-hidden px-3", stateClass(data))}
      title="Click to isolate this layer"
    >
      <span aria-hidden className="absolute inset-x-0 top-0 h-[3px]" style={{ background: v.color }} />
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate font-serif text-[16px]">{v.label}</span>
        <span className="font-mono text-[11px] text-muted tabular">{v.sub}</span>
      </div>
      <Handle type="source" id="top" position={Position.Top} isConnectable={false} />
      <Handle type="target" id="top" position={Position.Top} isConnectable={false} />
    </div>
  );
});

const AUTH_ICON = { guarded: IconLock, unguarded: IconUnlock, public: IconGlobe, unknown: IconUnlock } as const;

export const EntryNode = memo(function EntryNode({ data }: NodeProps<LensNode>) {
  const v = data.v;
  const auth = v.auth ?? "unknown";
  const Icon = AUTH_ICON[auth];
  const method = v.method ?? "";
  return (
    <div className={cx("lens-node flex h-full w-full items-stretch", stateClass(data))} style={stateStyle(data)} title={v.sub}>
      <span aria-hidden className="w-[3px] shrink-0 rounded-l-[7px]" style={{ background: AUTH_COLOR[auth] }} />
      <div className="flex min-w-0 flex-1 flex-col justify-center gap-[3px] px-2.5">
        <div className="flex min-w-0 items-center gap-1.5">
          {method && (
            <span className="shrink-0 rounded-[3px] px-1 font-mono text-[9.5px] font-bold leading-[15px]" style={{ color: METHOD_COLOR[method] ?? "var(--muted)", background: `color-mix(in srgb, ${METHOD_COLOR[method] ?? "var(--muted)"} 14%, transparent)` }}>
              {method}
            </span>
          )}
          <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]">{v.label}</span>
        </div>
        <div className="flex items-center gap-1 text-[10.5px]" style={{ color: AUTH_COLOR[auth] }}>
          <Icon size={11} />
          <span className="font-medium">{auth}</span>
        </div>
      </div>
      <LRHandles />
    </div>
  );
});

export const SinkNode = memo(function SinkNode({ data }: NodeProps<LensNode>) {
  const v = data.v;
  const sev = v.severity ?? "info";
  const muted = v.status === "false_positive" || v.status === "accepted";
  return (
    <div className={cx("lens-node flex h-full w-full items-stretch", stateClass(data), muted && "opacity-60")} style={stateStyle(data)}>
      <span aria-hidden className="w-[4px] shrink-0 rounded-l-[7px]" style={{ background: SEVERITY_COLOR[sev] }} />
      <div className="flex min-w-0 flex-1 flex-col justify-center gap-[2px] px-2.5">
        <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide" style={{ color: SEVERITY_COLOR[sev] }}>
          {sev}
          {v.tainted && (
            <span className="inline-flex items-center gap-0.5 normal-case tracking-normal text-accent" title="User-controlled input reaches this sink">
              <IconDroplet size={10} /> tainted
            </span>
          )}
          {v.status && v.status !== "open" && <span className="ml-auto rounded border border-line px-1 font-normal normal-case tracking-normal text-muted">{v.status.replace("_", " ")}</span>}
        </div>
        <div className={cx("truncate text-[12px] font-medium", v.status === "false_positive" && "line-through decoration-muted")}>{v.label}</div>
        <div className="truncate font-mono text-[10px] text-muted">{v.sub}</div>
      </div>
      <LRHandles />
    </div>
  );
});

export const DomainNode = memo(function DomainNode({ data }: NodeProps<LensNode>) {
  const v = data.v;
  return (
    <div className={cx("lens-node flex h-full w-full flex-col justify-center overflow-hidden px-3.5", stateClass(data))} style={stateStyle(data)}>
      <span aria-hidden className="absolute inset-y-0 left-0 w-[4px]" style={{ background: v.color }} />
      <span className="eyebrow !text-[9.5px]">Business Area</span>
      <span className="truncate font-serif text-[16.5px] leading-snug">{v.label}</span>
      <span className="text-[11px] text-muted">{v.sub}</span>
      <LRHandles />
    </div>
  );
});

export const FlowNode = memo(function FlowNode({ data }: NodeProps<LensNode>) {
  const v = data.v;
  return (
    <div className={cx("lens-node flex h-full w-full items-center gap-2 !rounded-full px-4", stateClass(data))} style={stateStyle(data)}>
      <span aria-hidden className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: v.color, boxShadow: `0 0 0 3px color-mix(in srgb, ${v.color} 25%, transparent)` }} />
      <div className="min-w-0">
        <div className="truncate text-[12.5px] font-medium">{v.label}</div>
        <div className="truncate text-[10.5px] text-muted">{v.sub}</div>
      </div>
      <LRHandles />
    </div>
  );
});

export const StepNode = memo(function StepNode({ data }: NodeProps<LensNode>) {
  const v = data.v;
  return (
    <div className={cx("lens-node flex h-full w-full items-center gap-2 px-3", stateClass(data), v.expanded && "!border-accent")} style={stateStyle(data)}>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12px] font-medium">{v.label}</div>
        <div className="truncate text-[10.5px] text-muted">{v.sub}</div>
      </div>
      {!!v.count && <IconChevronRight size={14} className={cx("shrink-0", v.expanded ? "text-accent" : "text-faint")} />}
      <LRHandles />
    </div>
  );
});

export const KnowledgeNode = memo(function KnowledgeNode({ data }: NodeProps<LensNode>) {
  const v = data.v;
  const big = v.kind === "topic";
  const r = big ? 18 : v.kind === "article" ? 12 : 9;
  return (
    <div className="relative flex h-full w-full flex-col items-center" title={`${v.kind}: ${v.label}`}>
      <span
        className={cx("block shrink-0 rounded-full border-2 transition-shadow", data.selected && "ring-2 ring-accent ring-offset-2 ring-offset-[var(--bg)]", data.state === "hl" && "ring-2 ring-accent")}
        style={{ width: r, height: r, background: big ? v.color : `color-mix(in srgb, ${v.color} 30%, var(--panel))`, borderColor: v.color }}
      />
      <span className={cx("mt-1 max-w-full truncate text-center leading-tight", big ? "font-serif text-[13px] text-fg" : "text-[11px] text-muted")}>{v.label}</span>
      <Handle type="source" position={Position.Top} style={{ top: r / 2, left: "50%" }} isConnectable={false} />
      <Handle type="target" position={Position.Top} style={{ top: r / 2, left: "50%" }} isConnectable={false} />
    </div>
  );
});

/** Non-interactive caption (column headers, spacers). */
export const LabelNode = memo(function LabelNode({ data }: NodeProps<LensNode>) {
  const v = data.v;
  if (!v.label) return <div aria-hidden className="h-full w-full" />;
  return (
    <div className="flex h-full w-full items-end gap-2 border-b border-line pb-1.5">
      <span className="eyebrow">{v.label}</span>
      {v.sub && <span className="font-mono text-[10.5px] text-faint">{v.sub}</span>}
    </div>
  );
});

export const nodeTypes = {
  label: LabelNode,
  file: FileNode,
  folder: FolderNode,
  lensgroup: GroupNode,
  symbol: SymbolNode,
  more: MoreNode,
  external: ExternalNode,
  layerHeader: LayerHeaderNode,
  entry: EntryNode,
  sink: SinkNode,
  domain: DomainNode,
  flow: FlowNode,
  step: StepNode,
  knode: KnowledgeNode,
};
