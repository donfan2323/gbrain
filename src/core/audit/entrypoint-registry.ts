/**
 * Phase 9C (Universal Audit Event Integration) — the "intentionally not
 * audited" / "audited" registry for HTTP entry points, and the drift
 * detector that keeps it honest against the live Express routing stack.
 *
 * Design reference: PHASE9C-IMPLEMENTATION-SCOPE.md §2-1/§2-2,
 * PHASE9C-ACCEPTANCE-CRITERIA.md §3 row 10.
 *
 * Scope and a verified limitation:
 *
 *   - Every route gbrain registers ITSELF (`app.get('/foo', ...)` etc.)
 *     is registered directly on `app`, never through a sub-router gbrain
 *     owns — verified by grepping every `app.use(` call in serve-http.ts
 *     (cors/cookie-parser/static-file/inline-middleware only, plus the
 *     one exception below). `enumerateDirectRoutes()` therefore sees
 *     every gbrain-owned route with an exact, reliable path.
 *
 *   - The ONE exception is `@modelcontextprotocol/sdk`'s `mcpAuthRouter`,
 *     mounted via `app.use(authRouter)` with no path prefix. It is
 *     itself an `express.Router()`, and internally does
 *     `router.use(new URL(...).pathname, authorizationHandler(...))`
 *     (same for token/register/revoke) — each of THOSE handlers is
 *     ALSO an `express.Router()` (verified by reading the SDK source
 *     directly under node_modules). Reconstructing the resulting full
 *     path (e.g. `/authorize`) from `app.router.stack` alone is NOT
 *     reliably possible in this Express 5: a mounted sub-router's layer
 *     has no static `.path` string at registration time — Express 5's
 *     new router (path-to-regexp v8-based) resolves the matched prefix
 *     lazily via `layer.matchers`, only at actual request-dispatch time
 *     (verified directly against the installed express@^5.1.0 by
 *     inspecting a minimal two-level-nested-router app: `layer.path` is
 *     `undefined` until a real request is routed through it).
 *
 *     `checkEntrypointDrift()` therefore does NOT attempt to verify the
 *     SDK's internal routes by path. It verifies only that the expected
 *     NUMBER of top-level mounted routers is present (see
 *     `EXPECTED_MOUNTED_ROUTER_COUNT`) — enough to catch "someone added
 *     a second, unaccounted-for mounted router" without claiming
 *     precision this Express version cannot deliver. The SDK's
 *     `/authorize`, `/register`, and its own `/token`/`/revoke` fallback
 *     stay declared in `IN_ROUTES` below for documentation completeness
 *     (matching PHASE9C-IMPLEMENTATION-SCOPE.md §2-1 IN-3's text), but
 *     are informational only w.r.t. this file's drift check — this
 *     matches PHASE9C-CURRENT-AUDIT-PATHS.md's own acknowledgment that
 *     the SDK's internal audit behavior is "gbrainリポジトリ外のため未確認."
 *
 * stdio MCP's general operations, local CLI, and the operational-
 * diagnostic JSONL modules are not Express routes at all and are
 * therefore outside what any of this can verify — see
 * `OUT_NON_HTTP_CATEGORIES`.
 */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

export interface RouteEntry {
  method: HttpMethod;
  /** Exact Express path pattern as registered (e.g. '/admin/api/calibration/pattern/:id'). */
  path: string;
  /** One-line reason, cited in drift failures so a future reader doesn't have to dig through design docs. */
  reason: string;
}

/**
 * IN: audited HTTP entry points (PHASE9C-IMPLEMENTATION-SCOPE.md §2-1).
 * `/mcp`/`/mcp-v2` (IN-1/IN-2), OAuth lifecycle (IN-3), admin Authority-
 * changing routes (IN-4, 9 routes: 7 under `/admin/api/*` + the 2
 * session-establishment routes outside that prefix), and the webhook
 * (IN-5). `submit_agent` (IN-6) is NOT an HTTP route — it's a transport-
 * independent operation handler, verified separately by
 * `test/audit-delegation-chain.test.ts`.
 *
 * The four entries marked "(SDK, informational)" are mounted by
 * `@modelcontextprotocol/sdk`'s `mcpAuthRouter`, not by gbrain directly —
 * `checkEntrypointDrift()` cannot verify these by path (see file header);
 * they are declared here for documentation completeness only.
 */
