/**
 * npm and PyPI registry lookups for supply-chain checks. Every request has a
 * timeout, every response is validated, and repeated network failures switch
 * the client offline so a scan without network still finishes quickly.
 */
import { z } from "zod";
import { paths, readJson, writeJsonAtomic } from "../persistence.js";
import type { Ecosystem } from "./manifests.js";

export type RegistryFetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<Response>;

export const REGISTRY_TIMEOUT_MS = 8_000;
/** Whole-scan budget for registry work; packages left after it are skipped. */
export const REGISTRY_DEADLINE_MS = 60_000;
export const REGISTRY_CONCURRENCY = 8;
/** Network failures in a row before the client stops trying. */
export const OFFLINE_AFTER_FAILURES = 3;
const FOUND_TTL_MS = 24 * 60 * 60 * 1000;
const MISSING_TTL_MS = 60 * 60 * 1000;
/** Expired entries stay this long as an offline fallback, so findings don't vanish without network. */
const STALE_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
const CACHE_VERSION = 1;
const MESSAGE_MAX = 300;

const NPM_REGISTRY = "https://registry.npmjs.org";
const NPM_DOWNLOADS = "https://api.npmjs.org/downloads/point/last-week";
const PYPI_SIMPLE = "https://pypi.org/simple";
const PYPI_SIMPLE_JSON = "application/vnd.pypi.simple.v1+json";

/** PEP 792 project status values. */
export type ProjectStatus = "active" | "archived" | "deprecated" | "quarantined";

const PackageFactsSchema = z.object({
  kind: z.literal("package"),
  createdAt: z.string().max(40).optional(),
  latest: z.string().max(100).optional(),
  /** Deprecation notice on the package (npm: on its latest version). */
  deprecated: z.string().max(MESSAGE_MAX).optional(),
  /** Deprecation notice on the declared version, when it differs from latest. */
  versionDeprecated: z.string().max(MESSAGE_MAX).optional(),
  installScripts: z.array(z.string().max(40)).max(5).optional(),
  status: z.enum(["active", "archived", "deprecated", "quarantined"]).optional(),
  statusReason: z.string().max(MESSAGE_MAX).optional(),
});
const MissingFactsSchema = z.object({ kind: z.literal("missing"), unpublished: z.boolean().optional() });
const DownloadsFactsSchema = z.object({ kind: z.literal("downloads"), weekly: z.number().int().nonnegative() });
const FactsSchema = z.discriminatedUnion("kind", [PackageFactsSchema, MissingFactsSchema, DownloadsFactsSchema]);

export type PackageFacts = z.infer<typeof PackageFactsSchema>;
export type MissingFacts = z.infer<typeof MissingFactsSchema>;
type Facts = z.infer<typeof FactsSchema>;

const CacheSchema = z.object({
  version: z.literal(CACHE_VERSION),
  entries: z.record(z.string(), z.object({ fetchedAt: z.string(), facts: FactsSchema })),
});
type CacheFile = z.infer<typeof CacheSchema>;

const NpmLatestSchema = z.object({
  version: z.string(),
  deprecated: z.unknown().optional(),
  scripts: z.record(z.string(), z.unknown()).optional(),
});
const NpmVersionSchema = z.object({
  deprecated: z.unknown().optional(),
  scripts: z.record(z.string(), z.unknown()).optional(),
});
const NpmPackumentSchema = z.object({
  "dist-tags": z.record(z.string(), z.string()).optional(),
  time: z.record(z.string(), z.unknown()).optional(),
  versions: z.record(z.string(), NpmVersionSchema).optional(),
});
const NpmDownloadsSchema = z.object({ downloads: z.number().int().nonnegative() });
const PypiSimpleSchema = z.object({
  versions: z.array(z.string()).optional(),
  files: z.array(z.object({ "upload-time": z.string().optional() })).optional(),
  "project-status": z.object({ status: z.string().optional(), reason: z.string().optional() }).optional(),
});

const INSTALL_HOOKS = ["preinstall", "install", "postinstall"] as const;

/** Why a lookup produced no facts. */
export type SkipReason = "offline" | "timeout" | "deadline" | "network error" | "rate limited" | "registry error" | "invalid response";

/** `stale` marks expired cache data served because the registry couldn't be reached. */
export type LookupResult<T> = { ok: true; facts: T; stale?: SkipReason } | { ok: false; reason: SkipReason };

type HttpResult = { kind: "ok"; body: unknown } | { kind: "missing" } | { kind: "error"; reason: SkipReason; network: boolean };

