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
  /** GitHub App sign-ins expire (8 hours by default) and come with a refresh token. OAuth App tokens have neither. */
  refreshToken?: string;
  /** Epoch ms when `token` expires. */
  expiresAt?: number;
}

/** Refresh this long before expiry, so a request never goes out with a token about to lapse. */
const REFRESH_MARGIN_MS = 5 * 60_000;

let stored: Stored | null = null;
let file: string | null = null;
/** A token GitHub rejected. Kept on disk until the user reconnects or disconnects, but never used. */
let rejectedToken: string | null = null;
const states = new Map<string, number>();

export const oauthAvailable = () => !!(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET);
// The account connected in the app wins, so reconnecting fixes a stale server credential.
export const githubToken = (): string | null => stored?.token || process.env.GITHUB_TOKEN || null;
export const githubLogin = (): string | null => stored?.login ?? null;

/** The saved connection, or null when there is none. Throws when the file exists but can't be read. */
export async function readStoredGithub(target: string): Promise<Stored | null> {
  let text: string;
  try {
    text = await fs.readFile(target, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  const s = JSON.parse(text) as Partial<Stored>;
  if (typeof s.token !== "string" || typeof s.login !== "string") throw new Error(`${target} has no GitHub account in it`);
  return {
    token: s.token,
    login: s.login,
    ...(typeof s.refreshToken === "string" ? { refreshToken: s.refreshToken } : {}),
    ...(typeof s.expiresAt === "number" ? { expiresAt: s.expiresAt } : {}),
  };
}

export async function loadGithub(workspace: string): Promise<void> {
  file = path.join(workspace, "github.json");
  try {
    const s = await readStoredGithub(file);
    stored = s && s.token !== rejectedToken ? s : null;
  } catch (e) {
    // Keep whatever is in memory; a failed read must not drop a working connection.
    console.error(`[github] couldn't read the saved connection: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Picks up the saved connection when memory has none, e.g. after a startup read failed.
 * Call before any action that needs GitHub.
 */
export async function ensureGithubLoaded(): Promise<void> {
  if (!stored && file) await loadGithub(path.dirname(file));
  if (stored?.refreshToken && stored.expiresAt && Date.now() > stored.expiresAt - REFRESH_MARGIN_MS) {
    await refreshGithub().catch((e: unknown) => console.error(`[github] refresh failed: ${e instanceof Error ? e.message : String(e)}`));
  }
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  error?: string;
  error_description?: string;
}

const tokenUrl = "https://github.com/login/oauth/access_token";

async function requestToken(params: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: process.env.GITHUB_CLIENT_ID, client_secret: process.env.GITHUB_CLIENT_SECRET, ...params }),
    signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS),
  });
  return (await res.json()) as TokenResponse;
}

function storedFrom(body: TokenResponse, login: string, now = Date.now()): Stored {
  return {
    token: body.access_token!,
    login,
    ...(body.refresh_token ? { refreshToken: body.refresh_token } : {}),
    ...(body.expires_in ? { expiresAt: now + body.expires_in * 1000 } : {}),
  };
}

let refreshing: Promise<boolean> | null = null;

/** Swap an expiring GitHub App sign-in for a new one. One refresh at a time: GitHub retires the refresh token on use. */
function refreshGithub(): Promise<boolean> {
  refreshing ??= (async () => {
    const current = stored;
    if (!current?.refreshToken) return false;
    const body = await requestToken({ grant_type: "refresh_token", refresh_token: current.refreshToken });
    if (!body.access_token) throw new Error(body.error_description ?? body.error ?? "GitHub didn't return access.");
    stored = storedFrom(body, current.login);
    rejectedToken = null;
    if (file) await saveStored(file, stored);
    console.log(`[github] refreshed the connection for ${current.login}`);
    return true;
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

async function saveStored(target: string, s: Stored): Promise<void> {
  // Write then rename, so a deploy that stops the server mid-write can't leave a truncated file.
  const tmp = `${target}.${randomBytes(4).toString("hex")}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(s), { mode: 0o600 });
  await fs.rename(tmp, target);
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
  const body = await requestToken({ code, redirect_uri: redirectUri });
  if (!body.access_token) throw new Error(body.error_description ?? "GitHub didn't return access.");
  const user = (await api("/user", body.access_token)) as { login: string };
  stored = storedFrom(body, user.login);
  rejectedToken = null;
  if (file) await saveStored(file, stored);
  console.log(`[github] connected as ${user.login}${stored.expiresAt ? `, expires ${new Date(stored.expiresAt).toISOString()}, refreshable` : ", no expiry"}`);
}

/** Only the Disconnect button removes the saved connection. */
export async function disconnectGithub(): Promise<void> {
  stored = null;
  rejectedToken = null;
  if (file) await fs.rm(file, { force: true });
  console.log("[github] disconnected");
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

async function api(p: string, token: string, method = "GET", body?: unknown, retried = false): Promise<unknown> {
  const res = await fetch(`https://api.github.com${p}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "lens", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS),
  });
  if (res.status === 401) {
    // An expired GitHub App sign-in: refresh once and retry with the new token.
    if (!retried && stored?.token === token && stored.refreshToken) {
      const ok = await refreshGithub().catch((e: unknown) => (console.error(`[github] refresh failed: ${e instanceof Error ? e.message : String(e)}`), false));
      if (ok && stored) return api(p, stored.token, method, body, true);
    }
    if (stored?.token === token) {
      // Stop using it, but leave the file: deleting it on one 401 is how the connection used to vanish.
      rejectedToken = token;
      stored = null;
      console.error(`[github] GitHub rejected the saved connection (401 on ${method} ${p.split("?")[0]})`);
    }
    throw new Error("GitHub access was revoked. Connect GitHub again.");
  }
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { message?: string; errors?: Array<{ message?: string }> } | null;
    // 422s put the reason in errors[], e.g. "No commits between main and fix/…".
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

export interface GitIdentity {
  name: string;
  email: string;
}

let identityCache: { token: string; identity: GitIdentity } | null = null;

/** The connected account as a commit author, with GitHub's private noreply email. Null when not connected. */
export async function githubIdentity(): Promise<GitIdentity | null> {
  const t = githubToken();
  if (!t) return null;
  if (identityCache?.token === t) return identityCache.identity;
  const user = (await api("/user", t)) as { id: number; login: string; name: string | null };
  const identity = { name: user.name?.trim() || user.login, email: `${user.id}+${user.login}@users.noreply.github.com` };
  identityCache = { token: t, identity };
  return identity;
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
