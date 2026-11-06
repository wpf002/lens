/**
 * File-level infrastructure checks that need more than one line: Dockerfile stages,
 * Terraform blocks, Kubernetes pod specs, IAM statements, GitHub Actions triggers.
 * Single-line infra patterns live in rules.ts with the other rules.
 */
import YAML, { LineCounter } from "yaml";
import type { Confidence, Finding, Severity } from "../types.js";
import type { RawFinding } from "./analyze.js";

interface InfraCheck {
  title: string;
  category: Finding["category"];
  cwe: string;
  severity: Severity;
  confidence: Confidence;
  message: string;
}

const CHECKS = {
  "docker-latest-tag": { title: "Base image not pinned", category: "config", cwe: "CWE-829", severity: "medium", confidence: "high",
    message: "FROM uses :latest or no tag, so every build can pull a different image. Pin a version tag, ideally with an @sha256 digest." },
  "docker-root-user": { title: "Container runs as root", category: "config", cwe: "CWE-250", severity: "medium", confidence: "high",
    message: "The final stage never switches to a non-root USER. Add a user (e.g. `RUN adduser -D app` then `USER app`, or `USER node` on node images) before CMD. If a mounted volume needs root to chown, do that in ENTRYPOINT and exec the app through setpriv or gosu." },
  "docker-no-healthcheck": { title: "Dockerfile without HEALTHCHECK", category: "config", cwe: "CWE-693", severity: "low", confidence: "low",
    message: "No HEALTHCHECK, so Docker can't detect a hung container. Add `HEALTHCHECK CMD` hitting the app's health endpoint." },
  "tf-open-ingress": { title: "Admin port open to the internet", category: "config", cwe: "CWE-284", severity: "high", confidence: "high",
    message: "Ingress from 0.0.0.0/0 or ::/0 reaches an admin or database port. Restrict the source CIDR to a VPN, bastion, or office range." },
  "tf-unencrypted-storage": { title: "Storage encryption not enabled", category: "crypto", cwe: "CWE-311", severity: "medium", confidence: "medium",
    message: "This volume or database doesn't set encryption at rest. Add `storage_encrypted = true` (RDS) or `encrypted = true` (EBS/EFS)." },
  "iam-wildcard-action": { title: "IAM policy allows every action", category: "auth", cwe: "CWE-269", severity: "high", confidence: "high",
    message: "An Allow statement grants Action \"*\". List only the actions this role calls." },
  "iam-wildcard-resource": { title: "IAM policy applies to every resource", category: "auth", cwe: "CWE-732", severity: "medium", confidence: "medium",
    message: "An Allow statement with write actions uses Resource \"*\". Scope it to the ARNs the role needs." },
  "k8s-no-resource-limits": { title: "Container without resource limits", category: "config", cwe: "CWE-770", severity: "medium", confidence: "medium",
    message: "No resources.limits, so one pod can starve the node. Set cpu and memory limits." },
  "k8s-run-as-root": { title: "Pod may run as root", category: "config", cwe: "CWE-250", severity: "medium", confidence: "medium",
    message: "Neither the pod nor the container sets runAsNonRoot: true. Add it to securityContext with a non-zero runAsUser." },
  "k8s-privilege-escalation-default": { title: "Privilege escalation not disabled", category: "config", cwe: "CWE-250", severity: "low", confidence: "medium",
    message: "securityContext doesn't set allowPrivilegeEscalation: false. Add it to the container." },
  "k8s-plain-env-secret": { title: "Secret in plain container env", category: "secrets", cwe: "CWE-312", severity: "high", confidence: "high",
    message: "A credential is set as a literal env value. Move it to a Secret and use valueFrom.secretKeyRef." },
  "k8s-secret-manifest": { title: "Kubernetes Secret committed", category: "secrets", cwe: "CWE-312", severity: "high", confidence: "medium",
    message: "A Secret manifest with values is in the repo (base64 is not encryption). Remove it, rotate the values, and create the Secret from a secret store or sealed-secrets." },
  "gha-prt-checkout": { title: "pull_request_target checks out PR code", category: "code-exec", cwe: "CWE-94", severity: "critical", confidence: "high",
    message: "This workflow runs with repo secrets and write token on pull_request_target, then checks out the PR's head, so a fork PR can run code with those secrets. Switch the trigger to pull_request, or drop the ref: line so it checks out the base branch." },
} satisfies Record<string, InfraCheck>;

export type InfraCheckId = keyof typeof CHECKS;

