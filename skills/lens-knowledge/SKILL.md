---
name: lens-knowledge
description: Turn a folder of markdown notes (Obsidian vault, LLM wiki, docs site) into a Lens knowledge graph with links, backlinks, topics, sources, and missing pages.
argument-hint: "[folder]"
---

# /lens-knowledge

```bash
LENS="${CLAUDE_PLUGIN_ROOT:-$HOME/.lens/repo}/bin/lens"
DIR="${ARGUMENTS:-.}"
"$LENS" knowledge "$DIR"
```

This builds the graph deterministically: every markdown page becomes an article, `[[wikilinks]]` and relative links become edges, backlinks are computed, frontmatter `tags`/`category` and top-level folders become topics, files under `raw/`, `sources/`, `references/` become sources (linked with `cites`), and wikilinks with no page become `missing-page` entities.

Optional enrichment (better summaries and concept clusters):

1. `"$LENS" batches "$DIR"` then dispatch `file-analyzer` subagents per batch as in `/lens` Phase 2. In the prompt, add: "These are notes, not code. Summaries state the page's main claim or purpose. You may add `concepts` (named clusters of 2+ related pages) instead of code edges."
2. `"$LENS" apply enrich "$DIR"/.lens/intermediate/enrich-*.json --dir "$DIR"`

Then start `"$LENS" serve "$DIR" --port 0` in the background and give the user the URL. The Knowledge view opens automatically. Report pages, links, topics, and the missing pages most linked-to (good candidates to write next).
