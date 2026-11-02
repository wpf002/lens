# Lens

Point it at a repo and get a knowledge graph of every file, function, class, endpoint, and dependency. It comes with an interactive dashboard, a guided tour in dependency order, diff impact analysis, and a security view that maps each route's auth status to the dangerous sinks it can reach.

The graph is plain JSON at `.lens/knowledge-graph.json`, written one node per line so git diffs stay readable. Commit it, and anyone who clones the repo can run `lens serve` without re-running the analysis.

## How it works

Lens splits the work in two.

**1. Deterministic scan (`lens scan`), no LLM.** Tree-sitter parses TypeScript, JavaScript, Python, Go, Rust, Java, Kotlin, Scala, C#, C, C++, Ruby, PHP, Swift, Dart, Lua, Bash, and Solidity. The scan then:

- resolves imports (tsconfig paths, monorepo workspaces, Python packages, Go modules, Rust `crate::`, Java packages)
- links calls to their definitions, including inline route handlers
- parses Docker, Compose, GitHub Actions, Kubernetes, Terraform, Prisma, SQL, GraphQL, Protobuf, OpenAPI, `.env`, and Markdown
- detects routes in Express, Fastify, Next.js (app router, pages/api, server actions), NestJS, Flask, FastAPI, Django, Gin, net/http, Spring, JAX-RS, Rails, Sinatra, Laravel, and ASP.NET, and checks each one for auth guards
- runs the security rule pack, guesses architectural layers, and orders a starter tour

The result is usable right away: about 3 seconds for 100 files and 6 seconds for 500. Re-scans work from content hashes, so summaries written by the LLM carry over and any whose code changed are flagged stale.

**2. LLM enrichment (`/lens` in Claude Code).** Subagents read the code (file analyzers run in batches, up to 5 in parallel) and write small JSON patches:

- plain-English summaries, tags, and notes
- semantic edges (`writes_to`, `publishes`, `validates`…)
- architectural layers
- the guided tour
- business domains and flows
- security triage verdicts

`lens apply` checks each patch against a schema and drops any reference to a node that doesn't exist, so agents can't write to the graph directly.

```
lens scan ─► knowledge-graph.json (complete structure, heuristic summaries)
   ├─ lens batches ──────────► file-analyzer ×N ──────► enrich-*.json ─┐
   ├─ lens context architecture ► architecture-analyzer ► layers.json ──┤
   ├─ lens context tour ────────► tour-builder ────────► tour.json ────┼─► lens apply ─► lens serve
   ├─ lens context domain ──────► domain-analyzer ─────► domain.json ──┤
   └─ lens context security ────► security-triager ────► triage-*.json ┘
```

## Security view

Understand Anything doesn't have this part. For each project, Lens finds the following:

- **Entry points** (HTTP routes, webhooks, server actions, CLIs, cron jobs), each labeled `guarded`, `unguarded`, `public`, or `unknown`. The evidence can be inline middleware, decorators, router mounts, `app.use(auth)`, or session checks inside the handler.
- **Sinks**: shell and code execution, raw SQL, NoSQL operator injection, XSS sinks, SSRF, path traversal, unsafe deserialization, open redirects, disabled TLS verification, JWTs decoded without verification, weak crypto, predictable randomness, CORS wildcards, debug mode, disabled CSRF, and mass assignment.
- **Secrets**: AWS, GitHub, Stripe, OpenAI, Anthropic, Slack, private keys, DB URLs with passwords, high-entropy credentials, and committed `.env` files. Values are always redacted.
- **Reachability**: which routes can reach each sink over call edges, with the exact path. If request input is read anywhere on that path, the finding is marked tainted and its severity goes up.
- **Endpoint checks**: webhooks with no signature verification, and state-changing routes or server actions with no visible auth.
- **Dependencies** (optional): `--osv` looks up known CVEs on OSV.dev.

The `security-triager` agent then reads the code behind each finding and marks it confirmed, false positive, or accepted. It can also add issues the rules missed, like IDOR. Triage verdicts survive re-scans.

## Dashboard

Six views, switched with keys `1`–`6`:

- **Structure**: directory drill-down, or every file grouped by folder
- **Layers**
- **Business**: business areas → flows → steps
- **Health**: automatic checks for swallowed errors, dead code, copy-paste, debug leftovers, stubs, type escapes, untested files, unused dependencies and stale docs, plus an optional AI senior review
- **Security**: entry points → handlers → sinks, plus a findings table
- **Knowledge**: markdown wikis

