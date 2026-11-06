/**
 * Supply-chain checks on declared npm and PyPI dependencies: typosquats,
 * packages missing from the registry, brand-new packages, install scripts,
 * unpinned or git/URL sources, and deprecated, archived, or quarantined packages.
 * Registry lookups fail soft: without network the scan finishes and the
 * skipped packages are reported in the status.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Severity, Confidence } from "../types.js";
import type { RawFinding } from "./analyze.js";
import {
  type DeclaredDependency, type Ecosystem,
  isNpmManifest, isRequirementsFile, isPyproject, normalizePypiName,
  parsePackageJson, parseRequirementsTxt, parsePyproject,
} from "./manifests.js";
import { POPULAR_NPM, POPULAR_PYPI } from "./popular-packages.js";
import {
  RegistryClient, REGISTRY_CONCURRENCY, mapLimit,
  type RegistryFetch, type GitResolve, type SkipReason, type PackageFacts, type MissingFacts, type LookupResult,
} from "./registry.js";
import { versionedLine, parseGitSource, gitPinnedLine, successorName, type GitSource } from "./dep-fixes.js";

/** npm packages with more weekly downloads than this aren't treated as typosquats. */
export const POPULAR_WEEKLY_DOWNLOADS = 50_000;
export const NEW_PACKAGE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_LENGTH_FOR_DISTANCE_1 = 5;
const MIN_LENGTH_FOR_DISTANCE_2 = 8;
const MAX_TYPO_DISTANCE = 2;
const SECURITY_DEPRECATION = /secur|vulnerab|malicious|compromis|CVE-/i;

const CWE_SUPPLY_CHAIN = "CWE-1357";
const CWE_UNTRUSTED_INCLUDE = "CWE-829";
const CWE_UNMAINTAINED = "CWE-1104";
const CWE_EMBEDDED_MALWARE = "CWE-506";
const CWE_NO_INTEGRITY = "CWE-494";

/** Manifests Lens reads dependencies from but can't check against a registry yet. */
const UNSUPPORTED_MANIFEST = /(^|\/)(go\.mod|Cargo\.toml|Gemfile|composer\.json|pom\.xml|build\.gradle(\.kts)?)$/;

export const isDependencyManifest = (rel: string) =>
  isNpmManifest(rel) || isRequirementsFile(rel) || isPyproject(rel) || UNSUPPORTED_MANIFEST.test(rel);

export interface SupplyChainOptions {
  root: string;
  manifests: Array<{ path: string; src: string }>;
  /** Package names defined in this repo (workspaces); never looked up. */
  localPackages?: ReadonlySet<string>;
  offline?: boolean;
  fetch?: RegistryFetch;
  gitResolve?: GitResolve;
  now?: Date;
  timeoutMs?: number;
  deadlineMs?: number;
  onProgress?: (msg: string) => void;
}

export interface SupplyChainStatus {
  /** Distinct public registry packages declared. */
  packages: number;
  /** Packages whose registry checks ran on fresh or cached data. */
  checked: number;
  /** Packages whose registry checks didn't run, or ran on expired cache data. */
  skipped: number;
  skippedReason?: SkipReason;
  /** Manifests whose ecosystem has no registry checks. */
  unsupported: string[];
}

export interface SupplyChainResult {
  findings: RawFinding[];
  status: SupplyChainStatus;
}

export const isOfflineEnv = () => process.env.LENS_OFFLINE === "1" || process.env.LENS_OFFLINE === "true";

