// Copy the single-file dashboard build next to the CLI so `lens serve` works from dist alone.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, "../../dashboard/dist/index.html");
const dst = path.resolve(here, "../dist/dashboard.html");
if (!existsSync(src)) {
  console.warn("[lens] dashboard build not found; run `pnpm --filter @lens/dashboard build` first. `lens serve` will be unavailable.");
  process.exit(0);
}
mkdirSync(path.dirname(dst), { recursive: true });
copyFileSync(src, dst);
console.log("[lens] dashboard copied to dist/dashboard.html");
