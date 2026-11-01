---
name: lens-explain
description: Deep-dive explanation of one file, function, class, or endpoint using the Lens graph plus the source.
argument-hint: "<path | path:symbol | node-id>"
---

# /lens-explain

```bash
LENS="${CLAUDE_PLUGIN_ROOT:-$HOME/.lens/repo}/bin/lens"
"$LENS" explain "$ARGUMENTS"
```

If it can't resolve the reference, run `"$LENS" query search "$ARGUMENTS" -n 5` and pick the best match (ask if it's ambiguous). No graph yet: `"$LENS" scan .` first.

Read the source for the node (and for a file, its key symbols). For callers and callees that matter, `"$LENS" explain` them too and read their relevant lines.

Explain, in this order:

1. **Purpose**: what it's for, in one or two sentences.
2. **How it works**: walk through the logic in execution order. Name the branches that matter and the data that flows through.
3. **Where it sits**: layer, who calls it (incoming), what it depends on (outgoing), which endpoints reach it.
4. **Gotchas**: side effects, error handling, concurrency, performance traps, framework idioms a newcomer would miss.
5. **Security**: any findings on it, whether user input reaches it, auth on the routes that reach it.
6. **If you change it**: what else to check, based on the blast radius and tests (`tested_by`).

Cite `path:line` throughout. Match depth to the size of the thing: a 10-line helper gets a paragraph.