export const IN_ROUTES: readonly RouteEntry[] = [
  { method: 'POST', path: '/mcp', reason: 'IN-1: primary MCP JSON-RPC endpoint' },
  { method: 'POST', path: '/mcp-v2', reason: 'IN-1: ChatGPT-connector-compatible MCP endpoint' },
  { method: 'POST', path: '/ingest', reason: 'IN-2: direct content ingestion (success + rejection/failure)' },
  { method: 'POST', path: '/token', reason: 'IN-3: gbrain\'s own client_credentials + confidential-client token endpoint' },
  { method: 'POST', path: '/revoke', reason: 'IN-3: gbrain\'s own token revocation endpoint' },
  { method: 'GET', path: '/authorize', reason: 'IN-3 (SDK, informational): mcpAuthRouter — PKCE authorization_code flow' },
  { method: 'POST', path: '/authorize', reason: 'IN-3 (SDK, informational): mcpAuthRouter — PKCE consent submission' },
  { method: 'POST', path: '/register', reason: 'IN-3 (SDK, informational): mcpAuthRouter — Dynamic Client Registration (RFC 7591), an Authority-granting operation' },
  { method: 'POST', path: '/admin/login', reason: 'IN-4: bootstrap-token admin session establishment (session.establish)' },
  { method: 'GET', path: '/admin/auth/:token', reason: 'IN-4: magic-link admin session redemption (session.establish)' },
  { method: 'POST', path: '/admin/api/issue-magic-link', reason: 'IN-4: mints a one-time magic-link nonce' },
  { method: 'POST', path: '/admin/api/sign-out-everywhere', reason: 'IN-4: revokes all admin sessions (session.terminate)' },
  { method: 'POST', path: '/admin/api/api-keys', reason: 'IN-4: issues a legacy bearer token' },
  { method: 'POST', path: '/admin/api/api-keys/revoke', reason: 'IN-4: revokes a legacy bearer token' },
  { method: 'POST', path: '/admin/api/register-client', reason: 'IN-4: registers an OAuth client' },
  { method: 'POST', path: '/admin/api/update-client-ttl', reason: 'IN-4: modifies an OAuth client\'s token TTL' },
  { method: 'POST', path: '/admin/api/revoke-client', reason: 'IN-4: hard-deletes an OAuth client' },
  { method: 'POST', path: '/webhooks/github', reason: 'IN-5: HMAC-verified inbound webhook' },
] as const;

/** Declared-but-drift-check-unverifiable (SDK-mounted routes; see file header). Excluded from the direct-route diff so they never show up as spurious "unregistered" or "stale" noise. */
const SDK_INFORMATIONAL_ROUTE_KEYS = new Set(
  IN_ROUTES.filter((r) => r.reason.includes('(SDK, informational)')).map((r) => `${r.method} ${r.path}`),
);

/**
 * OUT: `/admin/api/*` read-only GET routes (11, PHASE9C-IMPLEMENTATION-
 * SCOPE.md §2-2 OUT-3). Authority-neutral; several are high-frequency
 * polling endpoints that would pollute the audit table if recorded.
 */
