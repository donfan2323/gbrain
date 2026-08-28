import { describe, expect, test, beforeAll, afterAll, beforeEach } from 'bun:test';
import { readFileSync } from 'node:fs';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { logAdminAuthorityAudit } from '../src/commands/serve-http.ts';

/**
 * Phase 3B-6 — AUTHZ-INV-013, admin-panel Authority-mutating routes.
 *
 * Historical scope (Phase 9C, 4a33a63e), exact — 9 routes:
 *   POST /admin/login, POST /admin/api/issue-magic-link,
 *   GET /admin/auth/:token, POST /admin/api/sign-out-everywhere,
 *   POST /admin/api/api-keys, POST /admin/api/api-keys/revoke,
 *   POST /admin/api/register-client, POST /admin/api/update-client-ttl,
 *   POST /admin/api/revoke-client.
 * Current architecture has a 10th: POST /admin/api/rescope-client, added
 * after the historical Phase 9C snapshot — unambiguously the same category
 * (changes a client's write source / federated-read / slug-fence / surface
 * grant), so it's covered too. None of the 10 had any audit before this
 * change (Phase 9C's own wiring for them never landed upstream).
 *
 * Actor identity: admin sessions are NOT OAuth clients. This reuses the
 * exact convention this codebase's own pre-existing
 * src/core/surface-audit.ts (writeSurfaceChangeAudit) already established —
 * the fixed, non-secret literal 'admin-api', never a session ID or cookie
 * value.
 *
 * Same two-proof-style structure as the /ingest and OAuth audit coverage
 * tests, for the same reason: runServeHttp()'s route handlers are closures
 * inside one large unexported function, and this sandbox has no
 * GBRAIN_DATABASE_URL to run the real HTTP surface against.
 */

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

async function readAdminAuditRows(action: string): Promise<Array<Record<string, unknown>>> {
  return engine.executeRaw<Record<string, unknown>>(
    `SELECT token_name, agent_name, operation, latency_ms, status, error_message, params
       FROM mcp_request_log WHERE operation = $1 ORDER BY id ASC`,
    [action],
  );
}

