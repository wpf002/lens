/**
 * `.lens/probe.json`: which POST routes are safe to send, the two test accounts
 * used for IDOR checks, and rate limits. The file names env vars; it never holds
 * session values, so it can be committed.
 */
import { z } from "zod";

export const PROBE_RATE_LIMIT_DEFAULT = 5;
export const PROBE_RATE_LIMIT_MAX = 20;
export const PROBE_MAX_REQUESTS_DEFAULT = 500;
export const PROBE_MAX_REQUESTS_HARD = 2000;

const FORBIDDEN_HEADERS = new Set(["host", "origin", "content-length", "transfer-encoding", "connection"]);
const headerName = z.string().regex(/^[A-Za-z0-9-]{1,64}$/).refine((h) => !FORBIDDEN_HEADERS.has(h.toLowerCase()), "this header can't be set by probe config");
const envVarName = z.string().regex(/^[A-Z_][A-Z0-9_]{0,63}$/, "env var names are UPPER_SNAKE_CASE");

const AccountSchema = z.object({
  headersFromEnv: z.record(headerName, envVarName).refine((r) => Object.keys(r).length >= 1 && Object.keys(r).length <= 10, "1 to 10 headers"),
});

const objectId = z.string().min(1).max(200).regex(/^[^/?#\s]+$/, "object ids can't contain / ? # or whitespace");

export const ProbeConfigSchema = z.object({
  safeToProbe: z.array(z.string().regex(/^POST \/\S{0,300}$/, 'entries look like "POST /api/search"')).max(200).default([]),
  accounts: z.object({ a: AccountSchema, b: AccountSchema }).optional(),
  objects: z.record(z.string().regex(/^\/\S{0,300}$/), z.object({ a: objectId, b: objectId })).default({}),
  rateLimit: z.number().positive().max(PROBE_RATE_LIMIT_MAX).default(PROBE_RATE_LIMIT_DEFAULT),
  maxRequests: z.number().int().positive().max(PROBE_MAX_REQUESTS_HARD).default(PROBE_MAX_REQUESTS_DEFAULT),
}).strict();

export type ProbeConfig = z.infer<typeof ProbeConfigSchema>;
export type AccountName = "a" | "b";
export type AccountHeaders = Record<AccountName, Record<string, string>>;

/** Read each account's headers from the environment. Fails if any named variable is unset. */
export function resolveAccounts(config: ProbeConfig, env: Record<string, string | undefined>): AccountHeaders | undefined {
  if (!config.accounts) return undefined;
  const missing: string[] = [];
  const read = (account: z.infer<typeof AccountSchema>) => {
    const headers: Record<string, string> = {};
    for (const [header, variable] of Object.entries(account.headersFromEnv)) {
      const value = env[variable];
      if (!value) missing.push(variable);
      else headers[header] = value;
    }
    return headers;
  };
  const resolved = { a: read(config.accounts.a), b: read(config.accounts.b) };
  if (missing.length) throw new Error(`Probe accounts need these env vars set: ${missing.join(", ")}`);
  return resolved;
}
