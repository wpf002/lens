import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { collectChanges, makeWorkspace } from "../src/workspace.js";
import { applyFixes, buildRecord, remediationPath, undoFix } from "../src/remediate.js";
import { writeJsonAtomic } from "@lens/core";

const NPM_TIMEOUT_MS = 120_000;

async function npmProject(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lens-lock-test-"));
  const app = path.join(root, "frontend");
  await fs.mkdir(path.join(app, "local-font"), { recursive: true });
  await fs.writeFile(path.join(app, "local-font/package.json"), JSON.stringify({ name: "local-font", version: "1.0.0" }));
  await fs.writeFile(path.join(app, "package.json"), JSON.stringify({ name: "app", version: "1.0.0", dependencies: {} }, null, 2));
  execFileSync("npm", ["install", "--package-lock-only", "--ignore-scripts", "--offline"], { cwd: app, stdio: "pipe" });
  return root;
}

describe("lockfile sync", () => {
  it("regenerates package-lock.json when a fix adds a dependency, and Undo restores it (PR #24 npm ci failure)", async () => {
    const root = await npmProject();
    const lockPath = path.join(root, "frontend/package-lock.json");
    const lockBefore = await fs.readFile(lockPath, "utf8");
    const ws = await makeWorkspace(root);
    const manifest = { name: "app", version: "1.0.0", dependencies: { "local-font": "file:local-font" } };
    await fs.writeFile(path.join(ws, "frontend/package.json"), JSON.stringify(manifest, null, 2));
    const { data } = await collectChanges(root, ws, {
      fixes: [{ itemId: "fonts", title: "Self-host fonts", explanation: "Added local-font.", files: ["frontend/package.json"] }],
      skipped: [],
    });
    const rec = buildRecord(root, "health", data, 0, undefined, "t");
    await writeJsonAtomic(remediationPath(root, "health"), rec);

    const { applied, failed } = await applyFixes(root, "health", rec.fixes.map((f) => f.id));
    expect(failed).toEqual([]);
    expect(applied).toHaveLength(1);
    expect(await fs.readFile(lockPath, "utf8")).toContain("local-font");

    await undoFix(root, "health", applied[0]!);
    expect(await fs.readFile(lockPath, "utf8")).toBe(lockBefore);
    expect(await fs.readFile(path.join(root, "frontend/package.json"), "utf8")).not.toContain("local-font");
    await fs.rm(ws, { recursive: true, force: true });
    await fs.rm(root, { recursive: true, force: true });
  }, NPM_TIMEOUT_MS);

  it("rolls the fix back when the lockfile can't be resolved", async () => {
    const root = await npmProject();
    const manifestPath = path.join(root, "frontend/package.json");
    const manifestBefore = await fs.readFile(manifestPath, "utf8");
    const ws = await makeWorkspace(root);
    await fs.writeFile(path.join(ws, "frontend/package.json"), JSON.stringify({ name: "app", version: "1.0.0", dependencies: { broken: "npm:" } }));
    const { data } = await collectChanges(root, ws, {
      fixes: [{ itemId: "bad", title: "Bad dep", explanation: "x", files: ["frontend/package.json"] }],
      skipped: [],
    });
    const rec = buildRecord(root, "health", data, 0, undefined, "t");
    await writeJsonAtomic(remediationPath(root, "health"), rec);

    const { applied, failed } = await applyFixes(root, "health", rec.fixes.map((f) => f.id));
    expect(applied).toEqual([]);
    expect(failed[0]?.error).toMatch(/couldn't update frontend\/package-lock\.json/);
    expect(await fs.readFile(manifestPath, "utf8")).toBe(manifestBefore);
    await fs.rm(ws, { recursive: true, force: true });
    await fs.rm(root, { recursive: true, force: true });
  }, NPM_TIMEOUT_MS);
});
