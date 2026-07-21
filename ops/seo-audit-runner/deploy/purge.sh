#!/usr/bin/env bash
# purge.sh — EXPLICIT state destruction (contract §8). Never part of
# uninstall, upgrade, or any automated flow.
#
# Requires BOTH:
#   --yes-delete-state              the unambiguous confirmation flag
#   --final-backup-to <dir>         an operator-named location that receives
#                                   a final state backup BEFORE deletion
#
# Deletes (after the final backup succeeds): the state directory including
# backups/, the configuration directory (runner.env!), and the log
# directory. The seo-runner user is kept unless --delete-user is given.
# Refuses to run while the runner is active.
#
# Staged-test overrides: --destdir plus the backup.sh overrides.
set -Eeuo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

DESTDIR=
CONFIRMED=0
FINAL_BACKUP_TO=
DELETE_USER=0

usage() {
  cat <<'EOF'
Usage: purge.sh --yes-delete-state --final-backup-to <dir> [--delete-user]
                [--destdir <dir>]

Permanently deletes runner state, backups, configuration (runner.env),
and logs — AFTER writing a final backup to the directory you name.
Run deploy/uninstall.sh first to remove code and units.
EOF
}

log()  { printf 'purge.sh: %s\n' "$*"; }
fail() { printf 'purge.sh: ERROR: %s\n' "$*" >&2; exit 1; }

while [ "$#" -gt 0 ]; do
  case $1 in
    --help|-h) usage; exit 0 ;;
    --yes-delete-state) CONFIRMED=1; shift ;;
    --final-backup-to)   [ "$#" -ge 2 ] || fail "--final-backup-to requires a value"; FINAL_BACKUP_TO=$2; shift 2 ;;
    --final-backup-to=*) FINAL_BACKUP_TO=${1#*=}; shift ;;
    --delete-user) DELETE_USER=1; shift ;;
    --destdir) [ "$#" -ge 2 ] || fail "--destdir requires a value"; DESTDIR=$2; shift 2 ;;
    --destdir=*) DESTDIR=${1#*=}; shift ;;
    *) printf 'purge.sh: unknown option: %s\n' "$1" >&2; exit 1 ;;
  esac
done

[ "$CONFIRMED" -eq 1 ] || fail "refusing to delete state without --yes-delete-state"
[ -n "$FINAL_BACKUP_TO" ] || fail "--final-backup-to <dir> is required (the final backup location)"

STATE_DIR=${SEO_AUDIT_RUNNER_STATE_DIR:-$DESTDIR/var/lib/seo-audit-runner}
ETC_DIR=$DESTDIR/etc/seo-audit-runner
LOG_DIR=$DESTDIR/var/log/seo-audit-runner
LOCK_PATH=$STATE_DIR/seo-audit-runner.lock

# ── Refuse while the runner is active ──────────────────────────────
if [ -f "$LOCK_PATH" ]; then
  lock_pid=$(sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9]\{1,\}\).*/\1/p' "$LOCK_PATH" 2>/dev/null | head -n 1)
  if [ -n "$lock_pid" ] && kill -0 "$lock_pid" 2>/dev/null; then
    fail "runner is active (lock held by pid $lock_pid) — stop it before purging"
  fi
fi

# ── Final backup to the operator-named location ────────────────────
if [ -f "$STATE_DIR/runner-state.sqlite" ]; then
  mkdir -p -- "$FINAL_BACKUP_TO"
  SEO_AUDIT_RUNNER_STATE_DIR="$STATE_DIR" \
  SEO_AUDIT_RUNNER_BACKUP_DIR="$FINAL_BACKUP_TO" \
    bash "$SCRIPT_DIR/backup.sh" --retention 9999 \
    || fail "final backup failed — NOTHING was deleted"
  log "final backup written to $FINAL_BACKUP_TO"
else
  log "no state database found — nothing to back up"
fi

# ── Delete ─────────────────────────────────────────────────────────
for dir in "$STATE_DIR" "$ETC_DIR" "$LOG_DIR"; do
  if [ -d "$dir" ]; then
    rm -rf -- "$dir"
    log "deleted $dir"
  fi
done

if [ "$DELETE_USER" -eq 1 ]; then
  if command -v userdel >/dev/null 2>&1 && getent passwd seo-runner >/dev/null 2>&1; then
    userdel seo-runner
    log "deleted system user seo-runner"
  else
    log "system user seo-runner not deleted (userdel or user not present)"
  fi
else
  log "system user seo-runner kept (use --delete-user to remove)"
fi

log "purge complete"
