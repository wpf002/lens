/**
 * Turn the graph's extracted endpoints into the exact list of requests a probe
 * run will send. Pure: no network, no secrets. `--dry-run` prints this list.
 */
import type { GraphNode, KnowledgeGraph } from "../../types.js";
import type { AccountName, ProbeConfig } from "./config.js";

export type ProbeMethod = "GET" | "HEAD" | "POST";
export type ProbeKind = "headers" | "unauth" | "idor-baseline" | "idor-swap" | "reflect" | "sql";

export interface PlannedRequest {
  kind: ProbeKind;
  /** Endpoint node id; absent for the host-level request. */
  endpointId?: string;
  /** Route template from the graph, e.g. /api/orders/:id. */
  route?: string;
  method: ProbeMethod;
  /** Path plus query, always starting with "/". */
  path: string;
  account?: AccountName;
  /** JSON body, only for POST routes listed in safeToProbe. */
  body?: string;
  /** Send `Origin: PROBE_ORIGIN` to test CORS reflection. */
  withOrigin?: boolean;
}

export interface SkippedEndpoint {
  endpointId: string;
  reason: string;
}

export interface ProbePlan {
  runId: string;
  marker: string;
  requests: PlannedRequest[];
  skipped: SkippedEndpoint[];
  /** Requests dropped by the maxRequests cap. */
  truncated: number;
}

/** Reserved TLD: this origin can't resolve, so CORS checks never reach a real host. */
export const PROBE_ORIGIN = "https://lens-probe.invalid";
export const REFLECT_PARAM = "lensprobe";
const DEFAULT_PARAM_VALUE = "1";
const SQL_QUOTES = ["'", '"'] as const;
const READ_METHODS = new Set(["GET", "HEAD", "ANY", "ALL"]);
const PROBED_ENTRY_TYPES = new Set(["http", "webhook"]);
const UNVERIFIED_AUTH = new Set(["unguarded", "unknown"]);

/** Benign marker: a run id plus characters an HTML encoder must escape. */
export const reflectMarker = (runId: string) => `lp${runId}"'<x>`;

// :id, :id*, :id?, {id}, {id:int}, <id>, <int:id>
const PARAM_RE = /:([A-Za-z_]\w*)[*?]?|\{([A-Za-z_]\w*)(?::[^}]*)?\}|<(?:\w+:)?([A-Za-z_]\w*)>/g;
// Regex-style routes (Django re_path) and bare wildcards can't be filled in reliably.
const UNTEMPLATABLE_RE = /[\^$()\\|*]/;

export function routeParams(route: string): string[] {
  return [...route.matchAll(PARAM_RE)].map((m) => m[1] ?? m[2] ?? m[3]!);
}

export function isTemplatable(route: string): boolean {
  return route.startsWith("/") && !UNTEMPLATABLE_RE.test(route.replace(PARAM_RE, "p"));
}

/** Replace each route parameter with a URL-encoded value. */
export function fillRoute(route: string, valueFor: (param: string, index: number) => string): string {
  let index = 0;
  return route.replace(PARAM_RE, (_match, a?: string, b?: string, c?: string) => encodeURIComponent(valueFor((a ?? b ?? c)!, index++)));
}

export function probeMethod(endpoint: NonNullable<GraphNode["endpoint"]>, safePosts: ReadonlySet<string>): ProbeMethod | undefined {
  const methods = (endpoint.method ?? "ANY").toUpperCase().split(/[\s,|]+/);
  if (methods.some((m) => READ_METHODS.has(m))) return "GET";
  if (methods.includes("POST") && safePosts.has(`POST ${endpoint.route}`)) return "POST";
  return undefined;
}

interface PlanOptions {
  runId: string;
  accountsConfigured: boolean;
}

export function planProbes(graph: Pick<KnowledgeGraph, "nodes">, config: ProbeConfig, { runId, accountsConfigured }: PlanOptions): ProbePlan {
  const marker = reflectMarker(runId);
  const safePosts = new Set(config.safeToProbe);
  const requests: PlannedRequest[] = [{ kind: "headers", method: "GET", path: "/", withOrigin: true }];
  const skipped: SkippedEndpoint[] = [];
  const asA: Pick<PlannedRequest, "account"> = accountsConfigured ? { account: "a" } : {};

  const endpoints = graph.nodes.filter((n) => n.kind === "endpoint" && n.endpoint).sort((x, y) => x.id.localeCompare(y.id));
  for (const node of endpoints) {
    const endpoint = node.endpoint!;
    if (!PROBED_ENTRY_TYPES.has(endpoint.entryType)) {
      if (endpoint.entryType === "server-action") skipped.push({ endpointId: node.id, reason: "server actions need a framework action id" });
      continue;
    }
    const route = endpoint.route;
    if (!isTemplatable(route)) {
      skipped.push({ endpointId: node.id, reason: "route pattern can't be filled in" });
      continue;
    }
    const method = probeMethod(endpoint, safePosts);
    if (!method) {
      skipped.push({ endpointId: node.id, reason: `${endpoint.method ?? "ANY"} isn't sent unless listed in safeToProbe` });
      continue;
    }
    const base = { endpointId: node.id, route, method };
    const defaultPath = fillRoute(route, () => DEFAULT_PARAM_VALUE);
    const postBody = (fields: Record<string, string>) => (method === "POST" ? { body: JSON.stringify(fields) } : {});

    if (UNVERIFIED_AUTH.has(endpoint.auth)) requests.push({ ...base, kind: "unauth", path: defaultPath, ...postBody({}) });

    const objects = config.objects[route];
    if (objects && accountsConfigured && method === "GET") {
      const objectPath = fillRoute(route, () => objects.b);
      requests.push({ ...base, kind: "idor-baseline", path: objectPath, account: "b" });
      requests.push({ ...base, kind: "idor-swap", path: objectPath, account: "a" });
    }

    const reflectPath = method === "POST" ? defaultPath : `${defaultPath}?${REFLECT_PARAM}=${encodeURIComponent(marker)}`;
    requests.push({ ...base, kind: "reflect", path: reflectPath, withOrigin: true, ...asA, ...postBody({ [REFLECT_PARAM]: marker }) });

    if (method === "GET") {
      const params = routeParams(route);
      for (const quote of SQL_QUOTES) {
        if (params.length) {
          for (let target = 0; target < params.length; target++) {
            const path = fillRoute(route, (_p, i) => (i === target ? `${DEFAULT_PARAM_VALUE}${quote}` : DEFAULT_PARAM_VALUE));
            requests.push({ ...base, kind: "sql", path, ...asA });
          }
        } else {
          requests.push({ ...base, kind: "sql", path: `${defaultPath}?${REFLECT_PARAM}=${encodeURIComponent(DEFAULT_PARAM_VALUE + quote)}`, ...asA });
        }
      }
    }
  }

  const truncated = Math.max(0, requests.length - config.maxRequests);
  return { runId, marker, requests: requests.slice(0, config.maxRequests), skipped, truncated };
}
