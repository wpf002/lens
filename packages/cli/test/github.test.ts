import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { githubApi, githubLogin, loadGithub, readStoredGithub } from "../src/github.js";

const saved = { token: "test-token-abc", login: "octo" };

async function workspaceWith(contents: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lens-gh-"));
  await fs.writeFile(path.join(dir, "github.json"), contents);
  return dir;
}

afterEach(() => vi.unstubAllGlobals());

describe("saved GitHub connection", () => {
  it("keeps the saved file when GitHub answers 401", async () => {
    const dir = await workspaceWith(JSON.stringify(saved));
    await loadGithub(dir);
    expect(githubLogin()).toBe("octo");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 401 })));
    await expect(githubApi("/user")).rejects.toThrow(/Connect GitHub again/);
    expect(githubLogin()).toBeNull();
    expect(await readStoredGithub(path.join(dir, "github.json"))).toEqual(saved);
  });

  it("keeps the connection in memory when the file can't be read", async () => {
    const good = await workspaceWith(JSON.stringify({ ...saved, token: "test-token-good" }));
    await loadGithub(good);
    expect(githubLogin()).toBe("octo");
    const broken = await workspaceWith("{");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await loadGithub(broken);
    expect(githubLogin()).toBe("octo");
  });

  it("refreshes an expired GitHub App sign-in and retries", async () => {
    const dir = await workspaceWith(JSON.stringify({ ...saved, token: "test-old", refreshToken: "test-refresh", expiresAt: Date.now() + 3_600_000 }));
    await loadGithub(dir);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/login/oauth/access_token")) {
        expect(JSON.parse(String(init?.body))).toMatchObject({ grant_type: "refresh_token", refresh_token: "test-refresh" });
        return Response.json({ access_token: "test-new", refresh_token: "test-refresh-2", expires_in: 28_800 });
      }
      const auth = (init?.headers as Record<string, string>).Authorization;
      return auth === "Bearer test-new" ? Response.json({ login: "octo" }) : new Response("{}", { status: 401 });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(githubApi("/user")).resolves.toEqual({ login: "octo" });
    expect(githubLogin()).toBe("octo");
    expect(await readStoredGithub(path.join(dir, "github.json"))).toMatchObject({ token: "test-new", refreshToken: "test-refresh-2" });
  });

  it("reads no connection when the file doesn't exist", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lens-gh-"));
    expect(await readStoredGithub(path.join(dir, "github.json"))).toBeNull();
  });
});
