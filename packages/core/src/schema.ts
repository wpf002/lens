/** Zod schemas for the graph and every agent patch format. Browser-safe. */
import { z } from "zod";
import { EDGE_KINDS, NODE_KINDS, SEMANTIC_EDGE_KINDS } from "./types.js";

const complexity = z.enum(["simple", "moderate", "complex"]);
const severity = z.enum(["critical", "high", "medium", "low", "info"]);
const lineRange = z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]);
/** Agents write prose; cap it so a runaway response can't bloat the graph. */
const prose = (max: number) => z.string().trim().min(1).max(max);
/** Long AI-written text gets trimmed instead of failing a whole paid run. */
const clip = (max: number) => z.string().trim().min(1).transform((s) => (s.length > max ? s.slice(0, max - 1) + "…" : s));
const tag = z.string().trim().min(1).max(40).regex(/^[\w.:/#+-]+$/, "tags are single tokens");

export const GraphNodeSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(NODE_KINDS),
  name: z.string(),
  path: z.string().optional(),
  lines: lineRange.optional(),
  language: z.string().optional(),
  summary: z.string(),
  summarySource: z.enum(["heuristic", "llm"]),
  tags: z.array(z.string()),
  complexity,
  layer: z.string().optional(),
  signature: z.string().optional(),
  exported: z.boolean().optional(),
  notes: z.string().optional(),
  metrics: z.record(z.string(), z.number().optional()).optional(),
  endpoint: z.object({
    method: z.string().optional(),
    route: z.string(),
    framework: z.string().optional(),
    auth: z.enum(["guarded", "unguarded", "public", "unknown"]),
    authEvidence: z.string().optional(),
    entryType: z.enum(["http", "rpc", "cli", "event", "cron", "webhook", "server-action"]),
    handlerId: z.string().optional(),
  }).optional(),
  domain: z.object({
    entities: z.array(z.string()).optional(),
    businessRules: z.array(z.string()).optional(),
    entryPoint: z.string().optional(),
    entryType: z.enum(["http", "cli", "event", "cron", "manual"]).optional(),
  }).optional(),
  knowledge: z.object({
    wikilinks: z.array(z.string()).optional(),
    backlinks: z.array(z.string()).optional(),
    category: z.string().optional(),
    frontmatter: z.record(z.string(), z.string()).optional(),
  }).optional(),
  stale: z.boolean().optional(),
});

export const GraphEdgeSchema = z.object({
  source: z.string(),
  target: z.string(),
  kind: z.enum(EDGE_KINDS),
  weight: z.number().min(0).max(1),
  label: z.string().optional(),
  evidence: z.object({ path: z.string(), line: z.number().optional() }).optional(),
  origin: z.enum(["static", "llm", "heuristic"]),
});

export const LayerSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: prose(40),
  description: prose(400),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  rank: z.number().int().min(0).max(20),
  nodeIds: z.array(z.string()),
});

export const TourStepSchema = z.object({
  order: z.number().int().positive(),
  title: prose(80),
  description: prose(1200),
  nodeIds: z.array(z.string()).min(1).max(8),
  lesson: prose(600).optional(),
});

export const FindingSchema = z.object({
  id: z.string(),
  rule: z.string(),
  title: z.string(),
  category: z.string(),
  cwe: z.string().optional(),
  severity,
  confidence: z.enum(["high", "medium", "low"]),
  path: z.string(),
  line: z.number(),
  nodeId: z.string(),
  message: z.string(),
  snippet: z.string().optional(),
  tainted: z.boolean().optional(),
  reachableFrom: z.array(z.string()),
  status: z.enum(["open", "confirmed", "false_positive", "accepted"]),
  triageNote: z.string().optional(),
});

