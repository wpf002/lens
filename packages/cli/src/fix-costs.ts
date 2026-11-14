import path from "node:path";
import { z } from "zod";
import { paths, readJson, writeJsonAtomic } from "@lens/core";

/** Batch fixes and refactors cost very different amounts per item, so each keeps its own history. */
export type FixKind = "batch" | "refactor";
export interface ItemRate {
  low: number;
  high: number;
}

const FixRunCostSchema = z.object({ items: z.number().int().positive(), usd: z.number().nonnegative() });
const FixCostLogSchema = z.object({ batch: z.array(FixRunCostSchema).optional(), refactor: z.array(FixRunCostSchema).optional() });
export type FixRunCost = z.infer<typeof FixRunCostSchema>;
type FixCostLog = z.infer<typeof FixCostLogSchema>;

const KEPT_RUNS = 30;
/** Fewer runs than this is too little to price from, so the default rate stays. */
export const MIN_MEASURED_RUNS = 3;
const LOW_QUANTILE = 0.25;
const HIGH_QUANTILE = 0.75;

const fixCostsPath = (root: string) => path.join(paths(root).dir, "fix-costs.json");

export async function loadFixCosts(root: string): Promise<FixCostLog> {
  const parsed = FixCostLogSchema.safeParse(await readJson<unknown>(fixCostsPath(root)));
  return parsed.success ? parsed.data : {};
}

export async function recordFixCost(root: string, kind: FixKind, run: FixRunCost): Promise<void> {
  const log = await loadFixCosts(root);
  log[kind] = [...(log[kind] ?? []), run].slice(-KEPT_RUNS);
  await writeJsonAtomic(fixCostsPath(root), log, true);
}

/** Per-item cost at the 25th and 75th percentile of recent runs, or the fallback until enough runs are logged. */
export function itemRate(runs: FixRunCost[] | undefined, fallback: ItemRate): ItemRate {
  const rates = (runs ?? []).map((r) => r.usd / r.items).sort((a, b) => a - b);
  if (rates.length < MIN_MEASURED_RUNS) return fallback;
  const at = (q: number) => rates[Math.min(rates.length - 1, Math.floor(q * rates.length))]!;
  return { low: at(LOW_QUANTILE), high: at(HIGH_QUANTILE) };
}
