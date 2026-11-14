import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { buildPlanRecord, moveFiles, usableMoves } from "../src/layout-plan.js";

function project(files: Record<string, string | Buffer>): string {
  const root = mkdtempSync(path.join(tmpdir(), "lens-layout-"));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), content);
  }
  return root;
}

describe("usableMoves", () => {
  it("drops missing, empty, binary, taken and unsafe moves", () => {
    const root = project({
      "src/a.ts": "export const a = 1;\n",
      "src/b.ts": "export const b = 1;\n",
      "src/empty.ts": "",
      "logo.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x01]),
      "src/taken.ts": "x\n",
    });
    const moves = usableMoves(root, [
      { from: "src/a.ts", to: "src/feature/a.ts" },
      { from: "src/missing.ts", to: "src/feature/missing.ts" },
      { from: "src/empty.ts", to: "src/feature/empty.ts" },
      { from: "logo.png", to: "assets/logo.png" },
      { from: "src/b.ts", to: "src/taken.ts" },
      { from: "src/b.ts", to: "../outside.ts" },
    ]);
    expect(moves).toEqual([{ from: "src/a.ts", to: "src/feature/a.ts" }]);
  });

  it("keeps a file in the first area that claims it", () => {
    const root = project({ "docs.md": "# Notes\n", "plan.md": "# Plan\n" });
    const record = buildPlanRecord(root, {
      summary: "Docs into docs/.",
      areas: [
        { id: "docs", title: "Move Docs", reason: "Stray root docs.", moves: [{ from: "docs.md", to: "docs/notes.md" }] },
        { id: "again", title: "Move Docs Again", reason: "Duplicate.", moves: [{ from: "docs.md", to: "docs/other.md" }] },
        { id: "plan", title: "Archive Plan", reason: "Old plan.", moves: [{ from: "plan.md", to: "docs/archive/plan.md" }] },
      ],
    });
    expect(record.areas.map((a) => [a.id, a.moves.length, a.dropped])).toEqual([
      ["docs", 1, 0],
      ["plan", 1, 0],
    ]);
    expect(record.areas.every((a) => a.status === "planned")).toBe(true);
  });
});

describe("moveFiles", () => {
  it("moves files and removes the folders they leave empty", async () => {
    const root = project({ "old/deep/a.ts": "a\n", "keep/b.ts": "b\n" });
    await moveFiles(root, [{ from: "old/deep/a.ts", to: "new/a.ts" }]);
    expect(readFileSync(path.join(root, "new/a.ts"), "utf8")).toBe("a\n");
    expect(existsSync(path.join(root, "old"))).toBe(false);
    expect(existsSync(path.join(root, "keep/b.ts"))).toBe(true);
  });
});
