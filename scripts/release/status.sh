#!/usr/bin/env bash
# gbrain deployment status — read-only. Shows current/previous release,
# their manifests, the full release list, and a live smoke-test-lite ping.
#
# Usage: status.sh
#
# dashboard-yct90.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"
SCRIPT_LOG_NAME="status"

echo "gbrain production deployment status"
echo "===================================="
echo "prod root:   $GBRAIN_PROD_ROOT"
echo "data dir:    $GBRAIN_DATA_DIR"
echo ""

if [ -L "$CURRENT_LINK" ]; then
  CUR="$(readlink "$CURRENT_LINK")"
  echo "current  -> $CUR"
  if [ -f "$CUR/manifest.json" ]; then
    bun -e '
      const fs = require("fs");
      const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      console.log(`  version:     ${m.version}`);
      console.log(`  bundle_type: ${m.bundle_type}`);
      console.log(`  git_sha:     ${m.git_sha_short} (dirty=${m.source_dirty})`);
      console.log(`  built_at:    ${m.built_at}`);
      const bunInfo = m.bun_runtime ? (m.bun_runtime.version + " (" + m.bun_runtime.sha256 + ")") : "unknown";
      console.log("  bun runtime: " + bunInfo);
      console.log(`  launcher:    ${m.launcher_checksum_sha256}`);
      console.log(`  node_modules digest: ${m.node_modules_digest_sha256}`);
    ' "$CUR/manifest.json"
  fi
else
  echo "current  -> (not set)"
fi

echo ""
if [ -L "$PREVIOUS_LINK" ]; then
  PREV="$(readlink "$PREVIOUS_LINK")"
  echo "previous -> $PREV"
else
  echo "previous -> (not set)"
fi

echo ""
echo "all releases:"
if [ -d "$RELEASES_DIR" ]; then
  find "$RELEASES_DIR" -mindepth 1 -maxdepth 1 -type d -not -name '.staging.*' | sort | while read -r d; do
    echo "  $d"
  done
else
  echo "  (none — releases/ does not exist yet)"
fi

echo ""
echo "live ping (127.0.0.1:$GBRAIN_HTTP_PORT/health):"
if resp="$(curl -s -m 3 -w '\n%{http_code}' "http://127.0.0.1:$GBRAIN_HTTP_PORT/health" 2>/dev/null)"; then
  code="$(echo "$resp" | tail -1)"
  body="$(echo "$resp" | sed '$d')"
  echo "  HTTP $code: $body"
else
  echo "  (no response — service may be down)"
fi
