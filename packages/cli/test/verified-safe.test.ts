import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { findingItemId, loadGraph, scanAndSave, writeJsonAtomic } from "@lens/core";
import { markVerifiedSafe } from "../src/enrich.js";
import { remediationPath, type RemediationRecord } from "../src/remediate.js";

const FIX = path.resolve(__dirname, "../../core/test/fixtures/vuln-app");

// Remediate skipped these as "Scanner was wrong", so they were never offered again but stayed Open.
describe("markVerifiedSafe", () => {
  let dir: string;
  let safeId: string;
  let otherId: string;
  let highBefore: number;

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "lens-safe-"));
    await fs.cp(FIX, dir, { recursive: true });
    const { graph } = await scanAndSave(dir);
    const [safe, other] = graph.security!.findings.filter((f) => f.status === "open" && f.severity === "high");
    safeId = safe!.id;
    otherId = other!.id;
    highBefore = graph.security!.summary!.bySeverity.high;
    const record: RemediationRecord = {
      generatedAt: new Date().toISOString(),
      source: "audit",
      fixes: [],
      edits: {},
      skipped: [
        { itemId: findingItemId(safe!), reason: "Scanner was wrong: the value is escaped before the query." },
        { itemId: findingItemId(other!), reason: "Decision: keep the shared password?" },
      ],
    };
    await writeJsonAtomic(remediationPath(dir, "audit"), record);
  });
  afterAll(async () => fs.rm(dir, { recursive: true, force: true }));

  it("closes only the findings Remediate found already safe", async () => {
    expect(await markVerifiedSafe(dir)).toBe(1);
    const findings = (await loadGraph(dir))!.security!.findings;
    const safe = findings.find((f) => f.id === safeId)!;
    expect(safe.status).toBe("false_positive");
    expect(safe.triageNote).toBe("the value is escaped before the query.");
    expect(findings.find((f) => f.id === otherId)!.status).toBe("open");
  });

  it("drops out of the open counts and survives a rescan", async () => {
    const { graph } = await scanAndSave(dir);
    expect(graph.security!.summary!.bySeverity.high).toBe(highBefore - 1);
    expect(graph.security!.findings.find((f) => f.id === safeId)!.status).toBe("false_positive");
  });

  it("does nothing the second time", async () => {
    expect(await markVerifiedSafe(dir)).toBe(0);
  });
});
