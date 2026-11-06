import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["test/**/*.test.ts"], testTimeout: 30000, env: { LENS_OFFLINE: "1" } } });
