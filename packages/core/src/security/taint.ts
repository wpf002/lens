/**
 * Interprocedural taint tracing over the call graph.
 *
 * Seeds are entry-point handlers: their request parameters and any request-input
 * expression in their body are tainted. Taint follows `calls` edges when a call
 * site passes a tainted expression as an argument, and lands on the callee's
 * parameter at that position. Sinks are then checked against the tainted names of
 * the function that contains them.
 *
 * Analysis is line/text based (same as the rule pack), flow-insensitive inside a
 * function except that a sanitized reassignment clears a name. It is bounded by
 * depth, visit, and call-site caps so large repos stay fast.
 */
import type { GraphEdge, GraphNode } from "../types.js";
import { taintRegexFor } from "./rules.js";

/** Max call hops from an entry handler. */
export const MAX_TAINT_DEPTH = 8;
/** Max function analyses (re-analysis after new taint counts again). */
export const MAX_TAINT_VISITS = 4000;
/** Max call sites inspected per caller→callee edge. */
export const MAX_CALL_SITES_PER_EDGE = 8;
/** Function bodies longer than this are analyzed only up to this many lines. */
export const MAX_BODY_LINES = 600;
/** Max argument text length scanned per call site. */
const MAX_ARG_CHARS = 2000;

/** Calls whose result is treated as clean: coercion, escaping, validation, path containment. */
const SANITIZER_CALL =
  /(?<![\w$.])(?:Number|parseInt|parseFloat|BigInt|Boolean|Math\.(?:floor|ceil|round|trunc)|encodeURIComponent|encodeURI|\w*[Ss]anitiz\w*|\w*[Ee]scape\w*|escape|validator\.\w+|shellescape|shellQuote\.quote|shlex\.quote|quote|path\.basename|basename|secure_filename|filepath\.Base|int|float|str\.isdigit|strconv\.Atoi|Integer\.parseInt|Long\.parseLong|UUID\.fromString|\w+Schema\.parse|z\.\w+\([^()]*\)\.parse)\s*\(/g;

/** Handler parameters that are response/continuation objects, not input. */
const NON_INPUT_PARAM = /^(?:_\w*|res|resp|response|reply|next|h|w|self|cls)$/;

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
  /** Tainted parameter positions (receiver excluded). */
  params: Set<number>;
  /** Tainted local names after propagation. */
  names: Set<string>;
  /** Node ids from the endpoint to this function, inclusive. */
  path: string[];
  entryId: string;
  depth: number;
}

export interface TaintResult {
  /** Functions that received tainted input. */
  tainted: Map<string, TaintState>;
  /** Functions whose every inspected call site passed only clean arguments. */
  clean: Set<string>;
  /** Visits were capped before the worklist emptied. */
  truncated: boolean;
}

export interface TraceInput {
  nodes: Map<string, GraphNode>;
  out: Map<string, GraphEdge[]>;
  /** Endpoint nodes to start from. */
  endpoints: GraphNode[];
  functions: Map<string, FunctionSource>;
}

const IDENT = /^[A-Za-z_$][\w$]*$/;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Index of the paren that closes the one at `open`, or -1. */
function closingParen(text: string, open: number): number {
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
    if (c === '"' || c === "'") quote = c;
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) return c === ")" ? i : -1;
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
    if (c === '"' || c === "'") quote = c;
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

/** Replace sanitizer calls (with their arguments) by a clean placeholder. */
export function stripSanitized(text: string): string {
  let out = text;
  for (let guard = 0; guard < 20; guard++) {
    SANITIZER_CALL.lastIndex = 0;
    const m = SANITIZER_CALL.exec(out);
    if (!m) break;
    const open = m.index + m[0].length - 1;
    const close = closingParen(out, open);
    if (close < 0) break;
    out = out.slice(0, m.index) + "0" + out.slice(close + 1);
  }
  return out;
}

/** True when `text` carries request input or a tainted name once sanitizer calls are removed. */
export function carriesTaint(text: string, names: Set<string>, source: RegExp | undefined): boolean {
  const t = stripSanitized(text);
  if (source?.test(t)) return true;
  for (const n of names) if (new RegExp(`(?<![\\w$.])${escapeRe(n)}(?![\\w$])`).test(t)) return true;
  return false;
}

/** Bare parameter name: drops TS types, defaults, rest/spread, and Python/Go annotations. */
function paramName(p: string): string | undefined {
  const n = p.replace(/^\s*(?:\.\.\.|\*{1,2}|&)/, "").split(/[:=\s]/)[0]!.trim();
  return IDENT.test(n) ? n : undefined;
}

/** Names bound on the left of an assignment: `x`, `{ a, b: c }`, `[a, b]`, `a, b`. */
function boundNames(lhs: string): string[] {
  const t = lhs.trim().replace(/^(?:const|let|var|final|val|auto)\s+/, "");
  if (/^[{[]/.test(t)) {
    return t.slice(1, -1).split(",").map((x) => x.split(":").pop()!.split("=")[0]!.replace(/^\s*\.\.\./, "").trim()).filter((x) => IDENT.test(x));
  }
  return t.split(",").map((x) => x.trim().split(/\s+/).pop()!.split(":")[0]!.trim()).filter((x) => IDENT.test(x));
}

const ASSIGN = /^\s*((?:(?:const|let|var|final|val|auto)\s+)?(?:\{[^}]*\}|\[[^\]]*\]|[A-Za-z_$][\w$]*(?:\s*:\s*[\w<>[\]|. ]+)?(?:\s*,\s*[A-Za-z_$][\w$]*)*))\s*(?::=|=(?![=>]))\s*(.+)$/;

