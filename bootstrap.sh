#!/usr/bin/env bash
# Lens infrastructure bootstrap.
# Creates the monorepo layout, root configs, and installs dependencies.
# Safe to re-run: it never overwrites files that already exist.
#
# Usage: ./bootstrap.sh            (run from the repo root)
#        LENS_SKIP_INSTALL=1 ./bootstrap.sh

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

say() { printf '\033[33m[lens]\033[0m %s\n' "$*"; }
need() { command -v "$1" >/dev/null 2>&1 || { echo "Missing: $1. $2" >&2; exit 1; }; }

need node "Install Node.js >= 22 (https://nodejs.org)."
need git "Install git."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 22 ]; then echo "Node >= 22 required (found $(node -v))." >&2; exit 1; fi
if ! command -v pnpm >/dev/null 2>&1; then
  say "pnpm not found, enabling via corepack"
  corepack enable && corepack prepare pnpm@10.28.0 --activate
fi

write() { # write <path> <<'EOF' ... only when missing
  local p="$1"; mkdir -p "$(dirname "$p")"
  if [ -e "$p" ]; then cat >/dev/null; say "exists, skipped: $p"; else cat >"$p"; say "created: $p"; fi
}

say "folder structure"
mkdir -p packages/core/src packages/cli/src packages/dashboard/src \
         skills agents hooks .claude-plugin scripts docs .github/workflows

write pnpm-workspace.yaml <<'EOF'
packages:
  - "packages/*"
onlyBuiltDependencies:
  - esbuild
EOF

write .npmrc <<'EOF'
auto-install-peers=true
strict-peer-dependencies=false
EOF

write .gitignore <<'EOF'
node_modules/
dist/
.turbo/
coverage/
*.log
.DS_Store
.env
.env.*
!.env.example
# Lens scratch output (the graph itself is meant to be committed)
.lens/intermediate/
.lens/tmp/
EOF

write .env.example <<'EOF'
# Optional. Only needed for `lens embed` (real embedding search).
# Pick one provider; leave the rest blank.
LENS_EMBED_PROVIDER=        # openai | voyage | ollama
OPENAI_API_KEY=
VOYAGE_API_KEY=
OLLAMA_HOST=http://localhost:11434
# Optional: the dashboard server port
LENS_PORT=4747
EOF

write tsconfig.base.json <<'EOF'
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "sourceMap": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "forceConsistentCasingInFileNames": true
  }
}
EOF

write turbo.json <<'EOF'
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": { "dependsOn": ["^build"], "outputs": ["dist/**"] },
    "test": { "dependsOn": ["^build"] },
    "typecheck": { "dependsOn": ["^build"] },
    "dev": { "cache": false, "persistent": true }
  }
}
EOF

if [ "${LENS_SKIP_INSTALL:-0}" != "1" ]; then
  say "installing dependencies"
  pnpm install
  say "building"
  pnpm build
fi

say "done. Try: node packages/cli/dist/index.js scan . && node packages/cli/dist/index.js serve ."
