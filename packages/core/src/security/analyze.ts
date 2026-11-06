/** Security analysis: per-file rule scan, then graph-level reachability and scoring. */
import type { Finding, GraphNode, KnowledgeGraph, SecurityReport, Severity, ExposurePath } from "../types.js";
import type { SymbolInfo } from "../extract.js";
import type { EntryPoint } from "./entrypoints.js";
import { effectiveAuth, indexGraph, publicByTriage } from "../graph-utils.js";
import {
  GENERIC_SECRET_RE, RULES, RULES_VERSION, SECRET_PATTERNS, isPlaceholder, isPlaceholderDbUrl, redact, shannonEntropy, taintRegexFor,
} from "./rules.js";
import { isTaintCategory, traceTaint, type FunctionSource, type TaintState } from "./taint.js";
import { isKubernetesManifest, isPolicyJson, scanInfra } from "./infra.js";

/** Lines that define a regex rather than execute anything: `pattern: /…/`, `const X_RE = /…/`, `new RegExp(…)`. */
const REGEX_DEF = /^\s*(?:(?:pattern|re|regex|unless|match|test|rule)\s*:\s*\/|(?:export\s+)?(?:const|let|var)\s+\w*(?:RE|Re|REGEX|Regex|PATTERN|Pattern)\w*\s*[:=][^=]*\/)|\bnew\s+RegExp\s*\(\s*["'`/]/;

export type RawFinding = Omit<Finding, "id" | "nodeId" | "reachableFrom" | "status"> & {
  /** requireTaint rule with no local taint: kept only if interprocedural tracing reaches the sink. */
  needsTaint?: boolean;
};

const SEV_ORDER: Severity[] = ["info", "low", "medium", "high", "critical"];
export const bump = (s: Severity, by = 1): Severity => SEV_ORDER[Math.max(0, Math.min(SEV_ORDER.length - 1, SEV_ORDER.indexOf(s) + by))]!;
export const SEV_WEIGHT: Record<Severity, number> = { critical: 25, high: 10, medium: 4, low: 1, info: 0 };

const HASH_COMMENT_LANGS = new Set(["python", "ruby", "shell", "yaml", "toml", "env", "dockerfile", "github-actions", "kubernetes", "docker-compose", "makefile"]);

/** Blank out comments while keeping line structure so rule hits map to real lines. */
export function stripComments(src: string, lang: string): string {
  const hash = HASH_COMMENT_LANGS.has(lang);
  const both = lang === "terraform"; // HCL takes #, //, and /* */
  let out = src;
  if (!hash) out = out.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  return out
    .split("\n")
    .map((l) => {
      const t = l.trimStart();
      const hashComment = t.startsWith("#") && !t.startsWith("#{") && !t.startsWith("#!");
      if (both ? hashComment || t.startsWith("//") : hash ? hashComment : t.startsWith("//")) return "";
      return l;
    })
    .join("\n");
}

function innermost(symbols: SymbolInfo[], line: number): SymbolInfo | undefined {
  return symbols.filter((s) => s.lines[0] <= line && s.lines[1] >= line).sort((a, b) => b.lines[0] - a.lines[0])[0];
}

export interface FileScanInput {
  path: string;
  lang: string;
  src: string;
  symbols: SymbolInfo[];
  isTest: boolean;
  entryPoints: EntryPoint[];
}

export function scanFile(input: FileScanInput): RawFinding[] {
  const { path, src, symbols, isTest } = input;
  const lang = isKubernetesManifest(input.lang, src) ? "kubernetes" : input.lang;
  const policyJson = isPolicyJson(path, src);
  const out: RawFinding[] = [];
  const cleaned = lang === "json" ? src : stripComments(src, lang);
  const lines = cleaned.split("\n");
  const rawLines = src.split("\n");
  const taint = taintRegexFor(lang);
  const isDocs = /\.(md|mdx|rst|txt)$/i.test(path);
  const isExample = /(?:^|\/)(?:examples?|samples?|fixtures?|docs?|__mocks__|testdata)\//i.test(path) || /\.example$|\.sample$|example\./i.test(path);

  const nearTaint = (line: number): boolean => {
    if (!taint) return false;
    const sym = innermost(symbols, line);
    const from = sym ? sym.lines[0] : Math.max(1, line - 6);
    const to = sym ? Math.min(sym.lines[1], line + 2) : line + 2;
    for (let i = from; i <= to && i <= lines.length; i++) if (taint.test(lines[i - 1]!)) return true;
    return false;
  };

  const codeLike = !isDocs && (policyJson || !/\.(json|jsonc|csv|lock|svg)$/i.test(path));
  if (codeLike) {
    for (const rule of RULES) {
      if (rule.langs !== "*" && !rule.langs.includes(lang)) continue;
      if (isTest && !rule.includeTests) continue;
      if (rule.pathFilter && !rule.pathFilter.test(path)) continue;
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i]!;
        if (l.length > 2000 || !rule.pattern.test(l)) continue;
        if (rule.unless?.test(l)) continue;
        if (REGEX_DEF.test(l)) continue; // pattern definitions (including this scanner's own rules)
        const tainted = nearTaint(i + 1);
        out.push({
          ...(rule.requireTaint && !tainted ? { needsTaint: true } : {}),
          rule: rule.id, title: rule.title, category: rule.category, cwe: rule.cwe,
          severity: rule.taintBoost && tainted ? bump(rule.severity) : rule.severity,
          confidence: tainted && rule.confidence === "low" ? "medium" : rule.confidence,
          path, line: i + 1, message: rule.message, snippet: rawLines[i]!.trim().slice(0, 200), tainted,
        });
      }
    }
  }

  // Secrets: scan raw text (secrets hide in comments too), never store the value.
  if (lang !== "markdown" || !isExample) {
    for (let i = 0; i < rawLines.length; i++) {
      const l = rawLines[i]!;
      if (l.length > 4000) continue;
      let hit = false;
      for (const p of SECRET_PATTERNS) {
        const m = p.re.exec(l);
        if (!m) continue;
        if (isPlaceholder(m[0]) || /EXAMPLE|example|xxxx|<|\.\.\./.test(m[0])) continue;
        if (p.id === "db-url-password" && isPlaceholderDbUrl(m[0])) continue;
        hit = true;
        out.push({
          rule: `secret-${p.id}`, title: `Hardcoded ${p.title}`, category: "secrets", cwe: "CWE-798",
          severity: isTest || isExample ? bump(p.severity, -2) : p.severity,
          confidence: "high", path, line: i + 1,
          message: `${p.title} committed to the repository. Rotate it and move it to a secret store.`,
          snippet: redact(l.trim(), m[0]),
        });
      }
      if (hit || isDocs) continue;
      const g = GENERIC_SECRET_RE.exec(l);
      if (g) {
        const val = g[2]!;
        if (!isPlaceholder(val) && shannonEntropy(val) >= 3.5 && !/process\.env|os\.environ|getenv|\$\{|config\[|settings\./.test(l) && !/^(?:https?:|\/|\.)/.test(val)) {
          out.push({
            rule: "secret-generic", title: "Hardcoded credential", category: "secrets", cwe: "CWE-798",
            severity: isTest || isExample ? "low" : "high", confidence: "medium", path, line: i + 1,
            message: `High-entropy literal assigned to ${g[1]}.`, snippet: redact(l.trim(), val),
          });
        }
      }
    }
  }

  // Committed real .env file
  if (/(^|\/)\.env(\.(?!example|sample|template|dist)[\w.-]+)?$/.test(path) && !/\.(example|sample|template|dist)$/.test(path)) {
    const assigned = rawLines.filter((l) => /^\s*[A-Z_][A-Z0-9_]*\s*=\s*\S/.test(l)).length;
    if (assigned > 0) {
      out.push({
        rule: "committed-env-file", title: "Environment file committed", category: "secrets", cwe: "CWE-538",
        severity: "high", confidence: "medium", path, line: 1,
        message: `${assigned} populated variables in a tracked .env file. Add it to .gitignore and rotate anything sensitive.`,
      });
    }
  }

  // Endpoint-level checks
  for (const e of input.entryPoints) {
    const h = e.handler ? symbols.find((s) => (s.owner ? `${s.owner}.${s.name}` : s.name) === e.handler || s.name === e.handler) : undefined;
    const body = h ? rawLines.slice(h.lines[0] - 1, h.lines[1]).join("\n") : rawLines.slice(e.line - 1, e.line + 30).join("\n");
    if (e.entryType === "webhook" && !/signature|verify|hmac|constructEvent|timingSafeEqual|compare_digest|X-Hub-Signature|svix|validateRequest/i.test(body)) {
      out.push({
        rule: "webhook-no-signature", title: "Webhook without signature verification", category: "auth", cwe: "CWE-345",
        severity: "high", confidence: "medium", path, line: e.line,
        message: `${e.method} ${e.route} looks like a webhook receiver but no signature/HMAC check is visible in the handler.`,
        snippet: rawLines[e.line - 1]?.trim().slice(0, 200),
      });
    }
    if (e.auth === "unguarded" && /^(POST|PUT|PATCH|DELETE|ANY)$/.test(e.method) && e.entryType === "http") {
      out.push({
        rule: "unauthenticated-mutation", title: "State-changing endpoint without visible auth", category: "auth", cwe: "CWE-306",
        severity: "medium", confidence: "low", path, line: e.line,
        message: `${e.method} ${e.route} has no auth middleware, decorator, or session check that Lens could see. Confirm it is guarded upstream (gateway, global middleware) or intended to be public.`,
        snippet: rawLines[e.line - 1]?.trim().slice(0, 200),
      });
    }
    if (e.entryType === "server-action" && e.auth === "unguarded") {
      out.push({
        rule: "server-action-no-auth", title: "Server action without auth check", category: "auth", cwe: "CWE-306",
        severity: "medium", confidence: "low", path, line: e.line,
        message: `Server action ${e.route.slice(7)} is callable by any client via POST and has no visible session check.`,
      });
    }
  }
  // Dedupe: one finding per category per line, keeping the most confident/severe.
  const CONF = { high: 3, medium: 2, low: 1 } as const;
  const best = new Map<string, RawFinding>();
  for (const f of out) {
    const k = `${f.category}:${f.line}`;
    const prev = best.get(k);
    // A taint-pending candidate may be dropped later, so a definite finding on the line wins.
    const score = (x: RawFinding) => CONF[x.confidence] * 10 + SEV_ORDER.indexOf(x.severity) - (x.needsTaint ? 100 : 0);
    if (!prev || score(f) > score(prev)) best.set(k, f);
  }
  // Infra checks are distinct problems even when several land on one container or resource line.
  const infra = isTest ? [] : scanInfra({ path, lang, cleaned, raw: src });
  return [...best.values(), ...infra];
}

/* ---------------- graph-level pass ---------------- */

export interface FinalizeInput {
  graph: Pick<KnowledgeGraph, "nodes" | "edges">;
  raw: RawFinding[];
  /** file path → [line range, node id] for innermost node lookup. */
  locate: (path: string, line: number, rule: string) => string;
  previous?: SecurityReport;
  /** Function node id → comment-stripped body and params, for interprocedural taint. */
  functions?: Map<string, FunctionSource>;
}

/** Longest taint path text appended to a finding message. */
const MAX_TAINT_PATH_TEXT = 240;

export function finalizeSecurity({ graph, raw, locate, previous, functions = new Map() }: FinalizeInput): SecurityReport {
  const idx = indexGraph(graph);
  const endpoints = graph.nodes.filter((n) => n.kind === "endpoint");
  const entryIds = endpoints.map((n) => n.id);

  // Forward reachability from each endpoint over routes/calls/middleware.
  const reach = new Map<string, Map<string, string>>(); // entry → (node → predecessor)
  const FOLLOW = new Set(["routes", "calls", "middleware"]);
  for (const ep of endpoints) {
    const prev = new Map<string, string>([[ep.id, ""]]);
    let frontier = [ep.id];
    for (let depth = 0; depth < 12 && frontier.length; depth++) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const e of idx.out.get(id) ?? []) {
          if (!FOLLOW.has(e.kind) || prev.has(e.target)) continue;
          prev.set(e.target, id);
          next.push(e.target);
        }
      }
      frontier = next;
    }
    reach.set(ep.id, prev);
  }

  const taint = traceTaint({ nodes: idx.nodes, out: idx.out, endpoints, functions });
  const enclosingFunction = (nodeId: string): string | undefined => {
    if (functions.has(nodeId)) return nodeId;
    const parent = idx.parent.get(nodeId);
    return parent && functions.has(parent) ? parent : undefined;
  };
  const tracedState = (r: RawFinding, nodeId: string): { fnId?: string; state?: TaintState } => {
    const fnId = enclosingFunction(nodeId);
    if (!fnId || !isTaintCategory(r.category)) return { fnId };
    return { fnId, state: taint.reached(fnId, r.line, r.category) };
  };
  const nodeName = (id: string) => idx.nodes.get(id)?.name ?? id;

  const prevStatus = new Map((previous?.findings ?? []).map((f) => [fingerprint(f), f]));
  const findings: Finding[] = [];
  const exposure: ExposurePath[] = [];
  raw.forEach(({ needsTaint, ...raw }) => {
    const nodeId = locate(raw.path, raw.line, raw.rule);
    const { fnId, state: traced } = tracedState(raw, nodeId);
    const r = { ...raw };
    // A capped trace can't rule out input reaching a function it never got to.
    const untracedAfterCap = taint.truncated && !(fnId && taint.tainted.has(fnId));
    const reachableFrom: string[] = [];
    for (const [ep, prev] of reach) {
      // The finding node itself, or the enclosing function reached via calls.
      let hit = prev.has(nodeId) ? nodeId : undefined;
      if (!hit) {
        const parent = idx.parent.get(nodeId);
        if (parent && prev.has(parent) && idx.nodes.get(parent)?.kind === "function") hit = parent;
      }
      if (!hit) continue;
      reachableFrom.push(ep);
    }
    if (needsTaint && !traced) {
      if (!untracedAfterCap || !reachableFrom.length) return;
      r.confidence = "low";
      r.message += " Input tracing stopped at a limit before this function, so this may be unreachable by input.";
    }
    const tracedEntries = [...(traced?.entries ?? [])];
    reachableFrom.unshift(...tracedEntries.map(([ep]) => ep).filter((ep) => !reachableFrom.includes(ep)));
    const id = `F${String(findings.length + 1).padStart(4, "0")}`;
    let severity = r.severity;
    let tainted = r.tainted;
    let message = r.message;
    if (traced && !tainted) {
      tainted = true;
      severity = bump(severity);
      // Inline handlers share the endpoint's name; drop the repeat.
      const names = tracedEntries[0]![1].map(nodeName).filter((n, i, all) => n !== all[i - 1]).join(" → ");
      const more = tracedEntries.length > 1 ? ` (+${tracedEntries.length - 1} more endpoints)` : "";
      message += ` Request input reaches this sink through ${names.slice(0, MAX_TAINT_PATH_TEXT)}${more}.`;
    }
    // Fallback when tracing never reached the sink's function: some function on an exposure path reads request input.
    const traceCovered = !!fnId && !untracedAfterCap && (taint.tainted.has(fnId) || taint.clean.has(fnId));
    if (!tainted && !traceCovered && reachableFrom.length && isTaintCategory(r.category)) {
      for (const ep of reachableFrom) {
        const prev = reach.get(ep)!;
        let cur: string | undefined = prev.has(nodeId) ? nodeId : idx.parent.get(nodeId);
        let via: GraphNode | undefined;
        while (cur) {
          const n = idx.nodes.get(cur);
          if (n?.tags.includes("reads-input")) via = n;
          cur = prev.get(cur) || undefined;
        }
        if (via) {
          tainted = true;
          severity = bump(severity);
          message += ` Request input enters through ${via.name}.`;
          break;
        }
      }
    }
    const exposedEp = reachableFrom.map((e) => idx.nodes.get(e)!).filter((n) => n.endpoint && (n.endpoint.auth === "unguarded" || n.endpoint.auth === "public") && n.endpoint.entryType !== "cli" && n.endpoint.entryType !== "cron");
    if (exposedEp.length && tainted && r.category !== "secrets" && r.category !== "auth") severity = bump(severity);
    const f: Finding = { ...r, id, nodeId, reachableFrom, severity, tainted, message, status: "open" };
    const old = prevStatus.get(fingerprint(f));
    if (old && old.status !== "open") {
      f.status = old.status;
      f.triageNote = old.triageNote;
      if (old.status === "confirmed") f.severity = old.severity;
    }
    findings.push(f);
    for (const [entryId, entryPath] of tracedEntries) {
      const path = entryPath.at(-1) === nodeId ? entryPath : [...entryPath, nodeId];
      exposure.push({ findingId: id, entryId, path, tainted: true });
    }
    for (const ep of reachableFrom.slice(0, 5)) {
      if (traced?.entries.has(ep)) continue;
      const prev = reach.get(ep)!;
      let cur: string | undefined = prev.has(nodeId) ? nodeId : idx.parent.get(nodeId);
      const path: string[] = [];
      while (cur) {
        path.unshift(cur);
        cur = prev.get(cur) || undefined;
      }
      if (path[0] === ep) {
        if (path[path.length - 1] !== nodeId) path.push(nodeId);
        exposure.push({ findingId: id, entryId: ep, path });
      }
    }
  });

  // Findings added by the triage agent (F9xxx), OSV (Dxxxx), or `lens probe` (Pxxxx) aren't reproducible from rules; keep them while their anchor exists.
  for (const old of previous?.findings ?? []) {
    if (!/^(F9\d{3}|D\d{4}|P\d{4})$/.test(old.id) || !idx.nodes.has(old.nodeId)) continue;
    findings.push({ ...old, reachableFrom: old.reachableFrom.filter((e) => idx.nodes.has(e)) });
  }
  findings.sort((a, b) => SEV_ORDER.indexOf(b.severity) - SEV_ORDER.indexOf(a.severity) || a.path.localeCompare(b.path) || a.line - b.line);
  return {
    generatedAt: new Date().toISOString(),
    rulesVersion: RULES_VERSION,
    entryPoints: entryIds,
    findings,
    exposure,
    taint: { truncated: taint.truncated, limits: taint.limits, tracedFunctions: taint.tainted.size },
    summary: summarize(findings, endpoints),
  };
}

export function summarize(findings: Finding[], endpoints: GraphNode[]): SecurityReport["summary"] {
  const triagedPublic = publicByTriage(findings);
  const bySeverity: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  let w = 0;
  for (const f of findings) {
    if (f.status === "false_positive" || f.status === "accepted") continue;
    bySeverity[f.severity]++;
    w += SEV_WEIGHT[f.severity] * (f.confidence === "low" ? 0.4 : f.confidence === "medium" ? 0.75 : 1);
  }
  return {
    bySeverity,
    unguardedEndpoints: endpoints.filter((e) => effectiveAuth(e, triagedPublic) === "unguarded").length,
    guardedEndpoints: endpoints.filter((e) => e.endpoint?.auth === "guarded").length,
    publicEndpoints: endpoints.filter((e) => effectiveAuth(e, triagedPublic) === "public").length,
    riskScore: Math.round(100 * (1 - Math.exp(-w / 80))),
  };
}

/** Stable identity for a finding across rescans (line numbers drift, snippets mostly don't). */
export function fingerprint(f: Pick<Finding, "rule" | "path" | "snippet" | "line">): string {
  return `${f.rule}|${f.path}|${(f.snippet ?? String(f.line)).replace(/\s+/g, "")}`;
}

