/** Constants and helpers every health check shares. */
import type { HealthHit } from "./health.js";

export const MAX_HITS = 40;
export const CODE_LANGS = new Set(["typescript", "tsx", "javascript", "python", "go", "rust", "java", "kotlin", "ruby", "php", "csharp", "swift", "dart"]);
export const JS_LANGS = new Set(["typescript", "tsx", "javascript"]);
export const ENTRY_RE = /(^|\/)(src\/)?(index|main|app|server|cli|__main__|__init__|manage|wsgi|asgi|program|Application|conftest|setup|vite\.config|next\.config|tailwind\.config|postcss\.config|eslint\.config|vitest\.config|jest\.config)\.[a-z]+$/i;
export const GENERATED = /(^|\/)(dist|build|out|vendor|generated|__generated__|\.next)\//;

export const lineOf = (src: string, index: number) => src.slice(0, index).split("\n").length;

export function push(hits: HealthHit[], h: HealthHit) {
  if (hits.length < MAX_HITS) hits.push(h);
}

/** Replace string literal contents with spaces so patterns over code don't match text. Line numbers are kept. */
export function blankStrings(src: string): string {
  return src.replace(/(["'`])(?:\\.|(?!\1)[^\\\n])*\1/g, (m) => m[0] + " ".repeat(m.length - 2) + m[0]);
}
