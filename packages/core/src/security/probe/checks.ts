/**
 * Read probe responses and record what they prove. Pure. A check only reports
 * what a response shows; no response is ever taken as proof that code is safe,
 * except a 401/403 (or login redirect) on an unauthenticated request.
 */
import type { Exchange, ProbeResponse } from "./client.js";
import { PROBE_ORIGIN, type PlannedRequest } from "./plan.js";

export type ObservationKind =
  | "auth-enforced" | "auth-missing" | "idor" | "reflected-xss" | "sql-error" | "verbose-error" | "missing-headers" | "cors-reflect";

export interface Observation {
  kind: ObservationKind;
  /** Absent for host-level results (headers, CORS). */
  endpointId?: string;
  evidence: string;
  /** cors-reflect only: the response also allowed credentials. */
  credentials?: boolean;
}

export interface Evaluation {
  observations: Observation[];
  /** `${kind}|${endpointId ?? HOST_KEY}` for every check that got a usable response this run. */
  covered: Set<string>;
}

export const HOST_KEY = "host";
export const coverageKey = (kind: ObservationKind, endpointId?: string) => `${kind}|${endpointId ?? HOST_KEY}`;

const SQL_ERROR_RE =
  /SQLSTATE\[|syntax error at or near|You have an error in your SQL syntax|SQLITE_ERROR|sqlite3\.OperationalError|unterminated quoted string|quoted string not properly terminated|Unclosed quotation mark|ORA-0\d{4}|PG::SyntaxError|psycopg2?\.errors|ER_PARSE_ERROR/i;
const STACK_TRACE_RE =
  /^\s*at .+?:\d+:\d+\)?\s*$|Traceback \(most recent call last\)|^\s*at [\w$.]+\(\w+\.(?:java|kt):\d+\)|Werkzeug Debugger|DEBUG = True|^Stack trace:\s*$\n#0 /m;
const LOGIN_REDIRECT_RE = /login|sign-?in|auth/i;
const XSS_WINDOW = 40;

const isSuccess = (r: ProbeResponse) => r.status >= 200 && r.status < 300;
const describe = (request: PlannedRequest, response: ProbeResponse) => `${request.method} ${request.path} returned ${response.status}`.slice(0, 300);

function authEnforced(response: ProbeResponse): boolean {
  if (response.status === 401 || response.status === 403) return true;
  const location = response.headers.location ?? "";
  return response.status >= 300 && response.status < 400 && LOGIN_REDIRECT_RE.test(location);
}

function reflectsUnescaped(response: ProbeResponse, marker: string): boolean {
  if (!/text\/html/i.test(response.headers["content-type"] ?? "")) return false;
  const token = marker.slice(0, marker.indexOf('"'));
  const at = response.body.indexOf(token);
  if (at < 0) return false;
  return response.body.slice(at, at + marker.length + XSS_WINDOW).includes("<x>");
}

function missingSecurityHeaders(response: ProbeResponse, https: boolean): string[] {
  const h = response.headers;
  const csp = h["content-security-policy"] ?? "";
  const missing: string[] = [];
  if (!csp) missing.push("Content-Security-Policy");
  if ((h["x-content-type-options"] ?? "").toLowerCase() !== "nosniff") missing.push("X-Content-Type-Options");
  if (!h["x-frame-options"] && !/frame-ancestors/i.test(csp)) missing.push("X-Frame-Options or frame-ancestors");
  if (!h["referrer-policy"]) missing.push("Referrer-Policy");
  if (https && !h["strict-transport-security"]) missing.push("Strict-Transport-Security");
  return missing;
}

export function evaluateExchanges(exchanges: Exchange[], { marker, https }: { marker: string; https: boolean }): Evaluation {
  const observations: Observation[] = [];
  const covered = new Set<string>();
  const verboseSeen = new Set<string>();
  const idorPairs = new Map<string, { baseline?: Exchange; swap?: Exchange }>();
  const corsPaths: string[] = [];
  let corsCredentials = false;

  for (const exchange of exchanges) {
    const { request, response } = exchange;
    if (!response) continue;
    const endpointId = request.endpointId;

    if (request.withOrigin) {
      covered.add(coverageKey("cors-reflect"));
      if (response.headers["access-control-allow-origin"] === PROBE_ORIGIN) {
        corsPaths.push(request.path);
        if (response.headers["access-control-allow-credentials"] === "true") corsCredentials = true;
      }
    }

    if (endpointId) {
      covered.add(coverageKey("verbose-error", endpointId));
      if (!verboseSeen.has(endpointId) && STACK_TRACE_RE.test(response.body)) {
        verboseSeen.add(endpointId);
        observations.push({ kind: "verbose-error", endpointId, evidence: `${describe(request, response)} with a stack trace in the body` });
      }
    }

    switch (request.kind) {
      case "headers": {
        if (response.status >= 500) break;
        covered.add(coverageKey("missing-headers"));
        const missing = missingSecurityHeaders(response, https);
        if (missing.length) observations.push({ kind: "missing-headers", evidence: `GET / is missing ${missing.join(", ")}` });
        break;
      }
      case "unauth":
        if (authEnforced(response)) observations.push({ kind: "auth-enforced", endpointId, evidence: `${describe(request, response)} without credentials` });
        else if (isSuccess(response)) observations.push({ kind: "auth-missing", endpointId, evidence: `${describe(request, response)} without credentials` });
        break;
      case "idor-baseline":
      case "idor-swap": {
        const pair = idorPairs.get(endpointId!) ?? {};
        if (request.kind === "idor-baseline") pair.baseline = exchange;
        else pair.swap = exchange;
        idorPairs.set(endpointId!, pair);
        break;
      }
      case "reflect":
        covered.add(coverageKey("reflected-xss", endpointId));
        if (reflectsUnescaped(response, marker)) observations.push({ kind: "reflected-xss", endpointId, evidence: `${describe(request, response)} and echoed the marker unescaped into HTML` });
        break;
      case "sql":
        covered.add(coverageKey("sql-error", endpointId));
        if (SQL_ERROR_RE.test(response.body) && !observations.some((o) => o.kind === "sql-error" && o.endpointId === endpointId)) {
          const signature = SQL_ERROR_RE.exec(response.body)![0];
          observations.push({ kind: "sql-error", endpointId, evidence: `${describe(request, response)} with database error "${signature}"` });
        }
        break;
    }
  }

  for (const [endpointId, { baseline, swap }] of idorPairs) {
    if (!baseline?.response || !swap?.response) continue;
    covered.add(coverageKey("idor", endpointId));
    const sameObject = isSuccess(baseline.response) && isSuccess(swap.response) && baseline.response.body.trim().length > 0 && swap.response.body === baseline.response.body;
    if (sameObject) observations.push({ kind: "idor", endpointId, evidence: `Account A got account B's object: ${describe(swap.request, swap.response)} with the same body B sees` });
  }

  if (corsPaths.length) {
    const credentialNote = corsCredentials ? " and allowed credentials" : "";
    observations.push({ kind: "cors-reflect", credentials: corsCredentials, evidence: `Echoed Origin ${PROBE_ORIGIN}${credentialNote} on ${corsPaths.slice(0, 3).join(", ")}${corsPaths.length > 3 ? ` +${corsPaths.length - 3}` : ""}`.slice(0, 300) });
  }
  return { observations, covered };
}
