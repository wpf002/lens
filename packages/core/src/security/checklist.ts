/**
 * Pre-launch security checklist. Each item gets a status from evidence Lens can
 * see without an LLM; items that need reading intent (ownership checks, token
 * lifetimes...) stay "unverified" until an AI audit or a human fills them in.
 *
 * Status meanings:
 *  - pass: positive evidence the control exists
 *  - fail: evidence of a gap
 *  - clear: the scanner looked and found nothing wrong (not proof)
 *  - unverified: needs code review (AI audit or human)
 *  - manual: outside the repo (dashboards, keys); a to-do for the owner
 *  - na: doesn't apply to this project
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { Finding, GraphNode, SecurityReport } from "../types.js";
import type { SupplyChainStatus } from "./supply-chain.js";
import type { HistoryScan } from "./git-history.js";

export type CheckStatus = "pass" | "fail" | "clear" | "unverified" | "manual" | "na";

export interface ChecklistItem {
  id: string;
  tier: 1 | 2 | 3;
  title: string;
  status: CheckStatus;
  /** file:line references or short facts backing the status. */
  evidence: string[];
  /** What to do when it isn't passing. */
  fix?: string;
  source: "scanner" | "repo" | "ai" | "manual";
}

export interface ChecklistInput {
  root: string;
  files: Array<{ path: string; src: string }>;
  deps: Record<string, string>;
  endpoints: GraphNode[];
  security: SecurityReport;
  /** Registry check coverage; absent when supply-chain checks didn't run. */
  supplyChain?: SupplyChainStatus;
  /** Secrets found in git history; absent when the root isn't a git repo. */
  gitHistory?: HistoryScan;
}

const read = (root: string, rel: string): string | null => {
  try {
    return readFileSync(path.join(root, rel), "utf8");
  } catch {
    return null;
  }
};
const exists = (root: string, rel: string) => existsSync(path.join(root, rel));
const listDir = (root: string, rel: string): string[] => {
  try {
    return readdirSync(path.join(root, rel));
  } catch {
    return [];
  }
};

const has = (deps: Record<string, string>, ...names: Array<string | RegExp>) =>
  Object.keys(deps).filter((d) => names.some((n) => (typeof n === "string" ? d.toLowerCase() === n : n.test(d))));

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "venv", ".venv", "__pycache__", "target", "vendor", ".lens"]);

/** Root and first-level subdirectory paths (e.g. `frontend/nginx.conf`) whose basename matches. */
function findShallow(root: string, match: (name: string) => boolean): string[] {
  const out = listDir(root, "").filter(match);
  for (const d of listDir(root, "")) {
    if (SKIP_DIRS.has(d) || d.startsWith(".")) continue;
    for (const f of listDir(root, d)) if (match(f)) out.push(`${d}/${f}`);
  }
  return out;
}

const at = (f: Pick<Finding, "path" | "line">) => `${f.path}:${f.line}`;

/** Find `re` in project files; returns up to `max` file:line hits. */
function grep(files: ChecklistInput["files"], re: RegExp, filter?: (p: string) => boolean, max = 6): string[] {
  const out: string[] = [];
  for (const f of files) {
    if (filter && !filter(f.path)) continue;
    const lines = f.src.split("\n");
    for (let i = 0; i < lines.length && out.length < max; i++) if (re.test(lines[i]!)) out.push(`${f.path}:${i + 1}`);
    if (out.length >= max) break;
  }
  return out;
}

const isCode = (p: string) => /\.(m?[jt]sx?|py|go|rb|php|java|kt|cs|rs)$/.test(p) && !/(^|\/)(tests?|__tests__|spec|fixtures?)\//.test(p) && !/\.(test|spec)\./.test(p);

