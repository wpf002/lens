import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { collectChanges, makeWorkspace } from "../src/workspace.js";
import { applyFixes, buildRecord, remediationPath, undoFix } from "../src/remediate.js";
import { writeJsonAtomic } from "@lens/core";
import { lockfileFor } from "../src/lockfile.js";

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

function hasTool(command: string): boolean {
  try {
    // Run outside the repo: corepack refuses yarn inside a pnpm project.
    execFileSync(command, ["--version"], { stdio: "pipe", cwd: os.tmpdir() });
    return true;
  } catch {
    return false;
  }
}

/** Applies a fix that rewrites `manifestRel`, checks the lockfile picked it up, then Undo restores both. */
async function applyThenUndo(root: string, manifestRel: string, manifestAfter: string, lockRel: string, added: string): Promise<void> {
  const lockPath = path.join(root, lockRel);
  const manifestPath = path.join(root, manifestRel);
  const lockBefore = await fs.readFile(lockPath, "utf8");
  const manifestBefore = await fs.readFile(manifestPath, "utf8");
  const ws = await makeWorkspace(root);
  await fs.writeFile(path.join(ws, manifestRel), manifestAfter);
  const { data } = await collectChanges(root, ws, {
    fixes: [{ itemId: "dep", title: "Add dep", explanation: `Added ${added}.`, files: [manifestRel] }],
    skipped: [],
  });
  const rec = buildRecord(root, "health", data, 0, undefined, "t");
  await writeJsonAtomic(remediationPath(root, "health"), rec);

  const { applied, failed } = await applyFixes(root, "health", rec.fixes.map((f) => f.id));
  expect(failed).toEqual([]);
  expect(applied).toHaveLength(1);
  expect(await fs.readFile(lockPath, "utf8")).toContain(added);

  await undoFix(root, "health", applied[0]!);
  expect(await fs.readFile(lockPath, "utf8")).toBe(lockBefore);
  expect(await fs.readFile(manifestPath, "utf8")).toBe(manifestBefore);
  await fs.rm(ws, { recursive: true, force: true });
}

describe("lockfile sync for other package managers", () => {
  it.skipIf(!hasTool("yarn"))("regenerates a Yarn Classic yarn.lock without touching node_modules", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "lens-lock-yarn-"));
    await fs.mkdir(path.join(root, "local-font"));
    await fs.writeFile(path.join(root, "local-font/package.json"), JSON.stringify({ name: "local-font", version: "1.0.0" }));
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "app", version: "1.0.0", dependencies: {} }, null, 2));
    const seedModules = await fs.mkdtemp(path.join(os.tmpdir(), "lens-lock-yarn-modules-"));
    execFileSync("yarn", ["install", "--offline", "--ignore-scripts", "--modules-folder", seedModules], { cwd: root, stdio: "pipe" });
    await fs.rm(seedModules, { recursive: true, force: true });
    const manifest = JSON.stringify({ name: "app", version: "1.0.0", dependencies: { "local-font": "file:local-font" } }, null, 2);
    await applyThenUndo(root, "package.json", manifest, "yarn.lock", "local-font");
    // Classic installs into a temp folder, so the project gets no node_modules.
    await expect(fs.access(path.join(root, "node_modules"))).rejects.toThrow();
    await fs.rm(root, { recursive: true, force: true });
  }, NPM_TIMEOUT_MS);

  it.skipIf(!hasTool("uv"))("regenerates uv.lock when a fix adds a dependency", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "lens-lock-uv-"));
    const pkg = path.join(root, "localpkg");
    await fs.mkdir(path.join(pkg, "localpkg"), { recursive: true });
    await fs.writeFile(path.join(pkg, "localpkg/__init__.py"), "");
    await fs.writeFile(path.join(pkg, "pyproject.toml"), [
      "[project]", 'name = "localpkg"', 'version = "1.0.0"', "",
      "[build-system]", 'requires = ["hatchling"]', 'build-backend = "hatchling.build"', "",
    ].join("\n"));
    const project = (deps: string, sources: string) => [
      "[project]", 'name = "app"', 'version = "1.0.0"', 'requires-python = ">=3.9"', `dependencies = [${deps}]`, "", sources,
    ].join("\n");
    await fs.writeFile(path.join(root, "pyproject.toml"), project("", ""));
    const previousOffline = process.env.UV_OFFLINE;
    process.env.UV_OFFLINE = "1";
    try {
      execFileSync("uv", ["lock"], { cwd: root, stdio: "pipe" });
      const after = project('"localpkg"', '[tool.uv.sources]\nlocalpkg = { path = "localpkg" }\n');
      await applyThenUndo(root, "pyproject.toml", after, "uv.lock", "localpkg");
    } finally {
      if (previousOffline === undefined) delete process.env.UV_OFFLINE;
      else process.env.UV_OFFLINE = previousOffline;
      await fs.rm(root, { recursive: true, force: true });
    }
  }, NPM_TIMEOUT_MS);

  it("maps each manifest to the lockfile the project has", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "lens-lock-map-"));
    await fs.mkdir(path.join(root, "svc"));
    expect(lockfileFor(root, "svc/pyproject.toml")).toBeNull();
    for (const file of ["poetry.lock", "pdm.lock", "uv.lock"]) {
      await fs.writeFile(path.join(root, file), "");
      expect(lockfileFor(root, "svc/pyproject.toml")?.lockRel).toBe(file);
      await fs.rm(path.join(root, file));
    }
    await fs.writeFile(path.join(root, "bun.lock"), "");
    expect(lockfileFor(root, "package.json")?.locker.command).toBe("bun");
    expect(lockfileFor(root, "svc/pyproject.toml")).toBeNull();
    await fs.rm(root, { recursive: true, force: true });
  });
});
