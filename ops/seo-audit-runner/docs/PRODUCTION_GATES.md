# Production Protection Gates — SEO Audit Runner Phase 4

Status: **approved contract** (Phase 4A). Every later phase must pass these
gates in order. No gate may be skipped, and no gate may be marked passed
without recorded evidence (command output pasted into the phase review).

## Standing rules (apply to every gate and every phase)

- All changes stay under `ops/seo-audit-runner/`. Nothing else in the
  repository — and nothing in the main application's runtime, Docker/nixpacks
  config, environment, or PostgreSQL database — is touched.
- No commit, push, PR, merge, or deployment without explicit approval of the
  phase's diff.
- No production audit is triggered and no production project is created during
  development, testing, or staging.
- Production scheduling stays disabled until Gate 6 and Gate 7 both pass.

## Gate 1 — Baseline (PASSED in the Phase 4 discovery, 2026-07-21)

- Working tree clean; branch `feat/seo-runner-phase-4` from `origin/main`.
- Runner test baseline recorded: 186/186 pass (`npm test`, Node 24.14.0).
- Live production health recorded:
  `/health` 200, `/api/health` 200 (connected + schemaReady true, host
  `seo-tools-postgres`), `/api/build-info` 200.
- Production project count recorded: 0 (empty internal DB) — this is why
  Gate 6 is blocked (see below).

## Gate 2 — Scope enforcement (checked before every review)

- `git diff --name-only <base>...HEAD` and `git status --short` show only
  paths beginning with `ops/seo-audit-runner/`.
- Zero changes to root package files, Dockerfile, docker-compose.yml,
  nixpacks.toml, `server/`, `backend/`, `src/`, `supabase/`, `scripts/`.
- Violation = stop, revert the out-of-scope change, re-review.

## Gate 3 — Local validation (per implementation phase)

- Full runner suite green: `cd ops/seo-audit-runner && npm test`
  (baseline 186; new phases may only add tests, never break existing ones).
- Shell syntax: `bash -n` / `sh -n` on every `deploy/*.sh`.
- CRLF scan: no `\r` bytes in any `*.sh`, `*.service`, `*.timer`,
  `cron.example`, `*.env.example` under `ops/seo-audit-runner/`.
- systemd validation: `systemd-analyze verify` on all units and
  `systemd-analyze calendar` on every `OnCalendar=` expression (requires a
  Linux host or container; this step is deferred to Gate 5 when developing on
  Windows).
- Deployment tests run against throwaway temp directories only:
  fresh-install test, re-install (idempotency) test, upgrade test with a
  PRE-POPULATED SQLite state (state must survive byte-for-byte or via clean
  migration), backup/restore round-trip test.
- `git status --short` clean of unintended files after tests.

## Gate 4 — Review (per phase)

- Complete diff presented; nothing staged or committed beforehand.
- Security review of the diff: no secrets, no root-of-repo changes, no
  path outside the contract layout, no TLS bypasses, file permissions match
  `deploy/README-deploy.md` §1/§3.
- Rollback method for the phase stated explicitly and reviewed.
- Explicit approval required before `git add`/commit/push/PR.

## Gate 5 — Isolated staging (before any production contact)

- A Linux host or container that is NOT the production app host.
- Runner configured against a MOCK of the five API endpoints (or a locally
  run app instance with a scratch database) — never the production URL.
- Full sequence exercised: install → validate-config → list-projects →
  status → run --all --dry-run → mock live run → retry-notifications
  → backup → restore → upgrade → rollback → uninstall.
- Verify both timers exist but are `disabled`/`inactive`
  (`systemctl is-enabled` returns `disabled`).
- Slack tested against a sandbox channel/webhook, never the real alert channel.

## Gate 6 — Controlled production installation (BLOCKED)

**Blocking precondition (approved decision):** the live application currently
has zero projects. This gate stays blocked until:
1. production projects are recreated or migrated into the live database, and
2. one specific project is explicitly approved by the operator for a
   controlled manual audit.

When unblocked, the sequence is strict and manual:
1. Record live app health (`/health`, `/api/health`, `/api/build-info`).
2. Take a state backup (even if state is empty — proves the path works).
3. Install WITHOUT enabling any timer.
4. `seo-audit-runner validate-config` — must pass.
5. `seo-audit-runner list-projects` — read-only; confirm expected projects.
6. `seo-audit-runner status` — state DB opens and migrates.
7. `seo-audit-runner run --all --dry-run` — read-only planning only.
8. `seo-audit-runner run --project <the one approved project>` — the single
   controlled production audit, watched live.
9. Review results, Slack output, state DB, and app health.
10. Only after review may the administrator consider enabling the daily timer
    (a separate explicit `systemctl enable --now` decision, plus the hourly
    retry timer).

## Gate 7 — Post-install monitoring (first week after enabling)

- Application health endpoints unchanged and healthy after each scheduled run.
- Runner journal (`journalctl -u seo-audit-runner`) reviewed; exit codes 0/2
  understood, any 1/4 investigated.
- Notification queue drained: `seo-audit-runner status --output json` shows no
  growing PENDING/FAILED backlog.
- SQLite health: `PRAGMA quick_check` via the backup script's pre-check.
- No duplicate runs (no unexpected exit-4 lock collisions, exactly one run per
  day in `automation_runs`).
- No unexpected load on the application (audit counts match the schedule).
- The rollback command for the installed release is documented and tested:
  `deploy/rollback.sh` (code) + restore procedure (state) from
  `deploy/README-deploy.md` §6–§7.
