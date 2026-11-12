/**
 * Hosted mode via a GitHub App installation. The server signs a short JWT with the
 * app's private key and trades it for an installation token (1 hour). Nothing is
 * stored, so there is no user sign-in to expire or revoke.
 *
 * Env: GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY (PEM, literal "\n" allowed), and
 * GITHUB_APP_INSTALLATION_ID when the app is installed on more than one account.
 */
import { createSign } from "node:crypto";
import { z } from "zod";

const GITHUB_API = "https://api.github.com";
const API_TIMEOUT_MS = 30_000;
/** GitHub rejects app JWTs that live longer than 10 minutes; back-date for clock drift. */
const JWT_BACKDATE_S = 60;
const JWT_LIFETIME_S = 9 * 60;
/** Mint a new installation token this long before the current one lapses. */
const TOKEN_MARGIN_MS = 5 * 60_000;

export interface AppConfig {
  appId: string;
  privateKey: string;
  installationId?: string;
}

const APP_ID_MESSAGE = "GITHUB_APP_ID must be the numeric App ID";
const PRIVATE_KEY_MESSAGE = "GITHUB_APP_PRIVATE_KEY must be the app's PEM private key";

const configSchema = z.object({
  GITHUB_APP_ID: z.string({ error: APP_ID_MESSAGE }).regex(/^\d+$/, APP_ID_MESSAGE),
  GITHUB_APP_PRIVATE_KEY: z.string({ error: PRIVATE_KEY_MESSAGE }).includes("PRIVATE KEY", { message: PRIVATE_KEY_MESSAGE }),
  GITHUB_APP_INSTALLATION_ID: z.string().regex(/^\d+$/).optional(),
});

/** Null when the app isn't configured. Throws when it's half-configured, so startup fails loudly. */
export function readAppConfig(env: NodeJS.ProcessEnv = process.env): AppConfig | null {
  if (!env.GITHUB_APP_ID && !env.GITHUB_APP_PRIVATE_KEY) return null;
  const parsed = configSchema.safeParse({
    GITHUB_APP_ID: env.GITHUB_APP_ID,
    GITHUB_APP_PRIVATE_KEY: env.GITHUB_APP_PRIVATE_KEY,
    GITHUB_APP_INSTALLATION_ID: env.GITHUB_APP_INSTALLATION_ID || undefined,
  });
  if (!parsed.success) throw new Error(`GitHub App config: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  return {
    appId: parsed.data.GITHUB_APP_ID,
    // Railway's variable editor keeps a pasted PEM's newlines, but a one-line paste arrives as "\n".
    privateKey: parsed.data.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, "\n"),
    ...(parsed.data.GITHUB_APP_INSTALLATION_ID ? { installationId: parsed.data.GITHUB_APP_INSTALLATION_ID } : {}),
  };
}

const base64url = (input: string | Buffer) => Buffer.from(input).toString("base64url");

/** RS256 JWT that authenticates as the app itself. */
export function appJwt(config: AppConfig, nowMs = Date.now()): string {
  const now = Math.floor(nowMs / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iat: now - JWT_BACKDATE_S, exp: now + JWT_LIFETIME_S, iss: config.appId }));
  const signature = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(config.privateKey);
  return `${header}.${payload}.${base64url(signature)}`;
}

const installationSchema = z.object({ id: z.number(), account: z.object({ login: z.string() }) });
const tokenSchema = z.object({ token: z.string(), expires_at: z.string() });

async function appRequest(config: AppConfig, p: string, method = "GET"): Promise<unknown> {
  const res = await fetch(`${GITHUB_API}${p}`, {
    method,
    headers: { Authorization: `Bearer ${appJwt(config)}`, Accept: "application/vnd.github+json", "User-Agent": "lens" },
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`GitHub App: ${res.status} on ${method} ${p}`);
  return res.json();
}

export interface Installation {
  id: number;
  login: string;
}

async function findInstallation(config: AppConfig): Promise<Installation> {
  if (config.installationId) {
    const one = installationSchema.parse(await appRequest(config, `/app/installations/${config.installationId}`));
    return { id: one.id, login: one.account.login };
  }
  const all = z.array(installationSchema).parse(await appRequest(config, "/app/installations"));
  if (all.length === 0) throw new Error("The GitHub App isn't installed on any account. Install it from the app's settings page.");
  if (all.length > 1) throw new Error(`The GitHub App is installed on ${all.length} accounts. Set GITHUB_APP_INSTALLATION_ID to pick one.`);
  return { id: all[0]!.id, login: all[0]!.account.login };
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

/** Holds one installation's token and renews it before it lapses. */
export class AppAuth {
  private installation: Installation | null = null;
  private cached: CachedToken | null = null;
  private minting: Promise<string> | null = null;

  constructor(private readonly config: AppConfig) {}

  /** The account the app is installed on, once a token has been minted. */
  login(): string | null {
    return this.installation?.login ?? null;
  }

  /** The current token without renewing it. Only for scrubbing it out of messages. */
  current(): string | null {
    return this.cached?.token ?? null;
  }

  /** A token valid for at least the next few minutes. One mint at a time. */
  token(nowMs = Date.now()): Promise<string> {
    if (this.cached && nowMs < this.cached.expiresAt - TOKEN_MARGIN_MS) return Promise.resolve(this.cached.token);
    this.minting ??= this.mint().finally(() => {
      this.minting = null;
    });
    return this.minting;
  }

  /** Drop the cached token after GitHub refused it, so the next call mints a new one. */
  invalidate(token: string): void {
    if (this.cached?.token === token) this.cached = null;
  }

  private async mint(): Promise<string> {
    this.installation ??= await findInstallation(this.config);
    const body = tokenSchema.parse(await appRequest(this.config, `/app/installations/${this.installation.id}/access_tokens`, "POST"));
    this.cached = { token: body.token, expiresAt: Date.parse(body.expires_at) };
    console.log(`[github] app token minted for ${this.installation.login}, expires ${body.expires_at}`);
    return body.token;
  }
}
