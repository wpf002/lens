# Dynamic Probe Plan

`lens probe` sends safe requests to the routes `entrypoints.ts` already extracted, on Will's own running app, and writes the results into `g.security.findings` so they flow into Remediate.

## Command

```
lens probe [dir] --target http://localhost:3000            # local
lens probe [dir] --target https://staging.app.dev --staging-host staging.app.dev
lens probe [dir] --target ... --dry-run                    # print every planned request, send nothing
```

- On a TTY it prints the request count, host, and methods, then asks `Send N requests to <host>? [y/N]`. `--yes` skips the prompt (for scripts).
- Optional config: `.lens/probe.json` (zod-validated, committed, holds no secrets):

```json
{
  "safeToProbe": ["POST /api/search"],
  "accounts": {
    "a": { "headersFromEnv": { "Cookie": "LENS_PROBE_A_COOKIE" } },
    "b": { "headersFromEnv": { "Cookie": "LENS_PROBE_B_COOKIE" } }
  },
  "objects": { "/api/orders/:id": { "a": "ord_1", "b": "ord_2" } },
  "rateLimit": 5,
  "maxRequests": 500
}
```

Session values come from env vars only. The config names the variable, never the value.

## Safety Limits (Hard-Coded)

| Limit | Value |
|---|---|
| Hosts allowed | `localhost`, `127.0.0.1`, `[::1]`, `*.localhost`, `*.test`. Anything else is refused. |
| Staging host | Only if passed as `--staging-host` and equal to the `--target` host, and a subdomain label (left of the registrable domain) is one of `staging`, `stage`, `dev`, `test`, `qa`, `sandbox`, `preview`, alone or hyphenated (`staging-2`, `api-dev`). Refused if it matches `project.homepage`. |
| DNS check | `localhost` / `*.localhost` must resolve to loopback. No target may resolve to a link-local or unspecified address (`169.254.0.0/16`, `0.0.0.0`, `::`, `fe80::`). `*.test` may resolve to loopback (local proxies). Resolved once per run; every request is pinned to that address through a custom `lookup`, so a DNS change mid-run can't move traffic. |
| Redirects | Never followed (`redirect: "manual"`). A 3xx is recorded, not chased. |
| Every request URL | Re-checked against the allowlist right before `fetch`. One choke point in `client.ts`. |
| Methods | `GET` and `HEAD` only. `POST` only for routes listed in `safeToProbe`. `PUT`, `PATCH`, `DELETE` are never sent. `ANY` routes get `GET`. |
| Routes | Only extracted `http`/`webhook`/`server-action` routes. No crawling, no link following, no route guessing. Webhooks get `GET` only. |
| Rate | 1 request in flight. Default 5 req/s, hard max 20. |
| Volume | Default 500 requests per run, hard max 2000. |
| Timeout | 5s per request. Response body read capped at 256 KB. |
| Backoff | 429 → wait `Retry-After` (max 30s), then continue. 10 total 5xx → stop the run. |
| Payloads | Fixed strings, no randomness beyond a marker id. No SQL keywords, no `UNION`, no `SLEEP`, no comments, no stacked queries. |
| Audit log | Every request appended to `.lens/probe-log.jsonl` (method, URL, status, ms). Account headers redacted. File gitignored. |

## Probes

