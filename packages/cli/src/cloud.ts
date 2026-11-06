/**
 * Hosted mode: projects are GitHub repos cloned into a workspace volume, and
 * applied fixes leave as a pushed branch. The GitHub token is passed per git
 * call as an auth header and never written to .git/config.
 */
import { execFile } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { createHmac, randomBytes } from "node:crypto";
import { githubApi, githubToken } from "./github.js";
import { brokenCount, testGate, type TestGate } from "./ci.js";

export interface RepoRef {
  owner: string;
  name: string;
}

/** Accepts `owner/name`, `github.com/owner/name`, or an https/ssh GitHub URL. */
export function parseRepo(input: string): RepoRef | null {
  const s = input.trim().replace(/\.git$/, "").replace(/\/+$/, "");
  const m =
    /^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)$/i.exec(s) ??
    /^git@github\.com:([\w.-]+)\/([\w.-]+)$/i.exec(s) ??
    /^([\w.-]+)\/([\w.-]+)$/.exec(s);
  if (!m) return null;
  const [, owner, name] = m as unknown as [string, string, string];
  if (owner.startsWith(".") || name.startsWith(".")) return null;
  return { owner, name };
}

export const reposDir = (workspace: string) => path.join(workspace, "repos");
export const repoDir = (workspace: string, r: RepoRef) => path.join(reposDir(workspace), r.owner, r.name);

function authArgs(): string[] {
  const t = githubToken();
  if (!t) return [];
  const basic = Buffer.from(`x-access-token:${t}`).toString("base64");
  return ["-c", `http.https://github.com/.extraheader=Authorization: Basic ${basic}`];
}

function git(cwd: string, args: string[], timeout = 5 * 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      // HTTP/2 drops large pushes to GitHub ("RPC failed; curl 92"); HTTP/1.1 with a big buffer doesn't.
      [...authArgs(), "-c", "http.version=HTTP/1.1", "-c", "http.postBuffer=524288000", "-c", "user.name=Lens", "-c", "user.email=lens@users.noreply.github.com", ...args],
      { cwd, timeout, maxBuffer: 20_000_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(scrub(stderr.trim() || err.message)));
        resolve(stdout.trim());
      },
    );
  });
}

/** Keep tokens out of error messages that reach the browser. */
function scrub(msg: string): string {
  let out = msg;
  const t = githubToken();
  if (t) out = out.split(t).join("***");
  out = out.replace(/Basic [A-Za-z0-9+/=]+/g, "Basic ***");
  // The browser gets a short message; the server log keeps git's own (token-free) text.
  console.error(`[github] ${out.slice(0, 1000)}`);
  if (/workflow/i.test(out) && /refusing|scope|permission/i.test(out)) return WORKFLOW_REJECTED;
  if (/Authentication failed|could not read Username|Repository not found|403/i.test(out)) {
    out = t
      ? "GitHub refused access to this repo. Reconnect GitHub and try again."
      : "Repo not found or private. Connect GitHub to open private repos.";
  }
  return out.slice(0, 300);
}

/** Clone the repo, or fast-forward it when the working tree is clean. Returns its folder. */
export async function cloneOrUpdate(workspace: string, r: RepoRef): Promise<string> {
  const dir = repoDir(workspace, r);
  const url = `https://github.com/${r.owner}/${r.name}.git`;
  if (!existsSync(path.join(dir, ".git"))) {
    await fs.mkdir(path.dirname(dir), { recursive: true });
    await git(path.dirname(dir), ["clone", "--depth", "200", "--no-tags", url, r.name]);
    // Lens output stays out of commits Lens makes.
    await fs.appendFile(path.join(dir, ".git", "info", "exclude"), "\n.lens/\n");
    return dir;
  }
  const dirty = await git(dir, ["status", "--porcelain", "--", ".", ":(exclude).lens"]);
  const branch = await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "");
  if (!dirty && !branch.startsWith("lens/fixes-")) await git(dir, ["pull", "--ff-only", "--no-tags"]).catch(() => undefined);
  return dir;
}

/**
 * Commit every change in the working tree and push it. The first push creates a
 * `lens/fixes-*` branch and the working copy stays on it, so later fixes and
 * pushes add commits to the same branch.
 */
