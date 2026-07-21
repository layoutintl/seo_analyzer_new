# Jobs and Schedules — SEO Audit Runner

Status: implemented (Phase 4C+). All of this lives in the runner's OWN
SQLite database (`/var/lib/seo-audit-runner/runner-state.sqlite`, schema
v3) — never in the application's PostgreSQL (isolation contract,
`DEPLOYMENT_ARCHITECTURE.md` §2).

## Model

**systemd starts the worker; the runner decides what is due.**
`seo-runner-tick.timer` (every 5 min, ships disabled) runs
`seo-audit-runner worker --once` as `seo-runner`. One tick:

1. **recover** — RUNNING jobs whose worker pid is dead → `FAILED`
   (`interrupted: …`); nothing is ever silently marked successful;
2. **enqueue** — each enabled schedule whose latest occurrence is due
   gets at most one job (unique `(schedule_id, occurrence_key)` index);
3. **execute** — QUEUED jobs are claimed atomically (single-statement
   `UPDATE … WHERE status='QUEUED'`; SQLite serializes writers) and run
   sequentially by spawning the runner CLI itself
   (`run --all` / `run --project <id>`) with structured argv — no shell,
   no eval. The child takes the runner's process lock, so a job can never
   overlap a manual run: on lock contention the child exits 4 and the job
   returns to QUEUED (attempt refunded) for the next tick.

## Job states

```
QUEUED ──claim──▶ RUNNING ──exit 0──▶ SUCCEEDED
   ▲                 │────exit ≠0──▶ FAILED ──job retry──▶ QUEUED
   │                 │────exit 4 (lock busy)──▶ QUEUED (deferred)
   └── job cancel (QUEUED only) ──▶ CANCELLED
```

Recorded per job: `created_at`, `started_at`, `finished_at`,
`updated_at`, `attempts`, `exit_code`, and a **sanitized** `error`
(secret-redacted, token-masked, truncated to 500 chars). A job is
SUCCEEDED **only** when the audit process exited 0.

## Schedule semantics

Frequencies: `daily`, `weekly` (`--day-of-week 0..6`, 0=Sunday),
`monthly` (`--day-of-month 1..31`, clamped to the month's last day —
day 31 in April runs on the 30th). **Cron expressions are deliberately
not supported** (the approved scheduling contract defines fixed
calendars, not cron syntax).

- **Timezone**: each schedule stores an IANA timezone (default
  `Africa/Cairo`, matching the production contract). Occurrences are
  computed as local wall-clock times in that zone and converted to UTC
  through the platform zoneinfo.
- **DST**: a wall time that does not exist on a spring-forward day
  resolves to the instant after the gap; an ambiguous (repeated) fall-back
  time resolves to its first occurrence. A host timezone change does not
  affect schedules (they carry their own zone).
- **Missed occurrences** (host down, timer disabled): only the MOST
  RECENT missed occurrence is considered, and only within the 24 h
  catch-up window — at most one catch-up job, mirroring systemd
  `Persistent=true`. Older misses are skipped, never batched.
- **At-most-once**: the occurrence key is a calendar bucket
  (`YYYY-MM-DD` for daily/weekly, `YYYY-MM` for monthly). The unique
  `(schedule_id, occurrence_key)` index makes one occurrence → one job a
  database guarantee, across concurrent ticks and schedule edits: editing
  a schedule's time never re-creates a job for a bucket that already ran.
- Schedules are **created disabled** and enabled explicitly
  (`schedule enable <id>`), consistent with the ship-disabled contract.

## Locking summary

| Concern | Mechanism |
|---|---|
| same job started twice | atomic SQLite claim (`UPDATE … WHERE status='QUEUED'`) |
| overlapping audits (any two runs) | runner process lock in the state dir (exit 4) |
| same-site overlap inside one run | orchestrator never parallelizes same-site audits |
| stale lock after crash | lock stores pid; dead-pid locks are reclaimed automatically |
| stale RUNNING job after crash | next tick marks it FAILED; `job retry` re-queues |

`/run/seo-audit-runner/` is provisioned but intentionally unused — the
lock stays in the state directory until the approved `RUNNER_LOCK_DIR`
change lands (Phase 4F, `deploy/README-deploy.md` §2a).

## CLI reference

```bash
seo-audit-runner job create --project <id> | --all
seo-audit-runner job list [--status QUEUED|RUNNING|SUCCEEDED|FAILED|CANCELLED] [--limit N]
seo-audit-runner job show|retry|cancel <job-id>
seo-audit-runner schedule create --frequency daily|weekly|monthly --at HH:MM
                                 [--project <id> | --all] [--timezone <IANA>]
                                 [--day-of-week 0..6] [--day-of-month 1..31]
seo-audit-runner schedule update <id> [same flags]
seo-audit-runner schedule enable|disable|delete <id>
seo-audit-runner schedule list
seo-audit-runner worker --once
```

All verbs accept `--output json`. This CLI is the backend's control
channel — see `BACKEND_CONTROL_API.md`.
