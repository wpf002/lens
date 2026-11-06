import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SecurityReport } from "../src/types.js";
import {
  checkSupplyChain, typosquatTarget, osaDistance, npmPinState, pypiPinState,
  parsePackageJson, parseRequirementsTxt, parsePyproject, scanProject, buildChecklist,
  versionedLine, parseGitSource, gitPinnedLine, successorName, registryTarballVersion, pypiCompatible, githubRepo, pickRef, findingItemId,
  type RegistryFetch, type GitResolve, type SupplyChainOptions, type DeclaredDependency,
} from "../src/index.js";

const NOW = new Date("2026-11-01T00:00:00Z");
const OLD = "2015-01-01T00:00:00.000Z";
const RECENT = "2026-10-25T00:00:00.000Z";

type Route = { status?: number; body?: unknown; headers?: Record<string, string> } | "network-error" | "hang";

/** Fake registry keyed by URL. Unknown URLs 404. Records every requested URL. */
function fakeRegistry(routes: Record<string, Route>) {
  const calls: string[] = [];
  const fetch: RegistryFetch = async (url, init) => {
    calls.push(url);
    const route = routes[url];
    if (route === "network-error") throw new TypeError("fetch failed");
    if (route === "hang") {
      return new Promise<Response>((_, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason));
      });
    }
    if (!route) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(route.body ?? {}), { status: route.status ?? 200, headers: route.headers });
  };
  return { fetch, calls };
}

const npmPackument = (name: string, opts: { created?: string; latest?: string; scripts?: Record<string, string>; deprecated?: string; repository?: unknown } = {}) => {
  const latest = opts.latest ?? "1.0.0";
  return {
    [`https://registry.npmjs.org/${name.replace("/", "%2f")}`]: {
      body: {
        "dist-tags": { latest },
        time: { created: opts.created ?? OLD },
        versions: { [latest]: { scripts: opts.scripts, deprecated: opts.deprecated, repository: opts.repository } },
      },
    },
  };
};
const npmLatest = (name: string, body: Record<string, unknown> = { version: "4.0.0" }) => ({
  [`https://registry.npmjs.org/${name}/latest`]: { body },
});
const github = (ownerRepo: string, archived: boolean) => ({
  [`https://api.github.com/repos/${ownerRepo}`]: { body: { archived } },
});
const SHA = "0123456789abcdef0123456789abcdef01234567";
/** Tests never shell out to git; a resolver must be passed explicitly. */
const noGit: GitResolve = async () => {
  throw new Error("git not available in tests");
};
const downloads = (name: string, weekly: number) => ({
  [`https://api.npmjs.org/downloads/point/last-week/${name}`]: { body: { downloads: weekly } },
});
const pypi = (name: string, opts: { created?: string; status?: string; reason?: string } = {}) => ({
  [`https://pypi.org/simple/${name}/`]: {
    body: {
      meta: { "api-version": "1.4" },
      name,
      versions: ["1.0.0", "1.2.0", "2.0.0rc1"],
      files: [{ filename: `${name}-1.0.0.tar.gz`, "upload-time": opts.created ?? OLD }],
      ...(opts.status ? { "project-status": { status: opts.status, reason: opts.reason } } : {}),
    },
  },
});

async function tmpRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), "lens-supply-"));
}

async function run(manifests: SupplyChainOptions["manifests"], routes: Record<string, Route>, extra: Partial<SupplyChainOptions> = {}) {
  const root = extra.root ?? (await tmpRoot());
  const reg = fakeRegistry(routes);
  const res = await checkSupplyChain({ root, manifests, offline: false, fetch: reg.fetch, gitResolve: noGit, now: NOW, ...extra });
  return { ...res, calls: reg.calls, root, rules: res.findings.map((f) => `${f.rule}:${f.snippet}`) };
}

const pkgJson = (deps: Record<string, string>, extra: Record<string, unknown> = {}) => ({
  path: "package.json",
  src: JSON.stringify({ name: "app", dependencies: deps, ...extra }, null, 2),
});

