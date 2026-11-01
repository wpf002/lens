# Lens for coding agents

If you are an agent working **on** this repo, read `CLAUDE.md`.

If you are an agent **using** Lens on another project: the entry point is the `lens` skill in `skills/lens/SKILL.md`. The CLI is `bin/lens` (builds itself on first run). Useful without any setup:

```
bin/lens scan <project>                 # deterministic graph, seconds
bin/lens query search "<words>" -d <project>
bin/lens explain <path|path:symbol> <project>
bin/lens diff <project> [--base main]
bin/lens security <project>
bin/lens serve <project>                # dashboard URL with token
```

Subagent definitions live in `agents/`. On platforms without subagents, follow those files yourself, one batch at a time.
