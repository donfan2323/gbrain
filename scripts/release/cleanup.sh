#!/usr/bin/env bash
# gbrain release cleanup — removes old release directories beyond the
# configured retention count. NEVER removes whatever `current` or `previous`
# currently resolve to (re-resolved via realpath at delete time, not a
# cached name, so a symlink retarget mid-run can't slip a live release past
# the guard).
#
# Usage:
#   cleanup.sh [--max-keep N]              dry-run (default) — lists only
#   cleanup.sh [--max-keep N] --apply       actually deletes
#
# dashboard-yct90.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"
SCRIPT_LOG_NAME="cleanup"

MAX_KEEP="${GBRAIN_MAX_RELEASES:-5}"
APPLY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --max-keep)
      MAX_KEEP="$2"
      shift 2
      ;;
    --apply)
      APPLY=1
      shift
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

[ -d "$RELEASES_DIR" ] || { log "no releases directory yet — nothing to clean up"; exit 0; }

# `mapfile` (bash 4+) is unavailable: this machine's `/usr/bin/env bash`
# resolves to macOS's stock bash 3.2.57 (no Homebrew bash installed) — found
# by test-writer's automated tests crashing with "mapfile: command not
# found" the moment any release actually existed. `while read` into an
# array via a loop is bash-3.2-portable.
ALL_RELEASES=()
while IFS= read -r line; do
  ALL_RELEASES+=("$line")
done < <(find "$RELEASES_DIR" -mindepth 1 -maxdepth 1 -type d -not -name '.staging.*' | sort)

TOTAL="${#ALL_RELEASES[@]}"
if [ "$TOTAL" -le "$MAX_KEEP" ]; then
  log "found $TOTAL release(s), max-keep=$MAX_KEEP — nothing to remove"
  exit 0
fi

# Sorted ascending (oldest first) by name — release names are timestamp-
# prefixed so lexical sort == chronological sort. Candidates for removal are
# everything except the newest MAX_KEEP, MINUS anything that resolves to
# current/previous regardless of its position in that list.
KEEP_COUNT=$((TOTAL - MAX_KEEP))
CANDIDATES=("${ALL_RELEASES[@]:0:$KEEP_COUNT}")

TO_DELETE=()
PROTECTED_SKIPPED=()
for dir in "${CANDIDATES[@]}"; do
  realdir="$(cd "$dir" && pwd)"
  if is_protected_release "$realdir"; then
    PROTECTED_SKIPPED+=("$dir")
  else
    TO_DELETE+=("$dir")
  fi
done

if [ "${#PROTECTED_SKIPPED[@]}" -gt 0 ]; then
  log "skipping ${#PROTECTED_SKIPPED[@]} candidate(s) that are current/previous (never deleted regardless of age):"
  for d in "${PROTECTED_SKIPPED[@]}"; do
    log "  KEEP (protected): $d"
  done
fi

if [ "${#TO_DELETE[@]}" -eq 0 ]; then
  log "nothing eligible for deletion after protecting current/previous"
  exit 0
fi

log "candidates for deletion ($( [ "$APPLY" = "1" ] && echo APPLYING || echo DRY-RUN )):"
for d in "${TO_DELETE[@]}"; do
  log "  ${APPLY:+DELETE }${d}"
done

if [ "$APPLY" != "1" ]; then
  log "dry-run only — re-run with --apply to actually delete the ${#TO_DELETE[@]} release(s) listed above"
  exit 0
fi

for d in "${TO_DELETE[@]}"; do
  realdir="$(cd "$d" && pwd)"
  # Re-check immediately before rm — belt and suspenders against a
  # concurrent deploy repointing current/previous mid-cleanup.
  if is_protected_release "$realdir"; then
    log "SKIP (became protected since listing): $d"
    continue
  fi
  chmod -R u+w "$d" 2>/dev/null || true
  rm -rf "$d"
  log "deleted $d"
done

log "cleanup complete: deleted ${#TO_DELETE[@]} release(s), kept $MAX_KEEP + protected"
