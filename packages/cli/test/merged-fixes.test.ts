import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyFixes, buildRecord, discardFixesTouching, isPendingFix, loadRemediation, markFixesMerged, remediationPath, undoFix } from "../src/remediate.js";
import { collectChanges, makeWorkspace } from "../src/workspace.js";
import { writeJsonAtomic } from "@lens/core";

async function proposeTwoFixes(root: string): Promise<[string, string]> {
  const ws = await makeWorkspace(root);
  await fs.writeFile(path.join(ws, "a.ts"), "fixed one\n");
  await fs.writeFile(path.join(ws, "b.ts"), "fixed two\n");
  const fixes = [
    { itemId: "one", title: "Fix one", explanation: "x", files: ["a.ts"] },
    { itemId: "two", title: "Fix two", explanation: "x", files: ["b.ts"] },
  ];
  const { data } = await collectChanges(root, ws, { fixes, skipped: [] });
  const rec = buildRecord(root, "health", data, 0, undefined, "t");
  await writeJsonAtomic(remediationPath(root, "health"), rec);
  await fs.rm(ws, { recursive: true, force: true });
  return [rec.fixes[0]!.id, rec.fixes[1]!.id];
}

describe("fixes after a merge", () => {
  it("keeps merged fixes out of the next pull request and Undo", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "lens-merged-"));
    await fs.writeFile(path.join(root, "a.ts"), "a\n");
    await fs.writeFile(path.join(root, "b.ts"), "b\n");
    const [first, second] = await proposeTwoFixes(root);
    await applyFixes(root, "health", [first]);
    await markFixesMerged(root, 26);
    await applyFixes(root, "health", [second]);

    const fixes = (await loadRemediation(root, "health"))!.fixes;
    expect(fixes.filter(isPendingFix).map((f) => f.id)).toEqual([second]);
    expect(fixes.find((f) => f.id === first)?.mergedIn).toBe(26);
    await expect(undoFix(root, "health", first)).rejects.toThrow(/already merged in #26/);
    expect(await fs.readFile(path.join(root, "a.ts"), "utf8")).toBe("fixed one\n");
    await fs.rm(root, { recursive: true, force: true });
  });

  it("reopens unmerged fixes in files a merge with the base dropped, leaving merged ones alone", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "lens-dropped-"));
    await fs.writeFile(path.join(root, "a.ts"), "a\n");
    await fs.writeFile(path.join(root, "b.ts"), "b\n");
    const [first, second] = await proposeTwoFixes(root);
    await applyFixes(root, "health", [first]);
    await markFixesMerged(root, 30);
    await applyFixes(root, "health", [second]);

    expect(await discardFixesTouching(root, ["a.ts", "b.ts"])).toBe(1);

    const fixes = (await loadRemediation(root, "health"))!.fixes;
    expect(fixes.find((f) => f.id === first)?.status).toBe("applied");
    expect(fixes.find((f) => f.id === second)?.status).toBe("discarded");
    expect(fixes.filter(isPendingFix)).toEqual([]);
    await fs.rm(root, { recursive: true, force: true });
  });

  it("leaves fixes in uncommitted files pending when a merge is found later", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "lens-merged-"));
    await fs.writeFile(path.join(root, "a.ts"), "a\n");
    await fs.writeFile(path.join(root, "b.ts"), "b\n");
    const [first, second] = await proposeTwoFixes(root);
    await applyFixes(root, "health", [first, second]);
    await markFixesMerged(root, 27, new Set(["b.ts"]));

    const fixes = (await loadRemediation(root, "health"))!.fixes;
    expect(fixes.find((f) => f.id === first)?.mergedIn).toBe(27);
    expect(fixes.filter(isPendingFix).map((f) => f.id)).toEqual([second]);
    await fs.rm(root, { recursive: true, force: true });
  });

  it("re-applies an undone fix from its saved edits", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "lens-redo-"));
    await fs.writeFile(path.join(root, "a.ts"), "a\n");
    await fs.writeFile(path.join(root, "b.ts"), "b\n");
    const [first] = await proposeTwoFixes(root);
    await applyFixes(root, "health", [first]);
    await undoFix(root, "health", first);
    expect(await fs.readFile(path.join(root, "a.ts"), "utf8")).toBe("a\n");

    expect((await applyFixes(root, "health", [first])).applied).toEqual([first]);
    expect(await fs.readFile(path.join(root, "a.ts"), "utf8")).toBe("fixed one\n");
    expect((await loadRemediation(root, "health"))!.fixes.find((f) => f.id === first)?.status).toBe("applied");
    await undoFix(root, "health", first);
    expect(await fs.readFile(path.join(root, "a.ts"), "utf8")).toBe("a\n");
    await fs.rm(root, { recursive: true, force: true });
  });
});
