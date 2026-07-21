# Deployment Contracts — SEO Audit Runner

Status: **approved contract** (Phase 4A). This file defines the target layout
and the behavioral contracts that the Phase 4B–4E scripts must implement.
No script referenced here exists yet; nothing in this document is executable.

Architecture decision and isolation rules: `../docs/DEPLOYMENT_ARCHITECTURE.md`.
Safety gates: `../docs/PRODUCTION_GATES.md`.

## 1. Production installation layout

| Path                                        | Purpose                          | Owner              | Mode  |
|---------------------------------------------|----------------------------------|--------------------|-------|
| `/opt/seo-audit-runner/releases/<stamp>/`   | immutable installed release      | `root:root`        | 0755  |
| `/opt/seo-audit-runner/current`             | symlink → active release         | `root:root`        | —     |
| `/opt/seo-audit-runner/node/`               | isolated Node runtime (≥22.5, 24 LTS preferred) | `root:root` | 0755 |
| `/usr/local/bin/seo-audit-runner`           | command wrapper (symlink/script) | `root:root`        | 0755  |
| `/etc/seo-runner/env`                       | runner environment (secrets)     | `root:seo-runner`  | 0640  |
| `/var/lib/seo-runner/state/`                | `RUNNER_STATE_DIR` (SQLite etc.) | `seo-runner:seo-runner` | 0700 |
| `/var/backups/seo-runner/`                  | state backups                    | `seo-runner:seo-runner` | 0700 |
| systemd units in `/etc/systemd/system/`     | service + timers (Phase 4C)      | `root:root`        | 0644  |

Notes:
- Releases are immutable: an upgrade installs a new `releases/<stamp>/` and
  flips the `current` symlink. Code directories are read-only for `seo-runner`
  (root-owned); the runner only ever writes inside `/var/lib/seo-runner/state`.
- Logs go to journald; no log files and no logrotate requirement in the
  default layout. If an operator redirects output to files instead, they own
  rotation (a `logrotate.example` may ship in a later phase).
- A non-root "user mode" install (everything under `~/seo-audit-runner/`,
  cron instead of system units) is a documented degraded option for hosts
  without root; contracts below still apply with paths translated.

## 2. Command wrapper contract (`/usr/local/bin/seo-audit-runner`)

- Resolves the isolated Node binary by absolute path
  (`/opt/seo-audit-runner/node/bin/node`), never `$PATH`.
- Adds `--experimental-sqlite` automatically when the resolved Node major
  version is 22 or 23; adds nothing on 24+.
- Executes `/opt/seo-audit-runner/current/bin/seo-audit-runner.js "$@"` with
  the environment loaded by systemd (`EnvironmentFile=/etc/seo-runner/env`);
  when invoked interactively it sources the same file if readable.
- Exit codes pass through unchanged (0/1/2/3/4 — see runner README).

## 3. User and permission model

- Dedicated system user: `seo-runner` (`useradd --system --shell
  /usr/sbin/nologin --home-dir /var/lib/seo-runner seo-runner`). No login, no
  sudo, no membership in the app's groups.
- `seo-runner` can read: the installed release (world-readable code),
  `/etc/seo-runner/env` (group read).
- `seo-runner` can write: only `/var/lib/seo-runner/state` and
  `/var/backups/seo-runner`.
- Nothing in the runner requires root at runtime. Root is needed only for
  install/upgrade (writing `/opt`, `/etc`, unit files).
- Secrets (`SLACK_BOT_TOKEN` / `SLACK_WEBHOOK_URL`) exist only in
  `/etc/seo-runner/env` (0640) — never in argv, unit files, SQLite, or logs
  (the runner already redacts them in its logger).

## 4. Scheduling contract

- Daily audit: `seo-audit-runner.timer` → `seo-audit-runner.service`
  (`run --all`), **03:00 Africa/Cairo**, `RandomizedDelaySec` small,
  `Persistent=true`.
- Hourly retry: `seo-runner-retry.timer` → `seo-runner-retry.service`
  (`retry-notifications`).
- **Both timers ship disabled** (`systemctl enable` is never run by install
  scripts). Enabling is a manual administrator action gated by
  `docs/PRODUCTION_GATES.md` Gate 6/7.
- Timezone: either set the host to `Africa/Cairo`, or use
  `OnCalendar=*-*-* 03:00:00 Africa/Cairo` (systemd ≥ 235). Exactly one
  scheduling mechanism per command per host (no cron + timer duplication).
- Cron fallback (documented, not installed): the two crontab lines shipped as
  `deploy/cron.example` in Phase 4C.

