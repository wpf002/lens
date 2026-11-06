/**
 * Exact manifest text for supply-chain fixes. The remediator has no network, so
 * every fix names the versions and commits Lens looked up, written in the same
 * format as the manifest line it replaces.
 */
import type { DeclaredDependency } from "./manifests.js";

const POETRY_LINE = /^[\w.-]+\s*=\s*["'{]/;
const SHA = /^[0-9a-f]{40}$/i;

type PinKind = "range" | "exact";

const isPoetry = (d: DeclaredDependency) => d.ecosystem === "PyPI" && POETRY_LINE.test(d.snippet);

/** PEP 440 compatible-release bound for `version`: `~=2.32` for 2.32.3, `>=5,<6` for 5. */
export function pypiCompatible(version: string): string {
  const parts = version.split(".");
  if (parts.length >= 2) return `~=${parts[0]}.${parts[1]}`;
  const major = Number(parts[0]);
  return Number.isInteger(major) ? `>=${version},<${major + 1}` : `==${version}`;
}

/** `d`'s manifest line rewritten to depend on `name` at `version`. */
export function versionedLine(d: DeclaredDependency, version: string, kind: PinKind, name = d.name): string {
  if (d.ecosystem === "npm") return `"${name}": "${kind === "range" ? "^" : ""}${version}"`;
  if (isPoetry(d)) {
    const spec = kind === "range" ? `^${version}` : version;
    if (d.snippet.includes("{") && name === d.name && /\bversion\s*=/.test(d.snippet)) {
      return d.snippet.replace(/\bversion\s*=\s*"[^"]*"/, `version = "${spec}"`);
    }
    return `${name} = "${spec}"`;
  }
  const head = d.snippet.split(/\s+#/)[0]!;
  const extras = name === d.name ? /^\s*[\w.-]+\s*(\[[^\]]*\])/.exec(head)?.[1] ?? "" : "";
  const marker = /;.*$/.exec(head)?.[0].trimEnd() ?? "";
  return `${name}${extras}${kind === "range" ? pypiCompatible(version) : `==${version}`}${marker ? ` ${marker}` : ""}`;
}

/** Where a git dependency lives and which ref it follows. */
export interface GitSource {
  /** URL `git ls-remote` can read without credentials when the repo is public. */
  cloneUrl: string;
  /** Branch, tag, or HEAD. */
  ref: string;
  /** `owner/repo` when hosted on GitHub. */
  github?: string;
}

const HOSTS: Record<string, string> = { github: "github.com", gitlab: "gitlab.com", bitbucket: "bitbucket.org" };

/** Reads a git dependency's repository and ref, or undefined when Lens can't resolve it (gists, semver ranges, short SHAs). */
export function parseGitSource(d: DeclaredDependency): GitSource | undefined {
  if (d.source.kind !== "git") return undefined;
  const spec = d.source.spec;
  let url: string;
  let ref: string | undefined;
  if (d.ecosystem === "npm") {
    const [base, hash] = spec.split("#", 2) as [string, string | undefined];
    ref = hash;
    const short = /^(?:(github|gitlab|bitbucket):)?([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(base);
    if (short) url = `https://${HOSTS[short[1] ?? "github"]}/${short[2]}/${short[3]}.git`;
    else if (/^(git\+|git:)/.test(base)) url = base;
    else return undefined;
  } else if (isPoetry(d)) {
    url = spec;
    ref = /\b(?:rev|tag|branch)\s*=\s*"([^"]+)"/.exec(d.snippet)?.[1];
  } else {
    if (!spec.startsWith("git+")) return undefined;
    const m = /^([^#]*\/[^/@#]+?)(?:@([^/#]+))?(#.*)?$/.exec(spec);
    if (!m) return undefined;
    url = m[1]!;
    ref = m[2];
  }
  ref ??= "HEAD";
  // A semver range or abbreviated SHA isn't a ref `ls-remote` can look up.
  if (ref.startsWith("semver:") || /^[0-9a-f]{7,39}$/i.test(ref)) return undefined;
  const cloneUrl = toHttps(url.replace(/^git\+/, ""));
  if (!cloneUrl) return undefined;
  const gh = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(cloneUrl);
  return { cloneUrl, ref, github: gh ? `${gh[1]}/${gh[2]}` : undefined };
}

/** Public repos answer over HTTPS without keys; ssh and git:// would prompt or are gone. */
function toHttps(url: string): string | undefined {
  if (url.startsWith("https://")) return url;
  const scp = /^(?:ssh:\/\/)?(?:[\w.-]+@)?([\w.-]+)[:/](.+)$/.exec(url.replace(/^(git|http):\/\//, ""));
  return scp ? `https://${scp[1]}/${scp[2]}` : undefined;
}

/** `d`'s manifest line with its git ref replaced by commit `sha`. */
export function gitPinnedLine(d: DeclaredDependency, sha: string): string {
  if (d.source.kind !== "git" || !SHA.test(sha)) return d.snippet;
  const spec = d.source.spec;
  if (d.ecosystem === "npm") return `"${d.name}": "${spec.split("#")[0]}#${sha}"`;
  if (isPoetry(d)) {
    return d.snippet.replace(/,\s*(?:branch|tag|rev)\s*=\s*"[^"]*"/g, "").replace(/\s*\}\s*$/, `, rev = "${sha}" }`);
  }
  const m = /^([^#]*\/[^/@#]+?)(?:@[^/#]+)?(#.*)?$/.exec(spec);
  return m ? d.snippet.replace(spec, `${m[1]}@${sha}${m[2] ?? ""}`) : d.snippet;
}

const SUCCESSOR = /\b(?:use|using|moved to|replaced by|renamed to|switch to|migrate to|in favou?r of|superseded by)\s+[`'"]?((?:@[\w.-]+\/)?[\w.-]+)/gi;
const NOT_A_PACKAGE = new Set([
  "the", "a", "an", "this", "that", "it", "its", "your", "our", "their", "native", "built-in", "builtin", "node", "nodejs", "node.js",
  "version", "versions", "latest", "newer", "new", "instead", "other", "another", "something", "alternatives", "alternative", "at", "of", "in",
]);

/** Package a deprecation notice points to ("use X instead", "renamed to X"), if any. */
export function successorName(notice: string, current: string): string | undefined {
  for (const m of notice.matchAll(SUCCESSOR)) {
    const name = m[1]!.replace(/\.+$/, "");
    const lower = name.toLowerCase();
    if (name.length < 2 || NOT_A_PACKAGE.has(lower) || /^v?\d/.test(name) || lower === current.toLowerCase()) continue;
    return name;
  }
  return undefined;
}
