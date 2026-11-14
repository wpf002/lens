import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyFixes, buildRecord, isPendingFix, loadRemediation, markFixesMerged, remediationPath, undoFix } from "../src/remediate.js";
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
});
