import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  ProbeConfigSchema, ProbeRefused, applyProbeResults, assertRequestAllowed, checkTarget, evaluateExchanges, findListeningAddress, planProbes,
  resolveAccounts, resolveTarget, runProbes,
  type Finding, type GraphNode, type KnowledgeGraph, type PlannedRequest, type ProbeConfig, type ResolvedAddress,
} from "../src/index.js";

/* ---------- fixture app ---------- */

interface Hit { method: string; url: string; headers: http.IncomingHttpHeaders }
const hits: Hit[] = [];
let server: http.Server;
let target: URL;
const pinned: ResolvedAddress = { address: "127.0.0.1", family: 4 };
const STACK = "Error: boom\n    at query (/app/db.js:10:5)\n    at handler (/app/routes.js:22:9)";

function fixtureApp(req: http.IncomingMessage, res: http.ServerResponse) {
  hits.push({ method: req.method!, url: req.url!, headers: req.headers });
  const url = new URL(req.url!, "http://fixture");
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("access-control-allow-credentials", "true");
  }
  const [, , section, id] = url.pathname.split("/");
  if (url.pathname === "/") return res.end("home");
  if (url.pathname === "/api/open") return res.end("open data");
  if (url.pathname === "/api/admin") return void res.writeHead(401).end("login required");
  if (url.pathname === "/redirect") return void res.writeHead(302, { location: "http://example.com/" }).end();
  if (url.pathname === "/boom") return void res.writeHead(500).end("fail");
  if (url.pathname === "/search") {
    res.setHeader("content-type", "text/html");
    return res.end(`<p>Results for ${url.searchParams.get("lensprobe") ?? ""}</p>`);
  }
  if (section === "orders") {
    if (!req.headers.authorization) return void res.writeHead(401).end();
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ id: decodeURIComponent(id!), owner: "b", total: 42 }));
  }
  if (section === "items") {
    if (decodeURIComponent(id!).includes("'")) return void res.writeHead(500).end(`SQLITE_ERROR: unrecognized token\n${STACK}`);
    return res.end("item");
  }
  if (section === "safe") return res.end("safe item");
  res.writeHead(404).end();
}

