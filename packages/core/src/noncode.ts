/**
 * Parsers for non-code files: manifests, containers, CI, schemas, infra, docs.
 * Each returns child entities and references that the graph builder turns into
 * nodes and edges. Regex/YAML based on purpose: these formats are small and
 * shallow, and a failed parse must never abort a scan.
 */
import YAML from "yaml";

export interface ChildEntity {
  kind: "table" | "endpoint" | "service" | "resource" | "step" | "section" | "schema";
  name: string;
  lines: [number, number];
  summary: string;
  tags?: string[];
  fields?: string[];
  method?: string;
  route?: string;
}

export interface NonCodeRef {
  /** Path-like target, resolved against the file's directory, or a symbolic name. */
  target: string;
  kind: "file" | "service" | "image" | "table" | "url";
  edge: "configures" | "deploys" | "documents" | "depends_on" | "triggers" | "migrates" | "reads_from" | "provisions";
  line?: number;
}

export interface NonCodeInfo {
  summary?: string;
  children: ChildEntity[];
  refs: NonCodeRef[];
  tags: string[];
  /** Declared package dependencies (name → version). */
  dependencies?: Record<string, string>;
  ecosystem?: "npm" | "PyPI" | "Go" | "crates.io" | "RubyGems" | "Maven" | "Packagist";
  /** For markdown: headings. */
  headings?: string[];
  links?: string[];
  wikilinks?: string[];
  frontmatter?: Record<string, string>;
  /** Env var names defined (never values). */
  envKeys?: string[];
}

const lineOf = (src: string, idx: number) => src.slice(0, idx).split("\n").length;

function blockEnd(src: string, startIdx: number): number {
  // brace-matched block end starting at first "{" after startIdx
  const open = src.indexOf("{", startIdx);
  if (open < 0) return lineOf(src, startIdx);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return lineOf(src, i);
  }
  return lineOf(src, src.length);
}

export function parseNonCode(path: string, lang: string, src: string): NonCodeInfo {
  try {
    switch (lang) {
      case "json": return path.endsWith("package.json") ? packageJson(src) : jsonFile(path, src);
      case "dockerfile": return dockerfile(src);
      case "docker-compose": return compose(src);
      case "github-actions": return ghActions(src);
      case "kubernetes": return k8s(src);
      case "yaml": return yamlFile(path, src);
      case "prisma": return prisma(src);
      case "sql": return sql(path, src);
      case "graphql": return graphql(src);
      case "protobuf": return protobuf(src);
      case "terraform": return terraform(src);
      case "markdown": return markdown(src);
      case "env": return envFile(src);
      case "toml": return toml(path, src);
      case "requirements": return requirements(src);
      case "gomod": return gomod(src);
      case "makefile": return makefile(src);
      case "procfile": return procfile(src);
      default: return { children: [], refs: [], tags: [] };
    }
  } catch {
    return { children: [], refs: [], tags: ["parse-error"] };
  }
}

function packageJson(src: string): NonCodeInfo {
  const pkg = JSON.parse(src) as Record<string, unknown>;
  const deps = { ...(pkg.dependencies as object), ...(pkg.devDependencies as object) } as Record<string, string>;
  const scripts = Object.keys((pkg.scripts as object) ?? {});
  const refs: NonCodeRef[] = [];
  for (const k of ["main", "module", "types", "bin"]) {
    const v = pkg[k];
    if (typeof v === "string") refs.push({ target: v, kind: "file", edge: "configures" });
    else if (v && typeof v === "object") for (const x of Object.values(v)) if (typeof x === "string") refs.push({ target: x, kind: "file", edge: "configures" });
  }
  const name = typeof pkg.name === "string" ? pkg.name : "package";
  const desc = typeof pkg.description === "string" ? pkg.description : "";
  return {
    summary: `npm manifest for ${name}${desc ? `: ${desc}` : ""}. ${Object.keys(deps).length} dependencies${scripts.length ? `, scripts: ${scripts.slice(0, 8).join(", ")}` : ""}.`,
    children: [],
    refs,
    tags: ["manifest", "npm"],
    dependencies: deps,
    ecosystem: "npm",
  };
}

