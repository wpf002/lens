import type { ImpactReport } from "../types.js";
import type { HealthCheck, HealthHit, HealthReport } from "./health.js";

type ChangedFile = ImpactReport["changedFiles"][number];

/** Checks about the project as a whole, or about work that's fine to leave for later, never block a change. */
const NOT_ABOUT_THE_CHANGE = new Set(["untested", "readme-boilerplate", "stale-docs", "unused-deps", "inconsistent-libs", "hotspots"]);

export interface ChangedHealthCheck {
  id: string;
  title: string;
  severity: HealthCheck["severity"];
  fix: string;
  hits: HealthHit[];
}

/** True when the hit is on a line the change added or edited. A hit with no line counts only in a new file. */
function inChange(hit: HealthHit, file: ChangedFile | undefined): boolean {
  if (!file || file.status === "D") return false;
  if (file.status === "A") return true;
  if (hit.line === undefined) return false;
  return file.hunks.some(([start, end]) => hit.line! >= start && hit.line! <= end);
}

/** The Health hits a change introduced, grouped by check. */
export function healthOfChange(report: HealthReport, changes: ChangedFile[]): ChangedHealthCheck[] {
  const byPath = new Map(changes.map((c) => [c.path, c]));
  return report.checks
    .filter((c) => c.source !== "ai" && !NOT_ABOUT_THE_CHANGE.has(c.id))
    .map((c) => ({ id: c.id, title: c.title, severity: c.severity, fix: c.fix, hits: c.hits.filter((h) => inChange(h, byPath.get(h.path))) }))
    .filter((c) => c.hits.length > 0);
}
