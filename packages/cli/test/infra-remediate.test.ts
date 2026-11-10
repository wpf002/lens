import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadGraph, scanAndSave, writeJsonAtomic } from "@lens/core";
import { remediationItems } from "../src/enrich.js";
import { applyFixes, buildRecord, remediationPath } from "../src/remediate.js";
import { collectChanges, makeWorkspace } from "../src/workspace.js";

const FIX = path.resolve(__dirname, "../../core/test/fixtures/vuln-app");
const INFRA = ["Dockerfile.worker", "infra", "k8s", "iam", ".github"];

// Remediate must be able to fix infra findings in place, workflows included.
describe("Remediate on infra findings", () => {
  let root: string;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "lens-infra-"));
    for (const entry of INFRA) await fs.cp(path.join(FIX, entry), path.join(root, entry), { recursive: true });
    await scanAndSave(root);
  });
  afterAll(async () => fs.rm(root, { recursive: true, force: true }));

  const rulesIn = async (file: string) => ((await loadGraph(root))!.security!.findings.filter((f) => f.path === file && f.status === "open").map((f) => f.rule));

  it("sends workflow items to Claude and applies infra edits, which clear the findings", async () => {
    const items = await remediationItems(root, "audit", undefined, Infinity);
    const pin = items.find((i) => i.evidence.some((e) => e.startsWith(".github/workflows/ci.yml:13 ")))!;
    expect(pin).toBeTruthy();

    const itemFor = (file: string) => items.find((i) => i.evidence.some((e) => e.startsWith(`${file}:`)))!.id;
    const ws = await makeWorkspace(root);
    const edit = async (file: string, find: string, replace: string) => {
      const p = path.join(ws, file);
      await fs.writeFile(p, (await fs.readFile(p, "utf8")).replace(find, replace));
    };
    await edit("Dockerfile.worker", "FROM python:latest AS build", "FROM python:3.12-slim AS build");
    await edit("infra/main.tf", "encrypted         = false", "encrypted         = true");
    await edit("k8s/deployment.yaml", "privileged: true", "privileged: false");
    await edit("iam/policy.json", '"Action": ["s3:*"]', '"Action": ["s3:GetObject", "s3:PutObject"]');
    await edit(".github/workflows/ci.yml", "some-org/setup-tool@v2", `some-org/setup-tool@${"a".repeat(40)} # v2`);
    const files = ["Dockerfile.worker", "infra/main.tf", "k8s/deployment.yaml", "iam/policy.json"];
    const { data, ignored } = await collectChanges(root, ws, {
      fixes: [
        ...files.map((file) => ({ itemId: itemFor(file), title: `Fix ${file}`, explanation: "x", files: [file] })),
        { itemId: pin.id, title: "Pin setup-tool", explanation: "x", files: [".github/workflows/ci.yml"] },
      ],
      skipped: [],
    });
    await fs.rm(ws, { recursive: true, force: true });
    expect(ignored).toEqual([]);
    const rec = buildRecord(root, "audit", data, 0, undefined, "t");
    expect(rec.fixes.every((f) => !f.invalid)).toBe(true);
    await writeJsonAtomic(remediationPath(root, "audit"), rec);
    expect((await applyFixes(root, "audit", rec.fixes.map((f) => f.id))).applied).toHaveLength(files.length + 1);

    await scanAndSave(root);
    expect(await rulesIn("Dockerfile.worker")).not.toContain("docker-latest-tag");
    expect(await rulesIn("infra/main.tf")).not.toContain("tf-unencrypted");
    expect(await rulesIn("k8s/deployment.yaml")).not.toContain("k8s-privileged");
    expect(await rulesIn("iam/policy.json")).not.toContain("iam-wildcard-action");
    expect(await rulesIn(".github/workflows/ci.yml")).not.toContain("gha-unpinned-action");
  });
});