describe("supply-chain helpers", () => {
  it("measures edit distance with adjacent swaps", () => {
    expect(osaDistance("lodash", "lodahs")).toBe(1);
    expect(osaDistance("express", "expres")).toBe(1);
    expect(osaDistance("express", "exprss")).toBe(1);
    expect(osaDistance("requests", "reqeusts")).toBe(1);
    expect(osaDistance("abc", "xyzabc", 2)).toBe(3);
  });

  it("finds typosquat targets and skips popular names and short names", () => {
    expect(typosquatTarget("expres", "npm")).toEqual({ target: "express", distance: 1 });
    expect(typosquatTarget("nodefetch", "npm")).toEqual({ target: "node-fetch", distance: 1 });
    expect(typosquatTarget("express", "npm")).toBeUndefined();
    expect(typosquatTarget("reqeusts", "PyPI")).toEqual({ target: "requests", distance: 1 });
    // Distance 2 needs a longer name, so short names don't match everything.
    expect(typosquatTarget("chak", "npm")).toBeUndefined();
    expect(typosquatTarget("totally-unrelated-name", "npm")).toBeUndefined();
  });

  it("classifies npm and PyPI version specs", () => {
    expect(npmPinState("^1.2.3")).toBe("pinned");
    expect(npmPinState("1.x")).toBe("pinned");
    expect(npmPinState("*")).toBe("floating");
    expect(npmPinState("latest")).toBe("floating");
    expect(npmPinState("")).toBe("floating");
    expect(npmPinState(">=1.0.0")).toBe("open");
    expect(npmPinState(">=1.0.0 <2")).toBe("pinned");
    expect(pypiPinState("")).toBe("floating");
    expect(pypiPinState(">=2.0")).toBe("open");
    expect(pypiPinState(">=2.0,<3")).toBe("pinned");
    expect(pypiPinState("==2.31.0")).toBe("pinned");
    expect(pypiPinState("~=2.31")).toBe("pinned");
  });

  it("parses manifests with lines, aliases, and git/URL sources", () => {
    const npm = parsePackageJson("package.json", JSON.stringify({
      dependencies: { a: "npm:real-pkg@^1.0.0", b: "github:user/repo", c: "workspace:*", d: "https://example.com/d.tgz" },
    }, null, 2));
    expect(npm.map((d) => [d.name, d.registryName, d.source.kind, d.line])).toEqual([
      ["a", "real-pkg", "registry", 3], ["b", "b", "git", 4], ["c", "c", "local", 5], ["d", "d", "url", 6],
    ]);
    const req = parseRequirementsTxt("requirements.txt", "flask==3.0.0\n-e git+https://github.com/x/y.git#egg=ylib\nrequests[socks] >=2 ; python_version>'3'\n# note\n");
    expect(req.deps.map((d) => [d.name, d.source.kind, d.line])).toEqual([["flask", "registry", 1], ["ylib", "git", 2], ["requests", "registry", 3]]);
    const py = parsePyproject("pyproject.toml", '[project]\nname = "x"\ndependencies = [\n  "httpx>=0.27,<1",\n  "rich",\n]\n[tool.poetry.dependencies]\npython = "^3.11"\nfastapi = "^0.110"\n');
    expect(py.map((d) => [d.name, d.line])).toEqual([["httpx", 4], ["rich", 5], ["fastapi", 9]]);
  });
});

