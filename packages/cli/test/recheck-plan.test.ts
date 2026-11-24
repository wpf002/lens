import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { KnowledgeGraph } from "@lens/core";
import { recheckPlan, remediationItems, reviewPath, type ReviewRecord } from "../src/enrich.js";
import { hashFiles, saveCoverage } from "../src/review-ledger.js";

const finding = (title: string, file: string, extra: Partial<ReviewRecord["findings"][number]> = {}) => ({ title, severity: "medium" as const, category: "design", path: file, detail: title, ...extra });

describe("recheckPlan", () => {
  it("re-reviews only changed files that hold open findings, and a closed single finding isn't fixed again", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "lens-recheck-"));
    mkdirSync(path.join(root, ".lens"));
    const files = ["changed.ts", "same.ts", "closed.ts", "minor.ts"];
    for (const f of files) writeFileSync(path.join(root, f), "export const a = 1;\n");
    await saveCoverage(root, Object.fromEntries(await hashFiles(root, files)));
    const record: ReviewRecord = {
      generatedAt: "2000-01-01T00:00:00.000Z",
      report: "REVIEW.md",
      findings: [finding("Stale", "changed.ts"), finding("Current", "same.ts"), finding("Gone", "closed.ts", { resolvedAt: "2000-01-02T00:00:00.000Z" }), finding("Minor", "minor.ts", { severity: "low" })],
    };
    writeFileSync(reviewPath(root), JSON.stringify(record));
    for (const f of ["changed.ts", "closed.ts", "minor.ts"]) writeFileSync(path.join(root, f), "export const a = 2;\n");
    // Only nodes are read from the graph here.
    const graph = { nodes: files.map((p) => ({ kind: "file", path: p })) } as unknown as KnowledgeGraph;

    const all = await recheckPlan(root, "review", undefined, graph);
    expect(all.paths).toEqual(["changed.ts"]);
    expect(all.estimate.limit).toBeGreaterThan(0);
    expect((await recheckPlan(root, "review", "review-1", graph)).paths).toEqual([]);
    // Health's Remediate fixes review findings of every severity, so it re-checks all of their changed files.
    expect((await recheckPlan(root, "health", undefined, graph)).paths).toEqual(["changed.ts", "minor.ts"]);
    expect((await recheckPlan(root, "audit", undefined, graph)).paths).toEqual([]);
    expect(await remediationItems(root, "review", "review-2")).toEqual([]);
  });
});
