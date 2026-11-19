import type { DataMode, Meta, ReviewRecord } from "../api";

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

/** True while the counts would still miss fixes the server knows about. */
export const awaitingRemediation = (s: { mode: DataMode; meta: Meta | null; remediationLoaded: boolean }): boolean =>
  s.mode === "server" && !!s.meta?.canEnrich && !s.remediationLoaded;

export type ItemStatus = { kind: "open"; reason?: string } | { kind: "fixed"; label: string } | { kind: "safe"; reason: string } | { kind: "wontfix" };
/** Items behind one issue row. A check row stands for every hit it found, which can be more than it lists. */
export type Tally = { open: number; asking: number; closed: number };

export const needsYou = (st: ItemStatus): boolean => st.kind === "open" && !!st.reason;

/** A check can store more hits than its count (duplicates counts groups, stores each copy), so items are the larger of the two. */
export function tallyItems(count: number, states: ItemStatus[]): Tally {
  const closed = states.filter((st) => st.kind !== "open").length;
  return { open: Math.max(0, Math.max(count, states.length) - closed), asking: states.filter(needsYou).length, closed };
}

export const sumTallies = (tallies: Tally[]): Tally =>
  tallies.reduce((sum, t) => ({ open: sum.open + t.open, asking: sum.asking + t.asking, closed: sum.closed + t.closed }), { open: 0, asking: 0, closed: 0 });