export async function checkSupplyChain(opts: SupplyChainOptions): Promise<SupplyChainResult> {
  const now = opts.now ?? new Date();
  const unsupported = opts.manifests.filter((m) => UNSUPPORTED_MANIFEST.test(m.path)).map((m) => m.path);
  const { deps, privateDeps } = await collectDependencies(opts);
  const local = new Set([...(opts.localPackages ?? [])].map((n) => n.toLowerCase()));
  const isLocal = (d: DeclaredDependency) => d.source.kind === "local" || local.has(d.registryName.toLowerCase());
  const external = deps.filter((d) => !isLocal(d));

  const lookups = new Map<string, PackageCheck>();
  const checkFor = new Map<DeclaredDependency, PackageCheck>();
  for (const d of external) {
    if (privateDeps.has(d) || d.source.kind !== "registry") continue;
    const name = registryKey(d.ecosystem, d.registryName);
    const version = d.ecosystem === "npm" ? baseVersion(d.source.spec) : undefined;
    const key = `${d.ecosystem}:${name}@${version ?? ""}`;
    if (!lookups.has(key)) lookups.set(key, { ecosystem: d.ecosystem, name, version, popular: isPopular(d.ecosystem, name) });
    checkFor.set(d, lookups.get(key)!);
  }
  const gitChecks: GitCheck[] = external
    .filter((d) => d.source.kind === "git" && !d.source.pinnedToCommit)
    .map((d) => ({ dep: d, git: parseGitSource(d) }));

  const client = new RegistryClient({
    root: opts.root, fetch: opts.fetch, gitResolve: opts.gitResolve, offline: opts.offline ?? isOfflineEnv(),
    now, timeoutMs: opts.timeoutMs, deadlineMs: opts.deadlineMs,
  });
  await client.loadCache();
  const checks = [...lookups.values()];
  await mapLimit(checks, REGISTRY_CONCURRENCY, (c) => runCheck(client, c));
  await mapLimit(gitChecks, REGISTRY_CONCURRENCY, (g) => runGitCheck(client, g));
  const cacheError = await client.saveCache();
  if (cacheError) opts.onProgress?.(`Registry cache not saved: ${cacheError}`);

  const findings: RawFinding[] = [];
  for (const d of external) {
    if (d.source.kind === "url") findings.push(urlFinding(d));
    if (d.source.kind !== "registry") continue;
    const check = checkFor.get(d);
    findings.push(...unpinnedFindings(d, check));
    if (check) findings.push(...registryFindings(d, check, now));
  }
  for (const g of gitChecks) findings.push(...gitFindings(g));

  const packageNames = new Set([...checks.map((c) => `${c.ecosystem}:${c.name}`), ...gitChecks.map((g) => `git:${g.dep.source.kind === "git" ? g.dep.source.spec : ""}`)]);
  const skippedNames = new Set([
    ...checks.filter((c) => c.skipped).map((c) => `${c.ecosystem}:${c.name}`),
    ...gitChecks.filter((g) => g.skipped).map((g) => `git:${g.dep.source.kind === "git" ? g.dep.source.spec : ""}`),
  ]);
  const reasons = [...checks.map((c) => c.skipped), ...gitChecks.map((g) => g.skipped)].filter((r): r is SkipReason => !!r);
  const status: SupplyChainStatus = {
    packages: packageNames.size,
    checked: packageNames.size - skippedNames.size,
    skipped: skippedNames.size,
    skippedReason: client.offline ?? reasons[0],
    unsupported,
  };
  if (status.packages) {
    const archiveUnchecked = [...checks, ...gitChecks].filter((c) => c.archiveUnchecked).length;
    opts.onProgress?.(`Supply chain: ${status.checked}/${status.packages} packages checked${status.skipped ? `, ${status.skipped} skipped (${status.skippedReason})` : ""}${
      archiveUnchecked ? `, ${archiveUnchecked} archive checks left for the next scan` : ""}`);
  }
  return { findings, status };
}

/** A package Lens suggests in a fix, with its current release. */
interface Replacement {
  name: string;
  latest: string;
}

