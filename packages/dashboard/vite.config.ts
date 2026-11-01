/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// Builds one self-contained dist/index.html (all JS/CSS inlined).
// public/ holds dev-only fixtures (sample-graph.json, sample-diff.json) and is
// intentionally NOT copied into the production build.
export default defineConfig({
  plugins: [react(), tailwindcss(), viteSingleFile({ removeViteModuleLoader: true })],
  build: {
    copyPublicDir: false,
    target: "es2022",
    chunkSizeWarningLimit: 8000,
    assetsInlineLimit: 100_000_000,
  },
  worker: { format: "es" },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