| Probe | Request | Evidence | Result |
|---|---|---|---|
| Unauthenticated access | Route with `auth: unguarded` or `unknown`, no credentials | 2xx | Confirms `unauthenticated-mutation` / `server-action-no-auth` on that route |
| | | 401/403 | Marks those findings `false_positive`, sets endpoint `auth: guarded` with evidence `probe: GET /x returned 401` |
| IDOR | Account A requests B's object id from `objects` | 2xx and body equals B's own response for that id | New `dyn-idor` (high, CWE-639) |
| Reflected input | Query param `lensprobe=lp<id>"'<x>` on GET routes, and the same as a JSON string field on safe POSTs | Marker returned unescaped in a `text/html` response | New `dyn-reflected-xss` (high, CWE-79); confirms existing `xss` findings reachable from the route |
| SQL error | `'` and `"` appended to path params and to existing query params | DB error signature in body (`SQLSTATE`, `syntax error at or near`, `You have an error in your SQL syntax`, `SQLITE_ERROR`, `unterminated quoted string`, `ORA-0`) | New `dyn-sql-error` (high, CWE-89); confirms existing `injection` findings reachable from the route |
| Security headers | `GET /` | Missing CSP, `X-Content-Type-Options`, `X-Frame-Options`/`frame-ancestors`, `Referrer-Policy`; HSTS on https only | One `dyn-missing-headers` per host (low, CWE-693) |
| CORS | `Origin: https://lens-probe.invalid` on `GET /` and each reflect request; reported once per host | `Access-Control-Allow-Origin` echoes it | `dyn-cors-reflect`: high with `Allow-Credentials: true`, medium without (CWE-942) |
| Verbose errors | Responses from the SQL probe | Stack trace (`at ... (/...:\d+:\d+)`, `Traceback (most recent call last)`, `node_modules/`, Werkzeug/Django debug page) | `dyn-verbose-error` (medium, CWE-209) |

`.invalid` is a reserved TLD, so the CORS origin can't reach any real host.

## How Results Land in the Graph

- Status changes and new findings go through one pure function, `applyProbeResults(graph, results)`, in core. Same zod caps as the triage patch.
- A clean probe only clears **auth** findings, and only on 401/403. A probe that finds no SQL error or reflection does not clear `injection` or `xss` findings. No error doesn't prove the code is safe.
- New findings attach to the endpoint node's file and line. Per-host findings (headers, CORS on `/`) attach to the file that starts the server (`listen(`), falling back to the first endpoint file.
- Re-runs replace earlier `dyn-*` findings that are still open, keyed by rule + route, so rows don't duplicate. Findings Will marked Fixed or Won't Fix keep that state.
- `triageNote` records the evidence: method, path, status, and the matched signature.

## Code Layout

- `packages/core/src/security/probe/allowlist.ts`: host and DNS checks (pure except the lookup).
- `.../probe/plan.ts`: graph + config → list of planned requests (pure).
- `.../probe/checks.ts`: response → evidence (pure).
- `.../probe/client.ts`: the only module that calls `fetch`. Rate limit, allowlist, timeout, body cap, log.
- `.../probe/merge.ts`: `applyProbeResults` (pure).
- `packages/cli/src/index.ts`: `lens probe` command.

Not in this change: a dashboard button. The CLI writes the graph, so results show in the Security tab and Remediate on next load.

## Tests

- Fixture server: `node:http` on `127.0.0.1:0` in the test, with routes for each case (open route, 401 route, IDOR pair, reflecting route, SQL-error route, CORS-reflecting route, stack-trace route, missing headers) and a small graph fixture pointing at it.
- Unit tests: allowlist accepts the listed hosts and refuses `example.com`, `10.0.0.1`, `0.0.0.0`, `localhost.evil.com`, staging hosts without a test label, and the homepage host. Redirects are not followed. `PUT`/`DELETE` never planned. POST only when `safeToProbe` lists it. Rate limit spacing. `maxRequests` cap. 5xx stop.
- Merge tests: 401 clears auth findings, 2xx confirms them, clean injection probe leaves `injection` findings open, re-run doesn't duplicate.

## Notes from implementation

- Server actions are skipped: calling one needs the framework's action id, which the graph doesn't hold.
- Regex-style routes (`re_path`, bare `*`) are skipped because they can't be filled in.
- `lens probe` appends one line per request to `.lens/probe-log.jsonl` (gitignored). The log holds method, path, status, and timing, never headers.
- Before sending, `lens probe` opens a TCP connection to each vetted address and pins the first one that accepts. `localhost` resolves to `::1` and `127.0.0.1`, and most dev servers bind only one. With nothing listening it stops before sending anything.
- A failed connection pauses the run 1s so a dev server restarting on a file change can come back. Five failures in a row end the run.
- First live run (brefach_studio, local API, 367 GETs): all requests answered, 1 new finding (missing security headers). With `API_SECRET` unset locally, every route answers without credentials. That's the local config, so auth results only mean something with the secret set.
