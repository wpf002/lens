import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { followFileMoves, reviewPath, type ReviewRecord } from "../src/enrich.js";

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