export async function pushFixes(root: string): Promise<{ branch: string; compareUrl: string | null; files: number }> {
  const status = await git(root, ["status", "--porcelain", "--", ".", ":(exclude).lens"]);
  if (!status) throw new Error("No changes to push.");
  const files = status.split("\n").filter(Boolean).length;
  let branch = await git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!branch.startsWith("lens/fixes-")) {
    const next = newBranchName();
    await git(root, ["config", "lens.base", branch]);
    await git(root, ["config", "--unset", "lens.merged"]).catch(() => undefined);
    await git(root, ["checkout", "-b", next]);
    branch = next;
  }
  const base = (await git(root, ["config", "--get", "lens.base"]).catch(() => "")) || "main";
  await git(root, ["add", "-A"]);
  await git(root, ["reset", "-q", "--", ".lens"]).catch(() => undefined);
  await git(root, ["commit", "-m", `Lens fixes (${files} file${files === 1 ? "" : "s"})`]);
  const pushed = await pushBranch(root, branch);
  branch = pushed.branch;
  const dropped = pushed.dropped;
  const origin = await git(root, ["remote", "get-url", "origin"]).catch(() => "");
  const r = parseRepo(origin);
  return { branch, compareUrl: r ? `https://github.com/${r.owner}/${r.name}/compare/${encodeURIComponent(base)}...${encodeURIComponent(branch)}?expand=1` : null, files: files - dropped };
}

const WORKFLOWS = ".github/workflows";
export const WORKFLOW_REJECTED = "GitHub won't accept changes to .github/workflows from Lens.";

const TRANSIENT = /RPC failed|remote end hung up|early EOF|Connection (reset|timed out)|Operation timed out|Could not resolve host|unexpected disconnect|returned error: 5\d\d|HTTP\/2/i;
const DIVERGED = /non-fast-forward|fetch first|\[rejected\]/i;
const PUSH_RETRY_DELAYS_MS = [2_000, 8_000, 20_000];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const newBranchName = () => `lens/fixes-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}-${randomBytes(2).toString("hex")}`;

/** `git push`, retried with backoff when the connection drops. */
async function pushWithRetry(root: string, branch: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await git(root, ["push", "-u", "origin", branch]);
      return;
    } catch (e) {
      const delay = PUSH_RETRY_DELAYS_MS[attempt];
      if (!(e instanceof Error) || !TRANSIENT.test(e.message) || delay === undefined) throw e;
      console.error(`[github] push attempt ${attempt + 1} failed, retrying in ${delay / 1000}s`);
      await sleep(delay);
    }
  }
}

/** Remove workflow-file changes from the last commit. Returns how many files were dropped. */
async function dropWorkflowChanges(root: string): Promise<number> {
  const touched = (await git(root, ["diff", "--name-only", "HEAD~1", "HEAD", "--", WORKFLOWS])).split("\n").filter(Boolean);
  if (!touched.length) return 0;
  await git(root, ["reset", "-q", "--soft", "HEAD~1"]);
  await git(root, ["reset", "-q", "--", WORKFLOWS]);
  await git(root, ["checkout", "--", WORKFLOWS]).catch(() => undefined);
  await git(root, ["clean", "-fdq", "--", WORKFLOWS]);
  const left = await git(root, ["diff", "--cached", "--name-only"]);
  if (!left) throw new Error("The only changes were to .github/workflows, which GitHub won't accept from Lens.");
  await git(root, ["commit", "-m", `Lens fixes (${left.split("\n").length} files)`]);
  return touched.length;
}

/**
 * Push the fixes branch. Retries dropped connections, drops workflow files if GitHub
 * refuses them, and moves to a fresh branch name if the remote branch has diverged
 * (never force-pushes). Returns the branch that was pushed.
 */
async function pushBranch(root: string, start: string): Promise<{ branch: string; dropped: number }> {
  let branch = start;
  let dropped = 0;
  for (;;) {
    try {
      await pushWithRetry(root, branch);
      return { branch, dropped };
    } catch (e) {
      if (!(e instanceof Error)) throw e;
      if (e.message.startsWith(WORKFLOW_REJECTED) && dropped === 0) {
        dropped = await dropWorkflowChanges(root);
        if (!dropped) throw e;
      } else if (DIVERGED.test(e.message) && branch === start) {
        branch = newBranchName();
        await git(root, ["branch", "-m", branch]);
      } else throw e;
    }
  }
}

export interface PullRequest {
  number: number;
  url: string;
  state: "open" | "merged" | "closed";
  mergedAt?: string;
  /** Test results on the PR's head commit compared with the base; only for open PRs. */
  tests?: TestGate;
}
export interface PushInfo {
  /** The `lens/fixes-*` branch, or null once merged. */
  branch: string | null;
  dirty: boolean;
  pr: PullRequest | null;
}

async function repoOf(root: string): Promise<RepoRef> {
  const r = parseRepo(await git(root, ["remote", "get-url", "origin"]).catch(() => ""));
  if (!r) throw new Error("This project isn't a GitHub repo.");
  return r;
}

