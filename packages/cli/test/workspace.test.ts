import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { collectChanges, makeWorkspace } from "../src/workspace.js";
import { applyFixes, buildRecord, remediationPath } from "../src/remediate.js";
import { writeJsonAtomic } from "@lens/core";

describe("workspace fixes", () => {
  it("turns edits in the copy into applied whole-file changes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "lens-ws-test-"));
    await fs.writeFile(path.join(root, "App.jsx"), "function A() {}\nfunction B() {}\n");
    await fs.writeFile(path.join(root, "old.md"), "stale\n");
    await fs.writeFile(path.join(root, ".env"), "SECRET=1\n");
    const ws = await makeWorkspace(root);
    expect(await fs.readFile(path.join(ws, ".env")).catch(() => null)).toBeNull();
    await fs.writeFile(path.join(ws, "App.jsx"), 'import { B } from "./B.jsx";\nfunction A() {}\n');
    await fs.writeFile(path.join(ws, "B.jsx"), "export function B() {}\n");
    await fs.writeFile(path.join(ws, "old.md"), "");
    await fs.writeFile(path.join(ws, ".env"), "SECRET=2\n");
    const { data, ignored } = await collectChanges(root, ws, {
      fixes: [
        { itemId: "split", title: "Split App", explanation: "Moved B.", files: ["App.jsx", "B.jsx"] },
        { itemId: "stale", title: "Remove old doc", explanation: "Unused.", files: ["old.md"] },
        { itemId: "noop", title: "Nothing", explanation: "x", files: [] },
      ],
      skipped: [],
    });
    expect(ignored).toEqual([]);
    expect(data.fixes.map((f) => f.itemId)).toEqual(["split", "stale"]);
    expect(data.skipped.map((x) => x.itemId)).toEqual(["noop"]);
    const rec = buildRecord(root, "health", data, 0, undefined, "t");
    expect(rec.fixes.every((f) => !f.invalid)).toBe(true);
    await writeJsonAtomic(remediationPath(root, "health"), rec);
    const { applied } = await applyFixes(root, "health", rec.fixes.map((f) => f.id));
    expect(applied).toHaveLength(2);
    expect(await fs.readFile(path.join(root, "B.jsx"), "utf8")).toContain("export function B");
    expect(await fs.readFile(path.join(root, "old.md")).catch(() => null)).toBeNull();
    expect(await fs.readFile(path.join(root, ".env"), "utf8")).toBe("SECRET=1\n");
    await fs.rm(ws, { recursive: true, force: true });
    await fs.rm(root, { recursive: true, force: true });
  });
});

describe("workflow files", () => {
  it("keeps edits to .github/workflows, since Lens pushes with workflow access", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "lens-ws-test-"));
    await fs.mkdir(path.join(root, ".github/workflows"), { recursive: true });
    await fs.writeFile(path.join(root, ".github/workflows/ci.yml"), "on: push\n");
    await fs.writeFile(path.join(root, "a.js"), "1\n");
    const ws = await makeWorkspace(root);
    await fs.writeFile(path.join(ws, ".github/workflows/ci.yml"), "on: pull_request\n");
    await fs.writeFile(path.join(ws, "a.js"), "2\n");
    const { data, ignored } = await collectChanges(root, ws, {
      fixes: [{ itemId: "ci", title: "CI", explanation: "x", files: ["a.js", ".github/workflows/ci.yml"] }],
      skipped: [],
    });
    expect(ignored).toEqual([]);
    expect(data.fixes[0]?.edits.map((e) => e.path)).toEqual([".github/workflows/ci.yml", "a.js"]);
    await fs.rm(ws, { recursive: true, force: true });
    await fs.rm(root, { recursive: true, force: true });
  });
});

describe("refactor budget", () => {
  it("gives each oversized item its own larger cap", async () => {
    const { remediateLimit, isRefactorItem, FIX_CHECK_RESERVE_USD } = await import("../src/enrich.js");
    expect(isRefactorItem("oversized~abc")).toBe(true);
    expect(isRefactorItem("untested~abc")).toBe(false);
    expect(remediateLimit("oversized", 5)).toBe(40 + FIX_CHECK_RESERVE_USD);
    expect(remediateLimit("oversized~abc", 1)).toBe(8 + FIX_CHECK_RESERVE_USD);
    expect(remediateLimit("untested", 5)).toBeLessThan(8 + FIX_CHECK_RESERVE_USD);
  });
});

describe("workspace changes from parallel fix runs", () => {
  it("ignores project changes made after the copy, and conflicting edits", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "lens-ws-par-"));
    await fs.writeFile(path.join(root, "a.ts"), "a\n");
    await fs.writeFile(path.join(root, "b.ts"), "b\n");
    await fs.writeFile(path.join(root, "c.ts"), "c\n");
    const ws = await makeWorkspace(root);
    await fs.writeFile(path.join(root, "b.ts"), "b fixed by another run\n");
    await fs.writeFile(path.join(root, "new.ts"), "added by another run\n");
    await fs.writeFile(path.join(root, "c.ts"), "c fixed by another run\n");
    await fs.writeFile(path.join(ws, "a.ts"), "a fixed\n");
    await fs.writeFile(path.join(ws, "c.ts"), "c fixed here\n");
    const { data, ignored } = await collectChanges(root, ws, {
      fixes: [{ itemId: "x", title: "Fix", explanation: "e", files: ["a.ts", "c.ts"] }],
      skipped: [],
    });
    expect(data.fixes[0]!.edits.map((e) => e.path)).toEqual(["a.ts"]);
    expect(ignored).toEqual(["c.ts"]);
  });
});
