import { afterEach, describe, it, expect, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPullRequest, fixesPatch, isFixesBranch, pushFixes, pushPending, restartFromBase } from "../src/cloud.js";

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

  async function fixesBranchBehindMain(mainEdit: { file: string; content: string }) {
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
    await fs.writeFile(path.join(root, "a.js"), "2\n");
    run(root, "commit", "-qam", "Lens fixes");
    run(root, "push", "-q", "-u", "origin", "lens/fixes-1");
    run(tmp, "clone", "-q", "-b", "main", remote, other);
    await fs.writeFile(path.join(other, mainEdit.file), mainEdit.content);
    run(other, "add", "-A");
    run(other, "commit", "-qm", "main moved on");
    run(other, "push", "-q", "origin", "main");
    return { tmp, remote, root };
  }

  it("merges the latest base into the fixes branch on the next push, so its pull request stays mergeable", async () => {
    const { tmp, remote, root } = await fixesBranchBehindMain({ file: "b.js", content: "main\n" });
    await fs.writeFile(path.join(root, "c.js"), "3\n");

    const { branch } = await pushFixes(root);

    expect(branch).toBe("lens/fixes-1");
    expect(run(remote, "show", `${branch}:b.js`)).toBe("main");
    expect(run(remote, "show", `${branch}:c.js`)).toBe("3");
    expect(run(remote, "merge-base", "--is-ancestor", "main", branch)).toBe("");
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("leaves no half-finished merge when the base conflicts with the fixes", async () => {
    const { tmp, remote, root } = await fixesBranchBehindMain({ file: "a.js", content: "main\n" });
    await fs.writeFile(path.join(root, "c.js"), "3\n");

    const { branch } = await pushFixes(root);

    expect(run(remote, "show", `${branch}:c.js`)).toBe("3");
    expect(run(remote, "show", `${branch}:a.js`)).toBe("2");
    expect(run(root, "status", "--porcelain")).toBe("");
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("moves fixes to the base branch after a patch download marked new files intent-to-add, with .lens gitignored", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lens-push-"));
    const remote = path.join(tmp, "remote.git");
    const root = path.join(tmp, "work");
    run(tmp, "init", "-q", "--bare", "-b", "main", remote);
    run(tmp, "init", "-q", "-b", "main", root);
    await fs.writeFile(path.join(root, ".gitignore"), ".lens\n");
    await fs.writeFile(path.join(root, "a.js"), "1\n");
    run(root, "add", "-A");
    run(root, "commit", "-qm", "init");
    run(root, "remote", "add", "origin", remote);
    run(root, "push", "-q", "-u", "origin", "main");
    run(root, "config", "lens.base", "main");
    run(root, "checkout", "-qb", "lens/fixes-1");
    await fs.mkdir(path.join(root, ".lens"));
    await fs.writeFile(path.join(root, ".lens/graph.json"), "{}");
    await fs.writeFile(path.join(root, "a.js"), "2\n");
    await fs.writeFile(path.join(root, "new.py"), "x = 1\n");
    run(root, "add", "-N", "new.py"); // what an older patch download left behind

    await restartFromBase(root, "lens/fixes-1");

    expect(run(root, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(await fs.readFile(path.join(root, "new.py"), "utf8")).toBe("x = 1\n");
    expect(await fixesPatch(root)).toContain("new file mode");
    expect(await fs.readFile(path.join(root, "a.js"), "utf8")).toBe("2\n");
    expect(await fs.readFile(path.join(root, ".lens/graph.json"), "utf8")).toBe("{}");
    expect(run(root, "status", "--porcelain")).toBe("M a.js\n?? new.py");
    await fs.rm(tmp, { recursive: true, force: true });
  });

  describe("in the owner's name", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    });

    /** A repo with one pushed commit on main and a local author, so commits don't fall back to the global git config. */
    async function ownerRepo() {
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lens-push-"));
      const remote = path.join(tmp, "remote.git");
      const root = path.join(tmp, "work");
      run(tmp, "init", "-q", "--bare", "-b", "main", remote);
      run(tmp, "init", "-q", "-b", "main", root);
      run(root, "config", "user.name", "Repo Owner");
      run(root, "config", "user.email", "owner@example.com");
      await fs.writeFile(path.join(root, "a.js"), "1\n");
      run(root, "add", "-A");
      run(root, "commit", "-qm", "init");
      run(root, "remote", "add", "origin", remote);
      run(root, "push", "-q", "-u", "origin", "main");
      return { tmp, remote, root };
    }

    it("names the branch after the fix, tracks it in git config, and commits as the repo's author", async () => {
      vi.stubEnv("GITHUB_TOKEN", "");
      const { tmp, remote, root } = await ownerRepo();
      await fs.writeFile(path.join(root, "a.js"), "2\n");

      const { branch } = await pushFixes(root, [{ title: "Escape user input in the search query.", files: ["a.js"] }]);

      expect(branch).toMatch(/^fix\/escape-user-input-search-\d{8}$/);
      expect(run(root, "config", "--get", "lens.branch")).toBe(branch);
      expect(await isFixesBranch(root, branch)).toBe(true);
      const log = run(remote, "log", "-1", "--format=%an <%ae>%n%B", branch);
      expect(log).toBe("Repo Owner <owner@example.com>\nEscape user input in the search query");
      expect(log).not.toMatch(/lens|claude|co-authored/i);

      await fs.writeFile(path.join(root, "b.js"), "x\n");
      expect((await pushFixes(root)).branch).toBe(branch);
      expect(run(remote, "log", "-1", "--format=%s", branch)).toBe("Update b.js");
      await fs.rm(tmp, { recursive: true, force: true });
    });

    it("commits as the connected GitHub account and titles the pull request from the fixes", async () => {
      vi.stubEnv("GITHUB_TOKEN", "test-token");
      const calls: Array<{ url: string; body: unknown }> = [];
      vi.stubGlobal("fetch", async (url: string, init?: { method?: string; body?: string }) => {
        calls.push({ url, body: init?.body ? JSON.parse(init.body) : null });
        if (url.endsWith("/user")) return Response.json({ id: 42, login: "octo", name: "Octo Cat" });
        if (init?.method === "POST") return Response.json({ number: 7, html_url: "https://github.com/octo/app/pull/7" }, { status: 201 });
        return Response.json([]);
      });
      const { tmp, remote, root } = await ownerRepo();
      run(root, "remote", "set-url", "origin", "https://github.com/octo/app.git");
      run(root, "remote", "set-url", "--push", "origin", remote);
      await fs.writeFile(path.join(root, "a.js"), "2\n");
      const fixes = [
        { title: "Validate the upload size", files: ["a.js"] },
        { title: "Fixed by Lens: close the file handle", files: ["a.js"] },
      ];

      const pr = await createPullRequest(root, fixes);

      expect(pr.number).toBe(7);
      const branch = run(root, "rev-parse", "--abbrev-ref", "HEAD");
      expect(run(remote, "log", "-1", "--format=%an <%ae>", branch)).toBe("Octo Cat <42+octo@users.noreply.github.com>");
      const sent = calls.find((c) => c.url.endsWith("/pulls"))?.body as { title: string; body: string };
      expect(sent.title).toBe("Validate the upload size and 1 more fix");
      expect(sent.body).toContain("- Close the file handle");
      expect(`${sent.title}\n${sent.body}`).not.toMatch(/lens|claude|\bAI\b/i);
      await fs.rm(tmp, { recursive: true, force: true });
    });
  });
});
