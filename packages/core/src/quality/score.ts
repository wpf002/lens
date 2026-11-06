/** Health score math. Browser-safe so the dashboard can score what's still open. */
import type { HealthSeverity } from "./health.js";

/** Points off per open item, and the most items in one group that count. */
const WEIGHT: Record<HealthSeverity, { perItem: number; cap: number }> = {
  high: { perItem: 6, cap: 5 },
  medium: { perItem: 1.5, cap: 10 },
  low: { perItem: 0.4, cap: 20 },
};

/** One automatic check's open hits, or one review finding (open: 1). */
export interface ScoreGroup {
  severity: HealthSeverity;
  open: number;
}

/** 0-100. Each group's penalty is capped so one noisy check can't sink the score alone. */
export function healthScore(groups: ScoreGroup[]): number {
  const penalty = groups.reduce((sum, g) => sum + WEIGHT[g.severity].perItem * Math.min(Math.max(0, g.open), WEIGHT[g.severity].cap), 0);
  return Math.max(0, Math.round(100 - penalty));
}
