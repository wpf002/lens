import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { paths } from "@lens/core";
import { markReviewCurrent, reviewPath } from "../src/enrich.js";

// Regression: a re-review after a merge found nothing to review, left generatedAt alone, and Health kept showing "Before #N".
describe("markReviewCurrent", () => {
  it("moves generatedAt forward and keeps findings and stableSince", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "lens-review-current-"));
    mkdirSync(paths(root).dir, { recursive: true });
    const before = { generatedAt: "2026-11-06T10:00:00.000Z", report: "CODE_REVIEW.md", findings: [{ title: "x" }] };
    writeFileSync(reviewPath(root), JSON.stringify(before));
    await markReviewCurrent(root, "2026-11-06T18:00:00.000Z");
    const after = JSON.parse(readFileSync(reviewPath(root), "utf8"));
    expect(after.generatedAt).toBe("2026-11-06T18:00:00.000Z");
    expect(after.stableSince).toBe("2026-11-06T10:00:00.000Z");
    expect(after.findings).toEqual(before.findings);
  });

  it("does nothing without a review", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "lens-review-current-"));
    await expect(markReviewCurrent(root)).resolves.toBeUndefined();
  });
});
