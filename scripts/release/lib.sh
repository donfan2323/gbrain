#!/usr/bin/env bash
# gbrain release tooling — shared helpers.
#
# Sourced by build-release.sh / preflight.sh / deploy.sh / rollback.sh /
# smoke-test.sh / cleanup.sh / status.sh. Never executed directly.
#
# All paths are configurable via environment variables so the same scripts
# run against the real production root AND against a throwaway temp root in
# automated tests (test/release/*.test.ts) — no script here ever hardcodes
# /Users/lab/AI_Production or /Users/lab/.gbrain.
#
# dashboard-yct90.

set -euo pipefail

# Repo root: two levels up from this file (scripts/release/lib.sh -> repo root).
GBRAIN_REPO_ROOT="${GBRAIN_REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"

# Versioned-release root. NEVER the git working tree.
GBRAIN_PROD_ROOT="${GBRAIN_PROD_ROOT:-/Users/lab/AI_Production/gbrain}"

# Real, existing gbrain data/config directory. shared/data and shared/config
# both symlink to this SAME directory (config.json and brain.pglite live
# together) — no data migration, ever.
GBRAIN_DATA_DIR="${GBRAIN_DATA_DIR:-$HOME/.gbrain}"

GBRAIN_HTTP_PORT="${GBRAIN_HTTP_PORT:-8765}"

# Bound for service_stop_and_wait's confirmed-exit poll (Phase 3B-36).
# Overridable for tests that need to exercise the timeout path without a
# real 30s wait — matches the existing GBRAIN_SMOKE_MAX_WAIT/
# GBRAIN_DEPLOY_LOCK_MAX_TRIES pattern.
GBRAIN_SERVICE_STOP_MAX_WAIT="${GBRAIN_SERVICE_STOP_MAX_WAIT:-30}"
GBRAIN_PUBLIC_URL="${GBRAIN_PUBLIC_URL:-https://fumitakamac-mini.tailcb4b20.ts.net}"
GBRAIN_LAUNCHD_LABEL="${GBRAIN_LAUNCHD_LABEL:-com.user.gbrain}"
GBRAIN_LAUNCHD_PLIST="${GBRAIN_LAUNCHD_PLIST:-$HOME/Library/LaunchAgents/${GBRAIN_LAUNCHD_LABEL}.plist}"

# Test-mode escape hatch: when set to 1, deploy.sh/rollback.sh manage the
# service as a plain background process (start/kill) instead of launchctl,
# so the atomic-swap/preflight/rollback logic is fully testable without
# registering a real macOS launchd service. Default (real deploys): 0.
GBRAIN_DEPLOY_TEST_MODE="${GBRAIN_DEPLOY_TEST_MODE:-0}"

RELEASES_DIR="$GBRAIN_PROD_ROOT/releases"
CURRENT_LINK="$GBRAIN_PROD_ROOT/current"
PREVIOUS_LINK="$GBRAIN_PROD_ROOT/previous"
SHARED_DIR="$GBRAIN_PROD_ROOT/shared"
SHARED_LOGS_DIR="$SHARED_DIR/logs"
SHARED_BACKUPS_DIR="$SHARED_DIR/backups"

# ---------------------------------------------------------------------------
# Logging. Writes to shared/logs/<script-name>.log AND stdout. Every line is
# passed through redact() first — defense in depth, matching gbrain's own
# log-hygiene posture (its own logs never print bootstrap tokens).
# ---------------------------------------------------------------------------

redact() {
  # Masks anything that looks like a secret: OpenAI/Anthropic-style keys,
  # gbrain OAuth client/code tokens, AWS-style keys, GitHub tokens, bearer
  # tokens, and generic key=value secret-ish assignments.
  sed -E \
    -e 's/(sk-[A-Za-z0-9_-]{10,})/***REDACTED***/g' \
    -e 's/(gbrain_cl_[a-f0-9]{16,})/***REDACTED***/g' \
    -e 's/(gbrain_code_[a-f0-9]{16,})/***REDACTED***/g' \
    -e 's/(AKIA[A-Z0-9]{16})/***REDACTED***/g' \
    -e 's/(ghp_[A-Za-z0-9]{20,})/***REDACTED***/g' \
    -e 's/([Bb]earer[[:space:]]+)[A-Za-z0-9._-]+/\1***REDACTED***/g' \
    -e 's/((secret|token|password|api_key)[\"'"'"']?[[:space:]]*[:=][[:space:]]*[\"'"'"']?)[A-Za-z0-9._-]{6,}/\1***REDACTED***/g'
}

