#!/bin/sh
# git-governance: checkpoint helper (report-only, never commits by itself).
#
# Run this before you commit, or any time you want a clear picture of what
# an agent session has changed. It classifies the working tree so a commit
# can be scoped to one logical feature/fix rather than swept in wholesale.
# See docs/GIT_GOVERNANCE.md for the commit-timing policy this supports.
#
# Usage: scripts/git_safe_checkpoint.sh
set -eu
cd "$(git rev-parse --show-toplevel)"

branch=$(git branch --show-current)
head=$(git rev-parse HEAD)

echo "== branch/HEAD =="
echo "branch: ${branch:-<detached>}"
echo "HEAD:   $head"

echo ""
echo "== working tree =="
staged=$(git diff --name-only --cached)
unstaged=$(git diff --name-only)
untracked=$(git ls-files --others --exclude-standard)

n_staged=$(printf '%s' "$staged" | grep -c . || true)
n_unstaged=$(printf '%s' "$unstaged" | grep -c . || true)
n_untracked=$(printf '%s' "$untracked" | grep -c . || true)

echo "staged:    $n_staged file(s)"
[ "$n_staged" -gt 0 ] && printf '%s\n' "$staged" | sed 's/^/  staged:    /'
echo "unstaged:  $n_unstaged file(s)"
[ "$n_unstaged" -gt 0 ] && printf '%s\n' "$unstaged" | sed 's/^/  modified:  /'
echo "untracked: $n_untracked file(s)"
[ "$n_untracked" -gt 0 ] && printf '%s\n' "$untracked" | sed 's/^/  untracked: /'

all_changed=$(printf '%s\n%s\n%s\n' "$staged" "$unstaged" "$untracked" | grep -v '^$' | sort -u || true)

echo ""
echo "== secret / generated-data screen =="
suspicious=$(printf '%s\n' "$all_changed" | grep -iE '\.(env|pem|key)$|secret|credential|token' || true)
if [ -n "$suspicious" ]; then
    echo "⚠ files matching secret-like patterns are in the change set:"
    printf '%s\n' "$suspicious" | sed 's/^/  /'
    echo "  Confirm none of these actually contain secret VALUES before committing."
else
    echo "no filename matched secret-like patterns (.env/.pem/.key/secret/credential/token)."
fi

echo ""
echo "== dirty-tree age (oldest modified tracked file, if any) =="
oldest=""
for f in $staged $unstaged; do
    [ -f "$f" ] || continue
    mt=$(stat -f '%m' "$f" 2>/dev/null || stat -c '%Y' "$f" 2>/dev/null || echo 0)
    if [ -z "$oldest" ] || [ "$mt" -lt "$oldest" ]; then
        oldest="$mt"
        oldest_file="$f"
    fi
done
if [ -n "$oldest" ]; then
    now=$(date +%s)
    age_min=$(( (now - oldest) / 60 ))
    echo "oldest touched file: $oldest_file (~${age_min} min ago)"
    if [ "$age_min" -gt 120 ]; then
        echo "⚠ dirty tree looks >2h old — per policy, either commit a logical checkpoint now or explain why it's still open."
    fi
else
    echo "(no modified tracked files)"
fi

echo ""
echo "== suggested next step =="
if [ "$n_staged" -eq 0 ] && [ "$n_unstaged" -eq 0 ] && [ "$n_untracked" -eq 0 ]; then
    echo "working tree is clean — nothing to checkpoint."
else
    cat <<'EOF'
Before committing:
  1. Group the files above into ONE logical feature/fix — don't mix unrelated changes.
  2. Run the relevant tests for that scope.
  3. `git add` only that scope's files (not `-A`) and commit with a message
     describing the change's intent.
  4. Push only to `fork` (never `origin`) — see docs/GIT_GOVERNANCE.md.
EOF
fi
