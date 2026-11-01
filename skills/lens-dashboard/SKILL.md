---
name: lens-dashboard
description: Open the Lens dashboard for a project that already has a knowledge graph (.lens/knowledge-graph.json).
argument-hint: "[path]"
---

# /lens-dashboard

```bash
LENS="${CLAUDE_PLUGIN_ROOT:-$HOME/.lens/repo}/bin/lens"
ROOT="${ARGUMENTS:-.}"
```

1. If `$ROOT/.lens/knowledge-graph.json` doesn't exist, say so and offer `/lens` (full) or `lens scan` (fast, no LLM). Stop.
2. If the graph's commit (`"$LENS" query stats --dir "$ROOT"` → `project.gitCommit`) differs from `git -C "$ROOT" rev-parse HEAD`, mention it's behind and that `"$LENS" scan "$ROOT"` refreshes structure in seconds (LLM summaries carry over; changed ones get flagged stale).
3. Start the server **in the background**: `"$LENS" serve "$ROOT" --port 0`
4. Give the user the printed URL (it includes a one-time `#token=`). Mention the keys: `/` search, `1`–`5` views, `?` shortcuts.

For a shareable file with no server: `"$LENS" export "$ROOT" --format html` writes `.lens/export.html` (source viewer disabled in that mode).
