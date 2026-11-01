# Lens

Codebase → knowledge graph → dashboard, with a security view. pnpm + Turborepo monorepo, TypeScript strict, ESM, Node 22+.

## Layout
- `packages/core` analysis engine. Browser-safe subset is `@lens/core/browser` (types, search, graph-utils); the dashboard must import only from there.
  - `scan.ts` orchestrates: walk → tree-sitter extract (`extract.ts`) / non-code parsers (`noncode.ts`) → import resolution (`resolve.ts`) → graph → heuristics (`heuristics.ts`) → security (`security/*`).
  - `apply.ts` merges agent patches; `schema.ts` holds every zod schema. Agents never touch the graph file directly.
  - `context.ts` builds the compact per-agent inputs; `diff.ts` impact analysis; `knowledge.ts` markdown wiki mode.
- `packages/cli` the `lens` binary and the token-gated dashboard server (`server.ts`).
- `packages/dashboard` React 19 + React Flow + ELK (web worker) + zustand + Tailwind v4, built by vite-plugin-singlefile into one `dist/index.html`. The CLI replaces `<!--LENS_DATA-->` to embed data for static export.
- `skills/`, `agents/`, `hooks/`, `.claude-plugin/` the Claude Code plugin (plugin root is the repo root).
- `bin/lens` launcher: builds on first run, then execs the CLI.

## Commands
- `pnpm install && pnpm build` · `pnpm test` · `pnpm typecheck`
- `pnpm dev:dashboard` (uses `packages/dashboard/public/sample-graph.json`)
- `bin/lens scan <dir>` · `bin/lens serve <dir>`

## Conventions
- Graph schema id is `lens/1` (`packages/core/src/types.ts`). Changing a type means updating `schema.ts`, the dashboard, and bumping the schema id if old graphs break.
- Tree-sitter grammars come from `tree-sitter-wasms` and load through `web-tree-sitter@0.25` (pinned; newer ABI breaks those grammars). Grammars are preloaded before parsing because loading one after the WASM heap grows is slow.
- New security rules go in `security/rules.ts` with a fixture line in `packages/core/test/fixtures/vuln-app` and an assertion in `core.test.ts`.
- Anything an agent writes is validated by a zod schema with length caps. Keep it that way.
- Versions: bump `package.json` (root + packages) and `.claude-plugin/plugin.json` together.