function realDepsItem(deps: Record<string, string>, hits: Finding[], status: SupplyChainStatus | undefined): ChecklistItem {
  const base = { id: "t3-realdeps", tier: 3 as const, title: "Every dependency real, maintained, correctly named" };
  const count = Object.keys(deps).length;
  if (!count && !status?.packages && !hits.length) return { ...base, status: "na", evidence: ["No dependency manifests."], source: "repo" };
  if (hits.length) {
    return { ...base, status: "fail", source: "scanner", evidence: hits.slice(0, 8).map((f) => `${at(f)} ${f.title}`), fix: "Run Remediate to replace, pin, or remove the flagged dependencies." };
  }
  if (!status) return { ...base, status: "unverified", source: "ai", evidence: [`${count} dependencies. Registry checks didn't run.`] };
  const gaps: string[] = [];
  if (status.skipped) gaps.push(`Registry checks skipped for ${status.skipped} of ${status.packages} packages (${status.skippedReason ?? "unknown"}). Rescan online to finish them.`);
  if (status.unsupported.length) gaps.push(`No registry checks for ${status.unsupported.join(", ")}.`);
  if (gaps.length) return { ...base, status: "unverified", source: "scanner", evidence: gaps };
  return { ...base, status: "clear", source: "scanner", evidence: [`${status.checked} packages checked against their registries: no typosquats, missing, new, or deprecated packages.`] };
}

const GIT_SECRETS_TITLE = "No secrets committed to the repository";

/** Secrets in current files are code fixes; ones only left in history need the owner to rotate the key. */
function gitSecretsCheck(current: Finding[], history: HistoryScan | undefined): ChecklistItem {
  const base = { id: "t1-git-secrets", tier: 1 as const, title: GIT_SECRETS_TITLE, source: "scanner" as const };
  if (current.length) return { ...base, status: "fail", evidence: current.slice(0, 8).map((f) => `${at(f)} ${f.title}`), fix: "Rotate each key first, then remove it from the code." };
  if (!history) return { ...base, status: "clear", evidence: ["None in the current files. Git history wasn't available to scan."] };
  const scope = `${history.commits} commit${history.commits === 1 ? "" : "s"}${history.shallow ? " (latest only; older history not cloned)" : ""}`;
  if (!history.hits.length) return { ...base, status: "pass", evidence: [`None in the current files or in ${scope} of git history.`] };
  return {
    ...base,
    status: "manual",
    evidence: history.hits.slice(0, 8).map((h) => `${h.commit} ${h.path}: ${h.title} (${h.snippet})`),
    fix: "Rotate each key listed. Deleting it from the code doesn't remove it from git history.",
  };
}

