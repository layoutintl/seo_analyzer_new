# Deployment Architecture — SEO Audit Runner (Phase 4)

Status: **approved contract** (Phase 4A, paths corrected). Implementation
follows in later phases. Scope: everything in this document applies only to
`ops/seo-audit-runner/`. The main SEO application (its runtime, Docker image,
nixpacks config, Node version, environment variables, startup command, and
PostgreSQL database) is **out of scope and must never be modified by runner
deployment work**.

## 1. Decision

**Primary architecture: Option A — systemd on a controlled Linux host.**

The runner is a zero-dependency Node CLI with local SQLite state. That is
exactly the shape systemd serves best:

| Concern            | How Option A covers it                                    |
|--------------------|-----------------------------------------------------------|
| Isolation          | dedicated system user, own runtime, own state dir         |
| Scheduling         | `Type=oneshot` service + timer, `Persistent=true` catch-up |
| Logging            | journald (rotation, retention, `journalctl -u`)            |
| Hardening          | `ProtectSystem=strict`, `ReadWritePaths=`, `PrivateTmp`     |
| Overlap protection | runner's own lock (exit code 4) + one timer                |
| Upgrades/rollback  | release directories + `current` symlink flip               |
| State persistence  | plain directory on disk; simplest possible backup/restore  |

**Fallback architecture (documented only, NOT implemented in Phase 4): Option B —
isolated Docker container.** A separate image built from
`ops/seo-audit-runner/` only (e.g. `FROM node:24-alpine`), state on a mounted
volume, scheduled by host systemd/cron or a platform scheduler. To be designed
in its own phase if ever needed. The fallback must never share the main
application's image, compose file, or platform service.

Rejected: dedicated new server (Option A plus procurement, no added safety),
cron-only (no hardening, no catch-up, weaker logging — kept only as a
documented degraded mode, see `deploy/README-deploy.md`).

## 2. Isolation guarantees (hard requirements)

1. **Separate Node.js runtime.** The runner uses its own Node installation
   (see §3). It never uses, upgrades, or configures the Node runtime of the
   main application, and no root-level `package.json` or lockfile is touched.
2. **Separate Linux system user.** All runner processes run as the dedicated
   non-root `seo-runner` user (see `deploy/README-deploy.md` §3); normal runs
   are performed as `seo-runner`, never root — root is used only for
   installation and administration.
3. **Separate state.** All durable state lives in the runner state directory
   (`RUNNER_STATE_DIR`, production: `/var/lib/seo-audit-runner/`). Nothing is
   written outside the runner's own directories.
4. **Separate configuration.** Runner env lives in its own root-protected file
   (`/etc/seo-audit-runner/runner.env`). The main application's
   `.env`/platform variables are never read or written.
5. **API-only integration.** The runner acts only as an outbound HTTP client
   and talks to the SEO application exclusively through its supported API —
   these five endpoints and nothing else:
   - `GET  /api/projects`
   - `GET  /api/projects/:id`
   - `GET  /api/projects/:id/audits/latest`
   - `POST /api/technical-analyzer/run`   ← the ONLY write endpoint
   - `GET  /api/audit-runs/:id/results`
6. **No application database access.** The runner never connects directly to
   the application's PostgreSQL (the app's `DATABASE_URL` is never configured
   for the runner). Its only database is its own SQLite file.
7. **No application deployment coupling.** No changes to the app's Dockerfile,
   docker-compose.yml, nixpacks.toml, server startup, or dublyo service.
8. **No network exposure. The runner listens on no network port.** It opens
   no server sockets and accepts no inbound connections; its only network
   activity is outbound HTTPS/HTTP to the configured application API and to
   Slack.

## 3. Node.js runtime requirement

- Minimum: **Node >= 22.5.0** (`node:sqlite` `DatabaseSync` floor; on
  22.5–23.x the `--experimental-sqlite` flag is required).
- Preferred: **Node 24 LTS** (node:sqlite needs no flag; the full runner test
  suite is verified on 24.x).
