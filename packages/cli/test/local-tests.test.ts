import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkLocalTests, newFailures, testPlan } from "../src/local-tests.js";

/** A git repo whose `npm test` prints a vitest-style failure line for each wrong answer in lib.js. */
async function repoWithTests(lib: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lens-local-tests-"));
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "app", private: true, scripts: { test: "node check.js" } }));
  await fs.writeFile(
    path.join(root, "check.js"),
    'const { add, sub } = require("./lib.js");\nlet bad = 0;\nif (add(1, 2) !== 3) { console.log(" × adds numbers"); bad++; }\nif (sub(3, 1) !== 2) { console.log(" × subtracts numbers"); bad++; }\nprocess.exit(bad ? 1 : 0);\n',
  );
  await fs.writeFile(path.join(root, "lib.js"), lib);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init", "-q");
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "base");
  return root;
}

const outcome = (ok: boolean, log: string) => ({ ok, log, timedOut: false });

describe("local test check", () => {
  it("blocks only the failures Lens's edits introduce", () => {
    expect(newFailures(outcome(false, " × adds numbers\n × subtracts numbers"), outcome(false, " × subtracts numbers"))).toMatchObject({ state: "broken", tests: ["adds numbers"] });
    expect(newFailures(outcome(false, " × subtracts numbers"), outcome(false, " × subtracts numbers"))).toEqual({ state: "passed" });
    expect(newFailures(outcome(false, "error TS2304: Cannot find name 'x'"), outcome(true, ""))).toMatchObject({ state: "broken", tests: [] });
  });

  it("tests only the changed workspace packages and what depends on them", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "lens-plan-"));
    await fs.mkdir(path.join(root, "packages/api/src"), { recursive: true });
    await fs.writeFile(path.join(root, "package.json"), "{}");
    await fs.writeFile(path.join(root, "pnpm-workspace.yaml"), "packages: ['packages/*']\n");
    await fs.writeFile(path.join(root, "pnpm-lock.yaml"), "");
    await fs.writeFile(path.join(root, "packages/api/package.json"), "{}");
    expect((await testPlan(root, ["packages/api/src/sync.ts"]))?.run).toEqual(["pnpm", "--filter", "...{./packages/api}", "-r", "--no-bail", "run", "--if-present", "test"]);
    expect((await testPlan(root, ["tsconfig.json"]))?.run).not.toContain("--filter");
    await fs.rm(root, { recursive: true, force: true });
  });

  it("reports a test the edits break and passes one that was already failing", async () => {
    const root = await repoWithTests("exports.add = (a, b) => a + b;\nexports.sub = (a, b) => a + b;\n");
    await fs.writeFile(path.join(root, "lib.js"), "exports.add = (a, b) => a * b;\nexports.sub = (a, b) => a + b;\n");
    expect(await checkLocalTests(root)).toMatchObject({ state: "broken", tests: ["adds numbers"] });

    await fs.writeFile(path.join(root, "lib.js"), "exports.add = (a, b) => a + b;\nexports.sub = (a, b) => a + b; // unchanged\n");
    expect(await checkLocalTests(root)).toEqual({ state: "passed" });
    expect(execFileSync("git", ["worktree", "list"], { cwd: root, encoding: "utf8" }).trim().split("\n")).toHaveLength(1);
    await fs.rm(root, { recursive: true, force: true });
  });

  it("skips a project with no test script", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "lens-no-tests-"));
    expect(await testPlan(root, ["a.ts"])).toBeNull();
    await fs.rm(root, { recursive: true, force: true });
  });
});
