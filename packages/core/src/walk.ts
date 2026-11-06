/** Project file discovery honoring .gitignore, .lensignore, and built-in defaults. */
import { promises as fs } from "node:fs";
import path from "node:path";
import ignore, { type Ignore } from "ignore";
import { classify, type LanguageInfo } from "./languages.js";

export const DEFAULT_IGNORES = [
  ".git/", "node_modules/", "bower_components/", "vendor/", ".venv/", "venv/", "env/", "__pycache__/",
  ".mypy_cache/", ".pytest_cache/", ".ruff_cache/", ".tox/", "dist/", "build/", "out/", ".next/", ".nuxt/",
  ".svelte-kit/", ".turbo/", ".vercel/", ".cache/", "coverage/", "target/", "bin/obj/", "obj/", ".gradle/",
  ".idea/", ".vscode/", ".terraform/", ".lens/", ".ua/", ".understand-anything/", "*.min.js", "*.min.css", "*.map",
  "*.lock", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "poetry.lock", "Cargo.lock", "go.sum",
  "*.snap", "*.generated.*", "*.pb.go", "*_pb2.py", "*.d.ts.map",
];

export interface WalkedFile {
  path: string; // posix, relative to root
  abs: string;
  size: number;
  lang: LanguageInfo;
}

export interface WalkOptions {
  maxFileBytes?: number;
  maxFiles?: number;
  exclude?: string[];
}

export interface WalkResult {
  files: WalkedFile[];
  skipped: { ignored: number; unknown: number; tooLarge: number; binary: number };
}

async function readIfExists(p: string): Promise<string> {
  try {
    return await fs.readFile(p, "utf8");
  } catch {
    return "";
  }
}

export async function buildIgnore(root: string, exclude: string[] = []): Promise<Ignore> {
  const ig = ignore().add(DEFAULT_IGNORES);
  ig.add(await readIfExists(path.join(root, ".gitignore")));
  ig.add(await readIfExists(path.join(root, ".lensignore")));
  ig.add(await readIfExists(path.join(root, ".lens", ".lensignore")));
  // Keep .env.example visible even if .env* is gitignored; it documents config.
  ig.add(["!.env.example"]);
  if (exclude.length) ig.add(exclude);
  return ig;
}

export async function walk(root: string, opts: WalkOptions = {}): Promise<WalkResult> {
  const maxBytes = opts.maxFileBytes ?? 1_000_000;
  const maxFiles = opts.maxFiles ?? 20_000;
  const ig = await buildIgnore(root, opts.exclude);
  const files: WalkedFile[] = [];
  const skipped = { ignored: 0, unknown: 0, tooLarge: 0, binary: 0 };
  const nestedIgnores: Array<{ dir: string; ig: Ignore }> = [];

  async function visit(dirRel: string): Promise<void> {
    const dirAbs = path.join(root, dirRel);
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    // Nested .gitignore files apply to their subtree.
    if (dirRel) {
      const nested = await readIfExists(path.join(dirAbs, ".gitignore"));
      if (nested) nestedIgnores.push({ dir: dirRel, ig: ignore().add(nested) });
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (files.length >= maxFiles) return;
      if (e.isSymbolicLink()) continue; // never follow symlinks out of the tree
      const rel = dirRel ? `${dirRel}/${e.name}` : e.name;
      const test = e.isDirectory() ? `${rel}/` : rel;
      if (ig.ignores(test) || nestedIgnores.some((n) => rel.startsWith(n.dir + "/") && n.ig.ignores(test.slice(n.dir.length + 1)))) {
        skipped.ignored++;
        continue;
      }
      if (e.isDirectory()) {
        await visit(rel);
        continue;
      }
      if (!e.isFile()) continue;
      const lang = classify(rel);
      if (!lang) {
        skipped.unknown++;
        continue;
      }
      const abs = path.join(root, rel);
      const st = await fs.stat(abs);
      if (st.size > maxBytes) {
        skipped.tooLarge++;
        continue;
      }
      files.push({ path: rel, abs, size: st.size, lang });
    }
  }

  await visit("");
  return { files, skipped };
}

export function looksBinary(buf: string): boolean {
  const sample = buf.slice(0, 4000);
  let bad = 0;
  for (let i = 0; i < sample.length; i++) {
    const c = sample.charCodeAt(i);
    if (c === 0) return true;
    if (c === 0xfffd) bad++;
  }
  return bad > 20;
}
