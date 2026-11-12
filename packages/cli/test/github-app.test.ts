import { createVerify, generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppAuth, appJwt, readAppConfig } from "../src/github-app.js";
import { configureGithubApp, githubApi, githubLogin, listGithubRepos } from "../src/github.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const env = { GITHUB_APP_ID: "12345", GITHUB_APP_PRIVATE_KEY: pem };
const HOUR_MS = 3_600_000;

/** Fake GitHub: one installation, tokens test-inst-1, test-inst-2, … */
function fakeGithub(onApi: (url: string, auth: string) => Response = () => Response.json({})) {
  let minted = 0;
  return vi.fn(async (url: string, init?: RequestInit) => {
    const auth = (init?.headers as Record<string, string>).Authorization ?? "";
    if (url.endsWith("/app/installations")) return Response.json([{ id: 7, account: { login: "octo" } }]);
    if (url.endsWith("/app/installations/7/access_tokens")) {
      minted += 1;
      return Response.json({ token: `test-inst-${minted}`, expires_at: new Date(Date.now() + HOUR_MS).toISOString() });
    }
    return onApi(url, auth);
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  configureGithubApp({});
});

describe("GitHub App config", () => {
  it("is off when nothing is set", () => {
    expect(readAppConfig({})).toBeNull();
  });

  it("fails on a half-set config", () => {
    expect(() => readAppConfig({ GITHUB_APP_ID: "12345" })).toThrow(/GITHUB_APP_PRIVATE_KEY/);
  });

  it("accepts a key pasted on one line with literal \\n", () => {
    const config = readAppConfig({ ...env, GITHUB_APP_PRIVATE_KEY: pem.replace(/\n/g, "\\n") });
    expect(config?.privateKey).toBe(pem);
  });
});

describe("GitHub App auth", () => {
  it("signs a JWT GitHub can verify with the app's public key", () => {
    const jwt = appJwt(readAppConfig(env)!, 1_000_000_000_000);
    const [header, payload, signature] = jwt.split(".");
    const ok = createVerify("RSA-SHA256").update(`${header}.${payload}`).verify(publicKey, Buffer.from(signature!, "base64url"));
    expect(ok).toBe(true);
    expect(JSON.parse(Buffer.from(payload!, "base64url").toString())).toEqual({ iat: 999_999_940, exp: 1_000_000_540, iss: "12345" });
  });

  it("reuses a token until it's near expiry, then mints a new one", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", fakeGithub());
    const auth = new AppAuth(readAppConfig(env)!);
    expect(await auth.token()).toBe("test-inst-1");
    expect(await auth.token()).toBe("test-inst-1");
    expect(auth.login()).toBe("octo");
    expect(await auth.token(Date.now() + HOUR_MS)).toBe("test-inst-2");
  });

  it("mints again and retries when GitHub refuses the token", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", fakeGithub((_url, auth) => (auth === "Bearer test-inst-2" ? Response.json({ ok: true }) : new Response("{}", { status: 401 }))));
    configureGithubApp(env);
    await expect(githubApi("/repos/octo/app")).resolves.toEqual({ ok: true });
    expect(githubLogin()).toBe("octo");
  });

  it("lists the installation's repos, newest push first", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const repositories = [
      { full_name: "octo/old", private: true, pushed_at: "2026-01-01T00:00:00Z" },
      { full_name: "octo/new", private: false, pushed_at: "2026-06-01T00:00:00Z" },
    ];
    vi.stubGlobal("fetch", fakeGithub(() => Response.json({ repositories })));
    configureGithubApp(env);
    expect((await listGithubRepos()).map((r) => r.name)).toEqual(["octo/new", "octo/old"]);
  });
});
