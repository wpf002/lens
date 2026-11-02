/**
 * Hosted mode: projects are GitHub repos cloned into a workspace volume, and
 * applied fixes leave as a pushed branch. The GitHub token is passed per git
 * call as an auth header and never written to .git/config.
 */
import { execFile } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { createHmac, randomBytes } from "node:crypto";
import { githubToken } from "./github.js";

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

/** The fixes branch the working copy is on, and whether it has unpushed changes. */
export async function pushState(root: string): Promise<{ branch: string; dirty: boolean; compareUrl: string | null } | null> {
  const branch = await git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "");
  if (!branch.startsWith("lens/fixes-")) return null;
  const dirty = !!(await git(root, ["status", "--porcelain", "--", ".", ":(exclude).lens"]).catch(() => ""));
  const base = (await git(root, ["config", "--get", "lens.base"]).catch(() => "")) || "main";
  const r = parseRepo(await git(root, ["remote", "get-url", "origin"]).catch(() => ""));
  return { branch, dirty, compareUrl: r ? `https://github.com/${r.owner}/${r.name}/compare/${encodeURIComponent(base)}...${encodeURIComponent(branch)}?expand=1` : null };
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
