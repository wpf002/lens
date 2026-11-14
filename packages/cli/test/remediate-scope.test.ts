import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { paths, scanAndSave } from "@lens/core";
import { fixAllPlan, remediationItems, REFACTOR_CHECKS, setWontFix } from "../src/enrich.js";
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
