#!/usr/bin/env bash
# gbrain release build — RUNTIME BUNDLE approach.
#
# ADR-0001 (docs/adr/0001-single-binary-rejected.md): `bun build --compile`
# was rejected after empirical testing showed the compiled binary's embedded
# PGLite WASM payload fails to extract on this Bun version, for BOTH a fresh
# `gbrain init` and opening an already-initialized database — i.e., it does
# not work for the actual production use case, not just an edge case. This
# script instead packages the currently-proven-working execution mode
# ("bun running the TypeScript source directly") as an immutable, versioned,
# working-tree-independent bundle:
#
#   releases/<id>/
#     app/            — git-archive snapshot of HEAD: src/, package.json,
#                        bun.lock, node_modules/ (installed fresh, frozen,
#                        scripts disabled — see below)
#     runtime/bun     — a COPY of the currently-validated bun executable,
#                       pinned so a future global `bun upgrade` cannot change
#                       this release's behavior
#     bin/gbrain      — thin launcher: exec's runtime/bun against
#                        app/src/cli.ts. This is the ONLY thing launchd ever
#                        invokes (see docs/PRODUCTION-DEPLOYMENT.md) — the
#                        external contract stays identical even if a future
#                        release goes back to a compiled binary internally.
#     manifest.json / checksums.txt
#
# Never modifies the working tree (git archive reads committed content only;
# no stash/checkout/reset/commit anywhere in this script). Never opens the
# production PGLite DB. Refuses to build from a dirty tree by default.
#
# Usage: build-release.sh [--allow-dirty]
#
# dashboard-yct90.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"
SCRIPT_LOG_NAME="build-release"

ALLOW_DIRTY=0
[ "${1:-}" = "--allow-dirty" ] && ALLOW_DIRTY=1

mkdir -p "$RELEASES_DIR" "$SHARED_LOGS_DIR"

cd "$GBRAIN_REPO_ROOT"

GIT_SHA="$(git rev-parse HEAD)"
GIT_SHA_SHORT="$(git rev-parse --short HEAD)"
BUILT_AT="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

SOURCE_DIRTY="false"
if ! git diff --quiet HEAD -- 2>/dev/null; then
  SOURCE_DIRTY="true"
fi

if [ "$SOURCE_DIRTY" = "true" ] && [ "$ALLOW_DIRTY" != "1" ]; then
  die "working tree has uncommitted changes vs HEAD — refusing to build a release from a dirty tree. Commit first, or pass --allow-dirty if you understand a git-archive snapshot NEVER includes uncommitted changes anyway (only committed content is captured either way — this gate exists so nobody is surprised that uncommitted work silently did not make it into the release)."
fi

RELEASE_NAME="$(date -u '+%Y%m%d%H%M%S')-${GIT_SHA_SHORT}"
FINAL_DIR="$RELEASES_DIR/$RELEASE_NAME"
STAGING_DIR="$RELEASES_DIR/.staging.$RELEASE_NAME.$$"

if [ -e "$FINAL_DIR" ]; then
  die "release $RELEASE_NAME already exists at $FINAL_DIR — refusing to overwrite"
fi

cleanup_staging() {
  [ -d "$STAGING_DIR" ] && chmod -R u+w "$STAGING_DIR" 2>/dev/null && rm -rf "$STAGING_DIR"
}
trap cleanup_staging EXIT

mkdir -p "$STAGING_DIR/app" "$STAGING_DIR/runtime" "$STAGING_DIR/bin"

log "building release $RELEASE_NAME from HEAD=$GIT_SHA_SHORT (dirty=$SOURCE_DIRTY, allow_dirty=$ALLOW_DIRTY)"

# --- 1. Clean, working-tree-independent source snapshot. `git archive` only
# ever emits committed content — it is physically incapable of picking up
# uncommitted changes, concurrent edits, or anything from `git stash`, which
# is exactly the property this whole pipeline exists to guarantee.
git archive --format=tar HEAD | (cd "$STAGING_DIR/app" && tar -x) \
  || die "git archive snapshot failed"
[ -f "$STAGING_DIR/app/package.json" ] || die "git archive snapshot missing package.json — HEAD may not be the expected repo root"
[ -f "$STAGING_DIR/app/bun.lock" ] || die "git archive snapshot missing bun.lock — dependency install would not be reproducible"
log "source snapshot OK ($(find "$STAGING_DIR/app" -type f | wc -l | tr -d ' ') files from git archive)"

