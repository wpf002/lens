/**
 * Commit messages, branch names, and pull request text for the projects Lens fixes.
 * Everything here ends up in the owner's git history, so it reads like a person wrote it.
 */
import path from "node:path";

export interface AppliedFix {
  title: string;
  files: string[];
}

const SUBJECT_MAX = 72;
const TOPIC_WORDS = 4;
const TOPIC_MAX = 40;

const ATTRIBUTION_LINE = /^\s*(co-authored-by:|signed-off-by:\s*(claude|lens)|🤖|generated (with|by)\b)/i;
const ATTRIBUTION_PHRASE = /,?\s*\b((found|flagged|fixed|suggested|proposed|written|made|done|applied|reported|detected|created)\s+)?(by|via|from|with|using)\s+(Lens|Claude( Code)?|an? AI( agent| assistant| model)?|the AI)\b/gi;
// "Lens" alone stays: a project can be about camera lenses. Only Lens as the actor goes.
const TOOL_NAMES = /\bClaude( Code)?('s)?\s*|\bLens(-|'s\s+|\s+)(found|flagged|reported|detected|suggested|review|scan|check)\w*\s*/g;
const GENERATED_PHRASE = /\s*\b(auto-?)?generated\s+(by|with|using)\s+(Lens|Claude( Code)?|AI|an AI|ChatGPT|GPT-?\d\S*|Copilot)\b/gi;

/** Remove anything that names the tool or an AI as the author. */
export function cleanText(text: string): string {
  return text
    .split("\n")
    .filter((l) => !ATTRIBUTION_LINE.test(l))
    .map((l) => l.replace(GENERATED_PHRASE, "").replace(ATTRIBUTION_PHRASE, "").replace(TOOL_NAMES, "").replace(/ {2,}/g, " ").replace(/\s+([.,;:])/g, "$1").replace(/^(\s*)[:;,]\s*/, "$1").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function capitalize(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  return `${cut.slice(0, cut.lastIndexOf(" ") > max / 2 ? cut.lastIndexOf(" ") : cut.length)}…`;
}

function titles(fixes: AppliedFix[]): string[] {
  return [...new Set(fixes.map((f) => capitalize(cleanText(f.title).replace(/\.$/, ""))).filter(Boolean))];
}

/** Fixes whose files are among the changed paths. */
export function fixesTouching(fixes: AppliedFix[], changed: string[]): AppliedFix[] {
  const set = new Set(changed);
  return fixes.filter((f) => f.files.some((p) => set.has(p)));
}

/** One-line subject: the fix title, or the first title plus how many more. */
export function subjectFor(fixes: AppliedFix[], changed: string[]): string {
  const list = titles(fixes);
  if (list.length === 1) return truncate(list[0]!, SUBJECT_MAX);
  if (list.length > 1) {
    const rest = ` and ${list.length - 1} more fix${list.length === 2 ? "" : "es"}`;
    return `${truncate(list[0]!, SUBJECT_MAX - rest.length)}${rest}`;
  }
  const names = [...new Set(changed.map((p) => path.basename(p)))];
  if (!names.length) return "Update files";
  return truncate(names.length <= 2 ? `Update ${names.join(" and ")}` : `Update ${names[0]} and ${names.length - 1} other files`, SUBJECT_MAX);
}

/** Subject line, then a bullet per fix when there's more than one. */
export function commitMessage(fixes: AppliedFix[], changed: string[]): string {
  const list = titles(fixes);
  const subject = subjectFor(fixes, changed);
  return list.length > 1 ? `${subject}\n\n${list.map((t) => `- ${t}`).join("\n")}` : subject;
}

export function pullRequestText(fixes: AppliedFix[], changed: string[]): { title: string; body: string } {
  const list = titles(fixes);
  const files = [...new Set(changed)].sort();
  const sections = [list.length ? list.map((t) => `- ${t}`).join("\n") : "", files.length ? `Files:\n${files.map((f) => `- \`${f}\``).join("\n")}` : ""].filter(Boolean);
  return { title: subjectFor(fixes, changed), body: sections.join("\n\n") };
}

function slug(s: string): string {
  const words = s
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/[\s-]+/)
    .filter((w) => w && !STOP_WORDS.has(w))
    .slice(0, TOPIC_WORDS);
  return words.join("-").slice(0, TOPIC_MAX).replace(/-+$/, "");
}
const STOP_WORDS = new Set(["a", "an", "the", "of", "in", "on", "to", "for", "and", "or", "with", "from", "by", "at", "is", "it"]);

/** `fix/<topic>-<yyyymmdd>`, from the first fix title or the first changed file. */
export function branchNameFor(fixes: AppliedFix[], changed: string[], now = new Date()): string {
  const first = titles(fixes)[0] ?? path.basename(changed[0] ?? "", path.extname(changed[0] ?? ""));
  const topic = slug(first) || "updates";
  return `fix/${topic}-${now.toISOString().slice(0, 10).replace(/-/g, "")}`;
}