describe("checkSupplyChain", () => {
  it("flags a typosquat only when the package isn't widely downloaded", async () => {
    const r = await run([pkgJson({ expres: "^1.0.0", colors: "^1.4.0" })], {
      ...npmPackument("expres"), ...downloads("expres", 12), ...npmLatest("colors", { version: "1.4.0" }),
      ...npmLatest("express", { version: "4.21.2" }),
    });
    expect(r.rules).toEqual(['dep-typosquat:"expres": "^1.0.0"']);
    const f = r.findings[0]!;
    expect(f).toMatchObject({ category: "supply-chain", cwe: "CWE-1357", severity: "high", path: "package.json", line: 4 });
    expect(f.message).toContain('change `"expres": "^1.0.0"` to `"express": "^4.21.2"`, then change every import of expres to express');

    const busy = await run([pkgJson({ expres: "^1.0.0" })], { ...npmPackument("expres"), ...downloads("expres", 900_000) });
    expect(busy.findings).toEqual([]);
  });

  it("flags packages missing from the registry and suggests the close match", async () => {
    const r = await run([pkgJson({ "react-hook-formz": "^7.0.0", "ai-made-up-helper": "^1.0.0" })], npmLatest("react-hook-form", { version: "7.53.0" }));
    expect(r.findings.map((f) => f.rule)).toEqual(["dep-not-on-registry", "dep-not-on-registry"]);
    expect(r.findings[0]!.message).toContain('`"react-hook-formz": "^7.0.0"` to `"react-hook-form": "^7.53.0"`');
    expect(r.findings[1]!.message).toContain('Remove `"ai-made-up-helper": "^1.0.0"` from package.json');
    expect(r.status).toMatchObject({ packages: 2, checked: 2, skipped: 0 });
  });

  it("flags new packages and install scripts unless pinned to an exact version", async () => {
    const routes = {
      ...npmPackument("fresh-lib", { created: RECENT }),
      ...npmPackument("native-thing", { scripts: { postinstall: "node setup.js", test: "jest" } }),
      ...downloads("native-thing", 40),
    };
    const r = await run([pkgJson({ "fresh-lib": "^1.0.0", "native-thing": "^1.0.0" })], routes);
    expect(r.findings.map((f) => [f.rule, f.cwe])).toEqual([["dep-new-package", "CWE-1357"], ["dep-install-script", "CWE-829"]]);
    expect(r.findings[0]!.message).toContain("2026-10-25");
    expect(r.findings[0]!.message).toContain('change `"fresh-lib": "^1.0.0"` to `"fresh-lib": "1.0.0"`');
    expect(r.findings[1]!.message).toContain("postinstall");
    expect(r.findings[1]!.message).toContain('`"native-thing": "1.0.0"`');

    const pinned = await run([pkgJson({ "fresh-lib": "1.0.0", "native-thing": "1.0.0" })], routes);
    expect(pinned.findings).toEqual([]);
  });

  it("flags unpinned, git, and URL dependencies without network", async () => {
    const r = await run([
      pkgJson({ a: "*", b: "latest", c: ">=2.0.0", d: "git+https://github.com/x/d.git", e: "github:x/e#0123456789abcdef0123456789abcdef01234567", f: "http://example.com/f.tgz" }),
      { path: "requirements.txt", src: "flask\nrequests>=2\n" },
    ], {}, { offline: true });
    expect(r.findings.map((f) => `${f.rule}:${f.severity}:${f.snippet}`)).toEqual([
      'dep-unpinned:medium:"a": "*"',
      'dep-unpinned:medium:"b": "latest"',
      'dep-unpinned:low:"c": ">=2.0.0"',
      'dep-git-source:high:"f": "http://example.com/f.tgz"',
      "dep-unpinned:medium:flask",
      "dep-unpinned:low:requests>=2",
      'dep-git-source:medium:"d": "git+https://github.com/x/d.git"',
    ]);
    expect(r.findings[0]!.message).toContain("Pin it to the version your lockfile installs");
    expect(r.findings[3]!.message).toContain('change `"f": "http://example.com/f.tgz"` to `"f": "https://example.com/f.tgz"`');
    expect(r.findings.find((f) => f.rule === "dep-git-source")!.cwe).toBe("CWE-494");
  });

  it("flags deprecated npm packages and archived or quarantined PyPI projects", async () => {
    const r = await run([
      pkgJson({ request: "^2.88.0", "old-crypto-lib": "^1.0.0" }),
      { path: "requirements.txt", src: "pycrypto==2.6.1\nevilpkg==1.0\n" },
    ], {
      ...npmLatest("request", { version: "2.88.2", deprecated: "request has been deprecated, see https://github.com/request/request/issues/3142" }),
      ...npmPackument("old-crypto-lib", { deprecated: "Contains a security vulnerability, use new-crypto-lib" }),
      ...npmLatest("new-crypto-lib", { version: "2.1.0" }),
      ...pypi("pycrypto", { status: "archived" }),
      ...pypi("evilpkg", { status: "quarantined", reason: "malware report" }),
    });
    expect(r.findings.map((f) => `${f.rule}:${f.severity}:${f.cwe}`)).toEqual([
      "dep-deprecated:low:CWE-1104",
      "dep-deprecated:medium:CWE-1104",
      "dep-deprecated:low:CWE-1104",
      "dep-quarantined:critical:CWE-506",
    ]);
    expect(r.findings[1]!.message).toContain('`"old-crypto-lib": "^1.0.0"` to `"new-crypto-lib": "^2.1.0"`');
    expect(r.findings[0]!.message).toContain('Remove `"request": "^2.88.0"` from package.json');
  });

  it("skips workspace, private-registry, and private-index packages", async () => {
    const root = await tmpRoot();
    await fs.writeFile(path.join(root, ".npmrc"), "@acme:registry=https://npm.acme.internal/\n");
    const r = await run([
      pkgJson({ "@acme/ui": "^1.0.0", "my-sibling": "*", "linked": "file:../linked" }),
      { path: "requirements.txt", src: "--index-url https://pypi.acme.internal/simple\nacme-internal==1.0\n" },
    ], {}, { root, localPackages: new Set(["my-sibling"]) });
    expect(r.calls).toEqual([]);
    expect(r.findings).toEqual([]);
  });

  it("finishes offline, marks lookups skipped, and stops after repeated network failures", async () => {
    const deps = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`pkg-number-${i}`, "^1.0.0"]));
    const routes = Object.fromEntries(Object.keys(deps).map((n) => [`https://registry.npmjs.org/${n}`, "network-error" as const]));
    const r = await run([pkgJson(deps)], routes);
    expect(r.findings).toEqual([]);
    expect(r.status).toMatchObject({ packages: 12, checked: 0, skipped: 12, skippedReason: "network error" });
    // Concurrency lets a few requests start before the client gives up, but not all twelve.
    expect(r.calls.length).toBeLessThan(12);

    const off = await run([pkgJson({ "left-padx": "^1.0.0" })], {}, { offline: true });
    expect(off.calls).toEqual([]);
    expect(off.status).toMatchObject({ packages: 1, skipped: 1, skippedReason: "offline" });
  });

  it("times out a hanging registry and marks the package skipped", async () => {
    const r = await run([pkgJson({ "slow-lib": "^1.0.0" })], { "https://registry.npmjs.org/slow-lib": "hang" }, { timeoutMs: 50 });
    expect(r.status).toMatchObject({ skipped: 1, skippedReason: "timeout" });
  });

  it("caches lookups under .lens and falls back to expired data when offline", async () => {
    const root = await tmpRoot();
    const manifests = [pkgJson({ expres: "^1.0.0" })];
    const first = await run(manifests, { ...npmPackument("expres"), ...downloads("expres", 3) }, { root });
    // Package, downloads, and the typosquat target's latest release.
    expect(first.calls.length).toBe(3);
    const cache = JSON.parse(await fs.readFile(path.join(root, ".lens", "registry-cache.json"), "utf8"));
    expect(Object.keys(cache.entries)).toHaveLength(3);

    const second = await run(manifests, {}, { root });
    expect(second.calls).toEqual([]);
    expect(second.rules).toEqual(first.rules);

    const later = new Date(NOW.getTime() + 3 * 24 * 60 * 60 * 1000);
    const offline = await run(manifests, {}, { root, offline: true, now: later });
    expect(offline.rules).toEqual(first.rules);
    expect(offline.status).toMatchObject({ skipped: 1, skippedReason: "offline" });
  });

  it("names the latest release when a dependency is unpinned", async () => {
    const r = await run([
      pkgJson({ a: "*" }),
      { path: "requirements.txt", src: "flask\nrequests[socks]>=2 ; python_version>'3' # http\n" },
      { path: "pyproject.toml", src: '[tool.poetry.dependencies]\npython = "^3.11"\nrich = "*"\n' },
    ], { ...npmPackument("a", { latest: "3.2.1" }), ...pypi("flask"), ...pypi("requests"), ...pypi("rich") });
    expect(r.findings.map((f) => f.message.split(". ").pop())).toEqual([
      'In package.json, change `"a": "*"` to `"a": "^3.2.1"`.',
      "In requirements.txt, change `flask` to `flask~=1.2`.",
      "In requirements.txt, change `requests[socks]>=2 ; python_version>'3' # http` to `requests[socks]~=1.2 ; python_version>'3'`.",
      'In pyproject.toml, change `rich = "*"` to `rich = "^1.2.0"`.',
    ]);
  });

  it("flags packages whose GitHub repository is archived, and fails soft when GitHub rate-limits", async () => {
    const deps = { "old-orm": "^1.0.0", "live-lib": "^1.0.0" };
    const r = await run([pkgJson(deps)], {
      ...npmPackument("old-orm", { repository: { url: "git+https://github.com/someone/old-orm.git" } }),
      ...npmPackument("live-lib", { repository: "github:someone/live-lib" }),
      ...github("someone/old-orm", true), ...github("someone/live-lib", false),
    });
    expect(r.rules).toEqual(['dep-deprecated:"old-orm": "^1.0.0"']);
    expect(r.findings[0]!.message).toContain("(someone/old-orm) is archived on GitHub");
    expect(r.findings[0]!.message).toContain('Remove `"old-orm": "^1.0.0"`');

    const limited = await run([pkgJson(deps)], {
      ...npmPackument("old-orm", { repository: "someone/old-orm" }),
      ...npmPackument("live-lib", { repository: "someone/live-lib" }),
      "https://api.github.com/repos/someone/old-orm": { status: 403, headers: { "x-ratelimit-remaining": "0" } },
    });
    expect(limited.findings).toEqual([]);
    expect(limited.status).toMatchObject({ packages: 2, checked: 2, skipped: 0 });
  });

  it("pins git dependencies to the commit or registry release Lens looked up", async () => {
    const asked: string[] = [];
    const gitResolve: GitResolve = async (url, ref) => {
      asked.push(`${url}#${ref}`);
      return url.includes("gone") ? undefined : SHA;
    };
    const r = await run([
      pkgJson({ d: "github:x/d#main", published: "github:x/published", gone: "git+https://github.com/x/gone.git", old: "x/old" }),
      { path: "requirements.txt", src: "git+https://github.com/x/pylib.git@v2#egg=pylib\n" },
    ], {
      ...npmLatest("published", { version: "2.0.0", repository: { url: "https://github.com/x/published" } }),
      ...github("x/old", true),
    }, { gitResolve });
    const byName = Object.fromEntries(r.findings.map((f) => [`${f.rule}:${f.snippet.split('"')[1] ?? f.snippet}`, f.message]));
    expect(byName["dep-git-source:d"]).toContain(`Pin it to the commit main points to now. In package.json, change \`"d": "github:x/d#main"\` to \`"d": "github:x/d#${SHA}"\``);
    expect(byName["dep-git-source:published"]).toContain('change `"published": "github:x/published"` to `"published": "^2.0.0"`');
    expect(byName["dep-git-source:gone"]).toContain("Lens couldn't read https://github.com/x/gone.git");
    expect(byName["dep-deprecated:old"]).toContain("x/old, which is archived on GitHub");
    expect(byName["dep-git-source:git+https://github.com/x/pylib.git@v2#egg=pylib"])
      .toContain(`to \`git+https://github.com/x/pylib.git@${SHA}#egg=pylib\``);
    expect(asked).toEqual(expect.arrayContaining(["https://github.com/x/d.git#main", "https://github.com/x/pylib.git#v2"]));
    expect(asked).not.toContain(expect.stringContaining("published"));
    expect(r.status).toMatchObject({ skipped: 0 });
  });

  it("ignores a corrupt cache file", async () => {
    const root = await tmpRoot();
    await fs.mkdir(path.join(root, ".lens"));
    await fs.writeFile(path.join(root, ".lens", "registry-cache.json"), "{not json");
    const r = await run([pkgJson({ expres: "^1.0.0" })], { ...npmPackument("expres"), ...downloads("expres", 3) }, { root });
    expect(r.rules).toEqual(['dep-typosquat:"expres": "^1.0.0"']);
  });
});

