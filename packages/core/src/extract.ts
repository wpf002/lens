/**
 * Structural extraction from tree-sitter ASTs. One table-driven walker covers
 * every grammar; per-language tables only list node types and import shapes.
 */
import { parse, type SyntaxNode } from "./treesitter.js";

export interface SymbolInfo {
  name: string;
  kind: "function" | "class";
  /** interface | struct | trait | enum | type | method | constructor | ... */
  subkind: string;
  lines: [number, number];
  owner?: string;
  exported: boolean;
  signature: string;
  doc?: string;
  params: string[];
  branches: number;
  bases: string[];
  decorators: string[];
}

export interface ImportInfo {
  source: string;
  names: string[];
  line: number;
  /** Re-export (`export * from`), include, require, dynamic import. */
  style: "import" | "require" | "include" | "reexport" | "dynamic" | "use" | "mod";
}

export interface CallInfo {
  /** Enclosing symbol qualified name ("Class.method" or "fn") or "" for module scope. */
  caller: string;
  callee: string;
  receiver?: string;
  line: number;
}

export interface Structure {
  symbols: SymbolInfo[];
  imports: ImportInfo[];
  calls: CallInfo[];
  exports: string[];
  fileDoc?: string;
  parsed: boolean;
}

interface Spec {
  functions: Record<string, string>; // node type → subkind
  classes: Record<string, string>;
  calls: string[];
  imports: (n: SyntaxNode, out: ImportInfo[]) => void;
  exported: (n: SyntaxNode, name: string, owner?: string) => boolean;
  /** Types whose presence nests members (class bodies, impl blocks). */
  containers?: Record<string, (n: SyntaxNode) => string | null>;
}

const NAME_TYPES = new Set([
  "identifier", "simple_identifier", "type_identifier", "property_identifier", "field_identifier",
  "name", "constant", "word", "private_property_identifier",
]);
const BRANCH_TYPES = new Set([
  "if_statement", "if_expression", "if", "elif_clause", "else_if_clause", "elsif", "unless", "if_modifier", "unless_modifier",
  "for_statement", "for_in_statement", "for_of_statement", "enhanced_for_statement", "for_expression", "for", "foreach_statement",
  "for_range_loop", "range_clause", "while_statement", "while_expression", "while", "until", "do_statement", "loop_expression",
  "switch_case", "case_clause", "switch_label", "expression_case", "type_case", "when_entry", "match_arm", "case_statement", "when",
  "catch_clause", "except_clause", "rescue", "guard_statement",
  "conditional_expression", "ternary_expression", "conditional",
]);

/** Source of the file being extracted; slicing it is far cheaper than node.text across the WASM boundary. */
let SRC = "";
const txt = (n: SyntaxNode, max = Infinity) => SRC.slice(n.startIndex, Math.min(n.endIndex, n.startIndex + max));

