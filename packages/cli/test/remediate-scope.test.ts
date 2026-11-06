import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { paths, scanAndSave } from "@lens/core";
import { fixAllPlan, remediationItems, REFACTOR_CHECKS } from "../src/enrich.js";

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
});
