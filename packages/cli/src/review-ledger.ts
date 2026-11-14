/**
 * The review ledger: every finding the code review has ever made, in .lens/review.json.
 * Findings are only appended, so a finding's id (review-<index>) never changes and fixes,
 * skips, and Won't Fix decisions stay attached to it across reviews. Coverage records the
 * content hash of each file as of its last review, so each run reviews only new or changed
 * files and the first run reviews all of them.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { paths, readJson, reviewKey, writeJsonAtomic, type ReviewFindings } from "@lens/core";

type AgentFinding = ReviewFindings["findings"][number];
export type StoredFinding = Omit<AgentFinding, "priorId"> & {
  /** When the review first reported it. */
  foundAt?: string;
  /** Set when a later review confirmed the problem is gone, or its file was deleted. */
  resolvedAt?: string;
  /** Index of the closed finding this one brings back. */
  regressionOf?: number;
  /** Found by the check Lens runs on its own fixes. */
  byFix?: boolean;
};

/** Stored at .lens/review.json; survives rescans. */
export interface ReviewRecord {
  generatedAt: string;
  /** When the latest full review run began. Findings found since then show as New. */
  runStartedAt?: string;
  costUsd?: number;
  summary?: string;
  report: string;
  findings: StoredFinding[];
  /** Since this time, finding ids have been stable. Remediation records older than this used other numbering. */
  stableSince?: string;
}

export type FindingStatus = "open" | "closed" | "wontfix";
export interface MergeContext {
  /** Paths reviewed in this run. Only their open findings can be resolved. */
  reviewed: Set<string>;
  /** Paths that still exist in the project. */
  existing: Set<string>;
  /** Indexes Lens fixed or found already safe. */
  fixed: Set<number>;
  /** reviewKeys the owner closed as Won't Fix. */
  wontFix: Set<string>;
  now: string;
  byFix?: boolean;
}

export const REVIEW_ID = /^review-(\d+)$/;
export const reviewId = (i: number) => `review-${i}`;
export const reviewIndex = (id: string): number | undefined => {
  const m = REVIEW_ID.exec(id);
  return m ? Number(m[1]) : undefined;
};

export function findingStatus(f: StoredFinding, i: number, ctx: Pick<MergeContext, "fixed" | "wontFix">): FindingStatus {
  if (ctx.wontFix.has(reviewKey(f))) return "wontfix";
  return f.resolvedAt || ctx.fixed.has(i) ? "closed" : "open";
}

/**
 * Fold one review pass into the ledger. A re-reported open finding is refreshed in place;
 * a re-reported closed one comes back as a new regression; a re-reported Won't Fix is dropped.
 * Open findings close only when the reviewer lists them as resolved or their file is gone.
 */
export function mergeReview(prior: StoredFinding[], output: Pick<ReviewFindings, "findings" | "resolved">, ctx: MergeContext): { findings: StoredFinding[]; added: number[] } {
  const findings = prior.map((f) => ({ ...f }));
  const priorCount = findings.length;
  const latestByKey = new Map<string, number>();
  findings.forEach((f, i) => latestByKey.set(reviewKey(f), i));
  const refreshed = new Set<number>();
  const regressed = new Set<number>();
  const added: number[] = [];
  const append = (f: StoredFinding) => {
    findings.push(f);
    latestByKey.set(reviewKey(f), findings.length - 1);
    added.push(findings.length - 1);
  };

  for (const { priorId, ...f } of output.findings) {
    const claimed = priorId ? reviewIndex(priorId) : undefined;
    const match = claimed !== undefined && claimed < priorCount && findings[claimed]!.path === f.path ? claimed : latestByKey.get(reviewKey(f));
    if (match === undefined) {
      append({ ...f, foundAt: ctx.now, ...(ctx.byFix ? { byFix: true } : {}) });
      continue;
    }
    const status = findingStatus(findings[match]!, match, ctx);
    if (status === "wontfix") continue;
    if (status === "open") {
      const { severity, category, line, detail, fix } = f;
      findings[match] = { ...findings[match]!, severity, category, line, detail, fix };
      refreshed.add(match);
      continue;
    }
    if (regressed.has(match)) continue;
    regressed.add(match);
    append({ ...f, foundAt: ctx.now, regressionOf: match, ...(ctx.byFix ? { byFix: true } : {}) });
  }

  const resolve = (i: number) => {
    findings[i] = { ...findings[i]!, resolvedAt: ctx.now };
  };
  for (const id of output.resolved) {
    const i = reviewIndex(id);
    if (i === undefined || i >= priorCount || refreshed.has(i)) continue;
    if (ctx.reviewed.has(findings[i]!.path) && findingStatus(findings[i]!, i, ctx) === "open") resolve(i);
  }
  for (let i = 0; i < priorCount; i++) if (!ctx.existing.has(findings[i]!.path) && findingStatus(findings[i]!, i, ctx) === "open") resolve(i);
  return { findings, added };
}