const ADMIN_PORTS = [22, 3389, 3306, 5432, 1433, 1521, 27017, 6379, 9200, 5601, 11211, 2375, 2379];
const OPEN_CIDR = /["'](?:0\.0\.0\.0\/0|::\/0)["']/;
const SECRET_NAME = /^(?:[A-Z0-9_]*_)?(?:PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|SECRET_?KEY|CLIENT_?SECRET|CREDENTIALS?)(?:_[A-Z0-9_]*)?$/i;
const WORKLOAD_KINDS = new Set(["Pod", "Deployment", "StatefulSet", "DaemonSet", "ReplicaSet", "Job", "CronJob", "ReplicationController"]);

export interface InfraInput {
  path: string;
  /** Language id after content detection (yaml manifests become "kubernetes"). */
  lang: string;
  /** Comment-stripped source, same line structure as raw. */
  cleaned: string;
  raw: string;
}

/** Kubernetes manifests outside k8s/ or helm/ folders classify as plain yaml; spot them by their header keys. */
export function isKubernetesManifest(lang: string, src: string): boolean {
  if (lang === "kubernetes") return true;
  return lang === "yaml" && /^apiVersion:\s*\S/m.test(src) && /^kind:\s*[A-Z]\w+/m.test(src);
}

/** IAM policy documents stored as JSON. */
/** CloudTrail records quote policies they logged; those are events, not grants. */
const CLOUDTRAIL_LOG = /"eventVersion"\s*:/;

export function isPolicyJson(path: string, src: string): boolean {
  return /\.json$/i.test(path) && /"Statement"\s*:/.test(src) && /"(?:Action|NotAction)"\s*:/.test(src) && !CLOUDTRAIL_LOG.test(src);
}

export function scanInfra(input: InfraInput): RawFinding[] {
  const lines = input.cleaned.split("\n");
  const rawLines = input.raw.split("\n");
  const out: RawFinding[] = [];
  const report = (id: InfraCheckId, index: number, extra: Partial<Pick<RawFinding, "severity" | "confidence" | "message" | "title">> = {}) => {
    out.push({ rule: id, ...CHECKS[id], path: input.path, line: index + 1, snippet: rawLines[index]?.trim().slice(0, 200), ...extra });
  };
  if (input.lang === "dockerfile") dockerChecks(lines, report);
  if (input.lang === "terraform") {
    terraformChecks(lines, report);
    iamChecks(lines, report);
  }
  if (input.lang === "json" && isPolicyJson(input.path, input.raw)) iamChecks(lines, report);
  if (input.lang === "kubernetes") kubernetesChecks(input.cleaned, lines, report);
  if (input.lang === "github-actions") actionsChecks(lines, report);
  return out;
}

type Report = (id: InfraCheckId, index: number, extra?: Partial<Pick<RawFinding, "severity" | "confidence" | "message" | "title">>) => void;

/* ---------------- Dockerfile ---------------- */

function dockerChecks(lines: string[], report: Report): void {
  const stageNames = new Set<string>();
  let finalFrom = -1;
  let finalImage = "";
  let lastUser: { index: number; user: string } | undefined;
  let hasHealthcheck = false;
  let dropsRoot = false;
  lines.forEach((line, index) => {
    const from = /^\s*FROM\s+(?:--\S+\s+)*(\S+)(?:\s+AS\s+(\S+))?/i.exec(line);
    if (from) {
      const image = from[1]!;
      if (!isPinnedOrLocal(image, stageNames)) report("docker-latest-tag", index);
      if (from[2]) stageNames.add(from[2].toLowerCase());
      finalFrom = index;
      finalImage = image;
      lastUser = undefined;
      dropsRoot = false;
      return;
    }
    const user = /^\s*USER\s+(\S+)/i.exec(line);
    if (user) lastUser = { index, user: user[1]! };
    if (/^\s*HEALTHCHECK\s/i.test(line)) hasHealthcheck = true;
    if (/^\s*(?:ENTRYPOINT|CMD)\s/i.test(line) && PRIVILEGE_DROP.test(line)) dropsRoot = true;
  });
  if (finalFrom < 0) return;
  const nonRootImage = /nonroot|rootless/i.test(finalImage);
  if (lastUser && /^(?:root|0)(?::|$)/.test(lastUser.user)) report("docker-root-user", lastUser.index, { message: `The last USER is ${lastUser.user}, so the app runs as root. Switch to a non-root user before CMD.` });
  else if (!lastUser && !nonRootImage && !dropsRoot) report("docker-root-user", finalFrom);
  if (!hasHealthcheck) report("docker-no-healthcheck", finalFrom);
}

/** Entrypoints that start as root only to fix volume ownership, then exec the app as another user. */
const PRIVILEGE_DROP = /\b(?:gosu|su-exec|setpriv\s+--reuid|runuser\s+-u)\b/;

function isPinnedOrLocal(image: string, stageNames: Set<string>): boolean {
  if (image.toLowerCase() === "scratch" || stageNames.has(image.toLowerCase()) || image.includes("$")) return true;
  if (image.includes("@sha256:")) return true;
  const afterSlash = image.slice(image.lastIndexOf("/") + 1);
  const colon = afterSlash.indexOf(":");
  return colon >= 0 && afterSlash.slice(colon + 1) !== "latest";
}

/* ---------------- brace blocks (HCL and JSON) ---------------- */

interface Block {
  start: number;
  end: number;
  header: string;
  body: string[];
}

const braceDelta = (line: string): number => (line.match(/\{/g)?.length ?? 0) - (line.match(/\}/g)?.length ?? 0);

function blockFrom(lines: string[], start: number): Block {
  let depth = 0;
  for (let i = start; i < lines.length; i++) {
    depth += braceDelta(lines[i]!);
    if (depth <= 0 && i > start) return { start, end: i, header: lines[start]!, body: lines.slice(start, i + 1) };
  }
  return { start, end: lines.length - 1, header: lines[start]!, body: lines.slice(start) };
}

/** Innermost block that opens above line `index` and is still open there. */
function enclosingBlock(lines: string[], index: number, skip = 0): Block | undefined {
  let balance = 0;
  let skipped = 0;
  for (let i = index - 1; i >= 0; i--) {
    balance += -braceDelta(lines[i]!);
    if (balance < 0) {
      if (skipped++ === skip) return blockFrom(lines, i);
      balance = 0;
    }
  }
  return undefined;
}

function resourceType(header: string): string | undefined {
  return /^\s*resource\s+"([\w-]+)"/.exec(header)?.[1];
}

/** First `key = value` in a block, or `"key": value` in JSON. */
function attribute(body: string[], key: string): string | undefined {
  const re = new RegExp(`(?:^|[\\s{,])"?${key}"?\\s*[:=]\\s*(.+)$`);
  for (const line of body) {
    const m = re.exec(line);
    if (m) return m[1]!.trim();
  }
  return undefined;
}

const quoted = (text: string): string[] => [...text.matchAll(/"([^"]*)"/g)].map((m) => m[1]!);

/* ---------------- Terraform ---------------- */

function terraformChecks(lines: string[], report: Report): void {
  lines.forEach((line, index) => {
    const type = resourceType(line);
    if (type) encryptionCheck(type, blockFrom(lines, index), report);
    if (OPEN_CIDR.test(line)) openIngressCheck(lines, index, report);
  });
}

function encryptionCheck(type: string, block: Block, report: Report): void {
  const text = block.body.join("\n");
  if ((type === "aws_db_instance" || type === "aws_rds_cluster") && !/\bstorage_encrypted\s*=/.test(text) && !/\breplicate_source_db\s*=/.test(text)) {
    report("tf-unencrypted-storage", block.start);
  }
  if ((type === "aws_ebs_volume" || type === "aws_efs_file_system") && !/\bencrypted\s*=/.test(text)) report("tf-unencrypted-storage", block.start);
}

function openIngressCheck(lines: string[], index: number, report: Report): void {
  const block = enclosingBlock(lines, index);
  if (!block) return;
  const head = block.header.trim();
  const type = resourceType(head);
  if (/^egress\b/.test(head) || type === "aws_vpc_security_group_egress_rule") return;
  if (/^authorized_networks\b/.test(head)) {
    report("tf-open-ingress", index, { message: "The database accepts connections from 0.0.0.0/0. Remove this authorized network and connect through a private IP or the Cloud SQL proxy." });
    return;
  }
  if (/^ingress\b/.test(head) || type === "aws_vpc_security_group_ingress_rule" || (type === "aws_security_group_rule" && /"ingress"/.test(attribute(block.body, "type") ?? ""))) {
    if (exposesAdminPort(block.body)) report("tf-open-ingress", index);
    return;
  }
  if (type === "google_compute_firewall" && !/EGRESS/.test(attribute(block.body, "direction") ?? "")) {
    const ports = block.body.flatMap((l) => (/\bports\s*=/.test(l) ? quoted(l) : []));
    const allProtocols = block.body.some((l) => /\bprotocol\s*=\s*"all"/.test(l));
    if (allProtocols || ports.some((p) => portSpecHitsAdmin(p))) report("tf-open-ingress", index);
  }
}

function exposesAdminPort(body: string[]): boolean {
  const protocol = (attribute(body, "ip_protocol") ?? attribute(body, "protocol") ?? "").replace(/"/g, "");
  if (protocol === "-1" || protocol === "all") return true;
  const from = Number(/^\d+/.exec(attribute(body, "from_port") ?? "")?.[0]);
  const to = Number(/^\d+/.exec(attribute(body, "to_port") ?? "")?.[0] ?? from);
  if (!Number.isFinite(from)) return false;
  return ADMIN_PORTS.some((p) => p >= from && p <= (Number.isFinite(to) ? to : from));
}

function portSpecHitsAdmin(spec: string): boolean {
  const [lo, hi] = spec.split("-").map(Number);
  if (!Number.isFinite(lo)) return false;
  return ADMIN_PORTS.some((p) => p >= lo! && p <= (Number.isFinite(hi) ? hi! : lo!));
}

/* ---------------- IAM (Terraform + JSON) ---------------- */

const ACTION_KEY = /(?:^|[\s{,])"?(Action|actions)"?\s*[:=]\s*(.*)$/;
const READ_ONLY_ACTION = /:(?:Describe|List|Get|Head|BatchGet|Search|Query|Lookup|View)\w*\*?$/;

/** Values of a string or list attribute, following a list across lines. */
function listValue(lines: string[], index: number, rest: string): string[] {
  const text = rest.trimStart();
  if (text.startsWith('"')) return quoted(text).slice(0, 1);
  if (!text.startsWith("[")) return [];
  let collected = text;
  for (let i = index + 1; !collected.includes("]") && i < Math.min(lines.length, index + 60); i++) collected += ` ${lines[i]}`;
  return quoted(collected.slice(0, collected.indexOf("]") + 1 || undefined));
}

function iamChecks(lines: string[], report: Report): void {
  lines.forEach((line, index) => {
    const m = ACTION_KEY.exec(line);
    if (!m) return;
    const actions = listValue(lines, index, m[2]!);
    if (!actions.length) return;
    const statement = enclosingBlock(lines, index + 1) ?? { start: 0, end: lines.length - 1, header: "", body: lines };
    // jsonencode keeps the whole statement on one line; the enclosing block is then the policy.
    const effect = m[2]!.match(/Effect"?\s*[:=]\s*"(\w+)"/)?.[1] ?? attribute(statement.body, "(?:Effect|effect)")?.match(/"(\w+)"/)?.[1] ?? "Allow";
    if (effect !== "Allow") return;
    const resourceIndex = statement.body.findIndex((l) => /(?:^|[\s{,])"?(?:Resource|resources)"?\s*[:=]/.test(l));
    const resourceLine = resourceIndex >= 0 ? statement.start + resourceIndex : -1;
    const resources = resourceLine >= 0 ? listValue(lines, resourceLine, /(?:Resource|resources)"?\s*[:=]\s*(.*)$/.exec(lines[resourceLine]!)![1]!) : [];
    const anyResource = resources.includes("*");
    if (actions.includes("*")) {
      report("iam-wildcard-action", index, anyResource
        ? { severity: "critical", title: "IAM policy grants full admin", message: "Action \"*\" on Resource \"*\" is full account admin. List only the actions and ARNs this role uses." }
        : {});
      return;
    }
    const serviceWildcard = actions.find((a) => /^[\w-]+:\*$/.test(a));
    if (serviceWildcard) {
      report("iam-wildcard-action", index, { severity: anyResource ? "high" : "medium", message: `${serviceWildcard} grants every ${serviceWildcard.split(":")[0]} action${anyResource ? " on every resource" : ""}. List the specific actions this role calls.` });
      return;
    }
    if (anyResource && actions.some((a) => !READ_ONLY_ACTION.test(a))) report("iam-wildcard-resource", resourceLine);
  });
}

/* ---------------- Kubernetes ---------------- */

interface ContainerSpec {
  name?: string;
  resources?: { limits?: Record<string, unknown> };
  securityContext?: SecurityContext;
}

interface SecurityContext {
  runAsNonRoot?: boolean;
  runAsUser?: number;
  allowPrivilegeEscalation?: boolean;
  privileged?: boolean;
}

function podSpecPath(kind: string): (string | number)[] {
  if (kind === "Pod") return ["spec"];
  if (kind === "CronJob") return ["spec", "jobTemplate", "spec", "template", "spec"];
  return ["spec", "template", "spec"];
}

function kubernetesChecks(cleaned: string, lines: string[], report: Report): void {
  plainEnvSecrets(lines, report);
  const counter = new LineCounter();
  let docs: YAML.Document.Parsed[];
  try {
    docs = YAML.parseAllDocuments(cleaned, { lineCounter: counter, uniqueKeys: false }) as YAML.Document.Parsed[];
  } catch {
    return; // Helm templates with {{ }} often aren't valid YAML; the line rules still cover them.
  }
  if (!Array.isArray(docs)) return;
  const lineOf = (node: unknown): number => {
    const range = (node as { range?: [number, number, number] } | null)?.range;
    return range ? counter.linePos(range[0]).line - 1 : 0;
  };
  for (const doc of docs) {
    if (doc.errors.length) continue;
    const kind = doc.get("kind");
    if (typeof kind !== "string") continue;
    if (kind === "Secret") {
      const data = doc.get("data") ?? doc.get("stringData");
      if (data && YAML.isMap(data) && data.items.length) report("k8s-secret-manifest", lineOf(doc.get("kind", true)));
      continue;
    }
    if (!WORKLOAD_KINDS.has(kind)) continue;
    const specPath = podSpecPath(kind);
    const pod = (doc.getIn(specPath) as YAML.YAMLMap | undefined)?.toJSON() as { securityContext?: SecurityContext } | undefined;
    if (!pod) continue;
    const podNonRoot = pod.securityContext?.runAsNonRoot === true || (pod.securityContext?.runAsUser ?? 0) > 0;
    for (const group of ["containers", "initContainers"]) {
      const list = doc.getIn([...specPath, group], true);
      if (!YAML.isSeq(list)) continue;
      list.items.forEach((item, i) => {
        const container = (YAML.isMap(item) ? item.toJSON() : {}) as ContainerSpec;
        const at = lineOf(doc.getIn([...specPath, group, i, "name"], true) ?? item);
        const sc = container.securityContext ?? {};
        if (!container.resources?.limits || !Object.keys(container.resources.limits).length) report("k8s-no-resource-limits", at);
        const explicitRoot = sc.runAsUser === 0 || pod.securityContext?.runAsUser === 0 || sc.runAsNonRoot === false;
        const nonRoot = sc.runAsNonRoot === true || (sc.runAsUser ?? 0) > 0 || podNonRoot;
        if (!nonRoot && !explicitRoot) report("k8s-run-as-root", at);
        if (sc.allowPrivilegeEscalation === undefined && sc.privileged !== true) report("k8s-privilege-escalation-default", at);
      });
    }
  }
}

/** `- name: DB_PASSWORD` followed by a literal `value:`. Text-based so Helm templates are covered too. */
function plainEnvSecrets(lines: string[], report: Report): void {
  lines.forEach((line, index) => {
    const name = /^\s*-\s*name:\s*["']?([\w.-]+)["']?\s*$/.exec(line)?.[1];
    if (!name || !SECRET_NAME.test(name)) return;
    for (let j = index + 1; j <= index + 2 && j < lines.length; j++) {
      const value = /^\s*value:\s*(.*)$/.exec(lines[j]!)?.[1]?.trim();
      if (value === undefined) continue;
      if (!value || value === '""' || value === "''") return;
      report("k8s-plain-env-secret", index, value.includes("{{") ? { confidence: "medium" } : {});
      return;
    }
  });
}

/* ---------------- GitHub Actions ---------------- */

const PR_HEAD_REF = /\bref\s*:\s*.*(?:github\.event\.pull_request\.head\.(?:sha|ref)|github\.head_ref|refs\/pull\/)|\bgh\s+pr\s+checkout\b|\bgit\s+(?:fetch|checkout)\b.*\bpull\/\$?\{?\{?/;
const WORKFLOW_RUN_HEAD = /\bref\s*:\s*.*github\.event\.workflow_run\.head_(?:sha|branch)/;

function actionsChecks(lines: string[], report: Report): void {
  const text = lines.join("\n");
  const prTarget = /\bpull_request_target\b/.test(text);
  const workflowRun = /^\s*workflow_run\s*:/m.test(text) || /\bon:\s*\[?[^\n]*\bworkflow_run\b/.test(text);
  lines.forEach((line, index) => {
    if (prTarget && PR_HEAD_REF.test(line)) report("gha-prt-checkout", index);
    else if (workflowRun && WORKFLOW_RUN_HEAD.test(line)) {
      report("gha-prt-checkout", index, {
        severity: "high", title: "workflow_run checks out PR code",
        message: "This workflow_run job checks out the triggering run's head commit and runs with secrets, so a fork PR's code can reach them. Don't run that code here; pass build output as an artifact and treat it as untrusted.",
      });
    }
  });
}
