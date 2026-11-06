/**
 * npm and PyPI registry lookups for supply-chain checks. Every request has a
 * timeout, every response is validated, and repeated network failures switch
 * the client offline so a scan without network still finishes quickly.
 */
import { execFile } from "node:child_process";
import { z } from "zod";
import { paths, readJson, writeJsonAtomic } from "../persistence.js";
import type { Ecosystem } from "./manifests.js";

export type RegistryFetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<Response>;
/** Resolves a git ref to its commit SHA, or undefined when the ref doesn't exist. Throws on network failure. */
export type GitResolve = (url: string, ref: string, signal: AbortSignal) => Promise<string | undefined>;

export const REGISTRY_TIMEOUT_MS = 8_000;
/** Whole-scan budget for registry work; packages left after it are skipped. */
export const REGISTRY_DEADLINE_MS = 60_000;
export const REGISTRY_CONCURRENCY = 8;
/** Network failures in a row before the client stops trying. */
export const OFFLINE_AFTER_FAILURES = 3;
const FOUND_TTL_MS = 24 * 60 * 60 * 1000;
const MISSING_TTL_MS = 60 * 60 * 1000;
/** Repos get archived rarely, and unauthenticated GitHub calls are scarce (60 an hour). */
const GITHUB_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Uncached GitHub calls per scan; the rest wait for the next scan, served from cache after that. */
export const GITHUB_LOOKUPS_PER_SCAN = 40;
/** Expired entries stay this long as an offline fallback, so findings don't vanish without network. */
const STALE_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
/** Bumped when facts gain fields, so older entries are refetched instead of read without them. */
const CACHE_VERSION = 2;
const MESSAGE_MAX = 300;

const NPM_REGISTRY = "https://registry.npmjs.org";
const NPM_DOWNLOADS = "https://api.npmjs.org/downloads/point/last-week";
const PYPI_SIMPLE = "https://pypi.org/simple";
const PYPI_SIMPLE_JSON = "application/vnd.pypi.simple.v1+json";
const GITHUB_API = "https://api.github.com/repos";
const GITHUB_JSON = "application/vnd.github+json";
const USER_AGENT = "lens-supply-chain";
const COMMIT_SHA = /^[0-9a-f]{40}$/;

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
  /** GitHub `owner/repo` the package says its source lives in. */
  repository: z.string().max(200).optional(),
});
const MissingFactsSchema = z.object({ kind: z.literal("missing"), unpublished: z.boolean().optional() });
const DownloadsFactsSchema = z.object({ kind: z.literal("downloads"), weekly: z.number().int().nonnegative() });
const GithubFactsSchema = z.object({ kind: z.literal("github"), archived: z.boolean() });
const CommitFactsSchema = z.object({ kind: z.literal("commit"), sha: z.string().regex(COMMIT_SHA) });
const FactsSchema = z.discriminatedUnion("kind", [PackageFactsSchema, MissingFactsSchema, DownloadsFactsSchema, GithubFactsSchema, CommitFactsSchema]);

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
  repository: z.unknown().optional(),
});
const NpmVersionSchema = z.object({
  deprecated: z.unknown().optional(),
  scripts: z.record(z.string(), z.unknown()).optional(),
  repository: z.unknown().optional(),
});
const NpmPackumentSchema = z.object({
  "dist-tags": z.record(z.string(), z.string()).optional(),
  time: z.record(z.string(), z.unknown()).optional(),
  versions: z.record(z.string(), NpmVersionSchema).optional(),
});
const GithubRepoSchema = z.object({ archived: z.boolean() });
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
  gitResolve?: GitResolve;
  offline?: boolean;
  now?: Date;
  timeoutMs?: number;
  deadlineMs?: number;
}

export class RegistryClient {
  private readonly fetchImpl: RegistryFetch;
  private readonly gitResolve: GitResolve;
  private githubCalls = 0;
  private githubBlocked = false;
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
    this.gitResolve = opts.gitResolve ?? gitLsRemote;
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

  /** Whether a GitHub repo is archived. Capped per scan, and stops for the scan once GitHub rate-limits. */
  lookupGithubArchived(ownerRepo: string): Promise<LookupResult<boolean>> {
    return this.cached(`github:${ownerRepo.toLowerCase()}`, async () => {
      if (this.githubBlocked || this.githubCalls >= GITHUB_LOOKUPS_PER_SCAN) return { ok: false, reason: "rate limited" };
      this.githubCalls++;
      const res = await this.getJson(`${GITHUB_API}/${ownerRepo}`, GITHUB_JSON, { "user-agent": USER_AGENT });
      // A deleted or private repo says nothing about archival.
      if (res.kind === "missing") return { ok: true, facts: { kind: "github", archived: false } };
      if (res.kind === "error") {
        if (res.reason === "rate limited") this.githubBlocked = true;
        return { ok: false, reason: res.reason };
      }
      const body = GithubRepoSchema.safeParse(res.body);
      return body.success ? { ok: true, facts: { kind: "github", archived: body.data.archived } } : { ok: false, reason: "invalid response" };
    }).then((r): LookupResult<boolean> => {
      if (!r.ok) return r;
      return r.facts.kind === "github" ? { ok: true, facts: r.facts.archived, stale: r.stale } : { ok: false, reason: "invalid response" };
    });
  }