function jsonFile(path: string, src: string): NonCodeInfo {
  const base = path.split("/").pop()!;
  if (/^tsconfig.*\.json$/.test(base)) {
    const refs: NonCodeRef[] = [];
    const ext = /"extends"\s*:\s*"([^"]+)"/.exec(src);
    if (ext?.[1]?.startsWith(".")) refs.push({ target: ext[1], kind: "file", edge: "configures" });
    return { summary: "TypeScript compiler configuration.", children: [], refs, tags: ["typescript", "build"] };
  }
  if (/openapi|swagger/i.test(base) || /"(openapi|swagger)"\s*:/.test(src.slice(0, 500))) {
    const doc = JSON.parse(src) as { paths?: Record<string, Record<string, unknown>> };
    return openapi(doc, src);
  }
  const keys = Object.keys(JSON.parse(src) ?? {}).slice(0, 8);
  return { summary: keys.length ? `JSON config with keys: ${keys.join(", ")}.` : undefined, children: [], refs: [], tags: ["json"] };
}

function openapi(doc: { paths?: Record<string, Record<string, unknown>> }, src: string): NonCodeInfo {
  const children: ChildEntity[] = [];
  for (const [route, ops] of Object.entries(doc.paths ?? {})) {
    for (const method of Object.keys(ops ?? {})) {
      if (!/^(get|post|put|patch|delete|head|options)$/i.test(method)) continue;
      const idx = src.indexOf(route);
      const line = idx >= 0 ? lineOf(src, idx) : 1;
      children.push({ kind: "endpoint", name: `${method.toUpperCase()} ${route}`, lines: [line, line], summary: `API operation ${method.toUpperCase()} ${route} declared in the OpenAPI spec.`, method: method.toUpperCase(), route });
    }
  }
  return { summary: `OpenAPI spec declaring ${children.length} operations.`, children, refs: [], tags: ["openapi", "api"] };
}

function dockerfile(src: string): NonCodeInfo {
  const refs: NonCodeRef[] = [];
  const children: ChildEntity[] = [];
  const froms: string[] = [];
  const ports: string[] = [];
  src.split("\n").forEach((raw, i) => {
    const l = raw.trim();
    const m = /^(\w+)\s+(.*)$/.exec(l);
    if (!m) return;
    const [, ins, arg] = m as unknown as [string, string, string];
    const I = ins.toUpperCase();
    if (I === "FROM") {
      const img = arg.split(/\s+/)[0]!;
      froms.push(img);
      refs.push({ target: img, kind: "image", edge: "depends_on", line: i + 1 });
      const stage = /\bAS\s+(\S+)/i.exec(arg)?.[1];
      children.push({ kind: "step", name: stage ? `stage ${stage}` : `FROM ${img}`, lines: [i + 1, i + 1], summary: `Build stage based on ${img}.` });
    } else if (I === "COPY" || I === "ADD") {
      const parts = arg.replace(/--\S+\s*/g, "").split(/\s+/);
      for (const p of parts.slice(0, -1)) if (p && p !== "." && !p.startsWith("http")) refs.push({ target: p, kind: "file", edge: "deploys", line: i + 1 });
    } else if (I === "EXPOSE") ports.push(...arg.split(/\s+/));
    else if (I === "CMD" || I === "ENTRYPOINT") {
      for (const f of arg.match(/[\w./-]+\.(js|mjs|py|go|sh|rb|jar)\b/g) ?? []) refs.push({ target: f, kind: "file", edge: "deploys", line: i + 1 });
    }
  });
  return {
    summary: `Container image built from ${froms.join(" → ") || "unknown base"}${ports.length ? `, exposes ${ports.join(", ")}` : ""}.`,
    children,
    refs,
    tags: ["docker", "container"],
  };
}

