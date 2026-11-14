import type { ReviewRecord } from "../api";

export const SEV_ORDER = { high: 0, medium: 1, low: 2 } as const;

export interface IssueOrder {
  severity: keyof typeof SEV_ORDER;
  /** Found by the latest review run, or brought back by it. */
  fresh: boolean;
  asks: boolean;
}

/** Found since the latest review run began. generatedAt moves on every batch, so older records fall back to it. */
export function isNewFinding(foundAt: string | undefined, review: Pick<ReviewRecord, "generatedAt" | "runStartedAt">): boolean {
  if (!foundAt) return false;
  return foundAt >= (review.runStartedAt ?? review.generatedAt);
}

/** Highest severity first; within a severity, new findings, then rows waiting on the owner. */
export function compareIssues(a: IssueOrder, b: IssueOrder): number {
  return SEV_ORDER[a.severity] - SEV_ORDER[b.severity] || Number(b.fresh) - Number(a.fresh) || Number(b.asks) - Number(a.asks);
}
