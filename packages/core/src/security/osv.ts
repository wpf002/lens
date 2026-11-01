/** Known-vulnerability lookup for declared dependencies via the public OSV API. Opt-in (network). */
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Finding, KnowledgeGraph, Severity } from "../types.js";
import { parseNonCode } from "../noncode.js";
import { summarize } from "./analyze.js";

interface OsvVuln {
  id: string;
  summary?: string;
  aliases?: string[];
  database_specific?: { severity?: string };
  severity?: Array<{ type: string; score: string }>;
}

const MANIFESTS = /(^|\/)(package\.json|requirements\.txt|pyproject\.toml|go\.mod|Cargo\.toml)$/;

function baseVersion(v: string): string | undefined {
  const m = /(\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?)/.exec(v);
  return m?.[1];
}

function sevFrom(v: OsvVuln): Severity {
  const s = v.database_specific?.severity?.toLowerCase();
  if (s === "critical" || s === "high" || s === "low") return s;
  if (s === "moderate" || s === "medium") return "medium";
  const cvss = v.severity?.find((x) => x.type.startsWith("CVSS"))?.score;
  const n = cvss ? Number(/\/?(\d+\.\d)$/.exec(cvss)?.[1] ?? NaN) : NaN;
  if (!Number.isNaN(n)) return n >= 9 ? "critical" : n >= 7 ? "high" : n >= 4 ? "medium" : "low";
  return "medium";
}

export async function osvScan(root: string, g: KnowledgeGraph, opts: { timeoutMs?: number } = {}): Promise<{ added: number; queried: number }> {
  if (!g.security) throw new Error("Run lens scan first.");
  const manifests = g.nodes.filter((n) => n.path && MANIFESTS.test(n.path) && !/node_modules/.test(n.path));
  const queries: Array<{ pkg: string; version: string; ecosystem: string; path: string; nodeId: string; line: number }> = [];
  for (const m of manifests) {
    const src = await fs.readFile(path.join(root, m.path!), "utf8").catch(() => "");
    const lang = m.path!.endsWith("package.json") ? "json" : m.path!.endsWith("requirements.txt") ? "requirements" : m.path!.endsWith("go.mod") ? "gomod" : "toml";
    const info = parseNonCode(m.path!, lang, src);
    if (!info.dependencies || !info.ecosystem) continue;
    for (const [pkg, range] of Object.entries(info.dependencies)) {
      const version = baseVersion(range);
      if (!version || /^(workspace|file|link|git)/.test(range)) continue;
      const line = src.split("\n").findIndex((l) => l.includes(`"${pkg}"`) || l.startsWith(pkg) || l.includes(` ${pkg} `)) + 1;
      queries.push({ pkg, version, ecosystem: info.ecosystem, path: m.path!, nodeId: m.id, line: line || 1 });
    }
  }
  if (!queries.length) return { added: 0, queried: 0 };
  // Drop prior dependency findings; this pass is authoritative for them.
  g.security.findings = g.security.findings.filter((f) => f.category !== "dependency");
  let added = 0;
  for (let i = 0; i < queries.length; i += 500) {
    const chunk = queries.slice(i, i + 500);
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 20000);
    const r = await fetch("https://api.osv.dev/v1/querybatch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ queries: chunk.map((q) => ({ package: { name: q.pkg, ecosystem: q.ecosystem }, version: q.version })) }),
      signal: ctl.signal,
    }).finally(() => clearTimeout(t));
    if (!r.ok) throw new Error(`OSV query failed: ${r.status}`);
    const j = (await r.json()) as { results: Array<{ vulns?: Array<{ id: string }> }> };
    for (let k = 0; k < chunk.length; k++) {
      const vulns = j.results[k]?.vulns ?? [];
      if (!vulns.length) continue;
      const q = chunk[k]!;
      // Fetch details for the worst few only, to keep it fast.
      const details: OsvVuln[] = [];
      for (const v of vulns.slice(0, 5)) {
        const d = await fetch(`https://api.osv.dev/v1/vulns/${encodeURIComponent(v.id)}`).then((x) => (x.ok ? (x.json() as Promise<OsvVuln>) : null)).catch(() => null);
        if (d) details.push(d);
      }
      const worst = details.map(sevFrom).sort((a, b) => ["critical", "high", "medium", "low", "info"].indexOf(a) - ["critical", "high", "medium", "low", "info"].indexOf(b))[0] ?? "medium";
      const f: Finding = {
        id: `D${String(added + 1).padStart(4, "0")}`,
        rule: "osv-known-vuln",
        title: `${q.pkg}@${q.version} has ${vulns.length} known vulnerabilit${vulns.length === 1 ? "y" : "ies"}`,
        category: "dependency",
        severity: worst,
        confidence: "medium",
        path: q.path,
        line: q.line,
        nodeId: q.nodeId,
        message: details.map((d) => `${d.id}${d.aliases?.length ? ` (${d.aliases.slice(0, 2).join(", ")})` : ""}: ${d.summary ?? ""}`).join("; ").slice(0, 700) + ` Version resolved from the declared range, so check the lockfile.`,
        reachableFrom: [],
        status: "open",
      };
      g.security.findings.push(f);
      added++;
    }
  }
  g.security.summary = summarize(g.security.findings, g.nodes.filter((n) => n.kind === "endpoint"));
  return { added, queried: queries.length };
}
