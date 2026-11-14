import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildLayout, namingStyle, scanProject, type LayoutFile } from "../src/index.js";
import { walk } from "../src/walk.js";

const code = (p: string): LayoutFile => ({ path: p, category: "code" });
const test = (p: string): LayoutFile => ({ path: p, category: "test" });
const doc = (p: string): LayoutFile => ({ path: p, category: "docs" });
const many = (dir: string, n: number) => Array.from({ length: n }, (_, k) => code(`${dir}/file-${k}.ts`));
const checkOf = (files: LayoutFile[], id: string, maxFolderFiles?: number) => buildLayout({ files, maxFolderFiles }).checks.find((c) => c.id === id);

describe("namingStyle", () => {
  it("tells the common styles apart", () => {
    expect(namingStyle("user-service")).toBe("kebab-case");
    expect(namingStyle("user_service")).toBe("snake_case");
    expect(namingStyle("userService")).toBe("camelCase");
    expect(namingStyle("UserService")).toBe("PascalCase");
    expect(namingStyle("users")).toBe("lowercase");
  });
});

describe("buildLayout", () => {
  it("flags a folder holding more files than the limit", () => {
    const hit = checkOf(many("apps/api/src", 30), "crowded-folder");
    expect(hit?.hits[0]).toMatchObject({ path: "apps/api/src", detail: expect.stringContaining("30 files") });
  });

  it("uses the owner's folder limit", () => {
    expect(checkOf(many("src", 30), "crowded-folder", 40)).toBeUndefined();
  });

  it("leaves migration and fixture folders alone", () => {
    expect(checkOf([...many("prisma/migrations", 30), ...many("test/fixtures", 30)], "crowded-folder")).toBeUndefined();
  });

  it("flags a folder that mixes kebab-case and camelCase modules", () => {
    const hit = checkOf([code("src/user-service.ts"), code("src/orderService.ts"), code("src/billing-api.ts")], "mixed-file-naming");
    expect(hit?.hits[0]?.detail).toMatch(/kebab-case 2.*camelCase 1/);
  });

  it("allows PascalCase components beside kebab-case modules and framework file names", () => {
    const files = [code("app/UserCard.tsx"), code("app/user-api.ts"), code("app/page.tsx"), code("app/not-found.tsx"), code("app/index.ts")];
    expect(checkOf(files, "mixed-file-naming")).toBeUndefined();
  });

  it("flags non-standard docs at a package root but not README or CLAUDE.md", () => {
    const files = [doc("README.md"), doc("CLAUDE.md"), doc("PLAN_V2.md"), code("apps/web/package.json"), doc("apps/web/NOTES.md"), doc("docs/guide.md")];
    expect(checkOf(files, "stray-root-docs")?.hits.map((h) => h.path)).toEqual(["PLAN_V2.md", "apps/web/NOTES.md"]);
  });

  it("flags the same doc name in two places", () => {
    const hit = checkOf([doc("docs/setup.md"), doc("apps/web/SETUP.md"), doc("apps/web/README.md"), doc("README.md")], "duplicate-docs");
    expect(hit?.count).toBe(1);
  });

  it("flags spaces and non-ASCII in names but allows Next.js route syntax", () => {
    const files = [code("docs/Meeting Notes.md"), code("src/café.ts"), code("app/[id]/(group)/@modal/page.tsx")];
    expect(checkOf(files, "unsafe-file-names")?.hits.map((h) => h.path)).toEqual(["docs/Meeting Notes.md", "src/café.ts"]);
  });

  it("flags tests named after a bug", () => {
    const files = [test("tests/fix-login-redirect.test.ts"), test("tests/bug-142.test.ts"), test("src/auth.test.ts")];
    expect(checkOf(files, "bug-named-tests")?.count).toBe(2);
  });

  it("scores a clean layout 100", () => {
    expect(buildLayout({ files: [doc("README.md"), code("src/index.ts"), test("src/index.test.ts")] }).score).toBe(100);
  });
});

describe("scan", () => {
  it("adds a layout report that reads the folder limit from .lens/architecture.json", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lens-layout-"));
    await fs.mkdir(path.join(dir, "src"));
    await Promise.all(Array.from({ length: 8 }, (_, k) => fs.writeFile(path.join(dir, "src", `part-${k}.ts`), `export const part${k} = ${k};\n`)));
    await fs.mkdir(path.join(dir, ".lens"));
    await fs.writeFile(path.join(dir, ".lens", "architecture.json"), JSON.stringify({ maxFolderFiles: 5 }));
    const { graph } = await scanProject(dir);
    expect(graph.layout?.checks.find((c) => c.id === "crowded-folder")?.hits[0]?.path).toBe("src");
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe("walk ignores", () => {
  it("skips Claude worktrees and paths in .git/info/exclude", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "lens-walk-"));
    const write = async (rel: string, text: string) => {
      await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
      await fs.writeFile(path.join(root, rel), text);
    };
    await write("src/app.ts", "export const app = 1;\n");
    await write(".claude/worktrees/copy/src/app.ts", "export const app = 1;\n");
    await write("scratch/notes.ts", "export const notes = 1;\n");
    await write(".git/info/exclude", "scratch/\n");
    const { files } = await walk(root);
    expect(files.map((f) => f.path)).toEqual(["src/app.ts"]);
  });
});
