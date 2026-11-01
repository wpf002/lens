/**
 * Entry point + auth guard detection across common web frameworks.
 * Produces route records tied to handler symbols so reachability can start there.
 */
import type { EndpointMeta } from "../types.js";
import type { SymbolInfo } from "../extract.js";

export interface EntryPoint {
  method: string;
  route: string;
  line: number;
  framework: string;
  entryType: EndpointMeta["entryType"];
  /** Qualified symbol name of the handler, when resolvable. */
  handler?: string;
  auth: EndpointMeta["auth"];
  authEvidence?: string;
  /** Middleware identifiers applied inline before the handler. */
  middleware?: string[];
}

/** Router mounts: app.use("/users", userRoutes) or app.use("/admin", requireAuth, adminRoutes). */
export interface Mount {
  prefix: string;
  target: string;
  line: number;
  guarded?: string;
}

export function detectMounts(src: string): Mount[] {
  const out: Mount[] = [];
  src.split("\n").forEach((l, i) => {
    const m = /\.(?:use|register|route)\s*\(\s*["'`](\/[^"'`]*)["'`]\s*,\s*(.+?)\)\s*;?\s*$/.exec(l);
    if (!m) return;
    const args = m[2]!.split(",").map((x) => x.trim()).filter(Boolean);
    const target = args[args.length - 1]!.replace(/\(.*$/, "").replace(/^.*\./, "");
    if (!/^[A-Za-z_$][\w$]*$/.test(target)) return;
    const mw = args.slice(0, -1).join(",");
    out.push({ prefix: m[1]!, target, line: i + 1, guarded: AUTH_TOKEN_RE.test(mw) ? `mounted with ${mw.slice(0, 80)} (line ${i + 1})` : undefined });
  });
  return out;
}

export const AUTH_TOKEN_RE =
  /\b(?:auth\w*|requireAuth|requireUser|requireLogin|ensureAuth\w*|isAuthenticated|authenticated|authenticate\w*|verifyToken|verifyJwt|jwtAuth|checkJwt|passport\.authenticate|protect(?:ed)?|guard|withAuth|withSession|login_required|permission_required|user_passes_test|permission_classes|IsAuthenticated|Depends\(\s*(?:get_current_\w+|current_user|verify_\w+|auth\w*)|Security\(|@PreAuthorize|@Secured|@RolesAllowed|UseGuards|AuthGuard|authenticate_user!|require_login|before_action\s+:(?:authenticate|require|authorize)\w*|middleware\(\s*['"\[]*auth|clerkMiddleware|getServerSession|currentUser|requireSession|session\.user|req\.user\b|request\.user\.is_authenticated|\[Authorize\])/;

const PUBLIC_ROUTE_RE =
  /(?:^|\/)(?:health\w*|healthz|readyz|livez|status|ping|version|metrics|login|logout|signin|signup|sign-in|sign-up|register|forgot\w*|reset\w*|verify-email|callback|oauth|auth|public|static|assets|docs|openapi|swagger|favicon\.ico|robots\.txt|sitemap\w*|\.well-known)(?:$|\/|\.)/i;

const HTTP_METHODS = "get|post|put|patch|delete|head|options|all|any";

interface Ctx {
  path: string;
  lang: string;
  src: string;
  lines: string[];
  symbols: SymbolInfo[];
}

function symbolAt(ctx: Ctx, line: number, after = 0): SymbolInfo | undefined {
  // Innermost function containing the line, or the first function starting within `after` lines below.
  const containing = ctx.symbols.filter((s) => s.kind === "function" && s.lines[0] <= line && s.lines[1] >= line).sort((a, b) => b.lines[0] - a.lines[0])[0];
  if (containing && after === 0) return containing;
  const below = ctx.symbols.find((s) => s.kind === "function" && s.lines[0] >= line && s.lines[0] <= line + after);
  return below ?? containing;
}

const qname = (s: SymbolInfo | undefined) => (s ? (s.owner ? `${s.owner}.${s.name}` : s.name) : undefined);

/** File-level middleware (router.use(auth), app.addHook('onRequest', ...), before_action). */
function fileLevelGuard(ctx: Ctx, uptoLine: number): string | undefined {
  for (let i = 0; i < Math.min(uptoLine, ctx.lines.length); i++) {
    const l = ctx.lines[i]!;
    if (/\.(?:use|addHook|register|before_action|middleware)\s*\(|before_action|@UseGuards|\[Authorize\]|permission_classes|dependencies\s*=\s*\[/.test(l) && AUTH_TOKEN_RE.test(l)) {
      return `line ${i + 1}: ${l.trim().slice(0, 100)}`;
    }
  }
  return undefined;
}

function handlerGuard(ctx: Ctx, h: SymbolInfo | undefined): string | undefined {
  if (!h) return undefined;
  const body = ctx.lines.slice(h.lines[0] - 1, Math.min(h.lines[1], h.lines[0] + 25));
  for (let i = 0; i < body.length; i++) {
    const l = body[i]!;
    if (/\b(?:getServerSession|auth\(\)|currentUser\(|requireUser\(|requireAuth\(|verifyToken\(|getUser\(|getSession\(|validateSession\(|if\s*\(\s*!\s*(?:req\.user|session|user)\b|request\.user\.is_authenticated|abort\(\s*401|status\(\s*401|Unauthorized|HTTPException\(\s*status_code\s*=\s*401|throw\s+new\s+UnauthorizedException)/.test(l)) {
      return `handler line ${h.lines[0] + i}: ${l.trim().slice(0, 100)}`;
    }
  }
  for (const d of h.decorators) if (AUTH_TOKEN_RE.test(d)) return `decorator ${d}`;
  if (h.params.some((p) => /current_user|user\s*=\s*Depends|principal|Authentication/i.test(p))) return "handler takes an authenticated principal";
  if (AUTH_TOKEN_RE.test(h.signature)) return `signature: ${h.signature.slice(0, 100)}`;
  return undefined;
}

function classifyAuth(ctx: Ctx, route: string, line: string, lineNo: number, h: SymbolInfo | undefined): Pick<EntryPoint, "auth" | "authEvidence"> {
  // Strip the route literal so "/auth/login" doesn't count as an auth middleware.
  const inline = line.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, "''");
  if (AUTH_TOKEN_RE.test(inline)) return { auth: "guarded", authEvidence: `inline: ${line.trim().slice(0, 100)}` };
  const hg = handlerGuard(ctx, h);
  if (hg) return { auth: "guarded", authEvidence: hg };
  const fg = fileLevelGuard(ctx, lineNo);
  if (fg) return { auth: "guarded", authEvidence: `file middleware ${fg}` };
  if (PUBLIC_ROUTE_RE.test(route)) return { auth: "public", authEvidence: "route name suggests a public endpoint" };
  return { auth: "unguarded" };
}

function entryTypeFor(route: string): EntryPoint["entryType"] {
  // A bare `/events` path is usually a first-party beacon; only count it under a provider name.
  return /webhook|hook\b|stripe|github\/?$|callback|(?:slack|twilio|shopify|svix|clerk|paddle)\b.*\/events?$/i.test(route) ? "webhook" : "http";
}

export function detectEntryPoints(ctx: Ctx, frameworks: string[]): EntryPoint[] {
  const out: EntryPoint[] = [];
  const { lines, path, lang } = ctx;
  const push = (e: Omit<EntryPoint, "auth" | "authEvidence" | "entryType"> & { entryType?: EntryPoint["entryType"] }, rawLine: string, h: SymbolInfo | undefined) => {
    const a = classifyAuth(ctx, e.route, rawLine, e.line, h);
    out.push({ ...e, entryType: e.entryType ?? entryTypeFor(e.route), handler: e.handler ?? qname(h), ...a });
  };
  const isJs = lang === "typescript" || lang === "javascript";

  /* ---- JS/TS ---- */
  if (isJs) {
    // Next.js app router: app/**/route.ts exports GET/POST...
    const appRoute = /(?:^|\/)app\/(.*?)\/?route\.(?:ts|js|tsx|jsx|mts|mjs)$/.exec(path);
    if (appRoute) {
      const route = "/" + appRoute[1]!.replace(/\([^)]*\)\/?/g, "").replace(/\[\.\.\.(\w+)\]/g, ":$1*").replace(/\[(\w+)\]/g, ":$1").replace(/\/$/, "");
      for (const s of ctx.symbols) {
        if (!s.owner && /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(s.name) && s.exported) {
          push({ method: s.name, route: route === "/" ? "/" : route, line: s.lines[0], framework: "next", handler: s.name }, lines[s.lines[0] - 1] ?? "", s);
        }
      }
      for (const m of ctx.src.matchAll(/export\s+const\s+(GET|POST|PUT|PATCH|DELETE)\s*=/g)) {
        const ln = ctx.src.slice(0, m.index).split("\n").length;
        if (!out.some((e) => e.method === m[1])) push({ method: m[1]!, route, line: ln, framework: "next", handler: m[1]! }, lines[ln - 1] ?? "", symbolAt(ctx, ln));
      }
    }
    // Next.js pages/api
    const pagesApi = /(?:^|\/)pages\/api\/(.+)\.(?:ts|js)$/.exec(path);
    if (pagesApi) {
      const route = "/api/" + pagesApi[1]!.replace(/\/index$/, "").replace(/\[(\w+)\]/g, ":$1");
      const def = ctx.symbols.find((s) => s.exported && !s.owner && s.kind === "function") ?? ctx.symbols.find((s) => s.kind === "function");
      push({ method: "ANY", route, line: def?.lines[0] ?? 1, framework: "next", handler: qname(def) }, lines[(def?.lines[0] ?? 1) - 1] ?? "", def);
    }
    // Server actions
    if (/^\s*["']use server["']/m.test(ctx.src.slice(0, 200))) {
      for (const s of ctx.symbols) if (s.exported && !s.owner && s.kind === "function") {
        push({ method: "POST", route: `action:${s.name}`, line: s.lines[0], framework: "next", entryType: "server-action", handler: s.name }, lines[s.lines[0] - 1] ?? "", s);
      }
    }
    // Express / Fastify / Koa-router / Hono / Elysia style
    const re = new RegExp(`\\b(\\w+)\\.(${HTTP_METHODS})\\s*\\(\\s*(["'\`])([^"'\`]*)\\3`, "i");
    lines.forEach((l, i) => {
      const m = re.exec(l);
      if (!m) return;
      const obj = m[1]!;
      if (!/^(app|router|server|fastify|api|r|route|routes|v\d|hono|elysia|instance|koa|express|\w*[Rr]outer|\w*[Aa]pp)$/.test(obj)) return;
      const route = m[4]!;
      if (route && !route.startsWith("/") && route !== "*") return;
      // handler: last identifier argument on the line, or an inline function starting here
      const argText = l.slice(m.index + m[0].length);
      const ids = [...argText.matchAll(/,\s*([A-Za-z_$][\w$.]*)\s*(?=[,)])/g)].map((x) => x[1]!.split(".").pop()!);
      const inline = /=>|\bfunction\b/.test(argText);
      const named = inline ? undefined : ids[ids.length - 1];
      const middleware = inline ? ids : ids.slice(0, -1);
      const inlineName = `${m[2]!.toUpperCase()} ${route}`;
      const h = (named && ctx.symbols.find((s) => s.name === named && s.kind === "function")) || ctx.symbols.find((s) => s.name === inlineName && s.lines[0] === i + 1) || symbolAt(ctx, i + 1, 1);
      push({ method: m[2]!.toUpperCase(), route: route || "/", line: i + 1, framework: frameworks.find((f) => /express|fastify|koa|hono|elysia/i.test(f)) ?? "express-like", handler: named ?? qname(h), middleware }, l, h);
    });
    // fastify.route({ method, url })
    for (const m of ctx.src.matchAll(/\.route\s*\(\s*\{[^}]*?method\s*:\s*\[?\s*["'](\w+)["'][^}]*?url\s*:\s*["']([^"']+)["']/gs)) {
      const ln = ctx.src.slice(0, m.index).split("\n").length;
      push({ method: m[1]!.toUpperCase(), route: m[2]!, line: ln, framework: "fastify" }, lines[ln - 1] ?? "", symbolAt(ctx, ln, 3));
    }
    // NestJS decorators
    let controllerBase = "";
    lines.forEach((l, i) => {
      const c = /@Controller\s*\(\s*["']([^"']*)["']/.exec(l);
      if (c) controllerBase = "/" + c[1]!.replace(/^\//, "");
      const d = /@(Get|Post|Put|Patch|Delete|All)\s*\(\s*(?:["']([^"']*)["'])?/.exec(l);
      if (d) {
        const h = symbolAt(ctx, i + 1, 6);
        const decoStack = lines.slice(Math.max(0, i - 4), i + 3).join(" ");
        const route = (controllerBase + "/" + (d[2] ?? "")).replace(/\/+/g, "/").replace(/\/$/, "") || "/";
        push({ method: d[1]!.toUpperCase(), route, line: i + 1, framework: "nest" }, decoStack, h);
      }
    });
  }

  /* ---- Python ---- */
  if (lang === "python") {
    lines.forEach((l, i) => {
      const flask = /@(\w+)\.(route|get|post|put|patch|delete|api_route|websocket)\s*\(\s*["']([^"']*)["'](.*)$/.exec(l);
      if (flask) {
        const methods = /methods\s*=\s*\[([^\]]+)\]/.exec(flask[4]!)?.[1]?.replace(/["'\s]/g, "") ?? (flask[2] === "route" || flask[2] === "api_route" ? "GET" : flask[2]!.toUpperCase());
        const h = symbolAt(ctx, i + 1, 8);
        const stack = lines.slice(i, Math.min(lines.length, i + 6)).join(" ");
        push({ method: methods.toUpperCase(), route: flask[3]!, line: i + 1, framework: frameworks.find((f) => /fastapi|flask|starlette|sanic|quart/i.test(f)) ?? "flask-like", entryType: flask[2] === "websocket" ? "rpc" : undefined }, stack, h);
      }
      const dj = /^\s*(?:re_)?path\s*\(\s*r?["']([^"']*)["']\s*,\s*([\w.]+)/.exec(l);
      if (dj && /urls\.py$/.test(path)) {
        push({ method: "ANY", route: "/" + dj[1]!, line: i + 1, framework: "django", handler: dj[2]!.replace(/\.as_view$/, "").split(".").pop() }, l, undefined);
        // Django view guard lives in the view file; mark unknown rather than unguarded.
        const last = out[out.length - 1]!;
        if (last.auth === "unguarded") last.auth = "unknown";
      }
    });
    // Lambda handlers
    for (const s of ctx.symbols) if (!s.owner && /^(lambda_handler|handler)$/.test(s.name) && s.params.length >= 2) {
      push({ method: "EVENT", route: `lambda:${path}`, line: s.lines[0], framework: "aws-lambda", entryType: "event" }, "", s);
    }
  }

  /* ---- Go ---- */
  if (lang === "go") {
    lines.forEach((l, i) => {
      const std = /\b(?:http|mux|\w*[Mm]ux|router|r)\.(?:HandleFunc|Handle)\s*\(\s*"([^"]+)"\s*,\s*([\w.]+)/.exec(l);
      const gin = /\b(\w+)\.(GET|POST|PUT|PATCH|DELETE|Any|Handle)\s*\(\s*"([^"]+)"\s*,\s*(.*)\)/.exec(l);
      if (std) {
        const route = std[1]!.replace(/^(GET|POST|PUT|PATCH|DELETE)\s+/, "");
        const method = /^(GET|POST|PUT|PATCH|DELETE)\s/.exec(std[1]!)?.[1] ?? "ANY";
        const hn = std[2]!.split(".").pop()!;
        push({ method, route, line: i + 1, framework: "net/http", handler: hn }, l, ctx.symbols.find((s) => s.name === hn));
      } else if (gin) {
        const args = gin[4]!.split(",").map((x) => x.trim());
        const hn = args[args.length - 1]!.split(".").pop()!.replace(/\(.*$/, "");
        push({ method: gin[2]!.toUpperCase(), route: gin[3]!, line: i + 1, framework: frameworks.find((f) => /gin|echo|fiber|chi/i.test(f)) ?? "gin-like", handler: hn }, l, ctx.symbols.find((s) => s.name === hn));
      }
    });
  }

  /* ---- Java / Kotlin (Spring, JAX-RS) ---- */
  if (lang === "java" || lang === "kotlin") {
    let base = "";
    lines.forEach((l, i) => {
      const rm = /@RequestMapping\s*\(\s*(?:value\s*=\s*|path\s*=\s*)?["']([^"']+)["']/.exec(l);
      const isClassLevel = rm && lines.slice(i + 1, i + 4).some((x) => /\b(class|interface)\b/.test(x));
      if (rm && isClassLevel) {
        base = rm[1]!;
        return;
      }
      const m = /@(Get|Post|Put|Patch|Delete|Request)Mapping\s*(?:\(\s*(?:value\s*=\s*|path\s*=\s*)?["']?([^"')]*)["']?)?/.exec(l);
      const jax = /@(GET|POST|PUT|DELETE|PATCH)\b/.exec(l);
      if (m || jax) {
        const h = symbolAt(ctx, i + 1, 6);
        const stack = lines.slice(Math.max(0, i - 3), i + 4).join(" ");
        const pathAnn = jax ? /@Path\s*\(\s*"([^"]+)"/.exec(lines.slice(i - 2, i + 3).join(" "))?.[1] ?? "" : m?.[2] ?? "";
        const method = jax ? jax[1]! : m![1] === "Request" ? "ANY" : m![1]!.toUpperCase();
        push({ method, route: (base + "/" + pathAnn).replace(/\/+/g, "/"), line: i + 1, framework: jax ? "jax-rs" : "spring" }, stack, h);
      }
    });
  }

  /* ---- Ruby (Rails routes, Sinatra) ---- */
  if (lang === "ruby") {
    lines.forEach((l, i) => {
      const sin = /^\s*(get|post|put|patch|delete)\s+["']([^"']+)["']\s*(?:,\s*to:\s*["']([^"']+)["'])?/.exec(l);
      if (sin) push({ method: sin[1]!.toUpperCase(), route: sin[2]!, line: i + 1, framework: /routes\.rb$/.test(path) ? "rails" : "sinatra", handler: sin[3] }, l, symbolAt(ctx, i + 1));
      const res = /^\s*resources?\s+:(\w+)/.exec(l);
      if (res && /routes\.rb$/.test(path)) {
        push({ method: "ANY", route: `/${res[1]}`, line: i + 1, framework: "rails", handler: `${res[1]}#*` }, l, undefined);
        const last = out[out.length - 1]!;
        if (last.auth === "unguarded") last.auth = "unknown";
      }
    });
  }

  /* ---- PHP (Laravel) ---- */
  if (lang === "php") {
    lines.forEach((l, i) => {
      const m = /Route::(get|post|put|patch|delete|any|match)\s*\(\s*["']([^"']+)["']/.exec(l);
      if (m) push({ method: m[1]!.toUpperCase(), route: m[2]!.startsWith("/") ? m[2]! : "/" + m[2], line: i + 1, framework: "laravel" }, l + (lines[i + 1] ?? ""), undefined);
    });
  }

  /* ---- C# (ASP.NET) ---- */
  if (lang === "csharp") {
    lines.forEach((l, i) => {
      const m = /\[Http(Get|Post|Put|Patch|Delete)(?:\(\s*"([^"]*)"\s*\))?\]/.exec(l) ?? /\.Map(Get|Post|Put|Patch|Delete)\s*\(\s*"([^"]+)"/.exec(l);
      if (m) push({ method: m[1]!.toUpperCase(), route: "/" + (m[2] ?? "").replace(/^\//, ""), line: i + 1, framework: "aspnet" }, lines.slice(Math.max(0, i - 3), i + 2).join(" "), symbolAt(ctx, i + 1, 4));
    });
  }

  /* ---- CLI / scheduled entry points (all languages) ---- */
  if (/(^|\/)(cli|bin|cmd|commands?)\/|(?:^|\/)(main|cli|__main__)\.\w+$/.test(path) && /process\.argv|argparse|click\.|typer\.|commander|yargs|cobra|flag\.Parse|clap::|OptionParser|sys\.argv/.test(ctx.src)) {
    const main = ctx.symbols.find((s) => /^(main|run|cli)$/.test(s.name));
    out.push({ method: "CLI", route: `cli:${path}`, line: main?.lines[0] ?? 1, framework: "cli", entryType: "cli", handler: qname(main), auth: "public", authEvidence: "local CLI invocation" });
  }
  for (const m of ctx.src.matchAll(/(?:@Cron\s*\(\s*["']([^"']+)|cron\.schedule\s*\(\s*["']([^"']+)|@(?:app\.)?(?:task|periodic_task|shared_task)\b|schedule\.every\(|new\s+CronJob\s*\(\s*["']([^"']+))/g)) {
    const ln = ctx.src.slice(0, m.index).split("\n").length;
    const h = symbolAt(ctx, ln, 4);
    out.push({ method: "CRON", route: `cron:${m[1] ?? m[2] ?? m[3] ?? qname(h) ?? path}`, line: ln, framework: "scheduler", entryType: "cron", handler: qname(h), auth: "public", authEvidence: "internal scheduler" });
  }
  // Dedupe (same method+route+line)
  const seen = new Set<string>();
  return out.filter((e) => {
    const k = `${e.method} ${e.route} ${e.line}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
