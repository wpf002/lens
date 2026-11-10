import { githubApi } from "./github.js";

const USES = /uses:\s*["']?([\w.-]+\/[\w.-]+)(\/[^@\s"']*)?@([^\s"'#]+)/;
const SHA = /^[0-9a-f]{40}$/;

export interface ActionRef {
  repo: string;
  /** Subdirectory of a multi-action repo, e.g. "/init" in github/codeql-action/init. */
  subpath: string;
  ref: string;
}

/** The action a `uses:` line names, or null when it's local, a docker image, or already pinned. */
export function parseActionRef(line: string): ActionRef | null {
  const m = USES.exec(line);
  if (!m || SHA.test(m[3]!)) return null;
  return { repo: m[1]!, subpath: m[2] ?? "", ref: m[3]! };
}

export type ResolveSha = (repo: string, ref: string) => Promise<string>;

const githubSha: ResolveSha = async (repo, ref) => {
  const commit = (await githubApi(`/repos/${repo}/commits/${encodeURIComponent(ref)}`)) as { sha?: unknown };
  if (typeof commit.sha !== "string" || !SHA.test(commit.sha)) throw new Error(`GitHub returned no commit for ${repo}@${ref}`);
  return commit.sha;
};

/**
 * The exact edit that pins an unpinned action, with the commit SHA looked up on GitHub so
 * Claude doesn't have to guess one. Undefined when the line isn't an action or the lookup fails.
 */
export async function actionPinFix(line: string, resolve: ResolveSha = githubSha): Promise<string | undefined> {
  const a = parseActionRef(line);
  if (!a) return undefined;
  try {
    const sha = await resolve(a.repo, a.ref);
    return `Replace \`${a.repo}${a.subpath}@${a.ref}\` with \`${a.repo}${a.subpath}@${sha} # ${a.ref}\`.`;
  } catch (e) {
    console.error(`[remediate] couldn't resolve ${a.repo}@${a.ref}: ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
}
