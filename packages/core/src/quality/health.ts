/**
 * Code health: deterministic checks for habits common in fast or AI-written code
 * (dead code, copy-paste, swallowed errors, leftover debug output, stubs, type
 * escapes, `_v2` files, unused dependencies, untested files). No LLM involved.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { GraphEdge, GraphNode } from "../types.js";
import type { ImportInfo, SymbolInfo } from "../extract.js";
import { stripComments } from "../security/analyze.js";
import { healthScore } from "./score.js";

export type HealthSeverity = "high" | "medium" | "low";
export type HealthCategory = "errors" | "dead-code" | "duplication" | "leftovers" | "types" | "structure" | "tests" | "dependencies" | "docs";

export interface HealthHit {
  path: string;
  line?: number;
  detail: string;
}

export interface HealthCheck {
  id: string;
  title: string;
  category: HealthCategory;
  severity: HealthSeverity;
  count: number;
  hits: HealthHit[];
  fix: string;
  source?: "scanner" | "ai";
}

export interface HealthReport {
  generatedAt: string;
  /** 0-100, lower when high-severity checks have hits. */
  score: number;
  checks: HealthCheck[];
}

export interface HealthFile {
  path: string;
  src: string;
  lang: string;
  category: string;
  isTest: boolean;
  symbols: SymbolInfo[];
  imports: ImportInfo[];
}

export interface HealthInput {
  root: string;
  files: HealthFile[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  deps: Record<string, string>;
}

const MAX_HITS = 40;
const CODE_LANGS = new Set(["typescript", "tsx", "javascript", "python", "go", "rust", "java", "kotlin", "ruby", "php", "csharp", "swift", "dart"]);
const JS_LANGS = new Set(["typescript", "tsx", "javascript"]);
const ENTRY_RE = /(^|\/)(src\/)?(index|main|app|server|cli|__main__|__init__|manage|wsgi|asgi|program|Application|conftest|setup|vite\.config|next\.config|tailwind\.config|postcss\.config|eslint\.config|vitest\.config|jest\.config)\.[a-z]+$/i;
const FRAMEWORK_ROUTE_DIR = /(^|\/)(pages|app|routes|api|migrations|alembic|scripts|bin|cmd)\//;
const GENERATED = /(^|\/)(dist|build|out|vendor|generated|__generated__|\.next)\//;

/** Names frameworks call by convention; never "dead". */
const CONVENTION_NAMES = new Set([
  "main", "default", "handler", "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS",
  "setup", "teardown", "loader", "action", "middleware", "generateMetadata", "generateStaticParams",
  "getServerSideProps", "getStaticProps", "getStaticPaths", "lifespan", "startup", "shutdown",
  "render", "constructor", "configure", "register", "init", "run", "app", "create_app",
]);

const lineOf = (src: string, index: number) => src.slice(0, index).split("\n").length;

function push(hits: HealthHit[], h: HealthHit) {
  if (hits.length < MAX_HITS) hits.push(h);
}

/** Count every identifier token across the project (comments stripped), for "is this name used anywhere?". */
function identifierCounts(files: HealthFile[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const f of files) {
    const clean = stripComments(f.src, f.lang);
    for (const m of clean.matchAll(/[A-Za-z_$][\w$]*/g)) counts.set(m[0], (counts.get(m[0]) ?? 0) + 1);
  }
  return counts;
}

function normalizeBody(src: string, lang: string, lines: [number, number], name: string): string {
  const body = src.split("\n").slice(lines[0] - 1, lines[1]).join("\n");
  return stripComments(body, lang)
    .replace(new RegExp(`\\b${name.replace(/[$]/g, "\\$")}\\b`, "g"), "_")
    .replace(/\s+/g, " ")
    .trim();
}

/** Strongly connected components of the file import graph (Tarjan). */
function importCycles(fileIds: string[], edges: GraphEdge[]): string[][] {
  const adj = new Map<string, string[]>();
  const set = new Set(fileIds);
  for (const e of edges) if ((e.kind === "imports" || e.kind === "exports") && set.has(e.source) && set.has(e.target) && e.source !== e.target) (adj.get(e.source) ?? adj.set(e.source, []).get(e.source)!).push(e.target);
  let index = 0;
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const out: string[][] = [];
  const strong = (v: string) => {
    idx.set(v, index);
    low.set(v, index++);
    stack.push(v);
    onStack.add(v);
    for (const w of adj.get(v) ?? []) {
      if (!idx.has(w)) {
        strong(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, idx.get(w)!));
    }
    if (low.get(v) === idx.get(v)) {
      const comp: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        comp.push(w);
      } while (w !== v);
      if (comp.length > 1) out.push(comp);
    }
  };
  for (const v of fileIds) if (!idx.has(v)) strong(v);
  return out;
}

