#!/usr/bin/env bash
# uninstall.sh — NON-DESTRUCTIVE uninstall (contract §8).
#
# Removes: systemd units (stopped and disabled first), the command wrapper,
# and /opt/seo-audit-runner (code + isolated Node runtime).
#
# PRESERVES (always): /var/lib/seo-audit-runner (state AND backups/),
# /etc/seo-audit-runner/runner.env (+ example files), /var/log/seo-audit-runner,
# and the seo-runner user. State deletion exists only in deploy/purge.sh
# behind an explicit flag.
#
# Staged-test overrides: --destdir (systemctl is skipped when unavailable).
set -Eeuo pipefail

DESTDIR=

usage() {
  cat <<'EOF'
Usage: uninstall.sh [--destdir <dir>]

Removes the runner's code, isolated Node runtime, command wrapper, and
systemd units. State, backups, configuration, logs, and the seo-runner
user are ALWAYS preserved (use deploy/purge.sh to delete state).
EOF
}

log()  { printf 'uninstall.sh: %s\n' "$*"; }
fail() { printf 'uninstall.sh: ERROR: %s\n' "$*" >&2; exit 1; }

while [ "$#" -gt 0 ]; do
  case $1 in
    --help|-h) usage; exit 0 ;;
    --destdir) [ "$#" -ge 2 ] || fail "--destdir requires a value"; DESTDIR=$2; shift 2 ;;
    --destdir=*) DESTDIR=${1#*=}; shift ;;
    *) printf 'uninstall.sh: unknown option: %s\n' "$1" >&2; exit 1 ;;
  esac
done

OPT_DIR=$DESTDIR/opt/seo-audit-runner
WRAPPER=$DESTDIR/usr/local/bin/seo-audit-runner
SYSTEMD_DIR=$DESTDIR/etc/systemd/system
UNITS='seo-audit-runner.timer seo-audit-runner.service seo-runner-retry.timer seo-runner-retry.service seo-runner-tick.timer seo-runner-tick.service'

# ── Stop and disable units first (real systemd hosts only) ─────────
if [ -z "$DESTDIR" ] && command -v systemctl >/dev/null 2>&1; then
  for unit in $UNITS; do
    systemctl disable --now "$unit" >/dev/null 2>&1 || true
  done
  log "systemd timers and services stopped and disabled"
fi

# ── Remove unit files, wrapper, code ───────────────────────────────
removed_units=0
for unit in $UNITS; do
  if [ -f "$SYSTEMD_DIR/$unit" ]; then
    rm -f -- "$SYSTEMD_DIR/$unit"
    removed_units=$((removed_units + 1))
  fi
done
[ "$removed_units" -gt 0 ] && log "removed $removed_units systemd unit file(s) from $SYSTEMD_DIR"

if [ -z "$DESTDIR" ] && command -v systemctl >/dev/null 2>&1; then
  systemctl daemon-reload >/dev/null 2>&1 || true
fi

if [ -e "$WRAPPER" ]; then
  rm -f -- "$WRAPPER"
  log "removed command wrapper $WRAPPER"
fi

if [ -d "$OPT_DIR" ]; then
  rm -rf -- "$OPT_DIR"
  log "removed $OPT_DIR (code, releases, isolated Node runtime)"
fi

# ── Report exactly what was kept ───────────────────────────────────
log "uninstall complete. PRESERVED (delete only via deploy/purge.sh):"
log "  state + backups: $DESTDIR/var/lib/seo-audit-runner"
log "  configuration:   $DESTDIR/etc/seo-audit-runner (runner.env kept)"
log "  logs:            $DESTDIR/var/log/seo-audit-runner"
log "  system user:     seo-runner"
