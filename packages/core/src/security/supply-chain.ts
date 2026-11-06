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
  type RegistryFetch, type SkipReason, type PackageFacts, type MissingFacts, type LookupResult,
} from "./registry.js";

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

  const findings: RawFinding[] = [];
  for (const d of deps) if (!isLocal(d)) findings.push(...sourceFindings(d));

  const lookups = new Map<string, PackageCheck>();
  for (const d of deps) {
    if (isLocal(d) || privateDeps.has(d) || d.source.kind !== "registry") continue;
    const name = registryKey(d.ecosystem, d.registryName);
    const version = d.ecosystem === "npm" ? baseVersion(d.source.spec) : undefined;
    const key = `${d.ecosystem}:${name}@${version ?? ""}`;
    if (!lookups.has(key)) lookups.set(key, { ecosystem: d.ecosystem, name, version, popular: isPopular(d.ecosystem, name) });
  }

  const client = new RegistryClient({ root: opts.root, fetch: opts.fetch, offline: opts.offline ?? isOfflineEnv(), now, timeoutMs: opts.timeoutMs, deadlineMs: opts.deadlineMs });
  await client.loadCache();
  const checks = [...lookups.values()];
  await mapLimit(checks, REGISTRY_CONCURRENCY, (c) => runCheck(client, c));
  const cacheError = await client.saveCache();
  if (cacheError) opts.onProgress?.(`Registry cache not saved: ${cacheError}`);

  for (const d of deps) {
    if (d.source.kind !== "registry" || isLocal(d) || privateDeps.has(d)) continue;
    const name = registryKey(d.ecosystem, d.registryName);
    const check = lookups.get(`${d.ecosystem}:${name}@${(d.ecosystem === "npm" ? baseVersion(d.source.spec) : undefined) ?? ""}`);
    if (check) findings.push(...registryFindings(d, check, now));
  }

  const packageNames = new Set(checks.map((c) => `${c.ecosystem}:${c.name}`));
  const skippedNames = new Set(checks.filter((c) => c.skipped).map((c) => `${c.ecosystem}:${c.name}`));
  const reasons = checks.map((c) => c.skipped).filter((r): r is SkipReason => !!r);
  const status: SupplyChainStatus = {
    packages: packageNames.size,
    checked: packageNames.size - skippedNames.size,
    skipped: skippedNames.size,
    skippedReason: client.offline ?? reasons[0],
    unsupported,
  };
  if (status.packages) {
    opts.onProgress?.(`Supply chain: ${status.checked}/${status.packages} packages checked${status.skipped ? `, ${status.skipped} skipped (${status.skippedReason})` : ""}`);
  }
  return { findings, status };
}

interface PackageCheck {
  ecosystem: Ecosystem;
  name: string;
  version?: string;
  popular: boolean;
  facts?: PackageFacts | MissingFacts;
  weeklyDownloads?: number;
  typo?: TyposquatMatch;
  /** Set when any part of this package's checks didn't get fresh registry data. */
  skipped?: SkipReason;
}

async function runCheck(client: RegistryClient, c: PackageCheck): Promise<void> {
  const res = await client.lookupPackage(c.ecosystem, c.name, { popular: c.popular, version: c.version });
  if (!noteResult(c, res)) return;
  c.facts = res.facts;
  if (c.popular) return;
  c.typo = typosquatTarget(c.name, c.ecosystem);
  const needsDownloads = c.ecosystem === "npm" && c.facts.kind === "package" && (c.typo || c.facts.installScripts?.length);
  if (!needsDownloads) return;
  const dl = await client.lookupWeeklyDownloads(c.name);
  if (noteResult(c, dl)) c.weeklyDownloads = dl.facts;
}

