/** File classification: extension/filename → language, category, and grammar. */

export type FileCategory = "code" | "config" | "docs" | "infra" | "data" | "markup" | "script" | "test";

export interface LanguageInfo {
  id: string;
  category: FileCategory;
  /** tree-sitter-wasms grammar name (tree-sitter-<grammar>.wasm). */
  grammar?: string;
}

const EXT: Record<string, LanguageInfo> = {
  ts: { id: "typescript", category: "code", grammar: "typescript" },
  mts: { id: "typescript", category: "code", grammar: "typescript" },
  cts: { id: "typescript", category: "code", grammar: "typescript" },
  tsx: { id: "typescript", category: "code", grammar: "tsx" },
  js: { id: "javascript", category: "code", grammar: "javascript" },
  mjs: { id: "javascript", category: "code", grammar: "javascript" },
  cjs: { id: "javascript", category: "code", grammar: "javascript" },
  jsx: { id: "javascript", category: "code", grammar: "javascript" },
  py: { id: "python", category: "code", grammar: "python" },
  pyi: { id: "python", category: "code", grammar: "python" },
  go: { id: "go", category: "code", grammar: "go" },
  rs: { id: "rust", category: "code", grammar: "rust" },
  java: { id: "java", category: "code", grammar: "java" },
  kt: { id: "kotlin", category: "code", grammar: "kotlin" },
  kts: { id: "kotlin", category: "code", grammar: "kotlin" },
  scala: { id: "scala", category: "code", grammar: "scala" },
  rb: { id: "ruby", category: "code", grammar: "ruby" },
  php: { id: "php", category: "code", grammar: "php" },
  cs: { id: "csharp", category: "code", grammar: "c_sharp" },
  c: { id: "c", category: "code", grammar: "c" },
  h: { id: "c", category: "code", grammar: "c" },
  cc: { id: "cpp", category: "code", grammar: "cpp" },
  cpp: { id: "cpp", category: "code", grammar: "cpp" },
  cxx: { id: "cpp", category: "code", grammar: "cpp" },
  hpp: { id: "cpp", category: "code", grammar: "cpp" },
  hh: { id: "cpp", category: "code", grammar: "cpp" },
  swift: { id: "swift", category: "code", grammar: "swift" },
  dart: { id: "dart", category: "code", grammar: "dart" },
  lua: { id: "lua", category: "code", grammar: "lua" },
  ex: { id: "elixir", category: "code", grammar: "elixir" },
  exs: { id: "elixir", category: "code", grammar: "elixir" },
  zig: { id: "zig", category: "code", grammar: "zig" },
  sol: { id: "solidity", category: "code", grammar: "solidity" },
  vue: { id: "vue", category: "code" },
  svelte: { id: "svelte", category: "code" },
  sh: { id: "shell", category: "script", grammar: "bash" },
  bash: { id: "shell", category: "script", grammar: "bash" },
  zsh: { id: "shell", category: "script" },
  ps1: { id: "powershell", category: "script" },
  sql: { id: "sql", category: "data" },
  prisma: { id: "prisma", category: "data" },
  graphql: { id: "graphql", category: "data" },
  gql: { id: "graphql", category: "data" },
  proto: { id: "protobuf", category: "data" },
  csv: { id: "csv", category: "data" },
  json: { id: "json", category: "config" },
  jsonc: { id: "json", category: "config" },
  yaml: { id: "yaml", category: "config" },
  yml: { id: "yaml", category: "config" },
  toml: { id: "toml", category: "config" },
  ini: { id: "ini", category: "config" },
  xml: { id: "xml", category: "markup" },
  html: { id: "html", category: "markup" },
  htm: { id: "html", category: "markup" },
  css: { id: "css", category: "markup" },
  scss: { id: "css", category: "markup" },
  less: { id: "css", category: "markup" },
  md: { id: "markdown", category: "docs" },
  mdx: { id: "markdown", category: "docs" },
  rst: { id: "restructuredtext", category: "docs" },
  txt: { id: "text", category: "docs" },
  tf: { id: "terraform", category: "infra" },
  tfvars: { id: "terraform", category: "infra" },
  hcl: { id: "terraform", category: "infra" },
};

const NAMES: Record<string, LanguageInfo> = {
  dockerfile: { id: "dockerfile", category: "infra" },
  containerfile: { id: "dockerfile", category: "infra" },
  makefile: { id: "makefile", category: "script" },
  jenkinsfile: { id: "jenkinsfile", category: "infra" },
  procfile: { id: "procfile", category: "infra" },
  gemfile: { id: "ruby", category: "config", grammar: "ruby" },
  rakefile: { id: "ruby", category: "script", grammar: "ruby" },
  ".env": { id: "env", category: "config" },
  ".env.example": { id: "env", category: "config" },
  "go.mod": { id: "gomod", category: "config" },
  "requirements.txt": { id: "requirements", category: "config" },
};

export function classify(relPath: string): LanguageInfo | null {
  const base = relPath.split("/").pop()!.toLowerCase();
  if (NAMES[base]) return withTest(relPath, NAMES[base]);
  if (base.startsWith("dockerfile") || base.endsWith(".dockerfile")) return { id: "dockerfile", category: "infra" };
  if (base.startsWith(".env")) return { id: "env", category: "config" };
  const dot = base.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = base.slice(dot + 1);
  const info = EXT[ext];
  if (!info) return null;
  if ((ext === "yml" || ext === "yaml") && /(^|\/)\.github\/workflows\//.test(relPath)) {
    return { id: "github-actions", category: "infra" };
  }
  if ((ext === "yml" || ext === "yaml") && /(docker-)?compose/.test(base)) return { id: "docker-compose", category: "infra" };
  if ((ext === "yml" || ext === "yaml") && /(^|\/)(k8s|kubernetes|helm|charts|manifests)\//.test(relPath)) {
    return { id: "kubernetes", category: "infra" };
  }
  return withTest(relPath, info);
}

const TEST_RE = /(^|\/)(__tests__|tests?|spec|e2e)\/|\.(test|spec)\.[a-z]+$|(^|\/)test_[^/]+\.py$|_test\.(go|py)$|Tests?\.(java|kt|cs)$/;

export function isTestPath(p: string): boolean {
  return TEST_RE.test(p);
}

function withTest(p: string, info: LanguageInfo): LanguageInfo {
  return info.category === "code" && isTestPath(p) ? { ...info, category: "test" } : info;
}

/** Node kind for a non-code file. */
export function fileNodeKind(p: string, info: LanguageInfo):
  "file" | "config" | "document" | "service" | "pipeline" | "schema" | "resource" {
  switch (info.id) {
    case "dockerfile":
    case "docker-compose":
    case "procfile":
    case "kubernetes":
      return "service";
    case "github-actions":
    case "jenkinsfile":
      return "pipeline";
    case "terraform":
      return "resource";
    case "prisma":
    case "graphql":
    case "protobuf":
      return "schema";
    case "sql":
      return /migrat/i.test(p) ? "schema" : "schema";
    case "markdown":
    case "restructuredtext":
    case "text":
      return "document";
  }
  if (info.category === "config") return "config";
  if (info.category === "docs") return "document";
  return "file";
}
