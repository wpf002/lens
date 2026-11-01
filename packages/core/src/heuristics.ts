/** No-LLM defaults: layers, summaries, complexity, frameworks, tour. */
import type { Complexity, GraphNode, KnowledgeGraph, Layer, TourStep } from "./types.js";
import { indexGraph } from "./graph-utils.js";
import { isTestPath } from "./languages.js";

export const LAYER_DEFS: Array<Omit<Layer, "nodeIds"> & { match: RegExp }> = [
  { id: "ui", name: "UI", rank: 0, color: "#c084fc", description: "Components, pages, views, styles: what the user sees.",
    match: /(^|\/)(components?|pages|views?|screens?|ui|frontend|web|client|widgets|layouts?|templates|styles|public|app\/(?!api\/)|src\/app\/(?!api\/)|hooks)\/|\.(tsx|jsx|vue|svelte|css|scss|html)$/ },
  { id: "api", name: "API", rank: 1, color: "#60a5fa", description: "Routes, controllers, handlers, resolvers: the request boundary.",
    match: /(^|\/)(routes?|routers?|controllers?|handlers?|api|endpoints?|resolvers?|rest|graphql|rpc|grpc|server|middlewares?|views\.py$|urls\.py$)(\/|$)|(^|\/)route\.(ts|js)$|_handler\.|Controller\.|\.controller\./ },
  { id: "service", name: "Service", rank: 2, color: "#34d399", description: "Business logic, use cases, orchestration, background jobs.",
    match: /(^|\/)(services?|use-?cases?|domain|core|business|logic|workers?|jobs?|tasks?|queues?|engine|pipeline|agents?|features?|modules?|actions?|commands?|processors?)(\/|$)|Service\.|\.service\./ },
  { id: "data", name: "Data", rank: 3, color: "#fbbf24", description: "Models, schemas, repositories, migrations, DB access.",
    match: /(^|\/)(models?|db|database|repositor(y|ies)|repos?|schemas?|migrations?|entities|entity|prisma|sql|dao|stores?|persistence|orm|seeds?)(\/|$)|\.(sql|prisma)$|Repository\.|\.model\.|\.entity\./ },
  { id: "utility", name: "Utility", rank: 4, color: "#94a3b8", description: "Shared helpers, types, constants, cross-cutting libraries.",
    match: /(^|\/)(utils?|utilities|helpers?|common|shared|lib|libs|types?|constants?|internal|pkg|support|tools?)(\/|$)|\.(d\.ts)$/ },
  { id: "infra", name: "Infra", rank: 5, color: "#f472b6", description: "Containers, CI/CD, IaC, deploy and build scripts.",
    match: /(^|\/)(\.github|\.gitlab|\.circleci|docker|deploy|deployment|infra|infrastructure|terraform|k8s|kubernetes|helm|charts|ops|scripts|bin|ci)(\/|$)|(^|\/)(Dockerfile[^/]*|docker-compose[^/]*|Makefile|Procfile|Jenkinsfile|[^/]+\.tf)$/ },
  { id: "config", name: "Config", rank: 6, color: "#22d3ee", description: "Project, build, and runtime configuration.",
    match: /(^|\/)(config|configs|settings|conf)(\/|$)|(^|\/)(package\.json|tsconfig[^/]*|pyproject\.toml|Cargo\.toml|go\.mod|\.env[^/]*|[^/]+\.config\.(js|ts|mjs|cjs)|[^/]+rc(\.json|\.js)?)$/ },
  { id: "test", name: "Test", rank: 7, color: "#a3a3a3", description: "Tests, fixtures, and test utilities.", match: /$^/ },
  { id: "docs", name: "Docs", rank: 8, color: "#e8e6e3", description: "Documentation and guides.", match: /\.(md|mdx|rst|txt)$/ },
];

export function heuristicLayer(n: GraphNode): string {
  const p = n.path ?? "";
  if (n.kind === "document") return "docs";
  if (isTestPath(p)) return "test";
  if (n.kind === "pipeline" || n.kind === "service" || n.kind === "resource") return "infra";
  if (n.kind === "config") return "config";
  if (n.kind === "schema" || n.kind === "table") return "data";
  if (n.tags.includes("has-routes")) return "api";
  // Most specific directory match wins: check the deepest directory segment first.
  const segs = p.split("/");
  for (let depth = segs.length - 1; depth >= 0; depth--) {
    const sub = segs.slice(depth).join("/");
    for (const L of LAYER_DEFS) if (L.match.test(sub) && L.id !== "docs") return L.id;
  }
  return "service";
}