/** Tainted names in a function body, given tainted parameter names. */
export function propagate(fn: FunctionSource, seedNames: Iterable<string>, source: RegExp | undefined): Set<string> {
  const names = new Set(seedNames);
  const lines = fn.lines.slice(0, MAX_BODY_LINES);
  // Two passes so `b = a` before `a = req.body` (loops, hoisting) still links; the second pass never clears.
  for (let pass = 0; pass < 2; pass++) {
    for (const l of lines) {
      const m = ASSIGN.exec(l);
      if (!m) continue;
      const bound = boundNames(m[1]!);
      if (!bound.length) continue;
      if (carriesTaint(m[2]!, names, source)) for (const n of bound) names.add(n);
      else if (pass === 0 && stripSanitized(m[2]!) !== m[2]) for (const n of bound) names.delete(n);
    }
  }
  return names;
}

/** Positional arguments at each call to `callee` in a body, up to the cap. */
export function callSites(fn: FunctionSource, callee: string): string[][] {
  const text = fn.lines.slice(0, MAX_BODY_LINES).join("\n");
  const re = new RegExp(`(?<![\\w$])${escapeRe(callee)}\\s*\\(`, "g");
  const out: string[][] = [];
  for (const m of text.matchAll(re)) {
    if (out.length >= MAX_CALL_SITES_PER_EDGE) break;
    const open = m.index! + m[0].length - 1;
    const close = closingParen(text, open);
    if (close < 0) continue;
    out.push(splitArgs(text.slice(open + 1, close)));
  }
  return out;
}

function paramList(fn: FunctionSource): string[] {
  return fn.receiverParam ? fn.params.slice(1) : fn.params;
}

function namesFor(fn: FunctionSource, positions: Set<number>): string[] {
  const ps = paramList(fn);
  return [...positions].map((i) => (ps[i] ? paramName(ps[i]!) : undefined)).filter((x): x is string => !!x);
}

const shortName = (n: GraphNode) => n.name.split(".").pop()!;

export function traceTaint({ nodes, out, endpoints, functions }: TraceInput): TaintResult {
  const tainted = new Map<string, TaintState>();
  const cleanCalls = new Set<string>();
  const queue: string[] = [];

  for (const ep of endpoints) {
    if (!ep.endpoint || ep.endpoint.entryType === "cron" || ep.endpoint.entryType === "cli") continue;
    for (const e of out.get(ep.id) ?? []) {
      if (e.kind !== "routes") continue;
      const fn = functions.get(e.target);
      if (!fn || tainted.has(e.target)) continue;
      const ps = paramList(fn);
      const positions = new Set(ps.map((p, i) => [paramName(p), i] as const).filter(([n]) => n && !NON_INPUT_PARAM.test(n)).map(([, i]) => i));
      tainted.set(e.target, { params: positions, names: new Set(), path: [ep.id, e.target], entryId: ep.id, depth: 0 });
      queue.push(e.target);
    }
  }

  let visits = 0;
  while (queue.length) {
    if (visits++ >= MAX_TAINT_VISITS) return finish(true);
    const id = queue.shift()!;
    const state = tainted.get(id)!;
    const fn = functions.get(id)!;
    const source = taintRegexFor(fn.lang);
    state.names = propagate(fn, namesFor(fn, state.params), source);
    if (state.depth >= MAX_TAINT_DEPTH) continue;
    for (const e of out.get(id) ?? []) {
      if (e.kind !== "calls") continue;
      const target = nodes.get(e.target);
      const calleeFn = functions.get(e.target);
      if (!target || !calleeFn) continue;
      const sites = callSites(fn, shortName(target));
      if (!sites.length) continue;
      const hit = new Set<number>();
      for (const args of sites) args.forEach((a, i) => {
        if (a && carriesTaint(a, state.names, source)) hit.add(i);
      });
      if (!hit.size) {
        cleanCalls.add(e.target);
        continue;
      }
      const prev = tainted.get(e.target);
      if (prev && [...hit].every((i) => prev.params.has(i))) continue;
      if (prev) for (const i of hit) prev.params.add(i);
      else tainted.set(e.target, { params: hit, names: new Set(), path: [...state.path, e.target], entryId: state.entryId, depth: state.depth + 1 });
      if (!queue.includes(e.target)) queue.push(e.target);
    }
  }
  return finish(false);

  function finish(truncated: boolean): TaintResult {
    const clean = new Set([...cleanCalls].filter((id) => !tainted.has(id)));
    return { tainted, clean, truncated };
  }
}

/** Whether the sink at `line` uses request input or a traced tainted name. */
export function sinkTainted(fn: FunctionSource, state: TaintState, line: number): boolean {
  const i = line - fn.startLine;
  const text = fn.lines[i];
  if (text === undefined) return false;
  // A call left open on the sink line (`exec(\n  cmd\n)`) continues on the next line.
  const open = (text.match(/\(/g)?.length ?? 0) > (text.match(/\)/g)?.length ?? 0);
  const window = open ? text + "\n" + (fn.lines[i + 1] ?? "") : text;
  return carriesTaint(window, state.names, taintRegexFor(fn.lang));
}
