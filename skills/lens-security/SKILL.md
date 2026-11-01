---
name: lens-security
description: Security review of a codebase with Lens - attack surface (endpoints and auth), static findings with reachability, agent triage, and optional dependency CVE lookup.
argument-hint: "[path] [--osv] [--report]"
---

# /lens-security

```bash
LENS="${CLAUDE_PLUGIN_ROOT:-$HOME/.lens/repo}/bin/lens"
ROOT=<first non-flag argument, default .>
```

1. Refresh structure (cheap, keeps prior triage verdicts): `"$LENS" scan "$ROOT" --json`.
2. With `--osv` (network): `"$LENS" security "$ROOT" --osv --json > /dev/null` adds known-vulnerable dependency findings from OSV.dev.
3. `"$LENS" context security "$ROOT"`. Read the findings count from the file.
4. Dispatch `security-triager` subagents, 40 findings each by index range, at most 3 in parallel, outputs `$ROOT/.lens/intermediate/triage-<n>.json`. Give each the context path, its range, the output path, the root, and `$LENS`.
5. `"$LENS" apply triage "$ROOT"/.lens/intermediate/triage-*.json --dir "$ROOT"`
6. `"$LENS" security "$ROOT" --min medium` and summarize:
   - Risk score and confirmed critical/high issues, each with location, why it's exploitable (which route, auth status), and the fix.
   - Unguarded state-changing endpoints that triage confirmed.
   - What was ruled out (count of false positives), so the user knows the noise was handled.
7. With `--report`, also write `SECURITY-REVIEW.md` from `"$LENS" security "$ROOT" --md` plus the triage notes for confirmed items.
8. Point to the dashboard's Security view (`/lens-dashboard`, view 4): routes on the left, sinks on the right, exposure paths between.

This is a review of the user's own code. Describe issues and remediations; don't produce exploit code.
