/**
 * Hosted mode: "Connect GitHub" via a GitHub OAuth App. The app's client ID and
 * secret come from GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET. The access token
 * GitHub returns is stored in the workspace volume (mode 600) and only ever
 * reaches git as a per-command auth header.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

interface Stored {
  token: string;
  login: string;
}

let stored: Stored | null = null;
let file: string | null = null;
const states = new Map<string, number>();

export const oauthAvailable = () => !!(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET);
// The account connected in the app wins, so reconnecting fixes a stale server credential.
export const githubToken = (): string | null => stored?.token || process.env.GITHUB_TOKEN || null;
export const githubLogin = (): string | null => stored?.login ?? null;

export async function loadGithub(workspace: string): Promise<void> {
  file = path.join(workspace, "github.json");
  try {
    const s = JSON.parse(await fs.readFile(file, "utf8")) as Stored;
    if (typeof s.token === "string" && typeof s.login === "string") stored = s;
  } catch {
    stored = null;
  }
}

export function authorizeUrl(redirectUri: string): string {
  const now = Date.now();
  for (const [k, exp] of states) if (exp < now) states.delete(k);
  const state = randomBytes(16).toString("hex");
  states.set(state, now + 10 * 60_000);
  const q = new URLSearchParams({ client_id: process.env.GITHUB_CLIENT_ID!, redirect_uri: redirectUri, scope: "repo workflow", state, allow_signup: "false" });
  return `https://github.com/login/oauth/authorize?${q}`;
}

export async function finishOAuth(code: string, state: string, redirectUri: string): Promise<void> {
  const exp = states.get(state);
  states.delete(state);
  if (!exp || exp < Date.now()) throw new Error("This sign-in link expired. Try Connect GitHub again.");
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: process.env.GITHUB_CLIENT_ID, client_secret: process.env.GITHUB_CLIENT_SECRET, code, redirect_uri: redirectUri }),
  });
  const body = (await res.json()) as { access_token?: string; error_description?: string };
  if (!body.access_token) throw new Error(body.error_description ?? "GitHub didn't return access.");
  const user = (await api("/user", body.access_token)) as { login: string };
  stored = { token: body.access_token, login: user.login };
  if (file) await fs.writeFile(file, JSON.stringify(stored), { mode: 0o600 });
}

export async function disconnectGithub(): Promise<void> {
  stored = null;
  if (file) await fs.rm(file, { force: true });
}

export interface GithubRepo {
  name: string;
  private: boolean;
  pushedAt: string;
}

export async function listGithubRepos(): Promise<GithubRepo[]> {
  const t = githubToken();
  if (!t) return [];
  const rows = (await api("/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member", t)) as {
    full_name: string;
    private: boolean;
    pushed_at: string;
  }[];
  return rows.map((r) => ({ name: r.full_name, private: r.private, pushedAt: r.pushed_at }));
}

const GITHUB_API_TIMEOUT_MS = 30_000;

async function api(p: string, token: string, method = "GET", body?: unknown): Promise<unknown> {
  const res = await fetch(`https://api.github.com${p}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "lens", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS),
  });
  if (res.status === 401) {
    if (stored?.token === token) await disconnectGithub();
    throw new Error("GitHub access was revoked. Connect GitHub again.");
  }
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { message?: string; errors?: Array<{ message?: string }> } | null;
    // 422s put the reason in errors[], e.g. "No commits between main and lens/fixes-…".
    const msg = [err?.message, ...(err?.errors ?? []).map((e) => e.message)].filter(Boolean).join(": ");
    throw new Error(`GitHub: ${msg ? msg.slice(0, 200) : res.status}`);
  }
  return res.status === 204 ? null : res.json();
}

/** Authenticated GitHub REST call for the connected account. */
export function githubApi(p: string, method = "GET", body?: unknown): Promise<unknown> {
  const t = githubToken();
  if (!t) throw new Error("Connect GitHub first.");
  return api(p, t, method, body);
}

/** Plain-text GitHub download (Actions job logs). Returns null when GitHub has no log for it. */
export async function githubText(p: string, maxBytes = 5_000_000): Promise<string | null> {
  const t = githubToken();
  if (!t) throw new Error("Connect GitHub first.");
  // Logs redirect to a signed URL; fetch drops the auth header on that cross-origin hop.
  const res = await fetch(`https://api.github.com${p}`, { headers: { Authorization: `Bearer ${t}`, "User-Agent": "lens" }, signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS) });
  if (res.status === 404 || res.status === 410) return null;
  if (!res.ok) throw new Error(`GitHub: ${res.status}`);
  const text = await res.text();
  return text.length > maxBytes ? text.slice(-maxBytes) : text;
}
