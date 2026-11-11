import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import ELK from "elkjs/lib/elk.bundled.js";
import type { ImpactReport, KnowledgeGraph } from "@lens/core/browser";
import { buildLayers, buildStructure, edgeAccumulator } from "./aggregate";
import { layerColor, hashColor } from "./colors";
import { buildDomain } from "./domain";
import { DEFAULT_FILTERS, compileFilters, isTestNode, sanitizeFilters } from "./filters";
import { buildKnowledge, forceLayout } from "./knowledge";
import { columnLayout, computeLayout, fallbackElk, shelfPack, type ElkLike } from "./layout";
import { toMermaid } from "./mermaid";
import { buildModel, commonDir } from "./model";
import { computeOverlay } from "./overlay";
import { buildSecurity, DEFAULT_SECURITY_FILTER, filterFindings, findingFocus, inputPath, splitFindings, traceLimitsText, urgentOpenCount } from "./security";
import { findingItemId } from "@lens/core/browser";
import { buildFileTree } from "./tree";
import { validateGraph } from "./validate";

const fixture = (name: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../../public/${name}`, import.meta.url)), "utf8")) as unknown;
const graph = fixture("sample-graph.json") as KnowledgeGraph;
const diff = fixture("sample-diff.json") as ImpactReport;
const model = buildModel(graph);
const cf = compileFilters(model, DEFAULT_FILTERS);

describe("model", () => {
  it("indexes files and owners", () => {
    expect(model.files.length).toBeGreaterThan(30);
    expect(model.owner.get("function:server/src/db/taskRepo.ts:searchTasks")).toBe("file:server/src/db/taskRepo.ts");
    // nested method -> class -> file
    expect(model.owner.get("function:server/src/services/taskService.ts:search")).toBe("file:server/src/services/taskService.ts");
    // a second node at an existing path is owned by the canonical file
    expect(model.owner.get("service:postgres")).toBe("config:docker-compose.yml");
    expect(model.riskByFile.get("file:server/src/services/exportService.ts")).toBe("critical");
  });
  it("computes common directories", () => {
    expect(commonDir(["a/b/c.ts", "a/b/d/e.ts"])).toBe("a/b");
    expect(commonDir(["x.ts", "a/y.ts"])).toBe("");
  });
});

describe("structure aggregation", () => {
  it("drills into the root with folders and aggregated edges", () => {
    const vm = buildStructure(model, cf, { dir: "", flat: false, expanded: new Set() });
    const folders = vm.nodes.filter((n) => n.type === "folder");
    expect(folders.map((f) => f.label)).toEqual(expect.arrayContaining(["apps/web", "server", "docs"]));
    const server = folders.find((f) => f.label === "server")!;
    expect(server.fileCount).toBe(model.files.filter((f) => f.path.startsWith("server/")).length);
    expect(server.risk).toBe("critical");
    // every edge references visible nodes and has a positive count
    const ids = new Set(vm.nodes.map((n) => n.id));
    for (const e of vm.edges) {
      expect(ids.has(e.source) && ids.has(e.target)).toBe(true);
      expect(e.count).toBeGreaterThan(0);
      expect(e.kinds).not.toContain("contains");
    }
    // web -> server via HTTP calls edge
    expect(vm.edges.some((e) => e.source === "d:apps/web" && e.target === "d:server")).toBe(true);
    expect(vm.rep("function:server/src/db/taskRepo.ts:searchTasks")).toBe("d:server");
  });

  it("shows an outside node and maps foreign files to it", () => {
    const vm = buildStructure(model, cf, { dir: "server/src/db", flat: false, expanded: new Set() });
    expect(vm.nodes.some((n) => n.id === "x:outside")).toBe(true);
    expect(vm.rep("file:server/src/app.ts")).toBe("x:outside");
    expect(vm.rep("file:server/src/db/taskRepo.ts")).toBe("f:file:server/src/db/taskRepo.ts");
  });

  it("expands a file into its symbols and routes edges to them", () => {
    const f = "file:server/src/db/taskRepo.ts";
    const vm = buildStructure(model, cf, { dir: "server/src/db", flat: false, expanded: new Set([f]) });
    const syms = vm.nodes.filter((n) => n.parent === `f:${f}`);
    expect(syms.map((s) => s.label)).toEqual(expect.arrayContaining(["searchTasks", "findTasksForUser"]));
    expect(vm.rep("function:server/src/db/taskRepo.ts:searchTasks")).toBe("s:function:server/src/db/taskRepo.ts:searchTasks");
  });

  it("builds the flat grouped view", () => {
    const vm = buildStructure(model, cf, { dir: "", flat: true, expanded: new Set() });
    const groups = vm.nodes.filter((n) => n.type === "group");
    const files = vm.nodes.filter((n) => n.type === "file");
    expect(files.length).toBe(model.files.length);
    for (const f of files) expect(groups.some((g) => g.id === f.parent)).toBe(true);
  });

  it("applies filters", () => {
    const noTests = compileFilters(model, { ...DEFAULT_FILTERS, hideTests: true });
    const vm = buildStructure(model, noTests, { dir: "server/test", flat: false, expanded: new Set() });
    expect(vm.nodes.filter((n) => n.type === "file")).toHaveLength(0);
    const onlyFindings = compileFilters(model, { ...DEFAULT_FILTERS, onlyFindings: true });
    const flat = buildStructure(model, onlyFindings, { dir: "", flat: true, expanded: new Set() });
    const files = flat.nodes.filter((n) => n.type === "file");
    expect(files.length).toBeGreaterThan(0);
    expect(files.every((n) => (model.findingsByFile.get(n.graphId!) ?? []).length > 0)).toBe(true);
    const noImports = compileFilters(model, { ...DEFAULT_FILTERS, hiddenEdgeKinds: ["imports"] });
    const vm2 = buildStructure(model, noImports, { dir: "", flat: true, expanded: new Set() });
    expect(vm2.edges.every((e) => !e.kinds.includes("imports"))).toBe(true);
  });

  it("accumulates edges with counts and ranked kinds", () => {
    const acc = edgeAccumulator();
    acc.add("a", "b", "calls");
    acc.add("a", "b", "imports");
    acc.add("a", "b", "imports");
    acc.add("a", "a", "calls");
    const [e, ...rest] = acc.edges();
    expect(rest).toHaveLength(0);
    expect(e!.count).toBe(3);
    expect(e!.kinds).toEqual(["imports", "calls"]);
  });
});

describe("layers view", () => {
  it("places layers in rank order with arc edges between headers", () => {
    const vm = buildLayers(model, cf, {});
    const headers = vm.nodes.filter((n) => n.type === "layerHeader");
    expect(headers[0]!.label).toBe("UI");
    for (let i = 1; i < headers.length; i++) expect(headers[i]!.x!).toBeGreaterThan(headers[i - 1]!.x!);
    const arcs = vm.edges.filter((e) => e.variant === "arc");
    expect(arcs.length).toBeGreaterThan(0);
    expect(arcs.some((a) => a.source === "lh:ui" && a.target === "lh:utility")).toBe(true);
  });
});

describe("security view", () => {
  it("builds entry -> hop -> sink columns", () => {
    const vm = buildSecurity(model, cf, DEFAULT_SECURITY_FILTER);
    const entry = vm.nodes.find((n) => n.id === "en:endpoint:POST /api/admin/export")!;
    const sink = vm.nodes.find((n) => n.id === "sink:LNS-001")!;
    expect(entry.auth).toBe("unguarded");
    expect(sink.x!).toBeGreaterThan(entry.x!);
    expect(vm.edges.some((e) => e.target === "sink:LNS-001")).toBe(true);
    const focus = findingFocus(model, "LNS-002");
    const reps = focus.map((id) => vm.rep(id)).filter(Boolean);
    expect(reps).toContain("sink:LNS-002");
    expect(reps).toContain("en:endpoint:GET /api/tasks/search");
  });
  it("filters findings", () => {
    const all = graph.security!.findings;
    expect(filterFindings(all, { severities: ["critical"], categories: [], statuses: [] })).toHaveLength(1);
    expect(filterFindings(all, { severities: [], categories: [], statuses: ["false_positive"] }).every((f) => f.status === "false_positive")).toBe(true);
  });
  it("keeps public, no-fix-needed, and fixed findings out of the open list", () => {
    const base = graph.security!.findings;
    const all = [{ ...base[0]!, id: "A", status: "accepted" as const }, { ...base[0]!, id: "B", status: "false_positive" as const }, { ...base[1]!, id: "C", status: "open" as const }, { ...base[2]!, id: "D", status: "open" as const }];
    const { open, closed } = splitFindings(all, new Set([findingItemId(all[3]!)]));
    expect(open.map((f) => f.id)).toEqual(["C"]);
    expect(closed.map((f) => f.id).sort()).toEqual(["A", "B", "D"]);
  });
  it("Security tab count skips high findings Lens already fixed", () => {
    const high = { ...graph.security!.findings[0]!, severity: "high" as const, status: "open" as const };
    expect(urgentOpenCount([high], new Set())).toBe(1);
    expect(urgentOpenCount([high], new Set([findingItemId(high)]))).toBe(0);
  });
});

describe("domain + knowledge", () => {
  it("builds domains and reveals implementations for a step", () => {
    const vm = buildDomain(model, cf, { expandedStep: "step:login-verify" });
    expect(vm.nodes.filter((n) => n.type === "domain")).toHaveLength(3);
    expect(vm.nodes.some((n) => n.id === "impl:function:server/src/services/authService.ts:verifyPassword")).toBe(true);
    expect(vm.edges.some((e) => e.kinds[0] === "cross_domain")).toBe(true);
  });
  it("lays out knowledge nodes deterministically", () => {
    const vm = buildKnowledge(model, cf);
    expect(vm.nodes.length).toBeGreaterThan(5);
    const a = forceLayout(vm, 120);
    const b = forceLayout(vm, 120);
    expect(a).toEqual(b);
    for (const p of Object.values(a)) expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
  });
});

describe("layout", () => {
  const elk = new ELK() as unknown as ElkLike;
  it("lays out nested groups with ELK and keeps children inside parents", async () => {
    const vm = buildStructure(model, cf, { dir: "", flat: true, expanded: new Set(["file:server/src/db/taskRepo.ts"]) });
    const pos = await computeLayout({ nodes: vm.nodes.map((n) => ({ id: n.id, w: n.w, h: n.h, parent: n.parent })), edges: vm.edges }, elk);
    for (const n of vm.nodes) {
      const p = pos[n.id]!;
      expect(p).toBeDefined();
      if (n.parent) {
        const parent = pos[n.parent]!;
        expect(p.x).toBeGreaterThanOrEqual(0);
        expect(p.y).toBeGreaterThanOrEqual(30);
        expect(p.x + p.w).toBeLessThanOrEqual(parent.w + 0.5);
        expect(p.y + p.h).toBeLessThanOrEqual(parent.h + 0.5);
      }
    }
    // no two top-level boxes overlap
    const tops = vm.nodes.filter((n) => !n.parent).map((n) => pos[n.id]!);
    for (let i = 0; i < tops.length; i++)
      for (let j = i + 1; j < tops.length; j++) {
        const a = tops[i]!;
        const b = tops[j]!;
        const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        expect(overlap).toBe(false);
      }
  });
  it("fallback layered layout ranks a chain left to right", async () => {
    const pos = await computeLayout(
      { nodes: ["a", "b", "c"].map((id) => ({ id, w: 100, h: 40 })), edges: [{ source: "a", target: "b" }, { source: "b", target: "c" }, { source: "c", target: "a" }] },
      fallbackElk,
    );
    expect(pos.a!.x).toBeLessThan(pos.b!.x);
    expect(pos.b!.x).toBeLessThan(pos.c!.x);
  });
  it("column layout orders by barycenter", () => {
    const pos = columnLayout([["a", "b"], ["y", "x"]], [{ source: "a", target: "x" }, { source: "b", target: "y" }], () => ({ w: 10, h: 10 }));
    expect(pos.x!.y).toBeLessThan(pos.y!.y);
  });
  it("shelf packs within width", () => {
    const r = shelfPack(["a", "b", "c"], [{ w: 50, h: 10 }, { w: 50, h: 20 }, { w: 50, h: 10 }], 110, 10);
    expect(r.pos.c).toEqual({ x: 0, y: 30 });
    expect(r.w).toBe(110);
  });
});

describe("overlay", () => {
  it("rings changed/impacted nodes and dims the rest", () => {
    const vm = buildStructure(model, cf, { dir: "server/src/db", flat: false, expanded: new Set() });
    const o = computeOverlay(vm, { diff });
    expect(o.changed.has("f:file:server/src/db/taskRepo.ts")).toBe(true);
    expect(o.dim.has("f:file:server/src/db/userRepo.ts")).toBe(true);
  });
  it("highlights a focus set and its internal edges", () => {
    const vm = buildStructure(model, cf, { dir: "", flat: true, expanded: new Set() });
    const o = computeOverlay(vm, { focus: ["file:server/src/app.ts", "file:server/src/routes/tasks.ts"] });
    expect(o.hl.size).toBe(2);
    expect([...o.edgeHl].some((id) => id.includes("app.ts") && id.includes("routes/tasks.ts"))).toBe(true);
    // containing groups are not dimmed
    expect(o.dim.has("g:server/src")).toBe(false);
  });
});

describe("misc utils", () => {
  it("emits mermaid with subgraphs and escaped labels", () => {
    const text = toMermaid(
      [
        { id: "g", type: "group", label: "src", w: 0, h: 0 },
        { id: "a", type: "file", label: 'say "hi"', parent: "g", w: 1, h: 1 },
        { id: "b", type: "folder", label: "lib", w: 1, h: 1 },
      ],
      [{ id: "e", source: "a", target: "b", count: 3, kinds: ["imports"] }],
    );
    expect(text).toContain("flowchart LR");
    expect(text).toContain('subgraph n0["src"]');
    expect(text).toContain("#quot;hi#quot;");
    expect(text).toContain('n1 -->|"imports ×3"| n2');
  });
  it("sanitizes stored filters", () => {
    expect(sanitizeFilters({ hideTests: true, hiddenNodeKinds: ["file", 3] })).toEqual({ ...DEFAULT_FILTERS, hideTests: true, hiddenNodeKinds: ["file"] });
    expect(sanitizeFilters("garbage")).toEqual(DEFAULT_FILTERS);
  });
  it("detects tests", () => {
    expect(isTestNode({ id: "x", kind: "file", name: "a.test.ts", path: "src/a.test.ts", summary: "", summarySource: "heuristic", tags: [], complexity: "simple" })).toBe(true);
    expect(isTestNode({ id: "x", kind: "file", name: "a.ts", path: "src/a.ts", summary: "", summarySource: "heuristic", tags: [], complexity: "simple" })).toBe(false);
  });
  it("colors layers from the palette, then layer.color, then a hash", () => {
    expect(layerColor({ id: "api", name: "API" })).toBe("#60a5fa");
    expect(layerColor({ id: "x1", name: "Frontend" })).toBe("#c084fc");
    expect(layerColor({ id: "zz", name: "Zed", color: "#123456" })).toBe("#123456");
    expect(hashColor("zz")).toMatch(/^#[0-9a-f]{6}$/);
  });
  it("builds a compacted file tree", () => {
    const tree = buildFileTree(model.files);
    const apps = tree.children.find((c) => c.name.startsWith("apps"))!;
    expect(apps.name).toBe("apps/web");
    expect(tree.fileCount).toBe(model.files.length);
  });
  it("validates and repairs malformed graphs", () => {
    const { graph: g, warnings } = validateGraph({ schema: "lens/0", nodes: [{ id: "a" }, null], edges: "nope" });
    expect(warnings.length).toBeGreaterThan(0);
    expect(g.nodes).toHaveLength(1);
    expect(g.edges).toEqual([]);
    expect(g.nodes[0]!.tags).toEqual([]);
  });
});

describe("inputPath", () => {
  const names: Record<string, string> = { "endpoint:a": "GET /a", "function:h": "GET /a", "function:s": "save" };
  const nameOf = (id: string) => names[id] ?? id;
  it("names the first traced path, drops repeated inline names, and counts the rest", () => {
    const exposure = [
      { findingId: "F1", entryId: "endpoint:a", path: ["endpoint:a", "function:s"] },
      { findingId: "F1", entryId: "endpoint:a", path: ["endpoint:a", "function:h", "function:s"], tainted: true },
      { findingId: "F1", entryId: "endpoint:b", path: ["endpoint:b", "function:s"], tainted: true },
    ];
    expect(inputPath(exposure, "F1", nameOf)).toEqual({ steps: ["GET /a", "save"], more: 1 });
    expect(inputPath(exposure, "F2", nameOf)).toBeNull();
  });
  it("lists the caps that cut a trace short", () => {
    expect(traceLimitsText(["depth", "body"])).toContain("call depth cap, long function bodies");
  });
});

describe("checklist groups", () => {
  it("puts failing checks in To Fix and counts them with open findings", async () => {
    const { checkGroup, toFixCount } = await import("./security");
    expect(checkGroup("fail")).toBe("fix");
    expect(checkGroup("unverified")).toBe("you");
    expect(checkGroup("manual")).toBe("you");
    expect(["pass", "clear", "na"].map((s) => checkGroup(s as never))).toEqual(["done", "done", "done"]);
    const checks = [{ status: "fail" }, { status: "manual" }, { status: "pass" }] as never;
    expect(toFixCount(2, checks)).toBe(3);
  });

  it("scores security 100 when nothing is left to fix, and lower per open item", async () => {
    const { securityScore } = await import("./security");
    expect(securityScore([], [{ status: "manual", tier: 1 }, { status: "pass", tier: 1 }])).toBe(100);
    const one = securityScore([], [{ status: "fail", tier: 1 }]);
    expect(one).toBeLessThan(100);
    expect(securityScore([{ severity: "critical" }], [])).toBeLessThan(securityScore([{ severity: "high" }], []));
    expect(securityScore([{ severity: "low" }], [])).toBeGreaterThan(one);
  });

  it("labels each tab's Remediate by whose job is running", async () => {
    const { remediateLabel } = await import("./security");
    const run = (task: string, source?: string) => ({ task, source, state: "running" }) as never;
    expect(remediateLabel("audit", run("review"))).toBe("Health Running");
    expect(remediateLabel("health", run("review"))).toBe("Running…");
    expect(remediateLabel("health", run("remediate", "audit"))).toBe("Security Running");
    expect(remediateLabel("audit", run("remediate", "audit"))).toBe("Running…");
    expect(remediateLabel("health", run("remediate", "review"))).toBe("Running…");
    expect(remediateLabel("audit", run("domain"))).toBe("AI Running");
    expect(remediateLabel("audit", { task: "review", state: "done" } as never)).toBe("Remediate");
  });

  it("builds a Claude Code prompt from open checks", async () => {
    const { checkPrompt } = await import("./security");
    const text = checkPrompt("you", [{ title: "Spend caps", evidence: ["No cap found"], fix: "Add a cap" }], { "t1-spend": "Set a monthly limit." }, ["t1-spend"]);
    expect(text).toContain("Never print secret values.");
    expect(text).toContain("1. Spend caps\n   Goal: Set a monthly limit.\n   - No cap found");
    expect(checkPrompt("fix", [{ title: "X", evidence: [], fix: "Do Y" }])).toContain("Goal: Do Y");
  });
});