describe("supply-chain in scan and checklist", () => {
  it("adds findings to the security report and fails the realdeps check", async () => {
    const root = await tmpRoot();
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "demo", dependencies: { expres: "^1.0.0" } }, null, 2));
    await fs.writeFile(path.join(root, "index.js"), "require('expres');\n");
    const reg = fakeRegistry({ ...npmPackument("expres"), ...downloads("expres", 3) });
    const { graph } = await scanProject(root, { offline: false, registryFetch: reg.fetch });
    const f = graph.security!.findings.find((x) => x.rule === "dep-typosquat");
    expect(f).toMatchObject({ category: "supply-chain", path: "package.json", status: "open" });
    const item = graph.security!.checklist!.find((c) => c.id === "t3-realdeps");
    expect(item).toMatchObject({ status: "fail", source: "scanner" });
  });

  it("marks the realdeps check unverified when lookups were skipped", async () => {
    const root = await tmpRoot();
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "demo", dependencies: { express: "^4.0.0" } }));
    const { graph } = await scanProject(root, { offline: true });
    const item = graph.security!.checklist!.find((c) => c.id === "t3-realdeps")!;
    expect(item.status).toBe("unverified");
    expect(item.evidence[0]).toContain("skipped for 1 of 1 packages (offline)");
  });

  it("clears the realdeps check when every package was checked", () => {
    const security: SecurityReport = { generatedAt: "", rulesVersion: "", entryPoints: [], findings: [], exposure: [], summary: { bySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 }, unguardedEndpoints: 0, guardedEndpoints: 0, publicEndpoints: 0, riskScore: 0 } };
    const items = buildChecklist({ root: "/nonexistent", files: [], deps: { express: "^4.0.0" }, endpoints: [], security, supplyChain: { packages: 1, checked: 1, skipped: 0, unsupported: [] } });
    expect(items.find((c) => c.id === "t3-realdeps")).toMatchObject({ status: "clear" });
  });
});

