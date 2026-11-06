/**
 * Habits that make code read as machine-written: change-log comments, attribution
 * banners, emoji, template leftovers, pass-through wrappers, blanket try blocks,
 * tests that assert nothing. Each check favors missing a case over a false hit.
 */
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { stripComments } from "../security/analyze.js";
import { CODE_LANGS, GENERATED, JS_LANGS, push } from "./shared.js";
import type { HealthCheck, HealthFile, HealthHit } from "./health.js";

export type TellCheck = Omit<HealthCheck, "count" | "source"> & { count?: number };

export interface TellInput {
  root: string;
  /** Every scanned file, including markdown and config. */
  files: HealthFile[];
  /** Source files outside build output, tests included. */
  code: HealthFile[];
  /** `code` without tests. */
  prod: HealthFile[];
}

export function aiTellChecks(input: TellInput): TellCheck[] {
  return [
    narratingComments(input.code),
    aiAttribution(input.files),
    restatingComments(input.code),
    emojiInCode(input.code),
    commentHabits(input.code),
    readmeBoilerplate(input.root, input.files),
    scaffoldLeftovers(input.root, input.files, input.prod),
    mixedLibraries(input.prod),
    forwardingWrappers(input.prod),
    blanketTry(input.prod),
    weakTests(input.code),
    fragmentedFiles(input.prod),
  ];
}

/* Comments */

export interface CommentLine {
  line: number;
  text: string;
  /** True when the comment is the whole line, false for a trailing comment. */
  full: boolean;
}

const HASH_ONLY_LANGS = new Set(["python", "ruby"]);
const PYTHON_DIRECTIVE = /^#\s*(type:|noqa|pragma|-\*-|fmt:)/;

function quotesBalanced(s: string): boolean {
  const plain = s.replace(/\\./g, "");
  return ['"', "'", "`"].every((q) => plain.split(q).length % 2 === 1);
}

