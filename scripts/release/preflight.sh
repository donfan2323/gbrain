#!/usr/bin/env bash
# gbrain release preflight — validates a runtime-bundle release BEFORE it is
# ever made current. Never opens the production PGLite DB (every binary
# invocation here uses an isolated, throwaway GBRAIN_HOME). Read-only with
# respect to the release itself and to shared/.
#
# Usage: preflight.sh <release-name-or-path>
# Exit 0 = safe to deploy. Non-zero = do not deploy; message explains why.
#
# dashboard-yct90.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"
SCRIPT_LOG_NAME="preflight"

[ $# -ge 1 ] || die "usage: preflight.sh <release-name-or-path>"
RELEASE_DIR="$(resolve_release_path "$1")"

log "preflight: $RELEASE_DIR"

[ -d "$RELEASE_DIR" ] || die "release directory does not exist: $RELEASE_DIR"
[ -f "$RELEASE_DIR/manifest.json" ] || die "missing manifest.json in $RELEASE_DIR"
[ -f "$RELEASE_DIR/checksums.txt" ] || die "missing checksums.txt in $RELEASE_DIR"
[ -f "$RELEASE_DIR/bin/gbrain" ] || die "missing bin/gbrain launcher in $RELEASE_DIR"
[ -x "$RELEASE_DIR/bin/gbrain" ] || die "bin/gbrain is not executable in $RELEASE_DIR"
[ -x "$RELEASE_DIR/runtime/bun" ] || die "missing or non-executable runtime/bun in $RELEASE_DIR"
[ -d "$RELEASE_DIR/app/node_modules" ] || die "missing app/node_modules in $RELEASE_DIR"
[ -f "$RELEASE_DIR/app/src/cli.ts" ] || die "missing app/src/cli.ts in $RELEASE_DIR"

command -v bun >/dev/null 2>&1 || die "bun not found on PATH — cannot validate manifest.json"

MANIFEST_CHECK="$(bun -e '
  const fs = require("fs");
  const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const required = ["release_name","version","git_sha","git_sha_short","built_at","port","routes_expected","bundle_type","launcher_checksum_sha256","bun_runtime","node_modules_digest_sha256"];
  const missing = required.filter(k => !(k in m));
  if (missing.length) { console.log("MISSING:" + missing.join(",")); process.exit(1); }
  if (m.bundle_type !== "runtime-bundle") { console.log("WRONG_TYPE:" + m.bundle_type); process.exit(1); }
  if (!m.bun_runtime || !m.bun_runtime.sha256 || !m.bun_runtime.version) { console.log("BAD_BUN_RUNTIME_FIELD"); process.exit(1); }
  console.log("OK:" + m.launcher_checksum_sha256 + ":" + m.port + ":" + m.bun_runtime.sha256 + ":" + m.node_modules_digest_sha256);
' "$RELEASE_DIR/manifest.json" 2>&1)" || die "manifest.json failed validation: $MANIFEST_CHECK"

IFS=':' read -r _ MANIFEST_LAUNCHER_CHECKSUM MANIFEST_PORT MANIFEST_BUN_CHECKSUM MANIFEST_NM_DIGEST <<< "$MANIFEST_CHECK"

# --- Checksum verification: launcher script.
ACTUAL_LAUNCHER_CHECKSUM="$(sha256_of "$RELEASE_DIR/bin/gbrain")"
[ "$ACTUAL_LAUNCHER_CHECKSUM" = "$MANIFEST_LAUNCHER_CHECKSUM" ] \
  || die "launcher checksum mismatch: manifest says $MANIFEST_LAUNCHER_CHECKSUM, bin/gbrain is actually $ACTUAL_LAUNCHER_CHECKSUM"
grep -q "  bin/gbrain\$" "$RELEASE_DIR/checksums.txt" || die "checksums.txt missing bin/gbrain entry"
RECORDED_LAUNCHER_CHECKSUM="$(grep "  bin/gbrain\$" "$RELEASE_DIR/checksums.txt" | awk '{print $1}')"
[ "$ACTUAL_LAUNCHER_CHECKSUM" = "$RECORDED_LAUNCHER_CHECKSUM" ] \
  || die "launcher checksum mismatch: checksums.txt says $RECORDED_LAUNCHER_CHECKSUM, actual is $ACTUAL_LAUNCHER_CHECKSUM"

# --- Checksum verification: pinned bun runtime.
ACTUAL_BUN_CHECKSUM="$(sha256_of "$RELEASE_DIR/runtime/bun")"
[ "$ACTUAL_BUN_CHECKSUM" = "$MANIFEST_BUN_CHECKSUM" ] \
  || die "runtime/bun checksum mismatch: manifest says $MANIFEST_BUN_CHECKSUM, actual is $ACTUAL_BUN_CHECKSUM"

# --- Checksum verification: app/src, sampled fully (every file is listed in
# checksums.txt at build time — verify every one still matches).
MISMATCHES=0
while IFS= read -r line; do
  hash="${line%%  *}"
  relpath="${line#*  }"
  case "$relpath" in
    app/src/*)
      actual="$(sha256_of "$RELEASE_DIR/$relpath" 2>/dev/null || echo "MISSING")"
      if [ "$actual" != "$hash" ]; then
        log "CHECKSUM MISMATCH: $relpath (expected $hash, got $actual)"
        MISMATCHES=$((MISMATCHES + 1))
      fi
      ;;
  esac
done < "$RELEASE_DIR/checksums.txt"
[ "$MISMATCHES" -eq 0 ] || die "$MISMATCHES file(s) under app/src failed checksum verification — release may have been tampered with or corrupted"

# --- node_modules aggregate digest re-verification (same xargs-batched
# computation as build time, using RELATIVE paths via `cd` first — must
# match build-release.sh's computation exactly, or the digest would be
# comparing hashes of two different path strings rather than actual content
# drift; see build-release.sh's comment on this for the empirical bug this
# fixes).
ACTUAL_NM_DIGEST="$(cd "$RELEASE_DIR" && find app/node_modules -type f -print0 2>/dev/null | sort -z | xargs -0 shasum -a 256 | shasum -a 256 | awk '{print $1}')"
[ "$ACTUAL_NM_DIGEST" = "$MANIFEST_NM_DIGEST" ] \
  || die "node_modules digest mismatch: manifest says $MANIFEST_NM_DIGEST, actual is $ACTUAL_NM_DIGEST — dependency tree drifted since build"

[ "$MANIFEST_PORT" = "$GBRAIN_HTTP_PORT" ] \
  || die "manifest port ($MANIFEST_PORT) does not match configured GBRAIN_HTTP_PORT ($GBRAIN_HTTP_PORT) — Caddy hardcodes this port, refusing to deploy a mismatched release"

# --- Secrets must never be present, checked again independently of
# build-time scanning (skip node_modules — third-party vendored source, not
# scanned at build time either, for the same speed/relevance rationale).
SCAN_TARGET="$(mktemp -d)"
trap 'rm -rf "$SCAN_TARGET"' EXIT
ln -s "$RELEASE_DIR/app/src" "$SCAN_TARGET/src"
cp "$RELEASE_DIR/manifest.json" "$RELEASE_DIR/checksums.txt" "$RELEASE_DIR/source.diff" "$SCAN_TARGET/" 2>/dev/null || true
scan_for_secrets "$SCAN_TARGET" \
  || die "secret-shaped pattern found in release — refusing to deploy"

# --- The bundle must run WITHOUT touching production data. Isolated
# GBRAIN_HOME only — this is the single most important invariant in this
# whole pipeline: preflight must never race the live PGLite lock.
ISOLATED_HOME="$(mktemp -d)"
VERSION_OUTPUT="$(GBRAIN_HOME="$ISOLATED_HOME" "$RELEASE_DIR/bin/gbrain" --version 2>&1)" \
  || die "release launcher failed --version under isolated GBRAIN_HOME: $VERSION_OUTPUT"
rm -rf "$ISOLATED_HOME"
log "isolated run OK: $VERSION_OUTPUT"

# --- launchd plist syntax check, if the plist already exists.
if [ -f "$GBRAIN_LAUNCHD_PLIST" ]; then
  if command -v plutil >/dev/null 2>&1; then
    plutil -lint "$GBRAIN_LAUNCHD_PLIST" >/dev/null || die "launchd plist fails plutil -lint: $GBRAIN_LAUNCHD_PLIST"
  fi
fi

# --- shared/ must exist (or be creatable) and be writable.
mkdir -p "$SHARED_LOGS_DIR" "$SHARED_BACKUPS_DIR"
[ -w "$SHARED_LOGS_DIR" ] || die "shared/logs is not writable: $SHARED_LOGS_DIR"
[ -w "$SHARED_BACKUPS_DIR" ] || die "shared/backups is not writable: $SHARED_BACKUPS_DIR"

# --- Real data dir must exist — this pipeline never migrates it.
[ -d "$GBRAIN_DATA_DIR" ] || die "GBRAIN_DATA_DIR does not exist: $GBRAIN_DATA_DIR (this pipeline never creates or migrates data — only links to an existing dir)"

log "preflight PASSED for $RELEASE_DIR (launcher=$ACTUAL_LAUNCHER_CHECKSUM, bun=$ACTUAL_BUN_CHECKSUM, node_modules=$ACTUAL_NM_DIGEST)"