log() {
  local msg="$1"
  local ts
  ts="$(date '+%Y-%m-%dT%H:%M:%S%z')"
  local line="[$ts] $msg"
  echo "$line" | redact
  if [ -d "$SHARED_LOGS_DIR" ]; then
    echo "$line" | redact >> "$SHARED_LOGS_DIR/${SCRIPT_LOG_NAME:-release}.log"
  fi
}

die() {
  log "ERROR: $1"
  exit "${2:-1}"
}

# ---------------------------------------------------------------------------
# Checksums
# ---------------------------------------------------------------------------

sha256_of() {
  shasum -a 256 "$1" | awk '{print $1}'
}

# ---------------------------------------------------------------------------
# Atomic symlink swap.
#
# BUG FIX (found by test-writer's automated tests, confirmed by direct
# reproduction): `mv tmp_link link_path` is NOT a correct symlink replace
# when `link_path` already exists AND is a symlink pointing at a directory
# (exactly the `current`/`previous` case after the first deploy). `mv`'s own
# CLI-level heuristic runs `stat()` (which follows symlinks) on the
# destination to decide "is this a directory to move into," and a symlink
# resolving to a directory reads as "yes" — so `mv` silently moves the
# temp symlink INSIDE the target directory instead of replacing `link_path`,
# leaving `link_path` completely unchanged. On a read-only (chmod 555)
# release directory this fails loudly (`Permission denied`); on a writable
# one it fails SILENTLY (exit 0, `current` never actually updated). This
# broke every second-and-later deploy, every automatic rollback-on-failed-
# smoke-test, and rollback.sh's entire current<->previous swap.
#
# Fix: call `fs.renameSync()` via bun directly, bypassing `mv`'s directory-
# detection layer entirely. POSIX `rename()` operates on the destination
# directory ENTRY itself (never dereferences a symlink destination) and is
# a single atomic syscall — verified empirically on this system to
# correctly and repeatably replace a symlink-to-directory without entering
# it, unlike `mv`.
# ---------------------------------------------------------------------------

atomic_symlink() {
  local target="$1"
  local link_path="$2"
  local tmp_link
  tmp_link="$(dirname "$link_path")/.$(basename "$link_path").tmp.$$"
  ln -sfn "$target" "$tmp_link"
  bun -e 'require("fs").renameSync(process.argv[1], process.argv[2])' "$tmp_link" "$link_path" \
    || die "atomic_symlink: fs.renameSync failed replacing $link_path -> $target"
}

# ---------------------------------------------------------------------------
# Secret scan. Used by build-release.sh (manifest/checksums must be clean)
# and preflight.sh (defense in depth before a release goes live).
# Returns 0 (clean) or 1 (found something secret-shaped) via exit code;
# prints nothing about the actual secret value, only the fact + file.
# ---------------------------------------------------------------------------

scan_for_secrets() {
  local target="$1"
  local found=0
  local pattern='sk-[A-Za-z0-9_-]{10,}|gbrain_cl_[a-f0-9]{16,}|gbrain_cs_[a-f0-9]{16,}|gbrain_code_[a-f0-9]{16,}|AKIA[A-Z0-9]{16}|ghp_[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----'
  if [ -f "$target" ]; then
    if grep -EIq "$pattern" "$target" 2>/dev/null; then
      log "SECRET SCAN: pattern match in $target (value redacted)"
      found=1
    fi
  elif [ -d "$target" ]; then
    while IFS= read -r -d '' f; do
      if grep -EIq "$pattern" "$f" 2>/dev/null; then
        log "SECRET SCAN: pattern match in $f (value redacted)"
        found=1
      fi
    done < <(find "$target" -type f -print0)
  fi
  return "$found"
}

# ---------------------------------------------------------------------------
# Release resolution helpers
# ---------------------------------------------------------------------------

