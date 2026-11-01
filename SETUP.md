# Repo setup

## 1. Create the GitHub repo

```bash
gh repo create wpf002/lens --private --description "Turn any codebase into an explorable knowledge graph, with a security view"
```

Or create it at github.com/new named `lens`, no README/license/gitignore (they're in this repo).

## 2. Initialize and push

```bash
cd ~/Documents/lens
git init -b main
git add .
git commit -m "Initial commit: Lens monorepo (core, cli, dashboard, plugin)"
git remote add origin git@github.com:wpf002/lens.git
git push -u origin main
```

HTTPS remote instead of SSH: `git remote add origin https://github.com/wpf002/lens.git`

## 3. Bootstrap

```bash
./bootstrap.sh
```

Checks Node 22+ and pnpm, writes any missing root config, installs, builds.

## 4. Install as a Claude Code plugin

From inside Claude Code:

```
/plugin marketplace add wpf002/lens
/plugin install lens@lens
```

Local checkout instead of GitHub:

```
/plugin marketplace add ~/Documents/lens
/plugin install lens@lens
```

## 5. Other agents (Codex, Cursor, Copilot, Gemini CLI, OpenCode, Cline)

```bash
./install.sh            # prompts for platform
./install.sh codex
```

## 6. Branch protection (optional)

```bash
gh api -X PUT repos/wpf002/lens/branches/main/protection \
  -F required_status_checks.strict=true \
  -F 'required_status_checks.contexts[]=ci' \
  -F enforce_admins=false \
  -F required_pull_request_reviews=null \
  -F restrictions=null
```
