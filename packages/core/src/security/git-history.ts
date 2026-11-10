/**
 * Looks for secrets in every line ever added to the repo's git history, so the
 * owner doesn't have to run gitleaks themselves. Only high-confidence key
 * patterns are used; the generic `password = "..."` check is too noisy across
 * years of history.
 */
import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";
import { SECRET_PATTERNS, isPlaceholder, isPlaceholderDbUrl, redact } from "./rules.js";

const run = promisify(execFile);
const GIT_TIMEOUT_MS = 60_000;
const MAX_LOG_BYTES = 512 * 1024 * 1024;
const MAX_LINE_CHARS = 4000;
const MAX_HITS = 20;

export interface HistorySecret {
  commit: string;
  path: string;
  title: string;
  /** The added line with the secret redacted. */
  snippet: string;
}

export interface HistoryScan {
  commits: number;
  /** True when the clone is shallow, so older commits weren't checked. */
  shallow: boolean;
  hits: HistorySecret[];
}

/** Secrets in the added lines of a `git log -p --format=commit:%h` dump. Pure, for testing. */
export function findHistorySecrets(log: string): HistorySecret[] {
  const hits: HistorySecret[] = [];
  const seen = new Set<string>();
  let commit = "";
  let file = "";
  for (const line of log.split("\n")) {
    if (line.startsWith("commit:")) commit = line.slice(7).trim();
    else if (line.startsWith("+++ ")) file = line.replace(/^\+\+\+ (?:b\/)?/, "");
    else if (line.startsWith("+") && line.length <= MAX_LINE_CHARS) {
      for (const p of SECRET_PATTERNS) {
        const m = p.re.exec(line);
        if (!m || isPlaceholder(m[0]) || /EXAMPLE|example|xxxx|<|\.\.\./.test(m[0])) continue;
        if (p.id === "db-url-password" && isPlaceholderDbUrl(m[0])) continue;
        // One entry per secret value: the same key copied across commits is one key to rotate.
        if (seen.has(m[0])) continue;
        seen.add(m[0]);
        hits.push({ commit, path: file, title: p.title, snippet: redact(line.slice(1).trim(), m[0]) });
        if (hits.length >= MAX_HITS) return hits;
      }
    }
  }
  return hits;
}

const git = async (root: string, args: string[]) =>
  (await run("git", ["-C", root, ...args], { timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_LOG_BYTES })).stdout;

/** Undefined when `root` isn't the top of a git repo or git fails; the checklist then says history wasn't checked. */
export async function scanGitHistory(root: string): Promise<HistoryScan | undefined> {
  try {
    const top = (await git(root, ["rev-parse", "--show-toplevel"])).trim();
    // The scanned folder may sit inside a bigger repo; its history isn't this project's.
    if ((await realpath(top)) !== (await realpath(root))) return undefined;
    const [count, shallow, log] = await Promise.all([
      git(root, ["rev-list", "--all", "--count"]),
      git(root, ["rev-parse", "--is-shallow-repository"]),
      git(root, ["log", "--all", "-p", "-U0", "--no-color", "--no-ext-diff", "--no-renames", "--format=commit:%h"]),
    ]);
    return { commits: Number(count.trim()) || 0, shallow: shallow.trim() === "true", hits: findHistorySecrets(log) };
  } catch (e) {
    console.error(`[scan] git history not scanned: ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
}
