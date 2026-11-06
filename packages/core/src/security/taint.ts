/**
 * Interprocedural taint tracing over the call graph.
 *
 * Seeds are entry-point handlers: their request parameters and any request-input
 * expression in their body are tainted. Taint follows `calls` edges, plus calls the
 * resolver missed that match a repo function by name, when a call site passes a
 * tainted expression as an argument. It lands on the callee's parameter at that
 * position (or keyword). Sinks are then checked against the tainted names of the
 * function that contains them.
 *
 * Taint is tracked per sink category: `escapeHtml(x)` is clean for XSS but still
 * tainted for SQL. Only known library sanitizers clear taint by name. A repo
 * function counts as a sanitizer only when every return in its body is a
 * sanitized form of its input.
 *
 * Analysis is line/text based (same as the rule pack). It is bounded by depth,
 * visit, call-site, and body caps; any cap that cuts the trace short is reported.
 */
import type { Finding, GraphEdge, GraphNode, TaintLimit } from "../types.js";
import { taintRegexFor } from "./rules.js";

/** Max call hops from an entry handler. */
export const MAX_TAINT_DEPTH = 8;
/** Max function analyses (re-analysis after new taint counts again). */
export const MAX_TAINT_VISITS = 4000;
/** Max call sites inspected per caller→callee pair. */
export const MAX_CALL_SITES_PER_EDGE = 8;
/** Function bodies longer than this are analyzed only up to this many lines. */
export const MAX_BODY_LINES = 600;
/** Max endpoints recorded per function. More still taint it but aren't listed. */
export const MAX_ENTRIES_PER_FUNCTION = 16;
/** A call name matching more repo functions than this isn't followed by name. */
export const MAX_NAME_CANDIDATES = 3;
/** Repo functions longer than this aren't considered as sanitizer helpers. */
const MAX_HELPER_LINES = 30;
/** Max argument text length scanned per call site. */
const MAX_ARG_CHARS = 2000;
/** Max sanitizer calls removed from one expression. */
const MAX_SANITIZER_STRIPS = 20;

export const TAINT_CATEGORIES = [
  "injection", "command-exec", "code-exec", "ssrf", "path-traversal", "deserialization", "xss", "redirect",
] as const satisfies readonly Finding["category"][];
export type TaintCategory = (typeof TAINT_CATEGORIES)[number];
export const isTaintCategory = (c: string): c is TaintCategory => (TAINT_CATEGORIES as readonly string[]).includes(c);

/** Bitmask over TAINT_CATEGORIES. A set bit means the value is still dangerous for that category. */
type Kinds = number;
const ALL_KINDS: Kinds = (1 << TAINT_CATEGORIES.length) - 1;
const bit = (c: TaintCategory): Kinds => 1 << TAINT_CATEGORIES.indexOf(c);
const bits = (...cs: TaintCategory[]): Kinds => cs.reduce((m, c) => m | bit(c), 0);

/** Library calls whose result is clean for the given categories. */
const LIBRARY_SANITIZERS: Array<{ call: string; clears: Kinds }> = [
  // Coercion to a number, boolean, or id is safe for every sink.
  {
    call: String.raw`Number|parseInt|parseFloat|BigInt|Boolean|Math\.(?:floor|ceil|round|trunc|abs)|int|float|bool|strconv\.(?:Atoi|ParseInt|ParseUint|ParseFloat|ParseBool)|Integer\.parseInt|Long\.parseLong|Double\.parseDouble|UUID\.fromString|uuid\.UUID|z\.(?:number|boolean|enum|nativeEnum|literal|date|coerce\.(?:number|boolean|date))\([^()]*\)(?:\.\w+\([^()]*\))*\.parse`,
    clears: ALL_KINDS,
  },
  { call: String.raw`(?:mysql|SqlString|sqlstring|connection|conn|pool|db|client)\.(?:escape|escapeId)|\w+\.(?:escapeLiteral|escapeIdentifier)`, clears: bits("injection") },
  {
    call: String.raw`(?:_|lodash|validator|he|html|markupsafe|cgi)\.(?:escape|encode)|DOMPurify\.sanitize|sanitizeHtml|bleach\.clean|html\.EscapeString|template\.HTMLEscapeString|StringEscapeUtils\.escapeHtml4|Encode\.forHtml|escapeHtml|escape_html`,
    clears: bits("xss"),
  },
  { call: String.raw`shlex\.quote|pipes\.quote|shellescape|shellQuote\.quote|escapeshellarg`, clears: bits("command-exec") },
  { call: String.raw`(?:os\.)?path\.basename|basename|secure_filename|filepath\.Base|FilenameUtils\.getName`, clears: bits("path-traversal") },
  { call: String.raw`encodeURIComponent|urllib\.parse\.quote|quote_plus|url\.(?:QueryEscape|PathEscape)|URLEncoder\.encode`, clears: bits("ssrf", "redirect") },
];

