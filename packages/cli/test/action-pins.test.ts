import { describe, it, expect } from "vitest";
import { actionPinFix, parseActionRef } from "../src/action-pins.js";

const SHA = "b".repeat(40);

describe("actionPinFix", () => {
  it("gives the exact pinned line with the looked-up SHA", async () => {
    const fix = await actionPinFix("      - uses: pnpm/action-setup@v4", async (repo, ref) => (repo === "pnpm/action-setup" && ref === "v4" ? SHA : "x"));
    expect(fix).toBe(`Replace \`pnpm/action-setup@v4\` with \`pnpm/action-setup@${SHA} # v4\`.`);
  });

  it("keeps a multi-action repo's subdirectory", async () => {
    expect(await actionPinFix("- uses: github/codeql-action/init@v3", async () => SHA)).toContain(`github/codeql-action/init@${SHA} # v3`);
  });

  it("returns nothing when the lookup fails or the action is already pinned", async () => {
    expect(await actionPinFix("- uses: some-org/tool@v2", async () => Promise.reject(new Error("offline")))).toBeUndefined();
    expect(parseActionRef(`- uses: some-org/tool@${SHA}`)).toBeNull();
    expect(parseActionRef("- uses: ./local-action")).toBeNull();
  });
});