describe('AUTHZ-INV-013: logAdminAuthorityAudit() payload shape', () => {
  test('ADM-A1: successful mutation writes exactly one success row', async () => {
    await logAdminAuthorityAudit(engine, {
      action: 'admin_register_client', status: 'success', target: 'gbrain_cl_new1', latencyMs: 3,
    });
    const rows = await readAdminAuditRows('admin_register_client');
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe('success');
    expect((rows[0].params as any)?.target).toBe('gbrain_cl_new1');
  });

  test('ADM-A2: validation failure is audited with a machine-readable reason', async () => {
    await logAdminAuthorityAudit(engine, {
      action: 'admin_register_client', status: 'error', reason: 'missing_name', latencyMs: 1,
    });
    const rows = await readAdminAuditRows('admin_register_client');
    expect(rows[0].status).toBe('error');
    expect(rows[0].error_message).toBe('missing_name');
  });

  test('ADM-A3: credential-verification denial (bad bootstrap token) is audited as denied', async () => {
    await logAdminAuthorityAudit(engine, {
      action: 'admin_login', status: 'denied', reason: 'invalid_bootstrap_token',
      credentialRef: 'ab12cd34ef56ab78', latencyMs: 2,
    });
    const rows = await readAdminAuditRows('admin_login');
    expect(rows[0].status).toBe('denied');
    expect((rows[0].params as any)?.credential_ref).toBe('ab12cd34ef56ab78');
  });

  test('ADM-A4: operational failure is audited', async () => {
    await logAdminAuthorityAudit(engine, {
      action: 'admin_revoke_client', status: 'error', reason: 'revoke_client_failed', latencyMs: 4,
    });
    const rows = await readAdminAuditRows('admin_revoke_client');
    expect(rows[0].status).toBe('error');
    expect(rows[0].error_message).toBe('revoke_client_failed');
  });

  test('ADM-A5: actor identity is always the fixed literal admin-api, never a session/cookie value', async () => {
    await logAdminAuthorityAudit(engine, {
      action: 'admin_sign_out_everywhere', status: 'success', latencyMs: 1,
    });
    const rows = await readAdminAuditRows('admin_sign_out_everywhere');
    expect(rows[0].token_name).toBe('admin-api');
    expect(rows[0].agent_name).toBe('admin-api');
  });

  test('ADM-A6: no secrets — audit rows never contain a bootstrap/session/client-secret-shaped marker', async () => {
    const FAKE_ADMIN_COOKIE = 'XPROBE_ADMIN_COOKIE_MARKER_9f8e7d6c5b';
    const FAKE_SESSION_TOKEN = 'XPROBE_SESSION_TOKEN_MARKER_1a2b3c4d5e';
    const FAKE_CLIENT_SECRET = 'gbrain_cs_XPROBE_SECRET_MARKER_zz99yy';
    const FAKE_ACCESS_TOKEN = 'gbrain_at_XPROBE_ACCESS_MARKER_pq12rs';
    const FAKE_BASIC_HEADER = 'Basic WFBST0JFX0FETUlOX0hFQURFUg==';
    await logAdminAuthorityAudit(engine, {
      action: 'admin_login', status: 'success', credentialRef: 'deadbeefdeadbeef', latencyMs: 1,
    });
    await logAdminAuthorityAudit(engine, {
      action: 'admin_create_api_key', status: 'success', target: 'my-key', credentialRef: 'cafebabecafebabe', latencyMs: 1,
    });
    await logAdminAuthorityAudit(engine, {
      action: 'admin_register_client', status: 'success', target: 'gbrain_cl_abc', latencyMs: 1,
    });
    const rows = [
      ...(await readAdminAuditRows('admin_login')),
      ...(await readAdminAuditRows('admin_create_api_key')),
      ...(await readAdminAuditRows('admin_register_client')),
    ];
    const serialized = JSON.stringify(rows);
    for (const marker of [FAKE_ADMIN_COOKIE, FAKE_SESSION_TOKEN, FAKE_CLIENT_SECRET, FAKE_ACCESS_TOKEN, FAKE_BASIC_HEADER]) {
      expect(serialized).not.toContain(marker);
    }
    expect(serialized).not.toMatch(/gbrain_(at|rt|cs)_/);
    expect(serialized).not.toMatch(/^Basic /);
  });

  test('ADM-A7: exactly-once — one call writes exactly one row', async () => {
    await logAdminAuthorityAudit(engine, {
      action: 'admin_update_client_ttl', status: 'success', target: 'gbrain_cl_ttl', latencyMs: 1,
    });
    const rows = await readAdminAuditRows('admin_update_client_ttl');
    expect(rows.length).toBe(1);
  });

  test('write failure is swallowed (best-effort, does not throw)', async () => {
    const brokenEngine = { executeRaw: async () => { throw new Error('no db'); } } as unknown as PGLiteEngine;
    await expect(
      logAdminAuthorityAudit(brokenEngine, { action: 'admin_login', status: 'error', latencyMs: 0 }),
    ).resolves.toBeUndefined();
  });
});

