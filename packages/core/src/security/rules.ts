/**
 * Security rule pack. Line-oriented pattern rules with a taint window check.
 * Rules are deliberately conservative: confidence reflects how often the
 * pattern alone is a real bug, and the triage agent is expected to clear the rest.
 */
import type { Confidence, Finding, Severity } from "../types.js";

export const RULES_VERSION = "2026.09.1";

export interface Rule {
  id: string;
  title: string;
  category: Finding["category"];
  cwe: string;
  severity: Severity;
  confidence: Confidence;
  /** Language ids this applies to, or "*". */
  langs: string[] | "*";
  pattern: RegExp;
  /** Skip the line when this matches (e.g. safe variants). */
  unless?: RegExp;
  message: string;
  /** Raise severity one level when user input is visible near the sink. */
  taintBoost?: boolean;
  /** Only report when user input is visible near the sink. */
  requireTaint?: boolean;
  /** Only in files whose path matches. */
  pathFilter?: RegExp;
  /** Skip test files (default true). */
  includeTests?: boolean;
}

const JS = ["typescript", "javascript", "vue", "svelte"];
const PY = ["python"];
const GO = ["go"];
const JAVA = ["java", "kotlin", "scala"];
const RB = ["ruby"];
const PHP = ["php"];
const CS = ["csharp"];