interface PackageCheck {
  ecosystem: Ecosystem;
  name: string;
  version?: string;
  popular: boolean;
  facts?: PackageFacts | MissingFacts;
  weeklyDownloads?: number;
  typo?: TyposquatMatch;
  /** The package's GitHub repository is archived. */
  repoArchived?: boolean;
  /** GitHub didn't answer. Kept out of `skipped`: it says nothing about whether the package is real. */
  archiveUnchecked?: boolean;
  /** Typosquat target, or the successor a deprecation notice names, with its version. */
  replacement?: Replacement;
  /** Set when any part of this package's checks didn't get fresh registry data. */
  skipped?: SkipReason;
}

async function runCheck(client: RegistryClient, c: PackageCheck): Promise<void> {
  const res = await client.lookupPackage(c.ecosystem, c.name, { popular: c.popular, version: c.version });
  if (!noteResult(c, res)) return;
  const facts = res.facts;
  c.facts = facts;
  if (c.popular) return;
  c.typo = typosquatTarget(c.name, c.ecosystem);
  const needsDownloads = c.ecosystem === "npm" && facts.kind === "package" && (c.typo || facts.installScripts?.length);
  if (needsDownloads) {
    const dl = await client.lookupWeeklyDownloads(c.name);
    if (noteResult(c, dl)) c.weeklyDownloads = dl.facts;
  }
  const target = replacementName(c);
  if (target) c.replacement = await lookupReplacement(client, c, c.ecosystem, target);
  if (facts.kind === "package" && facts.repository && !facts.deprecated) {
    const archived = await client.lookupGithubArchived(facts.repository);
    if (archived.ok) c.repoArchived = archived.facts;
    else c.archiveUnchecked = true;
  }
}

/** Which package a fix for `c` should switch to, before checking that it exists. */
function replacementName(c: PackageCheck): string | undefined {
  const facts = c.facts;
  if (!facts) return undefined;
  if (facts.kind === "missing") return typosquatTarget(c.name, c.ecosystem)?.target;
  if (isTyposquat(c)) return c.typo!.target;
  const notice = facts.deprecated ?? (facts.status === "deprecated" || facts.status === "archived" ? facts.statusReason : undefined);
  return notice ? successorName(notice, c.name) : undefined;
}

/** `name`'s current release, when it exists and isn't itself deprecated. */
async function lookupReplacement(client: RegistryClient, owner: { skipped?: SkipReason }, ecosystem: Ecosystem, name: string): Promise<Replacement | undefined> {
  const res = await client.lookupPackage(ecosystem, registryKey(ecosystem, name), { popular: true });
  if (!noteResult(owner, res)) return undefined;
  const facts = res.facts;
  if (facts.kind !== "package" || !facts.latest || facts.deprecated || facts.status) return undefined;
  return { name, latest: facts.latest };
}

interface GitCheck {
  dep: DeclaredDependency;
  /** Undefined when the spec can't be resolved (gists, semver ranges, short SHAs, non-git VCS). */
  git?: GitSource;
  /** Commit the ref points at now; undefined when the repo couldn't be read. */
  sha?: string;
  /** Registry release built from the same repository (npm only). */
  registryRelease?: Replacement;
  archived?: boolean;
  archiveUnchecked?: boolean;
  skipped?: SkipReason;
}

async function runGitCheck(client: RegistryClient, g: GitCheck): Promise<void> {
  if (!g.git) return;
  const d = g.dep;
  // Only an npm package published from this same GitHub repo is a safe swap; a name match alone could be someone else's package.
  if (d.ecosystem === "npm" && g.git.github) {
    const res = await client.lookupPackage("npm", registryKey("npm", d.registryName), { popular: true });
    if (noteResult(g, res) && res.facts.kind === "package" && res.facts.latest && !res.facts.deprecated
      && res.facts.repository?.toLowerCase() === g.git.github.toLowerCase()) {
      g.registryRelease = { name: d.registryName, latest: res.facts.latest };
    }
  }
  if (g.git.github) {
    const archived = await client.lookupGithubArchived(g.git.github);
    if (archived.ok) g.archived = archived.facts;
    else g.archiveUnchecked = true;
  }
  if (g.registryRelease) return;
  const commit = await client.resolveCommit(g.git.cloneUrl, g.git.ref);
  if (noteResult(g, commit)) g.sha = commit.facts;
}

