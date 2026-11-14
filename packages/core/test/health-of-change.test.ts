import { describe, expect, it } from "vitest";
import { healthOfChange, type HealthReport } from "../src/index.js";

const report: HealthReport = {
  generatedAt: "",
  score: 50,
  checks: [
    { id: "swallowed-errors", title: "Swallowed Errors", category: "errors", severity: "high", count: 3, fix: "Handle it.", hits: [{ path: "old.ts", line: 2, detail: "old" }, { path: "old.ts", line: 9, detail: "edited" }, { path: "new.ts", line: 1, detail: "new" }] },
    { id: "dead-files", title: "Unused Files", category: "dead-code", severity: "medium", count: 2, fix: "Delete it.", hits: [{ path: "old.ts", detail: "old file" }, { path: "new.ts", detail: "new file" }] },
    { id: "untested", title: "Untested Files", category: "tests", severity: "medium", count: 1, fix: "Test it.", hits: [{ path: "new.ts", detail: "no test" }] },
  ],
};

describe("healthOfChange", () => {
  it("keeps only hits on changed lines and in new files, and skips project-wide checks", () => {
    const problems = healthOfChange(report, [
      { path: "old.ts", status: "M", hunks: [[8, 10]] },
      { path: "new.ts", status: "A", hunks: [] },
    ]);
    expect(problems.map((c) => [c.id, c.hits.map((h) => h.detail)])).toEqual([
      ["swallowed-errors", ["edited", "new"]],
      ["dead-files", ["new file"]],
    ]);
  });
});
