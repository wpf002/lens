import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { paths, scanAndSave } from "@lens/core";
import { countFixRuns, fixAllPlan, fixPrompt, nextFixBatch, buildFixPrompt, pickFixBatch, remediationItems, reviewPath, REFACTOR_CHECKS, SAME_CHECK_BATCH, setWontFix } from "../src/enrich.js";
import { itemRate, recordFixCost } from "../src/fix-costs.js";

const FIX = path.resolve(__dirname, "../../core/test/fixtures/vuln-app");

// Remediate must hand every Health check and every Security finding to Claude, so nothing stays Open after a run.
describe("Remediate scope", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "lens-scope-"));
    await fs.cp(FIX, dir, { recursive: true });
    await scanAndSave(dir);
    const file = paths(dir).graph;
    const graph = JSON.parse(await fs.readFile(file, "utf8"));
    graph.health.checks.push({ id: "oversized", title: "Oversized File", severity: "low", count: 1, fix: "Split it.", hits: [{ path: "app.js", detail: "900 lines" }] });
    const sample = graph.security.findings[0];
    graph.security.findings.push({ ...sample, id: `${sample.id}-low`, rule: `${sample.rule}-low`, line: 999, severity: "low", status: "open", title: "Low Finding" });
    await fs.writeFile(file, JSON.stringify(graph));
  });
  afterAll(async () => fs.rm(dir, { recursive: true, force: true }));

  it("includes refactor-check hits in a Health run", async () => {
    const items = await remediationItems(dir, "health", undefined, Infinity);
    expect(items.some((i) => REFACTOR_CHECKS.has(i.id.split("~")[0]!))).toBe(true);
  });

  it("includes low-severity Security findings in an audit run", async () => {
    const items = await remediationItems(dir, "audit", undefined, Infinity);
    expect(items.some((i) => i.title === "Low Finding")).toBe(true);
  });

  it("puts every open Health item in the Copy Prompt text, with its file and fix", async () => {
    const items = await remediationItems(dir, "health", undefined, Infinity);
    const prompt = fixPrompt("health", items);
    expect(prompt.split("\n").filter((l) => /^\d+\. /.test(l))).toHaveLength(items.length);
    expect(prompt).toContain("app.js 900 lines");
    expect(prompt).toContain("Fix: Split it.");
  });

  it("puts the files waiting for review ahead of the open items", async () => {
    const saved = await buildFixPrompt(dir, "health");
    expect(saved.reviewFiles).toBeGreaterThan(0);
    const review = saved.prompt.indexOf("## Step 1: Review");
    const fix = saved.prompt.indexOf("## Step 2: Fix");
    expect(review).toBeGreaterThan(-1);
    expect(fix).toBeGreaterThan(review);
    expect(saved.prompt.slice(review, fix).split("\n").filter((l) => l.startsWith("- "))).toHaveLength(saved.reviewFiles);
  });

  it("prices refactors on top of batch fixes", async () => {
    const plan = await fixAllPlan(dir, "health");
    expect(plan.items).toBeGreaterThan(0);
    expect(plan.estimate.limit).toBeGreaterThanOrEqual(8);
  });

  it("counts only open rows, so Won't Fix rows don't inflate the Fix All count", async () => {
    const before = await fixAllPlan(dir, "health");
    const [first] = await remediationItems(dir, "health", undefined, Infinity);
    await setWontFix(dir, first!.id, true);
    const after = await fixAllPlan(dir, "health");
    expect(after.items).toBe(before.items - 1);
    expect(after.items).toBe((await remediationItems(dir, "health", undefined, Infinity)).length);
    await setWontFix(dir, first!.id, false);
  });

  it("prices Fix All from the project's logged fix costs once there are enough runs", async () => {
    const before = await fixAllPlan(dir, "health");
    for (const usd of [0.02, 0.02, 0.02, 0.02]) await recordFixCost(dir, "batch", { items: 2, usd });
    const after = await fixAllPlan(dir, "health");
    expect(after.estimate.high).toBeLessThan(before.estimate.high);
    await fs.rm(path.join(paths(dir).dir, "fix-costs.json"));
  });

  it("never shows a high end above the run's limit", async () => {
    for (const usd of [500, 500, 500]) await recordFixCost(dir, "batch", { items: 1, usd });
    const plan = await fixAllPlan(dir, "health");
    expect(plan.estimate.high).toBe(plan.estimate.limit);
    expect(plan.estimate.low).toBeLessThanOrEqual(plan.estimate.limit);
    await fs.rm(path.join(paths(dir).dir, "fix-costs.json"));
  });
});

