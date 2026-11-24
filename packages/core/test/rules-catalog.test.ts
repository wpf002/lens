import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { RULES, RULES_BLOCK_BEGIN, RULES_BLOCK_END, catalogCheckIds, renderRulesBlock, withRulesBlock } from "../src/index.js";

const SRC = path.join(import.meta.dirname, "..", "src");
const CHECK_ID = /(?:\bid|\brule): "([a-z0-9]+(?:-[a-z0-9]+)*)"|\bcheck\("([a-z0-9-]+)"|^ {2}"([a-z0-9]+(?:-[a-z0-9]+)+)": \{ title:/gm;

/** Every check id written in the security and quality sources, so a new check can't ship without a rule. */
function sourceCheckIds(): Set<string> {
  const ids = new Set(RULES.map((r) => r.id));
  for (const dir of ["security", "security/probe", "quality"]) {
    for (const file of readdirSync(path.join(SRC, dir)).filter((f) => f.endsWith(".ts"))) {
      const text = readFileSync(path.join(SRC, dir, file), "utf8");
      for (const m of text.matchAll(CHECK_ID)) ids.add(m[1] ?? m[2] ?? m[3]);
    }
  }
  return ids;
}

describe("rules catalog", () => {
  it("has a rule for every Lens check", () => {
    const covered = catalogCheckIds();
    const missing = [...sourceCheckIds()].filter((id) => !covered.has(id)).sort();
    expect(missing).toEqual([]);
  });

  it("names only checks that exist", () => {
    const known = sourceCheckIds();
    expect([...catalogCheckIds()].filter((id) => !known.has(id))).toEqual([]);
  });

  it("replaces its block in place and keeps the rest of the file", () => {
    const first = withRulesBlock("# Mine\n\nKeep this.\n");
    expect(first.startsWith("# Mine\n\nKeep this.\n\n" + RULES_BLOCK_BEGIN)).toBe(true);
    const stale = first.replace("No circular imports.", "Old rule.") + "\nAfter.\n";
    const refreshed = withRulesBlock(stale);
    expect(refreshed).toContain("No circular imports.");
    expect(refreshed).not.toContain("Old rule.");
    expect(refreshed.endsWith(`${RULES_BLOCK_END}\n\nAfter.\n`)).toBe(true);
    expect(refreshed.split(RULES_BLOCK_BEGIN)).toHaveLength(2);
    expect(withRulesBlock("")).toBe(renderRulesBlock() + "\n");
  });
});
