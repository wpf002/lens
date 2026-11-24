/** Every Lens check, restated as an instruction Claude Code can follow while writing code. */
export interface CatalogRule {
  rule: string;
  /** Ids of the Lens checks this rule prevents. */
  checks: string[];
}

export interface CatalogGroup {
  heading: string;
  rules: CatalogRule[];
}

export interface CatalogSection {
  title: string;
  groups: CatalogGroup[];
}

export const RULES_BLOCK_BEGIN = "<!-- lens-rules:begin -->";
export const RULES_BLOCK_END = "<!-- lens-rules:end -->";

const SECRET_DETECTORS = [
  "aws-access-key", "aws-secret-key", "github-token", "slack-token", "slack-webhook", "stripe-live-key", "google-api-key",
  "openai-key", "anthropic-key", "private-key", "db-url-password", "twilio-key", "sendgrid-key", "npm-token",
];

export const RULES_CATALOG: CatalogSection[] = [
  {
    title: "Security",
    groups: [
      {
        heading: "Injection",
        rules: [
          {
            rule: "Never pass request data to a shell. Use execFile/spawn with an argument array and no `shell: true` (Node), `subprocess.run([...])` without `shell=True` (Python), `exec.Command` with separate args (Go), `ProcessBuilder` with a list (Java), array-form `system` (Ruby), `escapeshellarg` (PHP).",
            checks: ["js-exec-shell", "js-spawn-tainted", "js-shell-true", "py-exec", "go-exec", "java-exec", "rb-exec", "php-exec"],
          },
          { rule: "Never use `eval`, `new Function`, string `setTimeout`, Python `eval`/`exec`, or PHP `eval` on dynamic input.", checks: ["js-eval", "py-eval", "php-eval"] },
          {
            rule: "Build SQL with parameters or the ORM's query builder only. No template literals or concatenation into `query()`, no f-strings or `%` in `cursor.execute`, no `Sprintf` SQL in Go, no concatenated JDBC (use `PreparedStatement`). In Prisma use tagged `$queryRaw`, never `$queryRawUnsafe`/`$executeRawUnsafe`; same for `raw()` in Knex, Sequelize and TypeORM.",
            checks: ["sql-template-concat", "py-sql-format", "prisma-raw-unsafe", "js-orm-raw", "go-sql-sprintf", "java-sql-concat", "dyn-sql-error"],
          },
          { rule: "Never pass a request body or query object straight into a MongoDB/NoSQL filter. Pick and type-check each field so `{ $ne: null }` can't get in.", checks: ["nosql-injection"] },
          { rule: "Never build a `RegExp` from user input. Escape it or use a plain string match.", checks: ["regex-from-input"] },
          { rule: "Disable external entities and DTDs in every XML parser (`defusedxml` in Python).", checks: ["xxe"] },
          { rule: "Never deserialize untrusted data with `pickle`, `yaml.load` (use `safe_load`), `node-serialize`, Java `ObjectInputStream`, Ruby `Marshal.load`/`YAML.load`, or PHP `unserialize`. Use JSON.", checks: ["py-unsafe-deser", "js-unsafe-deser", "java-unsafe-deser", "rb-unsafe-deser", "php-unserialize"] },
        ],
      },
      {
        heading: "Output and Requests",
        rules: [
          {
            rule: "Don't render raw HTML from data: no `dangerouslySetInnerHTML`, `innerHTML`/`outerHTML`/`document.write`, `v-html`, `|safe`/`Markup`/autoescape off, `html_safe`/`raw`, or echoed request input in PHP without `htmlspecialchars`. If HTML is required, sanitize it with DOMPurify first.",
            checks: ["react-dangerous-html", "dom-innerhtml", "vue-v-html", "py-template-unsafe", "rb-html-safe", "php-echo-input", "dyn-reflected-xss"],
          },
          { rule: "Don't fetch a URL taken from the request. Allowlist hosts and block private and link-local IPs on any outbound call built from user input.", checks: ["ssrf-request-url"] },
          { rule: "Redirect only to relative paths or an allowlist, never to a raw `next`/`returnTo`/`url` parameter.", checks: ["open-redirect"] },
          { rule: "Never build a file path from request input. Resolve it against a fixed base directory and reject anything that escapes it.", checks: ["path-traversal"] },
          { rule: "Never persist a request body wholesale (`create({ data: req.body })`, `Model(**request.json)`, `update(params)`). Pick allowed fields through a schema.", checks: ["mass-assignment"] },
          { rule: "Validate every route's body, query and params with a schema (Zod in TS, Pydantic in Python) that rejects unknown fields.", checks: ["t2-validation"] },
          { rule: "Never return stack traces or `err.message` to clients on 5xx in production. Log the detail, return a generic error with a request id.", checks: ["t2-errors", "dyn-verbose-error"] },
        ],
      },
      {
        heading: "Auth and Access",
        rules: [
          { rule: "Enforce auth on the server on every non-public route, every mutation handler (POST/PUT/PATCH/DELETE) and every server action. Hiding a button in the UI is not access control.", checks: ["t1-auth", "unauthenticated-mutation", "server-action-no-auth"] },
          { rule: "Scope every lookup by id to the caller (`where: { id, userId }`). Never load an object by id alone.", checks: ["t1-idor", "dyn-idor"] },
          { rule: "Check admin and role permissions on the server, never only in the client.", checks: ["t1-admin"] },
          { rule: "Use a real auth provider or library (Auth.js, Clerk, Supabase Auth, Devise). No homemade password storage or session handling.", checks: ["t2-provider"] },
          { rule: "Keep access tokens short-lived and revoke refresh tokens on logout.", checks: ["t2-tokens"] },
          { rule: "Verify JWTs with `jwt.verify` and a pinned algorithm list. Never trust `jwt.decode` or `verify_signature: False`.", checks: ["jwt-no-verify"] },
          { rule: "Set session cookies with `httpOnly`, `secure` and `sameSite`.", checks: ["cookie-insecure"] },
          { rule: "Keep CSRF protection on for cookie-authenticated forms and mutations.", checks: ["csrf-disabled"] },
          { rule: "CORS on credentialed routes is an explicit origin allowlist. Never a wildcard or a reflected `Origin` with credentials.", checks: ["cors-wildcard-credentials", "t3-cors", "dyn-cors-reflect"] },
          { rule: "Rate limit auth, signup, password reset, email sends and AI endpoints.", checks: ["t2-ratelimit"] },
          { rule: "If clients talk to the database directly (Supabase, Firebase), enable row-level security on every table.", checks: ["t3-rls"] },
        ],
      },
      {
        heading: "Payments and AI",
        rules: [
          { rule: "Set prices on the server and grant paid access only from a verified Stripe webhook, never from a client redirect or a client-sent amount.", checks: ["t1-stripe"] },
          { rule: "Verify the signature on every incoming webhook (Stripe `constructEvent`, GitHub HMAC with `timingSafeEqual`) before trusting its body.", checks: ["webhook-no-signature"] },
          { rule: "Put paid AI API calls behind per-user limits and a spend cap.", checks: ["t1-spend"] },
          { rule: "Treat model input and output as untrusted. Limit agent tools to an allowlist with least privilege, and never let model text reach a shell, SQL or `eval`.", checks: ["t2-agents"] },
          { rule: "Keep production credentials out of reach of agents and dev tooling: no prod keys in local `.env`, MCP configs, or CI jobs that run untrusted code.", checks: ["t2-prodcreds"] },
          { rule: "Review CLAUDE.md, skills and MCP configs for dangerous commands and secrets before committing them.", checks: ["t3-agentcfg"] },
        ],
      },
      {
        heading: "Secrets",
        rules: [
          {
            rule: "Never put a secret in code, config, tests, Dockerfiles, Terraform or docs: no API keys (AWS, GitHub, Slack tokens and webhooks, Stripe live keys, Google, OpenAI, Anthropic, Twilio, SendGrid, npm), private key blocks, passwords in database URLs, signing secrets in `jwt.sign`, or literal values in secret-named variables. Read them from env vars validated at startup.",
            checks: [...SECRET_DETECTORS, "secret-generic", "hardcoded-jwt-secret", "t1-git-secrets"],
          },
          { rule: "Never commit a `.env` file. Gitignore `.env*`, commit a `.env.example` with placeholders, and keep a gitleaks pre-commit hook.", checks: ["committed-env-file", "t1-env"] },
          { rule: "Never expose a secret to the frontend: no secrets in `NEXT_PUBLIC_`/`VITE_`/`REACT_APP_` vars or client code.", checks: ["t1-bundle"] },
          { rule: "Never bake secrets into images with `ENV` or `ARG`. Pass them at runtime or use `RUN --mount=type=secret`.", checks: ["docker-secret-env"] },
          { rule: "No literal credentials in Terraform. Use variables marked `sensitive`, fed from a secret manager.", checks: ["tf-hardcoded-credential"] },
          { rule: "Redact auth headers, cookies, tokens, passwords and PII from logs.", checks: ["t3-logs"] },
        ],
      },
      {
        heading: "Crypto and Config",
        rules: [
          { rule: "Hash with SHA-256 or better and store passwords with argon2 or bcrypt. Never MD5 or SHA-1 for anything security related.", checks: ["weak-hash"] },
          { rule: "Encrypt with AES-GCM or ChaCha20-Poly1305. Never DES, 3DES, RC4, Blowfish or ECB mode.", checks: ["weak-cipher"] },
          { rule: "Generate tokens, ids, nonces, salts and reset codes with `crypto.randomBytes`/`randomUUID` or Python `secrets`, never `Math.random` or `random`.", checks: ["insecure-random"] },
          { rule: "Never turn off TLS verification (`rejectUnauthorized: false`, `verify=False`, `InsecureSkipVerify`, `NODE_TLS_REJECT_UNAUTHORIZED=0`).", checks: ["tls-verify-off"] },
          { rule: "Never enable debug mode in production config (`DEBUG=True`, `debug=True`, dev error pages).", checks: ["debug-enabled"] },
          { rule: "No public source maps, debug routes, Swagger UI or GraphQL introspection in production.", checks: ["t2-debug"] },
          { rule: "Send security headers on every response: CSP, HSTS, `X-Content-Type-Options`, `frame-ancestors`, `Referrer-Policy`.", checks: ["t3-headers", "dyn-missing-headers"] },
          { rule: "Keep storage buckets private, serve files through short-lived signed URLs, and never serve uploads from the app's origin.", checks: ["t2-storage"] },
          { rule: "Preview and staging get their own database and secrets, never production's.", checks: ["t2-staging"] },
          { rule: "Write an audit log for logins, permission changes, deletes, exports and payments.", checks: ["t3-auditlog"] },
          { rule: "Configure database backups and document the restore steps.", checks: ["t3-backups"] },
        ],
      },
      {
        heading: "Containers and Cloud",
        rules: [
          { rule: "Pin Docker base images to a version or digest, never `:latest` or no tag.", checks: ["docker-latest-tag"] },
          { rule: "Run containers as a non-root `USER`; in Kubernetes set `runAsNonRoot: true` and never `runAsUser: 0`.", checks: ["docker-root-user", "k8s-run-as-root", "k8s-run-as-root-explicit"] },
          { rule: "Give every Dockerfile a `HEALTHCHECK`.", checks: ["docker-no-healthcheck"] },
          { rule: "Don't `ADD` remote URLs; download with a checksum check. Never pipe `curl`/`wget` into a shell.", checks: ["docker-add-url", "curl-pipe-shell"] },
          { rule: "Never mount the Docker socket into a container.", checks: ["docker-socket-mount"] },
          { rule: "No privileged containers, no host network/PID/IPC, no `hostPath` volumes.", checks: ["k8s-privileged", "k8s-host-namespace", "k8s-host-path"] },
          { rule: "Set `allowPrivilegeEscalation: false` explicitly on every container.", checks: ["k8s-allow-privilege-escalation", "k8s-privilege-escalation-default"] },
          { rule: "Set CPU and memory requests and limits on every container.", checks: ["k8s-no-resource-limits"] },
          { rule: "Load Kubernetes secrets through `secretKeyRef` or a secret manager, never plain `env` values, and never commit a `Secret` manifest.", checks: ["k8s-plain-env-secret", "k8s-secret-manifest"] },
          { rule: "Keep buckets private: no public ACLs, keep the S3 public access block on, no policy with `Principal: \"*\"`.", checks: ["tf-public-acl", "tf-public-access-block-off", "tf-public-principal"] },
          { rule: "Turn on encryption for every bucket, volume and database.", checks: ["tf-unencrypted", "tf-unencrypted-storage"] },
          { rule: "Never make a database publicly accessible or open SSH, RDP or database ports to `0.0.0.0/0`.", checks: ["tf-public-db", "tf-open-ingress"] },
          { rule: "List explicit IAM actions and resources. Never `\"*\"` for either.", checks: ["iam-wildcard-action", "iam-wildcard-resource"] },
        ],
      },
      {
        heading: "CI",
        rules: [
          { rule: "Pin third-party GitHub Actions to a full 40-character commit SHA.", checks: ["gha-unpinned-action"] },
          { rule: "Never `echo` or print secrets in a workflow.", checks: ["gha-secret-echo"] },
          { rule: "Never put `${{ github.event.* }}` fields directly in a `run:` script. Pass them through `env:`.", checks: ["gha-script-injection"] },
          { rule: "Give workflows least-privilege `permissions:`, never `write-all`.", checks: ["gha-write-all"] },
          { rule: "Never check out PR head code in `pull_request_target` or `workflow_run` jobs that hold secrets.", checks: ["gha-prt-checkout"] },
        ],
      },
      {
        heading: "Dependencies",
        rules: [
          { rule: "Add only real, maintained, correctly spelled packages from the public registry. Check the exact name, age, deprecation and quarantine status first.", checks: ["dep-typosquat", "dep-new-package", "dep-deprecated", "dep-quarantined", "dep-not-on-registry", "t3-realdeps"] },
          { rule: "Pin dependency versions. No `*`, `latest`, or git/URL sources.", checks: ["dep-unpinned", "dep-git-source"] },
          { rule: "Avoid packages with install scripts unless they're needed and reviewed.", checks: ["dep-install-script"] },
          { rule: "Never add a version with a known vulnerability. Use the patched release.", checks: ["osv-known-vuln"] },
          { rule: "Commit the lockfile and install with `--frozen-lockfile` in CI.", checks: ["t3-lockfile"] },
          { rule: "Enable Dependabot, Renovate or an audit step.", checks: ["t3-depscan"] },
        ],
      },
    ],
  },
  {
    title: "Health",
    groups: [
      {
        heading: "Errors and Leftovers",
        rules: [
          { rule: "Handle every error. No empty `catch`, no catch-and-ignore, no `.catch(() => {})`.", checks: ["swallowed-errors"] },
          { rule: "No try/catch around code that can't throw, and no blanket try around a whole function.", checks: ["blanket-try"] },
          { rule: "Remove `console.log`, `print` debugging and `debugger` before finishing.", checks: ["debug-leftovers"] },
          { rule: "No TODO/FIXME stubs, `not implemented` throws or `pass` placeholders. Finish it or leave it out.", checks: ["stubs"] },
          { rule: "No mock, fake or placeholder data in app code. Fixtures belong in tests.", checks: ["mock-data"] },
          { rule: "No `any`, `as any`, `@ts-ignore`, `@ts-expect-error`, `# type: ignore` or lint-disable without a comment saying why.", checks: ["type-escapes"] },
          { rule: "Delete template files, sample pages, default assets and starter README text the project doesn't use.", checks: ["scaffold-leftovers"] },
        ],
      },
      {
        heading: "Duplication and Dead Code",
        rules: [
          { rule: "Don't copy-paste functions. Extract shared logic once it appears a second time.", checks: ["duplicates"] },
          { rule: "No `foo2`/`foo-new`/`foo-v2`/`foo-old` files beside the original. Edit the original; git keeps history.", checks: ["version-files"] },
          { rule: "Wire every new file and function in within the same change. Delete unused files, functions and exports.", checks: ["dead-files", "dead-functions"] },
          { rule: "Remove dependencies nothing imports.", checks: ["unused-deps"] },
          { rule: "No forwarding wrappers, one-caller abstractions or single-implementation interfaces.", checks: ["forwarding-wrappers"] },
          { rule: "Use the library the project already uses for a job. Don't add a second HTTP client, date library or test runner.", checks: ["inconsistent-libs"] },
        ],
      },
      {
        heading: "Size and Naming",
        rules: [
          { rule: "Keep functions under 80 lines and files under 800. Split by responsibility.", checks: ["oversized"] },
          { rule: "Don't scatter one concern across many tiny files that always change together. One module per concern.", checks: ["fragmented"] },
          { rule: "No magic numbers or strings. Use named constants.", checks: ["magic-numbers"] },
          { rule: "Use descriptive names. No `data2`, `tmp`, `handleStuff` or unclear abbreviations.", checks: ["vague-names"] },
          { rule: "Match the file's existing identifier naming style.", checks: ["mixed-naming"] },
        ],
      },
      {
        heading: "Comments and Docs",
        rules: [
          { rule: "No comments that narrate the change or session (\"Now we...\", \"Updated to...\", \"Fixed:\").", checks: ["narrating-comments"] },
          { rule: "No comments that restate the code. Comments explain why.", checks: ["restating-comments"] },
          { rule: "No section-divider comments and no doc comments that only repeat a short function's name.", checks: ["comment-habits"] },
          { rule: "Never mention Claude, AI or generated code in code, comments, commits or docs.", checks: ["ai-attribution"] },
          { rule: "No emoji in code, comments, logs or UI copy.", checks: ["emoji"] },
          { rule: "READMEs carry real values and run steps. No placeholders, stock phrases or emoji bullets, and add any LICENSE file the README mentions.", checks: ["readme-boilerplate"] },
          { rule: "Update docs in the same change when commands, paths or env vars they describe change.", checks: ["stale-docs"] },
        ],
      },
      {
        heading: "Tests and Tooling",
        rules: [
          { rule: "Add tests for new business logic, starting with the most-used files.", checks: ["untested"] },
          { rule: "Tests assert real behavior and values. Never only that a function was called or returned something; no empty or skipped tests.", checks: ["weak-tests"] },
          { rule: "Keep a formatter, linter, typecheck and test script configured, and run them before finishing.", checks: ["missing-tooling"] },
        ],
      },
    ],
  },
  {
    title: "Architecture",
    groups: [
      {
        heading: "Layers",
        rules: [
          { rule: "Keep dependencies one-directional. UI code never imports the database or server-only modules, and business logic stays out of UI components and route handlers.", checks: ["layer-violations"] },
          { rule: "No circular imports.", checks: ["import-cycles"] },
        ],
      },
      {
        heading: "Layout",
        rules: [
          { rule: "Keep folders under 20 files. Group files by feature before that.", checks: ["crowded-folder"] },
          { rule: "Use one file naming style per folder, matching the files already there.", checks: ["mixed-file-naming"] },
          { rule: "Put docs in `docs/`, not loose in the repo root (README, CONTRIBUTING, CHANGELOG, LICENSE, SECURITY and CLAUDE.md stay). Don't write plan or notes .md files.", checks: ["stray-root-docs"] },
          { rule: "Don't write a second doc on a topic an existing doc covers. Update that doc.", checks: ["duplicate-docs"] },
          { rule: "Name files with lowercase ASCII letters, digits and hyphens. No spaces or non-ASCII characters.", checks: ["unsafe-file-names"] },
          { rule: "Put a regression test in the test file for the module it covers (`foo.ts` → `foo.test.ts`), never a file named after the bug.", checks: ["bug-named-tests"] },
        ],
      },
    ],
  },
];

