import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { paths, writeJsonAtomic } from "@lens/core";
import { MAX_TEST_REPAIRS, allowAnotherRepair, compareRuns, errorExcerpt, failedTests, gateNeedsWork, repairItems, staleBaseRuns, type TestGate } from "../src/ci.js";
import { mergeBlock } from "../src/cloud.js";

const PYTEST_LOG = [
  "2026-11-03T22:40:01.1234567Z ERROR    main:main.py:126 Unhandled exception on POST /api/alerts/subscribe",
  "2026-11-03T22:40:01.1234567Z ============ short test summary info ============",
  "2026-11-03T22:40:01.1234567Z FAILED tests/test_xml.py::test_parse - AttributeError: 'XMLParser' object has no attribute 'parser'",
  "2026-11-03T22:40:01.1234567Z FAILED tests/test_analytics.py::test_forwarded_for_takes_leftmost_client",
  "2026-11-03T22:40:01.1234567Z FAILED tests/test_alerts.py::test_subscribe_reports_send_failure - RuntimeError: DB pool not initialised",
  "2026-11-03T22:40:01.1234567Z ======= 3 failed, 120 passed in 9.1s =======",
].join("\n");

const VITEST_LOG = [" FAIL  src/App.test.tsx > renders", " × renders the header 12ms", " ✓ keeps working 3ms"].join("\n");

describe("CI log parsing", () => {
  it("reads failing test names from pytest and vitest output", () => {
    expect(failedTests(PYTEST_LOG)).toEqual(["tests/test_xml.py::test_parse", "tests/test_analytics.py::test_forwarded_for_takes_leftmost_client", "tests/test_alerts.py::test_subscribe_reports_send_failure"]);
    expect(failedTests(VITEST_LOG)).toEqual(["src/App.test.tsx", "renders the header"]);
    expect(failedTests("--- FAIL: TestHandler (0.01s)\ntest api::parse ... FAILED")).toEqual(["TestHandler", "api::parse"]);
  });

  it("keeps the error lines without timestamps", () => {
    const excerpt = errorExcerpt(PYTEST_LOG);
    expect(excerpt).toContain("AttributeError");
    expect(excerpt).not.toMatch(/2026-11-03T/);
  });
});

describe("test gate", () => {
  it("blames Lens only for tests that pass on the base commit", () => {
    const head = [
      { name: "backend", failed: true, tests: ["t::alerts", "t::xml", "t::analytics"], excerpt: "x" },
      { name: "frontend", failed: true, tests: [], excerpt: "audit" },
      { name: "lint", failed: true, tests: [], excerpt: "lint" },
      { name: "build", failed: false, tests: [], excerpt: "" },
    ];
    const base = [
      { name: "backend", failed: true, tests: ["t::alerts"], excerpt: "" },
      { name: "frontend", failed: true, tests: [], excerpt: "" },
      { name: "lint", failed: false, tests: [], excerpt: "" },
    ];
    const { broken, preexisting } = compareRuns(head, base);
    expect(broken).toEqual([
      { name: "backend", tests: ["t::xml", "t::analytics"], excerpt: "x" },
      { name: "lint", tests: [], excerpt: "lint" },
    ]);
    expect(preexisting).toBe(1);
  });

  it("re-runs a base-commit pass that's hours old before blaming Lens (lockfile drift on PR #23)", () => {
    const now = Date.parse("2026-11-06T17:12:00Z");
    const broken = [{ name: "Backend tests & audit", tests: [], excerpt: "requirements.txt is out of date" }];
    const base = [
      { id: 1, name: "Backend tests & audit", completed_at: "2026-11-05T17:25:00Z" },
      { id: 2, name: "Frontend tests & audit", completed_at: "2026-11-05T17:25:00Z" },
    ];
    expect(staleBaseRuns(broken, base, now).map((r) => r.id)).toEqual([1]);
    expect(staleBaseRuns(broken, [{ ...base[0]!, completed_at: "2026-11-06T16:00:00Z" }], now)).toEqual([]);
  });

  it("blocks Merge while tests run or when Lens broke some", () => {
    const gate: TestGate = { pr: 1, sha: "a", state: "broken", broken: [{ name: "backend", tests: ["a", "b"], excerpt: "" }], preexisting: 0, attempts: 0 };
    expect(mergeBlock({ tests: gate })).toMatch(/break 2 tests/);
    expect(mergeBlock({ tests: { ...gate, state: "running" } })).toMatch(/still running/);
    expect(mergeBlock({ tests: { ...gate, state: "passed", broken: [] } })).toBeNull();
    expect(mergeBlock({ tests: { ...gate, state: "none", broken: [] } })).toBeNull();
    expect(mergeBlock({})).not.toBeNull();
    expect(mergeBlock({ tests: { ...gate, state: "passed", broken: [] }, conflicts: true })).toMatch(/conflict/);
  });

  it("hands the remediator the failing tests, log, and changed files", () => {
    const gate: TestGate = { pr: 1, sha: "a", state: "broken", broken: [{ name: "backend", tests: ["t::xml"], excerpt: "AttributeError" }], preexisting: 0, attempts: 0 };
    const [item] = repairItems(gate, ["backend/services/xml_safe.py"]);
    expect(item?.id).toBe("tests-1");
    expect(item?.evidence.join("\n")).toContain("t::xml");
    expect(item?.evidence.join("\n")).toContain("AttributeError");
    expect(item?.evidence.join("\n")).toContain("backend/services/xml_safe.py");
  });

  it("lets Fix Tests start another repair once the automatic ones are used up", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "lens-fix-tests-"));
    const gate: TestGate = { pr: 19, sha: "a", state: "broken", broken: [{ name: "build", tests: [], excerpt: "Cannot find package 'zod'" }], preexisting: 0, attempts: MAX_TEST_REPAIRS };
    await writeJsonAtomic(path.join(paths(root).dir, "test-gate.json"), gate, true);
    expect(gateNeedsWork(gate)).toBe(false);

    expect(await allowAnotherRepair(root, 19)).toBe(true);
    const saved = JSON.parse(await fs.readFile(path.join(paths(root).dir, "test-gate.json"), "utf8")) as TestGate;
    expect(gateNeedsWork(saved)).toBe(true);
    expect(await allowAnotherRepair(root, 19)).toBe(false);
    expect(repairItems(saved, [])[0]?.evidence.join("\n")).toMatch(/2 earlier repair attempts/);
  });
});