export interface RegistryClientOptions {
  root: string;
  fetch?: RegistryFetch;
  offline?: boolean;
  now?: Date;
  timeoutMs?: number;
  deadlineMs?: number;
}

export class RegistryClient {
  private readonly fetchImpl: RegistryFetch;
  private readonly timeoutMs: number;
  private readonly deadline: number;
  private readonly now: Date;
  private cache: CacheFile = { version: CACHE_VERSION, entries: {} };
  private cacheChanged = false;
  private consecutiveFailures = 0;
  private offlineReason: SkipReason | undefined;
  /** Requests actually sent, for tests and progress output. */
  requests = 0;

  constructor(private readonly opts: RegistryClientOptions) {
    this.fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init));
    this.timeoutMs = opts.timeoutMs ?? REGISTRY_TIMEOUT_MS;
    this.now = opts.now ?? new Date();
    this.deadline = Date.now() + (opts.deadlineMs ?? REGISTRY_DEADLINE_MS);
    if (opts.offline) this.offlineReason = "offline";
  }

  get offline(): SkipReason | undefined {
    return this.offlineReason;
  }

  async loadCache(): Promise<void> {
    const raw = await readJson<unknown>(paths(this.opts.root).registryCache);
    const parsed = CacheSchema.safeParse(raw);
    // A missing, old-version, or corrupt cache starts empty and is rewritten.
    if (parsed.success) this.cache = parsed.data;
  }

  /** Writes the cache if lookups changed it. Returns the error message on failure. */
  async saveCache(): Promise<string | undefined> {
    if (!this.cacheChanged) return undefined;
    const cutoff = this.now.getTime() - STALE_KEEP_MS;
    const entries = Object.fromEntries(Object.entries(this.cache.entries).filter(([, e]) => Date.parse(e.fetchedAt) > cutoff));
    try {
      await writeJsonAtomic(paths(this.opts.root).registryCache, { version: CACHE_VERSION, entries });
      this.cacheChanged = false;
      return undefined;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  /** Facts for one package; `version` picks which version's scripts and deprecation to read (npm). */
  lookupPackage(ecosystem: Ecosystem, name: string, opts: { popular: boolean; version?: string }): Promise<LookupResult<PackageFacts | MissingFacts>> {
    const key = `${ecosystem}:${name}@${opts.version ?? "latest"}${opts.popular ? ":p" : ""}`;
    return this.cached(key, async () => {
      if (ecosystem === "PyPI") return this.pypiFacts(name);
      return opts.popular ? this.npmLatestFacts(name) : this.npmPackumentFacts(name, opts.version);
    }) as Promise<LookupResult<PackageFacts | MissingFacts>>;
  }

  lookupWeeklyDownloads(name: string): Promise<LookupResult<number>> {
    return this.cached(`npm-downloads:${name}`, async () => {
      const res = await this.getJson(`${NPM_DOWNLOADS}/${name}`, "application/json");
      if (res.kind === "missing") return { ok: true, facts: { kind: "downloads", weekly: 0 } };
      if (res.kind === "error") return { ok: false, reason: res.reason };
      const body = NpmDownloadsSchema.safeParse(res.body);
      return body.success ? { ok: true, facts: { kind: "downloads", weekly: body.data.downloads } } : { ok: false, reason: "invalid response" };
    }).then((r): LookupResult<number> => {
      if (!r.ok) return r;
      return r.facts.kind === "downloads" ? { ok: true, facts: r.facts.weekly, stale: r.stale } : { ok: false, reason: "invalid response" };
    });
  }

  private async cached(key: string, load: () => Promise<LookupResult<Facts>>): Promise<LookupResult<Facts>> {
    const hit = this.cache.entries[key];
    if (hit) {
      const ttl = hit.facts.kind === "missing" ? MISSING_TTL_MS : FOUND_TTL_MS;
      if (this.now.getTime() - Date.parse(hit.fetchedAt) < ttl) return { ok: true, facts: hit.facts };
    }
    const result = await load();
    if (result.ok) {
      this.cache.entries[key] = { fetchedAt: this.now.toISOString(), facts: result.facts };
      this.cacheChanged = true;
    } else if (hit) {
      return { ok: true, facts: hit.facts, stale: result.reason };
    }
    return result;
  }

  private async getJson(url: string, accept: string): Promise<HttpResult> {
    if (this.offlineReason) return { kind: "error", reason: this.offlineReason, network: false };
    const remaining = this.deadline - Date.now();
    if (remaining <= 0) return { kind: "error", reason: "deadline", network: false };
    this.requests++;
    let res: Response;
    try {
      res = await this.fetchImpl(url, { headers: { accept }, signal: AbortSignal.timeout(Math.min(this.timeoutMs, remaining)) });
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      return this.networkFailure(timedOut ? "timeout" : "network error");
    }
    this.consecutiveFailures = 0;
    if (res.status === 404) return { kind: "missing" };
    if (res.status === 429) return { kind: "error", reason: "rate limited", network: false };
    if (!res.ok) return { kind: "error", reason: "registry error", network: false };
    try {
      return { kind: "ok", body: await res.json() };
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      return timedOut ? this.networkFailure("timeout") : { kind: "error", reason: "invalid response", network: false };
    }
  }

  private networkFailure(reason: SkipReason): HttpResult {
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= OFFLINE_AFTER_FAILURES) this.offlineReason = reason;
    return { kind: "error", reason, network: true };
  }

  private async npmLatestFacts(name: string): Promise<LookupResult<Facts>> {
    const res = await this.getJson(`${NPM_REGISTRY}/${npmPath(name)}/latest`, "application/json");
    if (res.kind === "missing") return { ok: true, facts: { kind: "missing" } };
    if (res.kind === "error") return { ok: false, reason: res.reason };
    const body = NpmLatestSchema.safeParse(res.body);
    if (!body.success) return { ok: false, reason: "invalid response" };
    return { ok: true, facts: { kind: "package", latest: body.data.version, deprecated: deprecationText(body.data.deprecated) } };
  }

  private async npmPackumentFacts(name: string, version: string | undefined): Promise<LookupResult<Facts>> {
    const res = await this.getJson(`${NPM_REGISTRY}/${npmPath(name)}`, "application/json");
    if (res.kind === "missing") return { ok: true, facts: { kind: "missing" } };
    if (res.kind === "error") return { ok: false, reason: res.reason };
    const body = NpmPackumentSchema.safeParse(res.body);
    if (!body.success) return { ok: false, reason: "invalid response" };
    const { time = {}, versions = {} } = body.data;
    const latest = body.data["dist-tags"]?.latest;
    // An unpublished package keeps a stub packument with no versions.
    if (!latest || !versions[latest]) return { ok: true, facts: { kind: "missing", unpublished: typeof time.unpublished === "object" } };
    const declared = version && versions[version] ? version : latest;
    const declaredMeta = versions[declared]!;
    const scripts = Object.keys(declaredMeta.scripts ?? {}).filter((s) => (INSTALL_HOOKS as readonly string[]).includes(s));
    const versionDeprecated = declared !== latest ? deprecationText(declaredMeta.deprecated) : undefined;
    return {
      ok: true,
      facts: {
        kind: "package",
        createdAt: typeof time.created === "string" ? time.created : undefined,
        latest,
        deprecated: deprecationText(versions[latest]!.deprecated),
        versionDeprecated,
        installScripts: scripts.length ? scripts : undefined,
      },
    };
  }

  private async pypiFacts(name: string): Promise<LookupResult<Facts>> {
    const res = await this.getJson(`${PYPI_SIMPLE}/${name}/`, PYPI_SIMPLE_JSON);
    if (res.kind === "missing") return { ok: true, facts: { kind: "missing" } };
    if (res.kind === "error") return { ok: false, reason: res.reason };
    const body = PypiSimpleSchema.safeParse(res.body);
    if (!body.success) return { ok: false, reason: "invalid response" };
    const uploads = (body.data.files ?? []).map((f) => f["upload-time"]).filter((t): t is string => !!t).sort();
    const status = body.data["project-status"]?.status;
    const known = status === "archived" || status === "deprecated" || status === "quarantined" || status === "active" ? status : undefined;
    if (!uploads.length && !body.data.versions?.length && known !== "quarantined") return { ok: true, facts: { kind: "missing" } };
    return {
      ok: true,
      facts: {
        kind: "package",
        createdAt: uploads[0],
        latest: latestStable(body.data.versions ?? []),
        status: known,
        statusReason: body.data["project-status"]?.reason?.slice(0, MESSAGE_MAX),
      },
    };
  }
}

/** Scoped names keep the `@` and escape the slash, as the npm registry expects. */
const npmPath = (name: string) => name.replace("/", "%2f");

function deprecationText(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim().slice(0, MESSAGE_MAX);
  if (value === true) return "deprecated";
  return undefined;
}

/** Highest release version made only of numbers (skips pre-releases and dev builds). */
export function latestStable(versions: string[]): string | undefined {
  const stable = versions.filter((v) => /^\d+(\.\d+)*$/.test(v));
  return stable.sort(compareNumericVersions).at(-1);
}

export function compareNumericVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** Runs `work` over `items` with at most `limit` in flight. */
export async function mapLimit<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await work(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}
