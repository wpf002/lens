import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { parse, preloadGrammars } from "../src/treesitter.js";

type TreeSitter = typeof import("web-tree-sitter");
const require = createRequire(import.meta.url);
const esm = pathToFileURL(path.join(path.dirname(require.resolve("web-tree-sitter")), "tree-sitter.js")).href;
/** The copy of web-tree-sitter the loader imported for its Nth WASM instance. */
const instance = async (n: number) => (await import(`${esm}?instance=${n}`)) as TreeSitter;
const SOURCE = "export const answer = 42;\n";

describe("tree-sitter after a WASM trap", () => {
  it("swaps in a fresh instance, so the files after the trap still parse", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect((await parse("typescript", SOURCE))?.rootNode.type).toBe("program");

    // A trap poisons the whole instance: every later parse on it fails.
    vi.spyOn((await instance(1)).Parser.prototype, "parse").mockImplementation(() => {
      throw new WebAssembly.RuntimeError("null function or function signature mismatch");
    });
    await expect(parse("typescript", SOURCE)).rejects.toThrow(/signature mismatch/);
    expect((await parse("typescript", SOURCE))?.rootNode.type).toBe("program");
  });

  it("reloads tree-sitter when a poisoned instance can't create parsers", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn((await instance(2)).Parser.prototype, "setLanguage").mockImplementation(() => {
      throw new WebAssembly.RuntimeError("null function or function signature mismatch");
    });
    await expect(preloadGrammars(["javascript"])).resolves.toBeUndefined();
    expect((await parse("javascript", SOURCE))?.rootNode.type).toBe("program");
  });
});