export const OUT_ADMIN_READONLY_ROUTES: readonly RouteEntry[] = [
  { method: 'GET', path: '/admin/api/agents', reason: 'OUT-3: read-only, Authority-neutral' },
  { method: 'GET', path: '/admin/api/agents/spend', reason: 'OUT-3: read-only, Authority-neutral' },
  { method: 'GET', path: '/admin/api/stats', reason: 'OUT-3: read-only, Authority-neutral' },
  { method: 'GET', path: '/admin/api/health-indicators', reason: 'OUT-3: read-only, high-frequency polling' },
  { method: 'GET', path: '/admin/api/full-stats', reason: 'OUT-3: read-only, Authority-neutral' },
  { method: 'GET', path: '/admin/api/jobs/watch', reason: 'OUT-3: read-only, high-frequency polling' },
  { method: 'GET', path: '/admin/api/calibration/pattern/:id', reason: 'OUT-3: read-only, Authority-neutral' },
  { method: 'GET', path: '/admin/api/calibration/profile', reason: 'OUT-3: read-only, Authority-neutral' },
  { method: 'GET', path: '/admin/api/calibration/charts/:type', reason: 'OUT-3: read-only, Authority-neutral' },
  { method: 'GET', path: '/admin/api/requests', reason: 'OUT-3: read-only, Authority-neutral' },
  { method: 'GET', path: '/admin/api/api-keys', reason: 'OUT-3: read-only, Authority-neutral' },
] as const;

/**
 * OUT: everything else that is a live, gbrain-owned Express route but
 * structurally irrelevant to Phase 9C's judging principle (no attempted
 * exercise of Authority) — liveness probe, admin SPA static assets, the
 * 405-by-design GET handlers for the POST-only MCP endpoints, and the
 * admin SSE debug stream.
 */
export const OUT_OTHER_ROUTES: readonly RouteEntry[] = [
  { method: 'GET', path: '/health', reason: 'liveness probe, no Authority' },
  { method: 'GET', path: '/.well-known/openid-configuration', reason: 'static OAuth discovery metadata, no Authority (gbrain-owned handler; the SDK mounts its own separate discovery routes, not covered by direct-route enumeration)' },
  { method: 'GET', path: '/mcp', reason: 'returns 405 by design (MCP is POST-only); no Authority exercised' },
  { method: 'GET', path: '/mcp-v2', reason: 'returns 405 by design (MCP is POST-only); no Authority exercised' },
  { method: 'GET', path: '/admin/events', reason: 'SSE debug stream, gated by requireAdmin but not an Authority-changing action itself; out of Phase 9C scope per DOMAIN-MODEL.md §5 note on SSE' },
  { method: 'GET', path: '/admin/{*path}', reason: 'admin SPA static asset serving / client-side-routing catch-all' },
] as const;

export const OUT_ROUTES: readonly RouteEntry[] = [...OUT_ADMIN_READONLY_ROUTES, ...OUT_OTHER_ROUTES];

/**
 * Categories the drift checker structurally cannot verify (not Express
 * routes at all). Declared here for documentation completeness; the
 * absence-of-instrumentation for these is verified by other means (code
 * review, `test/audit-delegation-chain.test.ts` for submit_agent).
 */
export const OUT_NON_HTTP_CATEGORIES: readonly string[] = [
  'stdio MCP general operations (src/mcp/server.ts) — ctx.auth is always undefined, no Authority to exercise',
  'local CLI (gbrain <command>) — authorization is delegated to the OS boundary (AUTHZ-INV-011)',
  '18-30+ operational-diagnostic JSONL modules (*-audit.ts under src/core/) — no subject, no authorization decision, gbrain-internal telemetry',
];

/**
 * Number of top-level mounted sub-routers (`app.use(someRouter)`,
 * `layer.route` absent, `layer.name === 'router'`) gbrain's Express app
 * is expected to have. Currently exactly 1: `@modelcontextprotocol/sdk`'s
 * `mcpAuthRouter` (see file header for why its internal routes aren't
 * individually verified). If this count ever changes, `checkEntrypoint
 * Drift()` flags it — a new mounted router is exactly the kind of change
 * that could silently introduce unaudited Authority-changing routes.
 */
export const EXPECTED_MOUNTED_ROUTER_COUNT = 1;

