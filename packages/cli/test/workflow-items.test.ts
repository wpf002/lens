import { describe, it, expect } from "vitest";
import { splitWorkflowItems } from "../src/remediate.js";

// GitHub rejects workflow edits pushed by Lens, so those items must reach the owner as to-dos instead of Claude.
describe("splitWorkflowItems", () => {
  const workflow = { id: "gha-unpinned-action~ci", title: "Unpinned Action", evidence: [".github/workflows/ci.yml:13 Pin actions/cache to a commit SHA."] };
  const docker = { id: "docker-root-user~df", title: "Root User", evidence: ["Dockerfile:2 Add USER app."] };
  const mixed = { id: "curl-pipe-shell", title: "Curl Pipe", evidence: [".github/workflows/ci.yml:20 Download then verify.", "Dockerfile:5 Download then verify."] };

  it("sends workflow-only items to the owner with file, line, and change", () => {
    const { forClaude, ownerOnly } = splitWorkflowItems([workflow, docker, mixed]);
    expect(forClaude).toEqual([docker, mixed]);
    expect(ownerOnly).toHaveLength(1);
    expect(ownerOnly[0]!.itemId).toBe(workflow.id);
    expect(ownerOnly[0]!.reason).toMatch(/^Outside code: /);
    expect(ownerOnly[0]!.reason).toContain(".github/workflows/ci.yml line 13: Pin actions/cache to a commit SHA.");
  });

  it("keeps items without evidence for Claude", () => {
    const bare = { id: "x", title: "X" };
    expect(splitWorkflowItems([bare]).forClaude).toEqual([bare]);
  });
});
