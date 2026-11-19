import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeJsonAtomic } from "@lens/core";
import { applyFixes, remediationPath, undoFix, type RemediationRecord } from "../src/remediate.js";

async function projectWithFix(onDisk: string, edit = { find: "export const x = 1;", replace: "export const x = 2;" }): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lens-landed-"));
  await fs.writeFile(path.join(root, "a.ts"), onDisk);
  const record: RemediationRecord = {
    generatedAt: new Date().toISOString(),
    source: "review",
    fixes: [{ id: "f1", itemId: "review-1", title: "Use 2", explanation: "", files: [{ path: "a.ts", diff: "", created: false }], status: "undone" }],
    skipped: [],
    edits: { f1: [{ path: "a.ts", ...edit }] },
  };
  await writeJsonAtomic(remediationPath(root, "review"), record);
  return root;
}

describe("Apply on a fix that's already in the code", () => {
  it("marks it applied without editing the file, and Undo still restores the original", async () => {
    const root = await projectWithFix("export const x = 2;\n");
    const { applied, failed } = await applyFixes(root, "review", ["f1"]);
    expect(failed).toEqual([]);
    expect(applied).toEqual(["f1"]);
    expect(await fs.readFile(path.join(root, "a.ts"), "utf8")).toBe("export const x = 2;\n");

    await undoFix(root, "review", "f1");
    expect(await fs.readFile(path.join(root, "a.ts"), "utf8")).toBe("export const x = 1;\n");
    await fs.rm(root, { recursive: true, force: true });
  });

  it("still applies a fix whose original text is on disk", async () => {
    const root = await projectWithFix("export const x = 1;\n");
    expect((await applyFixes(root, "review", ["f1"])).applied).toEqual(["f1"]);
    expect(await fs.readFile(path.join(root, "a.ts"), "utf8")).toBe("export const x = 2;\n");
    await fs.rm(root, { recursive: true, force: true });
  });

  it("refuses a fix when the file matches neither the original nor the fixed text", async () => {
    const root = await projectWithFix("export const x = 3;\n");
    expect((await applyFixes(root, "review", ["f1"])).failed).toHaveLength(1);
    await fs.rm(root, { recursive: true, force: true });
  });

  it("applies a deletion whose kept text is already on disk", async () => {
    const root = await projectWithFix("export const x = 1;\nconst BROKEN = true;\n", { find: "export const x = 1;\nconst BROKEN = true;\n", replace: "export const x = 1;\n" });
    expect((await applyFixes(root, "review", ["f1"])).applied).toEqual(["f1"]);
    expect(await fs.readFile(path.join(root, "a.ts"), "utf8")).toBe("export const x = 1;\n");
    await fs.rm(root, { recursive: true, force: true });
  });
});