function noteResult<T>(c: { skipped?: SkipReason }, res: LookupResult<T>): res is { ok: true; facts: T } {
  if (!res.ok) {
    c.skipped ??= res.reason;
    return false;
  }
  if (res.stale) c.skipped ??= res.stale;
  return true;
}

interface Collected {
  deps: DeclaredDependency[];
  /** Dependencies resolved from a private registry or index. */
  privateDeps: Set<DeclaredDependency>;
}

async function collectDependencies(opts: SupplyChainOptions): Promise<Collected> {
  const deps: DeclaredDependency[] = [];
  const privateDeps = new Set<DeclaredDependency>();
  const npmrcCache = new Map<string, Promise<NpmRegistryConfig>>();
  for (const m of opts.manifests) {
    if (isNpmManifest(m.path)) {
      const dir = path.posix.dirname(m.path);
      const configs = await Promise.all([".", dir].map((d) => {
        if (!npmrcCache.has(d)) npmrcCache.set(d, readNpmrc(path.join(opts.root, d, ".npmrc"), opts.onProgress));
        return npmrcCache.get(d)!;
      }));
      for (const d of parsePackageJson(m.path, m.src)) {
        deps.push(d);
        if (configs.some((cfg) => isPrivateNpm(cfg, d.registryName))) privateDeps.add(d);
      }
    } else if (isRequirementsFile(m.path)) {
      const parsed = parseRequirementsTxt(m.path, m.src);
      for (const d of parsed.deps) {
        deps.push(d);
        if (parsed.customIndex) privateDeps.add(d);
      }
    } else if (isPyproject(m.path)) {
      deps.push(...parsePyproject(m.path, m.src));
    }
  }
  return { deps, privateDeps };
}

interface NpmRegistryConfig {
  defaultIsPrivate: boolean;
  privateScopes: Set<string>;
}

const PUBLIC_NPM = /^https?:\/\/registry\.(npmjs\.org|yarnpkg\.com)\/?$/;

async function readNpmrc(file: string, onProgress?: (msg: string) => void): Promise<NpmRegistryConfig> {
  const cfg: NpmRegistryConfig = { defaultIsPrivate: false, privateScopes: new Set() };
  let src: string;
  try {
    src = await fs.readFile(file, "utf8");
  } catch (err) {
    // No .npmrc means the public registry. An unreadable one is reported and treated the same way.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") onProgress?.(`Couldn't read ${file}: ${(err as Error).message}`);
    return cfg;
  }
  for (const line of src.split("\n")) {
    const m = /^\s*(@[\w.-]+:)?registry\s*=\s*(\S+)/.exec(line);
    if (!m || PUBLIC_NPM.test(m[2]!)) continue;
    if (m[1]) cfg.privateScopes.add(m[1].slice(0, -1).toLowerCase());
    else cfg.defaultIsPrivate = true;
  }
  return cfg;
}

function isPrivateNpm(cfg: NpmRegistryConfig, name: string): boolean {
  if (cfg.defaultIsPrivate) return true;
  const scope = name.startsWith("@") ? name.split("/")[0]!.toLowerCase() : undefined;
  return !!scope && cfg.privateScopes.has(scope);
}

const registryKey = (eco: Ecosystem, name: string) => (eco === "PyPI" ? normalizePypiName(name) : name.toLowerCase());

const POPULAR_PYPI_NORMALIZED = new Set([...POPULAR_PYPI].map(normalizePypiName));
const popularList = (eco: Ecosystem) => (eco === "npm" ? POPULAR_NPM : POPULAR_PYPI_NORMALIZED);
const isPopular = (eco: Ecosystem, normalizedName: string) => popularList(eco).has(normalizedName);

/** First `x.y.z` in an npm range, used to read that version's scripts and deprecation. */
function baseVersion(spec: string): string | undefined {
  return /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(spec)?.[1];
}