function compose(src: string): NonCodeInfo {
  const doc = YAML.parse(src) as { services?: Record<string, Record<string, unknown>> } | null;
  const children: ChildEntity[] = [];
  const refs: NonCodeRef[] = [];
  for (const [name, svc] of Object.entries(doc?.services ?? {})) {
    const idx = src.search(new RegExp(`^\\s{2}${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:`, "m"));
    const line = idx >= 0 ? lineOf(src, idx) : 1;
    const image = typeof svc?.image === "string" ? svc.image : undefined;
    const build = typeof svc?.build === "string" ? svc.build : (svc?.build as { context?: string; dockerfile?: string } | undefined)?.context;
    const ports = Array.isArray(svc?.ports) ? (svc.ports as unknown[]).map(String) : [];
    children.push({ kind: "service", name, lines: [line, line], summary: `Compose service "${name}"${image ? ` running ${image}` : ""}${build ? ` built from ${build}` : ""}${ports.length ? `, ports ${ports.join(", ")}` : ""}.`, tags: image ? [image.split(":")[0]!] : [] });
    if (build) refs.push({ target: build.replace(/\/?$/, "/Dockerfile"), kind: "file", edge: "deploys", line });
    for (const dep of Array.isArray(svc?.depends_on) ? svc.depends_on : Object.keys((svc?.depends_on as object) ?? {})) {
      refs.push({ target: String(dep), kind: "service", edge: "depends_on", line });
    }
    for (const envf of ([] as unknown[]).concat(svc?.env_file ?? [])) refs.push({ target: String(envf), kind: "file", edge: "configures", line });
  }
  return { summary: `Docker Compose stack with ${children.length} services: ${children.map((c) => c.name).join(", ")}.`, children, refs, tags: ["docker-compose", "infra"] };
}

function ghActions(src: string): NonCodeInfo {
  const doc = YAML.parse(src) as { name?: string; on?: unknown; jobs?: Record<string, { steps?: Array<{ uses?: string; run?: string; name?: string }> }> } | null;
  const children: ChildEntity[] = [];
  const refs: NonCodeRef[] = [];
  const on = doc?.on ? (typeof doc.on === "string" ? [doc.on] : Array.isArray(doc.on) ? doc.on.map(String) : Object.keys(doc.on as object)) : [];
  for (const [job, def] of Object.entries(doc?.jobs ?? {})) {
    const idx = src.search(new RegExp(`^\\s{2}${job}:`, "m"));
    const line = idx >= 0 ? lineOf(src, idx) : 1;
    const uses = (def?.steps ?? []).map((s) => s.uses).filter(Boolean) as string[];
    children.push({ kind: "step", name: `job ${job}`, lines: [line, line], summary: `CI job "${job}" with ${def?.steps?.length ?? 0} steps${uses.length ? ` using ${uses.slice(0, 4).join(", ")}` : ""}.` });
    for (const s of def?.steps ?? []) {
      for (const f of s.run?.match(/[\w./-]+\.(sh|py|mjs|js|ts)\b/g) ?? []) refs.push({ target: f, kind: "file", edge: "triggers" });
    }
  }
  return { summary: `GitHub Actions workflow${doc?.name ? ` "${doc.name}"` : ""} triggered on ${on.join(", ") || "manual"} with ${children.length} jobs.`, children, refs, tags: ["ci", "github-actions"] };
}

function k8s(src: string): NonCodeInfo {
  const children: ChildEntity[] = [];
  for (const d of YAML.parseAllDocuments(src)) {
    const o = d.toJS() as { kind?: string; metadata?: { name?: string } } | null;
    if (!o?.kind) continue;
    children.push({ kind: "resource", name: `${o.kind}/${o.metadata?.name ?? "unnamed"}`, lines: [1, 1], summary: `Kubernetes ${o.kind} "${o.metadata?.name ?? ""}".` });
  }
  return { summary: `Kubernetes manifest: ${children.map((c) => c.name).join(", ")}.`, children, refs: [], tags: ["kubernetes", "infra"] };
}