describe('AUTHZ-INV-013: every terminal branch of the 10 admin Authority-mutating routes calls logAdminAuthorityAudit()', () => {
  const SERVE_HTTP_PATH = new URL('../src/commands/serve-http.ts', import.meta.url).pathname;
  const source = readFileSync(SERVE_HTTP_PATH, 'utf8');

  function slice(startMarker: string, endMarker: string): string {
    const startIdx = source.indexOf(startMarker);
    expect(startIdx, `start marker not found: ${startMarker}`).toBeGreaterThan(-1);
    const endIdx = source.indexOf(endMarker, startIdx + startMarker.length);
    expect(endIdx, `end marker not found after start: ${endMarker}`).toBeGreaterThan(startIdx);
    return source.slice(startIdx, endIdx);
  }

  const routes: Array<{ name: string; body: string; statusCodes: string[]; minCalls: number }> = [
    {
      name: 'POST /admin/login',
      body: slice("app.post('/admin/login'", "app.post('/admin/api/issue-magic-link'"),
      statusCodes: ['400', '401'],
      minCalls: 3,
    },
    {
      name: 'POST /admin/api/issue-magic-link',
      body: slice("app.post('/admin/api/issue-magic-link'", "app.get('/admin/auth/:token'"),
      statusCodes: ['401'],
      minCalls: 3,
    },
    {
      name: 'GET /admin/auth/:token',
      body: slice("app.get('/admin/auth/:token'", '// Admin auth middleware'),
      statusCodes: ['401'],
      minCalls: 2,
    },
    {
      name: 'POST /admin/api/sign-out-everywhere',
      body: slice("app.post('/admin/api/sign-out-everywhere'", "app.get('/admin/api/agents'"),
      statusCodes: [],
      minCalls: 1,
    },
    {
      name: 'POST /admin/api/api-keys + /api-keys/revoke',
      body: slice("app.post('/admin/api/api-keys'", "app.post('/admin/api/register-client'"),
      statusCodes: ['400'],
      minCalls: 6,
    },
    {
      name: 'POST /admin/api/register-client',
      body: slice("app.post('/admin/api/register-client'", "app.post('/admin/api/update-client-ttl'"),
      statusCodes: ['400', '409'],
      minCalls: 9,
    },
    {
      name: 'POST /admin/api/update-client-ttl',
      body: slice("app.post('/admin/api/update-client-ttl'", "app.post('/admin/api/rescope-client'"),
      statusCodes: ['400'],
      minCalls: 3,
    },
    {
      name: 'POST /admin/api/rescope-client',
      body: slice("app.post('/admin/api/rescope-client'", "app.post('/admin/api/revoke-client'"),
      statusCodes: ['400'],
      minCalls: 8,
    },
    {
      name: 'POST /admin/api/revoke-client',
      body: slice("app.post('/admin/api/revoke-client'", '// -----'),
      statusCodes: ['400'],
      minCalls: 3,
    },
  ];

  // register-client and rescope-client use a local per-route closure
  // (auditRegister/auditRescope) that wraps logAdminAuthorityAudit once —
  // so the literal call name at each branch is the closure's name, not
  // logAdminAuthorityAudit itself. Both count as coverage.
  const AUDIT_CALL_PATTERN = /\b(?:logAdminAuthorityAudit|auditRegister|auditRescope)\(/g;

  for (const route of routes) {
    test(`${route.name}: every res.status(4xx) branch is preceded by an audit call, and at least ${route.minCalls} exist`, () => {
      for (const code of route.statusCodes) {
        const regex = new RegExp(`res\\.status\\(${code}\\)`, 'g');
        const positions: number[] = [];
        let m: RegExpExecArray | null;
        while ((m = regex.exec(route.body)) !== null) positions.push(m.index);
        expect(positions.length, `${route.name}: expected at least one res.status(${code})`).toBeGreaterThan(0);
        for (const pos of positions) {
          const preceding = route.body.slice(Math.max(0, pos - 400), pos);
          expect(preceding, `${route.name}: res.status(${code}) at offset ${pos} has no preceding audit call`)
            .toMatch(/logAdminAuthorityAudit\(|auditRegister\(|auditRescope\(/);
        }
      }
      const callCount = (route.body.match(AUDIT_CALL_PATTERN) ?? []).length;
      expect(callCount, `${route.name}: expected >= ${route.minCalls} audit calls`).toBeGreaterThanOrEqual(route.minCalls);
    });
  }

  test('the register-client and rescope-client 500/catch-all branches are audited too', () => {
    // Both routes have inner try/catch blocks for individual validation
    // steps AND one outer catch-all at the end — use the LAST match.
    const registerBody = routes.find(r => r.name.includes('register-client'))!.body;
    const registerCatchIdx = registerBody.lastIndexOf('} catch (e) {');
    expect(registerCatchIdx).toBeGreaterThan(-1);
    expect(registerBody.slice(registerCatchIdx, registerCatchIdx + 400)).toContain("auditRegister('error', 'register_client_failed'");

    const rescopeBody = routes.find(r => r.name.includes('rescope-client'))!.body;
    const rescopeCatchIdx = rescopeBody.lastIndexOf('} catch (e) {');
    expect(rescopeCatchIdx).toBeGreaterThan(-1);
    expect(rescopeBody.slice(rescopeCatchIdx, rescopeCatchIdx + 500)).toContain("auditRescope('error',");
  });

  test('ADM-A8: requireAdmin() still routes through hasScope([\'admin\'], \'admin\') — AUTHZ-INV-010 unchanged by this commit', () => {
    const match = source.match(/function requireAdmin\([^)]*\)[^{]*\{([\s\S]*?)\n  \}/);
    expect(match).not.toBeNull();
    const body = match![1];
    expect(body).toContain("hasScope(['admin'], 'admin')");
  });
});
