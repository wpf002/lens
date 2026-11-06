/**
 * Coding standards a scanner can judge without guessing: magic numbers in
 * business logic, placeholder names, mixed naming styles in one module, and a
 * project with no linter or formatter. Each check prefers missing a case to
 * flagging a good one.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { stripComments } from "../security/analyze.js";
import type { HealthCheck, HealthFile, HealthHit } from "./health.js";
import { JS_LANGS, blankStrings, push } from "./shared.js";

type Check = Omit<HealthCheck, "source">;

export interface StandardsInput {
  root: string;
  /** Non-test source files, generated code already removed. */
  prod: HealthFile[];
  /** Every scanned file, for manifests and tool configs. */
  files: HealthFile[];
  layerOf: (filePath: string) => string | undefined;
  /** Declared dependency names (package.json, requirements, pyproject). */
  deps: string[];
}

export function buildStandardsChecks(input: StandardsInput): Check[] {
  return [magicNumbers(input), vagueNames(input), mixedNaming(input), missingTooling(input)];
}

/* ---------- magic numbers ---------- */

/** Layers where a bare number usually encodes a business rule. UI numbers are mostly sizes and styling. */
const BUSINESS_LAYERS = new Set(["service", "data", "api"]);
/** Numbers whose meaning is plain at the use site: identities, halves, decimal and time units. */
const PLAIN_NUMBERS = new Set(["0", "1", "2", "10", "100", "1000", "60", "24", "7", "12", "365", "3600", "1024", "86400", "0.5"]);
const CONSTANT_FILE = /(^|\/)(constants?|config|configs|settings|migrations?|alembic|seeds?|fixtures?)(\/|\.|_|$)/i;
const NAMED_CONSTANT_LINE = /^\s*(export\s+)?(const|let|var|final|static|readonly|public|private)?\s*[A-Z][A-Z0-9_]*\s*(:[^=]+)?=/;
const STATUS_CONTEXT = /status|code/i;
const NUMBER = String.raw`\d[\d_]*(?:\.\d+)?`;
const MAGIC_PATTERNS = [
  new RegExp(String.raw`(?<![=!<>-])(?:[<>]=?|[!=]==?)\s*-?(${NUMBER})(?![\w.])`, "g"),
  new RegExp(String.raw`(?<![\w.$])(${NUMBER})\s*(?:[<>]=?|[!=]==?)(?![=>])`, "g"),
  new RegExp(String.raw`(?<![*/])[*/](?![*/=])\s*(${NUMBER})(?![\w.])`, "g"),
  new RegExp(String.raw`(?<![\w.$])(${NUMBER})\s*[*/](?![*/=])`, "g"),
];
/** Factors that turn a count into a duration or size: `5 * 60_000` reads as five minutes, `6 / 12` as half a year. */
const UNIT_FACTORS = new Set(["7", "12", "24", "60", "365", "1000", "1024", "3600", "86400", "60000", "3600000"]);
const LITERAL_PRODUCT = new RegExp(String.raw`(?<![\w.$])${NUMBER}(?:\s*[*/]\s*${NUMBER})+(?![\w.])`, "g");
/** A JS regex literal: a slash after an operator, bracket, or keyword, so division isn't caught. */
const REGEX_LITERAL = /(?<=(?:^|[(,=:[!&|?{};+\-*%<>~^]|\breturn|\btypeof)\s*)\/(?![/*])(?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^/\\\n[])+\/[dgimsuvy]*/gm;

/** `100_000` → `100000`, `100.0` → `100`, so spelling doesn't change the verdict. */
const normalize = (literal: string) => literal.replace(/_/g, "").replace(/\.0+$/, "");

function isPlainNumber(literal: string, line: string): boolean {
  const value = normalize(literal);
  if (PLAIN_NUMBERS.has(value)) return true;
  return /^[1-5]\d\d$/.test(value) && STATUS_CONTEXT.test(line);
}

/** Blank products of literals that include a unit factor, so only the remaining numbers are judged. */
function blankUnitProducts(line: string): string {
  return line.replace(LITERAL_PRODUCT, (m) => (m.split(/[*/]/).some((factor) => UNIT_FACTORS.has(normalize(factor.trim()))) ? " ".repeat(m.length) : m));
}

export function magicNumbersInLine(line: string): string[] {
  if (NAMED_CONSTANT_LINE.test(line)) return [];
  const judged = blankUnitProducts(line);
  const found = new Set<string>();
  for (const re of MAGIC_PATTERNS) for (const m of judged.matchAll(re)) if (!isPlainNumber(m[1]!, line)) found.add(m[1]!);
  return [...found];
}

/** Python triple-quoted strings and JS template literals can span lines; blank them keeping line breaks. */
const PYTHON_TRIPLE_QUOTED = /"""[\s\S]*?"""|'''[\s\S]*?'''/g;
const JS_TEMPLATE_LITERAL = /`(?:\\[\s\S]|[^`\\])*`/g;

function blankMultilineStrings(src: string, lang: string): string {
  const re = lang === "python" ? PYTHON_TRIPLE_QUOTED : JS_LANGS.has(lang) ? JS_TEMPLATE_LITERAL : undefined;
  return re ? src.replace(re, (m) => m.replace(/[^\n]/g, " ")) : src;
}

/** Code with comments, strings, and (in JS) regex literals blanked; line breaks kept. */
function codeOnly(f: HealthFile): string {
  const clean = blankStrings(blankMultilineStrings(stripComments(f.src, f.lang), f.lang));
  return JS_LANGS.has(f.lang) ? clean.replace(REGEX_LITERAL, (m) => " ".repeat(m.length)) : clean;
}

function magicNumbers({ prod, layerOf }: StandardsInput): Check {
  const hits: HealthHit[] = [];
  let count = 0;
  for (const f of prod) {
    if ((!JS_LANGS.has(f.lang) && f.lang !== "python") || CONSTANT_FILE.test(f.path) || !BUSINESS_LAYERS.has(layerOf(f.path) ?? "")) continue;
    const original = f.src.split("\n");
    codeOnly(f).split("\n").forEach((line, i) => {
      const numbers = magicNumbersInLine(line);
      if (!numbers.length) return;
      count++;
      push(hits, { path: f.path, line: i + 1, detail: `${numbers.join(", ")} in \`${original[i]!.trim().slice(0, 80)}\`` });
    });
  }
  return {
    id: "magic-numbers",
    title: "Magic Numbers",
    category: "standards",
    severity: "low",
    hits,
    count,
    fix: "Give each number a named constant that says what it is (MAX_LOGIN_ATTEMPTS, TAX_RATE) next to the code that uses it, or in the module's existing constants file.",
  };
}

