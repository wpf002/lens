/**
 * Layout checks: how files are placed and named, judged against widely used
 * conventions (feature folders, one file-naming style, a short set of root docs,
 * tests named for the unit they cover). Deterministic, no LLM.
 */
import path from "node:path";
import type { HealthCheck, HealthHit, HealthReport } from "./health.js";
import { healthScore } from "./score.js";
import { GENERATED, push } from "./shared.js";

export interface LayoutFile {
  path: string;
  /** FileCategory from languages.ts. */
  category: string;
}

export interface LayoutInput {
  files: LayoutFile[];
  /** Most files one folder may hold directly. */
  maxFolderFiles?: number;
}

/** No standard sets this; 20 keeps a folder listing readable on one screen. Owners change it in .lens/architecture.json. */
export const DEFAULT_MAX_FOLDER_FILES = 20;

/** Categories that count toward a crowded folder. Assets and data are left out. */
const COUNTED_CATEGORIES = new Set(["code", "test", "docs"]);

/** Folders that hold a numbered or generated series by design. */
const SERIES_FOLDER = /(^|\/)(migrations?|alembic|versions|fixtures?|__snapshots__|__fixtures__|snapshots|adr|decisions|public|assets|static|icons|images|locales?|i18n|generated|seeds?)(\/|$)/i;

/** Root docs every reviewer expects, plus the files AI coding tools read. */
const STANDARD_ROOT_DOCS = new Set([
  "readme", "contributing", "changelog", "security", "license", "licence", "code_of_conduct", "code-of-conduct",
  "support", "authors", "notice", "governance", "agents", "claude", "gemini", "copilot-instructions",
]);

/** Doc names that are expected in many folders. */
const REPEATABLE_DOCS = new Set(["readme", "index", "skill", "changelog", "agents", "claude", "license"]);

/** File names frameworks require, whatever the repo's naming style. */
const FRAMEWORK_NAMES = new Set([
  "page", "layout", "route", "loading", "error", "not-found", "template", "default", "global-error", "middleware",
  "instrumentation", "opengraph-image", "twitter-image", "sitemap", "robots", "manifest", "icon", "apple-icon",
  "__init__", "__main__", "conftest", "setup", "manage", "wsgi", "asgi", "vite-env",
]);

const COMPONENT_EXT = new Set([".tsx", ".jsx", ".vue", ".svelte"]);
const DOC_EXT = new Set([".md", ".mdx", ".txt", ".rst"]);

/** Characters that break shells, URLs or other operating systems. Brackets, parens and @ are Next.js route syntax. */
const SAFE_NAME = /^[A-Za-z0-9._@()[\]+-]+$/;

/** Test names that describe a bug report instead of the unit under test. */
const BUG_NAMED_TEST = /(^|[-_.])(bug|bugs|fix|fixes|hotfix|issue|issues|regression|repro|patch|ticket)([-_.\d]|$)/i;

export type NamingStyle = "kebab-case" | "snake_case" | "camelCase" | "PascalCase" | "lowercase" | "other";

/** The part of a file name before its first dot, so `user.service.ts` and `foo.test.ts` name `user` and `foo`. */
export function fileStem(filePath: string): string {
  return path.posix.basename(filePath).split(".")[0] ?? "";
}

export function namingStyle(stem: string): NamingStyle {
  if (/^[a-z][a-z0-9]*$/.test(stem)) return "lowercase";
  if (/^[a-z][a-z0-9]*(-[a-z0-9]+)+$/.test(stem)) return "kebab-case";
  if (/^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(stem)) return "snake_case";
  if (/^[a-z][a-z0-9]*([A-Z][a-z0-9]*)+$/.test(stem)) return "camelCase";
  if (/^[A-Z][a-z0-9]*([A-Z][a-z0-9]*)*$/.test(stem)) return "PascalCase";
  return "other";
}

const dirOf = (p: string) => path.posix.dirname(p);
const extOf = (p: string) => path.posix.extname(p).toLowerCase();
const counted = (files: LayoutFile[]) => files.filter((f) => !GENERATED.test(f.path));

function byFolder(files: LayoutFile[]): Map<string, LayoutFile[]> {
  const folders = new Map<string, LayoutFile[]>();
  for (const f of files) {
    const dir = dirOf(f.path);
    (folders.get(dir) ?? folders.set(dir, []).get(dir)!).push(f);
  }
  return folders;
}

function check(id: string, title: string, severity: HealthCheck["severity"], hits: HealthHit[], count: number, fix: string): HealthCheck {
  return { id, title, category: "structure", severity, count, hits, fix, source: "scanner" };
}

function crowdedFolders(folders: Map<string, LayoutFile[]>, max: number): HealthCheck {
  const crowded = [...folders]
    .filter(([dir]) => !SERIES_FOLDER.test(dir))
    .map(([dir, files]) => ({ dir, n: files.filter((f) => COUNTED_CATEGORIES.has(f.category)).length }))
    .filter((f) => f.n > max)
    .sort((a, b) => b.n - a.n);
  const hits: HealthHit[] = [];
  for (const f of crowded) push(hits, { path: f.dir === "." ? "/" : f.dir, detail: `${f.n} files directly in this folder (limit ${max})` });
  return check("crowded-folder", "Crowded Folders", "medium", hits, crowded.length,
    "Group the files into one subfolder per feature or domain (routes, logic and data for that feature together). Shared helpers go in lib/ or shared/ only once two features use them.");
}