export function buildHeuristicLayers(nodes: GraphNode[]): Layer[] {
  const byLayer = new Map<string, string[]>();
  for (const n of nodes) {
    if (!n.path || !isFileKind(n)) continue;
    const l = n.layer ?? heuristicLayer(n);
    n.layer = l;
    (byLayer.get(l) ?? byLayer.set(l, []).get(l)!).push(n.id);
  }
  return LAYER_DEFS.filter((d) => byLayer.has(d.id)).map(({ match: _m, ...d }) => ({ ...d, nodeIds: byLayer.get(d.id)! }));
}

export function isFileKind(n: Pick<GraphNode, "kind">): boolean {
  return n.kind === "file" || n.kind === "config" || n.kind === "document" || n.kind === "service" || n.kind === "pipeline" || n.kind === "schema" || n.kind === "resource";
}

export function fileComplexity(loc: number, branches: number): Complexity {
  const score = loc / 150 + branches / 25;
  return score < 0.8 ? "simple" : score < 2.5 ? "moderate" : "complex";
}

export function functionComplexity(branches: number, loc: number): Complexity {
  if (branches <= 3 && loc < 40) return "simple";
  if (branches <= 10 && loc < 120) return "moderate";
  return "complex";
}

/* ---------------- frameworks ---------------- */

const FRAMEWORK_DEPS: Record<string, string> = {
  next: "Next.js", react: "React", vue: "Vue", nuxt: "Nuxt", svelte: "Svelte", "@sveltejs/kit": "SvelteKit", "@angular/core": "Angular",
  express: "Express", fastify: "Fastify", koa: "Koa", hono: "Hono", "@nestjs/core": "NestJS", elysia: "Elysia", "@trpc/server": "tRPC",
  prisma: "Prisma", "@prisma/client": "Prisma", "drizzle-orm": "Drizzle", typeorm: "TypeORM", sequelize: "Sequelize", mongoose: "Mongoose",
  "@remix-run/node": "Remix", astro: "Astro", electron: "Electron", "react-native": "React Native", expo: "Expo", vite: "Vite",
  tailwindcss: "Tailwind", zod: "Zod", graphql: "GraphQL", "socket.io": "Socket.IO", bullmq: "BullMQ", stripe: "Stripe",
  django: "Django", flask: "Flask", fastapi: "FastAPI", starlette: "Starlette", sqlalchemy: "SQLAlchemy", celery: "Celery", pydantic: "Pydantic",
  torch: "PyTorch", tensorflow: "TensorFlow", pandas: "pandas", numpy: "NumPy", langchain: "LangChain", "scikit-learn": "scikit-learn",
  "github.com/gin-gonic/gin": "Gin", "github.com/labstack/echo/v4": "Echo", "github.com/gofiber/fiber/v2": "Fiber", "github.com/go-chi/chi/v5": "chi",
  "gorm.io/gorm": "GORM", actix_web: "Actix", "actix-web": "Actix", axum: "Axum", rocket: "Rocket", tokio: "Tokio", serde: "Serde",
  rails: "Rails", sinatra: "Sinatra", "laravel/framework": "Laravel", "symfony/symfony": "Symfony",
};

export function detectFrameworks(deps: Record<string, string>, files: string[]): string[] {
  const out = new Set<string>();
  for (const d of Object.keys(deps)) {
    const f = FRAMEWORK_DEPS[d] ?? FRAMEWORK_DEPS[d.toLowerCase()];
    if (f) out.add(f);
  }
  if (files.some((f) => /(^|\/)manage\.py$/.test(f))) out.add("Django");
  if (files.some((f) => /(^|\/)config\/routes\.rb$/.test(f))) out.add("Rails");
  if (files.some((f) => /(^|\/)artisan$/.test(f))) out.add("Laravel");
  if (files.some((f) => /pom\.xml$|build\.gradle/.test(f)) && files.some((f) => /Application\.(java|kt)$/.test(f))) out.add("Spring");
  if (files.some((f) => /(^|\/)Dockerfile/.test(f))) out.add("Docker");
  if (files.some((f) => /\.tf$/.test(f))) out.add("Terraform");
  return [...out].sort();
}

/* ---------------- tour ---------------- */

