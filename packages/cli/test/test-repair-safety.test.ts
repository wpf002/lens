import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeJsonAtomic } from "@lens/core";
import { appliedFixIds, applyFixes, buildRecord, confineFixes, remediationPath, undoFixesSince } from "../src/remediate.js";
import { inRepairScope, repairItems, type TestGate } from "../src/ci.js";

async function projectWith(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lens-repair-"));
  for (const [rel, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), text);
  }
  return root;
}

const edit = (itemId: string, file: string, find: string, replace: string) => ({ itemId, title: itemId, explanation: "x", edits: [{ path: file, find, replace }] });

describe("test repair safety", () => {
  it("undoes only the fixes a stopped repair applied, restoring each file", async () => {
    const root = await projectWith({ "a.ts": "const a = 1;\n", "b.ts": "const b = 1;\n" });
    const earlier = buildRecord(root, "health", { fixes: [edit("old", "a.ts", "1", "2")], skipped: [] }, 0, undefined, "old");
    await writeJsonAtomic(remediationPath(root, "health"), earlier);
    await applyFixes(root, "health", earlier.fixes.map((f) => f.id));
    const before = await appliedFixIds(root, "health");

    const repair = buildRecord(root, "health", { fixes: [edit("r1", "b.ts", "1", "3"), edit("r2", "a.ts", "2", "4")], skipped: [] }, 0, "tests", "rep");
    await writeJsonAtomic(remediationPath(root, "health"), { ...repair, fixes: [...earlier.fixes.map((f) => ({ ...f, status: "applied" as const })), ...repair.fixes], edits: { ...earlier.edits, ...repair.edits } });
    await applyFixes(root, "health", repair.fixes.map((f) => f.id));

    expect(await undoFixesSince(root, "health", before)).toEqual(["rep-2", "rep-1"]);
    expect(await fs.readFile(path.join(root, "a.ts"), "utf8")).toBe("const a = 2;\n");
    expect(await fs.readFile(path.join(root, "b.ts"), "utf8")).toBe("const b = 1;\n");
    expect(await appliedFixIds(root, "health")).toEqual(before);
    await fs.rm(root, { recursive: true, force: true });
  });

  it("refuses repair fixes that edit files outside the pull request and the failure", async () => {
    const gate: TestGate = { pr: 28, sha: "a", state: "broken", preexisting: 0, attempts: 0, broken: [{ name: "test", tests: ["apps/api/src/sync.test.ts > syncs"], excerpt: "at /home/runner/work/app/app/apps/api/src/sync.ts:12" }] };
    const items = repairItems(gate, ["apps/api/src/youtube.ts"]);
    expect(items[0]?.evidence.join("\n")).toContain("apps/api/src/youtube.ts");
    for (const allowed of ["apps/api/src/youtube.ts", "apps/api/src/sync.test.ts", "apps/api/src/sync.ts", "apps/api/package.json"]) expect(inRepairScope(items, allowed)).toBe(true);
    expect(inRepairScope(items, "apps/web/src/App.tsx")).toBe(false);

    const root = await projectWith({ "apps/api/src/youtube.ts": "let y = 1;\n", "apps/web/src/App.tsx": "let w = 1;\n" });
    const record = buildRecord(root, "health", { fixes: [edit("tests-1", "apps/api/src/youtube.ts", "1", "2"), edit("tests-1", "apps/web/src/App.tsx", "1", "2")], skipped: [] }, 0, "tests");
    expect(confineFixes(record, (file) => inRepairScope(items, file))).toBe(1);
    expect(record.fixes[0]?.invalid).toBeUndefined();
    expect(record.fixes[1]?.invalid).toMatch(/outside this repair: apps\/web\/src\/App\.tsx/);
    await fs.rm(root, { recursive: true, force: true });
  });
});