## 5. Installation contract (Phase 4B script `install.sh`)

- Idempotent: re-running against the same release is a no-op; against a new
  release it behaves as upgrade §7.
- Creates user, directories, and permissions exactly as §1/§3.
- Copies `ops/seo-audit-runner/` (bin, src, package.json, README, docs) into a
  new release dir; **excludes** `state/`, `.env`, tests optional.
- Writes `/etc/seo-runner/env` only from a provided template if absent; never
  overwrites an existing env file.
- Installs systemd units (Phase 4C) but **never enables or starts timers**.
- Ends by running `seo-audit-runner validate-config` as `seo-runner` and
  reporting the result. Install fails loudly if validation fails.
- Touches nothing outside the paths in §1.

## 6. Backup and restore contracts (Phase 4D)

Backup (`backup.sh`):
- Source: the state directory only (SQLite + `.backup-v*` + journals;
  **never** the lock file, never `/etc/seo-runner/env` — config/secrets are
  backed up separately by the operator's secret store).
- Method: consistent SQLite copy — `sqlite3 <db> ".backup <dest>"` when the
  sqlite3 CLI exists, otherwise `PRAGMA wal_checkpoint(TRUNCATE)` + file copy
  via the runner's own Node runtime. Then tar the state dir snapshot with a
  UTC timestamp into `/var/backups/seo-runner/`.
- Runs a `PRAGMA quick_check` first and refuses to back up a database that
  fails it (protects the backup set from silently rotating in corruption).
- Retention: keep newest N (default 14); pruning deletes only files matching
  the backup naming pattern inside `/var/backups/seo-runner/`.
- Safe while the runner is running (WAL + `.backup`/checkpoint semantics), but
  the scheduled backup should avoid the 03:00 audit window.

Restore (`restore.sh`):
- Refuses to run while the service is active or the state-dir lock is held.
- Never deletes existing state: renames the current state dir to
  `state.pre-restore-<stamp>` and restores the chosen backup into a fresh dir,
  then swaps atomically.
- Ends with `seo-audit-runner status` to prove the restored DB opens and
  migrates cleanly.
- Rollback of a bad restore = swap the renamed directory back.

## 7. Upgrade and rollback contracts (Phase 4E)

Upgrade (`upgrade.sh`):
1. `backup.sh` (mandatory; abort on failure),
2. install the new code as a new `releases/<stamp>/`,
3. flip `current` symlink,
4. run `validate-config` (which also applies any runner SQLite migrations —
   these are versioned, transactional, and take their own pre-migration
   `.backup-v<N>` copy),
5. on any failure: flip the symlink back and report — automatic code rollback.
- State is never modified by upgrade except through the runner's own
  migrations.

Rollback (`rollback.sh`):
- Flips `current` to the previous release directory. Code-only, instant.
- SQLite schema is NOT downgraded. Policy: rolling back code across a runner
  schema-version bump additionally requires restoring the matching state
  backup (the migration's `.backup-v<N>` or the pre-upgrade backup from step 1).
  The script must detect a schema version newer than the rolled-back code
  supports and instruct the operator instead of guessing.

## 8. Uninstall and purge contracts (Phase 4E)

Uninstall (`uninstall.sh`) — non-destructive:
- Stops and disables units, removes unit files, removes `/opt/seo-audit-runner`
  and the wrapper.
- **Preserves**: `/var/lib/seo-runner/state`, `/var/backups/seo-runner`,
  `/etc/seo-runner/env`, and the `seo-runner` user.
- Prints exactly what was kept and where.

Purge (`purge.sh`) — explicit destruction:
- Requires an unambiguous flag (e.g. `--yes-delete-state`).
- Takes a final backup to a location the operator names, then removes state,
  backups dir, env file, and optionally the user.
- Never runs as part of uninstall, upgrade, or any automated flow.

## 9. Validation before and after any host change

Repeat these read-only checks before and after every deployment action
(install/upgrade/rollback/restore), and record the output:

- Application (must be unaffected):
  `GET /health`, `GET /api/health`, `GET /api/build-info` on the live app.
- Runner: `seo-audit-runner validate-config`, `seo-audit-runner status
  --output json`, `seo-audit-runner run --all --dry-run` (dry-run performs
  read-only GETs and triggers nothing).

## 10. Line endings

Every file under `ops/seo-audit-runner/` is LF (enforced by
`.gitattributes`). Shell scripts, systemd units, cron/logrotate examples, and
env templates are explicitly pinned `eol=lf`; a CRLF script or unit file is a
deployment-blocking defect, checked in Gate 3 (`bash -n` + a byte-level CRLF
scan).
