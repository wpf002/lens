---
name: lens-onboard
description: Generate an ONBOARDING.md for new engineers from the Lens knowledge graph.
argument-hint: "[output path]"
---

# /lens-onboard

```bash
LENS="${CLAUDE_PLUGIN_ROOT:-$HOME/.lens/repo}/bin/lens"
"$LENS" onboard . --stdout
```

That prints a deterministic draft: architecture by layer, reading order from the tour, API surface with auth status, security notes, and complex hot spots. No graph yet: run `/lens` first (the guide is much better with LLM summaries and a real tour), or `"$LENS" scan .` for a structural version.

Turn the draft into a guide a new hire would actually use:

- Open with a 3–4 sentence "what this is and how it works" in plain language.
- Add **Getting started**: install, run, test commands. Take them from the manifest scripts, Makefile, README, and CI config. Verify each exists.
- Keep the layer and reading-order sections, but rewrite bullet summaries so they explain *why* a newcomer should care.
- Add **Conventions** you can see in the code: error handling, logging, config loading, naming, test layout.
- Add **Where to make common changes** ("add an endpoint: …", "add a DB column: …") based on the actual structure.
- Keep the security section factual.

Write it to `ONBOARDING.md` (or the path in `$ARGUMENTS`). If the file exists, show a short summary of what changed and ask before overwriting.