export interface TyposquatMatch {
  target: string;
  distance: number;
}

/** The popular package `name` is probably a misspelling of, if any. Expects a normalized name. */
export function typosquatTarget(name: string, ecosystem: Ecosystem): TyposquatMatch | undefined {
  const popular = popularList(ecosystem);
  if (popular.has(name)) return undefined;
  const bare = stripSeparators(name);
  let best: TyposquatMatch | undefined;
  for (const target of popular) {
    if (Math.abs(target.length - name.length) > MAX_TYPO_DISTANCE) continue;
    const distance = bare === stripSeparators(target) ? 1 : osaDistance(name, target, MAX_TYPO_DISTANCE);
    if (distance > MAX_TYPO_DISTANCE) continue;
    const minLength = distance === 1 ? MIN_LENGTH_FOR_DISTANCE_1 : MIN_LENGTH_FOR_DISTANCE_2;
    if (name.length < minLength) continue;
    if (!best || distance < best.distance) best = { target, distance };
  }
  return best;
}

const stripSeparators = (s: string) => s.replace(/[-_.@/]/g, "");

/** Optimal string alignment distance (edits plus adjacent swaps), capped at `max + 1`. */
export function osaDistance(a: string, b: string, max = Infinity): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const rows: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array<number>(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) rows[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    let rowMin = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(rows[i - 1]![j]! + 1, rows[i]![j - 1]! + 1, rows[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, rows[i - 2]![j - 2]! + 1);
      rows[i]![j] = v;
      rowMin = Math.min(rowMin, v);
    }
    if (rowMin > max) return max + 1;
  }
  return Math.min(rows[a.length]![b.length]!, max + 1);
}

type PinState = "pinned" | "floating" | "open";

export function npmPinState(spec: string): PinState {
  const s = spec.trim();
  if (s === "" || s === "*" || /^x$/i.test(s)) return "floating";
  // A word that isn't a version is a dist-tag such as `latest` or `next`.
  if (/^[a-z][\w-]*$/i.test(s)) return "floating";
  const alternatives = s.split("||").map((a) => a.trim());
  if (alternatives.some((a) => a === "" || a === "*" || /^x$/i.test(a))) return "floating";
  if (alternatives.some((a) => />/.test(a) && !/</.test(a))) return "open";
  return "pinned";
}

export function pypiPinState(spec: string): PinState {
  const s = spec.trim();
  if (s === "" || s === "*") return "floating";
  // PEP 440 operators with an upper bound, or Poetry's caret, tilde, and bare versions.
  if (/==|~=|<|\^|~|^\d/.test(s)) return "pinned";
  return "open";
}

/** True when the spec names exactly one version. */
function isExactPin(eco: Ecosystem, spec: string): boolean {
  const s = spec.trim();
  if (eco === "npm") return /^=?v?\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.test(s);
  return /^===?\s*[\w.!+-]+$/.test(s) || /^\d[\w.!+-]*$/.test(s);
}

const registryLabel = (eco: Ecosystem) => (eco === "npm" ? "npm" : "PyPI");

function finding(d: DeclaredDependency, f: { rule: string; title: string; severity: Severity; cwe: string; message: string; confidence?: Confidence }): RawFinding {
  return {
    rule: f.rule,
    title: f.title,
    category: "supply-chain",
    cwe: f.cwe,
    severity: f.severity,
    confidence: f.confidence ?? "high",
    path: d.manifest,
    line: d.line,
    message: f.message,
    snippet: d.snippet,
  };
}

const quote = (text: string) => `\`${text}\``;
const changeTo = (d: DeclaredDependency, line: string) => `In ${d.manifest}, change ${quote(d.snippet)} to ${quote(line)}.`;
const swapTo = (d: DeclaredDependency, r: Replacement) =>
  `In ${d.manifest}, change ${quote(d.snippet)} to ${quote(versionedLine(d, r.latest, "range", r.name))}, then change every import of ${d.registryName} to ${r.name}.`;