/** Style groups compared inside one folder: React/Vue components may differ from plain modules. */
function styleGroup(file: string): "component" | "module" {
  return COMPONENT_EXT.has(extOf(file)) ? "component" : "module";
}

function mixedNaming(folders: Map<string, LayoutFile[]>): HealthCheck {
  const hits: HealthHit[] = [];
  let count = 0;
  for (const [dir, files] of folders) {
    const groups = new Map<string, Map<NamingStyle, string[]>>();
    for (const f of files) {
      if (f.category !== "code" && f.category !== "test") continue;
      const stem = fileStem(f.path);
      const style = namingStyle(stem);
      if (style === "lowercase" || style === "other" || FRAMEWORK_NAMES.has(stem) || stem.startsWith("[") || stem.startsWith("(")) continue;
      const group = groups.get(styleGroup(f.path)) ?? groups.set(styleGroup(f.path), new Map()).get(styleGroup(f.path))!;
      (group.get(style) ?? group.set(style, []).get(style)!).push(path.posix.basename(f.path));
    }
    for (const styles of groups.values()) {
      if (styles.size < 2) continue;
      count++;
      const parts = [...styles].sort((a, b) => b[1].length - a[1].length).map(([style, names]) => `${style} ${names.length} (${names[0]})`);
      push(hits, { path: dir === "." ? "/" : dir, detail: parts.join(", ") });
    }
  }
  return check("mixed-file-naming", "Mixed File Naming", "low", hits, count,
    "Rename the files in this folder to the style most of them already use. TypeScript and JavaScript modules use kebab-case, React components may use PascalCase, Python uses snake_case. Update every import.");
}

function packageRoots(files: LayoutFile[]): Set<string> {
  const roots = new Set<string>(["."]);
  for (const f of files) if (/(^|\/)(package\.json|pyproject\.toml|go\.mod|Cargo\.toml)$/.test(f.path)) roots.add(dirOf(f.path));
  return roots;
}

function strayRootDocs(files: LayoutFile[]): HealthCheck {
  const roots = packageRoots(files);
  const hits: HealthHit[] = [];
  let count = 0;
  for (const f of files) {
    if (!DOC_EXT.has(extOf(f.path)) || !roots.has(dirOf(f.path))) continue;
    if (STANDARD_ROOT_DOCS.has(fileStem(f.path).toLowerCase())) continue;
    count++;
    push(hits, { path: f.path, detail: "not a standard root doc" });
  }
  return check("stray-root-docs", "Stray Root Docs", "low", hits, count,
    "Keep only README, CONTRIBUTING, CHANGELOG, SECURITY and LICENSE at a package root. Move guides into docs/, decisions into docs/adr/, and delete notes, plans and status reports that no longer describe the code.");
}

function duplicateDocs(files: LayoutFile[]): HealthCheck {
  const byName = new Map<string, string[]>();
  for (const f of files) {
    if (!DOC_EXT.has(extOf(f.path))) continue;
    const name = fileStem(f.path).toLowerCase();
    if (REPEATABLE_DOCS.has(name)) continue;
    (byName.get(name) ?? byName.set(name, []).get(name)!).push(f.path);
  }
  const hits: HealthHit[] = [];
  let count = 0;
  for (const [, paths] of byName) {
    if (paths.length < 2) continue;
    count++;
    push(hits, { path: paths[0]!, detail: `same doc name also at ${paths.slice(1, 4).join(", ")}${paths.length > 4 ? ` and ${paths.length - 4} more` : ""}` });
  }
  return check("duplicate-docs", "Duplicate Docs", "low", hits, count,
    "Merge the copies into one doc in docs/ and delete the rest, or rename them if they cover different things.");
}

function unsafeNames(files: LayoutFile[]): HealthCheck {
  const hits: HealthHit[] = [];
  let count = 0;
  for (const f of files) {
    const bad = f.path.split("/").find((part) => !SAFE_NAME.test(part));
    if (!bad) continue;
    count++;
    push(hits, { path: f.path, detail: `"${bad}" has spaces or non-ASCII characters` });
  }
  return check("unsafe-file-names", "Unsafe File Names", "medium", hits, count,
    "Rename to lowercase ASCII letters, digits and hyphens, and update every reference.");
}

function bugNamedTests(files: LayoutFile[]): HealthCheck {
  const hits: HealthHit[] = [];
  let count = 0;
  for (const f of files) {
    if (f.category !== "test" || !BUG_NAMED_TEST.test(fileStem(f.path))) continue;
    count++;
    push(hits, { path: f.path, detail: "named after a bug, not the code it tests" });
  }
  return check("bug-named-tests", "Tests Named After Bugs", "low", hits, count,
    "Move each test case into the test file for the module it covers (foo.ts → foo.test.ts, next to it) and delete the per-bug file.");
}

export function buildLayout(input: LayoutInput): HealthReport {
  const files = counted(input.files);
  const folders = byFolder(files);
  const checks = [
    crowdedFolders(folders, input.maxFolderFiles ?? DEFAULT_MAX_FOLDER_FILES),
    mixedNaming(folders),
    strayRootDocs(files),
    duplicateDocs(files),
    unsafeNames(files),
    bugNamedTests(files),
  ].filter((c) => c.count > 0);
  return { generatedAt: new Date().toISOString(), score: healthScore(checks.map((c) => ({ severity: c.severity, open: c.count }))), checks };
}
