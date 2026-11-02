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
      [...authArgs(), "-c", "user.name=Lens", "-c", "user.email=lens@users.noreply.github.com", ...args],
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
  if (/Authentication failed|could not read Username|Repository not found|403/i.test(out)) {
    out = t
      ? "GitHub refused access to this repo, or it doesn't exist."
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
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
    const next = `lens/fixes-${stamp}-${randomBytes(2).toString("hex")}`;
    await git(root, ["config", "lens.base", branch]);
    await git(root, ["config", "--unset", "lens.merged"]).catch(() => undefined);
    await git(root, ["checkout", "-b", next]);
    branch = next;
  }
  const base = (await git(root, ["config", "--get", "lens.base"]).catch(() => "")) || "main";
  await git(root, ["add", "-A"]);
  await git(root, ["reset", "-q", "--", ".lens"]).catch(() => undefined);
  await git(root, ["commit", "-m", `Lens fixes (${files} file${files === 1 ? "" : "s"})`]);
  await git(root, ["push", "-u", "origin", branch]);
  const origin = await git(root, ["remote", "get-url", "origin"]).catch(() => "");
  const r = parseRepo(origin);
  return { branch, compareUrl: r ? `https://github.com/${r.owner}/${r.name}/compare/${encodeURIComponent(base)}...${encodeURIComponent(branch)}?expand=1` : null, files };
}

export interface PullRequest {
  number: number;
  url: string;
  state: "open" | "merged" | "closed";
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

async function findPr(r: RepoRef, branch: string): Promise<PullRequest | null> {
  const rows = (await githubApi(`/repos/${r.owner}/${r.name}/pulls?state=all&head=${encodeURIComponent(`${r.owner}:${branch}`)}`)) as Array<{ number: number; html_url: string; state: string; merged_at: string | null }>;
  const p = rows[0];
  return p ? { number: p.number, url: p.html_url, state: p.merged_at ? "merged" : p.state === "open" ? "open" : "closed" } : null;
}

/** Where the fixes are: unpushed, pushed, in an open pull request, or merged. */
export async function pushState(root: string): Promise<PushInfo | null> {
  const branch = await git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "");
  const dirty = !!(await git(root, ["status", "--porcelain", "--", ".", ":(exclude).lens"]).catch(() => ""));
  if (!branch.startsWith("lens/fixes-")) {
    const merged = await git(root, ["config", "--get", "lens.merged"]).catch(() => "");
    const [n, url] = merged.split(" ");
    return n && url ? { branch: null, dirty, pr: { number: Number(n), url, state: "merged" } } : null;
  }
  // Shallow clones are single-branch, so there's no local origin/<branch> ref to check. Ask GitHub.
  const pr = githubToken() ? await findPr(await repoOf(root), branch).catch(() => null) : null;
  return { branch, dirty, pr };
}

/** Push any new fixes, then open a pull request into the base branch. */
export async function createPullRequest(root: string, body: string): Promise<PullRequest> {
  const st = await pushState(root);
  if (!st?.branch || st.dirty) await pushFixes(root);
  const branch = await git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const r = await repoOf(root);
  const existing = await findPr(r, branch);
  if (existing?.state === "open") return existing;
  const base = (await git(root, ["config", "--get", "lens.base"]).catch(() => "")) || "main";
  const p = (await githubApi(`/repos/${r.owner}/${r.name}/pulls`, "POST", { title: "Lens fixes", head: branch, base, body: body.slice(0, 60_000) })) as { number: number; html_url: string };
  return { number: p.number, url: p.html_url, state: "open" };
}

/** Squash-merge the open pull request, then move the working copy back to the updated base branch. */
export async function mergePullRequest(root: string): Promise<PullRequest> {
  const branch = await git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!branch.startsWith("lens/fixes-")) throw new Error("No fixes branch to merge.");
  if (await git(root, ["status", "--porcelain", "--", ".", ":(exclude).lens"])) throw new Error("There are fixes not in the pull request yet. Update it first.");
  const r = await repoOf(root);
  const pr = await findPr(r, branch);
  if (!pr || pr.state !== "open") throw new Error("There's no open pull request for these fixes.");
  await githubApi(`/repos/${r.owner}/${r.name}/pulls/${pr.number}/merge`, "PUT", { merge_method: "squash" });
  await githubApi(`/repos/${r.owner}/${r.name}/git/refs/heads/${branch.split("/").map(encodeURIComponent).join("/")}`, "DELETE").catch(() => undefined);
  const base = (await git(root, ["config", "--get", "lens.base"]).catch(() => "")) || "main";
  await git(root, ["checkout", base]);
  await git(root, ["pull", "--ff-only", "--no-tags", "origin", base]);
  await git(root, ["branch", "-D", branch]).catch(() => undefined);
  await git(root, ["config", "lens.merged", `${pr.number} ${pr.url}`]);
  return { ...pr, state: "merged" };
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
  return git(root, ["diff", "--binary", "HEAD", "--", ".", ":(exclude).lens"]);
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