/** Python distribution name → import name, for the common mismatches. */
const PY_IMPORT_NAME: Record<string, string> = {
  beautifulsoup4: "bs4", pyyaml: "yaml", "python-dotenv": "dotenv", pillow: "PIL", "scikit-learn": "sklearn",
  "python-jose": "jose", "psycopg2-binary": "psycopg2", "psycopg-binary": "psycopg", pyjwt: "jwt", "python-multipart": "multipart",
  "google-generativeai": "google", "opencv-python": "cv2", "typing-extensions": "typing_extensions", "email-validator": "email_validator",
  "pydantic-settings": "pydantic_settings", "python-dateutil": "dateutil", pymongo: "pymongo", "msgpack-python": "msgpack",
};
/** Packages used from the command line, config, or as plugins rather than imported. */
const TOOLING = /^(@types\/|typescript$|eslint|@eslint\/|prettier|vite$|@vitejs\/|vitest|@vitest\/|jest|@jest\/|ts-jest|tailwindcss|@tailwindcss\/|postcss|autoprefixer|husky|lint-staged|ts-node|tsx$|nodemon|concurrently|turbo$|rimraf|cross-env|npm-run-all|@testing-library\/|playwright|@playwright\/|cypress|webpack|babel|@babel\/|rollup|esbuild|swc|@swc\/|uvicorn|gunicorn|pytest|black$|ruff$|mypy|flake8|isort|coverage|pre-commit|hypercorn|wheel$|setuptools|pip-tools|types-)/i;

/**
 * Direct dependencies only: package.json, and requirements.in / pyproject when present
 * (a compiled requirements.txt also lists every transitive package).
 */