async function findPr(root: string, r: RepoRef, branch: string): Promise<PullRequest | null> {
  const rows = (await githubApi(`/repos/${r.owner}/${r.name}/pulls?state=all&head=${encodeURIComponent(`${r.owner}:${branch}`)}`)) as Array<{ number: number; html_url: string; state: string; merged_at: string | null; head: { sha: string }; base: { sha: string } }>;
  const p = rows[0];
  if (!p) return null;
  const state = p.merged_at ? "merged" : p.state === "open" ? "open" : "closed";
  const tests = state === "open" ? await gateFor(root, r, p).catch((e: unknown) => (console.error(`[tests] ${e instanceof Error ? e.message : e}`), undefined)) : undefined;
  return { number: p.number, url: p.html_url, state, ...(p.merged_at ? { mergedAt: p.merged_at } : {}), ...(tests ? { tests } : {}) };
}

async function gateFor(root: string, r: RepoRef, p: { number: number; head: { sha: string }; base: { sha: string } }): Promise<TestGate> {
  const committed = Number(await git(root, ["log", "-1", "--format=%ct", p.head.sha]).catch(() => ""));
  return testGate(root, { repo: `${r.owner}/${r.name}`, pr: p.number, headSha: p.head.sha, baseSha: p.base.sha, ...(committed ? { pushedAt: committed * 1000 } : {}) });
}

/** Paths the open pull request changes, for the test-repair prompt. */
export async function pullRequestFiles(root: string, pr: number): Promise<string[]> {
  const r = await repoOf(root);
  const rows = (await githubApi(`/repos/${r.owner}/${r.name}/pulls/${pr}/files?per_page=100`)) as Array<{ filename: string }>;
  return rows.map((f) => f.filename);
}

async function mergedTime(root: string, n: number): Promise<string | undefined> {
  const r = await repoOf(root);
  const p = (await githubApi(`/repos/${r.owner}/${r.name}/pulls/${n}`)) as { html_url: string; merged_at: string | null };
  if (!p.merged_at) return undefined;
  await git(root, ["config", "lens.merged", `${n} ${p.html_url} ${p.merged_at}`]);
  return p.merged_at;
}

/** Where the fixes are: unpushed, pushed, in an open pull request, or merged. */
export async function pushState(root: string): Promise<PushInfo | null> {
  const branch = await git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "");
  const dirty = !!(await git(root, ["status", "--porcelain", "--", ".", ":(exclude).lens"]).catch(() => ""));
  if (!branch.startsWith("lens/fixes-")) {
    const merged = await git(root, ["config", "--get", "lens.merged"]).catch(() => "");
    const [n, url, saved] = merged.split(" ");
    if (!n || !url) return null;
    // Merges recorded before Lens saved the time: ask GitHub once and keep the answer.
    const mergedAt = saved || (githubToken() ? await mergedTime(root, Number(n)).catch(() => undefined) : undefined);
    return { branch: null, dirty, pr: { number: Number(n), url, state: "merged", ...(mergedAt ? { mergedAt } : {}) } };
  }
  // Shallow clones are single-branch, so there's no local origin/<branch> ref to check. Ask GitHub.
  const pr = githubToken() ? await findPr(root, await repoOf(root), branch).catch(() => null) : null;
  return { branch, dirty, pr };
}

/** Push any new fixes, then open a pull request into the base branch. */
/** Commit and push new fixes, or re-push a commit whose earlier push failed. */
export async function pushPending(root: string): Promise<void> {
  let st = await pushState(root);
  // That branch's pull request was merged or closed (maybe outside Lens); start the new fixes from the base branch.
  if (st?.branch && st.pr && st.pr.state !== "open") {
    await restartFromBase(root, st.branch);
    st = await pushState(root);
  }
  if (!st?.branch || st.dirty) await pushFixes(root);
  else await pushBranch(root, st.branch);
}

/** Move uncommitted fixes off a finished fixes branch onto the latest base branch. */
export async function restartFromBase(root: string, old: string): Promise<void> {
  const base = (await git(root, ["config", "--get", "lens.base"]).catch(() => "")) || "main";
  const dirty = !!(await git(root, ["status", "--porcelain", "--", ".", ":(exclude).lens"]));
  // A patch download leaves new files marked intent-to-add, and git stash refuses those ("not uptodate. Cannot merge").
  await git(root, ["reset", "-q"]);
  // No pathspec: .lens is ignored (info/exclude or .gitignore) so -u skips it, and naming it makes git exit 1 even though the stash succeeded.
  if (dirty) await git(root, ["stash", "push", "-u", "-q"]);
  try {
    await git(root, ["fetch", "-q", "--no-tags", "origin", base]);
    await git(root, ["checkout", "-q", "-B", base, "FETCH_HEAD"]);
    if (dirty) await git(root, ["stash", "pop", "-q"]);
  } catch (e) {
    // Put everything back where it was rather than lose the fixes.
    await git(root, ["checkout", "-q", "-f", old]).catch(() => undefined);
    if (dirty) await git(root, ["stash", "pop", "-q"]).catch(() => undefined);
    throw new Error(`These fixes conflict with the latest ${base}. Undo them and run Fix again. (${e instanceof Error ? e.message.slice(0, 200) : e})`);
  }
  await git(root, ["branch", "-D", old]).catch(() => undefined);
}

