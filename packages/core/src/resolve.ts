/** Import specifier → project file resolution, per language. */
import path from "node:path/posix";
import type { ImportInfo } from "./extract.js";

export interface ResolverContext {
  files: Set<string>;
  /** tsconfig/jsconfig "paths": alias prefix → target dirs (relative to root). */
  tsPaths: Array<{ prefix: string; targets: string[]; exact: boolean }>;
  tsBaseUrl?: string;
  goModule?: string;
  /** Workspace package name → its directory (monorepos). */
  workspacePackages: Map<string, { dir: string; entry?: string }>;
  /** Java/Kotlin/Scala/C# fully qualified type → file, built from package + class declarations. */
  qualifiedTypes: Map<string, string>;
  /** Directories that act as python import roots ("", "src"). */
  pyRoots: string[];
  /** basename-without-ext → files, for fallback matching. */
  byStem: Map<string, string[]>;
}

const JS_EXT = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte", ".json"];
const JS_INDEX = JS_EXT.map((e) => `/index${e}`);

function tryFiles(ctx: ResolverContext, base: string, exts: string[], indexes: string[] = []): string | null {
  const norm = path.normalize(base).replace(/^\.\//, "");
  if (norm.startsWith("..")) return null;
  if (ctx.files.has(norm)) return norm;
  // TS ESM convention: import "./x.js" where the source is x.ts
  const stripped = norm.replace(/\.(m|c)?js$/, "");
  for (const e of exts) if (ctx.files.has(stripped + e)) return stripped + e;
  for (const e of exts) if (ctx.files.has(norm + e)) return norm + e;
  for (const i of indexes) if (ctx.files.has(norm + i)) return norm + i;
  return null;
}

export function resolveImport(fromFile: string, lang: string, imp: ImportInfo, ctx: ResolverContext): string | null {
  const dir = path.dirname(fromFile) === "." ? "" : path.dirname(fromFile);
  const spec = imp.source.trim();
  if (!spec) return null;
  switch (lang) {
    case "typescript":
    case "javascript":
    case "vue":
    case "svelte":
      return resolveJs(dir, spec, ctx);
    case "python":
      return resolvePython(dir, spec, ctx);
    case "go":
      return resolveGo(spec, ctx);
    case "rust":
      return resolveRust(fromFile, spec, imp.style, ctx);
    case "java":
    case "kotlin":
    case "scala":
    case "csharp":
      return resolveQualified(spec, ctx);
    case "ruby":
      return tryFiles(ctx, spec.startsWith(".") ? path.join(dir, spec) : spec, [".rb"]) ?? tryFiles(ctx, path.join("lib", spec), [".rb"]);
    case "php":
      if (imp.style === "include") return tryFiles(ctx, path.join(dir, spec), [".php"]) ?? tryFiles(ctx, spec, [".php"]);
      return resolveQualified(spec.replace(/\\/g, "."), ctx) ?? byStem(ctx, spec.split("\\").pop()!, ".php");
    case "c":
    case "cpp":
      return tryFiles(ctx, path.join(dir, spec), [""]) ?? tryFiles(ctx, spec, [""]) ?? tryFiles(ctx, path.join("include", spec), [""]);
    case "shell":
      return tryFiles(ctx, path.join(dir, spec), [".sh", ""]) ?? null;
    case "swift":
    case "dart":
      if (spec.startsWith("package:") || !spec.includes("/")) return null;
      return tryFiles(ctx, path.join(dir, spec), [".dart", ".swift", ""]);
    case "solidity":
      return spec.startsWith(".") ? tryFiles(ctx, path.join(dir, spec), [""]) : null;
    default:
      return null;
  }
}

function resolveJs(dir: string, spec: string, ctx: ResolverContext): string | null {
  if (spec.startsWith(".") || spec.startsWith("/")) {
    return tryFiles(ctx, spec.startsWith("/") ? spec.slice(1) : path.join(dir, spec), JS_EXT, JS_INDEX);
  }
  for (const p of ctx.tsPaths) {
    if (p.exact ? spec === p.prefix : spec.startsWith(p.prefix)) {
      const rest = p.exact ? "" : spec.slice(p.prefix.length);
      for (const t of p.targets) {
        const r = tryFiles(ctx, path.join(t, rest), JS_EXT, JS_INDEX);
        if (r) return r;
      }
    }
  }
  if (ctx.tsBaseUrl !== undefined) {
    const r = tryFiles(ctx, path.join(ctx.tsBaseUrl, spec), JS_EXT, JS_INDEX);
    if (r) return r;
  }
  // Monorepo workspace packages: "@scope/pkg" or "@scope/pkg/sub"
  const parts = spec.split("/");
  const pkgName = spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
  const ws = ctx.workspacePackages.get(pkgName);
  if (ws) {
    const sub = parts.slice(spec.startsWith("@") ? 2 : 1).join("/");
    if (!sub) {
      const cands = [ws.entry, "src/index", "src/main", "index", "src/lib"].filter(Boolean) as string[];
      for (const c of cands) {
        const r = tryFiles(ctx, path.join(ws.dir, c.replace(/^\.\//, "").replace(/^dist\//, "src/")), JS_EXT, JS_INDEX);
        if (r) return r;
      }
    } else {
      return tryFiles(ctx, path.join(ws.dir, "src", sub), JS_EXT, JS_INDEX) ?? tryFiles(ctx, path.join(ws.dir, sub), JS_EXT, JS_INDEX);
    }
  }
  return null;
}

function resolvePython(dir: string, spec: string, ctx: ResolverContext): string | null {
  if (spec.startsWith(".")) {
    const dots = /^\.+/.exec(spec)![0].length;
    let base = dir;
    for (let i = 1; i < dots; i++) base = path.dirname(base) === "." ? "" : path.dirname(base);
    const rest = spec.slice(dots).replace(/\./g, "/");
    const target = rest ? path.join(base, rest) : base;
    return tryFiles(ctx, target, [".py", ".pyi"], ["/__init__.py"]);
  }
  const rel = spec.replace(/\./g, "/");
  for (const root of ctx.pyRoots) {
    const r = tryFiles(ctx, root ? path.join(root, rel) : rel, [".py", ".pyi"], ["/__init__.py"]);
    if (r) return r;
    // `from pkg.mod import name` where name is a submodule is handled by the caller trying names.
  }
  return null;
}

function resolveGo(spec: string, ctx: ResolverContext): string | null {
  if (!ctx.goModule || !spec.startsWith(ctx.goModule)) return null;
  const dir = spec.slice(ctx.goModule.length).replace(/^\//, "");
  // Go imports a package (directory): link to the first non-test file in it.
  const inDir = [...ctx.files].filter((f) => path.dirname(f) === (dir || ".") && f.endsWith(".go") && !f.endsWith("_test.go")).sort();
  return inDir[0] ?? null;
}

function resolveRust(fromFile: string, spec: string, style: ImportInfo["style"], ctx: ResolverContext): string | null {
  const dir = path.dirname(fromFile);
  if (style === "mod") {
    const own = /(^|\/)(main|lib|mod)\.rs$/.test(fromFile) ? dir : path.join(dir, path.basename(fromFile, ".rs"));
    return tryFiles(ctx, path.join(own, spec), [".rs"], ["/mod.rs"]);
  }
  const m = /^(crate|super|self)::(.+)$/.exec(spec);
  if (!m) return null;
  const segs = m[2]!.replace(/\{.*$/, "").split("::").filter(Boolean);
  let base = m[1] === "crate" ? findCrateRoot(fromFile, ctx) : m[1] === "super" ? path.dirname(dir) : dir;
  // Walk segments as far as they resolve to files: crate::db::pool::Pool → src/db/pool.rs
  let best: string | null = null;
  for (const seg of segs) {
    base = path.join(base, seg);
    const r = tryFiles(ctx, base, [".rs"], ["/mod.rs"]);
    if (r) best = r;
    else break;
  }
  return best;
}

function findCrateRoot(fromFile: string, ctx: ResolverContext): string {
  let d = path.dirname(fromFile);
  while (d && d !== ".") {
    if (ctx.files.has(path.join(d, "lib.rs")) || ctx.files.has(path.join(d, "main.rs"))) {
      if (path.basename(d) === "src") return d;
    }
    d = path.dirname(d);
  }
  return "src";
}

function resolveQualified(spec: string, ctx: ResolverContext): string | null {
  const clean = spec.replace(/^static\s+/, "").replace(/\.\*$/, "").replace(/\._$/, "").replace(/;$/, "");
  const hit = ctx.qualifiedTypes.get(clean);
  if (hit) return hit;
  // static member import: a.b.C.method → a.b.C
  const parent = clean.slice(0, clean.lastIndexOf("."));
  return ctx.qualifiedTypes.get(parent) ?? null;
}

function byStem(ctx: ResolverContext, stem: string, ext: string): string | null {
  const c = ctx.byStem.get(stem)?.filter((f) => f.endsWith(ext));
  return c && c.length === 1 ? c[0]! : null;
}

/** Parse tsconfig/jsconfig "paths" with comment tolerance. */
export function parseTsPaths(tsconfigSrc: string, configDir: string): { paths: ResolverContext["tsPaths"]; baseUrl?: string } {
  const json = tsconfigSrc.replace(/\/\*[\s\S]*?\*\/|(^|[^:"])\/\/.*$/gm, "$1").replace(/,(\s*[}\]])/g, "$1");
  let o: { compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } };
  try {
    o = JSON.parse(json);
  } catch {
    return { paths: [] };
  }
  const baseUrl = o.compilerOptions?.baseUrl !== undefined ? path.join(configDir, o.compilerOptions.baseUrl) : undefined;
  const base = baseUrl ?? configDir;
  const paths: ResolverContext["tsPaths"] = [];
  for (const [k, v] of Object.entries(o.compilerOptions?.paths ?? {})) {
    const exact = !k.endsWith("*");
    paths.push({
      prefix: k.replace(/\*$/, ""),
      exact,
      targets: v.map((t) => path.join(base, t.replace(/\*$/, "")).replace(/^\.$/, "")),
    });
  }
  return { paths, baseUrl: baseUrl === "." ? "" : baseUrl };
}