export const KnowledgeGraphSchema = z.object({
  schema: z.literal("lens/1"),
  kind: z.enum(["codebase", "knowledge"]),
  project: z.object({
    name: z.string(),
    description: z.string(),
    languages: z.array(z.string()),
    frameworks: z.array(z.string()),
    analyzedAt: z.string(),
    gitCommit: z.string().optional(),
    root: z.string().optional(),
    homepage: z.string().url().max(300).optional(),
  }),
  nodes: z.array(GraphNodeSchema),
  edges: z.array(GraphEdgeSchema),
  layers: z.array(LayerSchema.extend({ name: z.string(), description: z.string() })),
  tour: z.array(TourStepSchema.extend({ description: z.string(), nodeIds: z.array(z.string()) })),
  security: z.object({
    generatedAt: z.string(),
    rulesVersion: z.string(),
    entryPoints: z.array(z.string()),
    findings: z.array(FindingSchema),
    exposure: z.array(z.object({ findingId: z.string(), entryId: z.string(), path: z.array(z.string()) })),
    summary: z.object({
      bySeverity: z.record(z.string(), z.number()),
      unguardedEndpoints: z.number(),
      guardedEndpoints: z.number(),
      publicEndpoints: z.number(),
      riskScore: z.number(),
    }),
    checklist: z.array(z.object({
      id: z.string(),
      tier: z.union([z.literal(1), z.literal(2), z.literal(3)]),
      title: z.string(),
      status: z.enum(["pass", "fail", "clear", "unverified", "manual", "na"]),
      evidence: z.array(z.string()),
      fix: z.string().optional(),
      source: z.enum(["scanner", "repo", "ai", "manual"]),
    })).optional(),
  }).optional(),
  health: z.object({
    generatedAt: z.string(),
    score: z.number(),
    checks: z.array(z.object({
      id: z.string(),
      title: z.string(),
      category: z.string(),
      severity: z.enum(["high", "medium", "low"]),
      count: z.number(),
      hits: z.array(z.object({ path: z.string(), line: z.number().optional(), detail: z.string() })),
      fix: z.string(),
      source: z.enum(["scanner", "ai"]).optional(),
    })),
  }).optional(),
  stats: z.object({
    files: z.number(),
    nodes: z.number(),
    edges: z.number(),
    loc: z.number(),
    byKind: z.record(z.string(), z.number()),
    enrichedNodes: z.number(),
  }),
});

/* ---------------- agent patches ---------------- */

export const EnrichPatchSchema = z.object({
  nodes: z.array(z.object({
    id: z.string(),
    summary: prose(700),
    tags: z.array(tag).max(8).optional(),
    complexity: complexity.optional(),
    notes: prose(500).optional(),
  })).max(2000),
  edges: z.array(z.object({
    source: z.string(),
    target: z.string(),
    kind: z.enum(SEMANTIC_EDGE_KINDS),
    label: prose(120).optional(),
  })).max(2000).optional(),
  concepts: z.array(z.object({
    name: prose(60),
    summary: prose(500),
    nodeIds: z.array(z.string()).min(2).max(30),
  })).max(20).optional(),
});

export const LayersPatchSchema = z.object({ layers: z.array(LayerSchema).min(1).max(12) });

export const TourPatchSchema = z.object({ tour: z.array(TourStepSchema).min(3).max(15) });

export const DomainPatchSchema = z.object({
  domains: z.array(z.object({
    name: prose(60),
    summary: prose(600),
    entities: z.array(prose(60)).max(20).optional(),
    businessRules: z.array(prose(240)).max(20).optional(),
    flows: z.array(z.object({
      name: prose(80),
      summary: prose(600),
      entryPoint: z.string().optional(),
      entryType: z.enum(["http", "cli", "event", "cron", "manual"]).optional(),
      steps: z.array(z.object({ name: prose(80), summary: prose(400), nodeIds: z.array(z.string()).max(10) })).min(1).max(15),
    })).min(1).max(15),
  })).min(1).max(15),
  crossDomain: z.array(z.object({ from: z.string(), to: z.string(), label: prose(160) })).max(40).optional(),
});

