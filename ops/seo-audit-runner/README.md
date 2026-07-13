# seo-audit-runner

Standalone Linux automation command for the SEO analyzer application.

It discovers all projects, deduplicates domains, triggers a fresh SEO audit
per project **through the application's own supported HTTP API**, waits for
completion, extracts the issues the application classifies as critical
(`recommendation.priority === 'P0'`), and optionally sends a Slack digest.

**Isolation guarantees**

- Lives entirely in `ops/seo-audit-runner/`. No file of the main application
  is imported or modified.
- Pure HTTP API client — no database driver, no direct DB reads or writes.
- Audits are started through the exact same endpoint the frontend uses.
- Zero production npm dependencies (Node 20 built-ins + native `fetch`).

Endpoints used (the complete set):

| Purpose | Endpoint |
|---|---|
| List projects | `GET /api/projects` |
| Pre-flight `running_count` check | `GET /api/projects/:id` |
| Read-only request fallback | `GET /api/projects/:id/audits/latest` |
| Start audit | `POST /api/technical-analyzer/run` |
| Poll status / fetch results | `GET /api/audit-runs/:auditRunId/results` |

## Installation

Requires Node.js >= 20.10 (same major version the main app uses).

```bash
cd ops/seo-audit-runner
npm install          # no production dependencies; completes instantly
npm link             # optional: puts `seo-audit-runner` on your PATH
```

Without `npm link`, invoke it directly:

```bash
node bin/seo-audit-runner.js --help
```

## Configuration

```bash
cd ops/seo-audit-runner
cp .env.example .env
"${EDITOR:-nano}" .env
```

All settings (defaults shown):

```env
SEO_API_BASE_URL=http://localhost:3000
RUNNER_CONCURRENCY=1
POLL_INTERVAL_MS=5000
POLL_TIMEOUT_MS=900000
HTTP_REQUEST_TIMEOUT_MS=30000
RUNNER_STATE_DIR=/var/lib/seo-audit-runner   # default when unset: <runner>/state
RUNNER_LOG_LEVEL=info
NOTIFICATIONS_ENABLED=false
# SLACK_WEBHOOK_URL=...   required only when NOTIFICATIONS_ENABLED=true
```

Environment variables always win over `.env` values. A different env file can
be passed with `--env-file /path/to/file`.

### Security

The application API has **no authentication** (by design of the current app —
the runner does not invent a token header). Therefore:

- `SEO_API_BASE_URL` must point to a **trusted private endpoint**: localhost,
  a Docker network hostname, or a VPN/internal address.
- Plain-`http` URLs to public hosts are **rejected** at config validation.
  For development only, `ALLOW_INSECURE_PUBLIC_API=true` overrides this.
- URLs containing credentials are never logged (credentials are masked), and
  the Slack webhook URL is registered as a secret and redacted from all logs.

## Usage

```bash
seo-audit-runner validate-config          # check config + state dir (offline)
seo-audit-runner list-projects            # read-only listing with dedupe preview
seo-audit-runner run --all                # audit every deduplicated project
seo-audit-runner run --project PROJECT_ID # audit one project
seo-audit-runner run --all --dry-run      # plan only — no POST, no writes, no notifications
seo-audit-runner run --all --max-concurrency 1
seo-audit-runner run --all --no-notifications
seo-audit-runner run --all --fail-on-critical
```

### What a run does

1. `GET /api/projects` — discover all projects.
2. Normalize domains **for comparison only** (lowercase; strip scheme,
   credentials, path, query, fragment, trailing dot; ignore ports 80/443;
   keep other ports; strip one leading `www.`; other subdomains stay
   distinct). Original IDs and URLs are never replaced.
3. Deduplicate: one project per normalized domain. Winner selection order:
   usable `last_form_values` → most recent `last_audit_at` → most recent
   `updated_at` → `completed_count > 0` → lowest project ID. Losers are
   reported as `deduplicated: covered by <winner-project-id>`; nothing is
   deleted or modified.
4. Build the audit request from `last_form_values`
   (`sectionUrl→section`, `tagUrl→tag`, `searchUrl→search`,
   `authorUrl→author`, `videoArticleUrl→video_article`); if `homeUrl` or
   `articleUrl` is missing, fall back read-only to the latest completed
   audit's page types. If no valid pair exists →
   `SKIPPED_MISSING_AUDIT_CONFIG` (never guessed or crawled).
5. Pre-flight `GET /api/projects/:id`: if `running_count > 0` →
   `SKIPPED_ALREADY_RUNNING` (the app's audit endpoint replaces the site's
   `seed_urls`, so overlapping same-site runs are unsafe).
