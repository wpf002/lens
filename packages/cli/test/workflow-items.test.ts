import { describe, it, expect } from "vitest";
import { splitWorkflowItems } from "../src/remediate.js";

// GitHub rejects workflow edits pushed by Lens, so those items must reach the owner as to-dos instead of Claude.
describe("splitWorkflowItems", () => {
  const workflow = { id: "gha-unpinned-action~ci", title: "Unpinned Action", evidence: [".github/workflows/ci.yml:13 Pin actions/cache to a commit SHA."] };
  const docker = { id: "docker-root-user~df", title: "Root User", evidence: ["Dockerfile:2 Add USER app."] };
  const mixed = { id: "curl-pipe-shell", title: "Curl Pipe", evidence: [".github/workflows/ci.yml:20 Download then verify.", "Dockerfile:5 Download then verify."] };

  it("sends workflow evidence to the owner with file, line, and change", () => {
    const { forClaude, forOwner } = splitWorkflowItems([workflow, docker, mixed]);
    expect(forOwner.map((x) => x.itemId)).toEqual([workflow.id, mixed.id]);
    expect(forOwner[0]!.reason).toMatch(/^Outside code: /);
    expect(forOwner[0]!.reason).toContain(".github/workflows/ci.yml line 13: Pin actions/cache to a commit SHA.");
    expect(forOwner[1]!.reason).toContain(".github/workflows/ci.yml line 20: Download then verify.");
  });

  it("gives Claude a mixed item with only the evidence it can fix", () => {
    const { forClaude } = splitWorkflowItems([workflow, docker, mixed]);
    expect(forClaude).toEqual([docker, { ...mixed, evidence: ["Dockerfile:5 Download then verify."] }]);
  });

  it("keeps items without evidence for Claude", () => {
    const bare = { id: "x", title: "X" };
    expect(splitWorkflowItems([bare]).forClaude).toEqual([bare]);
  });
});