# --- 2. Reproducible dependency install. Clean staging dir (never the dev
# repo's own node_modules — that could carry local-only state, or deps that
# drifted from what bun.lock actually pins). `--production` skips
# devDependencies (test runners, type stubs — not needed to run `serve`).
# `--frozen-lockfile` refuses to proceed if package.json and bun.lock
# disagree (catches an out-of-date lockfile instead of silently resolving
# something different from what was tested). `--ignore-scripts` is REQUIRED,
# not optional: gbrain's own package.json runs
# `postinstall: bun run scripts/postinstall.ts`, which shells out to
# `which('gbrain')` and runs `apply-migrations --yes --non-interactive`
# against whatever `gbrain` resolves to on PATH — on this machine that is
# the LIVE PRODUCTION symlink chain. Without --ignore-scripts, building a
# release could silently run a migration command against the real
# production database. Verified this is the actual root cause by reading
# scripts/postinstall.ts before writing this comment.
(
  cd "$STAGING_DIR/app"
  bun install --production --frozen-lockfile --ignore-scripts \
    || { echo "INSTALL_FAILED" > "$STAGING_DIR/.install-status"; exit 1; }
) || die "bun install --frozen-lockfile failed in staging — release NOT published (no partial/broken node_modules ever reaches releases/)"
[ -d "$STAGING_DIR/app/node_modules" ] || die "bun install reported success but node_modules is missing"
DEP_COUNT="$(find "$STAGING_DIR/app/node_modules" -maxdepth 1 -mindepth 1 -type d | wc -l | tr -d ' ')"
log "dependency install OK (--production --frozen-lockfile --ignore-scripts; $DEP_COUNT top-level packages)"

# Aggregate digest over the whole node_modules tree (cheap, single value;
# per-file checksums for potentially thousands of vendored files would bloat
# checksums.txt for no real integrity benefit beyond what frozen-lockfile +
# registry integrity already provides — see manifest.json's
# node_modules_digest field, and docs/PRODUCTION-DEPLOYMENT.md). Uses
# `xargs -0` to batch many files per `shasum` invocation — `find -exec cmd
# {} \;` spawns ONE PROCESS PER FILE, which measured well over two minutes
# (timed out) across node_modules' full file count; xargs batching brings
# this down to a few seconds.
#
# MUST use paths RELATIVE to the staging dir (`cd` first), not absolute —
# `shasum`'s output line includes the path it was given, so the aggregate
# hash is sensitive to that string. The staging dir is named
# `.staging.<release>.<pid>` and gets renamed to the final `<release>` name
# afterward; hashing absolute paths would bake in the staging name and
# never match a later re-verification against the renamed, final directory
# (caught empirically: preflight recomputation disagreed with the
# manifest-recorded value until this was fixed).
NODE_MODULES_DIGEST="$(cd "$STAGING_DIR" && find app/node_modules -type f -print0 2>/dev/null | sort -z | xargs -0 shasum -a 256 | shasum -a 256 | awk '{print $1}')"

# --- 3. Pin the Bun runtime. Copying the actual executable (not just
# recording its version string) is what makes this release immune to a
# future global `bun upgrade` — the exact bug that killed the single-binary
# approach was Bun-version-specific, so "the same bun.lock" is not enough;
# we need "the same bun".
BUN_SOURCE_PATH="$(command -v bun)"
[ -n "$BUN_SOURCE_PATH" ] || die "bun not found on PATH — cannot pin a runtime"
BUN_SOURCE_REALPATH="$(cd "$(dirname "$BUN_SOURCE_PATH")" && pwd)/$(basename "$BUN_SOURCE_PATH")"
cp "$BUN_SOURCE_REALPATH" "$STAGING_DIR/runtime/bun"
chmod 555 "$STAGING_DIR/runtime/bun"
BUN_VERSION="$("$STAGING_DIR/runtime/bun" --version)"
BUN_CHECKSUM="$(sha256_of "$STAGING_DIR/runtime/bun")"
log "runtime bun pinned: $BUN_SOURCE_REALPATH (version=$BUN_VERSION, checksum=$BUN_CHECKSUM)"

# --- 4. Thin launcher. This is the ENTIRE external contract launchd ever
# depends on (docs/PRODUCTION-DEPLOYMENT.md "Launch contract"). Resolves its
# OWN real directory via `cd -P` (physically, following symlinks) so it
# works correctly whether invoked directly or via the `current` symlink —
# it must never accidentally resolve paths through `current` if a future
# rollback repoints that symlink while this process is starting.
cat > "$STAGING_DIR/bin/gbrain" <<'LAUNCHER'
#!/usr/bin/env bash
set -euo pipefail
RELEASE_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec "$RELEASE_DIR/runtime/bun" "$RELEASE_DIR/app/src/cli.ts" "$@"
LAUNCHER
chmod 555 "$STAGING_DIR/bin/gbrain"