function declaredDeps(root: string, files: HealthFile[], fallback: Record<string, string>): string[] {
  const out = new Set<string>();
  let sawManifest = false;
  for (const f of files) {
    if (path.basename(f.path) !== "package.json" || f.path.includes("node_modules/")) continue;
    try {
      const o = JSON.parse(f.src) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      for (const k of Object.keys({ ...o.dependencies, ...o.devDependencies })) out.add(k);
      sawManifest = true;
    } catch {
      /* not JSON */
    }
  }
  const dirs = new Set(["", ...files.map((f) => path.dirname(f.path)).filter((d) => d !== ".")]);
  let sawPython = false;
  for (const d of dirs) {
    for (const name of ["requirements.in", "pyproject.toml"]) {
      const abs = path.join(root, d, name);
      if (!existsSync(abs)) continue;
      let src = "";
      try {
        src = readFileSync(abs, "utf8");
      } catch {
        continue;
      }
      sawPython = sawManifest = true;
      const lines = name === "pyproject.toml" ? (/dependencies\s*=\s*\[([\s\S]*?)\]/.exec(src)?.[1] ?? "").split(/[,\n]/) : src.split("\n");
      for (const l of lines) {
        const m = /^\s*["']?([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(l.replace(/#.*/, ""));
        if (m && !l.trim().startsWith("-")) out.add(m[1]!);
      }
    }
  }
  if (!sawManifest) return Object.keys(fallback);
  // No .in/pyproject: fall back to the merged list for Python, which may include transitive pins.
  if (!sawPython) for (const f of files) if (/(^|\/)requirements[^/]*\.txt$/.test(f.path)) for (const k of Object.keys(fallback)) out.add(k);
  return [...out];
}

export function buildHealth(input: HealthInput): HealthReport {
  const { root, files, nodes, edges, deps } = input;
  const code = files.filter((f) => CODE_LANGS.has(f.lang) && !GENERATED.test(f.path));
  const prod = code.filter((f) => !f.isTest);
  const checks: HealthCheck[] = [];
  const add = (c: Omit<HealthCheck, "count"> & { count?: number }) => checks.push({ ...c, count: c.count ?? c.hits.length, source: "scanner" });
  const byPath = new Map(nodes.filter((n) => n.path && n.id === `${n.kind}:${n.path}`).map((n) => [n.path!, n]));
  const configText = files.filter((f) => !CODE_LANGS.has(f.lang)).map((f) => f.src).join("\n");

  /* ---------- errors ---------- */
  {
    const hits: HealthHit[] = [];
    let count = 0;
    for (const f of prod) {
      // Raw source on purpose: a block that holds an explanatory comment is a documented choice.
      const clean = f.src;
      const res = JS_LANGS.has(f.lang)
        ? [
            { re: /catch\s*(\([^)]*\))?\s*\{\s*\}/g, d: "empty catch block" },
            { re: /catch\s*\([^)]*\)\s*\{\s*console\.(log|error|warn)\([^;{}]*\);?\s*\}/g, d: "catch only logs to the console" },
            { re: /\.catch\(\s*\(\s*\w*\s*\)\s*=>\s*(\{\s*\}|null|undefined|\[\]|false)\s*\)/g, d: ".catch() discards the error" },
          ]
        : f.lang === "python"
          ? [
              { re: /^[ \t]*except\s*(Exception|BaseException)?\s*(as\s+\w+)?\s*:\s*\n[ \t]*(pass|\.\.\.|continue)\s*$/gm, d: "except block does nothing" },
              { re: /^[ \t]*except\s*:/gm, d: "bare except catches everything, including KeyboardInterrupt" },
            ]
          : [];
      for (const { re, d } of res)
        for (const m of clean.matchAll(re)) {
          count++;
          push(hits, { path: f.path, line: lineOf(clean, m.index ?? 0), detail: d });
        }
    }
    add({ id: "swallowed-errors", title: "Swallowed Errors", category: "errors", severity: "high", hits, count, fix: "Handle the error, rethrow it, or log it with context. A silent catch hides the bug that caused it." });
  }

  /* ---------- leftovers ---------- */
  {
    const hits: HealthHit[] = [];
    let count = 0;
    for (const f of prod) {
      const clean = stripComments(f.src, f.lang);
      const re = JS_LANGS.has(f.lang) ? /\bconsole\.(log|debug)\(|\bdebugger\s*;/g : f.lang === "python" ? /\bbreakpoint\(\)|\bpdb\.set_trace\(\)|\bic\(/g : null;
      if (!re) continue;
      for (const m of clean.matchAll(re)) {
        count++;
        push(hits, { path: f.path, line: lineOf(clean, m.index ?? 0), detail: m[0].replace(/\($/, "()") });
      }
    }
    add({ id: "debug-leftovers", title: "Debug Leftovers", category: "leftovers", severity: "medium", hits, count, fix: "Remove console.log/debugger/breakpoint() calls, or route them through a logger with levels." });
  }
  {
    const hits: HealthHit[] = [];
    let count = 0;
    const MARKER = /\b(TODO|FIXME|HACK|XXX)\b[:\s]*(.{0,80})/;
    // Phrases models leave in code that ships: stand-ins described as temporary.
    const STUB = /\b(in a real (app|application|implementation|project|world)|for demo purposes|for now,? (we|just|this)|placeholder (implementation|logic|value|data)|mock implementation|simplified (version|implementation)|implement (this|me) later|your (code|logic) here|not (yet )?implemented|replace (this|with (a |the )?real))\b/i;
    const NOT_IMPL = /raise\s+NotImplementedError|throw\s+new\s+Error\(\s*["'`](not implemented|todo|unimplemented)/i;
    for (const f of prod) {
      f.src.split("\n").forEach((l, i) => {
        const m = MARKER.exec(l) ?? STUB.exec(l) ?? NOT_IMPL.exec(l);
        if (!m) return;
        count++;
        push(hits, { path: f.path, line: i + 1, detail: l.trim().slice(0, 120) });
      });
    }
    add({ id: "stubs", title: "TODOs and Stubs", category: "leftovers", severity: "medium", hits, count, fix: "Finish or delete each one. \"For now\" and \"in a real app\" comments mark code that was never replaced." });
  }
  {
    const hits: HealthHit[] = [];
    let count = 0;
    const RE = /\b(mock|fake|dummy|sample|hardcoded|hard_coded)_?(data|users?|items?|response|results?|products?|orders?|records|rows)\b|\bMOCK_[A-Z_]+\b/i;
    for (const f of prod) {
      if (/(^|\/)(fixtures?|mocks?|__mocks__|seed|seeds|stories|storybook)\//i.test(f.path) || /\.(stories|fixture)\./.test(f.path)) continue;
      const clean = stripComments(f.src, f.lang);
      clean.split("\n").forEach((l, i) => {
        const m = RE.exec(l);
        if (!m) return;
        count++;
        push(hits, { path: f.path, line: i + 1, detail: `"${m[0]}"` });
      });
    }
    add({ id: "mock-data", title: "Mock Data in App Code", category: "leftovers", severity: "medium", hits, count, fix: "Move sample data to fixtures or tests, or label it clearly if it's an intentional fallback." });
  }

  /* ---------- types ---------- */
  {
    const hits: HealthHit[] = [];
    let count = 0;
    for (const f of prod) {
      const lines = f.src.split("\n");
      lines.forEach((l, i) => {
        const found: string[] = [];
        if (JS_LANGS.has(f.lang)) {
          if (/@ts-(ignore|nocheck)/.test(l)) found.push(l.includes("nocheck") ? "@ts-nocheck" : "@ts-ignore");
          if (/eslint-disable(?!-next-line\s+\S)/.test(l) && !/eslint-disable-next-line\s+\S/.test(l)) found.push("eslint-disable (all rules)");
          if (/(:\s*any\b|\bas\s+any\b|<any>)/.test(l.replace(/\/\/.*$/, ""))) found.push("any");
        } else if (f.lang === "python") {
          if (/#\s*type:\s*ignore(?!\[)/.test(l)) found.push("# type: ignore (no error code)");
          if (/#\s*noqa\s*$/.test(l)) found.push("# noqa (all rules)");
        }
        for (const d of found) {
          count++;
          push(hits, { path: f.path, line: i + 1, detail: d });
        }
      });
    }
    add({ id: "type-escapes", title: "Type and Lint Escapes", category: "types", severity: "low", hits, count, fix: "Replace `any` with a real type and give each ignore a specific rule or error code." });
  }

  /* ---------- duplication ---------- */
  {
    const groups = new Map<string, Array<{ path: string; line: number; name: string; len: number }>>();
    for (const f of prod)
      for (const s of f.symbols) {
        if (s.kind !== "function") continue;
        const len = s.lines[1] - s.lines[0] + 1;
        if (len < 6) continue;
        const norm = normalizeBody(f.src, f.lang, s.lines, s.name);
        if (norm.length < 120) continue;
        const h = createHash("sha1").update(norm).digest("hex");
        (groups.get(h) ?? groups.set(h, []).get(h)!).push({ path: f.path, line: s.lines[0], name: s.name, len });
      }
    const hits: HealthHit[] = [];
    let count = 0;
    for (const g of [...groups.values()].filter((g) => g.length > 1).sort((a, b) => b[0]!.len * b.length - a[0]!.len * a.length)) {
      count += g.length - 1;
      for (const x of g) push(hits, { path: x.path, line: x.line, detail: `${x.name}: same ${x.len}-line body in ${g.length} places` });
    }
    add({ id: "duplicates", title: "Copy-Pasted Functions", category: "duplication", severity: "medium", hits, count, fix: "Keep one copy and import it. Duplicates drift apart when only one gets fixed." });
  }
  {
    const hits: HealthHit[] = [];
    const RE = /(^|[_\-. ])(v\d+|new|old|copy|backup|bak|final|orig|temp|tmp|fixed|updated|improved|enhanced|refactored|working|clean|simple|alt)(?=\.[a-z0-9]+$|[_\-. ])|\s\(\d+\)\.[a-z]+$/i;
    for (const f of code) if (RE.test(path.basename(f.path)) && !/(^|\/)migrations?\//.test(f.path)) push(hits, { path: f.path, detail: "file name suggests a second version of something" });
    add({ id: "version-files", title: "Duplicate Version Files", category: "duplication", severity: "medium", hits, fix: "Merge into the original and delete the extra copy. Git already keeps history." });
  }

  /* ---------- dead code ---------- */
  const ids = identifierCounts(code);
  {
    const importedFiles = new Set(edges.filter((e) => e.kind === "imports" || e.kind === "exports" || e.kind === "routes").map((e) => e.target));
    const hits: HealthHit[] = [];
    for (const f of prod) {
      if (!JS_LANGS.has(f.lang) && f.lang !== "python") continue;
      const n = byPath.get(f.path);
      if (!n || importedFiles.has(n.id) || ENTRY_RE.test(f.path) || FRAMEWORK_ROUTE_DIR.test(f.path) || n.tags.includes("has-routes")) continue;
      const base = path.basename(f.path);
      const stem = base.replace(/\.[^.]+$/, "");
      if (configText.includes(base) || configText.includes(f.path) || (ids.get(stem) ?? 0) > 0) continue;
      push(hits, { path: f.path, detail: "nothing imports or runs this file" });
    }
    add({ id: "dead-files", title: "Unused Files", category: "dead-code", severity: "medium", hits, fix: "Delete it, or wire it in. Unused files still get read, reviewed, and scanned." });
  }
  {
    const hits: HealthHit[] = [];
    let count = 0;
    for (const f of prod) {
      if (FRAMEWORK_ROUTE_DIR.test(f.path)) continue;
      for (const s of f.symbols) {
        if (s.kind !== "function" || s.owner || s.decorators.length || CONVENTION_NAMES.has(s.name) || s.name.startsWith("__") || /^(test|use[A-Z])/.test(s.name)) continue;
        if ((ids.get(s.name) ?? 0) > 1) continue; // referenced somewhere besides its own definition
        count++;
        push(hits, { path: f.path, line: s.lines[0], detail: `${s.name}() is never called or referenced` });
      }
    }
    add({ id: "dead-functions", title: "Unused Functions", category: "dead-code", severity: "low", hits, count, fix: "Delete functions nothing calls. Keep them out of the codebase rather than commented or parked." });
  }

  /* ---------- structure ---------- */
  {
    const hits: HealthHit[] = [];
    let count = 0;
    for (const f of prod)
      for (const s of f.symbols) {
        const len = s.lines[1] - s.lines[0] + 1;
        if (s.kind !== "function" || len <= 80) continue;
        count++;
        push(hits, { path: f.path, line: s.lines[0], detail: `${s.name}() is ${len} lines` });
      }
    const big = prod.map((f) => ({ f, loc: f.src.split("\n").length })).filter((x) => x.loc > 800).sort((a, b) => b.loc - a.loc);
    for (const x of big) {
      count++;
      push(hits, { path: x.f.path, detail: `${x.loc}-line file` });
    }
    add({ id: "oversized", title: "Oversized Functions and Files", category: "structure", severity: "low", hits, count, fix: "Split by responsibility: functions over ~80 lines and files over ~800 are hard to review and test." });
  }
  {
    const fileIds = prod.map((f) => byPath.get(f.path)?.id).filter((x): x is string => !!x);
    const cycles = importCycles(fileIds, edges);
    const nameOf = (id: string) => id.replace(/^[a-z]+:/, "");
    const hits = cycles.slice(0, MAX_HITS).map((c) => ({ path: nameOf(c[0]!), detail: `import cycle: ${c.map(nameOf).join(" → ")} → ${nameOf(c[0]!)}` }));
    add({ id: "import-cycles", title: "Circular Imports", category: "structure", severity: "medium", hits, count: cycles.length, fix: "Move the shared piece into its own module that both sides import." });
  }
  {
    const fanIn = new Map<string, number>();
    for (const e of edges) if (e.kind === "imports" || e.kind === "calls") fanIn.set(e.target, (fanIn.get(e.target) ?? 0) + 1);
    const hot = prod
      .map((f) => byPath.get(f.path))
      .filter((n): n is GraphNode => !!n && n.complexity === "complex" && (fanIn.get(n.id) ?? 0) >= 3)
      .sort((a, b) => (fanIn.get(b.id) ?? 0) - (fanIn.get(a.id) ?? 0));
    add({ id: "hotspots", title: "Complex and Widely Used", category: "structure", severity: "medium", hits: hot.slice(0, MAX_HITS).map((n) => ({ path: n.path!, detail: `complex, used by ${fanIn.get(n.id)} other places` })), count: hot.length, fix: "These break the most things when they're wrong. Give them tests first, then simplify." });
  }

  /* ---------- tests ---------- */
  {
    const tests = code.filter((f) => f.isTest);
    const tested = new Set(edges.filter((e) => e.kind === "tested_by").map((e) => e.source));
    const hits: HealthHit[] = [];
    let count = 0;
    if (!tests.length && prod.length) {
      count = prod.length;
      hits.push({ path: ".", detail: `no test files for ${prod.length} source files` });
    } else {
      const fanIn = new Map<string, number>();
      for (const e of edges) if (e.kind === "imports") fanIn.set(e.target, (fanIn.get(e.target) ?? 0) + 1);
      const untested = prod
        .map((f) => byPath.get(f.path))
        .filter((n): n is GraphNode => !!n && n.kind === "file" && !tested.has(n.id) && !/\.(tsx|jsx|vue|svelte)$/.test(n.path!) && !ENTRY_RE.test(n.path!) && (n.metrics?.loc ?? 0) > 30)
        .sort((a, b) => (fanIn.get(b.id) ?? 0) - (fanIn.get(a.id) ?? 0));
      count = untested.length;
      for (const n of untested) push(hits, { path: n.path!, detail: `no test imports or targets this file${fanIn.get(n.id) ? ` (used by ${fanIn.get(n.id)})` : ""}` });
    }
    add({ id: "untested", title: "Untested Files", category: "tests", severity: tests.length ? "medium" : "high", hits, count, fix: "Start with the most-used files at the top of this list." });
  }

  /* ---------- dependencies ---------- */
  {
    const used = new Set<string>();
    for (const f of code)
      for (const imp of f.imports) {
        const s = imp.source;
        if (!s || s.startsWith(".") || s.startsWith("/")) continue;
        if (JS_LANGS.has(f.lang)) used.add(s.startsWith("@") ? s.split("/").slice(0, 2).join("/") : s.replace(/^node:/, "").split("/")[0]!);
        else if (f.lang === "python") used.add(s.split(".")[0]!.toLowerCase());
      }
    const hits: HealthHit[] = [];
    for (const name of declaredDeps(root, files, deps)) {
      if (TOOLING.test(name) || configText.match(new RegExp(`["'\\s/]${name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}["'\\s@/]`, "g"))?.length! > 1) continue;
      const jsHit = used.has(name);
      const py = (PY_IMPORT_NAME[name.toLowerCase()] ?? name).toLowerCase().replace(/-/g, "_").replace(/\[.*$/, "");
      const pyHit = used.has(py) || used.has(py.split("_")[0]!);
      if (jsHit || pyHit) continue;
      push(hits, { path: "", detail: `${name} is declared but never imported` });
    }
    add({ id: "unused-deps", title: "Possibly Unused Dependencies", category: "dependencies", severity: "low", hits, fix: "Remove packages nothing imports. Each one adds install time and supply-chain risk." });
  }

  /* ---------- docs ---------- */
  {
    // Working notes models leave behind: summaries of a session, plans, fix logs, status reports.
    const ARTIFACT = /(^|[_\-. ])(summary|implementation|plan|planning|fixes|fixed|changes|changelog[_-]\w+|notes|progress|status|report|complete|completed|done|todo|migration|refactor|refactoring|analysis|assessment|review|findings|instructions|prompt|context|scratch|draft|wip|v\d+|old|new|final|backup)(?=[_\-. ]|$)/i;
    const STANDARD = /^(readme|license|licence|changelog|contributing|security|code_of_conduct|claude|agents|gemini|copilot-instructions|support|authors|notice|setup|install|architecture|onboarding)\.md$/i;
    const OWN_REPORTS = new Set(["SECURITY_AUDIT.md", "CODE_REVIEW.md"]);
    const allText = files.map((f) => f.src).join("\n");
    const hits: HealthHit[] = [];
    for (const f of files) {
      if (!/\.(md|mdx|markdown)$/i.test(f.path) || GENERATED.test(f.path)) continue;
      const base = path.basename(f.path);
      if (OWN_REPORTS.has(base) || /(^|\/)(node_modules|\.github|\.claude|skills|agents|\.changeset)\//.test(f.path)) continue;
      const reasons: string[] = [];
      if (!STANDARD.test(base) && ARTIFACT.test(base.replace(/\.(md|mdx|markdown)$/i, ""))) reasons.push("named like a one-off working note");
      // Code paths the doc mentions that aren't in the repo anymore.
      const refs = new Set<string>();
      for (const m of f.src.matchAll(/`([\w@./-]+\/[\w@.-]+\.[a-z]{1,5})(?::\d+(?:-\d+)?)?`/g)) refs.add(m[1]!);
      const missing = [...refs].filter((r) => !existsSync(path.join(root, r)) && !existsSync(path.join(root, path.dirname(f.path), r)));
      if (missing.length >= 2 && missing.length / refs.size >= 0.3) reasons.push(`mentions ${missing.length} files that no longer exist (${missing.slice(0, 3).join(", ")}${missing.length > 3 ? ", …" : ""})`);
      if (!reasons.length) continue;
      const linked = allText.split(base).length - 1 > (f.src.split(base).length - 1);
      if (!linked) reasons.push("nothing links to it");
      push(hits, { path: f.path, detail: reasons.join("; ") });
    }
    add({ id: "stale-docs", title: "Stale Docs", category: "docs", severity: "low", hits, fix: "Delete notes that described one session's work, or fold what's still true into the README or docs/." });
  }

  return { generatedAt: new Date().toISOString(), score: healthScore(checks.map((c) => ({ severity: c.severity, open: c.count }))), checks };
}
