#!/usr/bin/env bash
# Official-First maintenance planner (Phase 3B-38) — thin entry point.
# READ-ONLY. Never merges, rebases, cherry-picks, builds, or deploys.
# See official-first-plan.ts for the full logic and official-first-patchset.json
# for the source-of-truth manifest this reads from.
#
# Usage:
#   official-first-plan.sh <old-official-sha> <new-official-sha> [--json]
#   official-first-plan.sh --drift [official-tracking-ref] [official-first-ref] [--json]
#
# dashboard-yct90.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bun "$SCRIPT_DIR/official-first-plan.ts" "$@"
