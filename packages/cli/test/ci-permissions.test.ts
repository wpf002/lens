import { describe, it, expect } from "vitest";
import { missingPermissions } from "../src/ci.js";
import { grantJobPermissions } from "../src/ci-permissions.js";

// beza PR #12: gitleaks-action on a pull_request with a read-only default GITHUB_TOKEN.
const GITLEAKS_LOG = [
  "2026-11-10T22:11:43.2181758Z       'x-accepted-github-permissions': 'pull_requests=read',",
  "2026-11-10T22:11:43.2192269Z       message: 'Resource not accessible by integration',",
  "2026-11-10T22:11:43.2194390Z       status: '403'",
].join("\n");

const BEZA_CI = `name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

  secrets:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: gitleaks/gitleaks-action@v2
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
`;

describe("refused workflow permissions", () => {
  it("reads the permission GitHub asked for from a 403 in the job log", () => {
    expect(missingPermissions(GITLEAKS_LOG)).toEqual(["pull-requests: read"]);
    expect(missingPermissions("'x-accepted-github-permissions': 'contents=write,metadata=read; issues=write'\nResource not accessible by integration")).toEqual(["contents: write"]);
  });

  it("ignores logs that aren't a token refusal", () => {
    expect(missingPermissions("'x-accepted-github-permissions': 'pull_requests=read'")).toEqual([]);
    expect(missingPermissions("FAILED tests/test_x.py::test_y")).toEqual([]);
  });
});

describe("grantJobPermissions", () => {
  it("adds a permissions block to only the failing job (beza PR #12)", () => {
    const out = grantJobPermissions(BEZA_CI, "secrets", ["pull-requests: read"])!;
    expect(out).toContain("  secrets:\n    permissions:\n      contents: read\n      pull-requests: read\n    runs-on: ubuntu-latest");
    expect(out).toContain("  build:\n    runs-on: ubuntu-latest");
  });

  it("merges into an existing block and upgrades levels", () => {
    const yaml = "jobs:\n  scan:\n    name: Secret Scan\n    permissions:\n      contents: read\n      pull-requests: none\n    runs-on: x\n";
    expect(grantJobPermissions(yaml, "Secret Scan", ["pull-requests: read"])).toBe(
      "jobs:\n  scan:\n    name: Secret Scan\n    permissions:\n      contents: read\n      pull-requests: read\n    runs-on: x\n",
    );
  });

  it("starts from the workflow-level block, since a job block replaces it", () => {
    const yaml = "permissions:\n  contents: write\njobs:\n  lint:\n    runs-on: x\n";
    expect(grantJobPermissions(yaml, "lint", ["checks: write"])).toContain("  lint:\n    permissions:\n      contents: write\n      checks: write\n    runs-on: x");
  });

  it("matches matrix check names and leaves files alone when nothing changes", () => {
    const yaml = "jobs:\n  test:\n    permissions: { contents: read, pull-requests: read }\n    runs-on: x\n";
    expect(grantJobPermissions(yaml, "test (20)", ["pull-requests: read"])).toBeNull();
    expect(grantJobPermissions(yaml, "other", ["pull-requests: read"])).toBeNull();
    expect(grantJobPermissions("jobs:\n  t:\n    permissions: read-all\n", "t", ["issues: write"])).toBeNull();
  });
});
