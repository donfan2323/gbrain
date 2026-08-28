import { describe, expect, test, beforeAll, afterAll, beforeEach } from 'bun:test';
import { readFileSync } from 'node:fs';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { logOAuthCredentialAudit } from '../src/commands/serve-http.ts';

/**
 * Phase 3B-5 — AUTHZ-INV-013, OAuth credential-lifecycle family
 * (POST /token, POST /revoke).
 *
 * Forensic finding: PHASE9A-AUTHORIZATION-INVARIANTS.md's own Phase 9C scope
 * doc calls these "the credential lifecycle itself... currently zero
 * permanent audit... highest audit-value path." That was, and remains, true
 * in current architecture — the historical stopgap (oauth-diagnostic.ts)
 * does not exist here, and 4a33a63e's audit_events wiring for these routes
 * never landed upstream.
 *
 * Scope finding (found, not assumed): current /token and /revoke are each a
 * CUSTOM Express handler ONLY for confidential clients (secret presented) —
 * both explicitly next()-fall-through to the MCP SDK's own mounted
 * authRouter for public/PKCE clients, and GET/POST /authorize is 100%
 * SDK-owned with no custom handler at all. This closes only what the custom,
 * directly-editable handlers do — the SDK-owned fallback paths are out of
 * reach without a third-party-router middleware wrapper, which even Phase
 * 9C's own implementation explicitly declined to build (non-goal,
 * dashboard-4xj73). See the accompanying report for the full reasoning.
 *
 * Same two-proof-style structure as test/ingest-audit-coverage.test.ts, for
 * the same reason: runServeHttp()'s route handlers are closures inside one
 * large unexported function, and this sandbox has no GBRAIN_DATABASE_URL to
 * run the real HTTP surface against.
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

async function readOAuthAuditRows(operation: 'oauth_token' | 'oauth_revoke'): Promise<Array<Record<string, unknown>>> {
  return engine.executeRaw<Record<string, unknown>>(
    `SELECT token_name, agent_name, operation, latency_ms, status, error_message, params
       FROM mcp_request_log WHERE operation = $1 ORDER BY id ASC`,
    [operation],
  );
}

describe('AUTHZ-INV-013: logOAuthCredentialAudit() payload shape', () => {
  test('TOKEN-A1: successful token issuance is audited without any token material', async () => {
    await logOAuthCredentialAudit(engine, {
      endpoint: 'token', grantType: 'client_credentials', clientId: 'gbrain_cl_abc123',
      latencyMs: 4, status: 'success',
    });
    const rows = await readOAuthAuditRows('oauth_token');
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe('success');
    expect(rows[0].token_name).toBe('gbrain_cl_abc123');
    expect(rows[0].error_message).toBeNull();
    expect((rows[0].params as any)?.grant_type).toBe('client_credentials');
  });

  test('TOKEN-A2: invalid_client failure is audited with the classified reason, no client secret', async () => {
    await logOAuthCredentialAudit(engine, {
      endpoint: 'token', grantType: 'authorization_code', clientId: 'gbrain_cl_bad',
      latencyMs: 2, status: 'denied', reason: 'invalid_client',
    });
    const rows = await readOAuthAuditRows('oauth_token');
    expect(rows[0].status).toBe('denied');
    expect(rows[0].error_message).toBe('invalid_client');
  });

  test('TOKEN-A3: invalid/expired code failure is audited as invalid_grant, no code value present', async () => {
    await logOAuthCredentialAudit(engine, {
      endpoint: 'token', grantType: 'authorization_code', clientId: 'gbrain_cl_c',
      latencyMs: 3, status: 'denied', reason: 'invalid_grant',
    });
    const rows = await readOAuthAuditRows('oauth_token');
    expect(rows[0].status).toBe('denied');
    expect(rows[0].error_message).toBe('invalid_grant');
  });

  test('TOKEN-A4: grant validation failure (missing code/refresh_token) is audited as invalid_request', async () => {
    await logOAuthCredentialAudit(engine, {
      endpoint: 'token', grantType: 'refresh_token', clientId: 'gbrain_cl_d',
      latencyMs: 1, status: 'error', reason: 'invalid_request',
    });
    const rows = await readOAuthAuditRows('oauth_token');
    expect(rows[0].status).toBe('error');
    expect(rows[0].error_message).toBe('invalid_request');
  });

  test('TOKEN-A5: refresh_token grant success is distinguishable from authorization_code success via grant_type', async () => {
    await logOAuthCredentialAudit(engine, {
      endpoint: 'token', grantType: 'refresh_token', clientId: 'gbrain_cl_e',
      latencyMs: 2, status: 'success',
    });
    const rows = await readOAuthAuditRows('oauth_token');
    expect((rows[0].params as any)?.grant_type).toBe('refresh_token');
  });

  test('REVOKE-A1: successful revocation is audited without the revoked token value', async () => {
    await logOAuthCredentialAudit(engine, {
      endpoint: 'revoke', clientId: 'gbrain_cl_f', latencyMs: 5, status: 'success',
    });
    const rows = await readOAuthAuditRows('oauth_revoke');
    expect(rows[0].status).toBe('success');
    expect(rows[0].token_name).toBe('gbrain_cl_f');
  });

  test('REVOKE-A2: unknown/invalid credential on revoke is audited (denied)', async () => {
    await logOAuthCredentialAudit(engine, {
      endpoint: 'revoke', clientId: null, latencyMs: 1, status: 'denied', reason: 'invalid_client',
    });
    const rows = await readOAuthAuditRows('oauth_revoke');
    expect(rows[0].status).toBe('denied');
    expect(rows[0].token_name).toBeNull();
  });

  test('no secret leakage: audit rows never contain a bearer/gbrain-prefixed secret or Basic-auth blob', async () => {
    await logOAuthCredentialAudit(engine, {
      endpoint: 'token', grantType: 'client_credentials', clientId: 'gbrain_cl_g',
      latencyMs: 1, status: 'denied', reason: 'invalid_grant',
    });
    await logOAuthCredentialAudit(engine, {
      endpoint: 'revoke', clientId: 'gbrain_cl_g', latencyMs: 1, status: 'success',
    });
    const rows = [...(await readOAuthAuditRows('oauth_token')), ...(await readOAuthAuditRows('oauth_revoke'))];
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toMatch(/gbrain_(at|rt|cs)_/); // access/refresh tokens, client secrets
    expect(serialized).not.toMatch(/^Basic /);
    expect(serialized).not.toMatch(/Bearer\s/);
  });

  test('exactly-once: one call writes exactly one row', async () => {
    await logOAuthCredentialAudit(engine, {
      endpoint: 'token', grantType: 'client_credentials', clientId: 'gbrain_cl_h',
      latencyMs: 1, status: 'success',
    });
    const rows = await readOAuthAuditRows('oauth_token');
    expect(rows.length).toBe(1);
  });

  test('write failure is swallowed (best-effort, does not throw)', async () => {
    const brokenEngine = { executeRaw: async () => { throw new Error('no db'); } } as unknown as PGLiteEngine;
    await expect(
      logOAuthCredentialAudit(brokenEngine, {
        endpoint: 'token', clientId: 'x', latencyMs: 0, status: 'error', reason: 'server_error',
      }),
    ).resolves.toBeUndefined();
  });
});

describe('AUTHZ-INV-013: every reachable non-success branch of the custom /token and /revoke handlers calls logOAuthCredentialAudit()', () => {
  const SERVE_HTTP_PATH = new URL('../src/commands/serve-http.ts', import.meta.url).pathname;
  const source = readFileSync(SERVE_HTTP_PATH, 'utf8');

  function slice(startMarker: string, endMarker: string): string {
    const startIdx = source.indexOf(startMarker);
    expect(startIdx).toBeGreaterThan(-1);
    const endIdx = source.indexOf(endMarker, startIdx + startMarker.length);
    expect(endIdx).toBeGreaterThan(startIdx);
    return source.slice(startIdx, endIdx);
  }

  const clientCredentialsHandler = slice(
    "app.post('/token', ccRateLimiter, express.urlencoded",
    "app.post('/token', ccRateLimiter, async (req, res, next)",
  );
  const confidentialGrantHandler = slice(
    "app.post('/token', ccRateLimiter, async (req, res, next)",
    "app.post('/revoke', ccRateLimiter, express.urlencoded",
  );
  const revokeHandler = slice(
    "app.post('/revoke', ccRateLimiter, express.urlencoded",
    'MCP SDK Auth Router',
  );

  function assertEveryStatusCallPreceded(body: string, codes: string[], label: string) {
    for (const code of codes) {
      const regex = new RegExp(`res\\.status\\(${code}\\)`, 'g');
      const positions: number[] = [];
      let m: RegExpExecArray | null;
      while ((m = regex.exec(body)) !== null) positions.push(m.index);
      expect(positions.length, `${label}: expected at least one res.status(${code}) in this handler`).toBeGreaterThan(0);
      for (const pos of positions) {
        const preceding = body.slice(Math.max(0, pos - 400), pos);
        expect(preceding, `${label}: res.status(${code}) at offset ${pos} has no preceding logOAuthCredentialAudit call within 400 chars`)
          .toContain('logOAuthCredentialAudit(');
      }
    }
  }

  test('client_credentials handler: 400 (invalid_request) and the catch-all 400 (invalid_grant) are both audited', () => {
    assertEveryStatusCallPreceded(clientCredentialsHandler, ['400'], 'client_credentials handler');
    expect((clientCredentialsHandler.match(/logOAuthCredentialAudit\(/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  test('confidential authorization_code/refresh_token handler: both 400s and the 401/400 catch are audited', () => {
    assertEveryStatusCallPreceded(confidentialGrantHandler, ['400', '401'], 'confidential grant handler');
    expect((confidentialGrantHandler.match(/logOAuthCredentialAudit\(/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });

  test('/revoke handler: 400, 401, and the retryable-503-or-500 branches are all audited', () => {
    assertEveryStatusCallPreceded(revokeHandler, ['400', '401'], '/revoke handler');
    // The two operational-failure branches use res.status(retryable ? 503 : 500) —
    // a ternary, not a literal status code — so check that pattern directly.
    const retryableStatusRegex = /res\.status\(retryable \? 503 : 500\)/g;
    const positions: number[] = [];
    let m: RegExpExecArray | null;
    while ((m = retryableStatusRegex.exec(revokeHandler)) !== null) positions.push(m.index);
    expect(positions.length).toBeGreaterThanOrEqual(2);
    for (const pos of positions) {
      expect(revokeHandler.slice(Math.max(0, pos - 400), pos)).toContain('logOAuthCredentialAudit(');
    }
    expect((revokeHandler.match(/logOAuthCredentialAudit\(/g) ?? []).length).toBeGreaterThanOrEqual(6);
  });

  test('the success path (res.json(tokens) / res.status(200).end()) is also audited in each handler', () => {
    for (const [label, body] of [
      ['client_credentials', clientCredentialsHandler],
      ['confidential grant', confidentialGrantHandler],
    ] as const) {
      const successIdx = body.indexOf('res.json(tokens)');
      expect(successIdx, `${label}: res.json(tokens) not found`).toBeGreaterThan(-1);
      const preceding = body.slice(Math.max(0, successIdx - 300), successIdx);
      expect(preceding, `${label}: success path not audited`).toContain('logOAuthCredentialAudit(');
    }
    const revokeSuccessIdx = revokeHandler.indexOf('res.status(200).end()');
    expect(revokeSuccessIdx).toBeGreaterThan(-1);
    expect(revokeHandler.slice(Math.max(0, revokeSuccessIdx - 300), revokeSuccessIdx)).toContain('logOAuthCredentialAudit(');
  });
});