6. `POST /api/technical-analyzer/run` → `{ siteId, auditRunId }` (both are
   stored in the run report). **This POST is never retried automatically**:
   after an ambiguous failure (timeout / reset / lost response) the runner
   only re-checks read-only endpoints and reports
   `TRIGGER_OUTCOME_UNKNOWN`.
7. Poll `GET /api/audit-runs/:auditRunId/results` with jittered, abortable
   requests until `COMPLETED` or `FAILED`, or report `TIMED_OUT` after
   `POLL_TIMEOUT_MS` (the application's audit status is never touched).
8. Extract critical issues: exactly `priority === 'P0'` from page
   `recommendations` and top-level `siteRecommendations`. Page status
   (`PASS`/`WARN`/`FAIL`) is not a severity signal; P1/P2 are never promoted.
9. Write the run journal to `RUNNER_STATE_DIR` (`last-run.json` +
   `run-<timestamp>.json`), send the optional Slack digest, print the report.

### Concurrency & locking

- `RUNNER_CONCURRENCY` (default **1**) bounds parallel audits across
  *different* sites; the same normalized domain never runs twice in one
  execution.
- A process lock file in `RUNNER_STATE_DIR` prevents two runner processes
  from executing simultaneously (exit code 4). The lock is released on
  success, error, `SIGINT`, and `SIGTERM`; a lock left by a dead process is
  reclaimed automatically. Note: the lock is also taken for `--dry-run`.

### Retry policy

- GET requests: exponential backoff with jitter on network failures and
  HTTP 429/500/502/503/504 (max 3 retries). Other 4xx are never retried.
- The audit-trigger POST: exactly one attempt, ever (see step 6).

### Exit codes

| Code | Meaning |
|---|---|
| 0 | completed successfully |
| 1 | configuration or runner-level failure (including aborted runs) |
| 2 | one or more audits `FAILED`, `TIMED_OUT`, `TRIGGER_FAILED`, or `TRIGGER_OUTCOME_UNKNOWN` |
| 3 | critical issues found and `--fail-on-critical` enabled |
| 4 | another runner instance is already active |

Precedence when several conditions occur: **4 > 1 > 3 > 2 > 0**.
(4 and 1 are decided at startup / on runner failure; among run results,
`--fail-on-critical` outranks audit failures because it is the explicitly
requested signal.)

### Notifications (Phase 2)

Disabled by default (`NOTIFICATIONS_ENABLED=false`). When enabled with a
`SLACK_WEBHOOK_URL`, a single digest message per run is posted: counts,
per-project P0 lists, and projects needing attention. `--no-notifications`
and `--dry-run` force-disable them for a run.
Alert history, issue fingerprinting, reopened/resolved detection, and
persistent dedup are Phase 3 (the notifier interface in `src/notifier.js` is
the extension point).

## Scheduling on Linux

Cron (every day at 06:00):

```cron
0 6 * * * cd /opt/seo-analyzer/ops/seo-audit-runner && /usr/bin/node bin/seo-audit-runner.js run --all >> /var/log/seo-audit-runner.log 2>&1
```

systemd timer:

```ini
# /etc/systemd/system/seo-audit-runner.service
[Unit]
Description=SEO audit runner
After=network-online.target

[Service]
Type=oneshot
WorkingDirectory=/opt/seo-analyzer/ops/seo-audit-runner
ExecStart=/usr/bin/node bin/seo-audit-runner.js run --all
Environment=RUNNER_STATE_DIR=/var/lib/seo-audit-runner

# /etc/systemd/system/seo-audit-runner.timer
[Unit]
Description=Daily SEO audits

[Timer]
OnCalendar=*-*-* 06:00:00
Persistent=true

[Install]
WantedBy=timers.target
```

## Tests

```bash
cd ops/seo-audit-runner
npm test
```

All HTTP requests in tests are mocked — no real audits are ever started.

## Assumptions & limitations

- The application must run in **DB mode** (`DATABASE_URL` set). In in-memory
  mode the trigger endpoint returns results synchronously and nothing can be
  polled; the runner reports this as a clear `TRIGGER_FAILED`.
- `running_count` is a best-effort guard: the app itself has no server-side
  lock, so a race with a human clicking "run" in the UI at the same second is
  still possible. The runner minimizes the window by checking immediately
  before triggering.
- After `TRIGGER_OUTCOME_UNKNOWN` the runner intentionally does nothing
  further for that project; re-run later once `running_count` is 0 again.
- `TIMED_OUT` means the runner stopped waiting — the audit may still finish
  server-side; the application status is never modified.