beforeAll(async () => {
  server = http.createServer(fixtureApp);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  target = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

/* ---------- handcrafted graph ---------- */

type Auth = NonNullable<GraphNode["endpoint"]>["auth"];
const FILE = "src/server.ts";

function endpointNode(method: string, route: string, line: number, auth: Auth, entryType: NonNullable<GraphNode["endpoint"]>["entryType"] = "http"): GraphNode {
  return {
    id: `endpoint:${FILE}:${method} ${route}`, kind: "endpoint", name: `${method} ${route}`, path: FILE, lines: [line, line + 4],
    endpoint: { method, route, auth, entryType },
  } as GraphNode;
}

const finding = (id: string, rule: string, category: Finding["category"], line: number, reachableFrom: string[] = []): Finding => ({
  id, rule, title: rule, category, severity: "high", confidence: "medium", path: FILE, line, nodeId: `file:${FILE}`, message: rule, reachableFrom, status: "open",
});

function buildGraph(): KnowledgeGraph {
  const nodes: GraphNode[] = [
    { id: `file:${FILE}`, kind: "file", name: "server.ts", path: FILE } as GraphNode,
    endpointNode("GET", "/api/open", 10, "unguarded"),
    endpointNode("GET", "/api/admin", 20, "unguarded"),
    endpointNode("GET", "/api/orders/:id", 30, "guarded"),
    endpointNode("GET", "/search", 40, "public"),
    endpointNode("GET", "/api/items/:id", 50, "guarded"),
    endpointNode("GET", "/api/safe/:id", 60, "guarded"),
    endpointNode("DELETE", "/api/orders/:id", 70, "unguarded"),
    endpointNode("PUT", "/api/profile", 80, "unguarded"),
    endpointNode("POST", "/api/search", 90, "unknown"),
    endpointNode("POST", "/api/upload", 100, "unknown"),
    endpointNode("POST", "submitForm", 110, "unguarded", "server-action"),
  ];
  const id = (route: string, method = "GET") => `endpoint:${FILE}:${method} ${route}`;
  return {
    schema: "lens/1", kind: "codebase", project: { name: "fixture" }, nodes, edges: [], layers: [], tour: [], stats: {},
    security: {
      generatedAt: "", rulesVersion: "", entryPoints: nodes.filter((n) => n.kind === "endpoint").map((n) => n.id), exposure: [],
      summary: { bySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 }, unguardedEndpoints: 0, guardedEndpoints: 0, publicEndpoints: 0, riskScore: 0 },
      findings: [
        finding("F0001", "unauthenticated-mutation", "auth", 20),
        finding("F0002", "unauthenticated-mutation", "auth", 10),
        finding("F0003", "sql-concat", "injection", 52, [id("/api/items/:id")]),
        finding("F0004", "sql-concat", "injection", 62, [id("/api/safe/:id")]),
      ],
    },
  } as unknown as KnowledgeGraph;
}

const config = (overrides: Partial<ProbeConfig> = {}): ProbeConfig => ({
  ...ProbeConfigSchema.parse({
    safeToProbe: ["POST /api/search"],
    accounts: { a: { headersFromEnv: { Authorization: "PROBE_A" } }, b: { headersFromEnv: { Authorization: "PROBE_B" } } },
    objects: { "/api/orders/:id": { a: "1", b: "2" } },
  }),
  ...overrides,
});
const ENV = { PROBE_A: "Bearer token-a", PROBE_B: "Bearer token-b" };
const noSleep = async () => {};

/* ---------- allowlist ---------- */

describe("probe target allowlist", () => {
  const refuse = (url: string, stagingHost?: string, homepageHost?: string) =>
    expect(() => checkTarget({ target: new URL(url), stagingHost, homepageHost })).toThrow(ProbeRefused);
  const allow = (url: string, stagingHost?: string) => expect(() => checkTarget({ target: new URL(url), stagingHost })).not.toThrow();

  it("allows local dev hosts", () => {
    for (const url of ["http://localhost:3000", "http://127.0.0.1:8080", "http://[::1]:3000", "http://app.localhost", "https://shop.test"]) allow(url);
  });
  it("refuses remote, private, and lookalike hosts", () => {
    refuse("https://example.com");
    refuse("http://10.0.0.1");
    refuse("http://0.0.0.0:3000");
    refuse("http://localhost.evil.com");
    refuse("http://user:pw@localhost:3000");
    refuse("file:///etc/passwd");
  });
  it("allows a staging host only when named and labelled", () => {
    allow("https://staging.app.com", "staging.app.com");
    allow("https://api-dev.app.com", "api-dev.app.com");
    refuse("https://staging.app.com");
    refuse("https://staging.app.com", "other.app.com");
    refuse("https://app.com", "app.com");
    refuse("https://www.app.com", "www.app.com");
    refuse("https://staging.com", "staging.com");
  });
  it("refuses the project's homepage", () => refuse("https://staging.app.com", "staging.app.com", "staging.app.com"));
  it("refuses names that resolve off loopback or to metadata addresses", async () => {
    await expect(resolveTarget("localhost", async () => [{ address: "10.0.0.5", family: 4 }])).rejects.toThrow(ProbeRefused);
    await expect(resolveTarget("staging.app.com", async () => [{ address: "169.254.169.254", family: 4 }])).rejects.toThrow(ProbeRefused);
    await expect(resolveTarget("0.0.0.0")).rejects.toThrow(ProbeRefused);
    await expect(resolveTarget("localhost", async () => [{ address: "127.0.0.1", family: 4 }])).resolves.toEqual({ address: "127.0.0.1", family: 4 });
  });
});

/* ---------- planner ---------- */

describe("probe planner", () => {
  const plan = planProbes(buildGraph(), config(), { runId: "abcd1234", accountsConfigured: true });

  it("never plans PUT or DELETE and only safe-listed POSTs", () => {
    const methods = new Set(plan.requests.map((r) => r.method));
    expect(methods.has("PUT" as never)).toBe(false);
    expect(methods.has("DELETE" as never)).toBe(false);
    expect(plan.requests.filter((r) => r.method === "POST").every((r) => r.route === "/api/search")).toBe(true);
    expect(plan.requests.some((r) => r.route === "/api/search" && r.body?.includes("lensprobe"))).toBe(true);
    const skippedRoutes = plan.skipped.map((s) => s.endpointId);
    expect(skippedRoutes).toEqual(expect.arrayContaining([expect.stringContaining("DELETE"), expect.stringContaining("PUT"), expect.stringContaining("/api/upload"), expect.stringContaining("submitForm")]));
    const reasonFor = (needle: string) => plan.skipped.find((x) => x.endpointId.includes(needle))!.reason;
    expect(reasonFor("DELETE")).toBe("DELETE is never sent");
    expect(reasonFor("/api/upload")).toMatch(/safeToProbe/);
  });
  it("plans unauth only for unverified routes and IDOR for configured objects", () => {
    const unauth = plan.requests.filter((r) => r.kind === "unauth").map((r) => r.route);
    expect(unauth).toEqual(expect.arrayContaining(["/api/open", "/api/admin", "/api/search"]));
    expect(unauth).not.toContain("/api/items/:id");
    const idor = plan.requests.filter((r) => r.kind.startsWith("idor"));
    expect(idor.map((r) => [r.path, r.account])).toEqual([["/api/orders/2", "b"], ["/api/orders/2", "a"]]);
  });
  it("caps the plan at maxRequests", () => {
    const capped = planProbes(buildGraph(), config({ maxRequests: 3 }), { runId: "x", accountsConfigured: false });
    expect(capped.requests).toHaveLength(3);
    expect(capped.truncated).toBeGreaterThan(0);
  });
});

/* ---------- client ---------- */

describe("probe client", () => {
  const baseOptions = () => ({ target, pinned, rateLimit: 20, maxRequests: 100, safePosts: new Set<string>(), sleep: noSleep });
  const get = (path: string): PlannedRequest => ({ kind: "headers", method: "GET", path });

  it("refuses requests outside the target, non-read methods, and unlisted POSTs", () => {
    const opts = { target, safePosts: new Set(["POST /api/search"]) };
    expect(() => assertRequestAllowed(get("/"), new URL("http://127.0.0.2/"), opts)).toThrow(ProbeRefused);
    expect(() => assertRequestAllowed({ kind: "unauth", method: "PUT" as never, path: "/x", route: "/x" }, new URL("/x", target), opts)).toThrow(ProbeRefused);
    expect(() => assertRequestAllowed({ kind: "reflect", method: "POST", path: "/api/upload", route: "/api/upload" }, new URL("/api/upload", target), opts)).toThrow(ProbeRefused);
    expect(() => assertRequestAllowed({ kind: "reflect", method: "POST", path: "/api/search", route: "/api/search" }, new URL("/api/search", target), opts)).not.toThrow();
  });
  it("does not follow redirects", async () => {
    hits.length = 0;
    const { exchanges } = await runProbes([get("/redirect")], baseOptions());
    expect(exchanges[0]!.response!.status).toBe(302);
    expect(hits).toHaveLength(1);
  });
  it("paces requests at the rate limit", async () => {
    let clock = 0;
    const sleeps: number[] = [];
    const sleep = async (ms: number) => void (sleeps.push(ms), (clock += ms));
    await runProbes(Array.from({ length: 5 }, () => get("/")), { ...baseOptions(), rateLimit: 5, sleep, now: () => clock });
    expect(sleeps).toEqual([200, 200, 200, 200]);
  });
  it("stops at the request cap and after repeated server errors", async () => {
    const capped = await runProbes(Array.from({ length: 5 }, () => get("/")), { ...baseOptions(), maxRequests: 2 });
    expect(capped.exchanges).toHaveLength(2);
    expect(capped.stoppedReason).toMatch(/cap/);
    const errors = await runProbes(Array.from({ length: 15 }, () => get("/boom")), baseOptions());
    expect(errors.exchanges).toHaveLength(10);
    expect(errors.stoppedReason).toMatch(/server errors/);
  });
  it("picks the address with a listener and refuses when nothing listens", async () => {
    const both: ResolvedAddress[] = [{ address: "::1", family: 6 }, { address: "127.0.0.1", family: 4 }];
    await expect(findListeningAddress(both, target)).resolves.toEqual({ address: "127.0.0.1", family: 4 });
    const closed = await new Promise<number>((resolve) => {
      const probe = http.createServer().listen(0, "127.0.0.1", () => {
        const port = (probe.address() as AddressInfo).port;
        probe.close(() => resolve(port));
      });
    });
    await expect(findListeningAddress(both, new URL(`http://localhost:${closed}`))).rejects.toThrow(/Nothing is listening/);
  });
  it("stops after repeated connection failures", async () => {
    const down = new URL("http://127.0.0.1:1");
    const result = await runProbes(Array.from({ length: 20 }, () => get("/")), { ...baseOptions(), target: down });
    expect(result.exchanges).toHaveLength(5);
    expect(result.stoppedReason).toMatch(/failed connections/);
  });
  it("sends account headers only from the resolved env", async () => {
    expect(() => resolveAccounts(config(), {})).toThrow(/PROBE_A/);
    hits.length = 0;
    await runProbes([{ kind: "idor-swap", method: "GET", path: "/api/orders/2", account: "a" }], { ...baseOptions(), accounts: resolveAccounts(config(), ENV) });
    expect(hits[0]!.headers.authorization).toBe("Bearer token-a");
  });
});

/* ---------- end to end against the fixture ---------- */

describe("probe run against the fixture app", () => {
  async function probe(graph: KnowledgeGraph) {
    const cfg = config();
    const plan = planProbes(graph, cfg, { runId: "e2e00001", accountsConfigured: true });
    const run = await runProbes(plan.requests, { target, pinned, rateLimit: 20, maxRequests: cfg.maxRequests, safePosts: new Set(cfg.safeToProbe), accounts: resolveAccounts(cfg, ENV), sleep: noSleep });
    const evaluation = evaluateExchanges(run.exchanges, { marker: plan.marker, https: false });
    const report = applyProbeResults(graph, evaluation, { readFile: () => "app.get('/');\nserver.listen(3000);\n" });
    return { evaluation, report };
  }

  it("confirms, clears, and adds findings", async () => {
    const graph = buildGraph();
    const { evaluation } = await probe(graph);
    const byId = new Map(graph.security!.findings.map((f) => [f.id, f]));
    const kinds = new Set(evaluation.observations.map((o) => o.kind));
    for (const kind of ["auth-enforced", "auth-missing", "idor", "reflected-xss", "sql-error", "verbose-error", "missing-headers", "cors-reflect"]) expect(kinds).toContain(kind);

    expect(byId.get("F0001")!.status).toBe("false_positive");
    expect(graph.nodes.find((n) => n.endpoint?.route === "/api/admin")!.endpoint!.auth).toBe("guarded");
    expect(byId.get("F0002")!.status).toBe("confirmed");
    expect(byId.get("F0003")!.status).toBe("confirmed");
    // A clean injection probe never clears a static injection finding.
    expect(byId.get("F0004")!.status).toBe("open");

    const dynamic = graph.security!.findings.filter((f) => /^P\d{4}$/.test(f.id));
    const rules = dynamic.map((f) => f.rule);
    expect(rules).toEqual(expect.arrayContaining(["dyn-idor", "dyn-reflected-xss", "dyn-sql-error", "dyn-verbose-error", "dyn-missing-headers", "dyn-cors-reflect"]));
    expect(dynamic.find((f) => f.rule === "dyn-cors-reflect")!.severity).toBe("high");
    expect(dynamic.find((f) => f.rule === "dyn-missing-headers")!.line).toBe(2);
    expect(dynamic.every((f) => f.status === "confirmed")).toBe(true);
    expect(graph.security!.summary.bySeverity.high).toBeGreaterThan(0);
  });

  it("re-runs reuse ids, keep Won't Fix status, and drop fixed issues", async () => {
    const graph = buildGraph();
    await probe(graph);
    const first = graph.security!.findings.filter((f) => /^P\d{4}$/.test(f.id)).map((f) => `${f.id}:${f.rule}`).sort();
    const headers = graph.security!.findings.find((f) => f.rule === "dyn-missing-headers")!;
    headers.status = "accepted";

    const { report } = await probe(graph);
    const second = graph.security!.findings.filter((f) => /^P\d{4}$/.test(f.id)).map((f) => `${f.id}:${f.rule}`).sort();
    expect(second).toEqual(first);
    expect(report.added).toBe(0);
    expect(graph.security!.findings.find((f) => f.rule === "dyn-missing-headers")!.status).toBe("accepted");

    // Simulate the XSS being fixed: the endpoint was checked again with no reflection.
    const xssEndpoint = graph.nodes.find((n) => n.endpoint?.route === "/search")!.id;
    const fixedRun = applyProbeResults(graph, { observations: [], covered: new Set([`reflected-xss|${xssEndpoint}`]) });
    expect(fixedRun.removed).toBe(1);
    expect(graph.security!.findings.some((f) => f.rule === "dyn-reflected-xss")).toBe(false);
    expect(graph.security!.findings.some((f) => f.rule === "dyn-idor")).toBe(true);
  });
});