/* ---------- vague names ---------- */

const VAGUE_EXACT = new Set([
  "tmp", "foo", "baz", "qux", "quux", "stuff", "thing", "things", "thingy", "misc", "blah", "asdf", "whatever",
  "myVar", "myFunc", "myFunction", "myData", "doStuff", "doIt", "doSomething", "doThings", "handleIt", "handleStuff", "handleThings", "handleSomething", "processStuff",
]);
const VAGUE_NUMBERED = /^(data|result|res|resp|response|obj|object|item|val|value|tmp|temp|arr|array|list|str|string|num|info|output|out|thing|stuff|var|func|fn|helper)\d+$/i;
const VAGUE_VERB_NOUN = /^(handle|do|process|manage|run)(Stuff|Things?|It|Something|Everything|Misc)$/;
const IDENT = /^[A-Za-z_$][\w$]*$/;

export function isVagueName(raw: string): boolean {
  const name = raw.replace(/^[_$]+/, "");
  return VAGUE_EXACT.has(name) || VAGUE_NUMBERED.test(name) || VAGUE_VERB_NOUN.test(name);
}

/** Names a file declares: functions, their parameters, and variables, each with its first line. */
function declaredNames(f: HealthFile): Array<{ name: string; line: number }> {
  const out: Array<{ name: string; line: number }> = [];
  for (const s of f.symbols) {
    if (s.kind !== "function") continue;
    out.push({ name: s.name, line: s.lines[0] });
    for (const p of s.params) if (IDENT.test(p)) out.push({ name: p, line: s.lines[0] });
  }
  const decl = JS_LANGS.has(f.lang) ? /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[=:;]/g : /^[ \t]*([A-Za-z_]\w*)[ \t]*(?::[^=\n]+)?=(?!=)|\bfor[ \t]+([A-Za-z_]\w*)[ \t]+in\b/gm;
  const clean = blankStrings(stripComments(f.src, f.lang));
  for (const m of clean.matchAll(decl)) out.push({ name: (m[1] ?? m[2])!, line: clean.slice(0, m.index).split("\n").length });
  return out;
}

