#!/usr/bin/env bash
# Phase 9C (Universal Audit Event Integration) — static, no-runtime-needed
# sanity check that every HTTP route path literally registered in
# src/commands/serve-http.ts is declared SOMEWHERE in
# src/core/audit/entrypoint-registry.ts (IN_ROUTES or OUT_ROUTES).
#
# This is a fast, CI-friendly text-extraction gate — it complements, and
# does NOT replace, test/audit-entrypoint-coverage.test.ts, which does the
# authoritative check via real runtime Express introspection
# (app.router.stack) against a live server. This script only catches the
# most common drift shape (a brand-new route added to serve-http.ts and
# never declared in the registry) fast, without spinning up a server —
# it does not verify HTTP method, and it does not (cannot, via grep) see
# routes mounted by @modelcontextprotocol/sdk's mcpAuthRouter, matching
# entrypoint-registry.ts's own documented scope limits.
#
# Wired into `bun run verify` / `bun run check:all` alongside
# check-admin-scope-drift.sh (same pattern: extract two lists, diff).
#
# Exits 0 on match, 1 on drift, 2 on internal error (file missing, parse fail).
#
# Usage:  scripts/check-audit-registry-drift.sh
set -euo pipefail

SERVE_HTTP=src/commands/serve-http.ts
REGISTRY=src/core/audit/entrypoint-registry.ts

[ -f "$SERVE_HTTP" ] || { echo "[check-audit-registry-drift] missing $SERVE_HTTP" >&2; exit 2; }
[ -f "$REGISTRY" ] || { echo "[check-audit-registry-drift] missing $REGISTRY" >&2; exit 2; }
command -v perl >/dev/null 2>&1 || { echo "[check-audit-registry-drift] perl not found (needed for multi-line-aware extraction)" >&2; exit 2; }

# Extract every path literal from app.get/post/put/delete/patch( ... ) call
# sites, including the multi-line form (path on its own line after the
# opening paren, e.g. POST /ingest and POST /webhooks/github) and the
# array form (app.get(['/mcp', '/mcp-v2'], ...)). Deliberately does NOT
# match app.use( — CORS/middleware mounts are not routes.
live_paths=$(
  perl -0777 -ne "
    while (/app\.(?:get|post|put|delete|patch)\(\s*(\[[^]]*\]|'[^']*')/gs) {
      my \$m = \$1;
      while (\$m =~ /'([^']*)'/g) { print \"\$1\n\"; }
    }
  " "$SERVE_HTTP" | sort -u
)

# Extract every `path: '...'` declared in entrypoint-registry.ts's
# RouteEntry literals (IN_ROUTES, OUT_ADMIN_READONLY_ROUTES, OUT_OTHER_ROUTES).
declared_paths=$(grep -oE "path: '[^']*'" "$REGISTRY" | sed -E "s/path: '(.*)'/\1/" | sort -u)

if [ -z "$live_paths" ]; then
  echo "[check-audit-registry-drift] could not extract any route paths from $SERVE_HTTP — extraction regex may be stale" >&2
  exit 2
fi
if [ -z "$declared_paths" ]; then
  echo "[check-audit-registry-drift] could not extract any declared paths from $REGISTRY — extraction regex may be stale" >&2
  exit 2
fi

missing=""
while IFS= read -r p; do
  [ -z "$p" ] && continue
  if ! grep -qxF "$p" <<< "$declared_paths"; then
    missing="${missing}${p}\n"
  fi
done <<< "$live_paths"

if [ -n "$missing" ]; then
  echo "[check-audit-registry-drift] DRIFT detected: the following route path(s) are registered in $SERVE_HTTP but not declared in $REGISTRY's IN_ROUTES or OUT_ROUTES:" >&2
  printf "%b" "$missing" >&2
  echo "" >&2
  echo "Add each to IN_ROUTES (if it should be audited) or OUT_ROUTES (if it is deliberately not audited, with a reason) in $REGISTRY." >&2
  echo "test/audit-entrypoint-coverage.test.ts is the authoritative runtime check; run it after fixing this." >&2
  exit 1
fi

live_count=$(printf '%s\n' "$live_paths" | grep -c . || true)
echo "[check-audit-registry-drift] ok: all $live_count live route path(s) are declared in entrypoint-registry.ts"