Also included:

- Search: `/` or `⌘K`, with fuzzy, semantic, or embedding modes
- Diff impact overlay
- Guided tour (`←`/`→`)
- Path finder between any two nodes
- Source viewer with the node's lines highlighted
- Filters
- Export to PNG, SVG, JSON, or Mermaid
- Open Project: pick any folder in Finder (or type a path) and Lens scans and shows it
- A phone layout

## Quick start

```bash
./bootstrap.sh                 # Node 22+, installs, builds
bin/lens scan ~/code/myapp
bin/lens serve ~/code/myapp    # prints http://127.0.0.1:4747/#token=…
```

To install as a Claude Code plugin, see [SETUP.md](SETUP.md). Then:

| Command | What it does |
|---|---|
| `/lens [path]` | Full analysis with agents, then opens the dashboard. Flags: `--quick`, `--full`, `--review`, `--no-triage`, `--exclude`, `--language`, `--auto-update` |
| `/lens-dashboard` | Open the dashboard for an existing graph |
| `/lens-diff [--base main]` | What your changes touch and what depends on them |
| `/lens-security [--osv] [--report]` | Attack surface, triaged findings, remediation |
| `/lens-chat <question>` | Answers from the graph, confirmed in source |
| `/lens-explain <path[:symbol]>` | Deep dive on one thing |
| `/lens-onboard` | Writes ONBOARDING.md |
| `/lens-domain` | Business domains → flows → steps |
| `/lens-knowledge [folder]` | Graph a markdown wiki / Obsidian vault |

For Codex, Gemini CLI, Copilot, Cursor, OpenCode, Cline, Kiro, and Trae, run `./install.sh <platform>`.

## Hosted (Railway)

`lens cloud` runs the dashboard as a hosted server. The `Dockerfile` and `railway.json` build it; mount a volume at `/data`.

| Variable | Purpose |
|---|---|
| `LENS_USERNAME` | Sign-in username. |
| `LENS_PASSWORD` | Sign-in password, 12+ characters. Without both, nobody can sign in. |
| `CLAUDE_CODE_OAUTH_TOKEN` | AI runs on your Claude plan, same as local. Create with `claude setup-token`. |
| `ANTHROPIC_API_KEY` | Alternative: AI runs billed to an API key. |
| `GITHUB_TOKEN` | Optional. Clone private repos and push fix branches. Without it, Lens opens public repos and fixes download as a patch. |
| `LENS_REPO` | Optional `owner/name` to open on first boot. |

Open Project takes `owner/name` or a GitHub URL and clones it into `/data/repos`. After Fix, **Download Patch** saves the changes as a `.patch` file; run `git apply <file>` in your checkout. With `GITHUB_TOKEN` set, **Push Branch** pushes them to a `lens/fixes-*` branch instead (never the default branch).

## CLI

```
lens scan [dir]                  build/refresh the graph        --full --exclude --no-security --json
lens serve [dir]                 dashboard (127.0.0.1, token)   --port --no-open --graph <file>
lens diff [dir]                  change impact                  --base <ref> --staged --depth --json --save
lens security [dir]              findings report                --min <sev> --osv --md --json --all
lens query search <q…>           hybrid search                  -m fuzzy|semantic|hybrid -k <kinds> -n
lens query node|neighbors|path|stats
lens explain <ref> [dir]         everything known about one node
lens onboard [dir]               ONBOARDING.md draft
lens export [dir]                -f html|mermaid|dot|json (html = self-contained dashboard)
lens knowledge [dir]             markdown wiki → graph
lens embed [dir]                 optional embeddings            --provider openai|voyage|ollama
lens batches | context | apply   the agent pipeline (apply supports --dry-run)
lens validate | init | clean
```

To refresh the graph automatically: `lens init --auto-update`. After each commit, the plugin hook re-runs the deterministic scan, which costs no tokens, and tells Claude how many summaries went stale.

## Repo layout

```
packages/core        engine: parsing, graph, search, diff, security, schemas, patches
packages/cli         `lens` binary + dashboard server
packages/dashboard   React + React Flow, built to one self-contained HTML file
skills/ agents/      Claude Code skills and subagent definitions
hooks/               opt-in post-commit refresh
bin/lens             launcher (builds on first run)
```

See [SECURITY.md](SECURITY.md) for the server's threat model. MIT licensed.
