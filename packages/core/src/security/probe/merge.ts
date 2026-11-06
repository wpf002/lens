/**
 * Fold probe observations into the security report. Auth findings are confirmed
 * or cleared, injection findings are only ever confirmed, and new dynamic
 * findings get stable P-ids so Won't Fix decisions survive re-runs.
 */
import type { Finding, GraphNode, KnowledgeGraph } from "../../types.js";
import { indexGraph } from "../../graph-utils.js";
import { locateNode, resortAndSummarize, reverseReach } from "../../apply.js";
import { coverageKey, type Evaluation, type Observation, type ObservationKind } from "./checks.js";

type NewFindingKind = Exclude<ObservationKind, "auth-enforced" | "auth-missing">;

interface DynamicRule {
  rule: string;
  title: string;
  category: Finding["category"];
  cwe: string;
  severity: Finding["severity"];
}

const DYNAMIC_RULES: Record<NewFindingKind, DynamicRule> = {
  idor: { rule: "dyn-idor", title: "Object readable by another account", category: "auth", cwe: "CWE-639", severity: "high" },
  "reflected-xss": { rule: "dyn-reflected-xss", title: "Input reflected unescaped into HTML", category: "xss", cwe: "CWE-79", severity: "high" },
  "sql-error": { rule: "dyn-sql-error", title: "Quote in input triggers a database error", category: "injection", cwe: "CWE-89", severity: "high" },
  "verbose-error": { rule: "dyn-verbose-error", title: "Stack trace in error response", category: "config", cwe: "CWE-209", severity: "medium" },
  "missing-headers": { rule: "dyn-missing-headers", title: "Missing security headers", category: "config", cwe: "CWE-693", severity: "low" },
  "cors-reflect": { rule: "dyn-cors-reflect", title: "CORS reflects any Origin", category: "config", cwe: "CWE-942", severity: "medium" },
};
const KIND_BY_RULE = new Map(Object.entries(DYNAMIC_RULES).map(([kind, r]) => [r.rule, kind as NewFindingKind]));
const HOST_LEVEL_KINDS = new Set<ObservationKind>(["missing-headers", "cors-reflect"]);
const AUTH_RULES = new Set(["unauthenticated-mutation", "server-action-no-auth"]);
const CONFIRMS_CATEGORY: Partial<Record<ObservationKind, Finding["category"]>> = { "reflected-xss": "xss", "sql-error": "injection" };
const PROBE_ID_RE = /^P(\d{4})$/;
const SERVER_START_RE = /\.listen\(/;
const NOTE_MAX = 400;

export interface MergeOptions {
  /** Reads a repo-relative file; used to anchor host-level findings at the server entry. */
  readFile?: (path: string) => string | undefined;
}

export interface MergeReport {
  confirmed: number;
  cleared: number;
  added: number;
  removed: number;
}

const note = (evidence: string) => `Probe: ${evidence}`.slice(0, NOTE_MAX);
const anchorKey = (rule: string, path: string, line: number) => `${rule}|${path}|${line}`;

function endpointCovers(node: GraphNode, finding: Finding): boolean {
  if (finding.path !== node.path) return false;
  const [start, end] = node.lines ?? [finding.line, finding.line];
  return finding.line >= start && finding.line <= end;
}

function hostAnchor(g: KnowledgeGraph, endpoints: GraphNode[], readFile: MergeOptions["readFile"]): { path: string; line: number } | undefined {
  if (readFile) {
    const candidates = [...new Set(endpoints.map((e) => e.path).filter((p): p is string => !!p))];
    for (const path of candidates) {
      const lines = readFile(path)?.split("\n") ?? [];
      const index = lines.findIndex((l) => SERVER_START_RE.test(l));
      if (index >= 0) return { path, line: index + 1 };
    }
  }
  const first = endpoints.find((e) => e.path);
  if (first?.path) return { path: first.path, line: first.lines?.[0] ?? 1 };
  const file = g.nodes.find((n) => n.kind === "file" && n.path);
  return file?.path ? { path: file.path, line: 1 } : undefined;
}

/** Apply one probe run to the graph in place. The graph must have a security report. */
export function applyProbeResults(g: KnowledgeGraph, evaluation: Evaluation, options: MergeOptions = {}): MergeReport {
  const security = g.security;
  if (!security) throw new Error("Run `lens security` before `lens probe`.");
  const report: MergeReport = { confirmed: 0, cleared: 0, added: 0, removed: 0 };
  const idx = indexGraph(g);
  const endpoints = g.nodes.filter((n) => n.kind === "endpoint" && n.endpoint);
  const endpointById = new Map(endpoints.map((n) => [n.id, n]));

  const confirm = (finding: Finding, evidence: string) => {
    if (finding.status !== "open") return;
    finding.status = "confirmed";
    finding.triageNote = note(evidence);
    report.confirmed++;
  };

  for (const observation of evaluation.observations) {
    const endpoint = observation.endpointId ? endpointById.get(observation.endpointId) : undefined;
    if (!endpoint) continue;
    if (observation.kind === "auth-enforced") {
      for (const finding of security.findings) {
        if (!AUTH_RULES.has(finding.rule) || !endpointCovers(endpoint, finding)) continue;
        if (finding.status !== "open" && finding.status !== "confirmed") continue;
        finding.status = "false_positive";
        finding.triageNote = note(observation.evidence);
        report.cleared++;
      }
      endpoint.endpoint!.auth = "guarded";
      endpoint.endpoint!.authEvidence = note(observation.evidence).slice(0, 200);
    } else if (observation.kind === "auth-missing") {
      for (const finding of security.findings) if (AUTH_RULES.has(finding.rule) && endpointCovers(endpoint, finding)) confirm(finding, observation.evidence);
    }
    const category = CONFIRMS_CATEGORY[observation.kind];
    if (category) {
      for (const finding of security.findings) {
        if (finding.category === category && !finding.rule.startsWith("dyn-") && finding.reachableFrom.includes(endpoint.id)) confirm(finding, observation.evidence);
      }
    }
  }

  const priorDynamic = new Map(security.findings.filter((f) => PROBE_ID_RE.test(f.id)).map((f) => [anchorKey(f.rule, f.path, f.line), f]));
  let nextId = Math.max(0, ...[...priorDynamic.values()].map((f) => Number(PROBE_ID_RE.exec(f.id)![1]))) + 1;
  const reproduced = new Set<string>();
  const anchor = hostAnchor(g, endpoints, options.readFile);

  for (const observation of evaluation.observations) {
    if (observation.kind === "auth-enforced" || observation.kind === "auth-missing") continue;
    const built = buildFinding(g, idx, observation, endpointById, anchor);
    if (!built) continue;
    const key = anchorKey(built.rule, built.path, built.line);
    if (reproduced.has(key)) continue;
    reproduced.add(key);
    const prior = priorDynamic.get(key);
    if (prior) {
      const keepStatus = prior.status === "accepted" || prior.status === "false_positive";
      Object.assign(prior, { ...built, id: prior.id, status: keepStatus ? prior.status : "confirmed", triageNote: keepStatus ? prior.triageNote : built.triageNote });
    } else {
      security.findings.push({ ...built, id: `P${String(nextId++).padStart(4, "0")}` });
      report.added++;
    }
  }

  // Drop dynamic findings this run re-checked and no longer saw. Unchecked ones stay.
  security.findings = security.findings.filter((finding) => {
    if (!PROBE_ID_RE.test(finding.id) || reproduced.has(anchorKey(finding.rule, finding.path, finding.line))) return true;
    const kind = KIND_BY_RULE.get(finding.rule);
    if (!kind) return true;
    const checked = HOST_LEVEL_KINDS.has(kind)
      ? evaluation.covered.has(coverageKey(kind))
      : finding.reachableFrom.some((endpointId) => evaluation.covered.has(coverageKey(kind, endpointId)));
    if (checked) report.removed++;
    return !checked;
  });

  resortAndSummarize(g);
  return report;
}

function buildFinding(
  g: KnowledgeGraph,
  idx: ReturnType<typeof indexGraph>,
  observation: Observation,
  endpointById: Map<string, GraphNode>,
  hostAnchorAt: { path: string; line: number } | undefined,
): Omit<Finding, "id"> | undefined {
  const kind = observation.kind as NewFindingKind;
  const rule = DYNAMIC_RULES[kind];
  let path: string;
  let line: number;
  let nodeId: string | undefined;
  let reachableFrom: string[] = [];

  if (HOST_LEVEL_KINDS.has(kind) || !observation.endpointId) {
    if (!hostAnchorAt) return undefined;
    ({ path, line } = hostAnchorAt);
    nodeId = locateNode(g, path, line);
  } else {
    const endpoint = endpointById.get(observation.endpointId);
    if (!endpoint?.path) return undefined;
    path = endpoint.path;
    line = endpoint.lines?.[0] ?? 1;
    nodeId = endpoint.endpoint!.handlerId ?? locateNode(g, path, line);
    const reach = nodeId ? reverseReach(idx, nodeId) : [];
    reachableFrom = [endpoint.id, ...reach.filter((id) => id !== endpoint.id)];
  }
  if (!nodeId) return undefined;

  const severity = kind === "cors-reflect" && observation.credentials ? "high" : rule.severity;
  return {
    rule: rule.rule,
    title: rule.title,
    category: rule.category,
    cwe: rule.cwe,
    severity,
    confidence: "high",
    path,
    line,
    nodeId,
    message: observation.evidence,
    ...(kind === "reflected-xss" || kind === "sql-error" ? { tainted: true } : {}),
    reachableFrom,
    status: "confirmed",
    triageNote: note(observation.evidence),
  };
}
