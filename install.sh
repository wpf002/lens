#!/usr/bin/env bash
# Lens installer for agents other than Claude Code (Claude Code uses /plugin marketplace add).
#
#   ./install.sh                 prompt for platform
#   ./install.sh codex           install skills for one platform
#   ./install.sh --update        pull latest and rebuild
#   ./install.sh --uninstall codex
#
#   curl -fsSL https://raw.githubusercontent.com/wpf002/lens/main/install.sh | bash -s codex
#
# Env: LENS_REPO_URL (default github.com/wpf002/lens), LENS_HOME (default ~/.lens/repo)
set -euo pipefail

REPO_URL="${LENS_REPO_URL:-https://github.com/wpf002/lens.git}"
LENS_HOME="${LENS_HOME:-$HOME/.lens/repo}"
BIN_DIR="$HOME/.local/bin"

platforms() {
  cat <<T
codex|$HOME/.agents/skills
gemini|$HOME/.agents/skills
opencode|$HOME/.agents/skills
pi|$HOME/.agents/skills
copilot|$HOME/.copilot/skills
cline|$HOME/.cline/skills
cursor|$HOME/.cursor/skills
kiro|$HOME/.kiro/skills
trae|$HOME/.trae/skills
vibe|$HOME/.vibe/skills
T
}

say() { printf '\033[33m[lens]\033[0m %s\n' "$*"; }
die() { printf '\033[31m[lens]\033[0m %s\n' "$*" >&2; exit 1; }

target_for() { platforms | awk -F'|' -v id="$1" '$1==id {print $2}'; }

ensure_repo() {
  command -v git >/dev/null || die "git is required"
  command -v node >/dev/null || die "Node.js >= 22 is required"
  [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 22 ] || die "Node.js >= 22 is required (found $(node -v))"
  # Running from a checkout: use it in place.
  local here; here="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
  if [ -n "$here" ] && [ -f "$here/.claude-plugin/plugin.json" ] && [ -d "$here/skills" ]; then
    LENS_HOME="$here"
  elif [ ! -d "$LENS_HOME/.git" ]; then
    say "cloning $REPO_URL → $LENS_HOME"
    mkdir -p "$(dirname "$LENS_HOME")"
    git clone --depth 1 "$REPO_URL" "$LENS_HOME"
  fi
  say "building"
  "$LENS_HOME/bin/lens" --version >/dev/null
  mkdir -p "$BIN_DIR"
  ln -sfn "$LENS_HOME/bin/lens" "$BIN_DIR/lens"
  # Stable path the skills fall back to when CLAUDE_PLUGIN_ROOT is unset.
  if [ "$LENS_HOME" != "$HOME/.lens/repo" ]; then mkdir -p "$HOME/.lens"; ln -sfn "$LENS_HOME" "$HOME/.lens/repo"; fi
}

install_for() {
  local id="$1" dest; dest="$(target_for "$id")"
  [ -n "$dest" ] || die "unknown platform '$id'. Supported: $(platforms | cut -d'|' -f1 | tr '\n' ' ')"
  ensure_repo
  mkdir -p "$dest"
  for s in "$LENS_HOME"/skills/*/; do
    local name; name="$(basename "$s")"
    ln -sfn "${s%/}" "$dest/$name"
  done
  say "linked $(ls -d "$LENS_HOME"/skills/*/ | wc -l | tr -d ' ') skills into $dest"
  case ":$PATH:" in *":$BIN_DIR:"*) ;; *) say "add $BIN_DIR to PATH to use 'lens' directly";; esac
  say "done. In $id, run the 'lens' skill (or 'lens scan . && lens serve .' in a terminal)."
}

uninstall_for() {
  local dest; dest="$(target_for "$1")"
  [ -n "$dest" ] || die "unknown platform '$1'"
  for s in "$dest"/lens "$dest"/lens-*; do [ -L "$s" ] && rm "$s"; done
  say "removed Lens skills from $dest"
}

case "${1:-}" in
  --help|-h) sed -n 2,12p "$0" ;;
  --update) [ -d "$LENS_HOME/.git" ] || die "no clone at $LENS_HOME"; git -C "$LENS_HOME" pull --ff-only; (cd "$LENS_HOME" && pnpm install && pnpm build) ;;
  --uninstall) uninstall_for "${2:?platform required}" ;;
  "")
    say "platforms: $(platforms | cut -d'|' -f1 | tr '\n' ' ')"
    printf 'install for: '; read -r p < /dev/tty; install_for "$p" ;;
  *) install_for "$1" ;;
esac
