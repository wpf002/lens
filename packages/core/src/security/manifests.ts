/** Declared dependencies with their raw specs and manifest lines, for supply-chain checks. */
import path from "node:path";

export type Ecosystem = "npm" | "PyPI";

/** Where a dependency is installed from. */
export type DependencySource =
  | { kind: "registry"; spec: string }
  | { kind: "git"; spec: string; pinnedToCommit: boolean }
  | { kind: "url"; spec: string; insecure: boolean }
  | { kind: "local" };

export interface DeclaredDependency {
  ecosystem: Ecosystem;
  /** Name as written in the manifest. */
  name: string;
  /** Name on the registry (differs from `name` for npm aliases). */
  registryName: string;
  source: DependencySource;
  /** Repo-relative manifest path. */
  manifest: string;
  line: number;
  /** Stable text for the row, one per dependency. */
  snippet: string;
}

const NPM_SECTIONS = ["dependencies", "devDependencies", "optionalDependencies"] as const;
const COMMIT_SHA = /#[0-9a-f]{40}$/i;
const SNIPPET_MAX = 200;

export const isNpmManifest = (rel: string) => path.posix.basename(rel) === "package.json";
export const isRequirementsFile = (rel: string) => /^requirements([.-][\w.-]*)?\.txt$/.test(path.posix.basename(rel));
export const isPyproject = (rel: string) => path.posix.basename(rel) === "pyproject.toml";
export const isSupplyChainManifest = (rel: string) => isNpmManifest(rel) || isRequirementsFile(rel) || isPyproject(rel);

/** PEP 503 name normalization: PyPI treats `Foo_Bar` and `foo-bar` as one project. */
export const normalizePypiName = (name: string) => name.toLowerCase().replace(/[-_.]+/g, "-");

