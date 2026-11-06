import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanProject, type HealthCheck } from "../src/index.js";
import { isVagueName, magicNumbersInLine, nameStyle } from "../src/quality/standards.js";
import { resolveLayerRules } from "../src/quality/architecture.js";

const FIXTURE = path.join(__dirname, "fixtures", "standards-app");

async function copyFixture(extra: Record<string, string> = {}): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lens-standards-"));
  await fs.cp(FIXTURE, dir, { recursive: true });
  for (const [rel, content] of Object.entries(extra)) {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await fs.writeFile(path.join(dir, rel), content);
  }
  return dir;
}

async function checksFor(dir: string): Promise<Map<string, HealthCheck>> {
  const { graph } = await scanProject(dir, { full: true });
  return new Map(graph.health!.checks.map((c) => [c.id, c]));
}

const hitsOf = (check: HealthCheck | undefined) => (check?.hits ?? []).map((h) => `${h.path}:${h.line ?? ""}`);

describe("layer violations", () => {
  it("flags UI reading the database and data code importing handlers", async () => {
    const by = await checksFor(await copyFixture());
    const check = by.get("layer-violations")!;
    expect(check.category).toBe("architecture");
    expect(hitsOf(check).sort()).toEqual(["src/components/OrderList.tsx:1", "src/db/orders.ts:2"]);
    expect(check.hits.find((h) => h.path === "src/components/OrderList.tsx")?.detail).toBe("UI → Data: imports src/db/orders.ts (UI reaches the database directly)");
  });

  it("skips type-only imports and API code reading data", async () => {
    const by = await checksFor(await copyFixture());
    const paths = by.get("layer-violations")!.hits.map((h) => h.path);
    expect(paths).not.toContain("src/components/OrderRow.tsx");
    expect(paths).not.toContain("src/api/orders.ts");
  });

  it("applies allow, rules, and ignore from .lens/architecture.json", async () => {
    const config = {
      allow: [{ from: "ui", to: "data" }],
      rules: [{ from: "api", to: "service", reason: "handlers go through the job queue" }],
      ignore: ["src/db/**"],
    };
    const by = await checksFor(await copyFixture({ ".lens/architecture.json": JSON.stringify(config) }));
    const check = by.get("layer-violations")!;
    expect(hitsOf(check)).toEqual(["src/api/orders.ts:2"]);
    expect(check.hits[0]!.detail).toContain("handlers go through the job queue");
  });

  it("drops the built-in rules when defaults is false", () => {
    expect(resolveLayerRules({ defaults: false })).toEqual([]);
    expect(resolveLayerRules(undefined).length).toBeGreaterThan(0);
  });

  it("fails the scan on an invalid override file", async () => {
    const badLayer = await copyFixture({ ".lens/architecture.json": JSON.stringify({ rules: [{ from: "UI Layer", to: "data" }] }) });
    await expect(scanProject(badLayer, { full: true })).rejects.toThrow(/architecture\.json is invalid/);
    const unknownKey = await copyFixture({ ".lens/architecture.json": JSON.stringify({ layers: [] }) });
    await expect(scanProject(unknownKey, { full: true })).rejects.toThrow(/architecture\.json is invalid/);
    const notJson = await copyFixture({ ".lens/architecture.json": "{ rules: " });
    await expect(scanProject(notJson, { full: true })).rejects.toThrow(/not valid JSON/);
    const tooLong = await copyFixture({ ".lens/architecture.json": JSON.stringify({ ignore: ["x".repeat(201)] }) });
    await expect(scanProject(tooLong, { full: true })).rejects.toThrow(/architecture\.json is invalid/);
  });
});