function vagueNames({ prod }: StandardsInput): Check {
  const hits: HealthHit[] = [];
  let count = 0;
  for (const f of prod) {
    if (!JS_LANGS.has(f.lang) && f.lang !== "python") continue;
    const reported = new Set<string>();
    for (const { name, line } of declaredNames(f).sort((a, b) => a.line - b.line)) {
      if (reported.has(name) || !isVagueName(name)) continue;
      reported.add(name);
      count++;
      push(hits, { path: f.path, line, detail: `\`${name}\` doesn't say what it holds or does` });
    }
  }
  return {
    id: "vague-names",
    title: "Vague Names",
    category: "standards",
    severity: "low",
    hits,
    count,
    fix: "Rename it after what the value holds or what the function does (pendingInvoices, retryFailedUpload) and update every reference.",
  };
}

/* ---------- mixed naming ---------- */

type NameStyle = "camelCase" | "snake_case";
const CAMEL = /^[a-z][a-z0-9]*([A-Z][a-z0-9]*)+$/;
const SNAKE = /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/;
/** Fewer classified names than this and there's no house style to break. */
const MIN_NAMED_FUNCTIONS = 3;

export function nameStyle(raw: string): NameStyle | undefined {
  const name = raw.replace(/^[_$]+/, "");
  return CAMEL.test(name) ? "camelCase" : SNAKE.test(name) ? "snake_case" : undefined;
}

function minorityStyle(lang: string, camel: number, snake: number): NameStyle {
  if (camel !== snake) return camel < snake ? "camelCase" : "snake_case";
  return lang === "python" ? "camelCase" : "snake_case";
}

function mixedNaming({ prod }: StandardsInput): Check {
  const hits: HealthHit[] = [];
  let count = 0;
  for (const f of prod) {
    if (!JS_LANGS.has(f.lang) && f.lang !== "python") continue;
    const named = f.symbols.filter((s) => s.kind === "function" && !s.name.startsWith("__")).map((s) => ({ s, style: nameStyle(s.name) })).filter((x) => x.style);
    const camel = named.filter((x) => x.style === "camelCase").length;
    const snake = named.length - camel;
    if (!camel || !snake || named.length < MIN_NAMED_FUNCTIONS) continue;
    const minority = minorityStyle(f.lang, camel, snake);
    const majority: NameStyle = minority === "camelCase" ? "snake_case" : "camelCase";
    const majorityCount = minority === "camelCase" ? snake : camel;
    for (const { s } of named.filter((x) => x.style === minority)) {
      count++;
      push(hits, { path: f.path, line: s.lines[0], detail: `${s.name} is ${minority}; ${majorityCount} other functions here are ${majority}` });
    }
  }
  return {
    id: "mixed-naming",
    title: "Mixed Naming Styles",
    category: "standards",
    severity: "low",
    hits,
    count,
    fix: "Rename to the style the rest of the module uses (camelCase in JS/TS, snake_case in Python) and update every caller.",
  };
}

/* ---------- linter and formatter ---------- */

/** Below this many files of a language, a missing linter isn't worth a row. */
const MIN_FILES_FOR_TOOLING = 5;

interface ToolingSpec {
  label: string;
  langs: (lang: string) => boolean;
  manifests: RegExp;
  linterFiles: string[];
  formatterFiles: string[];
  /** Tools that work with no config file, so the dependency alone counts. */
  linterDeps: RegExp;
  formatterDeps: RegExp;
  /** Sections inside shared config files (pyproject, setup.cfg) that configure a tool. */
  linterSections: RegExp;
  formatterSections: RegExp;
  linterHint: string;
  formatterHint: string;
}

