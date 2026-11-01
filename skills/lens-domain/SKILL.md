---
name: lens-domain
description: Map a codebase to business domains, flows, and steps for the Lens domain view.
argument-hint: "[path]"
---

# /lens-domain

```bash
LENS="${CLAUDE_PLUGIN_ROOT:-$HOME/.lens/repo}/bin/lens"
ROOT="${ARGUMENTS:-.}"
```

1. Needs a graph. If `.lens/knowledge-graph.json` is missing, run `"$LENS" scan "$ROOT"`. Domain mapping is better after `/lens` (summaries), but works on a structural graph.
2. `"$LENS" context domain "$ROOT"` writes `.lens/intermediate/context-domain.json`.
3. Dispatch the `domain-analyzer` subagent with that path, output `$ROOT/.lens/intermediate/domain.json`, the project root, and `$LENS`.
4. `"$LENS" apply domain "$ROOT"/.lens/intermediate/domain.json --dir "$ROOT"` (replaces any previous domain map).
5. Report the domains and their flows in a short list, then offer the dashboard (`/lens-dashboard`, view 3).