const dep = (over: Partial<DeclaredDependency> & Pick<DeclaredDependency, "snippet" | "source">): DeclaredDependency => ({
  ecosystem: "PyPI", name: "pkg", registryName: "pkg", manifest: "requirements.txt", line: 1, ...over,
});

describe("supply-chain fix text", () => {
  it("writes version lines in the manifest's own format", () => {
    const npm = dep({ ecosystem: "npm", name: "a", snippet: '"a": "*"', source: { kind: "registry", spec: "*" } });
    expect(versionedLine(npm, "3.2.1", "range")).toBe('"a": "^3.2.1"');
    expect(versionedLine(npm, "3.2.1", "exact", "b")).toBe('"b": "3.2.1"');
    const poetry = dep({ snippet: 'pkg = { version = "*", extras = ["x"] }', source: { kind: "registry", spec: "*" } });
    expect(versionedLine(poetry, "1.4.2", "range")).toBe('pkg = { version = "^1.4.2", extras = ["x"] }');
    const pep = dep({ snippet: "pkg[x]>=1 ; sys_platform=='linux'", source: { kind: "registry", spec: ">=1" } });
    expect(versionedLine(pep, "1.4.2", "exact")).toBe("pkg[x]==1.4.2 ; sys_platform=='linux'");
    expect(versionedLine(pep, "1.4.2", "range", "other")).toBe("other~=1.4 ; sys_platform=='linux'");
    expect(pypiCompatible("5")).toBe(">=5,<6");
  });

  it("reads git sources and pins them to a commit", () => {
    const npm = (spec: string) => dep({ ecosystem: "npm", name: "d", snippet: `"d": "${spec}"`, source: { kind: "git", spec, pinnedToCommit: false } });
    expect(parseGitSource(npm("github:x/d#v1"))).toEqual({ cloneUrl: "https://github.com/x/d.git", ref: "v1", github: "x/d" });
    expect(parseGitSource(npm("gitlab:x/d"))).toEqual({ cloneUrl: "https://gitlab.com/x/d.git", ref: "HEAD", github: undefined });
    expect(parseGitSource(npm("git+ssh://git@github.com/x/d.git#main"))).toMatchObject({ cloneUrl: "https://github.com/x/d.git", ref: "main", github: "x/d" });
    expect(parseGitSource(npm("github:x/d#semver:^1"))).toBeUndefined();
    expect(parseGitSource(npm("github:x/d#abc1234"))).toBeUndefined();
    expect(gitPinnedLine(npm("github:x/d#v1"), SHA)).toBe(`"d": "github:x/d#${SHA}"`);
    const poetry = dep({ snippet: 'pkg = { git = "https://github.com/x/p.git", branch = "dev" }', source: { kind: "git", spec: "https://github.com/x/p.git", pinnedToCommit: false } });
    expect(parseGitSource(poetry)).toMatchObject({ ref: "dev", github: "x/p" });
    expect(gitPinnedLine(poetry, SHA)).toBe(`pkg = { git = "https://github.com/x/p.git", rev = "${SHA}" }`);
  });

  it("turns registry tarball URLs into version pins", () => {
    const npmUrl = "https://registry.npmjs.org/@scope/lib.js/-/lib.js-2.3.4.tgz";
    const npm = dep({ ecosystem: "npm", name: "@scope/lib.js", registryName: "@scope/lib.js", snippet: `"@scope/lib.js": "${npmUrl}"`, source: { kind: "url", spec: npmUrl, insecure: false } });
    expect(registryTarballVersion(npm, npmUrl)).toBe("2.3.4");
    const whl = "https://files.pythonhosted.org/packages/ab/cd/my_pkg-1.0.2-py3-none-any.whl";
    expect(registryTarballVersion(dep({ name: "my-pkg", registryName: "my-pkg", snippet: `my-pkg @ ${whl}`, source: { kind: "url", spec: whl, insecure: false } }), whl)).toBe("1.0.2");
    expect(registryTarballVersion(npm, "https://example.com/lib.js-2.3.4.tgz")).toBeUndefined();
  });

  it("finds the successor a deprecation notice names", () => {
    expect(successorName("Use @scope/new-lib instead.", "old")).toBe("@scope/new-lib");
    expect(successorName("This package has been renamed to `fresh`.", "old")).toBe("fresh");
    expect(successorName("Please use the native fetch API", "old")).toBeUndefined();
    expect(successorName("use version 2 or later", "old")).toBeUndefined();
    expect(successorName("deprecated", "old")).toBeUndefined();
  });

  it("reads GitHub repos from package metadata", () => {
    expect(githubRepo({ url: "git+https://github.com/Owner/Repo.git" })).toBe("Owner/Repo");
    expect(githubRepo("github:owner/repo")).toBe("owner/repo");
    expect(githubRepo("owner/repo")).toBe("owner/repo");
    expect(githubRepo("https://gitlab.com/owner/repo")).toBeUndefined();
    expect(githubRepo(42)).toBeUndefined();
  });

  it("picks the exact ref from ls-remote output, peeling annotated tags", () => {
    const out = [`${"a".repeat(40)}\trefs/heads/feature/v1`, `${"b".repeat(40)}\trefs/tags/v1`, `${"c".repeat(40)}\trefs/tags/v1^{}`, `${"d".repeat(40)}\tHEAD`].join("\n");
    expect(pickRef(out, "v1")).toBe("c".repeat(40));
    expect(pickRef(out, "HEAD")).toBe("d".repeat(40));
    expect(pickRef(`${"a".repeat(40)}\trefs/heads/feature/main`, "main")).toBeUndefined();
  });

  it("keeps a supply-chain row's id when its message gains a new version", () => {
    const base = { rule: "dep-unpinned", path: "package.json", category: "supply-chain" as const, snippet: '"a": "*"' };
    expect(findingItemId({ ...base, message: "change to ^1.0.0" })).toBe(findingItemId({ ...base, message: "change to ^2.0.0" }));
  });
});