# --- 5. Sanity check: the bundle actually runs, under an ISOLATED GBRAIN_HOME
# so this can never race the live PGLite lock. This exercises the exact
# thing that killed the single-binary approach (PGLite WASM init) — a
# release that fails this does not get published.
ISOLATED_HOME="$STAGING_DIR/.preflight-home"
mkdir -p "$ISOLATED_HOME"
VERSION_OUTPUT="$(GBRAIN_HOME="$ISOLATED_HOME" "$STAGING_DIR/bin/gbrain" --version 2>&1)" \
  || die "release launcher failed to run --version: $VERSION_OUTPUT"
rm -rf "$ISOLATED_HOME"
GBRAIN_VERSION="$(echo "$VERSION_OUTPUT" | awk '{print $2}')"
[ -n "$GBRAIN_VERSION" ] || die "could not parse gbrain version from: $VERSION_OUTPUT"
log "launcher sanity check OK: gbrain $GBRAIN_VERSION"

# --- 6. Checksums. Every file under app/src (the security-critical part),
# plus package.json, bun.lock, the pinned bun runtime, and the launcher
# itself. node_modules is covered by the single aggregate digest above, not
# per-file here (see rationale above).
: > "$STAGING_DIR/checksums.txt"
( cd "$STAGING_DIR" && find app/src -type f -print0 | sort -z | xargs -0 shasum -a 256 ) >> "$STAGING_DIR/checksums.txt"
{
  echo "$(sha256_of "$STAGING_DIR/app/package.json")  app/package.json"
  echo "$(sha256_of "$STAGING_DIR/app/bun.lock")  app/bun.lock"
  echo "$(sha256_of "$STAGING_DIR/runtime/bun")  runtime/bun"
  echo "$(sha256_of "$STAGING_DIR/bin/gbrain")  bin/gbrain"
} >> "$STAGING_DIR/checksums.txt"
LAUNCHER_CHECKSUM="$(sha256_of "$STAGING_DIR/bin/gbrain")"

DIFF_CONTENT="$(git diff HEAD -- 2>/dev/null || true)"
printf '%s' "$DIFF_CONTENT" > "$STAGING_DIR/source.diff"

cat > "$STAGING_DIR/manifest.json" <<EOF
{
  "release_name": "$RELEASE_NAME",
  "version": "$GBRAIN_VERSION",
  "git_sha": "$GIT_SHA",
  "git_sha_short": "$GIT_SHA_SHORT",
  "source_dirty": $SOURCE_DIRTY,
  "built_at": "$BUILT_AT",
  "bundle_type": "runtime-bundle",
  "port": $GBRAIN_HTTP_PORT,
  "public_url": "$GBRAIN_PUBLIC_URL",
  "routes_expected": ["/mcp", "/mcp-v2", "/health"],
  "launcher_checksum_sha256": "$LAUNCHER_CHECKSUM",
  "bun_runtime": {
    "source_path": "$BUN_SOURCE_REALPATH",
    "version": "$BUN_VERSION",
    "sha256": "$BUN_CHECKSUM"
  },
  "dependency_count": $DEP_COUNT,
  "node_modules_digest_sha256": "$NODE_MODULES_DIGEST",
  "install_flags": "--production --frozen-lockfile --ignore-scripts"
}
EOF

# --- 7. Secret scan across the whole staging tree before it ever becomes
# visible under releases/ (skip node_modules for speed — third-party
# package source is not a plausible place for OUR secrets to leak from, and
# scanning potentially tens of thousands of vendored files here would slow
# every single build; app/src, manifest, checksums, and the launcher are the
# actual attacker-relevant surface for accidental secret inclusion).
SCAN_TARGET="$STAGING_DIR/.secret-scan-view"
mkdir -p "$SCAN_TARGET"
ln -s "$STAGING_DIR/app/src" "$SCAN_TARGET/src"
cp "$STAGING_DIR/manifest.json" "$STAGING_DIR/checksums.txt" "$STAGING_DIR/source.diff" "$SCAN_TARGET/"
if ! scan_for_secrets "$SCAN_TARGET"; then
  die "secret-shaped pattern found in staging release — refusing to publish (see log above for which file)"
fi
rm -rf "$SCAN_TARGET"

# --- 8. Read-only-ish + atomic publish.
chmod -R a-w "$STAGING_DIR/manifest.json" "$STAGING_DIR/checksums.txt" "$STAGING_DIR/source.diff"
chmod 555 "$STAGING_DIR" "$STAGING_DIR/app" "$STAGING_DIR/runtime" "$STAGING_DIR/bin"

mv "$STAGING_DIR" "$FINAL_DIR"
trap - EXIT

log "release $RELEASE_NAME built OK (bundle_type=runtime-bundle, version=$GBRAIN_VERSION, bun=$BUN_VERSION)"
echo "$FINAL_DIR"