function yamlFile(path: string, src: string): NonCodeInfo {
  if (/openapi|swagger/i.test(path) || /^(openapi|swagger):/m.test(src.slice(0, 300))) return openapi(YAML.parse(src), src);
  const doc = YAML.parse(src);
  const keys = doc && typeof doc === "object" ? Object.keys(doc).slice(0, 8) : [];
  return { summary: keys.length ? `YAML config with keys: ${keys.join(", ")}.` : undefined, children: [], refs: [], tags: ["yaml"] };
}

function prisma(src: string): NonCodeInfo {
  const children: ChildEntity[] = [];
  const re = /^\s*(model|enum|view|type)\s+(\w+)\s*\{/gm;
  for (const m of src.matchAll(re)) {
    const start = lineOf(src, m.index!);
    const end = blockEnd(src, m.index!);
    const body = src.split("\n").slice(start, end - 1);
    const fields = body.map((l) => l.trim().split(/\s+/)[0]!).filter((f) => f && !f.startsWith("@@") && !f.startsWith("//"));
    const relations = body.filter((l) => /@relation/.test(l)).length;
    children.push({ kind: m[1] === "model" || m[1] === "view" ? "table" : "schema", name: m[2]!, lines: [start, end], summary: `Prisma ${m[1]} ${m[2]} with ${fields.length} fields${relations ? `, ${relations} relations` : ""}.`, fields: fields.slice(0, 40) });
  }
  const provider = /provider\s*=\s*"(\w+)"/.exec(src.slice(src.indexOf("datasource")))?.[1];
  return { summary: `Prisma schema${provider ? ` (${provider})` : ""} with ${children.filter((c) => c.kind === "table").length} models.`, children, refs: [], tags: ["prisma", "orm", "database"] };
}

function sql(path: string, src: string): NonCodeInfo {
  const children: ChildEntity[] = [];
  const re = /create\s+(?:or\s+replace\s+)?(table|view|materialized\s+view|index|function|type)\s+(?:if\s+not\s+exists\s+)?([\w."]+)/gi;
  for (const m of src.matchAll(re)) {
    const start = lineOf(src, m.index!);
    const kind = /table|view/i.test(m[1]!) ? "table" : "schema";
    const name = m[2]!.replace(/"/g, "");
    let end = start;
    let fields: string[] = [];
    if (kind === "table" && /table/i.test(m[1]!)) {
      const open = src.indexOf("(", m.index!);
      let depth = 0;
      let i = open;
      for (; i < src.length && open >= 0; i++) {
        if (src[i] === "(") depth++;
        else if (src[i] === ")" && --depth === 0) break;
      }
      end = lineOf(src, i);
      fields = src.slice(open + 1, i).split(/,\s*\n|,(?![^(]*\))/).map((f) => f.trim().split(/\s+/)[0]!.replace(/"/g, "")).filter((f) => f && !/^(primary|foreign|unique|constraint|check|key)$/i.test(f));
    }
    children.push({ kind, name, lines: [start, end], summary: `SQL ${m[1]!.toLowerCase()} ${name}${fields.length ? ` with columns ${fields.slice(0, 6).join(", ")}${fields.length > 6 ? "…" : ""}` : ""}.`, fields });
  }
  const isMigration = /migrat/i.test(path);
  return { summary: `${isMigration ? "Database migration" : "SQL file"} defining ${children.length} objects.`, children, refs: [], tags: isMigration ? ["sql", "migration"] : ["sql"] };
}

function graphql(src: string): NonCodeInfo {
  const children: ChildEntity[] = [];
  for (const m of src.matchAll(/^\s*(type|input|interface|enum|union|scalar)\s+(\w+)/gm)) {
    const start = lineOf(src, m.index!);
    children.push({ kind: "schema", name: m[2]!, lines: [start, blockEnd(src, m.index!)], summary: `GraphQL ${m[1]} ${m[2]}.` });
  }
  return { summary: `GraphQL schema with ${children.length} types.`, children, refs: [], tags: ["graphql", "api"] };
}

function protobuf(src: string): NonCodeInfo {
  const children: ChildEntity[] = [];
  const refs: NonCodeRef[] = [];
  for (const m of src.matchAll(/^\s*(message|service|enum)\s+(\w+)/gm)) {
    const start = lineOf(src, m.index!);
    children.push({ kind: m[1] === "service" ? "service" : "schema", name: m[2]!, lines: [start, blockEnd(src, m.index!)], summary: `Protobuf ${m[1]} ${m[2]}.` });
  }
  for (const m of src.matchAll(/^\s*rpc\s+(\w+)\s*\(/gm)) {
    const l = lineOf(src, m.index!);
    children.push({ kind: "endpoint", name: m[1]!, lines: [l, l], summary: `gRPC method ${m[1]}.`, route: m[1]!, method: "RPC" });
  }
  for (const m of src.matchAll(/^\s*import\s+"([^"]+)"/gm)) refs.push({ target: m[1]!, kind: "file", edge: "depends_on" });
  return { summary: `Protobuf definitions: ${children.length} entries.`, children, refs, tags: ["protobuf", "grpc"] };
}

function terraform(src: string): NonCodeInfo {
  const children: ChildEntity[] = [];
  const refs: NonCodeRef[] = [];
  for (const m of src.matchAll(/^(resource|data|module|variable|output)\s+"([^"]+)"(?:\s+"([^"]+)")?/gm)) {
    const start = lineOf(src, m.index!);
    const name = m[3] ? `${m[2]}.${m[3]}` : m[2]!;
    children.push({ kind: "resource", name: `${m[1]} ${name}`, lines: [start, blockEnd(src, m.index!)], summary: `Terraform ${m[1]} ${name}.`, tags: [m[1]!] });
  }
  for (const m of src.matchAll(/source\s*=\s*"(\.[^"]+)"/g)) refs.push({ target: m[1]!, kind: "file", edge: "provisions" });
  return { summary: `Terraform config with ${children.length} blocks.`, children, refs, tags: ["terraform", "infra"] };
}

function markdown(src: string): NonCodeInfo {
  let body = src;
  const frontmatter: Record<string, string> = {};
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(src);
  if (fm) {
    body = src.slice(fm[0].length);
    try {
      const o = YAML.parse(fm[1]!) as Record<string, unknown>;
      for (const [k, v] of Object.entries(o ?? {})) frontmatter[k] = Array.isArray(v) ? v.join(", ") : String(v);
    } catch { /* ignore bad frontmatter */ }
  }
  const children: ChildEntity[] = [];
  const headings: string[] = [];
  const lines = src.split("\n");
  let inFence = false;
  lines.forEach((l, i) => {
    if (/^\s*```/.test(l)) inFence = !inFence;
    if (inFence) return;
    const h = /^(#{1,3})\s+(.+?)\s*#*$/.exec(l);
    if (h) {
      headings.push(h[2]!);
      if (h[1]!.length <= 2) children.push({ kind: "section", name: h[2]!.slice(0, 80), lines: [i + 1, i + 1], summary: `Section "${h[2]}".` });
    }
  });
  const links = [...body.matchAll(/\[[^\]]*\]\(([^)\s#]+)(?:#[^)]*)?\)/g)].map((m) => m[1]!).filter((l) => !/^(https?:|mailto:|data:)/.test(l));
  const wikilinks = [...body.matchAll(/\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g)].map((m) => m[1]!.trim());
  const firstPara = body.split(/\n\s*\n/).map((p) => p.trim()).find((p) => p && !p.startsWith("#") && !p.startsWith("```") && !p.startsWith("<") && !p.startsWith("!["));
  const refs: NonCodeRef[] = links.map((l) => ({ target: decodeURI(l), kind: "file" as const, edge: "documents" as const }));
  // Inline code paths like `src/foo.ts` also count as documentation references.
  for (const m of body.matchAll(/`((?:\.{0,2}\/)?[\w-]+(?:\/[\w.-]+)+\.\w{1,5})`/g)) refs.push({ target: m[1]!, kind: "file", edge: "documents" });
  return {
    summary: firstPara ? firstPara.replace(/\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g, "$1").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\s+/g, " ").replace(/[*_`]/g, "").slice(0, 280) : headings[0],
    children: children.slice(0, 40),
    refs,
    tags: ["docs"],
    headings,
    links,
    wikilinks,
    frontmatter,
  };
}

function envFile(src: string): NonCodeInfo {
  const keys = src.split("\n").map((l) => /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=/.exec(l)?.[1]).filter(Boolean) as string[];
  return { summary: `Environment variables: ${keys.slice(0, 12).join(", ")}${keys.length > 12 ? "…" : ""}.`, children: [], refs: [], tags: ["env", "config"], envKeys: keys };
}

function toml(path: string, src: string): NonCodeInfo {
  const deps: Record<string, string> = {};
  let section = "";
  for (const l of src.split("\n")) {
    const s = /^\s*\[([^\]]+)\]/.exec(l);
    if (s) {
      section = s[1]!;
      continue;
    }
    const kv = /^\s*([\w.-]+)\s*=\s*"?([^"\n]*)"?/.exec(l);
    if (kv && /(^|\.)(dependencies|dev-dependencies)$/.test(section)) deps[kv[1]!] = kv[2]!;
  }
  const pyDeps = /dependencies\s*=\s*\[([\s\S]*?)\]/.exec(src)?.[1];
  if (pyDeps) for (const m of pyDeps.matchAll(/"([A-Za-z0-9_.-]+)\s*([^"]*)"/g)) deps[m[1]!] = m[2]!.trim();
  const base = path.split("/").pop();
  const ecosystem = base === "Cargo.toml" ? "crates.io" : base === "pyproject.toml" ? "PyPI" : undefined;
  return { summary: `${base} with ${Object.keys(deps).length} dependencies.`, children: [], refs: [], tags: ["toml", ecosystem ? "manifest" : "config"], dependencies: deps, ecosystem };
}

function requirements(src: string): NonCodeInfo {
  const deps: Record<string, string> = {};
  for (const l of src.split("\n")) {
    const m = /^\s*([A-Za-z0-9_.-]+)\s*(?:\[.*\])?\s*(==|>=|~=|<=)?\s*([\w.]*)/.exec(l);
    if (m && !l.trim().startsWith("#") && !l.trim().startsWith("-")) deps[m[1]!] = m[3] ?? "";
  }
  return { summary: `Python requirements: ${Object.keys(deps).length} packages.`, children: [], refs: [], tags: ["manifest", "python"], dependencies: deps, ecosystem: "PyPI" };
}

function gomod(src: string): NonCodeInfo {
  const deps: Record<string, string> = {};
  for (const m of src.matchAll(/^\s*([\w./-]+\.[\w./-]+)\s+(v[\w.+-]+)/gm)) deps[m[1]!] = m[2]!;
  const mod = /^module\s+(\S+)/m.exec(src)?.[1];
  return { summary: `Go module ${mod ?? ""} with ${Object.keys(deps).length} requirements.`, children: [], refs: [], tags: ["manifest", "go"], dependencies: deps, ecosystem: "Go" };
}

function makefile(src: string): NonCodeInfo {
  const children: ChildEntity[] = [];
  src.split("\n").forEach((l, i) => {
    const m = /^([\w.-]+)\s*:(?!=)/.exec(l);
    if (m && !m[1]!.startsWith(".")) children.push({ kind: "step", name: `make ${m[1]}`, lines: [i + 1, i + 1], summary: `Make target ${m[1]}.` });
  });
  return { summary: `Makefile with targets: ${children.map((c) => c.name.slice(5)).slice(0, 10).join(", ")}.`, children, refs: [], tags: ["build", "make"] };
}

function procfile(src: string): NonCodeInfo {
  const children: ChildEntity[] = src.split("\n").map((l, i) => /^(\w+):\s*(.+)$/.exec(l) && { kind: "service" as const, name: l.split(":")[0]!, lines: [i + 1, i + 1] as [number, number], summary: `Process "${l.split(":")[0]}": ${l.split(":").slice(1).join(":").trim()}` }).filter(Boolean) as ChildEntity[];
  return { summary: `Procfile with ${children.length} processes.`, children, refs: [], tags: ["deploy"] };
}
