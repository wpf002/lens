/**
 * The only code in Lens that sends probe traffic. Every request is re-checked
 * against the vetted origin and method rules, pinned to the address resolved
 * up front, rate-limited, time-limited, and never follows redirects.
 */
import http from "node:http";
import https from "node:https";
import net, { type LookupFunction } from "node:net";
import { ProbeRefused, isSameOrigin, type ResolvedAddress } from "./allowlist.js";
import { PROBE_MAX_REQUESTS_HARD, PROBE_RATE_LIMIT_MAX, type AccountHeaders } from "./config.js";
import { PROBE_ORIGIN, type PlannedRequest } from "./plan.js";

export const PROBE_TIMEOUT_MS = 5_000;
export const PROBE_BODY_CAP_BYTES = 256 * 1024;
export const PROBE_MAX_SERVER_ERRORS = 10;
export const PROBE_MAX_RETRY_AFTER_MS = 30_000;
/** Stop when this many requests in a row fail to connect: the app went down or was never up. */
export const PROBE_MAX_CONSECUTIVE_FAILURES = 5;
/** Pause after a failed connection so a dev server restarting on file change can come back. */
export const PROBE_CONNECTION_RETRY_DELAY_MS = 1_000;
const CONNECT_CHECK_TIMEOUT_MS = 2_000;
const DEFAULT_RETRY_AFTER_MS = 1_000;
const USER_AGENT = "lens-probe";

export interface ProbeResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  ms: number;
}

export interface Exchange {
  request: PlannedRequest;
  /** Absent when the request failed (timeout, connection refused). */
  response?: ProbeResponse;
  error?: string;
}

export interface ProbeLogEntry {
  at: string;
  kind: PlannedRequest["kind"];
  method: string;
  path: string;
  status?: number;
  ms?: number;
  error?: string;
}

export interface RunOptions {
  target: URL;
  pinned: ResolvedAddress;
  rateLimit: number;
  maxRequests: number;
  /** POST routes from safeToProbe, checked again here so a bad plan can't send other POSTs. */
  safePosts: ReadonlySet<string>;
  accounts?: AccountHeaders;
  log?: (entry: ProbeLogEntry) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface RunResult {
  exchanges: Exchange[];
  stoppedReason?: string;
}

function acceptsConnections(address: ResolvedAddress, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: address.address, family: address.family, port, timeout: CONNECT_CHECK_TIMEOUT_MS });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

/**
 * Pick the first vetted address with something listening on the target port.
 * localhost resolves to both ::1 and 127.0.0.1, and many dev servers bind only one.
 * Opens a TCP connection and closes it; sends no HTTP.
 */
export async function findListeningAddress(addresses: ResolvedAddress[], target: URL): Promise<ResolvedAddress> {
  const port = Number(target.port || (target.protocol === "https:" ? 443 : 80));
  for (const address of addresses) if (await acceptsConnections(address, port)) return address;
  throw new ProbeRefused(`Nothing is listening on ${target.host}. Start the app, then run the probe again.`);
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Refuse anything the safety rules don't allow, even if the planner produced it. */
export function assertRequestAllowed(request: PlannedRequest, url: URL, options: Pick<RunOptions, "target" | "safePosts">): void {
  if (!isSameOrigin(url, options.target)) throw new ProbeRefused(`Refusing ${url.href}: not the probe target ${options.target.origin}.`);
  if (request.method === "GET" || request.method === "HEAD") return;
  if (request.method === "POST" && request.route && options.safePosts.has(`POST ${request.route}`)) return;
  throw new ProbeRefused(`Refusing ${request.method} ${request.path}: only GET, HEAD, and POSTs listed in safeToProbe are sent.`);
}

function pinnedLookup(pinned: ResolvedAddress): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all) callback(null, [{ address: pinned.address, family: pinned.family }]);
    else callback(null, pinned.address, pinned.family);
  };
}

function buildHeaders(request: PlannedRequest, accounts: AccountHeaders | undefined): Record<string, string> {
  const headers: Record<string, string> = { "user-agent": USER_AGENT, accept: "*/*" };
  if (request.account) {
    const accountHeaders = accounts?.[request.account];
    if (!accountHeaders) throw new ProbeRefused(`Request needs account ${request.account}, which isn't configured.`);
    Object.assign(headers, accountHeaders);
  }
  if (request.withOrigin) headers.origin = PROBE_ORIGIN;
  if (request.body !== undefined) {
    headers["content-type"] = "application/json";
    headers["content-length"] = String(Buffer.byteLength(request.body));
  }
  return headers;
}