export function classifyNpmSpec(spec: string): { source: DependencySource; registryName?: string } {
  const s = spec.trim();
  if (/^(workspace|file|link|portal):/.test(s)) return { source: { kind: "local" } };
  const alias = /^npm:((?:@[^/@]+\/)?[^@]+)(?:@(.*))?$/.exec(s);
  if (alias) return { source: { kind: "registry", spec: alias[2] ?? "*" }, registryName: alias[1] };
  if (/^(git\+|git:|github:|gitlab:|bitbucket:|gist:)/.test(s) || /^[\w.-]+\/[\w.-]+(#.*)?$/.test(s)) {
    return { source: { kind: "git", spec: s, pinnedToCommit: COMMIT_SHA.test(s) } };
  }
  if (/^https?:\/\//.test(s)) return { source: { kind: "url", spec: s, insecure: s.startsWith("http://") } };
  return { source: { kind: "registry", spec: s } };
}

const clip = (s: string) => s.slice(0, SNIPPET_MAX);

export function parsePackageJson(manifest: string, src: string): DeclaredDependency[] {
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(src) as Record<string, unknown>;
  } catch {
    // Invalid JSON is the parser's report to make, not a supply-chain finding.
    return [];
  }
  const lines = src.split("\n");
  const out: DeclaredDependency[] = [];
  for (const section of NPM_SECTIONS) {
    const deps = pkg[section];
    if (!deps || typeof deps !== "object") continue;
    const sectionLine = lines.findIndex((l) => l.includes(`"${section}"`));
    for (const [name, spec] of Object.entries(deps as Record<string, unknown>)) {
      if (typeof spec !== "string") continue;
      const { source, registryName } = classifyNpmSpec(spec);
      const keyLine = lines.findIndex((l, i) => i >= Math.max(0, sectionLine) && l.includes(`"${name}"`));
      out.push({
        ecosystem: "npm", name, registryName: registryName ?? name, source, manifest,
        line: keyLine >= 0 ? keyLine + 1 : 1,
        snippet: clip(`"${name}": "${spec}"`),
      });
    }
  }
  return out;
}

const VCS_PREFIX = /^(git|hg|svn|bzr)\+/;

/** One PEP 508 requirement (`name[extra]>=1 ; marker`, `name @ url`, or a bare VCS/URL line). */
export function parseRequirement(text: string): { name: string; source: DependencySource } | undefined {
  const req = text.split(/\s+#/)[0]!.trim();
  if (!req) return undefined;
  if (VCS_PREFIX.test(req) || /^https?:\/\//.test(req)) {
    const egg = /[#&]egg=([A-Za-z0-9][\w.-]*)/.exec(req)?.[1] ?? /\/([A-Za-z0-9][\w.]*?)-\d[^/]*\.(whl|tar\.gz|zip)$/.exec(req)?.[1];
    return egg ? { name: egg, source: urlSource(req) } : undefined;
  }
  const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*(.*)$/.exec(req);
  if (!m) return undefined;
  const rest = m[2]!.split(";")[0]!.trim();
  if (rest.startsWith("@")) return { name: m[1]!, source: urlSource(rest.slice(1).trim()) };
  return { name: m[1]!, source: { kind: "registry", spec: rest.replace(/^\(|\)$/g, "").trim() } };
}

function urlSource(url: string): DependencySource {
  if (VCS_PREFIX.test(url)) return { kind: "git", spec: url, pinnedToCommit: /@[0-9a-f]{40}(#|$)/i.test(url) };
  if (url.startsWith("file:") || url.startsWith(".") || url.startsWith("/")) return { kind: "local" };
  return { kind: "url", spec: url, insecure: url.startsWith("http://") };
}

export interface RequirementsFile {
  deps: DeclaredDependency[];
  /** `--index-url` / `--extra-index-url` set: packages may come from a private index. */
  customIndex: boolean;
}

export function parseRequirementsTxt(manifest: string, src: string): RequirementsFile {
  const deps: DeclaredDependency[] = [];
  let customIndex = false;
  src.split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    if (/^(-i|--index-url|--extra-index-url)\b/.test(line)) {
      if (!/pypi\.org\/simple/.test(line)) customIndex = true;
      return;
    }
    const editable = /^(-e|--editable)\s+(.+)$/.exec(line);
    if (line.startsWith("-") && !editable) return;
    const req = parseRequirement(editable ? editable[2]! : line);
    if (!req) return;
    deps.push({ ecosystem: "PyPI", name: req.name, registryName: req.name, source: req.source, manifest, line: i + 1, snippet: clip(line) });
  });
  return { deps, customIndex };
}

/** Sections whose arrays hold PEP 508 strings, and which keys in them count. */
function pep621ArrayKey(section: string, key: string): boolean {
  if (section === "project") return key === "dependencies";
  return section === "project.optional-dependencies" || section === "dependency-groups";
}

const POETRY_SECTION = /^tool\.poetry\.(dependencies|dev-dependencies|group\.[\w-]+\.dependencies)$/;

export function parsePyproject(manifest: string, src: string): DeclaredDependency[] {
  const deps: DeclaredDependency[] = [];
  let section = "";
  let inArray = false;
  const lines = src.split("\n");
  lines.forEach((raw, i) => {
    const line = raw.replace(/\s+#.*$/, "");
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (header && !inArray) {
      section = header[1]!.trim();
      return;
    }
    if (!inArray) {
      const open = /^\s*([\w.-]+)\s*=\s*\[(.*)$/.exec(line);
      if (open && pep621ArrayKey(section, open[1]!)) {
        inArray = true;
        collectStrings(open[2]!, i);
        return;
      }
      const poetry = POETRY_SECTION.test(section) ? /^\s*([\w.-]+)\s*=\s*(.+)$/.exec(line) : null;
      if (poetry && poetry[1] !== "python") {
        const name = poetry[1]!;
        deps.push({ ecosystem: "PyPI", name, registryName: name, source: poetrySource(poetry[2]!.trim()), manifest, line: i + 1, snippet: clip(raw.trim()) });
      }
      return;
    }
    collectStrings(line, i);
  });
  return deps;

  function collectStrings(text: string, i: number) {
    for (const m of text.matchAll(/"([^"]*)"|'([^']*)'/g)) {
      const value = m[1] ?? m[2] ?? "";
      const req = parseRequirement(value);
      if (req) deps.push({ ecosystem: "PyPI", name: req.name, registryName: req.name, source: req.source, manifest, line: i + 1, snippet: clip(value) });
    }
    // Brackets inside quoted strings (extras) don't close the array.
    if (text.replace(/"[^"]*"|'[^']*'/g, "").includes("]")) inArray = false;
  }
}

function poetrySource(value: string): DependencySource {
  if (value.startsWith("{")) {
    const field = (k: string) => new RegExp(`\\b${k}\\s*=\\s*"([^"]*)"`).exec(value)?.[1];
    const git = field("git");
    if (git) {
      const rev = field("rev");
      return { kind: "git", spec: git, pinnedToCommit: !!rev && /^[0-9a-f]{40}$/i.test(rev) };
    }
    const url = field("url");
    if (url) return { kind: "url", spec: url, insecure: url.startsWith("http://") };
    if (field("path")) return { kind: "local" };
    return { kind: "registry", spec: field("version") ?? "" };
  }
  return { kind: "registry", spec: value.replace(/^["']|["']$/g, "") };
}