/** What the reviewer is told about earlier findings in the files it's reviewing. */
export function priorFindingsFor(findings: StoredFinding[], files: Set<string>, ctx: Pick<MergeContext, "fixed" | "wontFix">) {
  return findings
    .map((f, i) => ({ f, i }))
    .filter(({ f }) => files.has(f.path))
    .map(({ f, i }) => ({ id: reviewId(i), status: findingStatus(f, i, ctx), title: f.title, severity: f.severity, path: f.path, line: f.line, detail: f.detail }));
}

export interface ReviewFile {
  path: string;
  loc: number;
}
export const BATCH_MAX_FILES = 25;
export const BATCH_MAX_LOC = 4_000;
/** One file's share of a batch, so one huge file doesn't take a batch alone for nothing. */
const FILE_LOC_CAP = 1_500;

/** Files grouped by directory into batches the reviewer can read completely. */
export function planBatches(files: ReviewFile[], maxFiles = BATCH_MAX_FILES, maxLoc = BATCH_MAX_LOC): ReviewFile[][] {
  const batches: ReviewFile[][] = [];
  let current: ReviewFile[] = [];
  let loc = 0;
  for (const f of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    const size = Math.min(f.loc, FILE_LOC_CAP);
    if (current.length && (current.length >= maxFiles || loc + size > maxLoc)) {
      batches.push(current);
      current = [];
      loc = 0;
    }
    current.push(f);
    loc += size;
  }
  if (current.length) batches.push(current);
  return batches;
}

export type Coverage = Record<string, string>;
const coveragePath = (root: string) => path.join(paths(root).dir, "review-coverage.json");

export async function loadCoverage(root: string): Promise<Coverage> {
  return (await readJson<Coverage>(coveragePath(root))) ?? {};
}
export async function saveCoverage(root: string, coverage: Coverage): Promise<void> {
  await writeJsonAtomic(coveragePath(root), coverage, true);
}

/** Files whose reviewed hash matches what's on disk now. */
export async function coveredFiles(root: string): Promise<Set<string>> {
  const coverage = await loadCoverage(root);
  const hashes = await hashFiles(root, Object.keys(coverage));
  return new Set(Object.keys(coverage).filter((rel) => hashes.get(rel) === coverage[rel]));
}

/** Files reviewed before Lens edited them stay reviewed at their new content. */
export async function keepReviewed(root: string, changed: string[], covered: Set<string>): Promise<void> {
  const kept = changed.filter((rel) => covered.has(rel));
  if (!kept.length) return;
  const coverage = await loadCoverage(root);
  const hashes = await hashFiles(root, kept);
  for (const [rel, hash] of hashes) coverage[rel] = hash;
  await saveCoverage(root, coverage);
}

/** Content hash of each file. Files that can't be read are left out. */
export async function hashFiles(root: string, rels: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  await Promise.all(
    rels.map(async (rel) => {
      const content = await fs.readFile(path.join(root, rel)).catch(() => null);
      if (content) out.set(rel, createHash("sha1").update(content).digest("hex"));
    }),
  );
  return out;
}

/** Files that are new or changed since their last review. */
export function pendingReview(files: ReviewFile[], hashes: Map<string, string>, coverage: Coverage): ReviewFile[] {
  return files.filter((f) => hashes.has(f.path) && coverage[f.path] !== hashes.get(f.path));
}

/** CODE_REVIEW.md, written from the ledger so it always matches the Health page. */
export function renderReport(record: ReviewRecord, ctx: Pick<MergeContext, "fixed" | "wontFix">): string {
  const rows = record.findings.map((f, i) => ({ f, i, status: findingStatus(f, i, ctx) }));
  const open = rows.filter((r) => r.status === "open");
  const order = { high: 0, medium: 1, low: 2 } as const;
  open.sort((a, b) => order[a.f.severity] - order[b.f.severity]);
  const lines = [`# Code Review`, "", `${open.length} open · ${rows.length - open.length} closed · updated ${record.generatedAt}`, ""];
  for (const { f, i } of open) {
    lines.push(`## [${f.severity.toUpperCase()}] ${f.title}`, "", `- Where: \`${f.path}${f.line ? `:${f.line}` : ""}\``, `- Why: ${f.detail}`);
    if (f.fix) lines.push(`- Fix: ${f.fix}`);
    if (f.regressionOf !== undefined) lines.push(`- Regression of ${reviewId(f.regressionOf)}`);
    lines.push(`- Id: ${reviewId(i)}`, "");
  }
  return lines.join("\n");
}
