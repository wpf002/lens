import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeFindingsFixedInCommits, closeFindingsOnChangedCode, followFileMoves, reviewPath, type ReviewRecord } from "../src/enrich.js";
import { hashFiles } from "../src/review-ledger.js";

const run = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();
const finding = (title: string, file: string) => ({ title, severity: "medium" as const, category: "design", path: file, detail: title, foundAt: "2000-01-01T00:00:00.000Z" });

describe("followFileMoves", () => {
  it("re-points findings at renamed files in a shallow clone and closes ones whose file was deleted", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lens-moves-"));
    const origin = path.join(tmp, "origin");
    run(tmp, "init", "-q", "-b", "main", origin);
    await fs.mkdir(path.join(origin, "src"));
    await fs.writeFile(path.join(origin, "src/auth.ts"), "export const a = 1;\n");
    await fs.writeFile(path.join(origin, "src/old.ts"), "export const b = 2;\n");
    run(origin, "add", "-A");
    run(origin, "commit", "-qm", "init");
    await fs.mkdir(path.join(origin, "src/auth"));
    run(origin, "mv", "src/auth.ts", "src/auth/auth.ts");
    run(origin, "rm", "-q", "src/old.ts");
    run(origin, "commit", "-qm", "move auth, drop old");
    await fs.writeFile(path.join(origin, "README.md"), "x\n");
    run(origin, "add", "-A");
    run(origin, "commit", "-qm", "later");

    const root = path.join(tmp, "work");
    run(tmp, "clone", "-q", "--depth", "1", `file://${origin}`, root);
    await fs.mkdir(path.join(root, ".lens"));
    const record: ReviewRecord = { generatedAt: "2000-01-01T00:00:00.000Z", report: "REVIEW.md", findings: [finding("Moved", "src/auth.ts"), finding("Deleted", "src/old.ts")] };
    await fs.writeFile(reviewPath(root), JSON.stringify(record));

    await followFileMoves(root);

    const saved = JSON.parse(await fs.readFile(reviewPath(root), "utf8")) as ReviewRecord;
    expect(saved.findings[0]).toMatchObject({ title: "Moved", path: "src/auth/auth.ts" });
    expect(saved.findings[0]!.resolvedAt).toBeUndefined();
    expect(saved.findings[1]!.resolvedAt).toBeTruthy();
  });
});

describe("closeFindingsOnChangedCode", () => {
  it("closes findings whose cited line is gone or whose file was mostly rewritten, and keeps the rest open", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "lens-gone-"));
    run(root, "init", "-q", "-b", "main");
    const before = ["export function load() {", "  return read().catch(() => new Map());", "}", "export const keep = compute(1, 2, 3);", ""].join("\n");
    await fs.writeFile(path.join(root, "a.ts"), before);
    await fs.writeFile(path.join(root, "b.ts"), "export const untouched = read().catch(() => null);\n");
    const split = ["export function register(app: App) {", "  app.get('/brief', buildBriefHandler);", "  app.get('/recap', buildRecapHandler);", "  app.post('/memory', saveMemoryHandler);", "}", ""].join("\n");
    await fs.writeFile(path.join(root, "c.ts"), split);
    run(root, "add", "-A");
    run(root, "commit", "-qm", "init", "--date=2000-01-01T00:00:00Z");
    await fs.mkdir(path.join(root, ".lens"));
    const hashes = await hashFiles(root, ["a.ts", "b.ts", "c.ts"]);
    await fs.writeFile(path.join(root, ".lens/review-coverage.json"), JSON.stringify(Object.fromEntries([...hashes].map(([rel, hash]) => [rel, [hash]]))));
    const foundAt = new Date(Date.now() + 1000).toISOString();
    const at = (title: string, file: string, line: number) => ({ ...finding(title, file), line, foundAt });
    const record: ReviewRecord = {
      generatedAt: foundAt,
      report: "REVIEW.md",
      findings: [at("Swallowed", "a.ts", 2), at("Still there", "a.ts", 4), at("Brace", "a.ts", 3), at("Unchanged file", "b.ts", 1), at("Module too big", "c.ts", 1)],
    };
    await fs.writeFile(reviewPath(root), JSON.stringify(record));
    await fs.writeFile(path.join(root, "a.ts"), before.replace("  return read().catch(() => new Map());", "  return read();"));
    await fs.writeFile(path.join(root, "c.ts"), ["export function register(app: App) {", "  registerBrief(app);", "}", ""].join("\n"));

    await closeFindingsOnChangedCode(root);

    const saved = JSON.parse(await fs.readFile(reviewPath(root), "utf8")) as ReviewRecord;
    expect(saved.findings.map((f) => (f.resolvedAt ? "closed" : "open"))).toEqual(["closed", "open", "open", "open", "closed"]);
  });
});

describe("closeFindingsFixedInCommits", () => {
  it("closes the findings a commit names in a Lens-Fixed trailer and leaves the rest open", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "lens-trailer-"));
    run(root, "init", "-q", "-b", "main");
    await fs.mkdir(path.join(root, ".lens"));
    const record: ReviewRecord = { generatedAt: "2000-01-01T00:00:00.000Z", report: "REVIEW.md", findings: [finding("Gate", "a.ts"), finding("Pay link", "b.ts"), finding("Capacity", "c.ts")] };
    await fs.writeFile(reviewPath(root), JSON.stringify(record));
    await fs.writeFile(path.join(root, "a.ts"), "export const a = 1;\n");
    run(root, "add", "a.ts");
    run(root, "commit", "-qm", "Tighten the write gate\n\nLens-Fixed: review-0\nLens-Fixed: review-2");

    await closeFindingsFixedInCommits(root);

    const saved = JSON.parse(await fs.readFile(reviewPath(root), "utf8")) as ReviewRecord;
    expect(saved.findings.map((f) => (f.resolvedAt ? "closed" : "open"))).toEqual(["closed", "open", "closed"]);
  });
});
