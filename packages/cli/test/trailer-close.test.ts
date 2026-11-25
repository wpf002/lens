import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanAndSave, writeJsonAtomic } from "@lens/core";
import { auditPath, closeFindingsFixedInCommits, remediationItems, type AuditRecord } from "../src/enrich.js";
import { layoutPlanPath, loadLayoutPlan, type LayoutPlanRecord } from "../src/layout-plan.js";

const FIX = path.resolve(__dirname, "../../core/test/fixtures/vuln-app");
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();
const AUDITED_AT = "2001-01-01T00:00:00Z";

// The scanner can't see IDOR, so only the audit fails it; the scanner itself fails XSS on this fixture.
const AI_ONLY = "t1-idor";
const SCANNER_FAILS = "t2-xss";

describe("Lens-Fixed trailers on Security and Architecture items", () => {
  let dir: string;
  const open = async () => new Set((await remediationItems(dir, "audit", undefined, Infinity)).map((i) => i.id));

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "lens-trailer-items-"));
    await fs.cp(FIX, dir, { recursive: true });
    git(dir, "init", "-q", "-b", "main");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "init", "--date=2000-01-01T00:00:00Z");
    await scanAndSave(dir);
    const audit: AuditRecord = {
      generatedAt: AUDITED_AT,
      report: "SECURITY_AUDIT.md",
      items: [
        { id: AI_ONLY, status: "fail", evidence: ["api/notes.ts:4 loads by id alone"] },
        { id: SCANNER_FAILS, status: "fail", evidence: ["web/Editor.tsx:9 unsanitized"] },
      ],
    };
    await writeJsonAtomic(auditPath(dir), audit);
    const plan: LayoutPlanRecord = {
      generatedAt: AUDITED_AT,
      summary: "Group by feature",
      areas: [
        { id: "api", title: "API", reason: "flat", moves: [], status: "planned", dropped: 0 },
        { id: "web", title: "Web", reason: "flat", moves: [], status: "planned", dropped: 0 },
      ],
    };
    await writeJsonAtomic(layoutPlanPath(dir), plan);
    await fs.writeFile(path.join(dir, "README.md"), "fixed\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", `Scope note lookups\n\nLens-Fixed: ${AI_ONLY}\nLens-Fixed: ${SCANNER_FAILS}\nLens-Fixed: layout-api`);
  });
  afterAll(async () => fs.rm(dir, { recursive: true, force: true }));

  it("closes an audit-only check, keeps one the scanner still fails, and marks the named area moved", async () => {
    const before = await open();
    expect(before.has(AI_ONLY) && before.has(SCANNER_FAILS)).toBe(true);

    await closeFindingsFixedInCommits(dir);

    const after = await open();
    expect(after.has(AI_ONLY)).toBe(false);
    expect(after.has(SCANNER_FAILS)).toBe(true);
    const plan = await loadLayoutPlan(dir);
    expect(plan?.areas.map((a) => `${a.id}:${a.status}`)).toEqual(["api:applied", "web:planned"]);
  });

  it("reopens the check when a newer audit fails it again", async () => {
    const audit: AuditRecord = { generatedAt: new Date(Date.now() + 60_000).toISOString(), report: "SECURITY_AUDIT.md", items: [{ id: AI_ONLY, status: "fail", evidence: ["api/notes.ts:4 still loads by id alone"] }] };
    await writeJsonAtomic(auditPath(dir), audit);
    expect((await open()).has(AI_ONLY)).toBe(true);
  });
});