const str = (n: SyntaxNode | null | undefined) => (n ? n.text.replace(/^[`'"]|[`'"]$/g, "") : "");

function firstNamed(n: SyntaxNode, types: Set<string>): SyntaxNode | null {
  for (let i = 0; i < n.namedChildCount; i++) {
    const c = n.namedChild(i)!;
    if (types.has(c.type)) return c;
  }
  return null;
}

function findDesc(n: SyntaxNode, pred: (x: SyntaxNode) => boolean, depth = 6): SyntaxNode | null {
  if (pred(n)) return n;
  if (depth === 0) return null;
  for (let i = 0; i < n.namedChildCount; i++) {
    const r = findDesc(n.namedChild(i)!, pred, depth - 1);
    if (r) return r;
  }
  return null;
}

function nameOf(n: SyntaxNode): string | null {
  const f = n.childForFieldName("name");
  if (f) return NAME_TYPES.has(f.type) ? f.text : lastIdent(f);
  // C/C++: declarator chain → function_declarator → identifier
  const decl = n.childForFieldName("declarator");
  if (decl) {
    const id = findDesc(decl, (x) => x.type === "identifier" || x.type === "field_identifier" || x.type === "qualified_identifier" || x.type === "destructor_name" || x.type === "operator_name");
    if (id) return id.text;
  }
  const c = firstNamed(n, NAME_TYPES);
  if (c) return c.text;
  // Lua `function M.run()` / dotted names: take the last identifier of the name expression.
  const v = firstNamed(n, new Set(["variable", "dot_index_expression", "method_index_expression"]));
  return v ? lastIdent(v) : null;
}

function lastIdent(n: SyntaxNode): string {
  if (NAME_TYPES.has(n.type)) return n.text;
  for (let i = n.namedChildCount - 1; i >= 0; i--) {
    const c = n.namedChild(i)!;
    if (NAME_TYPES.has(c.type)) return c.text;
  }
  const last = n.namedChild(n.namedChildCount - 1);
  return last ? lastIdent(last) : txt(n, 100);
}

function calleeOf(n: SyntaxNode): { callee: string; receiver?: string } | null {
  const fn =
    n.childForFieldName("function") ??
    n.childForFieldName("name") ??
    n.childForFieldName("method") ??
    n.childForFieldName("constructor") ??
    n.childForFieldName("type") ??
    n.namedChild(0);
  if (!fn) return null;
  // Java/Ruby/PHP: method name is a field, receiver is "object"/"receiver"
  const recv = n.childForFieldName("object") ?? n.childForFieldName("receiver") ?? n.childForFieldName("scope");
  if (NAME_TYPES.has(fn.type)) return { callee: fn.text, receiver: recv ? txt(recv, 60) : undefined };
  const prop = fn.childForFieldName("property") ?? fn.childForFieldName("field") ?? fn.childForFieldName("attribute") ?? fn.childForFieldName("name");
  const obj = fn.childForFieldName("object") ?? fn.childForFieldName("operand") ?? fn.childForFieldName("value") ?? fn.childForFieldName("scope");
  const callee = prop ? lastIdent(prop) : lastIdent(fn);
  if (!callee || callee.length > 80 || /[^\w$]/.test(callee)) return null;
  return { callee, receiver: obj ?? recv ? txt((obj ?? recv)!, 60) : undefined };
}

function leadingDoc(n: SyntaxNode): string | undefined {
  let prev = n.previousNamedSibling;
  // decorators/attributes sit between doc and def
  while (prev && /decorator|attribute|annotation|marker_annotation/.test(prev.type)) prev = prev.previousNamedSibling;
  const lines: string[] = [];
  while (prev && /comment/.test(prev.type) && n.startPosition.row - prev.endPosition.row <= 1 + lines.length * 0) {
    lines.unshift(prev.text);
    const pp = prev.previousNamedSibling;
    if (!pp || !/comment/.test(pp.type) || prev.startPosition.row - pp.endPosition.row > 1) break;
    prev = pp;
  }
  if (lines.length) return cleanComment(lines.join("\n"));
  // Python docstring: first statement in body is a string
  const body = n.childForFieldName("body");
  const first = body?.namedChild(0);
  if (first?.type === "expression_statement" && first.namedChild(0)?.type === "string") {
    return cleanComment(first.namedChild(0)!.text);
  }
  return undefined;
}

export function cleanComment(s: string): string {
  return s
    .replace(/^\s*("""|'''|\/\*\*?|\*\/|#+|\/\/+!?|--|\*)/gm, "")
    .replace(/("""|'''|\*\/)\s*$/gm, "")
    .replace(/^\s*@\w+.*$/gm, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
}

function signatureOf(n: SyntaxNode): string {
  const body = n.childForFieldName("body");
  const text = body ? SRC.slice(n.startIndex, Math.min(body.startIndex, n.startIndex + 400)) : txt(n, 300).split("\n")[0]!;
  return text.replace(/\s+/g, " ").trim().slice(0, 200);
}

/** Parameters recorded per function. */
const MAX_PARAMS = 12;

function paramsOf(n: SyntaxNode): string[] {
  const p = n.childForFieldName("parameters") ?? findDesc(n, (x) => /parameters|parameter_list|formal_parameters|function_value_parameters/.test(x.type), 3);
  if (!p) return [];
  const out: string[] = [];
  for (let i = 0; i < p.namedChildCount && out.length < MAX_PARAMS; i++) {
    const c = p.namedChild(i)!;
    if (/comment/.test(c.type)) continue;
    // Go groups names that share a type (`a, b string`) under one declaration with several name fields.
    const names = c.childrenForFieldName("name").filter((x): x is SyntaxNode => !!x);
    if (names.length > 1) {
      for (const x of names) if (out.length < MAX_PARAMS) out.push(x.text.slice(0, 40));
      continue;
    }
    const nm = names[0] ?? c.childForFieldName("pattern") ?? (NAME_TYPES.has(c.type) ? c : firstNamed(c, NAME_TYPES));
    out.push((nm ?? c).text.slice(0, 40));
  }
  return out;
}

function basesOf(n: SyntaxNode): string[] {
  const out: string[] = [];
  const heads = ["superclass", "superclasses", "super_interfaces", "interfaces", "heritage", "class_heritage", "base_class_clause", "base_clause", "base_list", "delegation_specifier", "inheritance_specifier", "extends_clause", "implements_clause", "argument_list", "extends_type_clause", "trait_bounds"];
  const visit = (x: SyntaxNode, depth: number) => {
    if (depth > 3) return;
    for (let i = 0; i < x.namedChildCount; i++) {
      const c = x.namedChild(i)!;
      if (heads.some((h) => c.type.includes(h)) || (x.type === "class_definition" && c.type === "argument_list")) {
        const ids = collect(c, (y) => y.type === "type_identifier" || y.type === "identifier" || y.type === "name" || y.type === "constant" || y.type === "simple_identifier");
        for (const id of ids) if (!out.includes(id.text) && id.text !== "object") out.push(id.text);
      } else if (depth < 1 && !/body|block/.test(c.type)) visit(c, depth + 1);
    }
  };
  visit(n, 0);
  return out.slice(0, 8);
}

function collect(n: SyntaxNode, pred: (x: SyntaxNode) => boolean, out: SyntaxNode[] = [], depth = 5): SyntaxNode[] {
  if (pred(n)) {
    out.push(n);
    return out;
  }
  if (depth === 0) return out;
  for (let i = 0; i < n.namedChildCount; i++) collect(n.namedChild(i)!, pred, out, depth - 1);
  return out;
}

const DECORATOR_TYPES = new Set(["decorator", "annotation", "marker_annotation", "attribute_list", "attribute_item", "attribute"]);

function decoratorsOf(n: SyntaxNode): string[] {
  const out: string[] = [];
  const scan = (x: SyntaxNode | null) => {
    if (!x) return;
    for (let i = 0; i < x.namedChildCount; i++) {
      const c = x.namedChild(i)!;
      if (DECORATOR_TYPES.has(c.type)) out.push(c.text.replace(/\s+/g, " ").slice(0, 120));
      if (c.type === "modifiers") scan(c);
    }
  };
  scan(n);
  if (n.parent && /decorated_definition/.test(n.parent.type)) scan(n.parent);
  let prev = n.previousNamedSibling;
  while (prev && DECORATOR_TYPES.has(prev.type)) {
    out.push(prev.text.replace(/\s+/g, " ").slice(0, 120));
    prev = prev.previousNamedSibling;
  }
  return [...new Set(out)];
}

/* ---------------- per-language tables ---------------- */

const jsImports = (n: SyntaxNode, out: ImportInfo[]) => {
  const line = n.startPosition.row + 1;
  if (n.type === "import_statement") {
    const src = n.childForFieldName("source");
    const names = collect(n, (x) => x.type === "identifier" || x.type === "property_identifier").map((x) => x.text);
    if (src) out.push({ source: str(src), names: [...new Set(names)], line, style: "import" });
  } else if (n.type === "export_statement") {
    const src = n.childForFieldName("source");
    if (src) out.push({ source: str(src), names: [], line, style: "reexport" });
  } else if (n.type === "call_expression") {
    const fn = n.childForFieldName("function");
    const args = n.childForFieldName("arguments");
    const a0 = args?.namedChild(0);
    if (a0 && (a0.type === "string" || a0.type === "template_string") && fn && (fn.text === "require" || fn.type === "import")) {
      out.push({ source: str(a0), names: [], line, style: fn.text === "require" ? "require" : "dynamic" });
    }
  }
};

const pyImports = (n: SyntaxNode, out: ImportInfo[]) => {
  const line = n.startPosition.row + 1;
  if (n.type === "import_statement") {
    for (const d of collect(n, (x) => x.type === "dotted_name")) out.push({ source: d.text, names: [], line, style: "import" });
  } else if (n.type === "import_from_statement") {
    const mod = n.childForFieldName("module_name");
    const names = collect(n, (x) => x.type === "dotted_name" || x.type === "identifier")
      .filter((x) => x.id !== mod?.id && !(mod && x.startIndex >= mod.startIndex && x.endIndex <= mod.endIndex))
      .map((x) => x.text);
    if (mod) out.push({ source: mod.text, names, line, style: "import" });
  }
};

const goImports = (n: SyntaxNode, out: ImportInfo[]) => {
  if (n.type === "import_spec") {
    const p = n.childForFieldName("path");
    if (p) out.push({ source: str(p), names: [], line: n.startPosition.row + 1, style: "import" });
  }
};

const rustImports = (n: SyntaxNode, out: ImportInfo[]) => {
  const line = n.startPosition.row + 1;
  if (n.type === "use_declaration") {
    const arg = n.childForFieldName("argument");
    if (arg) out.push({ source: arg.text.replace(/\s+/g, ""), names: [], line, style: "use" });
  } else if (n.type === "mod_item" && !n.childForFieldName("body")) {
    const nm = n.childForFieldName("name");
    if (nm) out.push({ source: nm.text, names: [], line, style: "mod" });
  }
};

const simpleImport = (types: string[], style: ImportInfo["style"] = "import") => (n: SyntaxNode, out: ImportInfo[]) => {
  if (!types.includes(n.type)) return;
  const text = n.text
    .replace(/^(import|using|use|#include|include|require_once|require|include_once|package)\s+(static\s+)?/, "")
    .replace(/[;"'<>]/g, "")
    .replace(/\s+as\s+\w+$/, "")
    .trim();
  if (text) out.push({ source: text.split(/\s+/)[0]!, names: [], line: n.startPosition.row + 1, style });
};

const rubyImports = (n: SyntaxNode, out: ImportInfo[]) => {
  if (n.type !== "call") return;
  const m = n.childForFieldName("method")?.text;
  if (m !== "require" && m !== "require_relative" && m !== "load") return;
  const arg = n.childForFieldName("arguments")?.namedChild(0);
  if (arg) out.push({ source: (m === "require_relative" ? "./" : "") + str(arg).replace(/^\.\//, ""), names: [], line: n.startPosition.row + 1, style: "require" });
};

const phpImports = (n: SyntaxNode, out: ImportInfo[]) => {
  const line = n.startPosition.row + 1;
  if (n.type === "namespace_use_clause") out.push({ source: n.text.replace(/\s+as\s+\w+$/, "").trim(), names: [], line, style: "use" });
  if (/^(require|include)(_once)?_expression$/.test(n.type)) {
    const s = collect(n, (x) => x.type === "string" || x.type === "encapsed_string")[0];
    if (s) out.push({ source: str(s).replace(/^['"]|['"]$/g, ""), names: [], line, style: "include" });
  }
};

const cImports = (n: SyntaxNode, out: ImportInfo[]) => {
  if (n.type !== "preproc_include") return;
  const p = n.childForFieldName("path");
  if (p) out.push({ source: p.text.replace(/[<>"]/g, ""), names: [], line: n.startPosition.row + 1, style: "include" });
};

const hasExportParent = (n: SyntaxNode) => {
  let p = n.parent;
  for (let i = 0; p && i < 3; i++, p = p.parent) if (p.type === "export_statement") return true;
  return false;
};
const hasModifier = (words: string[]) => (n: SyntaxNode) => {
  const mods = n.childForFieldName("modifiers") ?? firstNamed(n, new Set(["modifiers", "visibility_modifier", "modifier"]));
  const head = txt(n, 80);
  return (mods ? words.some((w) => txt(mods, 200).includes(w)) : false) || words.some((w) => head.startsWith(w + " "));
};
const upperFirst = (_n: SyntaxNode, name: string) => /^[A-Z]/.test(name);
const notPrivate = (_n: SyntaxNode, name: string) => !name.startsWith("_");

const JS: Spec = {
  functions: {
    function_declaration: "function", generator_function_declaration: "function", method_definition: "method",
    function_signature: "function",
  },
  classes: {
    class_declaration: "class", abstract_class_declaration: "class", interface_declaration: "interface",
    type_alias_declaration: "type", enum_declaration: "enum", class: "class",
  },
  calls: ["call_expression", "new_expression"],
  imports: jsImports,
  exported: (n) => hasExportParent(n),
};

const SPECS: Record<string, Spec> = {
  typescript: JS,
  tsx: JS,
  javascript: JS,
  python: {
    functions: { function_definition: "function" },
    classes: { class_definition: "class" },
    calls: ["call"],
    imports: pyImports,
    exported: notPrivate,
  },
  go: {
    functions: { function_declaration: "function", method_declaration: "method" },
    classes: { type_spec: "type" },
    calls: ["call_expression"],
    imports: goImports,
    exported: upperFirst,
  },
  rust: {
    functions: { function_item: "function", function_signature_item: "function" },
    classes: { struct_item: "struct", enum_item: "enum", trait_item: "trait", union_item: "union", type_item: "type" },
    calls: ["call_expression", "macro_invocation"],
    imports: rustImports,
    exported: (n) => firstNamed(n, new Set(["visibility_modifier"])) !== null,
    containers: { impl_item: (n) => n.childForFieldName("type")?.text.replace(/<.*$/, "") ?? null },
  },
  java: {
    functions: { method_declaration: "method", constructor_declaration: "constructor" },
    classes: { class_declaration: "class", interface_declaration: "interface", enum_declaration: "enum", record_declaration: "record", annotation_type_declaration: "annotation" },
    calls: ["method_invocation", "object_creation_expression"],
    imports: simpleImport(["import_declaration"]),
    exported: hasModifier(["public"]),
  },
  kotlin: {
    functions: { function_declaration: "function" },
    classes: { class_declaration: "class", object_declaration: "object" },
    calls: ["call_expression"],
    imports: simpleImport(["import_header"]),
    exported: (n) => !hasModifier(["private", "internal"])(n),
  },
  scala: {
    functions: { function_definition: "function", function_declaration: "function" },
    classes: { class_definition: "class", object_definition: "object", trait_definition: "trait" },
    calls: ["call_expression"],
    imports: simpleImport(["import_declaration"]),
    exported: (n) => !hasModifier(["private", "protected"])(n),
  },
  swift: {
    functions: { function_declaration: "function", init_declaration: "constructor" },
    classes: { class_declaration: "class", protocol_declaration: "protocol" },
    calls: ["call_expression"],
    imports: simpleImport(["import_declaration"]),
    exported: (n) => !hasModifier(["private", "fileprivate"])(n),
  },
  ruby: {
    functions: { method: "method", singleton_method: "method" },
    classes: { class: "class", module: "module" },
    calls: ["call"],
    imports: rubyImports,
    exported: notPrivate,
  },
  php: {
    functions: { function_definition: "function", method_declaration: "method" },
    classes: { class_declaration: "class", interface_declaration: "interface", trait_declaration: "trait", enum_declaration: "enum" },
    calls: ["function_call_expression", "member_call_expression", "scoped_call_expression", "object_creation_expression"],
    imports: phpImports,
    exported: (n) => !hasModifier(["private", "protected"])(n),
  },
  c_sharp: {
    functions: { method_declaration: "method", constructor_declaration: "constructor", local_function_statement: "function" },
    classes: { class_declaration: "class", interface_declaration: "interface", struct_declaration: "struct", record_declaration: "record", enum_declaration: "enum" },
    calls: ["invocation_expression", "object_creation_expression"],
    imports: simpleImport(["using_directive"]),
    exported: hasModifier(["public", "internal"]),
  },
  c: {
    functions: { function_definition: "function" },
    classes: { struct_specifier: "struct", enum_specifier: "enum", union_specifier: "union" },
    calls: ["call_expression"],
    imports: cImports,
    exported: (n) => !/^static\b/.test(txt(n, 10)),
  },
  cpp: {
    functions: { function_definition: "function" },
    classes: { class_specifier: "class", struct_specifier: "struct", enum_specifier: "enum" },
    calls: ["call_expression"],
    imports: cImports,
    exported: (n) => !/^static\b/.test(txt(n, 10)),
  },
  dart: {
    functions: { function_signature: "function", method_signature: "method" },
    classes: { class_definition: "class", mixin_declaration: "mixin", enum_declaration: "enum", extension_declaration: "extension" },
    calls: [],
    imports: simpleImport(["import_or_export"]),
    exported: notPrivate,
  },
  lua: {
    functions: { function_declaration: "function", function_definition_statement: "function", local_function_definition_statement: "function" },
    classes: {},
    calls: ["function_call", "call"],
    imports: () => {},
    exported: () => true,
  },
  bash: {
    functions: { function_definition: "function" },
    classes: {},
    calls: ["command"],
    imports: (n, out) => {
      if (n.type === "command" && /^(source|\.)$/.test(n.childForFieldName("name")?.text ?? "")) {
        const a = n.namedChild(1);
        if (a) out.push({ source: str(a), names: [], line: n.startPosition.row + 1, style: "include" });
      }
    },
    exported: () => true,
  },
  solidity: {
    functions: { function_definition: "function", modifier_definition: "modifier" },
    classes: { contract_declaration: "contract", interface_declaration: "interface", library_declaration: "library", struct_declaration: "struct" },
    calls: ["call_expression"],
    imports: simpleImport(["import_directive"]),
    exported: () => true,
  },
};

function docAnchor(n: SyntaxNode, isJs: boolean): SyntaxNode {
  let a = n;
  if (isJs && n.type === "variable_declarator" && n.parent) a = n.parent;
  if (a.parent && (a.parent.type === "export_statement" || a.parent.type === "decorated_definition")) a = a.parent;
  return a;
}

const ROUTE_METHOD_RE = /^(get|post|put|patch|delete|head|options|all|any)$/i;

/** Inline route handler: router.post("/x", mw, async (req, res) => {...}) → symbol "POST /x". */
function jsRouteHandler(n: SyntaxNode): { name: string; fn: SyntaxNode } | null {
  if (n.type !== "call_expression") return null;
  const fn = n.childForFieldName("function");
  if (fn?.type !== "member_expression") return null;
  const prop = fn.childForFieldName("property")?.text ?? "";
  if (!ROUTE_METHOD_RE.test(prop)) return null;
  const args = n.childForFieldName("arguments");
  const a0 = args?.namedChild(0);
  if (!args || !a0 || (a0.type !== "string" && a0.type !== "template_string")) return null;
  const route = a0.text.slice(1, -1);
  if (!route.startsWith("/") && route !== "*") return null;
  for (let i = args.namedChildCount - 1; i >= 1; i--) {
    const a = args.namedChild(i)!;
    if (/^(arrow_function|function_expression|function)$/.test(a.type)) return { name: `${prop.toUpperCase()} ${route}`, fn: a };
  }
  return null;
}

/** Variable-assigned functions: `const foo = () => {}` / `foo = function() {}`. */
function jsVarFunction(n: SyntaxNode): { name: string; fn: SyntaxNode } | null {
  if (n.type !== "variable_declarator") return null;
  const v = n.childForFieldName("value");
  if (!v || !/^(arrow_function|function_expression|function|generator_function)$/.test(v.type)) return null;
  const nm = n.childForFieldName("name");
  return nm && nm.type === "identifier" ? { name: nm.text, fn: v } : null;
}

const MAX_CALLS_PER_FILE = 4000;

export async function extractStructure(grammar: string, source: string): Promise<Structure> {
  const spec = SPECS[grammar];
  const empty: Structure = { symbols: [], imports: [], calls: [], exports: [], parsed: false };
  if (!spec) return empty;
  const tree = await parse(grammar, source);
  if (!tree) return empty;
  SRC = source;

  const symbols: SymbolInfo[] = [];
  const imports: ImportInfo[] = [];
  const calls: CallInfo[] = [];
  const exports = new Set<string>();
  const callTypes = new Set(spec.calls);
  const isJs = grammar === "typescript" || grammar === "tsx" || grammar === "javascript";

  const addSymbol = (n: SyntaxNode, name: string, kind: "function" | "class", subkind: string, owner: string | undefined, bodyNode: SyntaxNode = n) => {
    const exported = spec.exported(n, name, owner) || (isJs && n.parent?.parent?.type === "export_statement");
    const sym: SymbolInfo = {
      name,
      kind,
      subkind: owner && kind === "function" && subkind === "function" ? "method" : subkind,
      lines: [n.startPosition.row + 1, n.endPosition.row + 1],
      owner,
      exported,
      signature: signatureOf(kind === "function" && bodyNode !== n ? n : n),
      doc: leadingDoc(docAnchor(n, isJs)),
      params: kind === "function" ? paramsOf(bodyNode) : [],
      branches: 0, // counted during the main walk
      bases: kind === "class" ? basesOf(n) : [],
      decorators: decoratorsOf(n),
    };
    symbols.push(sym);
    if (kind === "function") fnByQname.set(owner ? `${owner}.${name}` : name, sym);
    if (exported && !owner) exports.add(name);
    return sym;
  };
  const fnByQname = new Map<string, SymbolInfo>();

  // Explicit stack walk: (node, owner, enclosingFunction)
  const stack: Array<[SyntaxNode, string | undefined, string]> = [[tree.rootNode, undefined, ""]];
  while (stack.length) {
    const [n, owner, encl] = stack.pop()!;
    let childOwner = owner;
    let childEncl = encl;
    spec.imports(n, imports);

    const fnKind = spec.functions[n.type];
    const clsKind = spec.classes[n.type];
    const container = spec.containers?.[n.type];
    if (clsKind) {
      let name = nameOf(n);
      if (grammar === "go" && n.type === "type_spec") {
        const t = n.childForFieldName("type")?.type ?? "";
        const sub = t.includes("struct") ? "struct" : t.includes("interface") ? "interface" : "type";
        if (name) addSymbol(n, name, "class", sub, undefined);
        name = null;
      } else if (name && !(n.type === "class" && !isJs && grammar !== "ruby")) {
        // anonymous JS class expressions have no name → skipped
        addSymbol(n, name, "class", clsKind, owner);
        childOwner = owner ? `${owner}.${name}` : name;
      }
    } else if (container) {
      const nm = container(n);
      if (nm) childOwner = nm;
    } else if (fnKind) {
      let name = nameOf(n);
      let own = owner;
      if (name && name.includes("::") && (grammar === "cpp" || grammar === "c")) {
        const parts = name.split("::");
        name = parts.pop()!;
        own = parts.join("::") || owner;
      }
      if (grammar === "go" && n.type === "method_declaration") {
        const recv = n.childForFieldName("receiver");
        const t = recv ? collect(recv, (x) => x.type === "type_identifier")[0]?.text : undefined;
        own = t ?? owner;
      }
      if (name && !(grammar === "typescript" && n.type === "function_signature" && owner)) {
        addSymbol(n, name, "function", fnKind, own);
        childEncl = own ? `${own}.${name}` : name;
      } else if (!name) name = null;
    } else if (isJs) {
      const vf = jsVarFunction(n);
      const rh = vf ? null : jsRouteHandler(n);
      if (rh) {
        addSymbol(rh.fn, rh.name, "function", "handler", owner, rh.fn);
        // the handler's own subtree is walked with the handler as enclosing symbol
        stack.push([rh.fn, owner, owner ? `${owner}.${rh.name}` : rh.name]);
        for (let i = n.namedChildCount - 1; i >= 0; i--) {
          const c = n.namedChild(i)!;
          if (c.type === "arguments") {
            for (let j = c.namedChildCount - 1; j >= 0; j--) {
              const a = c.namedChild(j)!;
              if (a.id !== rh.fn.id) stack.push([a, owner, encl]);
            }
          } else stack.push([c, owner, encl]);
        }
        continue;
      }
      if (vf) {
        addSymbol(n, vf.name, "function", "function", owner, vf.fn);
        childEncl = owner ? `${owner}.${vf.name}` : vf.name;
      } else if (n.type === "public_field_definition" || n.type === "field_definition") {
        const v = n.childForFieldName("value");
        const nm = n.childForFieldName("name") ?? n.childForFieldName("property");
        if (v && nm && /arrow_function|function/.test(v.type) && owner) {
          addSymbol(n, nm.text, "function", "method", owner, v);
          childEncl = `${owner}.${nm.text}`;
        }
      } else if (n.type === "export_statement") {
        // export { a, b } / export default foo
        for (const s of collect(n, (x) => x.type === "export_specifier", [], 3)) {
          const nm = s.childForFieldName("alias") ?? s.childForFieldName("name");
          if (nm) exports.add(nm.text);
        }
        if (/^export\s+default\b/.test(txt(n, 20))) exports.add("default");
      }
    }

    if (encl && (BRANCH_TYPES.has(n.type) || ((n.type === "binary_expression" || n.type === "boolean_operator") && /^(&&|\|\||and|or)$/.test(n.childForFieldName("operator")?.type ?? "")))) {
      const f = fnByQname.get(encl);
      if (f) f.branches++;
    }
    if (callTypes.has(n.type) && calls.length < MAX_CALLS_PER_FILE) {
      const c = calleeOf(n);
      if (c && c.callee !== "require") calls.push({ caller: encl, callee: c.callee, receiver: c.receiver, line: n.startPosition.row + 1 });
    }

    for (let i = n.namedChildCount - 1; i >= 0; i--) stack.push([n.namedChild(i)!, childOwner, childEncl]);
  }
  // Methods belong to their class: Python/Ruby class body nesting gives owner automatically.
  symbols.sort((a, b) => a.lines[0] - b.lines[0]);

  // File doc: first comment/docstring at top of file.
  let fileDoc: string | undefined;
  const first = tree.rootNode.namedChild(0);
  if (first && /comment/.test(first.type) && first.startPosition.row < 3) fileDoc = cleanComment(first.text);
  else if (first?.type === "expression_statement" && first.namedChild(0)?.type === "string") fileDoc = cleanComment(first.text);
  tree.delete();
  return { symbols, imports, calls, exports: [...exports], fileDoc, parsed: true };
}

export function supportsGrammar(grammar: string | undefined): boolean {
  return !!grammar && grammar in SPECS;
}