export function catalogCheckIds(): Set<string> {
  return new Set(RULES_CATALOG.flatMap((s) => s.groups.flatMap((g) => g.rules.flatMap((r) => r.checks))));
}

/** The catalog as a markdown block wrapped in markers, so it can be replaced in place inside a CLAUDE.md. */
export function renderRulesBlock(): string {
  const lines = [
    RULES_BLOCK_BEGIN,
    "## Lens Rules (Security, Health, Architecture)",
    "Lens checks every project for these. Follow them while writing code so nothing has to be fixed afterwards. Managed by `lens rules --install`; edits inside this block are overwritten.",
  ];
  for (const section of RULES_CATALOG) {
    lines.push("", `### ${section.title}`);
    for (const group of section.groups) {
      lines.push("", `**${group.heading}**`);
      for (const r of group.rules) lines.push(`- ${r.rule}`);
    }
  }
  lines.push(RULES_BLOCK_END);
  return lines.join("\n");
}

/** Replaces the rules block in `existing`, or appends it when there's none. */
export function withRulesBlock(existing: string): string {
  const block = renderRulesBlock();
  const start = existing.indexOf(RULES_BLOCK_BEGIN);
  const end = existing.indexOf(RULES_BLOCK_END);
  if (start >= 0 && end > start) return existing.slice(0, start) + block + existing.slice(end + RULES_BLOCK_END.length);
  const separator = existing.length === 0 ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
  return `${existing}${separator}${block}\n`;
}
