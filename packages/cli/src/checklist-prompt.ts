export interface ChecklistItem {
  title: string;
  details: string[];
}

export interface ChecklistSection {
  heading?: string;
  items: ChecklistItem[];
}

function checklistRules(total: number): string {
  return [
    `Work through this checklist of ${total} item${total === 1 ? "" : "s"}. Every item is required.`,
    "Don't skip, defer, merge away or mark any item as not needed, and don't end your turn or summarize until every box is checked.",
    "Keep the checklist in this conversation: after finishing an item, reply with its line changed from [ ] to [x]. Don't write a plan, checklist, notes or summary .md file.",
    "If an item needs a decision from me, ask, then finish it after I answer.",
    "Before stopping, print the full checklist with every item marked [x].",
  ].join(" ");
}

/** A Claude Code prompt that states the task, then lists every item as a numbered checkbox Claude must complete. */
export function checklistPrompt(task: string, sections: ChecklistSection[]): string {
  const total = sections.reduce((n, s) => n + s.items.length, 0);
  const out = [task, "", checklistRules(total)];
  let number = 0;
  for (const section of sections.filter((s) => s.items.length)) {
    out.push("");
    if (section.heading) out.push(`${section.heading}:`);
    for (const item of section.items) {
      number += 1;
      out.push(`- [ ] ${number}. ${item.title}`);
      for (const detail of item.details) out.push(`      ${detail}`);
    }
  }
  return out.join("\n");
}
