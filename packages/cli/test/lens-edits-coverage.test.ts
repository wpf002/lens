import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fixCheckLimit } from "../src/enrich.js";
import { coveredFiles, hashFiles, keepReviewed, markReviewed, pendingReview, saveCoverage, type Coverage } from "../src/review-ledger.js";

describe("Lens's own edits", () => {
  it("keep a reviewed file reviewed, so the next review doesn't re-read it in full", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "lens-coverage-"));
    writeFileSync(path.join(root, "reviewed.ts"), "export const a = 1;\n");
    writeFileSync(path.join(root, "never.ts"), "export const b = 1;\n");
    await saveCoverage(root, Object.fromEntries(await hashFiles(root, ["reviewed.ts"])));
    const covered = await coveredFiles(root);

    writeFileSync(path.join(root, "reviewed.ts"), "export const a = 2;\n");
    writeFileSync(path.join(root, "never.ts"), "export const b = 2;\n");
    await keepReviewed(root, ["reviewed.ts", "never.ts"], covered);

    expect([...(await coveredFiles(root))]).toEqual(["reviewed.ts"]);
  });

  it("get a check budget that grows with the number of files changed", () => {
    expect(fixCheckLimit(0)).toBe(fixCheckLimit(1));
    expect(fixCheckLimit(524)).toBeGreaterThan(fixCheckLimit(25) * 20);
  });
});

describe("Review coverage", () => {
  it("keeps a file reviewed when an undo or re-apply returns it to content reviewed before", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "lens-coverage-"));
    const original = "export const a = 1;\n";
    const fixed = "export const a = 2;\n";
    writeFileSync(path.join(root, "a.ts"), original);
    await saveCoverage(root, Object.fromEntries(await hashFiles(root, ["a.ts"])));
    const covered = await coveredFiles(root);

    writeFileSync(path.join(root, "a.ts"), fixed);
    await keepReviewed(root, ["a.ts"], covered);
    writeFileSync(path.join(root, "a.ts"), original);
    expect([...(await coveredFiles(root))]).toEqual(["a.ts"]);
    writeFileSync(path.join(root, "a.ts"), fixed);
    expect([...(await coveredFiles(root))]).toEqual(["a.ts"]);
  });

  it("queues only content that has never been reviewed", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "lens-coverage-"));
    writeFileSync(path.join(root, "a.ts"), "export const a = 1;\n");
    const first = await hashFiles(root, ["a.ts"]);
    const coverage: Coverage = { "a.ts": first.get("a.ts")! };
    const files = [{ path: "a.ts", loc: 1 }];
    expect(pendingReview(files, first, coverage)).toEqual([]);

    writeFileSync(path.join(root, "a.ts"), "export const a = 3;\n");
    const changed = await hashFiles(root, ["a.ts"]);
    expect(pendingReview(files, changed, coverage)).toEqual(files);
    markReviewed(coverage, "a.ts", changed.get("a.ts")!);
    expect(pendingReview(files, first, coverage)).toEqual([]);
    expect(pendingReview(files, changed, coverage)).toEqual([]);
  });
});
