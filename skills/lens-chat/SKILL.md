---
name: lens-chat
description: Answer questions about a codebase using its Lens knowledge graph (where is X handled, what calls Y, how does a request flow, what depends on Z).
argument-hint: "<question>"
---

# /lens-chat

Answer from the graph first, then confirm in source. Don't load `.lens/knowledge-graph.json` into context; query it.

```bash
LENS="${CLAUDE_PLUGIN_ROOT:-$HOME/.lens/repo}/bin/lens"
```

If no graph exists, run `"$LENS" scan .` (seconds, no LLM) and continue.

Tools, in the order you'll usually want them:

- `"$LENS" query search "<words>" -n 10` hybrid fuzzy + semantic search (synonym-aware: "auth" finds login, session, jwt). `-m fuzzy` for exact-ish names. `-k function,class` to filter.
- `"$LENS" explain <id|path|path:symbol>` summary, layer, grouped relations in and out, endpoints, findings, tour steps, blast radius.
- `"$LENS" query neighbors <ref> --depth 2 --direction in --edges calls,imports` who depends on this.
- `"$LENS" query path <a> <b>` how two things connect.
- `"$LENS" query stats` project overview, most depended-on code.
- `"$LENS" security . --min high` security questions.

Then Read the specific lines (`path` + `lines` from the results) before stating anything about behavior. Summaries marked `summarySource: "heuristic"` are structural guesses; trust the code over them.

Answer the question directly, cite `path:line` for every claim, and keep it as short as the question allows. If the graph is missing something the user needs (e.g. no summaries yet), say so and suggest `/lens`.