export function buildChecklist(input: ChecklistInput): ChecklistItem[] {
  const { root, files, deps, endpoints, security } = input;
  const open = security.findings.filter((f) => f.status === "open" || f.status === "confirmed");
  const openBy = (pred: (f: Finding) => boolean) => open.filter(pred);
  const items: ChecklistItem[] = [];
  const add = (i: ChecklistItem) => items.push(i);
  const ruleCheck = (id: string, tier: 1 | 2 | 3, title: string, pred: (f: Finding) => boolean, fix: string, clearNote = "Scanner found no instances.") => {
    const hits = openBy(pred);
    add({ id, tier, title, source: "scanner", status: hits.length ? "fail" : "clear", evidence: hits.length ? hits.slice(0, 8).map((f) => `${at(f)} ${f.title}`) : [clearNote], fix: hits.length ? fix : undefined });
  };

  const aiDeps = has(deps, "openai", "@anthropic-ai/sdk", "anthropic", "@google/generative-ai", "@google/genai", "google-generativeai", "cohere", "cohere-ai", "replicate", "@mistralai/mistralai", "mistralai", "groq-sdk", "groq", "together-ai", "ai", "@ai-sdk/openai", "@ai-sdk/anthropic", "langchain", "@langchain/core", "llamaindex", "litellm");
  const authDeps = has(deps, "next-auth", /^@auth\//, /^@clerk\//, "@supabase/supabase-js", "@supabase/ssr", "auth0", /^@auth0\//, "firebase", "firebase-admin", "lucia", "better-auth", "@kinde-oss/kinde-auth-nextjs", "@workos-inc/node", "django-allauth", "fastapi-users", "authlib", "devise", "@stytch/nextjs", "stytch");
  const homemadeAuth = has(deps, "bcrypt", "bcryptjs", "argon2", "passlib", "jsonwebtoken", "jose", "pyjwt", "python-jose", "express-session", "cookie-session", "iron-session");
  const stripe = has(deps, "stripe", "@stripe/stripe-js");
  const hasUsers = authDeps.length > 0 || homemadeAuth.length > 0;

  /* ---------------- Tier 1 ---------------- */
  {
    const unauth = openBy((f) => f.rule === "unauthenticated-mutation" || f.rule === "server-action-no-auth");
    const accepted = security.findings.filter((f) => (f.rule === "unauthenticated-mutation" || f.rule === "server-action-no-auth") && (f.status === "accepted" || f.status === "false_positive"));
    const unguardedReads = endpoints.filter((e) => e.endpoint?.auth === "unguarded" && ["GET", "HEAD"].includes((e.endpoint.method ?? "").toUpperCase()));
    if (!endpoints.length) add({ id: "t1-auth", tier: 1, title: "Auth enforced server-side on every non-public route", status: "na", evidence: ["No routes or server actions detected."], source: "scanner" });
    else if (unauth.length) add({ id: "t1-auth", tier: 1, title: "Auth enforced server-side on every non-public route", status: "fail", evidence: unauth.slice(0, 8).map((f) => `${at(f)} ${f.message.split(" has ")[0]}`), fix: "Check the session inside each handler (not only in middleware), or triage the route as public by design.", source: "scanner" });
    else add({ id: "t1-auth", tier: 1, title: "Auth enforced server-side on every non-public route", status: unguardedReads.length ? "unverified" : "clear", evidence: [...(accepted.length ? [`${accepted.length} unauthenticated routes triaged as public by design`] : []), ...(unguardedReads.length ? [`${unguardedReads.length} GET routes have no visible auth; confirm each is meant to be public`] : ["Every state-changing route has visible auth or a triage verdict."])], source: "scanner" });
  }
  add({ id: "t1-idor", tier: 1, title: "Every object lookup scoped to the caller (no IDOR)", status: hasUsers ? "unverified" : "na", evidence: [hasUsers ? "Needs code review: can user A read or modify user B's record?" : "No user accounts detected."], source: "ai" });
  add({ id: "t1-admin", tier: 1, title: "Admin and role checks on the server", status: hasUsers ? "unverified" : "na", evidence: [hasUsers ? "Needs code review." : "No user accounts detected."], source: "ai" });
  ruleCheck("t1-mass-assign", 1, "No mass assignment (request body never spread into the DB)", (f) => f.category === "mass-assignment", "Pick allowed fields explicitly; never spread req.body into create/update data.");
  {
    const publicSecret = grep(
      files,
      /\b(?:NEXT_PUBLIC_|VITE_|REACT_APP_|EXPO_PUBLIC_|PUBLIC_)[A-Z0-9_]*(?:SECRET|PRIVATE|PASSWORD|SERVICE_ROLE|API_KEY|TOKEN)\b/,
      (p) => !/\.md$/.test(p),
    ).filter((hit) => !/PUBLISHABLE|ANON_KEY|SITE_KEY|DSN|MEASUREMENT|POSTHOG|GA_/.test(hit));
    const frontendSecrets = openBy((f) => f.category === "secrets" && /(^|\/)(frontend|web|client|app|src\/(components|pages|app))\//.test(f.path));
    const hits = [...publicSecret, ...frontendSecrets.map((f) => `${at(f)} ${f.title}`)];
    add({ id: "t1-bundle", tier: 1, title: "No secrets in the frontend bundle", status: hits.length ? "fail" : "clear", evidence: hits.length ? hits : ["No secret-looking public env vars or client-side secrets found."], fix: hits.length ? "Move the value server-side; anything prefixed NEXT_PUBLIC_/VITE_ ships to every visitor." : undefined, source: "scanner" });
  }
  {
    const secrets = openBy((f) => f.category === "secrets");
    add(gitSecretsCheck(secrets, input.gitHistory));
  }
  {
    const ev: string[] = [];
    let fail = false;
    const gi = read(root, ".gitignore") ?? "";
    const ignoresEnv = /^\s*(?:\/?\.env(?:\*|\.\*)?|\*\.env|\.env\.local)\s*$/m.test(gi);
    ev.push(ignoresEnv ? ".gitignore ignores .env" : ".gitignore does not ignore .env");
    fail ||= !ignoresEnv;
    const committedEnv = files.map((f) => f.path).filter((p) => /(^|\/)\.env(\.(local|production|prod|development|dev))?$/.test(p));
    if (committedEnv.length) {
      ev.push(`env file in the project: ${committedEnv.join(", ")}`);
      fail = true;
    }
    const example = [".env.example", ".env.sample", ".env.template"].find((p) => exists(root, p)) ?? files.map((f) => f.path).find((p) => /(^|\/)\.env\.(example|sample|template)$/.test(p));
    ev.push(example ? `${example} present` : "no .env.example");
    fail ||= !example;
    const hookFiles = [".pre-commit-config.yaml", "lefthook.yml", "lefthook.yaml", ".lefthook.yml", ...listDir(root, ".husky").map((f) => `.husky/${f}`)];
    const hook = hookFiles.find((p) => /gitleaks|trufflehog|detect-secrets|git-secrets/.test(read(root, p) ?? ""));
    ev.push(hook ? `secret-scanning pre-commit hook in ${hook}` : "no gitleaks pre-commit hook");
    fail ||= !hook;
    add({ id: "t1-env", tier: 1, title: ".env gitignored, .env.example present, gitleaks pre-commit hook", status: fail ? "fail" : "pass", evidence: ev, fix: fail ? "Add `.env*` (with `!.env.example`) to .gitignore and a gitleaks hook via pre-commit or husky." : undefined, source: "repo" });
  }
  add({
    id: "t1-spend", tier: 1, title: "Paid AI APIs behind spend caps", status: aiDeps.length ? "manual" : "na",
    evidence: aiDeps.length ? aiDeps.map((d) => `Uses ${d}. Set a monthly cap in its billing console.`) : ["No paid AI SDKs detected."],
    source: "manual",
  });
  {
    const webhook = openBy((f) => f.rule === "webhook-no-signature");
    if (!stripe.length) add({ id: "t1-stripe", tier: 1, title: "Prices set server-side; access granted only from a verified Stripe webhook", status: "na", evidence: ["Stripe not used."], source: "scanner" });
    else add({ id: "t1-stripe", tier: 1, title: "Prices set server-side; access granted only from a verified Stripe webhook", status: webhook.length ? "fail" : "unverified", evidence: webhook.length ? webhook.map((f) => `${at(f)} ${f.title}`) : ["Webhook signature checks look present; confirm prices never come from the client."], fix: webhook.length ? "Verify with stripe.webhooks.constructEvent before granting anything." : undefined, source: webhook.length ? "scanner" : "ai" });
  }

  /* ---------------- Tier 2 ---------------- */
  add({
    id: "t2-provider", tier: 2, title: "Real auth provider, no homemade password or session handling",
    status: authDeps.length ? "pass" : homemadeAuth.length ? "unverified" : "na",
    evidence: authDeps.length ? authDeps.map((d) => `uses ${d}`) : homemadeAuth.length ? homemadeAuth.map((d) => `hand-rolled auth primitives: ${d}`) : ["No user accounts detected."],
    source: authDeps.length || !homemadeAuth.length ? "repo" : "ai",
  });
  add({ id: "t2-tokens", tier: 2, title: "Short-lived access tokens; refresh tokens revoked on logout", status: hasUsers ? "unverified" : "na", evidence: [hasUsers ? "Needs code review." : "No user accounts detected."], source: "ai" });
  {
    const libs = has(deps, "express-rate-limit", "@fastify/rate-limit", "slowapi", "@upstash/ratelimit", "rate-limiter-flexible", "django-ratelimit", "flask-limiter", "rack-attack", "hono-rate-limiter", "@nestjs/throttler", "limiter");
    const uses = grep(files, /\b(rateLimit|ratelimit|limiter\.limit|@limiter\.limit|Throttle|throttle)\b/, isCode, 4);
    const status: CheckStatus = !endpoints.length ? "na" : libs.length ? (uses.length ? "pass" : "unverified") : "fail";
    add({ id: "t2-ratelimit", tier: 2, title: "Rate limits on auth, email sends, and AI endpoints", status, evidence: libs.length ? [...libs.map((d) => `uses ${d}`), ...uses] : endpoints.length ? ["No rate-limiting library found."] : ["No routes detected."], fix: status === "fail" ? "Add a limiter (e.g. express-rate-limit, slowapi, @upstash/ratelimit) to login, signup, reset, email, and AI routes." : undefined, source: "repo" });
  }
  {
    const libs = has(deps, "zod", "pydantic", "joi", "yup", "valibot", "class-validator", "@sinclair/typebox", "ajv", "marshmallow", "superstruct", "arktype");
    const strict = grep(files, /\.strict\(\)|extra\s*=\s*["']forbid["']|Extra\.forbid|additionalProperties\s*:\s*false|forbidNonWhitelisted|forbid_extra|\.noUnknown\(/, isCode, 4);
    const status: CheckStatus = !endpoints.length ? "na" : !libs.length ? "fail" : strict.length ? "pass" : "fail";
    add({ id: "t2-validation", tier: 2, title: "Schema validation on every route, unknown fields rejected", status, evidence: [...libs.map((d) => `uses ${d}`), ...(strict.length ? strict : libs.length ? ["Unknown fields are accepted silently (no .strict() / extra='forbid')."] : ["No validation library found."])], fix: status === "fail" ? (libs.length ? "Use .strict() on Zod request schemas, or model_config = ConfigDict(extra='forbid') on Pydantic models." : "Validate every request body with Zod or Pydantic.") : undefined, source: "repo" });
  }
  ruleCheck("t2-ssrf", 2, "SSRF: user-supplied URLs can't reach private or metadata IPs", (f) => f.category === "ssrf", "Resolve the host, block private/loopback/link-local and 169.254.169.254, pin the IP, cap redirects.", "No server-side fetch of a user-supplied URL found.");
  add({ id: "t2-agents", tier: 2, title: "Model input untrusted; agent tools constrained", status: aiDeps.length ? "unverified" : "na", evidence: [aiDeps.length ? `AI code present (${aiDeps.join(", ")}); review tool permissions and prompt-injection paths.` : "No AI SDKs detected."], source: "ai" });
  add({ id: "t2-prodcreds", tier: 2, title: "Production credentials not reachable by agents or dev tooling", status: "manual", evidence: ["Keep prod keys out of local .env files and agent-accessible shells."], source: "manual" });
  {
    const storage = has(deps, "@aws-sdk/client-s3", "aws-sdk", "boto3", "@google-cloud/storage", "@vercel/blob", "cloudinary", "uploadthing", "multer", "formidable", "@supabase/storage-js", "minio");
    add({ id: "t2-storage", tier: 2, title: "Storage private; files via signed URLs; uploads not served from the app origin", status: storage.length ? "unverified" : "na", evidence: storage.length ? storage.map((d) => `uses ${d}`) : ["No file storage or upload libraries detected."], source: storage.length ? "ai" : "repo" });
  }
  ruleCheck("t2-xss", 2, "No dangerouslySetInnerHTML / unsanitized HTML on user or model output", (f) => f.category === "xss", "Render text, or sanitize with DOMPurify before injecting HTML.");
  ruleCheck("t2-csrf", 2, "CSRF protection if auth uses cookies", (f) => f.rule === "csrf-disabled" || f.rule === "cookie-insecure", "Use SameSite=Lax/Strict cookies plus a CSRF token on state-changing forms.");
  add({ id: "t2-errors", tier: 2, title: "No stack traces or err.message returned on 5xx in production", status: endpoints.length ? "unverified" : "na", evidence: [endpoints.length ? "Needs code review of the error handler." : "No routes detected."], source: "ai" });
  {
    const debug = openBy((f) => f.rule === "debug-enabled").map((f) => `${at(f)} debug mode`);
    const fastapiDocs = grep(files, /\bFastAPI\s*\(/, (p) => p.endsWith(".py"), 3).filter((hit) => {
      const [p] = hit.split(":");
      const src = files.find((f) => f.path === p)?.src ?? "";
      return !/docs_url\s*=\s*None|docs_url\s*=\s*.*if/.test(src);
    }).map((h) => `${h} FastAPI serves /docs and /openapi.json by default`);
    const swagger = has(deps, "swagger-ui-express", "@fastify/swagger-ui", "@nestjs/swagger").map((d) => `uses ${d}: confirm it's off in production`);
    const hits = [...debug, ...fastapiDocs, ...swagger];
    add({ id: "t2-debug", tier: 2, title: "No public source maps, debug routes, Swagger or GraphQL introspection in prod", status: debug.length || fastapiDocs.length ? "fail" : swagger.length ? "unverified" : "clear", evidence: hits.length ? hits : ["No debug flags or API explorers found."], fix: hits.length ? "Disable in production, e.g. FastAPI(docs_url=None, redoc_url=None, openapi_url=None) when IS_PRODUCTION." : undefined, source: "scanner" });
  }
  add({ id: "t2-staging", tier: 2, title: "Preview/staging don't share the prod DB or prod secrets", status: "manual", evidence: ["Check your hosting dashboard's per-environment variables."], source: "manual" });

  /* ---------------- Tier 3 ---------------- */
  {
    const LOCKS = new Set(["pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lockb", "bun.lock", "poetry.lock", "uv.lock", "Pipfile.lock", "Cargo.lock", "go.sum", "Gemfile.lock", "composer.lock"]);
    // A pip-compile style requirements.txt (every line pinned with ==) is a lockfile too.
    const pinnedReqs = findShallow(root, (n) => n === "requirements.txt").filter((p) => {
      const reqs = (read(root, p) ?? "").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#") && !l.startsWith("-"));
      return reqs.length > 0 && reqs.every((l) => /==/.test(l));
    });
    const lock = [...findShallow(root, (n) => LOCKS.has(n)), ...pinnedReqs];
    const workflows = listDir(root, ".github/workflows").map((f) => `.github/workflows/${f}`);
    const ci = workflows.map((p) => read(root, p) ?? "").join("\n");
    const installs = /\b(npm (install|i)\b|pnpm install|yarn install|yarn\b(?! --immutable)|bun install)/.test(ci);
    const frozen = /--frozen-lockfile|npm ci\b|--immutable|--locked|pip install --require-hashes|uv sync --frozen|poetry install/.test(ci);
    const ev = [lock.length ? `lockfile: ${lock.slice(0, 3).join(", ")}` : "no lockfile", workflows.length ? (frozen ? "CI installs from the lockfile" : installs ? "CI installs without --frozen-lockfile" : "CI doesn't install JS deps") : "no CI workflows"];
    const status: CheckStatus = !lock.length || (installs && !frozen) ? "fail" : "pass";
    add({ id: "t3-lockfile", tier: 3, title: "Lockfile committed; CI installs with --frozen-lockfile", status, evidence: ev, fix: status === "fail" ? "Commit the lockfile and use `pnpm install --frozen-lockfile` / `npm ci` in CI." : undefined, source: "repo" });
    const scanning = [exists(root, ".github/dependabot.yml") || exists(root, ".github/dependabot.yaml") ? ".github/dependabot.yml" : "", exists(root, "renovate.json") || exists(root, ".github/renovate.json") ? "renovate.json" : "", /\b(pnpm|npm|yarn) audit|pip-audit|osv-scanner|snyk|trivy|safety check/.test(ci) ? "audit step in CI" : ""].filter(Boolean);
    add({ id: "t3-depscan", tier: 3, title: "Dependency scanning (Dependabot, Renovate, or an audit step)", status: scanning.length ? "pass" : "fail", evidence: scanning.length ? scanning : ["No Dependabot/Renovate config or audit step in CI."], fix: scanning.length ? undefined : "Add .github/dependabot.yml, or run `lens security --osv` in CI.", source: "repo" });
  }
  add(realDepsItem(deps, openBy((f) => f.category === "supply-chain"), input.supplyChain));
  {
    const agentFiles = ["CLAUDE.md", "AGENTS.md", ".mcp.json", ".cursorrules", ".cursor", ".claude", ".windsurfrules", "GEMINI.md", ".github/copilot-instructions.md"].filter((p) => exists(root, p));
    add({ id: "t3-agentcfg", tier: 3, title: "CLAUDE.md, skills and MCP configs reviewed for commands and secrets", status: agentFiles.length ? "unverified" : "na", evidence: agentFiles.length ? agentFiles.map((p) => `${p} present`) : ["No agent config files."], source: agentFiles.length ? "ai" : "repo" });
  }
  {
    const lib = has(deps, "helmet", "@fastify/helmet", "secure", "django-csp", "flask-talisman", "secure-headers");
    const HEADER_RE = /Content-Security-Policy|contentSecurityPolicy|async headers\s*\(|headers:\s*async|X-Frame-Options|Strict-Transport-Security/;
    const code = grep(files, HEADER_RE, (p) => !/\.md$/.test(p), 4);
    // Headers often live in server/CDN config the scanner doesn't parse.
    const configs = findShallow(root, (n) => /^nginx.*\.conf$|\.nginx$|^_headers$|^vercel\.json$|^netlify\.toml$|^Caddyfile$|^staticwebapp\.config\.json$|^next\.config\.[mc]?[jt]s$|headers.*\.conf$/.test(n));
    for (const c of configs) {
      const lines = (read(root, c) ?? "").split("\n");
      const i = lines.findIndex((l) => HEADER_RE.test(l));
      if (i >= 0 && !code.some((h) => h.startsWith(`${c}:`))) code.push(`${c}:${i + 1}`);
    }
    add({ id: "t3-headers", tier: 3, title: "Security headers and CSP", status: lib.length || code.length ? "pass" : endpoints.length ? "fail" : "na", evidence: lib.length || code.length ? [...lib.map((d) => `uses ${d}`), ...code] : ["No helmet, headers(), or CSP found."], fix: lib.length || code.length ? undefined : "Add helmet / @fastify/helmet, or headers() in next.config, with a CSP.", source: "repo" });
  }
  {
    const wildcard = openBy((f) => f.rule === "cors-wildcard-credentials").map((f) => `${at(f)} ${f.title}`);
    const reflect = grep(files, /origin\s*:\s*true|allow_origins\s*=\s*\[\s*["']\*["']\s*\]|Access-Control-Allow-Origin["']?\s*[:,]\s*["']\*["']/, isCode, 4);
    const hits = [...wildcard, ...reflect];
    add({ id: "t3-cors", tier: 3, title: "CORS is an explicit allowlist on credentialed routes", status: hits.length ? "fail" : "clear", evidence: hits.length ? hits : ["No wildcard or reflected CORS origins found."], fix: hits.length ? "List allowed origins explicitly." : undefined, source: "scanner" });
  }
  ruleCheck("t3-rawsql", 3, "No $queryRawUnsafe / string-built SQL", (f) => f.category === "injection", "Use parameterized queries or tagged $queryRaw templates.");
  {
    const direct = has(deps, "@supabase/supabase-js", "firebase", "@firebase/firestore");
    add({ id: "t3-rls", tier: 3, title: "Row-level security if clients talk to the DB directly", status: direct.length ? "unverified" : "na", evidence: direct.length ? direct.map((d) => `uses ${d}: check RLS policies on every table`) : ["No client-side database access detected."], source: direct.length ? "ai" : "repo" });
  }
  add({ id: "t3-logs", tier: 3, title: "Logs redact auth headers, cookies, tokens, passwords, PII", status: endpoints.length ? "unverified" : "na", evidence: [endpoints.length ? "Needs code review of logging." : "No routes detected."], source: "ai" });
  add({ id: "t3-auditlog", tier: 3, title: "Audit log for logins, permission changes, deletes, exports, payments", status: hasUsers || stripe.length ? "unverified" : "na", evidence: [hasUsers || stripe.length ? "Needs code review." : "No accounts or payments detected."], source: "ai" });
  add({ id: "t3-backups", tier: 3, title: "Backups configured with a documented restore procedure", status: "manual", evidence: ["Check your database host's backup settings and write down the restore steps."], source: "manual" });

  return items;
}
