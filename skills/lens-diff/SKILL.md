---
name: lens-diff
description: Explain what current code changes (uncommitted, staged, or a branch vs its base) affect, using the Lens knowledge graph. Use before committing, when reviewing a PR, or when asked what a change could break.
argument-hint: "[--base <ref>] [--staged]"
---

# /lens-diff

```bash
LENS="${CLAUDE_PLUGIN_ROOT:-$HOME/.lens/repo}/bin/lens"
```

1. Make sure a graph exists (`.lens/knowledge-graph.json`). If not, run `"$LENS" scan .` first; it takes seconds and needs no LLM.
2. If files were added since the last scan, rescan so they're in the graph: `"$LENS" scan . --json` (cheap).
3. Get the impact report:
   ```bash
   "$LENS" diff . --json --save [--base <ref>] [--staged]
   ```
4. For the top changed nodes and direct dependents, pull context without loading the graph: `"$LENS" explain <node-id>`. Read the actual diff (`git diff`) for the changed hunks.
5. Write the answer:
   - **What changed**, in behavior terms (one line per logical change, not per file).
   - **Blast radius**: direct dependents that call or import the changed code, and whether their assumptions still hold. Name functions.
   - **Endpoints affected**, with auth status.
   - **Security**: anything in `securityRelevant`: changes to auth, input handling, or code with open findings. Say whether the change makes it better or worse.
   - **Tests to run**: from `testsToRun`, plus gaps (changed code with no `tested_by` edge).
   - **Risk**: low / medium / high with the reason.
6. Tell the user the dashboard's Diff toggle shows this overlaid on the graph (`/lens-dashboard`).
