import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { findHistorySecrets, scanAndSave } from "../src/index.js";

// Built at runtime so this file doesn't trip secret scanners itself.
const AWS_KEY = ["AKIA", "Q3XJ7LMN2PRS4TUV"].join("");

describe("findHistorySecrets", () => {
  it("reports added lines only, once per key, redacted", () => {
    const log = [
      "commit:abc1234",
      "+++ b/config.js",
      `+const key = "${AWS_KEY}";`,
      "commit:def5678",
      "+++ b/other.js",
      `-const key = "${AWS_KEY}";`,
      `+const again = "${AWS_KEY}";`,
    ].join("\n");
    const hits = findHistorySecrets(log);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ commit: "abc1234", path: "config.js", title: "AWS access key id" });
    expect(hits[0]!.snippet).not.toContain(AWS_KEY);
  });
});

describe("t1-git-secrets", () => {
  let dir: string;
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { stdio: "ignore" });

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "lens-history-"));
    git("init", "-q");
    await fs.writeFile(path.join(dir, "config.js"), `export const key = "${AWS_KEY}";\n`);
    git("add", ".");
    git("commit", "-qm", "add key");
    await fs.writeFile(path.join(dir, "config.js"), "export const key = process.env.AWS_KEY;\n");
    git("commit", "-qam", "move key to env");
  });
  afterAll(async () => fs.rm(dir, { recursive: true, force: true }));

  it("finds a key deleted from the code but left in history", async () => {
    const { graph } = await scanAndSave(dir, { offline: true });
    const check = graph.security!.checklist!.find((c) => c.id === "t1-git-secrets")!;
    expect(check.status).toBe("manual");
    expect(check.evidence[0]).toContain("config.js: AWS access key id");
  });

  it("passes once history is clean", async () => {
    await fs.rm(path.join(dir, ".git"), { recursive: true, force: true });
    git("init", "-q");
    git("add", ".");
    git("commit", "-qm", "fresh");
    const { graph } = await scanAndSave(dir, { offline: true });
    const check = graph.security!.checklist!.find((c) => c.id === "t1-git-secrets")!;
    expect(check.status).toBe("pass");
    expect(check.evidence[0]).toContain("1 commit of git history");
  });
});