interface ExpressRouteLayer {
  route?: { path: string | string[]; methods: Record<string, boolean> };
  name?: string;
  handle?: { stack?: unknown[] };
}

/**
 * Every route gbrain registers directly on `app` (not through any
 * sub-router it owns — see file header for why this is exhaustive for
 * gbrain's own code). Only inspects the TOP-level `app.router.stack`;
 * does not recurse into mounted sub-routers (see `countMountedRouters`).
 *
 * `layer.route.path` is an ARRAY, not a string, when the route was
 * registered with multiple paths in one call (serve-http.ts does exactly
 * this: `app.get(['/mcp', '/mcp-v2'], ...)`) — verified directly against
 * the installed express@^5.1.0. Each path in the array becomes its own
 * `RouteEntry` so it matches the registry's separate string declarations.
 */
export function enumerateDirectRoutes(app: { router?: { stack: ExpressRouteLayer[] } }): RouteEntry[] {
  const stack = app.router?.stack ?? [];
  const out: RouteEntry[] = [];
  for (const layer of stack) {
    if (!layer.route) continue;
    const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
    for (const [method, enabled] of Object.entries(layer.route.methods)) {
      if (!enabled) continue;
      const upper = method.toUpperCase();
      if (upper === '_ALL') continue; // Express's internal 'all' marker on some route shapes
      for (const path of paths) {
        out.push({ method: upper as HttpMethod, path, reason: '' });
      }
    }
  }
  return out;
}

/** Count top-level layers that are mounted sub-routers (not direct routes). */
export function countMountedRouters(app: { router?: { stack: ExpressRouteLayer[] } }): number {
  const stack = app.router?.stack ?? [];
  return stack.filter((layer) => !layer.route && layer.name === 'router' && layer.handle?.stack).length;
}

function routeKey(r: { method: string; path: string }): string {
  return `${r.method.toUpperCase()} ${r.path}`;
}

export interface DriftResult {
  /** Live gbrain-owned routes present in Express but declared in NEITHER IN_ROUTES nor OUT_ROUTES — the actionable failure. */
  unregisteredRoutes: RouteEntry[];
  /** Declared IN/OUT routes (excluding SDK-informational ones) that no longer exist live — informational (registry ahead of code), not itself a failure. */
  staleDeclarations: RouteEntry[];
  /** Actual vs. expected count of mounted sub-routers (e.g. a new one appeared, unaccounted for). */
  mountedRouterCount: number;
  mountedRouterCountMatchesExpected: boolean;
}

/**
 * The mechanism behind AUTHZ-INV-013's "偶発的な見落としとして放置されない":
 * every live, gbrain-owned HTTP route must be declared IN or OUT, and the
 * number of mounted sub-routers (the SDK boundary) must match what's
 * expected. `test/audit-entrypoint-coverage.test.ts` asserts both are
 * clean.
 */
export function checkEntrypointDrift(app: { router?: { stack: ExpressRouteLayer[] } }): DriftResult {
  const live = enumerateDirectRoutes(app);
  const liveKeys = new Set(live.map(routeKey));
  const declared = [...IN_ROUTES, ...OUT_ROUTES].filter((r) => !SDK_INFORMATIONAL_ROUTE_KEYS.has(routeKey(r)));
  const declaredKeys = new Set(declared.map(routeKey));

  const unregisteredRoutes = live
    .filter((r) => !declaredKeys.has(routeKey(r)))
    .map((r) => ({ ...r, reason: '(undeclared — add to IN_ROUTES or OUT_ROUTES in entrypoint-registry.ts)' }));

  const staleDeclarations = declared.filter((r) => !liveKeys.has(routeKey(r)));

  const mountedRouterCount = countMountedRouters(app);

  return {
    unregisteredRoutes,
    staleDeclarations,
    mountedRouterCount,
    mountedRouterCountMatchesExpected: mountedRouterCount === EXPECTED_MOUNTED_ROUTER_COUNT,
  };
}
