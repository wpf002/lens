#!/usr/bin/env node
// Lens auto-refresh hook. Opt-in per project: `lens init --auto-update`.
// After a commit (or at session start when the graph is behind HEAD) it re-runs the
// deterministic scan, which costs no tokens, then tells Claude how many LLM summaries
// went stale so it can offer to refresh just those.
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const mode = process.argv[2];
const COMMIT = /\bgit\s+(?:-C\s+\S+\s+)?(commit|merge|cherry-pick|rebase|pull|am)\b/;

async function stdin() {
  let s = "";
  process.stdin.setEncoding("utf8");
  for await (const c of process.stdin) s += c;
  return s;
}

function readJson(p) {
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
}

function readJsonSafe(s) { try { return JSON.parse(s || "{}"); } catch { return {}; } }
const payload = readJsonSafe(await stdin().catch(() => "{}"));

const cwd = payload.cwd || process.cwd();
const dir = path.join(cwd, ".lens");
const cfg = readJson(path.join(dir, "config.json"));
if (!cfg?.autoUpdate || !existsSync(path.join(dir, "knowledge-graph.json"))) process.exit(0);

if (mode === "post-tool-use") {
  const cmd = payload?.tool_input?.command;
  if (typeof cmd !== "string" || !COMMIT.test(cmd)) process.exit(0);
} else {
  const meta = readJson(path.join(dir, "meta.json"));
  let head = "";
  try { head = execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch { process.exit(0); }
  if (!meta || meta.gitCommit === head) process.exit(0);
}

const root = process.env.CLAUDE_PLUGIN_ROOT || path.join(process.env.HOME || "", ".lens/repo");
const lens = path.join(root, "bin", "lens");
let summary;
try {
  summary = JSON.parse(execFileSync(lens, ["scan", cwd, "--json"], { stdio: ["ignore", "pipe", "ignore"], timeout: 80_000 }).toString());
} catch {
  process.exit(0);
}

const parts = [`[lens] Graph refreshed after ${mode === "post-tool-use" ? "commit" : "new commits"}: ${summary.changedFiles} files changed.`];
if (summary.staleNodes > 0) {
  parts.push(`${summary.staleNodes} LLM summaries are now stale. To refresh only those: \`${lens} batches . --pending\`, dispatch file-analyzer per batch, then \`${lens} apply enrich .lens/intermediate/enrich-*.json\`. Offer this to the user; don't do it unasked.`);
}
if (summary.findings && (summary.findings.critical || summary.findings.high)) {
  parts.push(`Security: ${summary.findings.critical} critical / ${summary.findings.high} high open findings (risk ${summary.riskScore}/100).`);
}
const hookEventName = mode === "post-tool-use" ? "PostToolUse" : "SessionStart";
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: parts.join(" ") } }));
