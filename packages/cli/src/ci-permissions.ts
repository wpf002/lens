/**
 * A CI job that calls the GitHub API with a GITHUB_TOKEN missing a permission fails on every
 * pull request, whatever the change. Lens fixes that by granting the permission GitHub named
 * in the job's `permissions:` block. Line-based so the rest of the file keeps its formatting.
 */
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";

const WORKFLOWS_DIR = path.join(".github", "workflows");
const LEVELS = ["none", "read", "write"] as const;
type Level = (typeof LEVELS)[number];
type Permissions = Map<string, Level>;

const KEY_LINE = /^(\s*)([\w-]+):\s*(.*?)\s*$/;
const isContent = (line: string) => line.trim() !== "" && !line.trim().startsWith("#");
const indentOf = (line: string) => line.length - line.trimStart().length;
const stripComment = (value: string) => value.replace(/\s+#.*$/, "");
const unquote = (value: string) => stripComment(value).replace(/^(['"])(.*)\1$/, "$2");

/** Index of the first line after `start` whose indent is at or below `indent`. */
function blockEnd(lines: string[], start: number, indent: number): number {
  let i = start + 1;
  while (i < lines.length && (!isContent(lines[i]!) || indentOf(lines[i]!) > indent)) i++;
  return i;
}

function parseLevel(value: string): Level | null {
  const v = unquote(value).toLowerCase();
  return (LEVELS as readonly string[]).includes(v) ? (v as Level) : null;
}

/** A `permissions:` value at `lines[at]`: a block or flow mapping. Null for `read-all`, `write-all`, or anything else. */
function readPermissions(lines: string[], at: number): { perms: Permissions; end: number } | null {
  const [, , , inline = ""] = KEY_LINE.exec(lines[at]!) ?? [];
  const value = stripComment(inline);
  const end = blockEnd(lines, at, indentOf(lines[at]!));
  const perms: Permissions = new Map();
  if (value) {
    const flow = /^\{(.*)\}$/.exec(value);
    if (!flow) return null;
    for (const pair of flow[1]!.split(",").filter((p) => p.trim())) {
      const [key, raw = ""] = pair.split(":").map((x) => x.trim()) as [string, string?];
      const level = parseLevel(raw);
      if (!level) return null;
      perms.set(key, level);
    }
    return { perms, end };
  }
  for (const line of lines.slice(at + 1, end).filter(isContent)) {
    const m = KEY_LINE.exec(line);
    const level = m ? parseLevel(m[3]!) : null;
    if (!m || !level) return null;
    perms.set(m[2]!, level);
  }
  return { perms, end };
}

function findKey(lines: string[], from: number, to: number, indent: number, key: string): number {
  for (let i = from; i < to; i++) {
    const m = KEY_LINE.exec(lines[i]!);
    if (m && m[1]!.length === indent && m[2] === key) return i;
  }
  return -1;
}

/** Actions names a check after the job's `name:`, or its id; a matrix adds " (…)". */
function jobMatches(checkName: string, id: string, name: string | null): boolean {
  return [id, name].some((n) => !!n && (checkName === n || checkName.startsWith(`${n} (`)));
}

/**
 * Grant `wanted` ("key: level" lines) to the job named `checkName`. Returns the new file text,
 * or null when the job isn't in this file or already has every permission.
 */
export function grantJobPermissions(yaml: string, checkName: string, wanted: string[]): string | null {
  const lines = yaml.split("\n");
  const jobsAt = lines.findIndex((l) => /^jobs:\s*(#.*)?$/.test(l));
  if (jobsAt < 0) return null;
  const jobsEnd = blockEnd(lines, jobsAt, 0);
  const firstJob = lines.slice(jobsAt + 1, jobsEnd).find(isContent);
  if (!firstJob) return null;
  const jobIndent = indentOf(firstJob);

  for (let i = jobsAt + 1; i < jobsEnd; i++) {
    const job = KEY_LINE.exec(lines[i]!);
    if (!job || job[1]!.length !== jobIndent) continue;
    const end = blockEnd(lines, i, jobIndent);
    const firstChild = lines.slice(i + 1, end).find(isContent);
    if (!firstChild) continue;
    const childIndent = indentOf(firstChild);
    const nameAt = findKey(lines, i + 1, end, childIndent, "name");
    const name = nameAt >= 0 ? unquote(KEY_LINE.exec(lines[nameAt]!)![3]!) : null;
    if (!jobMatches(checkName, job[2]!, name)) continue;

    const permsAt = findKey(lines, i + 1, end, childIndent, "permissions");
    const topAt = findKey(lines, 0, jobsAt, 0, "permissions");
    // A job-level block replaces the workflow-level one, so a new block starts from it (or the read-only default).
    const current = permsAt >= 0 ? readPermissions(lines, permsAt) : topAt >= 0 ? readPermissions(lines, topAt) : { perms: new Map([["contents", "read" as Level]]), end: -1 };
    if (!current) return null;
    const merged = new Map(current.perms);
    let changed = permsAt < 0;
    for (const line of wanted) {
      const [key, raw = ""] = line.split(":").map((x) => x.trim()) as [string, string?];
      const level = parseLevel(raw);
      if (!level || LEVELS.indexOf(merged.get(key) ?? "none") >= LEVELS.indexOf(level)) continue;
      merged.set(key, level);
      changed = true;
    }
    if (!changed) return null;

    const pad = " ".repeat(childIndent);
    const step = " ".repeat(Math.max(2, childIndent - jobIndent));
    const block = [`${pad}permissions:`, ...[...merged].map(([k, v]) => `${pad}${step}${k}: ${v}`)];
    if (permsAt >= 0) lines.splice(permsAt, current.end - permsAt, ...block);
    else lines.splice(nameAt >= 0 ? nameAt + 1 : i + 1, 0, ...block);
    return lines.join("\n");
  }
  return null;
}

/** Grant the permissions in whichever workflow defines the check's job. Returns the file changed, or null. */
export async function grantCheckPermissions(root: string, checkName: string, wanted: string[]): Promise<string | null> {
  const dir = path.join(root, WORKFLOWS_DIR);
  if (!existsSync(dir)) return null;
  for (const file of (await fs.readdir(dir)).filter((f) => /\.ya?ml$/.test(f)).sort()) {
    const abs = path.join(dir, file);
    const next = grantJobPermissions(await fs.readFile(abs, "utf8"), checkName, wanted);
    if (next === null) continue;
    await fs.writeFile(abs, next);
    return path.posix.join(".github", "workflows", file);
  }
  return null;
}