describe("magic numbers", () => {
  it("flags unnamed thresholds in business code only", async () => {
    const by = await checksFor(await copyFixture());
    const check = by.get("magic-numbers")!;
    expect(hitsOf(check)).toEqual(["src/services/pricing.ts:5", "src/services/pricing.ts:6"]);
    expect(check.hits[0]!.detail.startsWith("0.15 in")).toBe(true);
  });

  it("leaves plain numbers, named constants, units, strings, and regexes alone", () => {
    expect(magicNumbersInLine("if (attempts > 5) retry();")).toEqual(["5"]);
    expect(magicNumbersInLine("const MAX_ATTEMPTS = 5;")).toEqual([]);
    expect(magicNumbersInLine("if (count > 0 && ratio < 0.5) return total / 100;")).toEqual([]);
    expect(magicNumbersInLine("const timeout = 5 * 60_000;")).toEqual([]);
    expect(magicNumbersInLine("const bytes = 64 * 1024 * 1024;")).toEqual([]);
    expect(magicNumbersInLine("if (res.status === 404) return null;")).toEqual([]);
    expect(magicNumbersInLine("const pct = value * 100.0;")).toEqual([]);
    expect(magicNumbersInLine("const fee = amount * 0.029;")).toEqual(["0.029"]);
  });
});

describe("vague names", () => {
  it("flags placeholder names and nothing else", async () => {
    const by = await checksFor(await copyFixture());
    const details = by.get("vague-names")!.hits.map((h) => h.detail.split("`")[1]);
    expect(details.sort()).toEqual(["data2", "handleStuff", "tmp"]);
  });

  it("knows placeholders from real names", () => {
    for (const name of ["tmp", "data2", "result3", "handleStuff", "doIt", "_foo"]) expect(isVagueName(name)).toBe(true);
    for (const name of ["temp", "data", "result", "bar", "handleSubmit", "x", "i", "h264", "processOrder"]) expect(isVagueName(name)).toBe(false);
  });
});

describe("mixed naming", () => {
  it("flags the odd one out in a module", async () => {
    const by = await checksFor(await copyFixture());
    const check = by.get("mixed-naming")!;
    expect(hitsOf(check)).toEqual(["src/services/naming.ts:13"]);
    expect(check.hits[0]!.detail).toBe("save_order is snake_case; 3 other functions here are camelCase");
  });

  it("classifies only multi-word names", () => {
    expect(nameStyle("getOrder")).toBe("camelCase");
    expect(nameStyle("get_order")).toBe("snake_case");
    expect(nameStyle("_private_helper")).toBe("snake_case");
    expect(nameStyle("render")).toBeUndefined();
    expect(nameStyle("OrderList")).toBeUndefined();
  });
});

describe("missing tooling", () => {
  it("flags a JS project with no linter or formatter", async () => {
    const by = await checksFor(await copyFixture());
    const details = by.get("missing-tooling")!.hits.map((h) => h.detail);
    expect(details).toEqual([
      "no linter for 9 JavaScript/TypeScript files (add ESLint or Biome)",
      "no formatter for 9 JavaScript/TypeScript files (add Prettier or Biome)",
    ]);
  });

  it("accepts a config file or a zero-config tool", async () => {
    const withConfigs = await copyFixture({ "eslint.config.js": "export default [];\n", ".prettierrc": "{}\n" });
    expect((await checksFor(withConfigs)).get("missing-tooling")!.hits).toEqual([]);
    const withBiome = await copyFixture({ "package.json": JSON.stringify({ name: "s", devDependencies: { "@biomejs/biome": "1.9.4" } }) });
    expect((await checksFor(withBiome)).get("missing-tooling")!.hits).toEqual([]);
  });

  it("checks Python for Ruff config in pyproject", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lens-py-"));
    await fs.mkdir(path.join(dir, "app"));
    for (const name of ["a", "b", "c", "d", "e"]) await fs.writeFile(path.join(dir, "app", `${name}.py`), `def run_${name}():\n    return 1\n`);
    await fs.writeFile(path.join(dir, "pyproject.toml"), "[project]\nname = \"p\"\ndependencies = []\n");
    expect((await checksFor(dir)).get("missing-tooling")!.hits.map((h) => h.path)).toEqual(["pyproject.toml", "pyproject.toml"]);
    await fs.writeFile(path.join(dir, "pyproject.toml"), "[project]\nname = \"p\"\ndependencies = []\n\n[tool.ruff]\nline-length = 100\n");
    expect((await checksFor(dir)).get("missing-tooling")!.hits).toEqual([]);
  });
});
