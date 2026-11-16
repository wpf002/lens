/**
 * Identifies the Lens build that made a graph. A server running a newer build sees a different id
 * on a saved graph and rescans it, so changed checks show up without the user reopening the project.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CODE_FILE = /\.(js|ts)$/;
const DECLARATION_FILE = /\.d\.ts$/;
const BUILD_ID_LENGTH = 16;

let cachedBuild: string | undefined;

/** A hash of the analysis engine's own code files, stable across restarts of the same build. */
export function scannerBuild(): string {
  if (cachedBuild) return cachedBuild;
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const files = readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((file) => CODE_FILE.test(file) && !DECLARATION_FILE.test(file))
    .sort();
  const hash = createHash("sha256");
  for (const file of files) hash.update(file).update(readFileSync(path.join(dir, file)));
  cachedBuild = hash.digest("hex").slice(0, BUILD_ID_LENGTH);
  return cachedBuild;
}

/** True when a saved codebase graph came from a different Lens build than the one running. */
export function madeByOtherBuild(graph: { kind: string; project: { scannerBuild?: string } }): boolean {
  return graph.kind === "codebase" && graph.project.scannerBuild !== scannerBuild();
}