function noteResult<T>(c: PackageCheck, res: LookupResult<T>): res is { ok: true; facts: T } {
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

/** Findings that need only the manifest: git/URL sources and unpinned versions. */
function sourceFindings(d: DeclaredDependency): RawFinding[] {
  const src = d.source;
  if (src.kind === "git" && !src.pinnedToCommit) {
    return [finding(d, {
      rule: "dep-git-source", severity: "medium", cwe: CWE_NO_INTEGRITY,
      title: `${d.name} installs from a git repository`,
      message: `${d.name} installs from git (${src.spec}) instead of ${registryLabel(d.ecosystem)}, so its code can change with no version bump and skips registry malware scanning. Replace it with the registry release in ${d.manifest}, or pin it to a full 40-character commit SHA.`,
    })];
  }
  if (src.kind === "url") {
    return [finding(d, {
      rule: "dep-git-source", severity: src.insecure ? "high" : "medium", cwe: CWE_NO_INTEGRITY,
      title: `${d.name} installs from a URL`,
      message: `${d.name} installs from ${src.spec} instead of ${registryLabel(d.ecosystem)}${src.insecure ? " over plain HTTP, so anyone on the network path can swap the code" : ", so its contents can change with no version bump"}. Replace it with the registry release in ${d.manifest}.`,
    })];
  }
  if (src.kind !== "registry") return [];
  const state = d.ecosystem === "npm" ? npmPinState(src.spec) : pypiPinState(src.spec);
  if (state === "pinned") return [];
  const declared = src.spec.trim() || "no version";
  const fix = d.ecosystem === "npm"
    ? `Replace it with a caret range of the release you've tested, like "^1.4.2", in ${d.manifest}.`
    : `Add a bounded specifier, like ${d.name}~=1.4 or ${d.name}==1.4.2, in ${d.manifest}.`;
  return [finding(d, {
    rule: "dep-unpinned", severity: state === "floating" ? "medium" : "low", cwe: CWE_SUPPLY_CHAIN,
    title: `${d.name} version isn't pinned`,
    message: state === "floating"
      ? `${d.name} is declared with ${declared === "no version" ? "no version" : `"${declared}"`}, so any future release, including a hijacked one, installs without review. ${fix}`
      : `${d.name} is declared as "${declared}" with no upper bound, so new major releases install without review. ${fix}`,
  })];
}

function registryFindings(d: DeclaredDependency, c: PackageCheck, now: Date): RawFinding[] {
  const facts = c.facts;
  if (!facts) return [];
  const label = registryLabel(d.ecosystem);
  const spec = d.source.kind === "registry" ? d.source.spec : "";
  const out: RawFinding[] = [];

  if (facts.kind === "missing") {
    const suggestion = typosquatTarget(c.name, d.ecosystem);
    out.push(finding(d, {
      rule: "dep-not-on-registry", severity: "high", cwe: CWE_SUPPLY_CHAIN,
      title: `${d.registryName} isn't on ${label}`,
      message: `${d.registryName} doesn't exist on ${label}${facts.unpublished ? " (it was unpublished)" : ""}. AI tools often invent package names like this, and anyone can register the name later and ship malware to you. ${
        suggestion ? `Replace it with ${suggestion.target} in ${d.manifest} and in every import.` : `Remove it from ${d.manifest}, or replace it with the package you meant, and update every import.`
      }`,
    }));
    return out;
  }
  if (facts.kind !== "package") return out;

  if (facts.status === "quarantined") {
    out.push(finding(d, {
      rule: "dep-quarantined", severity: "critical", cwe: CWE_EMBEDDED_MALWARE,
      title: `${d.registryName} is quarantined on PyPI`,
      message: `PyPI quarantined ${d.registryName}, which it does when a project is reported as malware. Remove it from ${d.manifest} and every import, and check any machine that installed it.`,
    }));
    return out;
  }

  if (c.typo && (d.ecosystem === "PyPI" || (c.weeklyDownloads !== undefined && c.weeklyDownloads < POPULAR_WEEKLY_DOWNLOADS))) {
    out.push(finding(d, {
      rule: "dep-typosquat", severity: c.typo.distance === 1 ? "high" : "medium", cwe: CWE_SUPPLY_CHAIN, confidence: "medium",
      title: `${d.registryName} looks like a typosquat of ${c.typo.target}`,
      message: `${d.registryName} is ${c.typo.distance} edit${c.typo.distance === 1 ? "" : "s"} from the popular package ${c.typo.target} and isn't widely used itself. Replace it with ${c.typo.target} in ${d.manifest} and in every import.`,
    }));
  }

  const exact = isExactPin(d.ecosystem, spec);
  const created = facts.createdAt ? Date.parse(facts.createdAt) : NaN;
  if (!c.popular && !exact && Number.isFinite(created) && now.getTime() - created < NEW_PACKAGE_DAYS * DAY_MS) {
    out.push(finding(d, {
      rule: "dep-new-package", severity: "medium", cwe: CWE_SUPPLY_CHAIN,
      title: `${d.registryName} was published in the last ${NEW_PACKAGE_DAYS} days`,
      message: `${d.registryName} was first published on ${new Date(created).toISOString().slice(0, 10)}. Brand-new packages are a common way to ship malware. Review its source, then pin the exact version you reviewed in ${d.manifest}${d.ecosystem === "npm" ? ` ("${d.name}": "1.2.3", no ^ or ~)` : ` (${d.name}==1.2.3)`}, or replace it with an established package.`,
    }));
  }

  const scripts = facts.installScripts ?? [];
  const trustedByDownloads = c.weeklyDownloads !== undefined && c.weeklyDownloads >= POPULAR_WEEKLY_DOWNLOADS;
  if (scripts.length && !c.popular && !trustedByDownloads && !exact) {
    out.push(finding(d, {
      rule: "dep-install-script", severity: "medium", cwe: CWE_UNTRUSTED_INCLUDE,
      title: `${d.registryName} runs an install script`,
      message: `${d.registryName} runs a ${scripts.join("/")} script on install with your user's permissions, and isn't a widely used package. Review the script, then pin the exact version you reviewed in ${d.manifest} ("${d.name}": "1.2.3", no ^ or ~), or replace it with a package that doesn't need one.`,
    }));
  }

  const deprecation = facts.deprecated ?? (facts.status === "deprecated" ? facts.statusReason ?? "deprecated" : undefined);
  if (deprecation) {
    out.push(finding(d, {
      rule: "dep-deprecated", severity: SECURITY_DEPRECATION.test(deprecation) ? "medium" : "low", cwe: CWE_UNMAINTAINED,
      title: `${d.registryName} is deprecated`,
      message: `${d.registryName} is deprecated on ${label}: "${deprecation}". Replace it with the successor the notice names, or a maintained alternative, in ${d.manifest} and every import.`,
    }));
  } else if (facts.status === "archived") {
    out.push(finding(d, {
      rule: "dep-deprecated", severity: "low", cwe: CWE_UNMAINTAINED,
      title: `${d.registryName} is archived`,
      message: `${d.registryName} is archived on PyPI and gets no more fixes, including security fixes. Replace it with a maintained alternative in ${d.manifest} and every import.`,
    }));
  } else if (facts.versionDeprecated && c.version) {
    out.push(finding(d, {
      rule: "dep-deprecated", severity: SECURITY_DEPRECATION.test(facts.versionDeprecated) ? "medium" : "low", cwe: CWE_UNMAINTAINED,
      title: `${d.registryName}@${c.version} is deprecated`,
      message: `${d.registryName}@${c.version} is deprecated on npm: "${facts.versionDeprecated}". Raise the range in ${d.manifest} to the latest release that isn't deprecated.`,
    }));
  }
  return out;
}