describe("itemRate", () => {
  const fallback = { low: 0.15, high: 0.4 };

  it("keeps the default until three runs are logged", () => {
    expect(itemRate([{ items: 5, usd: 5 }, { items: 5, usd: 5 }], fallback)).toEqual(fallback);
  });

  it("uses the 25th and 75th percentile of per-item cost", () => {
    const runs = [0.1, 0.2, 0.3, 0.4].map((perItem) => ({ items: 5, usd: perItem * 5 }));
    const rate = itemRate(runs, fallback);
    expect(rate.low).toBeCloseTo(0.2);
    expect(rate.high).toBeCloseTo(0.4);
  });
});

describe("nextFixBatch", () => {
  const hits = (check: string, n: number) => Array.from({ length: n }, (_, k) => ({ id: `${check}~h${k}` }));

  it("sends up to SAME_CHECK_BATCH hits of one check together", () => {
    const batch = nextFixBatch([...hits("swallowed-errors", 40), ...hits("console-logs", 3)]);
    expect(batch).toHaveLength(SAME_CHECK_BATCH);
    expect(batch.every((i) => i.id.startsWith("swallowed-errors~"))).toBe(true);
  });

  it("mixes small checks and review findings five at a time", () => {
    const batch = nextFixBatch([{ id: "review-1" }, ...hits("console-logs", 2), ...hits("swallowed-errors", 30)]);
    expect(batch.map((i) => i.id)).toEqual(["review-1", "console-logs~h0", "console-logs~h1", "swallowed-errors~h0", "swallowed-errors~h1"]);
  });

  it("runs a refactor alone", () => {
    expect(nextFixBatch([{ id: "oversized~a" }, ...hits("swallowed-errors", 10)])).toEqual([{ id: "oversized~a" }]);
  });
});

describe("pickFixBatch", () => {
  const hit = (id: string, file: string) => ({ id, evidence: [`${file}:3 detail`] });

  it("skips items in files a running batch is editing", () => {
    const running = [hit("swallowed-errors~a", "src/a.ts")];
    const left = [hit("swallowed-errors~b", "src/a.ts"), hit("console-logs~c", "src/b.ts")];
    expect(pickFixBatch(left, running, new Set()).map((i) => i.id)).toEqual(["console-logs~c"]);
  });

  it("starts a refactor only when nothing else runs, and nothing beside it", () => {
    const refactor = hit("oversized~r", "src/big.ts");
    const other = hit("console-logs~c", "src/b.ts");
    expect(pickFixBatch([refactor, other], [other], new Set())).toEqual([]);
    expect(pickFixBatch([refactor, other], [], new Set())).toEqual([refactor]);
    expect(pickFixBatch([other], [refactor], new Set())).toEqual([]);
  });
});

describe("countFixRuns", () => {
  const hits = (check: string, n: number) => Array.from({ length: n }, (_, k) => ({ id: `${check}~h${k}` }));

  it("counts one run per batch nextFixBatch would pick", () => {
    expect(countFixRuns([...hits("swallowed-errors", 30), ...hits("console-logs", 3), { id: "oversized~a" }])).toBe(4);
  });

  it("counts each item marked to run alone as its own run", () => {
    const items = hits("swallowed-errors", 6);
    expect(countFixRuns(items, new Set(items.slice(0, 2).map((i) => i.id)))).toBe(3);
  });
});

// Beza's remediation.json predates per-source files: its "review-2" meant the second high or medium finding.
describe("Copy Prompt with a legacy review record", () => {
  let dir: string;
  const finding = (title: string, severity: string) => ({ title, severity, path: "a.ts", line: 1, detail: title, fix: "Fix it." });

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "lens-legacy-"));
    await fs.mkdir(paths(dir).dir, { recursive: true });
    const at = "2026-10-23T15:10:00.000Z";
    await fs.writeFile(reviewPath(dir), JSON.stringify({ generatedAt: at, stableSince: at, findings: [finding("First", "high"), finding("Second", "high"), finding("Third", "low")] }));
    const fixes = ["review-1", "review-2"].map((itemId, k) => ({ id: `fix-${k}`, itemId, title: itemId, explanation: "", status: "applied" }));
    await fs.writeFile(path.join(paths(dir).dir, "remediation.json"), JSON.stringify({ source: "review", generatedAt: "2026-10-23T15:14:00.000Z", fixes, skipped: [] }));
  });
  afterAll(async () => fs.rm(dir, { recursive: true, force: true }));

  it("keeps the open low finding the Health tab still shows", async () => {
    const items = await remediationItems(dir, "health", undefined, Infinity);
    expect(items.map((i) => i.title)).toEqual(["Third"]);
  });
});
