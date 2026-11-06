import { afterAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadGraph, scanAndSave, writeJsonAtomic, type RegistryFetch } from "@lens/core";
import { remediationItems } from "../src/enrich.js";
import { collectChanges, makeWorkspace } from "../src/workspace.js";
import { applyFixes, buildRecord, remediationPath } from "../src/remediate.js";

const OLD = "2015-01-01T00:00:00.000Z";
const EXPRESS_LATEST = "4.21.2";

const packument = (name: string, latest: string) => ({
  "dist-tags": { latest },
  time: { created: OLD },
  versions: { [latest]: {} },
});

/** Registry as seen from the project: `expres` is a near-empty lookalike of `express`. */
const ROUTES: Record<string, unknown> = {
  "https://registry.npmjs.org/expres": packument("expres", "1.0.0"),
  "https://api.npmjs.org/downloads/point/last-week/expres": { downloads: 3 },
  "https://registry.npmjs.org/express": packument("express", EXPRESS_LATEST),
  "https://registry.npmjs.org/express/latest": { version: EXPRESS_LATEST },
};

const registryFetch: RegistryFetch = async (url) =>
  url in ROUTES ? new Response(JSON.stringify(ROUTES[url]), { status: 200 }) : new Response("{}", { status: 404 });

const scan = (root: string) => scanAndSave(root, { offline: false, registryFetch });

// A supply-chain row must carry the exact line to write, so the remediator (no network) can fix it and the rescan clears it.
describe("Remediate on supply-chain findings", () => {
  const dirs: string[] = [];
  afterAll(async () => Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true }))));

  it("fixes a typosquatted dependency from the line named in the finding", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "lens-supply-fix-"));
    dirs.push(root);
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "demo", dependencies: { expres: "^1.0.0" } }, null, 2));
    await fs.writeFile(path.join(root, "index.js"), "const express = require('expres');\nmodule.exports = express;\n");
    await scan(root);

    const items = await remediationItems(root, "audit", undefined, Infinity);
    const row = items.find((i) => i.id !== "t3-realdeps" && i.evidence[0]!.startsWith("package.json:4 "));
    expect(row?.evidence[0]).toContain(`\`"express": "^${EXPRESS_LATEST}"\``);
    expect(row?.evidence[0]).toContain("change every import of expres to express");
    expect(items.find((i) => i.id === "t3-realdeps")).toBeDefined();

    // What the remediator writes when it follows the finding text.
    const ws = await makeWorkspace(root);
    dirs.push(ws);
    await fs.writeFile(path.join(ws, "package.json"), JSON.stringify({ name: "demo", dependencies: { express: `^${EXPRESS_LATEST}` } }, null, 2));
    await fs.writeFile(path.join(ws, "index.js"), "const express = require('express');\nmodule.exports = express;\n");
    const { data } = await collectChanges(root, ws, {
      fixes: [{ itemId: row!.id, title: row!.title, explanation: "Switched expres to express.", files: ["package.json", "index.js"] }],
      skipped: [],
    });
    const rec = buildRecord(root, "audit", data, 0, undefined, "t");
    await writeJsonAtomic(remediationPath(root, "audit"), rec);
    const { applied, failed } = await applyFixes(root, "audit", rec.fixes.map((f) => f.id));
    expect(failed).toEqual([]);
    expect(applied).toHaveLength(1);

    await scan(root);
    const security = (await loadGraph(root))!.security!;
    expect(security.findings.filter((f) => f.category === "supply-chain")).toEqual([]);
    expect(security.checklist!.find((c) => c.id === "t3-realdeps")).toMatchObject({ status: "clear" });
    expect((await remediationItems(root, "audit", undefined, Infinity)).some((i) => i.id === row!.id)).toBe(false);
  });
});
