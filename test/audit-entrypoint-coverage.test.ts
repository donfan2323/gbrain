/**
 * Phase 9C (Universal Audit Event Integration) — registry-vs-live-routes
 * drift detection (`src/core/audit/entrypoint-registry.ts`).
 *
 * Design reference (priority order): PHASE9C-IMPLEMENTATION-SCOPE.md §2-1/
 * §2-2, PHASE9C-ACCEPTANCE-CRITERIA.md §1-2/§3-10.
 *
 * Verifies against the REAL, fully-registered Express `app` instance
 * (`runServeHttp()`'s own `app.router.stack`), not a hand-maintained
 * replica — a replica-based test would only prove the replica is
 * complete, not that production route registration actually matches the
 * registry, which is exactly the drift this file exists to catch.
 * `runServeHttp()` now returns `{ app, httpServer }` (Phase 9C addition,
 * purely additive — its one existing caller already discarded the return
 * value) specifically so this test can get a live app instance without
 * needing to make HTTP requests through an actual listening socket.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runServeHttp } from '../src/commands/serve-http.ts';
import {
  checkEntrypointDrift, enumerateDirectRoutes, countMountedRouters,
  IN_ROUTES, OUT_ROUTES, EXPECTED_MOUNTED_ROUTER_COUNT,
} from '../src/core/audit/entrypoint-registry.ts';

let engine: PGLiteEngine;
let httpServer: import('node:http').Server;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  const started = await runServeHttp(engine, {
    port: 0, // ephemeral — OS assigns a free port, no conflict risk
    tokenTtl: 3600,
    enableDcr: false,
    suppressBootstrapToken: true,
  } as any);
  app = started.app;
  httpServer = started.httpServer;
}, 30_000);

afterAll(async () => {
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  await engine.disconnect();
});

describe('checkEntrypointDrift() against the real, fully-registered serve-http.ts app', () => {
  test('no live, gbrain-owned route is missing from IN_ROUTES or OUT_ROUTES', () => {
    const result = checkEntrypointDrift(app);
    expect(result.unregisteredRoutes).toEqual([]);
  });

  test('the mounted-router count matches EXPECTED_MOUNTED_ROUTER_COUNT (the SDK\'s mcpAuthRouter, and nothing else unaccounted for)', () => {
    const result = checkEntrypointDrift(app);
    expect(result.mountedRouterCount).toBe(EXPECTED_MOUNTED_ROUTER_COUNT);
    expect(result.mountedRouterCountMatchesExpected).toBe(true);
  });

  test('every declared IN/OUT route (excluding the 3 SDK-informational ones) is actually live — the registry is not ahead of the code', () => {
    const result = checkEntrypointDrift(app);
    expect(result.staleDeclarations).toEqual([]);
  });
});

describe('§0(c): the 11 admin GET read-only routes are declared as intentionally-unaudited OUT routes, and match code reality', () => {
  test('all 11 OUT_ADMIN_READONLY_ROUTES paths are live on the real app', async () => {
    const { OUT_ADMIN_READONLY_ROUTES } = await import('../src/core/audit/entrypoint-registry.ts');
    expect(OUT_ADMIN_READONLY_ROUTES.length).toBe(11);
    const live = enumerateDirectRoutes(app);
    const liveKeys = new Set(live.map(r => `${r.method} ${r.path}`));
    for (const route of OUT_ADMIN_READONLY_ROUTES) {
      expect(liveKeys.has(`${route.method} ${route.path}`)).toBe(true);
    }
  });

  test('none of the 11 admin GET read-only routes appear in IN_ROUTES (mutually exclusive declaration)', async () => {
    const { OUT_ADMIN_READONLY_ROUTES } = await import('../src/core/audit/entrypoint-registry.ts');
    const inKeys = new Set(IN_ROUTES.map(r => `${r.method} ${r.path}`));
    for (const route of OUT_ADMIN_READONLY_ROUTES) {
      expect(inKeys.has(`${route.method} ${route.path}`)).toBe(false);
    }
  });
});

describe('IN_ROUTES declares exactly the 6 audited entrypoint categories (submit_agent excluded — not an HTTP route)', () => {
  test('IN_ROUTES contains /mcp, /mcp-v2, /ingest, /token, /revoke, /webhooks/github, and the 9 admin Authority routes', () => {
    const paths = IN_ROUTES.map(r => r.path);
    for (const expected of [
      '/mcp', '/mcp-v2', '/ingest', '/token', '/revoke', '/webhooks/github',
      '/admin/login', '/admin/auth/:token', '/admin/api/issue-magic-link',
      '/admin/api/sign-out-everywhere', '/admin/api/api-keys', '/admin/api/api-keys/revoke',
      '/admin/api/register-client', '/admin/api/update-client-ttl', '/admin/api/revoke-client',
    ]) {
      expect(paths).toContain(expected);
    }
  });

  test('the 9 admin Authority-changing routes are exactly 9, matching PHASE9C-IMPLEMENTATION-SCOPE.md IN-4', () => {
    const adminInRoutes = IN_ROUTES.filter(r => r.path.startsWith('/admin'));
    expect(adminInRoutes.length).toBe(9);
  });
});

describe('drift detection actually works (the check itself is exercised, not vacuously green)', () => {
  test('an undeclared route on a synthetic app is flagged as unregistered', () => {
    const syntheticApp = {
      router: {
        stack: [
          {
            route: { path: '/totally-new-undeclared-route', methods: { get: true } },
          },
        ],
      },
    };
    const result = checkEntrypointDrift(syntheticApp as any);
    expect(result.unregisteredRoutes.length).toBe(1);
    expect(result.unregisteredRoutes[0].path).toBe('/totally-new-undeclared-route');
    expect(result.unregisteredRoutes[0].method).toBe('GET');
  });

  test('a declared route with no live counterpart is flagged as stale', () => {
    const emptyApp = { router: { stack: [] } };
    const result = checkEntrypointDrift(emptyApp as any);
    // Every declared IN/OUT route (minus the 3 SDK-informational ones) is
    // stale against an app with zero registered routes.
    expect(result.staleDeclarations.length).toBeGreaterThan(0);
  });

  test('an extra mounted router is caught by the count check', () => {
    const syntheticApp = {
      router: {
        stack: [
          { name: 'router', handle: { stack: [] } },
          { name: 'router', handle: { stack: [] } }, // 2, not the expected 1
        ],
      },
    };
    const result = checkEntrypointDrift(syntheticApp as any);
    expect(result.mountedRouterCount).toBe(2);
    expect(result.mountedRouterCountMatchesExpected).toBe(false);
  });

  test('countMountedRouters() ignores direct routes and only counts sub-router layers', () => {
    const syntheticApp = {
      router: {
        stack: [
          { route: { path: '/x', methods: { get: true } } }, // a direct route, not a router
          { name: 'router', handle: { stack: [] } },
        ],
      },
    };
    expect(countMountedRouters(syntheticApp as any)).toBe(1);
  });
});

describe('enumerateDirectRoutes(): array-form multi-path route registration is expanded correctly', () => {
  test('/mcp and /mcp-v2 (registered via app.get([\'/mcp\',\'/mcp-v2\'], ...)) both appear as separate GET entries on the real app', () => {
    const live = enumerateDirectRoutes(app);
    const getPaths = live.filter(r => r.method === 'GET').map(r => r.path);
    expect(getPaths).toContain('/mcp');
    expect(getPaths).toContain('/mcp-v2');
  });

  test('/mcp and /mcp-v2 both appear as separate POST entries too', () => {
    const live = enumerateDirectRoutes(app);
    const postPaths = live.filter(r => r.method === 'POST').map(r => r.path);
    expect(postPaths).toContain('/mcp');
    expect(postPaths).toContain('/mcp-v2');
  });
});
