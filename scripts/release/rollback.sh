#!/usr/bin/env bash
# gbrain manual rollback: atomic swap current <-> previous, restart, smoke
# test. This is the standalone operator command (`scripts/release/rollback.sh`
# with no args) — distinct from deploy.sh's own inline auto-rollback-on-
# failed-smoke-test, which this script also happens to share logic with.
#
# Never touches git, never migrates/restores the DB (data is symlinked in
# place — rollback only ever changes which BINARY is running against it).
#
# dashboard-yct90.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"
SCRIPT_LOG_NAME="rollback"

LOCK_DIR="$GBRAIN_PROD_ROOT/.deploy-lock"

acquire_deploy_lock() {
  local tries=0
  while ! mkdir "$LOCK_DIR" 2>/dev/null; do
    if [ -f "$LOCK_DIR/pid" ]; then
      local holder_pid
      holder_pid="$(cat "$LOCK_DIR/pid" 2>/dev/null || echo "")"
      if [ -n "$holder_pid" ] && ! kill -0 "$holder_pid" 2>/dev/null; then
        log "stale deploy lock held by dead pid $holder_pid — removing"
        rm -rf "$LOCK_DIR"
        continue
      fi
    fi
    tries=$((tries + 1))
    if [ "$tries" -ge "${GBRAIN_DEPLOY_LOCK_MAX_TRIES:-30}" ]; then
      die "a deploy/rollback appears to already be in progress (lock: $LOCK_DIR) — refusing to run concurrently"
    fi
    sleep "${GBRAIN_DEPLOY_LOCK_SLEEP:-1}"
  done
  mkdir -p "$LOCK_DIR"
  echo $$ > "$LOCK_DIR/pid"
}

LOCK_HELD=0
release_deploy_lock() {
  [ "$LOCK_HELD" = "1" ] && rm -rf "$LOCK_DIR"
}
trap release_deploy_lock EXIT

acquire_deploy_lock
LOCK_HELD=1

[ -L "$CURRENT_LINK" ] || die "no 'current' release exists — nothing to roll back from"
[ -L "$PREVIOUS_LINK" ] || die "no 'previous' release exists — nothing to roll back to. (Only one deploy has ever happened, or previous was never set.)"

CUR="$(readlink "$CURRENT_LINK")"
PREV="$(readlink "$PREVIOUS_LINK")"
[ -d "$PREV" ] || die "'previous' points at a release that no longer exists on disk: $PREV"

log "rolling back: current ($CUR) <-> previous ($PREV)"

PREV_MANIFEST_VERSION="$(bun -e '
  const fs = require("fs");
  console.log(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).version);
' "$PREV/manifest.json" 2>/dev/null || echo "")"

log "stopping service"
service_stop
wait_for_port_free 15 || log "WARNING: port $GBRAIN_HTTP_PORT still appears occupied after stop wait"

# Swap: previous <- old current, current <- old previous. This preserves the
# "there are always two named slots, and they always point at each other's
# prior value" invariant, so a second rollback.sh call re-forwards cleanly.
atomic_symlink "$CUR" "$PREVIOUS_LINK"
atomic_symlink "$PREV" "$CURRENT_LINK"
log "current -> $PREV, previous -> $CUR"

if [ "$GBRAIN_DEPLOY_TEST_MODE" != "1" ] && [ -f "$GBRAIN_LAUNCHD_PLIST" ]; then
  plist_backup="$SHARED_BACKUPS_DIR/$(basename "$GBRAIN_LAUNCHD_PLIST").$(date -u '+%Y%m%d%H%M%S').bak"
  mkdir -p "$SHARED_BACKUPS_DIR"
  cp "$GBRAIN_LAUNCHD_PLIST" "$plist_backup"
  /usr/libexec/PlistBuddy -c "Set :ProgramArguments:0 $CURRENT_LINK/bin/gbrain" "$GBRAIN_LAUNCHD_PLIST" \
    || die "PlistBuddy failed to update ProgramArguments:0 — plist backup is at $plist_backup, restore it manually"
fi

log "starting service"
service_start "$PREV/bin/gbrain"

if "$SCRIPT_DIR/smoke-test.sh" "$PREV_MANIFEST_VERSION"; then
  log "rollback SUCCEEDED — service healthy on $PREV"
  exit 0
fi

cat <<'EOF' >&2

===============================================================
ROLLBACK'S OWN SMOKE TEST FAILED. Automation stops here.

Manual recovery steps:
  1. Check the service log:  tail -100 /Users/lab/Library/Logs/gbrain.log
  2. Check for a stuck PGLite lock (pglite-lock.ts's own error message
     names the holding PID — only remove the lock dir if that PID is
     confirmed dead: `ps -p <PID>`).
       ls -la "$GBRAIN_DATA_DIR/.gbrain-lock"
  3. If the PGLite lock is the problem and the holder is confirmed dead:
       rm -rf "$GBRAIN_DATA_DIR/.gbrain-lock"
  4. Manually verify which release 'current' points to:
       readlink "$CURRENT_LINK"
  5. Restart the service by hand and re-run:
       scripts/release/smoke-test.sh
  6. As a last resort, point launchd's plist back at the ORIGINAL
     pre-migration ProgramArguments (/Users/lab/.bun/bin/gbrain) — the
     pre-migration plist backup is in shared/backups/.

Do NOT attempt a second automatic rollback — the system only tracks two
named slots (current/previous); repeatedly swapping them is more likely
to make the state confusing than to fix a real regression.
===============================================================
EOF
exit 3
