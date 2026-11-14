import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fixCheckLimit } from "../src/enrich.js";
import { coveredFiles, hashFiles, keepReviewed, saveCoverage } from "../src/review-ledger.js";

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
