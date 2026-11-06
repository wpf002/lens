/**
 * Which hosts `lens probe` may send traffic to. Local dev hosts always; one
 * staging host only when passed explicitly and named like a test environment.
 * Everything else is refused before a single request goes out.
 */
import { lookup } from "node:dns/promises";
import net from "node:net";

export class ProbeRefused extends Error {}

const LOOPBACK_LITERALS = new Set(["127.0.0.1", "::1"]);
const TEST_ENV_LABEL = /^(?:staging|stage|dev|test|qa|sandbox|preview)(?:-[a-z0-9-]+)?$|-(?:staging|stage|dev|test|qa|sandbox|preview)$/;
const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

export interface TargetPolicy {
  target: URL;
  /** Host passed with --staging-host. Must equal the target host. */
  stagingHost?: string;
  /** Host of the project's public site (`project.homepage`). Never probed. */
  homepageHost?: string;
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

export function isLocalDevHost(host: string): boolean {
  const h = normalizeHost(host);
  return h === "localhost" || LOOPBACK_LITERALS.has(h) || h.endsWith(".localhost") || h.endsWith(".test");
}

/** A label left of the registrable domain names a test environment, e.g. staging.app.com or api-dev.app.com. */
export function looksLikeTestEnvironment(host: string): boolean {
  const labels = normalizeHost(host).split(".");
  if (labels.length < 3) return false;
  return labels.slice(0, -2).some((label) => TEST_ENV_LABEL.test(label));
}

/** Throws ProbeRefused unless the target is a local dev host or the explicitly named staging host. */
export function checkTarget({ target, stagingHost, homepageHost }: TargetPolicy): void {
  if (!ALLOWED_PROTOCOLS.has(target.protocol)) throw new ProbeRefused(`Only http and https targets are allowed, got ${target.protocol}`);
  if (target.username || target.password) throw new ProbeRefused("Target URL must not contain credentials.");
  const host = normalizeHost(target.hostname);
  if (homepageHost && normalizeHost(homepageHost) === host) throw new ProbeRefused(`${host} is the project's public homepage. Lens never probes production.`);
  if (isLocalDevHost(host)) return;
  if (!stagingHost) throw new ProbeRefused(`${host} isn't a local dev host. Pass it with --staging-host to probe a staging environment.`);
  if (normalizeHost(stagingHost) !== host) throw new ProbeRefused(`--staging-host ${stagingHost} doesn't match the target host ${host}.`);
  if (!looksLikeTestEnvironment(host)) throw new ProbeRefused(`${host} doesn't look like a test environment. A subdomain label must be staging, stage, dev, test, qa, sandbox, or preview.`);
}

/** The single gate every request URL passes through: same protocol, host, and port as the vetted target. */
export function isSameOrigin(url: URL, target: URL): boolean {
  return url.origin === target.origin && !url.username && !url.password;
}

function isLoopback(address: string): boolean {
  if (net.isIPv4(address)) return address.startsWith("127.");
  return address === "::1" || address === "::ffff:127.0.0.1";
}

/** Link-local (cloud metadata lives at 169.254.169.254) and unspecified addresses are never targets. */
function isForbiddenAddress(address: string): boolean {
  if (net.isIPv4(address)) return address.startsWith("169.254.") || address === "0.0.0.0";
  const a = address.toLowerCase();
  return a === "::" || a.startsWith("fe80:") || a.startsWith("::ffff:169.254.");
}

type LookupAll = (host: string) => Promise<Array<{ address: string; family: number }>>;
const systemLookup: LookupAll = (host) => lookup(host, { all: true });

/**
 * Resolve the target once and return the address every request will be pinned to,
 * so a DNS change mid-run can't move traffic to another machine.
 */
export async function resolveTarget(host: string, lookupAll: LookupAll = systemLookup): Promise<ResolvedAddress> {
  return (await resolveTargetAddresses(host, lookupAll))[0]!;
}

/** Every address the target resolves to, each checked against the same rules. */
export async function resolveTargetAddresses(host: string, lookupAll: LookupAll = systemLookup): Promise<ResolvedAddress[]> {
  const h = normalizeHost(host);
  const literal = net.isIP(h);
  const addresses = literal ? [{ address: h, family: literal }] : await lookupAll(h);
  if (!addresses.length) throw new ProbeRefused(`${h} did not resolve.`);
  const mustBeLoopback = h === "localhost" || h.endsWith(".localhost") || LOOPBACK_LITERALS.has(h);
  for (const a of addresses) {
    if (mustBeLoopback && !isLoopback(a.address)) throw new ProbeRefused(`${h} resolves to ${a.address}, which isn't loopback.`);
    if (isForbiddenAddress(a.address)) throw new ProbeRefused(`${h} resolves to ${a.address}, a link-local or unspecified address.`);
  }
  return addresses.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));
}