function send(url: URL, request: PlannedRequest, headers: Record<string, string>, pinned: ResolvedAddress, now: () => number): Promise<ProbeResponse> {
  const transport = url.protocol === "https:" ? https : http;
  const started = now();
  return new Promise((resolve, reject) => {
    const req = transport.request(
      { protocol: url.protocol, hostname: url.hostname.replace(/^\[|\]$/g, ""), port: url.port, path: url.pathname + url.search, method: request.method, headers, lookup: pinnedLookup(pinned), agent: false, timeout: PROBE_TIMEOUT_MS },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        const finish = () => {
          const responseHeaders: Record<string, string> = {};
          for (const [name, value] of Object.entries(res.headers)) if (value !== undefined) responseHeaders[name] = Array.isArray(value) ? value.join(", ") : value;
          resolve({ status: res.statusCode ?? 0, headers: responseHeaders, body: Buffer.concat(chunks).toString("utf8"), ms: now() - started });
        };
        res.on("data", (chunk: Buffer) => {
          const room = PROBE_BODY_CAP_BYTES - size;
          if (room > 0) chunks.push(chunk.subarray(0, room));
          size += chunk.length;
          if (size >= PROBE_BODY_CAP_BYTES) {
            res.removeAllListeners("data");
            res.destroy();
            finish();
          }
        });
        res.on("end", finish);
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error(`timed out after ${PROBE_TIMEOUT_MS}ms`)));
    req.on("error", reject);
    if (request.body !== undefined) req.write(request.body);
    req.end();
  });
}

function retryAfterMs(header: string | undefined): number {
  const seconds = Number(header);
  const ms = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : DEFAULT_RETRY_AFTER_MS;
  return Math.min(ms, PROBE_MAX_RETRY_AFTER_MS);
}

/** Send the planned requests one at a time. */
export async function runProbes(requests: PlannedRequest[], options: RunOptions): Promise<RunResult> {
  const sleep = options.sleep ?? realSleep;
  const now = options.now ?? Date.now;
  const rate = Math.min(options.rateLimit, PROBE_RATE_LIMIT_MAX);
  const limit = Math.min(options.maxRequests, PROBE_MAX_REQUESTS_HARD);
  const intervalMs = 1000 / rate;
  const exchanges: Exchange[] = [];
  let sent = 0;
  let serverErrors = 0;
  let consecutiveFailures = 0;
  let nextSlot = now();

  const sendPaced = async (request: PlannedRequest, url: URL, headers: Record<string, string>) => {
    const wait = nextSlot - now();
    if (wait > 0) await sleep(wait);
    nextSlot = Math.max(now(), nextSlot) + intervalMs;
    sent++;
    return send(url, request, headers, options.pinned, now);
  };

  for (const request of requests) {
    if (sent >= limit) return { exchanges, stoppedReason: `reached the ${limit}-request cap` };
    const url = new URL(request.path, options.target);
    assertRequestAllowed(request, url, options);
    const headers = buildHeaders(request, options.accounts);
    const entry: ProbeLogEntry = { at: new Date().toISOString(), kind: request.kind, method: request.method, path: request.path };
    try {
      let response = await sendPaced(request, url, headers);
      if (response.status === 429 && sent < limit) {
        await sleep(retryAfterMs(response.headers["retry-after"]));
        response = await sendPaced(request, url, headers);
      }
      consecutiveFailures = 0;
      exchanges.push({ request, response });
      options.log?.({ ...entry, status: response.status, ms: response.ms });
      if (response.status >= 500 && ++serverErrors >= PROBE_MAX_SERVER_ERRORS) {
        return { exchanges, stoppedReason: `stopped after ${serverErrors} server errors` };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      exchanges.push({ request, error: message });
      options.log?.({ ...entry, error: message });
      if (++consecutiveFailures >= PROBE_MAX_CONSECUTIVE_FAILURES) {
        return { exchanges, stoppedReason: `stopped after ${consecutiveFailures} failed connections in a row (${message})` };
      }
      await sleep(PROBE_CONNECTION_RETRY_DELAY_MS);
    }
  }
  return { exchanges };
}
