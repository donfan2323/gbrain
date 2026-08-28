#!/bin/sh
# git-governance: safe upstream-update helper (report-only for this repo).
#
# Unlike the Hermes implementation this was ported from, gbrain's `master`
# already carries local-only commits (see docs/GIT_GOVERNANCE.md) rather
# than being a clean mirror — so reconciling it with a moved origin/master
# is a real merge/rebase judgment call, not a mechanical fast-forward this
# script can safely automate. This script does the safe, non-destructive
# part only: fetch, and report exactly how local master and origin/master
# relate. It never merges, rebases, resets, or touches master, and it never
# runs anything under scripts/release/ — git state and production
# deployment are deliberately separate; see docs/PRODUCTION-DEPLOYMENT.md
# for the (entirely separate, explicit) deploy pipeline.
#
# Usage: scripts/git_safe_update.sh
set -eu
cd "$(git rev-parse --show-toplevel)"

echo "== fetch origin =="
git fetch origin

local_master=$(git rev-parse master)
origin_master=$(git rev-parse origin/master)

echo ""
echo "== master vs origin/master =="
echo "local master:  $local_master"
echo "origin/master: $origin_master"

if [ "$local_master" = "$origin_master" ]; then
    echo "identical — nothing to reconcile."
    exit 0
fi

if git merge-base --is-ancestor "$local_master" "$origin_master"; then
    echo "local master is a clean ancestor of origin/master — a fast-forward is possible."
    echo "This script does not apply it automatically. To do it yourself, from a branch"
    echo "other than master (never fetch into the currently-checked-out branch):"
    echo "  git switch <some-other-branch>"
    echo "  git fetch . origin/master:master"
    exit 0
fi

if git merge-base --is-ancestor "$origin_master" "$local_master"; then
    echo "origin/master is already an ancestor of local master — local is ahead, nothing to pull."
    echo "Consider whether those local-only commits should be pushed anywhere (fork only, never origin)."
    exit 0
fi

base=$(git merge-base "$local_master" "$origin_master")
ahead=$(git rev-list --count "$base..$local_master")
behind=$(git rev-list --count "$base..$origin_master")
echo "DIVERGED: local master has $ahead commit(s) origin/master lacks,"
echo "          origin/master has $behind commit(s) local master lacks."
echo "Common ancestor: $base"
echo ""
echo "This needs a human/agent judgment call (merge vs rebase vs cherry-pick specific"
echo "commits), not automation. If you're unsure whether the local-only commits are"
echo "backed up, protect them first:"
echo "  git branch rescue/<description>-\$(date -u +%Y%m%d) master"
echo "  git push fork rescue/<description>-\$(date -u +%Y%m%d)"
echo ""
echo "Deployment is never implied by resolving this — see docs/PRODUCTION-DEPLOYMENT.md"
echo "for the separate, explicit scripts/release/* pipeline."