resolve_release_path() {
  # Accepts either a bare release name (releases/<name>) or an absolute path.
  local ref="$1"
  if [[ "$ref" == /* ]]; then
    echo "$ref"
  else
    echo "$RELEASES_DIR/$ref"
  fi
}

current_release_path() {
  [ -L "$CURRENT_LINK" ] || return 1
  readlink "$CURRENT_LINK"
}

previous_release_path() {
  [ -L "$PREVIOUS_LINK" ] || return 1
  readlink "$PREVIOUS_LINK"
}

# A path counts as "protected from cleanup" if it resolves (realpath) to the
# same release as current or previous. Always re-resolves at call time —
# never trusts a cached name — so a symlink retarget between listing and
# deleting can't slip a live release past the guard.
is_protected_release() {
  local candidate_realpath="$1"
  local cur prev
  cur="$(cd "$RELEASES_DIR" 2>/dev/null && [ -L "$CURRENT_LINK" ] && cd "$(readlink "$CURRENT_LINK")" 2>/dev/null && pwd || true)"
  prev="$(cd "$RELEASES_DIR" 2>/dev/null && [ -L "$PREVIOUS_LINK" ] && cd "$(readlink "$PREVIOUS_LINK")" 2>/dev/null && pwd || true)"
  [ -n "$cur" ] && [ "$candidate_realpath" = "$cur" ] && return 0
  [ -n "$prev" ] && [ "$candidate_realpath" = "$prev" ] && return 0
  return 1
}

# ---------------------------------------------------------------------------
# Deploy/rollback mutual-exclusion lock. mkdir-based (atomic on POSIX),
# PID-tracked, stale-holder reaping. Shared by deploy.sh and rollback.sh —
# previously duplicated verbatim in both (found by architect review during
# this Unit's final design pass); a future edit to one without the other
# would have silently desynced locking behavior.
# ---------------------------------------------------------------------------

DEPLOY_LOCK_DIR="$GBRAIN_PROD_ROOT/.deploy-lock"
DEPLOY_LOCK_HELD=0

acquire_deploy_lock() {
  local tries=0
  while ! mkdir "$DEPLOY_LOCK_DIR" 2>/dev/null; do
    if [ -f "$DEPLOY_LOCK_DIR/pid" ]; then
      local holder_pid
      holder_pid="$(cat "$DEPLOY_LOCK_DIR/pid" 2>/dev/null || echo "")"
      if [ -n "$holder_pid" ] && ! kill -0 "$holder_pid" 2>/dev/null; then
        log "stale deploy lock held by dead pid $holder_pid — removing"
        rm -rf "$DEPLOY_LOCK_DIR"
        continue
      fi
    fi
    tries=$((tries + 1))
    if [ "$tries" -ge "${GBRAIN_DEPLOY_LOCK_MAX_TRIES:-30}" ]; then
      die "another deploy/rollback appears to be in progress (lock: $DEPLOY_LOCK_DIR) — refusing to run concurrently"
    fi
    sleep "${GBRAIN_DEPLOY_LOCK_SLEEP:-1}"
  done
  mkdir -p "$DEPLOY_LOCK_DIR"
  echo $$ > "$DEPLOY_LOCK_DIR/pid"
  DEPLOY_LOCK_HELD=1
}

release_deploy_lock() {
  [ "$DEPLOY_LOCK_HELD" = "1" ] && rm -rf "$DEPLOY_LOCK_DIR"
}

# ---------------------------------------------------------------------------
# Service control. Real mode uses launchctl (macOS). Test mode manages the
# release binary as a plain background process so the deploy/rollback/
# smoke-test logic is fully exercisable without registering a real launchd
# service. The PID file lives under shared/ so it's outside any release dir.
# ---------------------------------------------------------------------------

TEST_PID_FILE="$SHARED_DIR/.test-service.pid"

# Discovers the actual OS PID of the currently-running service, if any.
# Prints it on stdout and returns 0; prints nothing and returns 1 if no
# service appears to be running (safe to treat as "already stopped" by
# callers). Must be called BEFORE service_stop — the whole point is to
# capture what to wait for prior to issuing the stop request.
discover_service_pid() {
  if [ "$GBRAIN_DEPLOY_TEST_MODE" = "1" ]; then
    [ -f "$TEST_PID_FILE" ] || return 1
    local pid
    pid="$(cat "$TEST_PID_FILE")"
    kill -0 "$pid" 2>/dev/null || return 1
    echo "$pid"
    return 0
  fi
  # `launchctl list` prints "PID\tStatus\tLabel" per job, one per line; a
  # loaded-but-not-running job shows "-" for PID. awk field 3 is the label
  # (fields are tab-separated but awk's default FS splits on any
  # whitespace run, which still works here since the label has none).
  local pid
  pid="$(launchctl list 2>/dev/null | awk -v label="$GBRAIN_LAUNCHD_LABEL" '$3 == label { print $1; exit }')"
  [ -n "$pid" ] && [ "$pid" != "-" ] || return 1
  echo "$pid"
  return 0
}

# Portable, GNU-independent bounded wait for a PID to actually disappear
# from the process table. #4XXX (Phase 3B-36): `launchctl bootout`
# returning — or a plain `kill` in test mode — does NOT guarantee the
# underlying process has finished its own shutdown. PGLite's disconnect()
# drains in-flight work, releases its advisory .gbrain-lock, and disposes
# before actually exiting (src/core/pglite-engine.ts) — that takes a real,
# if normally brief, amount of wall-clock time. wait_for_port_free alone
# proved insufficient in production (Phase 3B-35): the service can unbind
# its listening port before it finishes deleting its own transient lock
# files, and the original code only WARNED on a port-wait timeout instead
# of gating the backup step on it. This helper is the authoritative
# fail-closed gate — poll for the PID's actual disappearance, no GNU
# `timeout`/`gtimeout` dependency, pure portable shell.
wait_for_pid_exit() {
  local pid="$1"
  local max_wait_s="${2:-30}"
  local interval_s=0.25
  local elapsed_s=0
  while :; do
    kill -0 "$pid" 2>/dev/null || return 0
    # awk for float comparison — bash arithmetic is integer-only and
    # max_wait_s/interval_s are not guaranteed to be whole numbers.
    awk -v e="$elapsed_s" -v m="$max_wait_s" 'BEGIN { exit !(e < m) }' || break
    sleep "$interval_s"
    elapsed_s="$(awk -v e="$elapsed_s" -v i="$interval_s" 'BEGIN { print e + i }')"
  done
  kill -0 "$pid" 2>/dev/null || return 0
  return 1
}

# Stop the service AND wait for confirmed process exit before returning.
# Fail-closed: a non-zero return means the OLD process may still be alive
# — callers MUST NOT proceed to backup/current-swap/migration on failure.
service_stop_and_wait() {
  local max_wait_s="${1:-30}"
  local pid
  if ! pid="$(discover_service_pid)"; then
    log "no running service PID found — treating as already stopped"
    return 0
  fi
  log "stopping service (pid $pid)"
  service_stop
  if wait_for_pid_exit "$pid" "$max_wait_s"; then
    log "confirmed process exit (pid $pid)"
    return 0
  fi
  log "ERROR: pid $pid still alive after ${max_wait_s}s wait — refusing to proceed to backup/swap"
  return 1
}

service_stop() {
  if [ "$GBRAIN_DEPLOY_TEST_MODE" = "1" ]; then
    if [ -f "$TEST_PID_FILE" ]; then
      local pid
      pid="$(cat "$TEST_PID_FILE")"
      kill "$pid" 2>/dev/null || true
      rm -f "$TEST_PID_FILE"
    fi
    return 0
  fi
  launchctl bootout "gui/$(id -u)/${GBRAIN_LAUNCHD_LABEL}" 2>/dev/null || true
}

service_start() {
  if [ "$GBRAIN_DEPLOY_TEST_MODE" = "1" ]; then
    local bin="$1"
    mkdir -p "$SHARED_DIR"
    # NOTE: gbrain's GBRAIN_HOME is documented (src/core/config.ts
    # configDir()) as "a parent dir; we always append '.gbrain' ourselves",
    # matching how the real production plist relies on no GBRAIN_HOME at
    # all and gets homedir()+'/.gbrain'. So GBRAIN_DATA_DIR here MUST be a
    # directory literally named .gbrain, and we pass its PARENT as
    # GBRAIN_HOME — never GBRAIN_DATA_DIR itself (verified empirically:
    # setting GBRAIN_HOME to the .gbrain dir directly makes gbrain look for
    # a nonexistent nested .gbrain/.gbrain and report "No brain configured").
    [ "$(basename "$GBRAIN_DATA_DIR")" = ".gbrain" ] \
      || die "GBRAIN_DATA_DIR must be a directory named '.gbrain' (got: $GBRAIN_DATA_DIR) — gbrain appends '.gbrain' to GBRAIN_HOME itself"
    GBRAIN_HOME="$(dirname "$GBRAIN_DATA_DIR")" nohup "$bin" serve --http --port "$GBRAIN_HTTP_PORT" --public-url "$GBRAIN_PUBLIC_URL" \
      >> "$SHARED_LOGS_DIR/test-service.log" 2>&1 &
    echo $! > "$TEST_PID_FILE"
    return 0
  fi
  launchctl bootstrap "gui/$(id -u)" "$GBRAIN_LAUNCHD_PLIST"
}

# Bounded wait until nothing is listening on GBRAIN_HTTP_PORT. Historically
# used as the sole pre-backup gate in deploy.sh/rollback.sh; superseded
# there by service_stop_and_wait's PID-based wait (Phase 3B-36) — a
# service can unbind its port well before it finishes its own internal
# shutdown cleanup, so port-freedom alone proved insufficient to gate a
# data backup on. Kept as a general-purpose helper (e.g. for a future
# script that only cares about the listener, not process cleanup).
wait_for_port_free() {
  local max_wait="${1:-15}"
  local waited=0
  while [ "$waited" -lt "$max_wait" ]; do
    if ! lsof -iTCP:"$GBRAIN_HTTP_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done
  return 1
}