const removeIt = (d: DeclaredDependency) =>
  `Remove ${quote(d.snippet)} from ${d.manifest} and rewrite the code that imports ${d.registryName} with built-in APIs or a package ${d.manifest} already lists.`;

function latestOf(c: PackageCheck | undefined): string | undefined {
  return c?.facts?.kind === "package" ? c.facts.latest : undefined;
}

/** Registry release a tarball URL points at, e.g. `registry.npmjs.org/x/-/x-1.2.3.tgz` or a files.pythonhosted.org sdist/wheel. */
export function registryTarballVersion(d: DeclaredDependency, url: string): string | undefined {
  const file = /^https?:\/\/(?:registry\.npmjs\.org|registry\.yarnpkg\.com|files\.pythonhosted\.org)\/.*\/([^/]+)$/.exec(url)?.[1];
  if (!file) return undefined;
  const base = d.registryName.replace(/^@[^/]+\//, "");
  const name = d.ecosystem === "PyPI" ? base.replace(/[-_.]+/g, "[-_.]") : base.replace(/[.]/g, "\\.");
  const m = new RegExp(`^${name}-(\\d[\\w.+!-]*?)(?:\\.tgz|\\.tar\\.gz|\\.zip|-[\\w.]+-[\\w.]+-[\\w.]+\\.whl)$`, "i").exec(file);
  return m?.[1];
}

/** A dependency that installs from a URL instead of a registry. */
function urlFinding(d: DeclaredDependency): RawFinding {
  const src = d.source;
  const insecure = src.kind === "url" && src.insecure;
  const spec = src.kind === "url" ? src.spec : "";
  const version = registryTarballVersion(d, spec);
  const fix = version
    ? `It's a ${registryLabel(d.ecosystem)} release. ${changeTo(d, versionedLine(d, version, "exact"))}`
    : insecure
      ? changeTo(d, d.snippet.replace(spec, spec.replace(/^http:/, "https:")))
      : `It isn't a ${registryLabel(d.ecosystem)} release, so Lens has no version to pin; publish it to a registry or commit the file into this repo and depend on it by path.`;
  return finding(d, {
    rule: "dep-git-source", severity: insecure ? "high" : "medium", cwe: CWE_NO_INTEGRITY,
    title: `${d.name} installs from a URL`,
    message: insecure
      ? `${d.name} downloads from ${spec} over plain HTTP, so anyone on the network path can swap the code. ${fix}`
      : `${d.name} installs from ${spec} instead of ${registryLabel(d.ecosystem)}, so its contents can change with no version bump. ${fix}`,
  });
}

/** Git dependencies not pinned to a commit, with the commit or registry release to pin to. */
function gitFindings(g: GitCheck): RawFinding[] {
  const d = g.dep;
  const spec = d.source.kind === "git" ? d.source.spec : "";
  const out: RawFinding[] = [];
  const fix = g.registryRelease
    ? changeTo(d, versionedLine(d, g.registryRelease.latest, "range"))
    : g.sha
      ? `Pin it to the commit ${g.git?.ref === "HEAD" ? "it installs now" : `${g.git?.ref} points to now`}. ${changeTo(d, gitPinnedLine(d, g.sha))}`
      : g.git && !g.skipped
        ? `Lens couldn't read ${g.git.cloneUrl} (private or deleted). Pin it to a full 40-character commit SHA from that repository.`
        : `Pin it to a full 40-character commit SHA in ${d.manifest}.`;
  out.push(finding(d, {
    rule: "dep-git-source", severity: "medium", cwe: CWE_NO_INTEGRITY,
    title: `${d.name} installs from a git repository`,
    message: `${d.name} installs from git (${spec}) instead of ${registryLabel(d.ecosystem)}, so its code can change with no version bump and skips registry malware scanning. ${fix}`,
  }));
  if (g.archived) {
    out.push(finding(d, {
      rule: "dep-deprecated", severity: "low", cwe: CWE_UNMAINTAINED,
      title: `${d.name}'s repository is archived`,
      message: `${d.name} installs from ${g.git?.github}, which is archived on GitHub and gets no more fixes, including security fixes. ${removeIt(d)}`,
    }));
  }
  return out;
}

/** Registry dependencies with no version, or no upper bound. */
function unpinnedFindings(d: DeclaredDependency, c: PackageCheck | undefined): RawFinding[] {
  if (d.source.kind !== "registry" || c?.facts?.kind === "missing") return [];
  const spec = d.source.spec;
  const state = d.ecosystem === "npm" ? npmPinState(spec) : pypiPinState(spec);
  if (state === "pinned") return [];
  const declared = spec.trim() || "no version";
  const latest = latestOf(c);
  const fix = latest
    ? changeTo(d, versionedLine(d, latest, "range"))
    : `Pin it to the version your lockfile installs, as ${d.ecosystem === "npm" ? "a caret range like ^X.Y.Z" : "a compatible release like ~=X.Y"}, in ${d.manifest}.`;
  return [finding(d, {
    rule: "dep-unpinned", severity: state === "floating" ? "medium" : "low", cwe: CWE_SUPPLY_CHAIN,
    title: `${d.name} version isn't pinned`,
    message: state === "floating"
      ? `${d.name} is declared with ${declared === "no version" ? "no version" : `"${declared}"`}, so any future release, including a hijacked one, installs without review. ${fix}`
      : `${d.name} is declared as "${declared}" with no upper bound, so new major releases install without review. ${fix}`,
  })];
}

const isTyposquat = (c: PackageCheck) =>
  !!c.typo && (c.ecosystem === "PyPI" || (c.weeklyDownloads !== undefined && c.weeklyDownloads < POPULAR_WEEKLY_DOWNLOADS));

/** Exact version to pin after review: the newest release the declared range allows, as far as Lens can tell. */
function reviewedVersion(c: PackageCheck, latest: string | undefined): string | undefined {
  const major = (v: string) => v.split(".")[0];
  if (latest && (!c.version || major(latest) === major(c.version))) return latest;
  return c.version ?? latest;
}

function registryFindings(d: DeclaredDependency, c: PackageCheck, now: Date): RawFinding[] {
  const facts = c.facts;
  if (!facts) return [];
  const label = registryLabel(d.ecosystem);
  const spec = d.source.kind === "registry" ? d.source.spec : "";
  const out: RawFinding[] = [];

  if (facts.kind === "missing") {
    out.push(finding(d, {
      rule: "dep-not-on-registry", severity: "high", cwe: CWE_SUPPLY_CHAIN,
      title: `${d.registryName} isn't on ${label}`,
      message: `${d.registryName} doesn't exist on ${label}${facts.unpublished ? " (it was unpublished)" : ""}. AI tools often invent package names like this, and anyone can register the name later and ship malware to you. ${
        c.replacement ? swapTo(d, c.replacement) : removeIt(d)
      }`,
    }));
    return out;
  }

  if (facts.status === "quarantined") {
    out.push(finding(d, {
      rule: "dep-quarantined", severity: "critical", cwe: CWE_EMBEDDED_MALWARE,
      title: `${d.registryName} is quarantined on PyPI`,
      message: `PyPI quarantined ${d.registryName}, which it does when a project is reported as malware. ${removeIt(d)} Check any machine that installed it.`,
    }));
    return out;
  }

  if (isTyposquat(c)) {
    const typo = c.typo!;
    out.push(finding(d, {
      rule: "dep-typosquat", severity: typo.distance === 1 ? "high" : "medium", cwe: CWE_SUPPLY_CHAIN, confidence: "medium",
      title: `${d.registryName} looks like a typosquat of ${typo.target}`,
      message: `${d.registryName} is ${typo.distance} edit${typo.distance === 1 ? "" : "s"} from the popular package ${typo.target} and isn't widely used itself. ${
        c.replacement ? swapTo(d, c.replacement) : `In ${d.manifest}, replace ${d.registryName} with ${typo.target}, and change every import to match.`
      }`,
    }));
  }

  const exact = isExactPin(d.ecosystem, spec);
  const pinTo = reviewedVersion(c, facts.latest);
  const pinFix = pinTo ? changeTo(d, versionedLine(d, pinTo, "exact")) : `Pin the exact version you reviewed in ${d.manifest}.`;
  const created = facts.createdAt ? Date.parse(facts.createdAt) : NaN;
  if (!c.popular && !exact && Number.isFinite(created) && now.getTime() - created < NEW_PACKAGE_DAYS * DAY_MS) {
    out.push(finding(d, {
      rule: "dep-new-package", severity: "medium", cwe: CWE_SUPPLY_CHAIN,
      title: `${d.registryName} was published in the last ${NEW_PACKAGE_DAYS} days`,
      message: `${d.registryName} was first published on ${new Date(created).toISOString().slice(0, 10)}. Brand-new packages are a common way to ship malware, and an exact pin stops a later malicious release from installing. ${pinFix}`,
    }));
  }

  const scripts = facts.installScripts ?? [];
  const trustedByDownloads = c.weeklyDownloads !== undefined && c.weeklyDownloads >= POPULAR_WEEKLY_DOWNLOADS;
  if (scripts.length && !c.popular && !trustedByDownloads && !exact) {
    out.push(finding(d, {
      rule: "dep-install-script", severity: "medium", cwe: CWE_UNTRUSTED_INCLUDE,
      title: `${d.registryName} runs an install script`,
      message: `${d.registryName} runs a ${scripts.join("/")} script on install with your user's permissions, and isn't a widely used package. An exact pin keeps a new release from changing that script without review. ${pinFix}`,
    }));
  }

  const deprecation = facts.deprecated ?? (facts.status === "deprecated" ? facts.statusReason ?? "deprecated" : undefined);
  const replaceFix = c.replacement ? swapTo(d, c.replacement) : removeIt(d);
  if (deprecation) {
    out.push(finding(d, {
      rule: "dep-deprecated", severity: SECURITY_DEPRECATION.test(deprecation) ? "medium" : "low", cwe: CWE_UNMAINTAINED,
      title: `${d.registryName} is deprecated`,
      message: `${d.registryName} is deprecated on ${label}: "${deprecation}". ${replaceFix}`,
    }));
  } else if (facts.status === "archived") {
    out.push(finding(d, {
      rule: "dep-deprecated", severity: "low", cwe: CWE_UNMAINTAINED,
      title: `${d.registryName} is archived`,
      message: `${d.registryName} is archived on PyPI and gets no more fixes, including security fixes. ${replaceFix}`,
    }));
  } else if (c.repoArchived) {
    out.push(finding(d, {
      rule: "dep-deprecated", severity: "low", cwe: CWE_UNMAINTAINED,
      title: `${d.registryName}'s repository is archived`,
      message: `${d.registryName}'s source repository (${facts.repository}) is archived on GitHub, so it gets no more fixes, including security fixes. ${replaceFix}`,
    }));
  } else if (facts.versionDeprecated && c.version) {
    out.push(finding(d, {
      rule: "dep-deprecated", severity: SECURITY_DEPRECATION.test(facts.versionDeprecated) ? "medium" : "low", cwe: CWE_UNMAINTAINED,
      title: `${d.registryName}@${c.version} is deprecated`,
      message: `${d.registryName}@${c.version} is deprecated on npm: "${facts.versionDeprecated}". ${
        facts.latest ? changeTo(d, versionedLine(d, facts.latest, "range")) : `Raise the range in ${d.manifest} to the latest release.`
      }`,
    }));
  }
  return out;
}