/** Handler parameters that are response/continuation objects, not input. */
const NON_INPUT_PARAM = /^(?:_\w*|res|resp|response|reply|next|h|w|self|cls)$/;
/** A return of a constant carries no input. */
const LITERAL_RETURN = /^(?:["'`][^"'`$]*["'`]|-?\d+(?:\.\d+)?|null|undefined|None|nil|true|false|True|False|\[\]|\{\})$/;
const IDENT = /^[A-Za-z_$][\w$]*$/;
const ASSIGN = /^\s*((?:(?:const|let|var|final|val|auto)\s+)?(?:\{[^}]*\}|\[[^\]]*\]|[A-Za-z_$][\w$]*(?:\s*:\s*[\w<>[\]|. ]+)?(?:\s*,\s*[A-Za-z_$][\w$]*)*))\s*(?::=|=(?![=>]))\s*(.+)$/;
const CALL_NAME = /(?<![\w$])([A-Za-z_$][\w$]*)\s*\(/g;

export interface FunctionSource {
  lang: string;
  /** 1-based first line of `lines`. */
  startLine: number;
  /** Comment-stripped body lines. */
  lines: string[];
  params: string[];
  /** Method whose first parameter is the receiver (Python self/cls). */
  receiverParam?: boolean;
}

export interface TaintState {
  /** Parameter position (receiver excluded) → categories it is tainted for. */
  params: Map<number, Kinds>;
  /** Local name → categories it is tainted for. 0 means derived from input but sanitized. */
  names: Map<string, Kinds>;
  /** Endpoint id → node ids from that endpoint to this function, inclusive. */
  entries: Map<string, string[]>;
  depth: number;
}

export interface TaintResult {
  /** Functions that received tainted input. */
  tainted: Map<string, TaintState>;
  /** Functions whose every inspected call site passed only clean arguments. */
  clean: Set<string>;
  /** Caps that cut the trace short. */
  limits: TaintLimit[];
  /** A cap stopped taint from spreading, so untraced code may still be reachable by input. */
  truncated: boolean;
  /** The state of `fnId` when the sink on `line` uses input dangerous for `category`. */
  reached(fnId: string, line: number, category: TaintCategory): TaintState | undefined;
}

export interface TraceInput {
  nodes: Map<string, GraphNode>;
  out: Map<string, GraphEdge[]>;
  /** Endpoint nodes to start from. */
  endpoints: GraphNode[];
  functions: Map<string, FunctionSource>;
}

interface Sanitizers {
  /** Per category index: sanitizer calls that clear it. */
  byCategory: RegExp[];
  /** Short names of every repo function. A repo definition overrides a library name. */
  repoNames: Set<string>;
  /** Repo helper name → categories its result is clean for. */
  helpers: Map<string, Kinds>;
}

interface TaintContext {
  source?: RegExp;
  sanitizers: Sanitizers;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const nameRes = new Map<string, RegExp>();
function nameRe(n: string): RegExp {
  let re = nameRes.get(n);
  if (!re) nameRes.set(n, (re = new RegExp(`(?<![\\w$.])${escapeRe(n)}(?![\\w$])`)));
  return re;
}

/** Index of the bracket that closes the one at `open`, or -1. */
function closingBracket(text: string, open: number): number {
  let depth = 0;
  let quote: string | undefined;
  const end = Math.min(text.length, open + MAX_ARG_CHARS);
  for (let i = open; i < end; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = undefined;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Split an argument list on top-level commas. */
export function splitArgs(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | undefined;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = undefined;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      out.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  const last = text.slice(start).trim();
  if (last || out.length) out.push(last);
  return out;
}

/** Replace calls that sanitize category `index` (with their arguments) by a clean placeholder. */
function stripFor(text: string, index: number, san: Sanitizers): string {
  if (!text.includes("(")) return text;
  const re = san.byCategory[index]!;
  const mask = 1 << index;
  let out = text;
  let from = 0;
  for (let strips = 0; strips < MAX_SANITIZER_STRIPS; ) {
    re.lastIndex = from;
    const m = re.exec(out);
    if (!m) break;
    const open = m.index + m[0].length - 1;
    const callee = m[0].slice(0, -1).trim();
    // A repo function that shadows a library name is judged by its own body.
    if (!callee.includes(".") && san.repoNames.has(callee) && !((san.helpers.get(callee) ?? 0) & mask)) {
      from = open + 1;
      continue;
    }
    const close = closingBracket(out, open);
    if (close < 0 || out[close] !== ")") break;
    out = out.slice(0, m.index) + "0" + out.slice(close + 1);
    from = m.index;
    strips++;
  }
  return out;
}

/**
 * Categories `text` is dangerous for. Undefined when it doesn't use request input or a
 * traced name at all; 0 when it uses input that is sanitized for every category.
 */
function inputUse(text: string, names: Map<string, Kinds>, ctx: TaintContext): Kinds | undefined {
  const hasSource = !!ctx.source?.test(text);
  const present = [...names.keys()].filter((n) => nameRe(n).test(text));
  if (!hasSource && !present.length) return undefined;
  if (!text.includes("(")) return (hasSource ? ALL_KINDS : 0) | present.reduce((m, n) => m | names.get(n)!, 0);
  let kinds = 0;
  for (let i = 0; i < TAINT_CATEGORIES.length; i++) {
    const mask = 1 << i;
    const t = stripFor(text, i, ctx.sanitizers);
    if ((hasSource && ctx.source!.test(t)) || present.some((n) => names.get(n)! & mask && nameRe(n).test(t))) kinds |= mask;
  }
  return kinds;
}

/** Names bound on the left of an assignment: `x`, `{ a, b: c }`, `[a, b]`, `a, b`. */
function boundNames(lhs: string): string[] {
  const t = lhs.trim().replace(/^(?:const|let|var|final|val|auto)\s+/, "");
  if (/^[{[]/.test(t)) {
    const close = closingBracket(t, 0);
    const inner = t.slice(1, close < 0 ? undefined : close);
    return inner.split(",").map((x) => x.split(":").pop()!.split("=")[0]!.replace(/^\s*\.\.\./, "").trim()).filter((x) => IDENT.test(x));
  }
  return t.split(",").map((x) => x.trim().split(/\s+/).pop()!.split(":")[0]!.trim()).filter((x) => IDENT.test(x));
}

/** Names a parameter binds: drops types, defaults, rest/spread; expands destructuring. */
function paramNames(p: string): string[] {
  const t = p.replace(/^\s*(?:\.\.\.|\*{1,2}|&)/, "").trim();
  if (/^[{[]/.test(t)) return boundNames(t);
  const n = t.split(/[:=\s]/)[0]!.trim();
  return IDENT.test(n) ? [n] : [];
}

const isRestParam = (p: string) => /^\s*(?:\.\.\.|\*)/.test(p);

/** Tainted names in a function body, given tainted parameter names. */
export function propagate(fn: FunctionSource, seed: Map<string, Kinds>, ctx: TaintContext): Map<string, Kinds> {
  const names = new Map(seed);
  const lines = fn.lines.slice(0, MAX_BODY_LINES);
  // Pass 0 merges taint in source order; pass 1 only picks up names used before their tainted
  // assignment (loops, hoisting), so a later `x = Number(x)` stays clean.
  for (let pass = 0; pass < 2; pass++) {
    for (const l of lines) {
      const m = ASSIGN.exec(l);
      if (!m) continue;
      const bound = boundNames(m[1]!);
      if (!bound.length) continue;
      const kinds = inputUse(m[2]!, names, ctx);
      if (kinds === undefined) continue;
      const selfAssign = bound.some((n) => nameRe(n).test(m[2]!));
      for (const n of bound) {
        if (pass === 1) {
          if (!names.has(n)) names.set(n, kinds);
        } else names.set(n, selfAssign ? kinds : (names.get(n) ?? 0) | kinds);
      }
    }
  }
  return names;
}

/** Positional arguments at each call to `callee` in a body, up to the cap. */
function callSites(fn: FunctionSource, callee: string): { sites: string[][]; capped: boolean } {
  const text = fn.lines.slice(0, MAX_BODY_LINES).join("\n");
  const re = new RegExp(`(?<![\\w$])${escapeRe(callee)}\\s*\\(`, "g");
  const sites: string[][] = [];
  for (const m of text.matchAll(re)) {
    if (sites.length >= MAX_CALL_SITES_PER_EDGE) return { sites, capped: true };
    const open = m.index! + m[0].length - 1;
    const close = closingBracket(text, open);
    if (close < 0) continue;
    sites.push(splitArgs(text.slice(open + 1, close)));
  }
  return { sites, capped: false };
}

const paramList = (fn: FunctionSource) => (fn.receiverParam ? fn.params.slice(1) : fn.params);

/** Callee parameter positions that receive tainted input at any call site. */
function argTaint(sites: string[][], params: string[], names: Map<string, Kinds>, ctx: TaintContext): Map<number, Kinds> {
  const hit = new Map<number, Kinds>();
  const add = (pos: number, kinds: Kinds) => {
    if (pos >= 0) hit.set(pos, (hit.get(pos) ?? 0) | kinds);
  };
  const restAt = params.findIndex(isRestParam);
  for (const args of sites) {
    args.forEach((arg, i) => {
      const kinds = arg ? inputUse(arg, names, ctx) : undefined;
      if (!kinds) return;
      const keyword = /^([A-Za-z_]\w*)\s*=(?!=)/.exec(arg);
      if (keyword) return add(params.findIndex((p) => paramNames(p).includes(keyword[1]!)), kinds);
      if (isRestParam(arg)) {
        for (let j = i; j < params.length; j++) add(j, kinds);
        return;
      }
      add(i < params.length && !(restAt >= 0 && i > restAt) ? i : restAt, kinds);
    });
  }
  return hit;
}

function seedNames(fn: FunctionSource, positions: Map<number, Kinds>): Map<string, Kinds> {
  const ps = paramList(fn);
  const out = new Map<string, Kinds>();
  for (const [i, kinds] of positions) for (const n of paramNames(ps[i] ?? "")) out.set(n, (out.get(n) ?? 0) | kinds);
  return out;
}

function returnExprs(fn: FunctionSource): string[] {
  const out: string[] = [];
  fn.lines.forEach((l, i) => {
    const r = /(?<![\w$])return\s+(.+?);?\s*$/.exec(l);
    if (r) out.push(r[1]!.trim());
    else if (i === 0) {
      const arrow = /=>\s*(?!\{)(.+?);?\s*$/.exec(l);
      if (arrow) out.push(arrow[1]!.trim());
    }
  });
  return out;
}

/** Categories a repo function's result is clean for: every return must be sanitized input or a constant. */
function helperClears(fn: FunctionSource, san: Sanitizers): Kinds {
  const seed = new Map<string, Kinds>();
  for (const p of paramList(fn)) for (const n of paramNames(p)) seed.set(n, ALL_KINDS);
  if (!seed.size) return 0;
  const ctx: TaintContext = { sanitizers: san };
  const names = propagate(fn, seed, ctx);
  let clears = ALL_KINDS;
  let usesInput = false;
  for (const r of returnExprs(fn)) {
    const kinds = inputUse(r, names, ctx);
    if (kinds === undefined) {
      // A non-constant return that doesn't name the input (e.g. a mutated buffer) can't be trusted.
      if (!LITERAL_RETURN.test(r)) return 0;
      continue;
    }
    usesInput = true;
    clears &= ~kinds;
  }
  return usesInput ? clears : 0;
}

function sanitizerRegexes(helpers: Map<string, Kinds>): RegExp[] {
  return TAINT_CATEGORIES.map((_, i) => {
    const mask = 1 << i;
    const alts = LIBRARY_SANITIZERS.filter((s) => s.clears & mask).map((s) => s.call);
    for (const [name, clears] of helpers) if (clears & mask) alts.push(escapeRe(name));
    return new RegExp(`(?<![\\w$.])(?:${alts.join("|")})\\s*\\(`, "g");
  });
}

/** Library sanitizers plus repo helpers whose body proves they sanitize; two rounds so a helper may call a helper. */
function buildSanitizers(functions: Map<string, FunctionSource>, nameOf: (id: string) => string): Sanitizers {
  const repoNames = new Set([...functions.keys()].map(nameOf));
  let san: Sanitizers = { byCategory: sanitizerRegexes(new Map()), repoNames, helpers: new Map() };
  for (let round = 0; round < 2; round++) {
    const helpers = new Map<string, Kinds>();
    for (const [id, fn] of functions) {
      if (fn.lines.length > MAX_HELPER_LINES) continue;
      const name = nameOf(id);
      const clears = helperClears(fn, san);
      // Same name defined twice: trust only what both definitions guarantee.
      helpers.set(name, helpers.has(name) ? helpers.get(name)! & clears : clears);
    }
    for (const [name, clears] of helpers) if (!clears) helpers.delete(name);
    san = { byCategory: sanitizerRegexes(helpers), repoNames, helpers };
  }
  return san;
}

const langFamily = (lang: string) => (/^(?:typescript|javascript|tsx|jsx|vue|svelte)$/.test(lang) ? "js" : lang);

export function traceTaint({ nodes, out, endpoints, functions }: TraceInput): TaintResult {
  const nameOf = (id: string) => (nodes.get(id)?.name ?? id.split(":").pop()!).split(".").pop()!;
  const byName = new Map<string, string[]>();
  for (const id of functions.keys()) {
    const n = nameOf(id);
    byName.set(n, [...(byName.get(n) ?? []), id]);
  }
  const sanitizers = buildSanitizers(functions, nameOf);
  const contexts = new Map<string, TaintContext>();
  const ctxFor = (lang: string): TaintContext => {
    let ctx = contexts.get(lang);
    if (!ctx) contexts.set(lang, (ctx = { source: taintRegexFor(lang), sanitizers }));
    return ctx;
  };

  const tainted = new Map<string, TaintState>();
  const cleanCalls = new Set<string>();
  const limits = new Set<TaintLimit>();
  const queue: string[] = [];
  const queued = new Set<string>();
  const enqueue = (id: string) => {
    if (queued.has(id)) return;
    queued.add(id);
    queue.push(id);
  };

  /** Merge taint arriving from `from` into `id`; true when anything new arrived. */
  const merge = (id: string, hit: Map<number, Kinds>, from: Pick<TaintState, "entries" | "depth">): boolean => {
    let st = tainted.get(id);
    let grew = false;
    if (!st) {
      st = { params: new Map(), names: new Map(), entries: new Map(), depth: from.depth + 1 };
      tainted.set(id, st);
      grew = true;
    }
    for (const [pos, kinds] of hit) {
      const prev = st.params.get(pos) ?? 0;
      if ((prev | kinds) !== prev) {
        st.params.set(pos, prev | kinds);
        grew = true;
      }
    }
    for (const [ep, path] of from.entries) {
      if (st.entries.has(ep)) continue;
      if (st.entries.size >= MAX_ENTRIES_PER_FUNCTION) {
        limits.add("entries");
        break;
      }
      st.entries.set(ep, path.at(-1) === id ? path : [...path, id]);
      grew = true;
    }
    st.depth = Math.min(st.depth, from.depth + 1);
    return grew;
  };

  /** Callees by graph edge, plus same-language repo functions matched by call name when no edge exists. */
  const calleesOf = (id: string, fn: FunctionSource): Array<{ id: string; name: string }> => {
    const found = new Map<string, string>();
    for (const e of out.get(id) ?? []) if (e.kind === "calls" && functions.has(e.target)) found.set(e.target, nameOf(e.target));
    const linkedNames = new Set(found.values());
    const text = fn.lines.slice(0, MAX_BODY_LINES).join("\n");
    for (const m of text.matchAll(CALL_NAME)) {
      const name = m[1]!;
      if (linkedNames.has(name)) continue;
      const candidates = (byName.get(name) ?? []).filter((c) => c !== id && langFamily(functions.get(c)!.lang) === langFamily(fn.lang));
      if (!candidates.length || candidates.length > MAX_NAME_CANDIDATES) continue;
      for (const c of candidates) found.set(c, name);
      linkedNames.add(name);
    }
    return [...found].map(([calleeId, name]) => ({ id: calleeId, name }));
  };

  for (const ep of endpoints) {
    if (!ep.endpoint || ep.endpoint.entryType === "cron" || ep.endpoint.entryType === "cli") continue;
    for (const e of out.get(ep.id) ?? []) {
      if (e.kind !== "routes") continue;
      const fn = functions.get(e.target);
      if (!fn) continue;
      const positions = new Map<number, Kinds>();
      paramList(fn).forEach((p, i) => {
        const ns = paramNames(p);
        if (ns.length && !(ns.length === 1 && NON_INPUT_PARAM.test(ns[0]!))) positions.set(i, ALL_KINDS);
      });
      if (merge(e.target, positions, { entries: new Map([[ep.id, [ep.id]]]), depth: -1 })) enqueue(e.target);
    }
  }

  let visits = 0;
  while (queue.length) {
    if (visits++ >= MAX_TAINT_VISITS) {
      limits.add("visits");
      break;
    }
    const id = queue.shift()!;
    queued.delete(id);
    const state = tainted.get(id)!;
    const fn = functions.get(id)!;
    const ctx = ctxFor(fn.lang);
    if (fn.lines.length > MAX_BODY_LINES) limits.add("body");
    state.names = propagate(fn, seedNames(fn, state.params), ctx);
    for (const callee of calleesOf(id, fn)) {
      const { sites, capped } = callSites(fn, callee.name);
      if (capped) limits.add("call-sites");
      if (!sites.length) continue;
      const hit = argTaint(sites, paramList(functions.get(callee.id)!), state.names, ctx);
      if (!hit.size) {
        cleanCalls.add(callee.id);
        continue;
      }
      if (state.depth >= MAX_TAINT_DEPTH) {
        if (!tainted.has(callee.id)) limits.add("depth");
        continue;
      }
      if (merge(callee.id, hit, state)) enqueue(callee.id);
    }
  }

  const limitList = [...limits];
  return {
    tainted,
    clean: new Set([...cleanCalls].filter((id) => !tainted.has(id))),
    limits: limitList,
    truncated: limitList.some((l) => l !== "entries"),
    reached(fnId, line, category) {
      const state = tainted.get(fnId);
      const fn = functions.get(fnId);
      if (!state || !fn) return undefined;
      const i = line - fn.startLine;
      const text = fn.lines[i];
      if (text === undefined) return undefined;
      // A call left open on the sink line (`exec(\n  cmd\n)`) continues on the next line.
      const open = (text.match(/\(/g)?.length ?? 0) > (text.match(/\)/g)?.length ?? 0);
      const window = open ? text + "\n" + (fn.lines[i + 1] ?? "") : text;
      const kinds = inputUse(window, state.names, ctxFor(fn.lang));
      return kinds && kinds & bit(category) ? state : undefined;
    },
  };
}
