/**
 * `lens probe`: send safe dynamic checks to a local or named staging copy of the
 * app and fold the results into the security report.
 */
import path from "node:path";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { promises as fs, readFileSync } from "node:fs";
import {
  ProbeConfigSchema, applyProbeResults, checkTarget, evaluateExchanges, formatZodError, paths, planProbes,
  resolveAccounts, resolveTarget, runProbes, type KnowledgeGraph, type ProbeConfig, type ProbeLogEntry, type ProbePlan,
} from "@lens/core";

export const PROBE_CONFIG_FILE = "probe.json";
export const PROBE_LOG_FILE = "probe-log.jsonl";
const RUN_ID_BYTES = 4;

export interface ProbeCommandOptions {
  target: string;
  stagingHost?: string;
  dryRun?: boolean;
  yes?: boolean;
  json?: boolean;
}

export interface ProbeIo {
  out: (x: unknown) => void;
  log: (m: string) => void;
  isTty: boolean;
  confirm: (question: string) => Promise<boolean>;
}

export class ProbeCommandError extends Error {}

export async function askYesNo(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
  } finally {
    rl.close();
  }
}

async function loadProbeConfig(root: string): Promise<ProbeConfig> {
  const file = path.join(paths(root).dir, PROBE_CONFIG_FILE);
  let raw: unknown = {};
  try {
    raw = JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw new ProbeCommandError(`Can't read ${file}: ${(error as Error).message}`);
  }
  const parsed = ProbeConfigSchema.safeParse(raw);
  if (!parsed.success) throw new ProbeCommandError(`Invalid ${PROBE_CONFIG_FILE}: ${formatZodError(parsed.error)}`);
  return parsed.data;
}

function parseTarget(raw: string): URL {
  try {
    return new URL(raw);
  } catch {
    throw new ProbeCommandError(`--target must be a full URL like http://localhost:3000, got ${raw}`);
  }
}

function hostOf(homepage: string | undefined): string | undefined {
  if (!homepage) return undefined;
  try {
    return new URL(homepage).hostname;
  } catch {
    return undefined;
  }
}

function describePlan(plan: ProbePlan, target: URL): string[] {
  const lines = plan.requests.map((r) => `${r.method.padEnd(4)} ${target.origin}${r.path}${r.account ? `  (account ${r.account})` : ""}  [${r.kind}]`);
  for (const s of plan.skipped) lines.push(`skip ${s.endpointId}: ${s.reason}`);
  if (plan.truncated) lines.push(`${plan.truncated} requests dropped by maxRequests`);
  return lines;
}

/** Returns true when the graph changed and should be saved. */
export async function runProbeCommand(root: string, graph: KnowledgeGraph, options: ProbeCommandOptions, io: ProbeIo): Promise<boolean> {
  if (!graph.security) throw new ProbeCommandError("No security report; run `lens security` first.");
  const target = parseTarget(options.target);
  const config = await loadProbeConfig(root);
  checkTarget({ target, stagingHost: options.stagingHost, homepageHost: hostOf(graph.project.homepage) });
  const pinned = await resolveTarget(target.hostname);
  const accounts = resolveAccounts(config, process.env);
  const plan = planProbes(graph, config, { runId: randomBytes(RUN_ID_BYTES).toString("hex"), accountsConfigured: !!accounts });

  if (options.dryRun) {
    if (options.json) io.out({ target: target.origin, pinnedAddress: pinned.address, ...plan });
    else io.out(describePlan(plan, target).join("\n"));
    return false;
  }

  const prompt = `Send ${plan.requests.length} requests to ${target.origin} (${pinned.address}) at ${config.rateLimit}/s?`;
  if (!options.yes) {
    if (!io.isTty) throw new ProbeCommandError("Pass --yes to probe without a terminal prompt.");
    if (!(await io.confirm(prompt))) {
      io.log("probe cancelled");
      return false;
    }
  }

  const logFile = path.join(paths(root).dir, PROBE_LOG_FILE);
  const logLines: string[] = [];
  const result = await runProbes(plan.requests, {
    target,
    pinned,
    rateLimit: config.rateLimit,
    maxRequests: config.maxRequests,
    safePosts: new Set(config.safeToProbe),
    accounts,
    log: (entry: ProbeLogEntry) => void logLines.push(JSON.stringify(entry)),
  });
  await fs.appendFile(logFile, logLines.length ? logLines.join("\n") + "\n" : "");

  const evaluation = evaluateExchanges(result.exchanges, { marker: plan.marker, https: target.protocol === "https:" });
  const readFile = (file: string) => {
    try {
      return readFileSync(path.join(root, file), "utf8");
    } catch {
      return undefined;
    }
  };
  const report = applyProbeResults(graph, evaluation, { readFile });
  const failed = result.exchanges.filter((e) => e.error).length;
  const summary = { sent: result.exchanges.length, failed, stoppedReason: result.stoppedReason, ...report, observations: evaluation.observations };
  if (options.json) {
    io.out(summary);
    return true;
  }
  io.out(`Probed ${target.origin}: ${summary.sent} requests, ${failed} failed${result.stoppedReason ? `, ${result.stoppedReason}` : ""}`);
  io.out(`  ${report.confirmed} confirmed · ${report.cleared} cleared · ${report.added} new · ${report.removed} resolved`);
  for (const o of evaluation.observations) io.out(`  ${o.kind.padEnd(16)} ${o.evidence}`);
  io.log(`request log: ${path.relative(root, logFile)}`);
  return true;
}
