/** Browser-safe surface of @lens/core. The dashboard imports only from here. */
export * from "./types.js";
export * from "./search.js";
export * from "./graph-utils.js";
export type { ChecklistItem, CheckStatus } from "./security/checklist.js";
export type { HealthCategory, HealthCheck, HealthHit, HealthReport, HealthSeverity } from "./quality/health.js";
