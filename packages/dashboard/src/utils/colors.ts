import type { EndpointMeta, Layer, NodeKind, Severity } from "@lens/core/browser";

export const SEVERITIES: Severity[] = ["critical", "high", "medium", "low", "info"];

export const SEVERITY_COLOR: Record<Severity, string> = {
  critical: "var(--sev-critical)",
  high: "var(--sev-high)",
  medium: "var(--sev-medium)",
  low: "var(--sev-low)",
  info: "var(--sev-info)",
};

/** Raw hex values, for places CSS variables can't reach (exports, canvas). */
export const SEVERITY_HEX: Record<Severity, string> = {
  critical: "#e5484d",
  high: "#f76b15",
  medium: "#ffc53d",
  low: "#3e9bff",
  info: "#8b8a88",
};

export const SEVERITY_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
export const SEVERITY_WEIGHT: Record<Severity, number> = { critical: 10, high: 5, medium: 2, low: 1, info: 0.2 };

export type Auth = EndpointMeta["auth"];
export const AUTH_COLOR: Record<Auth, string> = {
  guarded: "var(--auth-guarded)",
  unguarded: "var(--auth-unguarded)",
  public: "var(--auth-public)",
  unknown: "var(--auth-unknown)",
};

const LAYER_PALETTE: Record<string, string> = {
  ui: "#c084fc",
  api: "#60a5fa",
  service: "#34d399",
  data: "#fbbf24",
  infra: "#f472b6",
  utility: "#94a3b8",
  test: "#a3a3a3",
  config: "#22d3ee",
};

const LAYER_ALIASES: Array<[RegExp, keyof typeof LAYER_PALETTE]> = [
  [/^(ui|frontend|presentation|view|client|web)/, "ui"],
  [/^(api|route|controller|http|endpoint|interface)/, "api"],
  [/^(service|domain|business|logic|core|application)/, "service"],
  [/^(data|db|database|persistence|storage|model|repo)/, "data"],
  [/^(infra|deploy|ops|devops|platform)/, "infra"],
  [/^(util|shared|common|lib|helper)/, "utility"],
  [/^(test|spec|qa)/, "test"],
  [/^(config|settings|env|docs?)/, "config"],
];

/** Stable hash-derived color for anything without a palette entry. */
export function hashColor(key: string): string {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const hue = Math.abs(h) % 360;
  return hslToHex(hue, 55, 64);
}

function hslToHex(h: number, s: number, l: number): string {
  const sat = s / 100;
  const lig = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sat * Math.min(lig, 1 - lig);
  const f = (n: number) => lig - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const hex = (x: number) => Math.round(x * 255).toString(16).padStart(2, "0");
  return `#${hex(f(0))}${hex(f(8))}${hex(f(4))}`;
}

export function paletteKey(idOrName: string): string | undefined {
  const k = idOrName.toLowerCase().trim();
  if (k in LAYER_PALETTE) return k;
  for (const [re, key] of LAYER_ALIASES) if (re.test(k)) return key;
  return undefined;
}

/** Palette by id/name, then layer.color, then a hash. */
export function layerColor(layer: Pick<Layer, "id" | "name" | "color"> | undefined, fallbackId?: string): string {
  if (!layer) return fallbackId ? colorForLayerId(fallbackId) : "var(--faint)";
  const key = paletteKey(layer.id) ?? paletteKey(layer.name);
  if (key) return LAYER_PALETTE[key]!;
  if (layer.color) return layer.color;
  return hashColor(layer.id);
}

export function colorForLayerId(id: string): string {
  const key = paletteKey(id);
  return key ? LAYER_PALETTE[key]! : hashColor(id);
}

export const KIND_LABEL: Record<NodeKind, string> = {
  file: "file",
  function: "fn",
  class: "class",
  module: "mod",
  concept: "idea",
  config: "cfg",
  document: "doc",
  service: "svc",
  table: "table",
  endpoint: "api",
  pipeline: "ci",
  schema: "schema",
  resource: "res",
  domain: "business area",
  flow: "flow",
  step: "step",
  article: "article",
  entity: "entity",
  topic: "topic",
  claim: "claim",
  source: "source",
};

export const METHOD_COLOR: Record<string, string> = {
  GET: "#34d399",
  POST: "#60a5fa",
  PUT: "#fbbf24",
  PATCH: "#fbbf24",
  DELETE: "#f87171",
};
