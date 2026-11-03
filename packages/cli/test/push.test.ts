import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pushFixes, pushPending } from "../src/cloud.js";

const run = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();

// Mimics GitHub refusing workflow edits from a credential without workflow scope.
const HOOK = `#!/bin/sh
while read old new ref; do
  if git diff-tree --no-commit-id --name-only -r "$new" | grep -q '^.github/workflows/'; then
    echo "refusing to allow an OAuth App to create or update workflow without workflow scope" >&2
    exit 1
  fi
done
`;

describe("pushFixes", () => {
  it("drops workflow edits and pushes the rest when GitHub rejects them", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lens-push-"));
    const remote = path.join(tmp, "remote.git");
    const root = path.join(tmp, "work");
    run(tmp, "init", "-q", "--bare", "-b", "main", remote);
    await fs.writeFile(path.join(remote, "hooks/pre-receive"), HOOK, { mode: 0o755 });
    run(tmp, "init", "-q", "-b", "main", root);
    await fs.mkdir(path.join(root, ".github/workflows"), { recursive: true });
    await fs.writeFile(path.join(root, ".github/workflows/ci.yml"), "on: push\n");
    await fs.writeFile(path.join(root, "a.js"), "1\n");
    run(root, "add", "-A");
    run(root, "commit", "-qm", "init");
    run(root, "remote", "add", "origin", remote);
    run(root, "push", "-q", "-u", "origin", "main");

    await fs.writeFile(path.join(root, ".github/workflows/ci.yml"), "on: pull_request\n");
    await fs.writeFile(path.join(root, ".github/workflows/new.yml"), "on: push\n");
    await fs.writeFile(path.join(root, "a.js"), "2\n");
    const { branch, files } = await pushFixes(root);

    expect(files).toBe(1);
    expect(run(remote, "show", `${branch}:a.js`)).toBe("2");
    expect(run(remote, "show", `${branch}:.github/workflows/ci.yml`)).toBe("on: push");
    expect(run(root, "status", "--porcelain")).toBe("");
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("re-pushes a commit whose earlier push failed", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lens-push-"));
    const remote = path.join(tmp, "remote.git");
    const root = path.join(tmp, "work");
    run(tmp, "init", "-q", "--bare", "-b", "main", remote);
    run(tmp, "init", "-q", "-b", "main", root);
    await fs.writeFile(path.join(root, "a.js"), "1\n");
    run(root, "add", "-A");
    run(root, "commit", "-qm", "init");
    run(root, "remote", "add", "origin", remote);
    run(root, "push", "-q", "-u", "origin", "main");
    run(root, "checkout", "-qb", "lens/fixes-1");
    await fs.writeFile(path.join(root, "a.js"), "2\n");
    run(root, "commit", "-qam", "Lens fixes");

    await pushPending(root);

    expect(run(remote, "show", "lens/fixes-1:a.js")).toBe("2");
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("pushes to a fresh branch instead of force-pushing when the remote branch diverged", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lens-push-"));
    const remote = path.join(tmp, "remote.git");
    const root = path.join(tmp, "work");
    const other = path.join(tmp, "other");
    run(tmp, "init", "-q", "--bare", "-b", "main", remote);
    run(tmp, "init", "-q", "-b", "main", root);
    await fs.writeFile(path.join(root, "a.js"), "1\n");
    run(root, "add", "-A");
    run(root, "commit", "-qm", "init");
    run(root, "remote", "add", "origin", remote);
    run(root, "push", "-q", "-u", "origin", "main");
    run(root, "checkout", "-qb", "lens/fixes-1");
    run(tmp, "clone", "-q", "-b", "main", remote, other);
    run(other, "checkout", "-qb", "lens/fixes-1");
    await fs.writeFile(path.join(other, "b.js"), "x\n");
    run(other, "add", "-A");
    run(other, "commit", "-qm", "someone else");
    run(other, "push", "-q", "origin", "lens/fixes-1");
    await fs.writeFile(path.join(root, "a.js"), "2\n");

    const { branch } = await pushFixes(root);

    expect(branch).not.toBe("lens/fixes-1");
    expect(run(remote, "show", `${branch}:a.js`)).toBe("2");
    expect(run(remote, "show", "lens/fixes-1:b.js")).toBe("x");
    await fs.rm(tmp, { recursive: true, force: true });
  });
});
