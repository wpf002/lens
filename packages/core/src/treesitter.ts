/** Lazy web-tree-sitter loader. WASM only: no native bindings, works on every platform. */
import { createRequire } from "node:module";
import path from "node:path";
import { existsSync } from "node:fs";
import { Parser, Language, type Tree } from "web-tree-sitter";

const require = createRequire(import.meta.url);
let initPromise: Promise<void> | null = null;
const languages = new Map<string, Promise<Language | null>>();
const parsers = new Map<string, Parser>();

function wasmDir(): string {
  const pkg = require.resolve("tree-sitter-wasms/package.json");
  return path.join(path.dirname(pkg), "out");
}

async function init(): Promise<void> {
  initPromise ??= Parser.init();
  return initPromise;
}

async function loadLanguage(grammar: string): Promise<Language | null> {
  let p = languages.get(grammar);
  if (!p) {
    p = (async () => {
      await init();
      const file = path.join(wasmDir(), `tree-sitter-${grammar}.wasm`);
      if (!existsSync(file)) return null;
      try {
        return await Language.load(file);
      } catch {
        return null;
      }
    })();
    languages.set(grammar, p);
  }
  return p;
}

/**
 * Load every grammar a scan will need before parsing anything. Loading a
 * grammar (WASM side module) after the heap has grown from earlier parses is
 * several times slower, so loading everything first roughly halves scan time.
 */
export async function preloadGrammars(grammars: Iterable<string>): Promise<void> {
  const list = [...new Set(grammars)];
  const langs = await Promise.all(list.map((g) => loadLanguage(g)));
  list.forEach((g, i) => {
    const lang = langs[i];
    if (lang && !parsers.has(g)) {
      const p = new Parser();
      p.setLanguage(lang);
      parsers.set(g, p);
    }
  });
}

export async function parse(grammar: string, source: string): Promise<Tree | null> {
  const lang = await loadLanguage(grammar);
  if (!lang) return null;
  let parser = parsers.get(grammar);
  if (!parser) {
    parser = new Parser();
    parser.setLanguage(lang);
    parsers.set(grammar, parser);
  }
  try {
    return parser.parse(source);
  } catch {
    return null;
  }
}

export type { Tree, Node as SyntaxNode } from "web-tree-sitter";