/** What the security-auditor agent writes next to SECURITY_AUDIT.md. */
export const AuditVerdictsSchema = z.object({
  summary: clip(600).optional(),
  items: z.array(z.object({
    id: z.string().max(40), // unknown ids are dropped against the checklist
    status: z.enum(["pass", "fail", "unverified", "na"]),
    evidence: z.array(z.string().transform((x) => x.slice(0, 300))).transform((a) => a.slice(0, 8)).default([]),
    fix: z.string().transform((x) => x.slice(0, 400)).optional(),
  })).transform((a) => a.slice(0, 60)),
});
export type AuditVerdicts = z.infer<typeof AuditVerdictsSchema>;

/** What the code-reviewer agent writes next to CODE_REVIEW.md. */
export const ReviewFindingsSchema = z.object({
  summary: clip(600).optional(),
  findings: z.array(z.object({
    title: clip(140),
    severity: z.enum(["high", "medium", "low"]),
    // An unknown category shouldn't throw away the whole review.
    category: z.enum(["design", "over-engineering", "duplication", "errors", "consistency", "ai-habits", "tests", "performance", "naming"]).catch("design"),
    path: z.string().max(400),
    line: z.number().int().positive().optional(),
    detail: clip(600),
    fix: clip(600).optional(),
  })).transform((a) => a.slice(0, 40)),
});
export type ReviewFindings = z.infer<typeof ReviewFindingsSchema>;

/** What the remediator agent proposes. Lens validates and the user approves before anything is applied. */
export const RemediationSchema = z.object({
  summary: clip(600).optional(),
  fixes: z.array(z.object({
    itemId: z.string().max(80),
    title: clip(140),
    explanation: clip(600),
    edits: z.array(z.object({
      path: z.string().min(1).max(400),
      find: z.string().max(40_000).default(""),
      replace: z.string().max(80_000).default(""),
      /** Remove the whole file (unused files, stale docs). */
      delete: z.boolean().optional(),
    })).min(1).max(40),
  })).transform((a) => a.slice(0, 30)),
  skipped: z.array(z.object({ itemId: z.string().max(80), reason: clip(600) })).transform((a) => a.slice(0, 60)).default([]),
});
export type Remediation = z.infer<typeof RemediationSchema>;

/** What the remediator reports after editing a copy of the project. Lens diffs the copy for the edits. */
export const WorkspaceReportSchema = z.object({
  summary: clip(600).optional(),
  fixes: z.array(z.object({
    itemId: z.string().max(80),
    title: clip(140),
    explanation: clip(600),
    files: z.array(z.string().max(400)).max(200).default([]),
  })).transform((a) => a.slice(0, 30)),
  skipped: z.array(z.object({ itemId: z.string().max(80), reason: clip(600) })).transform((a) => a.slice(0, 60)).default([]),
});
export type WorkspaceReport = z.infer<typeof WorkspaceReportSchema>;

export const TriagePatchSchema = z.object({
  findings: z.array(z.object({
    id: z.string(),
    status: z.enum(["open", "confirmed", "false_positive", "accepted"]),
    severity: severity.optional(),
    note: prose(800),
  })).max(2000),
  added: z.array(z.object({
    rule: z.string().regex(/^[a-z0-9-]+$/),
    title: prose(120),
    category: z.enum(["injection", "command-exec", "code-exec", "xss", "ssrf", "path-traversal", "deserialization", "secrets", "crypto", "tls", "auth", "config", "redirect", "mass-assignment", "dependency"]),
    cwe: z.string().regex(/^CWE-\d+$/).optional(),
    severity,
    confidence: z.enum(["high", "medium", "low"]),
    path: z.string(),
    line: z.number().int().positive(),
    message: prose(800),
    snippet: z.string().max(200).optional(),
    tainted: z.boolean().optional(),
    nodeId: z.string().optional(),
  })).max(200).optional(),
});

export type PatchKind = "enrich" | "layers" | "tour" | "domain" | "triage";
export const PATCH_SCHEMAS = {
  enrich: EnrichPatchSchema,
  layers: LayersPatchSchema,
  tour: TourPatchSchema,
  domain: DomainPatchSchema,
  triage: TriagePatchSchema,
} as const;

export function formatZodError(e: z.ZodError): string {
  return e.issues.slice(0, 12).map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
}
