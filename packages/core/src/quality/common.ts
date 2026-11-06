import type { HealthHit } from "./health.js";

export const MAX_HITS = 40;
export const CODE_LANGS = new Set(["typescript", "tsx", "javascript", "python", "go", "rust", "java", "kotlin", "ruby", "php", "csharp", "swift", "dart"]);
export const JS_LANGS = new Set(["typescript", "tsx", "javascript"]);
export const GENERATED = /(^|\/)(dist|build|out|vendor|generated|__generated__|\.next)\//;

export const lineOf = (src: string, index: number) => src.slice(0, index).split("\n").length;

export function push(hits: HealthHit[], h: HealthHit) {
  if (hits.length < MAX_HITS) hits.push(h);
}
