/** Lazy web-tree-sitter loader. WASM only: no native bindings, works on every platform. */
import { createRequire } from "node:module";
import path from "node:path";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { Language, Parser, Tree } from "web-tree-sitter";

type TreeSitter = typeof import("web-tree-sitter");

const require = createRequire(import.meta.url);
let runtime: Promise<TreeSitter> | null = null;
/** Each reset imports a new copy of web-tree-sitter, so it gets its own WASM instance. */
let instance = 0;
const languages = new Map<string, Promise<Language | null>>();
const parsers = new Map<string, Parser>();

function wasmDir(): string {
  const pkg = require.resolve("tree-sitter-wasms/package.json");
  return path.join(path.dirname(pkg), "out");
}

function loadRuntime(): Promise<TreeSitter> {
  runtime ??= (async () => {
    // The package only exports its CommonJS entry to require; the ESM build sits beside it.
    const esm = path.join(path.dirname(require.resolve("web-tree-sitter")), "tree-sitter.js");
    instance += 1;
    const ts = (await import(`${pathToFileURL(esm).href}?instance=${instance}`)) as TreeSitter;
    await ts.Parser.init();
    return ts;
  })();
  return runtime;
}

async function loadLanguage(grammar: string): Promise<Language | null> {
  let p = languages.get(grammar);
  if (!p) {
    p = (async () => {
      const ts = await loadRuntime();
      const file = path.join(wasmDir(), `tree-sitter-${grammar}.wasm`);
      if (!existsSync(file)) return null;
      try {
        return await ts.Language.load(file);
      } catch {
        return null;
      }
    })();
    languages.set(grammar, p);
  }
  return p;
}

async function parserFor(grammar: string): Promise<Parser | null> {
  const existing = parsers.get(grammar);
  if (existing) return existing;
  const lang = await loadLanguage(grammar);
  if (!lang) return null;
  const parser = new (await loadRuntime()).Parser();
  parser.setLanguage(lang);
  parsers.set(grammar, parser);
  return parser;
}

/**
 * Load every grammar a scan will need before parsing anything. Loading a
 * grammar (WASM side module) after the heap has grown from earlier parses is
 * several times slower, so loading everything first roughly halves scan time.
 */
export async function preloadGrammars(grammars: Iterable<string>): Promise<void> {
  const list = [...new Set(grammars)];
  const load = async () => {
    await Promise.all(list.map((g) => loadLanguage(g)));
    for (const g of list) await parserFor(g);
  };
  try {
    await load();
  } catch (e) {
    // A trap in an earlier scan can leave the instance unusable; start over on a fresh one.
    console.error(`[scan] tree-sitter failed to start, reloading it: ${e instanceof Error ? e.message : String(e)}`);
    resetTreeSitter();
    await load();
  }
}

export async function parse(grammar: string, source: string): Promise<Tree | null> {
  const parser = await parserFor(grammar);
  if (!parser) return null;
  try {
    return parser.parse(source);
  } catch (e) {
    resetTreeSitter();
    throw e;
  }
}

/**
 * Throw away the WASM instance after a trap. A trap leaves its memory in an unknown state, so
 * every later parse (and even `new Parser()`) can fail until a new instance replaces it.
 */
export function resetTreeSitter(): void {
  for (const parser of parsers.values()) {
    try {
      parser.delete();
    } catch {
      // The old instance may be too broken to free; it's dropped either way.
    }
  }
  parsers.clear();
  languages.clear();
  runtime = null;
}

export type { Tree, Node as SyntaxNode } from "web-tree-sitter";