export const RULES: Rule[] = [
  /* ---- command / code execution ---- */
  { id: "js-exec-shell", title: "Shell command execution", category: "command-exec", cwe: "CWE-78", severity: "high", confidence: "medium", langs: JS,
    pattern: /(?:(?<![.\w$])|\b(?:child_process|childProcess|cp)\.)(?:exec|execSync)\s*\(\s*(?![`'"][^`'"$]*[`'"]\s*[,)])/,
    message: "child_process.exec runs its argument through a shell. With any request-derived part this is command injection; prefer execFile with an argument array.", taintBoost: true },
  { id: "js-spawn-tainted", title: "Process spawned with request data", category: "command-exec", cwe: "CWE-78", severity: "medium", confidence: "medium", langs: JS,
    pattern: /(?:(?<![.\w$])|\b(?:child_process|childProcess|cp)\.)(?:spawn|spawnSync|execFile|execFileSync|fork)\s*\(/, requireTaint: true,
    message: "A process is started in code that also handles request input. Check that the command and arguments are not attacker-controlled.", taintBoost: true },
  { id: "js-shell-true", title: "Command run through a shell", category: "command-exec", cwe: "CWE-78", severity: "medium", confidence: "medium", langs: JS,
    pattern: /\b(?:spawn|spawnSync|execFile|execFileSync)\s*\([^)]*shell\s*:\s*true/, message: "spawn/execFile with shell: true re-enables shell metacharacter parsing.", taintBoost: true },
  { id: "js-eval", title: "Dynamic code evaluation", category: "code-exec", cwe: "CWE-95", severity: "high", confidence: "medium", langs: JS,
    pattern: /(?<![\w.])(?:eval\s*\(|new\s+Function\s*\(|vm\.runIn(?:New|This)?Context\s*\(|setTimeout\s*\(\s*[`'"])/, message: "String evaluated as code.", taintBoost: true },
  { id: "py-exec", title: "Shell command execution", category: "command-exec", cwe: "CWE-78", severity: "high", confidence: "medium", langs: PY,
    pattern: /\b(?:os\.system|os\.popen|subprocess\.(?:call|run|Popen|check_output|check_call)\s*\([^)]*shell\s*=\s*True|commands\.getoutput)/, message: "Command executed through the shell.", taintBoost: true },
  { id: "py-eval", title: "Dynamic code evaluation", category: "code-exec", cwe: "CWE-95", severity: "high", confidence: "medium", langs: PY,
    pattern: /(?<![\w.])(?:eval|exec)\s*\((?!\s*["'])/, unless: /\.exec\(|cursor|re\.|regex|literal_eval/, message: "eval/exec on a non-literal expression.", taintBoost: true },
  { id: "go-exec", title: "Command execution through a shell", category: "command-exec", cwe: "CWE-78", severity: "high", confidence: "medium", langs: GO,
    pattern: /exec\.Command(?:Context)?\s*\([^)]*"(?:sh|bash|cmd|\/bin\/sh)"\s*,\s*"(?:-c|\/c)"/, message: "exec.Command invoking a shell with -c.", taintBoost: true },
  { id: "java-exec", title: "Runtime command execution", category: "command-exec", cwe: "CWE-78", severity: "high", confidence: "medium", langs: JAVA,
    pattern: /Runtime\.getRuntime\(\)\.exec\s*\(|new\s+ProcessBuilder\s*\(/, message: "Process execution; verify arguments are not request-controlled.", taintBoost: true },
  { id: "rb-exec", title: "Shell command execution", category: "command-exec", cwe: "CWE-78", severity: "high", confidence: "medium", langs: RB,
    pattern: /(?:\bsystem\s*\(|\bexec\s*\(|%x\{|`[^`]*#\{|\bIO\.popen|\bOpen3\.)/, message: "Shell execution with interpolation.", taintBoost: true },
  { id: "php-exec", title: "Shell command execution", category: "command-exec", cwe: "CWE-78", severity: "high", confidence: "medium", langs: PHP,
    pattern: /\b(?:shell_exec|system|passthru|exec|popen|proc_open)\s*\(/, message: "Shell execution function.", taintBoost: true },
  { id: "php-eval", title: "Dynamic code evaluation", category: "code-exec", cwe: "CWE-95", severity: "critical", confidence: "medium", langs: PHP,
    pattern: /\b(?:eval|assert|create_function)\s*\(|preg_replace\s*\(\s*['"][^'"]*\/e['"]/, message: "PHP code evaluation.", taintBoost: true },

  /* ---- SQL / NoSQL injection ---- */
  { id: "sql-template-concat", title: "SQL built with string interpolation", category: "injection", cwe: "CWE-89", severity: "high", confidence: "medium", langs: "*",
    pattern: /(?:`|"|')\s*(?:SELECT\s+[\w*,\s.]+\s+FROM|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b[^`"'\n]*(?:\$\{|"\s*\+|'\s*\+|%s|\{[a-z_]\w*\}|#\{)/i,
    unless: /\$\d|\?\s*[,)]|:\w+\b.*(?:params|bind)|(?:\bsql|\$queryRaw|\$executeRaw|\bPrisma\.sql|\bsqlTag|\bSQL)\s*`/, message: "Query text is concatenated or interpolated instead of parameterized.", taintBoost: true },
  { id: "py-sql-format", title: "SQL executed with formatted string", category: "injection", cwe: "CWE-89", severity: "high", confidence: "high", langs: PY,
    pattern: /\.execute(?:many)?\s*\(\s*(?:f["']|["'][^"']*["']\s*%\s*|["'][^"']*["']\s*\.format\s*\()/, message: "cursor.execute with an f-string, % formatting, or .format().", taintBoost: true },
  { id: "prisma-raw-unsafe", title: "Prisma raw query (unsafe variant)", category: "injection", cwe: "CWE-89", severity: "high", confidence: "high", langs: JS,
    pattern: /\$(?:queryRawUnsafe|executeRawUnsafe)\s*\(/, message: "$queryRawUnsafe/$executeRawUnsafe do not parameterize. Use the tagged $queryRaw template.", taintBoost: true },
  { id: "js-orm-raw", title: "Raw ORM query with interpolation", category: "injection", cwe: "CWE-89", severity: "high", confidence: "medium", langs: JS,
    pattern: /\.(?:query|raw|whereRaw|orderByRaw|joinRaw|unsafe)\s*\(\s*`[^`]*\$\{/, message: "Template literal interpolated into a raw query.", taintBoost: true },
  { id: "go-sql-sprintf", title: "SQL built with Sprintf/concat", category: "injection", cwe: "CWE-89", severity: "high", confidence: "medium", langs: GO,
    pattern: /\.(?:Query|QueryRow|Exec|QueryContext|ExecContext)\s*\(\s*(?:ctx\s*,\s*)?(?:fmt\.Sprintf\(|"[^"]*"\s*\+)/, message: "database/sql call with a formatted query string.", taintBoost: true },
  { id: "java-sql-concat", title: "JDBC statement with concatenation", category: "injection", cwe: "CWE-89", severity: "high", confidence: "medium", langs: JAVA,
    pattern: /\.(?:executeQuery|executeUpdate|execute|createQuery|createNativeQuery)\s*\(\s*"[^"]*"\s*\+/, message: "Query string concatenation; use PreparedStatement parameters.", taintBoost: true },
  { id: "nosql-injection", title: "Query object taken from request", category: "injection", cwe: "CWE-943", severity: "medium", confidence: "medium", langs: JS,
    pattern: /\.(?:find|findOne|updateOne|updateMany|deleteOne|deleteMany|aggregate)\s*\(\s*req\.(?:body|query|params)\b/, message: "Whole request object passed as a Mongo query allows operator injection ($ne, $gt).", taintBoost: false },

  /* ---- XSS / templating ---- */
  { id: "react-dangerous-html", title: "dangerouslySetInnerHTML", category: "xss", cwe: "CWE-79", severity: "medium", confidence: "medium", langs: JS,
    pattern: /dangerouslySetInnerHTML\s*=\s*\{\{?\s*__html\s*:\s*(?!["'`])/, unless: /sanitize|DOMPurify|purify/i, message: "Raw HTML rendered; make sure it is sanitized.", taintBoost: true },
  { id: "dom-innerhtml", title: "innerHTML/outerHTML/document.write assignment", category: "xss", cwe: "CWE-79", severity: "medium", confidence: "low", langs: JS,
    pattern: /\.(?:innerHTML|outerHTML)\s*[+]?=\s*(?!["'`][^${]*["'`]\s*;?$)|document\.write\s*\(|insertAdjacentHTML\s*\(/, unless: /sanitize|DOMPurify|escape/i, message: "HTML sink written from a non-literal value.", taintBoost: true },
  { id: "vue-v-html", title: "v-html directive", category: "xss", cwe: "CWE-79", severity: "medium", confidence: "low", langs: ["vue", "html"],
    pattern: /\bv-html\s*=/, message: "v-html renders raw HTML." },
  { id: "py-template-unsafe", title: "Unescaped template output", category: "xss", cwe: "CWE-79", severity: "medium", confidence: "medium", langs: PY,
    pattern: /\b(?:mark_safe|Markup)\s*\(|render_template_string\s*\(|\|\s*safe\b|autoescape\s*=\s*False/, message: "Template output marked safe or rendered from a string.", taintBoost: true },
  { id: "rb-html-safe", title: "html_safe / raw", category: "xss", cwe: "CWE-79", severity: "medium", confidence: "low", langs: RB,
    pattern: /\.html_safe\b|\braw\s*\(/, message: "Output marked HTML-safe.", taintBoost: true },
  { id: "php-echo-input", title: "Request input echoed", category: "xss", cwe: "CWE-79", severity: "high", confidence: "high", langs: PHP,
    pattern: /\b(?:echo|print)\b[^;]*\$_(?:GET|POST|REQUEST|COOKIE)\b/, unless: /htmlspecialchars|htmlentities|esc_html/, message: "Superglobal echoed without escaping." },

  /* ---- SSRF / redirect / path traversal ---- */
  { id: "ssrf-request-url", title: "Outbound request to user-controlled URL", category: "ssrf", cwe: "CWE-918", severity: "high", confidence: "medium", langs: "*",
    pattern: /\b(?:fetch|axios(?:\.\w+)?|got|request|http\.get|https\.get|requests\.(?:get|post|put|request)|urllib\.request\.urlopen|http\.Get|http\.NewRequest|HttpClient|RestTemplate|open-uri|Net::HTTP\.get|curl_setopt)\s*\(\s*[^)'"`]*\b(?:req\.(?:body|query|params)|request\.(?:args|form|json|GET|POST|data)|params\[|ctx\.(?:query|request)|c\.(?:Query|Param)|\$_(?:GET|POST|REQUEST))/,
    message: "HTTP client called with a URL taken from the request.", requireTaint: false },
  { id: "open-redirect", title: "Redirect to user-controlled location", category: "redirect", cwe: "CWE-601", severity: "medium", confidence: "medium", langs: "*",
    pattern: /\b(?:res\.redirect|redirect|reply\.redirect|RedirectResponse|HttpResponseRedirect|http\.Redirect|redirect_to|header\s*\(\s*["']Location)\s*\([^)]*(?:req\.(?:query|body|params)|request\.(?:args|GET|POST|query_params)|params\[|c\.Query|\$_GET)/,
    message: "Redirect target comes from the request; validate against an allowlist." },
  { id: "path-traversal", title: "File path from request", category: "path-traversal", cwe: "CWE-22", severity: "high", confidence: "medium", langs: "*",
    pattern: /\b(?:readFile|readFileSync|createReadStream|writeFile|writeFileSync|sendFile|unlink|open|send_file|send_from_directory|os\.Open|ioutil\.ReadFile|File\.read|file_get_contents|fopen|include|require)\s*\([^)]*(?:req\.(?:body|query|params)|request\.(?:args|form|GET|POST)|params\[|c\.(?:Query|Param)|\$_(?:GET|POST|REQUEST))/,
    unless: /path\.basename|secure_filename|filepath\.Base|realpath.*startsWith/, message: "Filesystem path built from request input without normalization/containment." },

  /* ---- deserialization ---- */
  { id: "py-unsafe-deser", title: "Unsafe deserialization", category: "deserialization", cwe: "CWE-502", severity: "high", confidence: "high", langs: PY,
    pattern: /\b(?:pickle|cPickle|dill|shelve)\.loads?\s*\(|\byaml\.load\s*\((?![^)]*Loader\s*=\s*(?:yaml\.)?(?:Safe|CSafe)Loader)|\bmarshal\.loads\s*\(|jsonpickle\.decode/, message: "Deserializer that can execute code on untrusted input.", taintBoost: true },
  { id: "js-unsafe-deser", title: "Unsafe deserialization", category: "deserialization", cwe: "CWE-502", severity: "high", confidence: "medium", langs: JS,
    pattern: /\b(?:serialize\.unserialize|node-serialize|unserialize)\s*\(|yaml\.load\s*\((?![^)]*(?:schema|FAILSAFE|JSON_SCHEMA))/, unless: /js-yaml.*safeLoad|yaml\.parse/, message: "Deserializer that may instantiate arbitrary types." },
  { id: "java-unsafe-deser", title: "Java native deserialization", category: "deserialization", cwe: "CWE-502", severity: "high", confidence: "medium", langs: JAVA,
    pattern: /new\s+ObjectInputStream\s*\(|\.readObject\s*\(\s*\)|XMLDecoder|enableDefaultTyping\s*\(/, message: "Native deserialization or polymorphic typing on untrusted data." },
  { id: "rb-unsafe-deser", title: "Unsafe deserialization", category: "deserialization", cwe: "CWE-502", severity: "high", confidence: "medium", langs: RB,
    pattern: /\bMarshal\.load\b|\bYAML\.load\b(?!_file)|\bObject\.const_get\s*\(\s*params/, message: "Marshal/YAML.load on untrusted input can execute code." },
  { id: "php-unserialize", title: "unserialize() on input", category: "deserialization", cwe: "CWE-502", severity: "high", confidence: "medium", langs: PHP,
    pattern: /\bunserialize\s*\(/, message: "PHP object injection via unserialize.", taintBoost: true },

  /* ---- crypto / tls / randomness ---- */
  { id: "weak-hash", title: "Weak hash algorithm", category: "crypto", cwe: "CWE-327", severity: "low", confidence: "medium", langs: "*",
    pattern: /createHash\s*\(\s*["'](?:md5|sha1)["']|hashlib\.(?:md5|sha1)\s*\(|MessageDigest\.getInstance\s*\(\s*"(?:MD5|SHA-?1)"|\bmd5\s*\(|crypto\/(?:md5|sha1)"|Digest::(?:MD5|SHA1)/i,
    unless: /usedforsecurity\s*=\s*False|etag|checksum|cache|fingerprint/i, message: "MD5/SHA-1 are broken for security use (fine for checksums and cache keys)." },
  { id: "weak-cipher", title: "Weak cipher or mode", category: "crypto", cwe: "CWE-327", severity: "medium", confidence: "high", langs: "*",
    pattern: /\b(?:des-|des3|DES\/|DESede|RC4|rc4|Blowfish|aes-\d+-ecb|AES\/ECB|MODE_ECB)\b|createCipher\s*\(/i, message: "DES/RC4/ECB mode or the deprecated createCipher (no IV)." },
  { id: "insecure-random", title: "Non-cryptographic RNG for secrets", category: "crypto", cwe: "CWE-338", severity: "medium", confidence: "medium", langs: "*",
    pattern: /(?:token|secret|password|passwd|nonce|salt|otp|session|apikey|api_key|reset)\w*\s*[:=][^;\n]*(?:Math\.random\(|random\.(?:random|randint|choice)\(|rand\(|mt_rand\(|math\/rand)/i, message: "Security-sensitive value generated with a predictable RNG." },
  { id: "tls-verify-off", title: "TLS certificate verification disabled", category: "tls", cwe: "CWE-295", severity: "high", confidence: "high", langs: "*",
    pattern: /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0|verify\s*=\s*False|InsecureSkipVerify\s*:\s*true|CURLOPT_SSL_VERIFYPEER\s*,\s*(?:false|0)|ServerCertificateValidationCallback\s*=|TrustAllCerts|ssl\._create_unverified_context|OpenSSL::SSL::VERIFY_NONE/,
    message: "Certificate validation turned off; traffic can be intercepted." },
  { id: "jwt-no-verify", title: "JWT decoded without verification", category: "auth", cwe: "CWE-347", severity: "high", confidence: "medium", langs: "*",
    pattern: /jwt\.decode\s*\([^)]*(?:verify\s*=\s*False|options\s*=\s*\{\s*["']verify_signature["']\s*:\s*False)|algorithms?\s*[:=]\s*\[?\s*["']none["']|ignoreExpiration\s*:\s*true|\bjwt\.decode\s*\(\s*\w+\s*\)(?!.*verify)/i,
    unless: /complete\s*:\s*true.*verify/, message: "Token accepted without signature/expiry check. jwt.decode() does not verify; use jwt.verify()." },
  { id: "hardcoded-jwt-secret", title: "Hardcoded signing secret", category: "secrets", cwe: "CWE-798", severity: "high", confidence: "medium", langs: "*",
    pattern: /\b(?:jwt\.sign|jwt\.encode|jws\.sign|sign)\s*\([^)]*,\s*["'][^"'\s]{6,}["']/, unless: /process\.env|os\.environ|getenv|config\./, message: "JWT signed with a literal secret." },

  /* ---- config / auth hygiene ---- */
  { id: "cors-wildcard-credentials", title: "CORS allows any origin", category: "config", cwe: "CWE-942", severity: "medium", confidence: "medium", langs: "*",
    pattern: /(?:origin\s*:\s*(?:["']\*["']|true)|Access-Control-Allow-Origin["']?\s*[,:]\s*["']\*|allow_origins\s*=\s*\[\s*["']\*["']|CORS_ORIGIN_ALLOW_ALL\s*=\s*True|AllowAnyOrigin\s*\(\)|AllowAllOrigins\s*:\s*true)/,
    message: "Any origin may call this API. Combined with credentials this exposes authenticated endpoints cross-site." },
  { id: "debug-enabled", title: "Debug mode enabled", category: "config", cwe: "CWE-489", severity: "medium", confidence: "medium", langs: "*",
    pattern: /\bDEBUG\s*=\s*True\b|app\.run\s*\([^)]*debug\s*=\s*True|app\.debug\s*=\s*true|config\.consider_all_requests_local\s*=\s*true|APP_DEBUG\s*=\s*true/i,
    pathFilter: /^(?!.*(?:test|spec|dev|local|example)).*$/i, message: "Debug mode leaks stack traces and can expose an interactive console." },
  { id: "cookie-insecure", title: "Session cookie missing security flags", category: "config", cwe: "CWE-614", severity: "low", confidence: "low", langs: "*",
    pattern: /(?:httpOnly|httponly|HttpOnly)\s*[:=]\s*(?:false|False)|secure\s*:\s*false|SESSION_COOKIE_SECURE\s*=\s*False|CSRF_COOKIE_SECURE\s*=\s*False/, message: "Cookie set without Secure/HttpOnly." },
  { id: "csrf-disabled", title: "CSRF protection disabled", category: "config", cwe: "CWE-352", severity: "medium", confidence: "medium", langs: "*",
    pattern: /@csrf_exempt|csrf\(\)\.disable\(\)|skip_before_action\s+:verify_authenticity_token|protect_from_forgery\s+with:\s*:null_session|WTF_CSRF_ENABLED\s*=\s*False|csrf\s*:\s*false/, message: "CSRF protection turned off for this route or app." },
  { id: "mass-assignment", title: "Request body persisted wholesale", category: "mass-assignment", cwe: "CWE-915", severity: "medium", confidence: "medium", langs: "*",
    pattern: /\.(?:create|update|updateOne|findByIdAndUpdate|insert|save|upsert|build|new|assign_attributes|update_attributes)\s*\(\s*(?:\{\s*data\s*:\s*)?(?:req\.body|request\.(?:json|data|POST)|params(?!\.require|\[)|ctx\.request\.body|\*\*request\.(?:json|data))\s*[,)}]/,
    unless: /permit\(|pick\(|parse\(|validated|schema\./, message: "Entire request body written to a model; attackers can set fields like role or isAdmin." },
  { id: "regex-from-input", title: "Regular expression from request", category: "injection", cwe: "CWE-1333", severity: "low", confidence: "medium", langs: JS,
    pattern: /new\s+RegExp\s*\(\s*req\.(?:body|query|params)/, message: "User-supplied regex can cause catastrophic backtracking (ReDoS)." },
  { id: "xxe", title: "XML parser with external entities", category: "injection", cwe: "CWE-611", severity: "high", confidence: "medium", langs: "*",
    pattern: /resolve_entities\s*=\s*True|XMLInputFactory\.newInstance\(\)|DocumentBuilderFactory\.newInstance\(\)(?![\s\S]{0,200}disallow-doctype)|noent\s*:\s*true|LIBXML_NOENT/, message: "XML parsing that may resolve external entities (XXE)." },
];

/** User-controlled input markers, per language family. */
export const TAINT_SOURCES: Record<string, RegExp> = {
  js: /\breq\.(?:body|query|params|headers|cookies|files?)\b|\brequest\.(?:body|query|params|json\(\)|formData\(\))|\bctx\.(?:request|query|params)\b|searchParams\.get|\bevent\.(?:body|queryStringParameters|pathParameters)|\bformData\.get/,
  python: /\brequest\.(?:args|form|json|data|values|files|GET|POST|body|query_params|headers|cookies)|\bevent\[["'](?:body|queryStringParameters)/,
  go: /\br\.(?:URL\.Query|FormValue|PostFormValue|Body|Header\.Get)|\bc\.(?:Query|Param|PostForm|FormValue|Bind\w*|ShouldBind\w*)\s*\(/,
  java: /@RequestParam|@PathVariable|@RequestBody|getParameter\s*\(|getHeader\s*\(|getInputStream\s*\(/,
  ruby: /\bparams\[|\bparams\.(?:require|permit|fetch)|\brequest\.(?:body|params|headers)/,
  php: /\$_(?:GET|POST|REQUEST|COOKIE|FILES|SERVER)\b|\$request->(?:input|get|query|all)\(/,
  csharp: /\[FromBody\]|\[FromQuery\]|Request\.(?:Query|Form|Body)/,
};

export function taintRegexFor(lang: string): RegExp | undefined {
  if (lang === "typescript" || lang === "javascript" || lang === "vue" || lang === "svelte") return TAINT_SOURCES.js;
  if (lang === "kotlin" || lang === "scala") return TAINT_SOURCES.java;
  return TAINT_SOURCES[lang];
}

/* ---- secrets ---- */

export interface SecretPattern {
  id: string;
  title: string;
  re: RegExp;
  severity: Severity;
}

export const SECRET_PATTERNS: SecretPattern[] = [
  { id: "aws-access-key", title: "AWS access key id", re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/, severity: "critical" },
  { id: "aws-secret-key", title: "AWS secret access key", re: /aws_?secret_?access_?key\s*[:=]\s*["']?[A-Za-z0-9/+=]{40}\b/i, severity: "critical" },
  { id: "github-token", title: "GitHub token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{60,}\b/, severity: "critical" },
  { id: "slack-token", title: "Slack token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, severity: "high" },
  { id: "slack-webhook", title: "Slack webhook URL", re: /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+/, severity: "medium" },
  { id: "stripe-live-key", title: "Stripe live secret key", re: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/, severity: "critical" },
  { id: "google-api-key", title: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/, severity: "high" },
  { id: "openai-key", title: "OpenAI API key", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}T3BlbkFJ[A-Za-z0-9_-]{20,}\b|\bsk-proj-[A-Za-z0-9_-]{40,}\b/, severity: "critical" },
  { id: "anthropic-key", title: "Anthropic API key", re: /\bsk-ant-(?:api|admin)\d{2}-[A-Za-z0-9_-]{80,}\b/, severity: "critical" },
  { id: "private-key", title: "Private key block", re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----/, severity: "critical" },
  { id: "db-url-password", title: "Database URL with inline password", re: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^:\s/@]+:[^@\s/]{3,}@(?!localhost|127\.0\.0\.1|db\b|postgres\b|mysql\b|redis\b)[\w.-]+/, severity: "high" },
  { id: "twilio-key", title: "Twilio API key", re: /\bSK[0-9a-fA-F]{32}\b/, severity: "high" },
  { id: "sendgrid-key", title: "SendGrid API key", re: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/, severity: "high" },
  { id: "npm-token", title: "npm token", re: /\bnpm_[A-Za-z0-9]{36}\b/, severity: "high" },
];

/** `password = "..."` style assignments with a high-entropy literal. */
export const GENERIC_SECRET_RE =
  /\b([A-Za-z_]*(?:password|passwd|secret|api_?key|apikey|access_?token|auth_?token|private_?key|client_?secret)[A-Za-z_]*)\s*[:=]\s*["']([^"'\s]{12,})["']/i;

export function shannonEntropy(s: string): number {
  const f = new Map<string, number>();
  for (const c of s) f.set(c, (f.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of f.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

const PLACEHOLDER = /^(?:x+|\*+|changeme|change_me|your[_-]?\w*|example\w*|placeholder|dummy|test\w*|secret|password|<[^>]+>|\$\{[^}]+\}|\{\{[^}]+\}\}|process\.env.*|null|none|todo|fixme|sample\w*|replace\w*|redacted)$/i;

export function isPlaceholder(v: string): boolean {
  return PLACEHOLDER.test(v) || /^(.)\1+$/.test(v) || /(?:example|placeholder|your|dummy|changeme|xxxx)/i.test(v);
}

/** Docs-style connection strings: `postgresql://user:pass@host/db`, `...:password@hostname`. */
export function isPlaceholderDbUrl(url: string): boolean {
  const m = /:\/\/([^:\s/@]+):([^@\s/]+)@([\w.-]+)/.exec(url);
  if (!m) return false;
  const [, user, pass, host] = m as unknown as [string, string, string, string];
  return (
    /^(?:pass|password|passwd|pwd|pw|secret|pass(?:word)?\d?|mypassword|yourpassword)$/i.test(pass) ||
    /^(?:host|hostname|server|your[-_]?host|db[-_]?host|example\.\w+)$/i.test(host) ||
    (/^(?:user|username|usr)$/i.test(user) && pass.length <= 8)
  );
}

/** Mask all but a short prefix of a secret-looking value. */
export function redact(line: string, secret: string): string {
  const keep = Math.min(4, Math.floor(secret.length / 5));
  return line.split(secret).join(secret.slice(0, keep) + "…[redacted]").slice(0, 200);
}
