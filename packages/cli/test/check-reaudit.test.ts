import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanAndSave, writeJsonAtomic } from "@lens/core";
import { auditPath, remediationItems, type AuditRecord } from "../src/enrich.js";
import { remediationPath, type RemediationRecord } from "../src/remediate.js";

const FIX = path.resolve(__dirname, "../../core/test/fixtures/vuln-app");
const CHECK = "t2-xss";

// Remediate fixed one spot of a failing check, the re-audit still failed it elsewhere, and no run offered it again.
describe("a fixed check the audit still fails", () => {
  let dir: string;
  const audit = (at: string): AuditRecord => ({ generatedAt: at, report: "SECURITY_AUDIT.md", items: [{ id: CHECK, status: "fail", evidence: ["web/Editor.tsx:9 still unsanitized"] }] });
  const fixed = (at: string): RemediationRecord => ({
    generatedAt: at,
    source: "audit",
    fixes: [{ id: "f1", itemId: CHECK, title: "Sanitize notes", explanation: "x", status: "applied", diffs: [] } as never],
    skipped: [],
    edits: {},
  });

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "lens-reaudit-"));
    await fs.cp(FIX, dir, { recursive: true });
    await scanAndSave(dir);
  });
  afterAll(async () => fs.rm(dir, { recursive: true, force: true }));

  const offered = async () => (await remediationItems(dir, "audit", undefined, Infinity)).some((i) => i.id === CHECK);

  it("waits for the audit after a fix", async () => {
    await writeJsonAtomic(auditPath(dir), audit("2026-01-01T00:00:00Z"));
    await writeJsonAtomic(remediationPath(dir, "audit"), fixed("2026-01-02T00:00:00Z"));
    expect(await offered()).toBe(false);
  });

  it("offers it again once a newer audit still fails it", async () => {
    await writeJsonAtomic(auditPath(dir), audit("2026-01-03T00:00:00Z"));
    expect(await offered()).toBe(true);
  });
});
