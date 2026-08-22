#!/usr/bin/env bash
# gbrain post-deploy smoke test. Talks to the LOCAL server directly
# (127.0.0.1:$GBRAIN_HTTP_PORT), never through Caddy — Caddy's matcher does
# not even proxy /health, and hitting the public URL would also depend on
# Tailscale/Caddy being reachable, which is out of this pipeline's control
# and not what we're verifying here.
#
# Usage: smoke-test.sh [expected_version]
# Exit 0 = healthy. Non-zero = NOT healthy (caller should roll back).
# Never logs a request/response body verbatim — only status codes and
# specific whitelisted JSON fields.
#
# dashboard-yct90.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"
SCRIPT_LOG_NAME="smoke-test"

EXPECTED_VERSION="${1:-}"
BASE_URL="http://127.0.0.1:${GBRAIN_HTTP_PORT}"
MAX_WAIT_SECONDS="${GBRAIN_SMOKE_MAX_WAIT:-30}"
REQUIRED_CONSECUTIVE_PASSES="${GBRAIN_SMOKE_CONSECUTIVE_PASSES:-3}"

log "smoke test starting against $BASE_URL (expected_version=${EXPECTED_VERSION:-<any>})"

# --- Wait for the process to come up. A connection failure during the
# startup grace window is NOT a failure verdict yet; it only becomes one if
# we never see a single successful response before MAX_WAIT_SECONDS.
waited=0
health_body=""
while [ "$waited" -lt "$MAX_WAIT_SECONDS" ]; do
  if health_body="$(curl -s -m 3 -w '\n%{http_code}' "$BASE_URL/health" 2>/dev/null)"; then
    code="$(echo "$health_body" | tail -1)"
    if [ "$code" = "200" ] || [ "$code" = "503" ]; then
      break
    fi
  fi
  sleep 1
  waited=$((waited + 1))
done

code="$(echo "$health_body" | tail -1)"
body="$(echo "$health_body" | sed '$d')"

[ "$code" = "200" ] || die "/health did not return 200 within ${MAX_WAIT_SECONDS}s (last status: ${code:-no response})"

if [ -n "$EXPECTED_VERSION" ]; then
  actual_version="$(echo "$body" | bun -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{console.log(JSON.parse(d).version||"")}catch{console.log("")}})' 2>/dev/null || true)"
  [ "$actual_version" = "$EXPECTED_VERSION" ] \
    || die "/health version mismatch: expected $EXPECTED_VERSION, got ${actual_version:-<unparseable>}"
fi
log "/health OK (version matches: ${EXPECTED_VERSION:-<not checked>})"

# --- /mcp and /mcp-v2 must both be reachable (401 = route exists, auth
# required — the expected, correct response for an unauthenticated probe).
# A 404 here means the route regressed (exactly the failure mode this
# pipeline exists to catch, per the /mcp-v2 incident that motivated it).
for route in /mcp /mcp-v2; do
  route_code="$(curl -s -o /dev/null -m 5 -w '%{http_code}' -X POST "$BASE_URL$route" -H 'Content-Type: application/json' -d '{}')"
  [ "$route_code" = "401" ] || die "$route returned $route_code, expected 401 (route missing or auth gate broken)"
  log "$route OK (401 — route present, auth required as expected)"
done

# --- OAuth discovery + PKCE S256 support.
discovery="$(curl -s -m 5 "$BASE_URL/.well-known/oauth-authorization-server")"
echo "$discovery" | bun -e '
  let d=""; process.stdin.on("data",c=>d+=c);
  process.stdin.on("end",()=>{
    const j = JSON.parse(d);
    if (!Array.isArray(j.code_challenge_methods_supported) || !j.code_challenge_methods_supported.includes("S256")) {
      console.error("PKCE S256 not advertised in oauth-authorization-server metadata");
      process.exit(1);
    }
  });
' || die "OAuth discovery / PKCE S256 check failed"
log "OAuth discovery + PKCE S256 OK"

# --- Unauthenticated admin-ish call must be rejected, never succeed.
unauth_code="$(curl -s -o /dev/null -m 5 -w '%{http_code}' -X POST "$BASE_URL/mcp" -H 'Content-Type: application/json' -d '{"method":"tools/call","params":{"name":"get_health"}}')"
[ "$unauth_code" = "401" ] || die "unauthenticated MCP call returned $unauth_code, expected 401 (auth bypass regression)"
log "unauthenticated-call rejection OK"

# --- Require N consecutive full passes (of the cheap checks) before final
# verdict, to rule out a flaky single-shot pass.
passes=0
for _ in $(seq 1 "$REQUIRED_CONSECUTIVE_PASSES"); do
  code2="$(curl -s -o /dev/null -m 3 -w '%{http_code}' "$BASE_URL/health")"
  [ "$code2" = "200" ] && passes=$((passes + 1))
  sleep 0.5
done
[ "$passes" -eq "$REQUIRED_CONSECUTIVE_PASSES" ] \
  || die "only $passes/$REQUIRED_CONSECUTIVE_PASSES consecutive /health passes — treating as unhealthy"

log "smoke test PASSED ($passes/$REQUIRED_CONSECUTIVE_PASSES consecutive /health checks, /mcp, /mcp-v2, OAuth discovery, PKCE S256, auth-rejection)"