- The runtime is installed privately for the runner (e.g.
  `/opt/seo-audit-runner/node/`) and resolved by absolute path in the command
  wrapper — never via the interactive user's `PATH`, never via the main
  application's runtime, and never via a system-wide Node upgrade.

## 4. Scheduling contract

- Full audit (`run --all`): **daily at 03:00 Africa/Cairo**.
- Slack notification retry (`retry-notifications`): **hourly**.
- **Both timers are disabled by default at install time**, and installation
  never enables scheduling automatically. Enabling is a separate, explicit
  administrator action (`systemctl enable --now …`) allowed only after the
  production gates pass (see `docs/PRODUCTION_GATES.md`). If a later phase
  adds an explicit opt-in installer flag, it must still enforce those gates.

Timezone handling — two supported options, pick exactly one per host:

1. Set the host timezone to Cairo: `timedatectl set-timezone Africa/Cairo`,
   then use `OnCalendar=*-*-* 03:00:00`.
2. Keep the host on UTC and pin the timezone in the calendar expression
   (supported by systemd >= 235): `OnCalendar=*-*-* 03:00:00 Africa/Cairo`.
   Verify with `systemd-analyze calendar '*-*-* 03:00:00 Africa/Cairo'`.

Never configure both cron and the systemd timer for the same runner command
on the same host. The runner's lock makes an overlap safe (second instance
exits with code 4), but duplicate scheduling produces alert noise and wasted
audits.

## 5. SQLite state ownership and persistence

- The state directory (`RUNNER_STATE_DIR`, production default
  `/var/lib/seo-audit-runner/`) is owned `seo-runner:seo-runner` (0700) and is
  the ONLY durable state of the automation. It contains:
  - `runner-state.sqlite` (+ `-wal`, `-shm`) at
    `/var/lib/seo-audit-runner/runner-state.sqlite` — issue lifecycle,
    snapshots, automation-run history, Slack notification outbox/queue;
  - `runner-state.sqlite.backup-v<N>` — automatic pre-migration backups;
  - `run-<timestamp>.json`, `last-run.json` — informational run journals;
  - `backups/` — operational state backups (see `deploy/README-deploy.md` §6);
  - `seo-audit-runner.lock` — process lock; runtime-only, never backed up or
    restored. **Current code keeps the lock in the state dir; moving it to
    `/run/seo-audit-runner/` via a new `RUNNER_LOCK_DIR` setting is a
    Phase 4F code change** (see `deploy/README-deploy.md` §2a) — deployment
    artifacts must not assume it exists before then.
- Logging is journald-first; `/var/log/seo-audit-runner/` is an optional
  protected directory for cron-mode/file logging only
  (`deploy/README-deploy.md` §1).
- The SQLite file contains **no secrets** (verified: only Slack message bodies,
  project/audit metadata, and status columns are persisted).
- Losing the state database is degraded, not fatal: the next run re-reports all
  currently active P0 issues as NEW once, and undelivered notifications are
  lost. Backup/restore contracts exist to avoid exactly that
  (`deploy/README-deploy.md` §6).
- The state directory must survive install, upgrade, rollback, and uninstall.
  Only the explicit `purge` operation may delete it, and only after taking a
  final backup.

## 6. Scope restriction

Every Phase 4 change — code, scripts, units, docs, tests — lives under:

    ops/seo-audit-runner/

Enforcement is Gate 2 in `docs/PRODUCTION_GATES.md`: before any review or
commit, `git diff --name-only <base>...HEAD` must return paths starting with
`ops/seo-audit-runner/` and nothing else.

## 7. Line endings

All files under `ops/seo-audit-runner/` are LF in the repository, enforced by
`ops/seo-audit-runner/.gitattributes`. Forced-LF working-tree rules cover
`*.sh`, `*.service`, `*.timer`, `cron.example`, `logrotate.example`,
`*.env.example`, and the shebang entrypoint `bin/seo-audit-runner.js`.
