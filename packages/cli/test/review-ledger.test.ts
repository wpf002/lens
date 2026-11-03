import { describe, expect, it } from "vitest";
import { reviewKey } from "@lens/core";
import { mergeReview, pendingReview, planBatches, priorFindingsFor, type StoredFinding } from "../src/review-ledger.js";

const finding = (title: string, path = "a.ts", extra: Partial<StoredFinding> = {}): StoredFinding => ({ title, severity: "medium", category: "design", path, detail: `${title} detail`, ...extra });
const ctx = (over: Partial<Parameters<typeof mergeReview>[2]> = {}) => ({ reviewed: new Set(["a.ts"]), existing: new Set(["a.ts", "b.ts"]), fixed: new Set<number>(), wontFix: new Set<string>(), now: "2026-11-03T00:00:00.000Z", ...over });

describe("review ledger", () => {
  it("keeps ids stable: re-reported open findings refresh in place, new ones append", () => {
    const prior = [finding("One"), finding("Two")];
    const { findings, added } = mergeReview(prior, { findings: [{ ...finding("Two"), line: 9, priorId: "review-1" }, finding("Three")], resolved: [] }, ctx());
    expect(findings.map((f) => f.title)).toEqual(["One", "Two", "Three"]);
    expect(findings[1]!.line).toBe(9);
    expect(added).toEqual([2]);
    expect(findings[0]!.resolvedAt).toBeUndefined(); // not re-reported, not listed as resolved: stays open
  });

  it("matches by title and path when the reviewer omits priorId", () => {
    const { findings, added } = mergeReview([finding("One")], { findings: [finding("One")], resolved: [] }, ctx());
    expect(findings).toHaveLength(1);
    expect(added).toEqual([]);
  });

  it("brings back a fixed finding as a regression and drops a Won't Fix one", () => {
    const prior = [finding("Fixed"), finding("Kept")];
    const { findings, added } = mergeReview(prior, { findings: [{ ...finding("Fixed"), priorId: "review-0" }, finding("Kept")], resolved: [] }, ctx({ fixed: new Set([0]), wontFix: new Set([reviewKey(prior[1]!)]) }));
    expect(added).toEqual([2]);
    expect(findings[2]).toMatchObject({ title: "Fixed", regressionOf: 0 });
    expect(findings).toHaveLength(3);
  });

  it("resolves only findings the reviewer confirmed gone in files it reviewed, or in deleted files", () => {
    const prior = [finding("Gone"), finding("Elsewhere", "b.ts"), finding("Deleted", "old.ts"), finding("Unchecked")];
    const { findings } = mergeReview(prior, { findings: [], resolved: ["review-0", "review-1", "review-99"] }, ctx());
    expect(findings.map((f) => !!f.resolvedAt)).toEqual([true, false, true, false]);
  });

  it("ignores a priorId that points at another file", () => {
    const { findings, added } = mergeReview([finding("One", "b.ts")], { findings: [{ ...finding("New"), priorId: "review-0" }], resolved: [] }, ctx());
    expect(added).toEqual([1]);
    expect(findings[0]!.title).toBe("One");
  });

  it("tells the reviewer each prior finding's status in its files", () => {
    const prior = [finding("One"), finding("Two", "b.ts"), finding("Three", "a.ts", { resolvedAt: "x" })];
    const out = priorFindingsFor(prior, new Set(["a.ts"]), { fixed: new Set(), wontFix: new Set() });
    expect(out.map((p) => [p.id, p.status])).toEqual([["review-0", "open"], ["review-2", "closed"]]);
  });

  it("reviews only new or changed files and batches them by directory", () => {
    const files = [{ path: "src/a.ts", loc: 10 }, { path: "src/b.ts", loc: 10 }, { path: "lib/c.ts", loc: 10 }];
    const hashes = new Map([["src/a.ts", "1"], ["src/b.ts", "2"], ["lib/c.ts", "3"]]);
    expect(pendingReview(files, hashes, { "src/a.ts": "1", "src/b.ts": "old" }).map((f) => f.path)).toEqual(["src/b.ts", "lib/c.ts"]);
    const batches = planBatches([...files, { path: "src/big.ts", loc: 5000 }], 25, 1000);
    expect(batches.map((b) => b.map((f) => f.path))).toEqual([["lib/c.ts", "src/a.ts", "src/b.ts"], ["src/big.ts"]]);
  });
});