  /** Commit SHA a git ref points at now, or undefined when the repo or ref doesn't exist. */
  resolveCommit(url: string, ref: string): Promise<LookupResult<string | undefined>> {
    return this.cached(`commit:${url}#${ref}`, async () => {
      const gate = this.gate();
      if (gate) return { ok: false, reason: gate };
      this.requests++;
      let sha: string | undefined;
      try {
        sha = await this.gitResolve(url, ref, AbortSignal.timeout(Math.min(this.timeoutMs, this.deadline - Date.now())));
      } catch (err) {
        const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
        return { ok: false, reason: this.networkFailure(timedOut ? "timeout" : "network error").reason };
      }
      this.consecutiveFailures = 0;
      return sha && COMMIT_SHA.test(sha) ? { ok: true, facts: { kind: "commit", sha } } : { ok: true, facts: { kind: "missing" } };
    }).then((r): LookupResult<string | undefined> => {
      if (!r.ok) return r;
      return { ok: true, facts: r.facts.kind === "commit" ? r.facts.sha : undefined, stale: r.stale };
    });
  }

  /** Why no request can go out now, if any. */
  private gate(): SkipReason | undefined {
    if (this.offlineReason) return this.offlineReason;
    if (this.deadline - Date.now() <= 0) return "deadline";
    return undefined;
  }

  private async cached(key: string, load: () => Promise<LookupResult<Facts>>): Promise<LookupResult<Facts>> {
    const hit = this.cache.entries[key];
    if (hit) {
      const ttl = hit.facts.kind === "missing" ? MISSING_TTL_MS : hit.facts.kind === "github" ? GITHUB_TTL_MS : FOUND_TTL_MS;
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

  private async getJson(url: string, accept: string, headers: Record<string, string> = {}): Promise<HttpResult> {
    const gate = this.gate();
    if (gate) return { kind: "error", reason: gate, network: false };
    const remaining = this.deadline - Date.now();
    this.requests++;
    let res: Response;
    try {
      res = await this.fetchImpl(url, { headers: { ...headers, accept }, signal: AbortSignal.timeout(Math.min(this.timeoutMs, remaining)) });
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      return this.networkFailure(timedOut ? "timeout" : "network error");
    }
    this.consecutiveFailures = 0;
    if (res.status === 404) return { kind: "missing" };
    // GitHub answers an exhausted unauthenticated quota with 403 and x-ratelimit-remaining: 0.
    if (res.status === 429 || (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0")) return { kind: "error", reason: "rate limited", network: false };
    if (!res.ok) return { kind: "error", reason: "registry error", network: false };
    try {
      return { kind: "ok", body: await res.json() };
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      return timedOut ? this.networkFailure("timeout") : { kind: "error", reason: "invalid response", network: false };
    }
  }

  private networkFailure(reason: SkipReason): Extract<HttpResult, { kind: "error" }> {
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
    return { ok: true, facts: { kind: "package", latest: body.data.version, deprecated: deprecationText(body.data.deprecated), repository: githubRepo(body.data.repository) } };
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
        repository: githubRepo(versions[latest]!.repository),
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

/** `owner/repo` when a package.json `repository` field points at GitHub. */
export function githubRepo(value: unknown): string | undefined {
  const raw = typeof value === "string" ? value : typeof value === "object" && value && "url" in value && typeof value.url === "string" ? value.url : undefined;
  if (!raw) return undefined;
  const short = /^(?:github:)?([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(raw);
  const full = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[#/].*)?$/i.exec(raw);
  const m = full ?? (raw.includes(":") && !raw.startsWith("github:") ? null : short);
  return m ? `${m[1]}/${m[2]}` : undefined;
}

/** git's answers for a repo that doesn't exist or needs credentials Lens doesn't have. */
const GIT_NO_REPO = /not found|could not read username|authentication failed|permission denied|does not appear to be a git repository/i;

/** `git ls-remote` with prompts disabled, so a private repo fails instead of waiting for a password. */
const gitLsRemote: GitResolve = (url, ref, signal) =>
  new Promise((resolve, reject) => {
    // Asking for `ref^{}` too returns the commit an annotated tag points at, not the tag object.
    execFile("git", ["ls-remote", "--", url, ref, `${ref}^{}`], {
      signal,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: "ssh -o BatchMode=yes" },
    }, (err, stdout, stderr) => {
      if (err && !signal.aborted && GIT_NO_REPO.test(String(stderr))) return resolve(undefined);
      if (err) return reject(err);
      resolve(pickRef(stdout, ref));
    });
  });

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

/**
 * Commit for `ref` from `ls-remote` output. Patterns match any ref ending in `ref`, so only exact
 * names count; a peeled annotated tag (`^{}`) wins over the tag object, and tags over branches.
 */
export function pickRef(lsRemote: string, ref: string): string | undefined {
  const shas = new Map<string, string>();
  for (const line of lsRemote.split("\n")) {
    const [sha, name] = line.split("\t");
    if (sha && name && COMMIT_SHA.test(sha)) shas.set(name, sha);
  }
  const order = ref === "HEAD" ? ["HEAD"] : [`refs/tags/${ref}^{}`, `refs/tags/${ref}`, `refs/heads/${ref}`, ref];
  for (const name of order) {
    const sha = shas.get(name);
    if (sha) return sha;
  }
  return undefined;
}
