#!/usr/bin/env bash
# gbrain atomic deploy: preflight -> stop -> backup -> atomic current swap ->
# start -> smoke test -> (on failure) automatic rollback to previous.
#
# Usage: deploy.sh <release-name-or-path>
#
# Never touches the git working tree. Never opens the production DB except
# via the release binary itself, started under the SAME data dir the
# previous release used (no migration). Rejects a second concurrent deploy.
#
# dashboard-yct90.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"
SCRIPT_LOG_NAME="deploy"

[ $# -ge 1 ] || die "usage: deploy.sh <release-name-or-path>"
RELEASE_DIR="$(resolve_release_path "$1")"

mkdir -p "$RELEASES_DIR" "$SHARED_DIR" "$SHARED_LOGS_DIR" "$SHARED_BACKUPS_DIR"

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
      die "another deploy appears to be in progress (lock: $LOCK_DIR) — refusing double-deploy"
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
log "deploy lock acquired (pid $$) for $RELEASE_DIR"

# --- 1. Preflight. Never touches current/previous or the service.
"$SCRIPT_DIR/preflight.sh" "$RELEASE_DIR" || die "preflight FAILED — aborting; current release untouched"

MANIFEST_VERSION="$(bun -e '
  const fs = require("fs");
  console.log(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).version);
' "$RELEASE_DIR/manifest.json")"

# --- 2. Record rollback target (may be empty on a first-ever deploy).
OLD_CURRENT=""
if [ -L "$CURRENT_LINK" ]; then
  OLD_CURRENT="$(readlink "$CURRENT_LINK")"
fi
log "current release before this deploy: ${OLD_CURRENT:-<none — first deploy>}"

# --- 3. Stop.
log "stopping service"
service_stop
wait_for_port_free 15 || log "WARNING: port $GBRAIN_HTTP_PORT still appears occupied after stop wait — continuing anyway (backup below reads a possibly-still-settling data dir)"

# --- 4. Backup data (post-stop, matches the existing manual cp -a
# .gbrain_backup_<timestamp> precedent — no new backup mechanism invented).
if [ -d "$GBRAIN_DATA_DIR" ]; then
  BACKUP_NAME="$(date -u '+%Y%m%d%H%M%S')-pre-$(basename "$RELEASE_DIR")"
  cp -a "$GBRAIN_DATA_DIR" "$SHARED_BACKUPS_DIR/$BACKUP_NAME"
  log "data backed up to $SHARED_BACKUPS_DIR/$BACKUP_NAME"
fi

# --- 5. previous <- old current (only if there WAS an old current).
if [ -n "$OLD_CURRENT" ]; then
  atomic_symlink "$OLD_CURRENT" "$PREVIOUS_LINK"
  log "previous -> $OLD_CURRENT"
fi

# --- 6. Atomic current swap.
atomic_symlink "$RELEASE_DIR" "$CURRENT_LINK"
log "current -> $RELEASE_DIR"

# --- 7. shared/data + shared/config symlinks (idempotent; same target,
# per architect design — config.json and brain.pglite live together).
[ -L "$SHARED_DIR/data" ] || ln -sfn "$GBRAIN_DATA_DIR" "$SHARED_DIR/data"
[ -L "$SHARED_DIR/config" ] || ln -sfn "$GBRAIN_DATA_DIR" "$SHARED_DIR/config"

update_plist_and_start() {
  local target_release="$1"
  if [ "$GBRAIN_DEPLOY_TEST_MODE" != "1" ] && [ -f "$GBRAIN_LAUNCHD_PLIST" ]; then
    local plist_backup="$SHARED_BACKUPS_DIR/$(basename "$GBRAIN_LAUNCHD_PLIST").$(date -u '+%Y%m%d%H%M%S').bak"
    cp "$GBRAIN_LAUNCHD_PLIST" "$plist_backup"
    log "plist backed up to $plist_backup"
    /usr/libexec/PlistBuddy -c "Set :ProgramArguments:0 $CURRENT_LINK/bin/gbrain" "$GBRAIN_LAUNCHD_PLIST" \
      || die "PlistBuddy failed to update ProgramArguments:0 — plist backup is at $plist_backup, restore it manually"
    if command -v plutil >/dev/null 2>&1; then
      plutil -lint "$GBRAIN_LAUNCHD_PLIST" >/dev/null || die "plist is invalid after edit — restore from $plist_backup immediately"
    fi
  fi
  log "starting service (target release: $target_release)"
  service_start "$target_release/bin/gbrain"
}

# --- 8. Update plist (real mode) + start.
update_plist_and_start "$RELEASE_DIR"

# --- 9. Smoke test. Automatic single-step rollback to previous on failure.
if "$SCRIPT_DIR/smoke-test.sh" "$MANIFEST_VERSION"; then
  log "deploy of $RELEASE_DIR (version=$MANIFEST_VERSION) SUCCEEDED"
  exit 0
fi

log "smoke test FAILED for $RELEASE_DIR — attempting automatic rollback to previous"

if [ -z "$OLD_CURRENT" ]; then
  die "deploy failed smoke test and there is no previous release (first-ever deploy). Service left on the FAILED release. Manual recovery required — see docs/PRODUCTION-DEPLOYMENT.md 'Emergency recovery'." 3
fi

service_stop
wait_for_port_free 15 || true
atomic_symlink "$OLD_CURRENT" "$CURRENT_LINK"
log "current rolled back -> $OLD_CURRENT"
update_plist_and_start "$OLD_CURRENT"

if "$SCRIPT_DIR/smoke-test.sh"; then
  die "deploy of $RELEASE_DIR failed its smoke test; automatic rollback to $OLD_CURRENT SUCCEEDED and is confirmed healthy. Investigate the failed release before retrying." 2
else
  die "deploy of $RELEASE_DIR failed its smoke test, AND the automatic rollback to $OLD_CURRENT ALSO failed its smoke test. Automation stops here — this needs a human. See docs/PRODUCTION-DEPLOYMENT.md 'Emergency recovery'." 3
fi
