import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadGraph, renameScannedPaths, saveGraph, scanAndSave } from "../src/index.js";

describe("renameScannedPaths", () => {
  it("keeps a moved file's summary and its links to agent nodes through the rescan", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "lens-rename-"));
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(path.join(root, "src/billing.ts"), "export function charge(amount: number) {\n  return amount * 2;\n}\n");
    await scanAndSave(root);

    const graph = (await loadGraph(root))!;
    const file = graph.nodes.find((n) => n.path === "src/billing.ts" && n.id.startsWith("file:"))!;
    file.summary = "Charges a customer.";
    file.summarySource = "llm";
    graph.nodes.push({ ...file, id: "domain:billing", kind: "domain", path: undefined, summary: "Billing.", summarySource: "llm" });
    graph.edges.push({ source: "domain:billing", target: file.id, kind: "contains", weight: 1, origin: "llm" });
    await saveGraph(root, graph);

    await fs.mkdir(path.join(root, "src/billing"), { recursive: true });
    await fs.rename(path.join(root, "src/billing.ts"), path.join(root, "src/billing/charge.ts"));
    await renameScannedPaths(root, [{ from: "src/billing.ts", to: "src/billing/charge.ts" }]);
    await scanAndSave(root);

    const after = (await loadGraph(root))!;
    const moved = after.nodes.find((n) => n.id === "file:src/billing/charge.ts")!;
    expect(moved.summary).toBe("Charges a customer.");
    expect(moved.stale).toBeUndefined();
    expect(after.nodes.some((n) => n.path === "src/billing.ts")).toBe(false);
    expect(after.edges.some((e) => e.source === "domain:billing" && e.target === moved.id)).toBe(true);
  });
});