/** Comment text per line, with the markers removed. Block comments yield one entry per line. */
export function commentLines(src: string, lang: string): CommentLine[] {
  const out: CommentLine[] = [];
  const slash = !HASH_ONLY_LANGS.has(lang);
  const hash = HASH_ONLY_LANGS.has(lang) || lang === "php";
  let inBlock = false;
  src.split("\n").forEach((raw, i) => {
    const line = i + 1;
    const t = raw.trim();
    const add = (text: string, full: boolean) => {
      const clean = text.replace(/^\*+\s?/, "").replace(/\*+\/?$/, "").trim();
      if (clean) out.push({ line, text: clean, full });
    };
    if (inBlock) {
      const end = t.indexOf("*/");
      if (end >= 0) inBlock = false;
      add(end >= 0 ? t.slice(0, end) : t, true);
      return;
    }
    if (slash && t.startsWith("/*")) {
      const end = t.indexOf("*/", 2);
      if (end < 0) inBlock = true;
      add(end >= 0 ? t.slice(2, end) : t.slice(2), true);
      return;
    }
    if (slash && t.startsWith("//")) return add(t.replace(/^\/\/+!?/, ""), true);
    if (hash && t.startsWith("#")) {
      if (!t.startsWith("#!") && !PYTHON_DIRECTIVE.test(t)) add(t.replace(/^#+/, ""), true);
      return;
    }
    const trailing = (slash ? /\s\/\/\s(.*)$/ : hash ? /\s#\s(.*)$/ : null)?.exec(raw);
    if (trailing && quotesBalanced(raw.slice(0, trailing.index))) add(trailing[1]!, false);
  });
  return out;
}

/** Comments that describe the edit that produced the code instead of the code. */
const NARRATING = [
  /^(now|next),?\s+(we|let['’]s)\b/i,
  /^let['’]s\s+\w+/i,
  /^(updated|changed|modified|refactored|rewritten|reworked|moved|renamed)\s+(to|so|this|the|from|for|it)\b/i,
  /^(fix|fixed|bug ?fix|updated?|changed?|added|new|removed|refactor(ed)?|improved|enhanced)\s*:/i,
  /\bas (requested|discussed|you asked|per your request)\b/i,
  /^(this|the) (fix|change|update|edit|patch) (ensures|makes|prevents|fixes|addresses|resolves)\b/i,
  /^previously,?\s+(this|we|it|the)\b/i,
  /\bthe (old|previous|original) (code|version|implementation)\b/i,
  /^i('ve| have| will|'ll)\s+(added|updated|changed|fixed|removed|moved|refactored|implemented|created)\b/i,
  /^added\s+(this|a|an|the|new)\b/i,
  /\b(critical|important) fix\b/i,
];

function narratingComments(code: HealthFile[]): TellCheck {
  const hits: HealthHit[] = [];
  let count = 0;
  for (const f of code)
    for (const c of commentLines(f.src, f.lang)) {
      if (!NARRATING.some((re) => re.test(c.text))) continue;
      count++;
      push(hits, { path: f.path, line: c.line, detail: c.text.slice(0, 120) });
    }
  return { id: "narrating-comments", title: "Narrating Comments", category: "habits", severity: "medium", hits, count, fix: "Delete comments that describe the edit or the session. Keep only why the code is the way it is." };
}

const CODING_AI = "(Claude Code|Claude|ChatGPT|GPT-?\\d[\\w.]*|GitHub Copilot|Copilot|Cursor|Codex|Windsurf|Devin|Aider|Gemini|an? AI(?: assistant| model| tool| agent)?|AI)";
const MADE_BY_AI = new RegExp(`\\b(auto-?)?(generated|written|created|authored|produced|built|made|assisted|scaffolded)\\s+(by|with|using|via)\\s+\\[?${CODING_AI}\\b`, "i");
const FILE_MADE_BY_AI = new RegExp(`\\b(this|the) (file|code|module|function|class|component|script|test|project)s? (was|were|is|has been) (auto-?)?(generated|written|created)\\s+(by|with|using)\\s+${CODING_AI}\\b`, "i");
const ANYWHERE_ATTRIBUTION = /co-authored-by:.*\b(claude|copilot|chatgpt|openai|anthropic|cursor|gemini|devin|aider)\b|noreply@anthropic\.com|\bas an ai (language )?model\b/i;
const DOC_SUBJECT = /\b(this|the)\s+(file|code|project|readme|repo|repository|app|codebase|documentation|docs|site|library|tool)\b/i;
/** Text meant for AI tools, where naming one is expected. */
const AI_CONFIG_PATH = /(^|\/)(\.claude|\.cursor|\.github|skills|agents|prompts|fixtures?|node_modules)\/|(^|\/)(CLAUDE|AGENTS|GEMINI)\.md$|(^|\/)\.cursorrules$/i;
const BANNER_LINES = 10;

/** An AI product's code and docs say what the model generates; only claims about the project itself count. */
function claimsProjectMadeByAi(text: string): boolean {
  const made = MADE_BY_AI.exec(text);
  if (!made) return false;
  const before = text.slice(0, made.index);
  return DOC_SUBJECT.test(before) || !/[a-z0-9]/i.test(before);
}

function attributionIn(f: HealthFile): Array<{ line: number; text: string }> {
  if (CODE_LANGS.has(f.lang)) {
    return commentLines(f.src, f.lang)
      .filter((c) => ANYWHERE_ATTRIBUTION.test(c.text) || FILE_MADE_BY_AI.test(c.text) || (c.line <= BANNER_LINES && claimsProjectMadeByAi(c.text)))
      .map((c) => ({ line: c.line, text: c.text }));
  }
  if (!/\.(md|mdx|markdown|txt|rst)$/i.test(f.path)) return [];
  const out: Array<{ line: number; text: string }> = [];
  f.src.split("\n").forEach((l, i) => {
    if (ANYWHERE_ATTRIBUTION.test(l) || claimsProjectMadeByAi(l)) out.push({ line: i + 1, text: l.trim() });
  });
  return out;
}

function aiAttribution(files: HealthFile[]): TellCheck {
  const hits: HealthHit[] = [];
  let count = 0;
  for (const f of files) {
    if (AI_CONFIG_PATH.test(f.path) || GENERATED.test(f.path)) continue;
    for (const a of attributionIn(f)) {
      count++;
      push(hits, { path: f.path, line: a.line, detail: a.text.slice(0, 120) });
    }
  }
  return { id: "ai-attribution", title: "AI Attribution", category: "habits", severity: "medium", hits, count, fix: "Remove the attribution line or banner. Authorship belongs in git history, not in the file." };
}

const RESTATING_VERBS = new Set(["return", "returns", "import", "imports", "increment", "increments", "set", "sets", "get", "gets", "create", "creates", "initialize", "initialise", "init", "call", "calls", "define", "defines", "declare", "add", "adds", "check", "checks", "loop", "iterate", "update", "updates", "export", "exports"]);
const STOP_WORDS = new Set(["the", "a", "an", "to", "of", "for", "and", "or", "if", "is", "are", "be", "with", "from", "in", "on", "into", "this", "that", "it", "its", "all", "each", "every", "our", "we", "new", "over", "through", "by", "as", "at", "then", "value", "variable"]);
const RESTATING_MAX_WORDS = 6;
const RESTATING_MAX_CONTENT = 4;

function identifierWords(line: string): Set<string> {
  const words = new Set<string>();
  for (const id of line.match(/[A-Za-z_$][\w$]*/g) ?? [])
    for (const w of id.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[\s_$]+/)) if (w) words.add(w.toLowerCase());
  return words;
}

function hasWord(words: Set<string>, w: string): boolean {
  return words.has(w) || words.has(w.replace(/s$/, "")) || words.has(`${w}s`);
}

/** A short comment whose words all appear in the next line of code, e.g. "Return the result" over `return result`. */
function restates(comment: string, next: string): boolean {
  const words = comment.toLowerCase().match(/[a-z]+/g) ?? [];
  if (!words.length || words.length > RESTATING_MAX_WORDS || !RESTATING_VERBS.has(words[0]!)) return false;
  const content = words.slice(1).filter((w) => !STOP_WORDS.has(w));
  if (!content.length || content.length > RESTATING_MAX_CONTENT) return false;
  const code = next.trim();
  if (words[0]!.startsWith("return") && !code.startsWith("return")) return false;
  if (words[0]!.startsWith("import") && !/^(import|from)\b/.test(code)) return false;
  const ids = identifierWords(code);
  return content.every((w) => hasWord(ids, w));
}

function restatingComments(code: HealthFile[]): TellCheck {
  const hits: HealthHit[] = [];
  let count = 0;
  for (const f of code) {
    const lines = f.src.split("\n");
    const comments = commentLines(f.src, f.lang).filter((c) => c.full);
    const commentAt = new Set(comments.map((c) => c.line));
    for (const c of comments) {
      if (commentAt.has(c.line - 1) || commentAt.has(c.line + 1)) continue;
      const next = lines[c.line] ?? "";
      if (!next.trim() || !restates(c.text, next)) continue;
      count++;
      push(hits, { path: f.path, line: c.line, detail: `"${c.text.slice(0, 60)}" repeats the next line` });
    }
  }
  return { id: "restating-comments", title: "Comments That Restate the Code", category: "habits", severity: "low", hits, count, fix: "Delete comments that say what the next line already says." };
}

const EMOJI = /\p{Extended_Pictographic}/u;
/** Below this are ©, ®, ™ and arrows, which show up in normal text. */
const EMOJI_MIN_CODE_POINT = 0x2600;
const LOG_CALL = /\b(console\.(log|info|warn|error|debug)|print|println!?|puts|logger\.\w+|log\.(info|warn|error|debug|trace|fatal)|logging\.\w+|fmt\.(Print|Fprint)\w*|System\.out\.print\w*)\s*\(/;

export function firstEmoji(s: string): string | null {
  for (const ch of s) if (ch.codePointAt(0)! >= EMOJI_MIN_CODE_POINT && EMOJI.test(ch)) return ch;
  return null;
}

function emojiInCode(code: HealthFile[]): TellCheck {
  const hits: HealthHit[] = [];
  let count = 0;
  for (const f of code) {
    const lines = new Map<number, string>();
    for (const c of commentLines(f.src, f.lang)) if (firstEmoji(c.text)) lines.set(c.line, "comment");
    f.src.split("\n").forEach((l, i) => {
      if (LOG_CALL.test(l) && firstEmoji(l)) lines.set(i + 1, "log message");
    });
    for (const [line, where] of [...lines].sort((a, b) => a[0] - b[0])) {
      count++;
      push(hits, { path: f.path, line, detail: `${firstEmoji(f.src.split("\n")[line - 1]!)} in a ${where}` });
    }
  }
  return { id: "emoji", title: "Emoji in Code", category: "habits", severity: "low", hits, count, fix: "Remove emoji from comments and log messages. Use plain words or log levels." };
}

const SECTION_BANNER = /^[=\-*#~_]{4,}|^[=\-*#~_]{3,}.*[=\-*#~_]{3,}$/;
const MIN_BANNERS = 3;
const MIN_DOCUMENTED_FUNCTIONS = 6;
const SHORT_FUNCTION_LINES = 5;

function commentHabits(code: HealthFile[]): TellCheck {
  const hits: HealthHit[] = [];
  for (const f of code) {
    const banners = commentLines(f.src, f.lang).filter((c) => c.full && SECTION_BANNER.test(c.text));
    if (banners.length >= MIN_BANNERS) push(hits, { path: f.path, line: banners[0]!.line, detail: `${banners.length} section-divider comments` });
    const fns = f.symbols.filter((s) => s.kind === "function");
    const short = fns.filter((s) => s.lines[1] - s.lines[0] + 1 <= SHORT_FUNCTION_LINES).length;
    if (fns.length >= MIN_DOCUMENTED_FUNCTIONS && fns.every((s) => s.doc) && short * 2 >= fns.length)
      push(hits, { path: f.path, line: fns[0]!.lines[0], detail: `all ${fns.length} functions have doc comments, ${short} of them ${SHORT_FUNCTION_LINES} lines or fewer` });
  }
  return { id: "comment-habits", title: "Comment Habits", category: "habits", severity: "low", hits, fix: "Drop section dividers and doc comments that only repeat a short function's name. Keep docs on exported or non-obvious code." };
}

/* README and scaffolding */

const README = /(^|\/)readme\.(md|mdx|markdown)$/i;
const README_PLACEHOLDER = /\b(yourusername|your-username|your_username|your-repo(-name)?|your\.email@|amazingfeature)\b|\[your name\]|github\.com\/username\//i;
const README_FILLER = /made with (❤️?|♥|love)|happy coding|contributions are welcome!|give (it |this (repo|project) )?a (⭐|star)|feel free to (submit|open) a (pull request|pr)\b|if you found this (project )?(helpful|useful)/i;
const LIST_OR_HEADING = /^\s*(#{1,6}|[-*+]|\d+\.)\s+(.*)$/;
const MIN_EMOJI_LINES = 3;
const LICENSE_CLAIM = /^#{1,6}\s*licen[cs]e\b|\blicensed under\b|\b(MIT|Apache|BSD|GPL)[- ]licen[cs]e\b/im;
const LICENSE_FILE = /^(licen[cs]e|copying)(\.|$)/i;

function rootFileNames(root: string): string[] | null {
  try {
    return readdirSync(root);
  } catch {
    // An unreadable root means the license check can't run; skip it rather than guess.
    return null;
  }
}

function readmeBoilerplate(root: string, files: HealthFile[]): TellCheck {
  const hits: HealthHit[] = [];
  let count = 0;
  const hit = (h: HealthHit) => {
    count++;
    push(hits, h);
  };
  for (const f of files) {
    if (!README.test(f.path) || AI_CONFIG_PATH.test(f.path) || GENERATED.test(f.path)) continue;
    const lines = f.src.split("\n");
    const emojiLines = lines.map((l, i) => ({ i, m: LIST_OR_HEADING.exec(l) })).filter((x) => x.m && firstEmoji(x.m[2]!.slice(0, 4)));
    if (emojiLines.length >= MIN_EMOJI_LINES) hit({ path: f.path, line: emojiLines[0]!.i + 1, detail: `${emojiLines.length} headings and bullets start with an emoji` });
    lines.forEach((l, i) => {
      const m = README_PLACEHOLDER.exec(l) ?? README_FILLER.exec(l);
      if (m) hit({ path: f.path, line: i + 1, detail: `"${m[0]}"` });
    });
    if (!f.path.includes("/") && LICENSE_CLAIM.test(f.src)) {
      const names = rootFileNames(root);
      if (names && !names.some((n) => LICENSE_FILE.test(n))) hit({ path: f.path, detail: "names a license but the repo has no LICENSE file" });
    }
  }
  return { id: "readme-boilerplate", title: "README Boilerplate", category: "docs", severity: "low", hits, count, fix: "Replace placeholders with real values, cut stock phrases and emoji bullets, and add the LICENSE file the README refers to." };
}

const TEMPLATE_README = /Getting Started with Create React App|bootstrapped with \[?Create React App|bootstrapped with \[?`?create-next-app|^# (React|Vue 3|Svelte|Preact|Solid)( \+ (TypeScript|TS))? \+ Vite/m;
const DEFAULT_ASSETS = ["public/vite.svg", "src/assets/react.svg", "src/assets/vue.svg", "src/assets/svelte.svg", "public/next.svg", "public/vercel.svg", "public/file.svg", "public/globe.svg", "public/window.svg", "public/logo192.png", "public/logo512.png", "src/logo.svg"];
const STARTER_TEXT = /Click on the (Vite and React|Vite and Vue|Vite and Svelte) logos|Edit <code>src\/App|>\s*Learn React\s*<|Get started by editing|count is \{\s*count\s*\}/;
const STARTER_FILE = /(^|\/)src\/reportWebVitals\.(js|ts)$|(^|\/)pages\/api\/hello\.(js|ts)$|(^|\/)app\/api\/hello\/route\.(js|ts)$/;

function scaffoldLeftovers(root: string, files: HealthFile[], prod: HealthFile[]): TellCheck {
  const hits: HealthHit[] = [];
  const references = files.filter((f) => !/\.(md|mdx|markdown)$/i.test(f.path)).map((f) => f.src).join("\n");
  for (const f of files) {
    if (README.test(f.path) && TEMPLATE_README.test(f.src)) push(hits, { path: f.path, detail: "still the framework's template README" });
    if (STARTER_FILE.test(f.path)) push(hits, { path: f.path, detail: "starter file from the project template" });
    if (/(^|\/)App\.test\.(js|jsx|ts|tsx)$/.test(f.path) && /learn react/i.test(f.src)) push(hits, { path: f.path, detail: "template test that looks for the starter page" });
  }
  for (const f of prod)
    f.src.split("\n").forEach((l, i) => {
      if (STARTER_TEXT.test(l)) push(hits, { path: f.path, line: i + 1, detail: "starter page text" });
    });
  const packageDirs = new Set(["", ...files.filter((f) => path.basename(f.path) === "package.json" && !f.path.includes("node_modules/")).map((f) => path.dirname(f.path)).filter((d) => d !== ".")]);
  for (const dir of packageDirs)
    for (const asset of DEFAULT_ASSETS) {
      const rel = path.posix.join(dir, asset);
      if (existsSync(path.join(root, rel)) && !references.includes(path.basename(asset))) push(hits, { path: rel, detail: "default template asset nothing uses" });
    }
  return { id: "scaffold-leftovers", title: "Scaffold Leftovers", category: "leftovers", severity: "low", hits, fix: "Delete template files, assets, and README text the project doesn't use, or replace them with the project's own." };
}

/* Structure */

/** Libraries that do the same job; a project should settle on one per family. */
const LIBRARY_FAMILIES: Array<{ job: string; langs: Set<string>; libs: Record<string, string> }> = [
  { job: "HTTP requests", langs: JS_LANGS, libs: { axios: "axios", got: "got", ky: "ky", superagent: "superagent", request: "request", "node-fetch": "fetch", "cross-fetch": "fetch", "isomorphic-fetch": "fetch", undici: "fetch" } },
  { job: "HTTP requests", langs: new Set(["python"]), libs: { requests: "requests", httpx: "httpx", aiohttp: "aiohttp", urllib3: "urllib3" } },
  { job: "dates", langs: JS_LANGS, libs: { moment: "moment", dayjs: "dayjs", "date-fns": "date-fns", luxon: "luxon" } },
  { job: "validation", langs: JS_LANGS, libs: { zod: "zod", yup: "yup", joi: "joi", ajv: "ajv", valibot: "valibot", superstruct: "superstruct" } },
];
const GLOBAL_FETCH = /(?<![\w.$])fetch\s*\(/;

function packageName(source: string, lang: string): string {
  if (lang === "python") return source.split(".")[0]!;
  return source.startsWith("@") ? source.split("/").slice(0, 2).join("/") : source.split("/")[0]!;
}

function mixedLibraries(prod: HealthFile[]): TellCheck {
  const hits: HealthHit[] = [];
  let count = 0;
  for (const family of LIBRARY_FAMILIES) {
    const users = new Map<string, Set<string>>();
    const use = (lib: string, file: string) => (users.get(lib) ?? users.set(lib, new Set()).get(lib)!).add(file);
    for (const f of prod) {
      if (!family.langs.has(f.lang)) continue;
      for (const imp of f.imports) {
        const lib = family.libs[packageName(imp.source, f.lang)];
        if (lib) use(lib, f.path);
      }
      if (family.job === "HTTP requests" && JS_LANGS.has(f.lang) && GLOBAL_FETCH.test(stripComments(f.src, f.lang))) use("fetch", f.path);
    }
    if (users.size < 2) continue;
    const ranked = [...users].sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0]));
    const [main, mainFiles] = ranked[0]!;
    for (const [lib, libFiles] of ranked.slice(1))
      for (const file of [...libFiles].filter((p) => !mainFiles.has(p)).sort()) {
        count++;
        push(hits, { path: file, detail: `uses ${lib} for ${family.job}; the rest of the project uses ${main} (${mainFiles.size} files)` });
      }
  }
  return { id: "inconsistent-libs", title: "Mixed Libraries", category: "dependencies", severity: "low", hits, count, fix: "Switch the odd file to the library the rest of the project uses for the same job." };
}

const JS_FORWARD = /^(?:export\s+)?(?:async\s+)?function\s*\*?\s*\w+\s*(?:<[^>]*>)?\(([^)]*)\)\s*(?::[^{]+)?\{\s*return\s+(?:await\s+)?([A-Za-z_$][\w$]*)\s*\(([^()]*)\)\s*;?\s*\}$/;
const JS_ARROW_FORWARD = /^(?:export\s+)?(?:const|let|var)\s+\w+\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\(([^)]*)\)|(\w+))\s*(?::[^=]+)?=>\s*(?:\{\s*return\s+)?(?:await\s+)?([A-Za-z_$][\w$]*)\s*\(([^()]*)\)\s*;?\s*\}?\s*;?$/;
const PY_FORWARD = /^(?:async\s+)?def\s+\w+\s*\(([^)]*)\)\s*(?:->[^:]+)?:\s*(?:("""|''')[\s\S]*?\2\s*)?return\s+(?:await\s+)?([A-Za-z_]\w*)\s*\(([^()]*)\)\s*$/;
const MAX_WRAPPER_LINES = 4;

const argNames = (s: string) => s.split(",").map((a) => a.trim()).filter(Boolean);

/** The function a body only forwards to, with the same arguments in the same order. */
export function forwardTarget(body: string, params: string[]): string | null {
  const m = JS_FORWARD.exec(body);
  const a = m ? null : JS_ARROW_FORWARD.exec(body);
  const p = m || a ? null : PY_FORWARD.exec(body);
  const callee = m?.[2] ?? a?.[3] ?? p?.[3];
  const args = m?.[3] ?? a?.[4] ?? p?.[4];
  if (!callee || args === undefined) return null;
  const passed = argNames(args);
  return passed.length === params.length && passed.every((x, i) => x === params[i]) ? callee : null;
}

function forwardingWrappers(prod: HealthFile[]): TellCheck {
  const hits: HealthHit[] = [];
  let count = 0;
  for (const f of prod) {
    if (!JS_LANGS.has(f.lang) && f.lang !== "python") continue;
    const lines = f.src.split("\n");
    for (const s of f.symbols) {
      if (s.kind !== "function" || s.owner || s.exported || s.decorators.length || s.lines[1] - s.lines[0] + 1 > MAX_WRAPPER_LINES) continue;
      const body = stripComments(lines.slice(s.lines[0] - 1, s.lines[1]).join("\n"), f.lang).trim();
      const callee = forwardTarget(body, s.params);
      if (!callee || callee === s.name || s.params.includes(callee)) continue;
      count++;
      push(hits, { path: f.path, line: s.lines[0], detail: `${s.name}() only calls ${callee}() with the same arguments` });
    }
  }
  return { id: "forwarding-wrappers", title: "Forwarding Wrappers", category: "structure", severity: "low", hits, count, fix: "Call the wrapped function directly and delete the wrapper." };
}

const MIN_TRY_FUNCTIONS = 4;
const BLANKET_TRY_SHARE = 0.75;

/** True when the function's first statement is a try block. */
function startsWithTry(lines: string[], start: number, end: number, python: boolean): boolean {
  let i = start - 1;
  while (i < end && !(python ? /:\s*(#.*)?$/.test(lines[i]!) : lines[i]!.includes("{"))) i++;
  for (i++; i < end; i++) {
    const t = lines[i]!.trim();
    if (!t || t.startsWith("//") || t.startsWith("#") || t.startsWith("*") || t.startsWith("/*")) continue;
    return python ? /^try\s*:/.test(t) : /^try\s*\{/.test(t);
  }
  return false;
}

function blanketTry(prod: HealthFile[]): TellCheck {
  const hits: HealthHit[] = [];
  for (const f of prod) {
    if (!JS_LANGS.has(f.lang) && f.lang !== "python") continue;
    const lines = f.src.split("\n");
    const fns = f.symbols.filter((s) => s.kind === "function" && s.lines[1] - s.lines[0] >= 3);
    if (fns.length < MIN_TRY_FUNCTIONS) continue;
    const wrapped = fns.filter((s) => startsWithTry(lines, s.lines[0], s.lines[1], f.lang === "python")).length;
    if (wrapped / fns.length >= BLANKET_TRY_SHARE) push(hits, { path: f.path, line: fns[0]!.lines[0], detail: `${wrapped} of ${fns.length} functions wrap their whole body in try` });
  }
  return { id: "blanket-try", title: "Blanket Try/Catch", category: "errors", severity: "low", hits, fix: "Catch only where the code can recover or add context. Let other errors reach one handler at the boundary." };
}

/* Tests */

const JS_TEST_CASE = /\b(it|test)(\.each\([^)]*\))?(\.(only|concurrent))?\s*\(\s*["'`]/g;
const PY_TEST_CASE = /^\s*(async\s+)?def\s+test_\w*/gm;
const JS_ASSERTION = /\bexpect\w*\s*\(|\bassert\w*(\.\w+)?\s*\(|\.should\b|\bt\.(is|deepEqual|true|false|throws|equal|assert|ok|not|like|snapshot)\w*\(|\.expect\(\s*\d/g;
const JS_MATCHER = /\.(not\.|resolves\.|rejects\.)*to[A-Z]\w*\(/g;
const JS_WEAK_MATCHER = /\.(not\.)?(toBeDefined|toBeTruthy|toBeNull|toBeUndefined|toMatchSnapshot|toMatchInlineSnapshot|toBeInTheDocument)\(/g;
const PY_ASSERT = /^\s*assert\b.*$|\bself\.assert\w+\(.*$|\bpytest\.raises\b|\.assert_\w+\(/gm;
const PY_WEAK_ASSERT = /^\s*assert\s+(not\s+)?[\w.[\]'"]+\s*$|^\s*assert\s+.+\s+is not None\s*$|\bself\.assert(True|IsNotNone)\(/;

const countOf = (src: string, re: RegExp) => src.match(re)?.length ?? 0;

/** Why a test file proves little, or null when its assertions check real values. */
export function weakTestReason(src: string, lang: string): string | null {
  const clean = stripComments(src, lang);
  if (JS_LANGS.has(lang)) {
    const cases = countOf(clean, JS_TEST_CASE);
    if (!cases) return null;
    if (!countOf(clean, JS_ASSERTION)) return `${cases} tests and no assertions`;
    const matchers = countOf(clean, JS_MATCHER);
    const weak = countOf(clean, JS_WEAK_MATCHER);
    const otherAsserts = countOf(clean, /\bassert\w*(\.\w+)?\s*\(|\.should\b|\bt\.\w+\(|\.expect\(\s*\d/g);
    return matchers > 0 && weak === matchers && !otherAsserts ? "every assertion only checks that a value exists or matches a snapshot" : null;
  }
  if (lang === "python") {
    const cases = countOf(clean, PY_TEST_CASE);
    if (!cases) return null;
    const asserts = clean.match(PY_ASSERT) ?? [];
    if (!asserts.length) return `${cases} tests and no assertions`;
    return asserts.every((a) => PY_WEAK_ASSERT.test(a)) ? "every assertion only checks that a value exists" : null;
  }
  return null;
}

function weakTests(code: HealthFile[]): TellCheck {
  const hits: HealthHit[] = [];
  for (const f of code) {
    if (!f.isTest) continue;
    const reason = weakTestReason(f.src, f.lang);
    if (reason) push(hits, { path: f.path, detail: reason });
  }
  return { id: "weak-tests", title: "Weak Tests", category: "tests", severity: "medium", hits, fix: "Assert on the actual output: values, calls, errors. A test that only checks something exists passes when the code is wrong." };
}

const TINY_FILE_LINES = 5;
const MIN_TINY_FILES = 5;
const REEXPORT_LINE = /^(import\b|export\s+(\*|\{[^}]*\}|type\s+\{[^}]*\})\s*from\b|export\s+\*|from\s+\S+\s+import\b|module\.exports\s*=\s*require\()/;
const SKIP_TINY = /(^|\/)(__init__\.py|[^/]+\.d\.ts)$|(^|\/)migrations?\//;

/** Lines of code that aren't imports or re-exports; null for barrel files that only re-export. */
function ownCodeLines(f: HealthFile): number | null {
  const lines = stripComments(f.src, f.lang).split("\n").map((l) => l.trim()).filter(Boolean);
  const own = lines.filter((l) => !REEXPORT_LINE.test(l)).length;
  return own === 0 ? null : own;
}

function fragmentedFiles(prod: HealthFile[]): TellCheck {
  const byDir = new Map<string, HealthFile[]>();
  for (const f of prod) if (!SKIP_TINY.test(f.path)) (byDir.get(path.dirname(f.path)) ?? byDir.set(path.dirname(f.path), []).get(path.dirname(f.path))!).push(f);
  const hits: HealthHit[] = [];
  for (const [dir, group] of [...byDir].sort((a, b) => a[0].localeCompare(b[0]))) {
    const sizes = group.map(ownCodeLines).filter((n): n is number => n !== null);
    const tiny = sizes.filter((n) => n <= TINY_FILE_LINES).length;
    if (tiny >= MIN_TINY_FILES && tiny * 2 > sizes.length) push(hits, { path: dir, detail: `${tiny} of ${sizes.length} files have ${TINY_FILE_LINES} or fewer lines of code` });
  }
  return { id: "fragmented", title: "Fragmented Files", category: "structure", severity: "low", hits, fix: "Merge the tiny files that change together into one module per concern." };
}
