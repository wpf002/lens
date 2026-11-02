# Security

## Reporting

Email wfoti71992@gmail.com with details and a reproduction. Please don't open a public issue for vulnerabilities.

## What Lens does to stay safe

- **Local server**: `lens serve` binds to 127.0.0.1, requires a random 192-bit token on every API call (constant-time compared), rejects non-loopback `Host` headers to block DNS rebinding, sends a strict CSP, and never sets CORS headers.
- **Switching projects**: the dashboard's Open Project button calls token-gated endpoints. They only open directories (never `/` or your home folder), scan the folder into `<folder>/.lens/`, and the macOS picker runs `osascript` with an argument array, no shell.
- **AI runs from the dashboard**: "Generate Domains with AI" is token-gated and spawns `claude -p` (argument array, no shell) in the project folder with only Read, Grep, Glob, Write and the `lens` CLI allowed, a `--max-budget-usd` cap, and a 20-minute timeout. Its output is validated by `applyPatch` like any agent patch.
- **Remediate**: the remediator agent can only write its proposal file. Lens checks every edit (path inside the project; never `.env`, lockfiles, `.git/` or `.lens/`; the text to replace must appear exactly once), shows it as a diff, and applies only fixes the user selects. Originals are backed up under `.lens/remediation-backup/` so Undo restores exact bytes.
- **File access**: `/api/file` only serves paths that are file nodes in the graph, resolves symlinks with `realpath`, and refuses anything outside the project root or over 2 MB.
- **Secrets**: the scanner never stores a detected secret. Findings keep the rule, location, and a masked preview.
- **Agent patches**: agents never write the graph. `lens apply` validates each patch with a schema, caps field lengths, and drops references to nodes that don't exist.
- **Prompt injection**: agent instructions treat repository content as data. A comment saying "ignore previous instructions" is just text in a summary.
- **No shell interpolation**: git and the browser opener are called with argument arrays; user-supplied git refs are validated.
- **Network**: the scan is offline. Only `lens security --osv` (OSV.dev) and `lens embed` (the embedding provider you pick) make network calls, and only when asked.

## Hosted mode (`lens cloud`)

- Sign-in checks `LENS_USERNAME` and `LENS_PASSWORD` (constant-time compare of SHA-256 digests, 750 ms delay on a failure) and returns a random per-boot session token that every other `/api` call needs. The loopback Host check is off because Railway's proxy sets the Host header.
- Projects can only be GitHub repos cloned into `/data/repos`. Opening arbitrary server paths is refused.
- Connect GitHub uses an OAuth App with a single-use `state` that expires after 10 minutes. The access GitHub returns is stored in `/data/github.json` (mode 600), goes to git only as a per-command auth header (never `.git/config`), is scrubbed from error messages, and isn't visible to Claude runs; neither is the client secret.
- Fixes are pushed only to new `lens/fixes-*` branches.

