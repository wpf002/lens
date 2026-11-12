import { describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const TRAP_MARKER = "LENS_TEST_WASM_TRAP";

// Stands in for a tree-sitter WASM trap on one file: the real one can't be triggered on demand.
vi.mock("../src/extract.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/extract.js")>();
  return {
    ...real,
    extractStructure: async (grammar: string, source: string) => {
      if (source.includes(TRAP_MARKER)) throw new WebAssembly.RuntimeError("memory access out of bounds");
      return real.extractStructure(grammar, source);
    },
  };
});

const { scanProject } = await import("../src/index.js");

describe("parser failure", () => {
  it("skips a file the parser traps on and still scans the rest", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lens-parse-failure-"));
    await fs.writeFile(path.join(dir, "good.ts"), "export function add(a: number, b: number) { return a + b; }\n");
    await fs.writeFile(path.join(dir, "bad.ts"), `export const marker = "${TRAP_MARKER}";\n`);

    const { graph } = await scanProject(dir, { full: true });

    const paths = graph.nodes.map((n) => n.path);
    expect(paths).toContain("bad.ts");
    expect(graph.nodes.some((n) => n.kind === "function" && n.name === "add")).toBe(true);
  });
});