export async function createPullRequest(root: string, body: string): Promise<PullRequest> {
  await pushPending(root);
  const branch = await git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const r = await repoOf(root);
  const existing = await findPr(root, r, branch);
  if (existing?.state === "open") return existing;
  const base = (await git(root, ["config", "--get", "lens.base"]).catch(() => "")) || "main";
  const p = (await githubApi(`/repos/${r.owner}/${r.name}/pulls`, "POST", { title: "Lens fixes", head: branch, base, body: body.slice(0, 60_000) })) as { number: number; html_url: string };
  return { number: p.number, url: p.html_url, state: "open" };
}

/** Why Merge is refused, or null. Only failures Lens's changes introduced block it. */
export function mergeBlock(tests: TestGate | undefined): string | null {
  if (!tests) return "Couldn't read the test results from GitHub. Try again.";
  if (tests.state === "running") return "Tests are still running.";
  if (tests.state === "broken") return `These fixes break ${brokenCount(tests)} test${brokenCount(tests) === 1 ? "" : "s"}. Undo them or wait for Lens to repair them.`;
  return null;
}

/** Squash-merge the open pull request, then move the working copy back to the updated base branch. */
export async function mergePullRequest(root: string): Promise<PullRequest> {
  const branch = await git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!branch.startsWith("lens/fixes-")) throw new Error("No fixes branch to merge.");
  if (await git(root, ["status", "--porcelain", "--", ".", ":(exclude).lens"])) throw new Error("There are fixes not in the pull request yet. Update it first.");
  const r = await repoOf(root);
  const pr = await findPr(root, r, branch);
  if (!pr || pr.state !== "open") throw new Error("There's no open pull request for these fixes.");
  const blocked = mergeBlock(pr.tests);
  if (blocked) throw new Error(blocked);
  await githubApi(`/repos/${r.owner}/${r.name}/pulls/${pr.number}/merge`, "PUT", { merge_method: "squash" });
  await githubApi(`/repos/${r.owner}/${r.name}/git/refs/heads/${branch.split("/").map(encodeURIComponent).join("/")}`, "DELETE").catch(() => undefined);
  const base = (await git(root, ["config", "--get", "lens.base"]).catch(() => "")) || "main";
  await git(root, ["checkout", base]);
  await git(root, ["pull", "--ff-only", "--no-tags", "origin", base]);
  await git(root, ["branch", "-D", branch]).catch(() => undefined);
  const mergedAt = new Date().toISOString();
  await git(root, ["config", "lens.merged", `${pr.number} ${pr.url} ${mergedAt}`]);
  return { number: pr.number, url: pr.url, state: "merged", mergedAt };
}

/** Repos already on the volume, as `owner/name`. */
export async function listRepos(workspace: string): Promise<string[]> {
  const out: string[] = [];
  const base = reposDir(workspace);
  for (const owner of await fs.readdir(base).catch(() => [] as string[])) {
    for (const name of await fs.readdir(path.join(base, owner)).catch(() => [] as string[])) {
      if (existsSync(path.join(base, owner, name, ".git"))) out.push(`${owner}/${name}`);
    }
  }
  return out.sort();
}

/** Unified diff of every change in the working tree, new files included. */
export async function fixesPatch(root: string): Promise<string> {
  await git(root, ["add", "-A", "-N", "--", "."]).catch(() => undefined);
  await git(root, ["reset", "-q", "--", ".lens"]).catch(() => undefined);
  try {
    return await git(root, ["diff", "--binary", "HEAD", "--", ".", ":(exclude).lens"]);
  } finally {
    // Drop the intent-to-add marks so later stashes and checkouts work.
    await git(root, ["reset", "-q"]);
  }
}

/**
 * Sign-in token that survives restarts and deploys. A random key kept on the
 * volume is mixed with the login, so changing the password signs everyone out.
 */
export async function sessionToken(workspace: string, login: { username: string; password: string }): Promise<string> {
  const file = path.join(workspace, "session.key");
  let key = await fs.readFile(file, "utf8").then((s) => s.trim()).catch(() => "");
  if (key.length < 32) {
    key = randomBytes(32).toString("base64url");
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(file, key, { mode: 0o600 });
  }
  return createHmac("sha256", key).update(`${login.username}\0${login.password}`).digest("base64url");
}