/** PageRank over file-level edges; used for tour and "important files" ranking. */
export function fileRank(graph: Pick<KnowledgeGraph, "nodes" | "edges">): Map<string, number> {
  const files = graph.nodes.filter((n) => isFileKind(n));
  const ids = new Set(files.map((f) => f.id));
  const idx = indexGraph(graph);
  const owner = (id: string): string | undefined => {
    let cur: string | undefined = id;
    for (let i = 0; cur && i < 6; i++) {
      if (ids.has(cur)) return cur;
      cur = idx.parent.get(cur);
    }
    return undefined;
  };
  const out = new Map<string, Set<string>>();
  for (const e of graph.edges) {
    if (e.kind === "contains" || e.kind === "tested_by" || e.kind === "documents") continue;
    const s = owner(e.source);
    const t = owner(e.target);
    if (s && t && s !== t) (out.get(s) ?? out.set(s, new Set()).get(s)!).add(t);
  }
  const N = Math.max(ids.size, 1);
  let rank = new Map([...ids].map((id) => [id, 1 / N]));
  for (let it = 0; it < 25; it++) {
    const next = new Map([...ids].map((id) => [id, 0.15 / N]));
    let dangling = 0;
    for (const id of ids) {
      const targets = out.get(id);
      const r = rank.get(id)!;
      if (!targets?.size) {
        dangling += r;
        continue;
      }
      for (const t of targets) next.set(t, next.get(t)! + (0.85 * r) / targets.size);
    }
    for (const id of ids) next.set(id, next.get(id)! + (0.85 * dangling) / N);
    rank = next;
  }
  return rank;
}

const ENTRY_RE = /(^|\/)(src\/)?(index|main|app|server|cli|__main__|manage|wsgi|asgi|program|Application)\.[a-z]+$|(^|\/)cmd\/[^/]+\/main\.go$|(^|\/)src\/(main|lib)\.rs$/i;

export function buildHeuristicTour(graph: Pick<KnowledgeGraph, "nodes" | "edges" | "layers">): TourStep[] {
  const rank = fileRank(graph);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const steps: TourStep[] = [];
  const used = new Set<string>();
  const add = (title: string, description: string, ids: string[], lesson?: string) => {
    const fresh = ids.filter((i) => byId.has(i) && !used.has(i)).slice(0, 5);
    if (!fresh.length) return;
    fresh.forEach((i) => used.add(i));
    steps.push({ order: steps.length + 1, title, description, nodeIds: fresh, lesson });
  };
  const files = graph.nodes.filter((n) => isFileKind(n) && !isTestPath(n.path ?? ""));
  const readme = files.filter((n) => n.kind === "document" && /(^|\/)readme\.(md|rst|txt)$/i.test(n.path!)).sort((a, b) => a.path!.length - b.path!.length);
  const manifests = files.filter((n) => /(^|\/)(package\.json|pyproject\.toml|Cargo\.toml|go\.mod|pom\.xml|build\.gradle|Gemfile|composer\.json)$/.test(n.path!)).sort((a, b) => a.path!.length - b.path!.length);
  add("Start here", "What the project is and how it is packaged. Read the README first, then the manifest for dependencies and scripts.", [...readme.slice(0, 1), ...manifests.slice(0, 2)].map((n) => n.id));

  const entries = files.filter((n) => n.kind === "file" && ENTRY_RE.test(n.path!)).sort((a, b) => (rank.get(b.id) ?? 0) - (rank.get(a.id) ?? 0) || a.path!.length - b.path!.length);
  add("Entry points", "Where execution starts. Everything else is reached from these files.", entries.slice(0, 3).map((n) => n.id));

  const endpoints = graph.nodes.filter((n) => n.kind === "endpoint");
  if (endpoints.length) {
    const routeFiles = [...new Set(endpoints.map((e) => graph.nodes.find((f) => f.path === e.path && isFileKind(f))?.id).filter(Boolean) as string[])];
    routeFiles.sort((a, b) => (rank.get(b) ?? 0) - (rank.get(a) ?? 0));
    add("The request boundary", `${endpoints.length} routes are exposed. These files map URLs to handlers.`, routeFiles.slice(0, 4));
  }

  const order = [...graph.layers].sort((a, b) => a.rank - b.rank).filter((l) => !["test", "docs", "config", "infra"].includes(l.id));
  for (const L of order) {
    const top = L.nodeIds.filter((id) => byId.get(id)?.kind === "file").sort((a, b) => (rank.get(b) ?? 0) - (rank.get(a) ?? 0));
    add(`${L.name} layer`, `${L.description} The most depended-on files here are shown first.`, top.slice(0, 4));
  }
  const infra = files.filter((n) => n.layer === "infra" || n.layer === "config").sort((a, b) => (rank.get(b.id) ?? 0) - (rank.get(a.id) ?? 0));
  add("Build, config, and deploy", "How the project is configured, built, and shipped.", infra.slice(0, 4).map((n) => n.id));
  return steps.slice(0, 10);
}

/* ---------------- summaries ---------------- */

export function listPreview(items: string[], max = 4): string {
  if (!items.length) return "";
  return items.slice(0, max).join(", ") + (items.length > max ? ` and ${items.length - max} more` : "");
}