const TOOLING: ToolingSpec[] = [
  {
    label: "JavaScript/TypeScript",
    langs: (l) => JS_LANGS.has(l),
    manifests: /(^|\/)package\.json$/,
    linterFiles: ["eslint.config.js", "eslint.config.mjs", "eslint.config.cjs", "eslint.config.ts", "eslint.config.mts", ".eslintrc", ".eslintrc.js", ".eslintrc.cjs", ".eslintrc.json", ".eslintrc.yml", ".eslintrc.yaml", "biome.json", "biome.jsonc", ".oxlintrc.json", "deno.json", "deno.jsonc"],
    formatterFiles: [".prettierrc", ".prettierrc.json", ".prettierrc.yml", ".prettierrc.yaml", ".prettierrc.js", ".prettierrc.cjs", ".prettierrc.mjs", ".prettierrc.toml", "prettier.config.js", "prettier.config.cjs", "prettier.config.mjs", "prettier.config.ts", "biome.json", "biome.jsonc", "dprint.json", ".dprint.json", "deno.json", "deno.jsonc"],
    linterDeps: /^(@biomejs\/biome|oxlint|standard|xo)$/,
    formatterDeps: /^(prettier|@biomejs\/biome|dprint)$/,
    linterSections: /"eslintConfig"\s*:/,
    formatterSections: /"prettier"\s*:\s*[{"]/,
    linterHint: "ESLint or Biome",
    formatterHint: "Prettier or Biome",
  },
  {
    label: "Python",
    langs: (l) => l === "python",
    manifests: /(^|\/)(pyproject\.toml|setup\.py|setup\.cfg|requirements[^/]*\.(txt|in))$/,
    linterFiles: ["ruff.toml", ".ruff.toml", ".flake8", ".pylintrc", "pylintrc"],
    formatterFiles: ["ruff.toml", ".ruff.toml"],
    linterDeps: /^(ruff|flake8|pylint)$/i,
    formatterDeps: /^(ruff|black|yapf|autopep8)$/i,
    linterSections: /^\[(tool\.ruff|tool\.pylint|flake8)[\].]|\b(ruff|flake8|pylint)\b/m,
    formatterSections: /^\[(tool\.ruff|tool\.black|tool\.yapf)[\].]|\b(ruff|black|yapf)\b/m,
    linterHint: "Ruff",
    formatterHint: "Ruff (ruff format) or Black",
  },
];

/** Shared files whose contents can configure a tool. pre-commit counts: hooks run on every commit. */
const SHARED_CONFIG_FILES = ["package.json", "pyproject.toml", "setup.cfg", "tox.ini", ".pre-commit-config.yaml"];

/** File text, or "" when the file is absent. Other read errors surface. */
function readIfExists(abs: string): string {
  try {
    return readFileSync(abs, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  }
}

/** TOML and INI comments start with #; JSON has none. */
const withoutHashComments = (name: string, text: string) => (name.endsWith(".json") ? text : text.replace(/#.*$/gm, ""));

function toolDirs(root: string, files: HealthFile[], spec: ToolingSpec): string[] {
  const dirs = new Set(["."]);
  for (const f of files) if (spec.manifests.test(f.path) && !f.path.includes("node_modules/")) dirs.add(path.dirname(f.path));
  return [...dirs].filter((d) => existsSync(path.join(root, d)));
}

function hasTool(root: string, dirs: string[], files: string[], deps: string[], depRe: RegExp, sectionRe: RegExp): boolean {
  if (deps.some((d) => depRe.test(d))) return true;
  for (const d of dirs) {
    if (files.some((name) => existsSync(path.join(root, d, name)))) return true;
    for (const name of SHARED_CONFIG_FILES) if (sectionRe.test(withoutHashComments(name, readIfExists(path.join(root, d, name))))) return true;
  }
  return false;
}

function missingTooling({ root, prod, files, deps }: StandardsInput): Check {
  const hits: HealthHit[] = [];
  for (const spec of TOOLING) {
    const count = prod.filter((f) => spec.langs(f.lang)).length;
    if (count < MIN_FILES_FOR_TOOLING) continue;
    const dirs = toolDirs(root, files, spec);
    const manifest = files.map((f) => f.path).filter((p) => spec.manifests.test(p)).sort((a, b) => a.split("/").length - b.split("/").length)[0] ?? ".";
    if (!hasTool(root, dirs, spec.linterFiles, deps, spec.linterDeps, spec.linterSections))
      push(hits, { path: manifest, detail: `no linter for ${count} ${spec.label} files (add ${spec.linterHint})` });
    if (!hasTool(root, dirs, spec.formatterFiles, deps, spec.formatterDeps, spec.formatterSections))
      push(hits, { path: manifest, detail: `no formatter for ${count} ${spec.label} files (add ${spec.formatterHint})` });
  }
  return {
    id: "missing-tooling",
    title: "No Linter or Formatter",
    category: "standards",
    severity: "medium",
    hits,
    count: hits.length,
    fix: "Add the language's standard tools with a committed config and a script to run them: ESLint and Prettier (or Biome) for JS/TS, Ruff for Python. Add the packages as dev dependencies and a lint script.",
  };
}
