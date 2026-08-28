import { describe, expect, test, beforeAll, afterAll, beforeEach } from 'bun:test';
import { readFileSync } from 'node:fs';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { extractSdkOAuthErrorCode, logSdkOAuthFallbackAudit } from '../src/commands/serve-http.ts';

/**
 * Phase 3B-8 — AUTHZ-INV-013, MCP SDK's own POST /token and POST /revoke
 * handlers (reached only by public/PKCE clients — confidential clients are
 * fully handled, and already audited, by this file's own custom handlers,
 * Phase 3B-5).
 *
 * Historical note: Phase 9C explicitly deferred instrumenting ANY SDK-owned
 * OAuth surface (its own implementation report names this exact gap as a
 * non-goal, dashboard-4xj73) — there is no historical actor/redaction
 * precedent to port here. The interception TECHNIQUE (rebinding res.json
 * on a middleware registered before the SDK router mount) is not new to
 * this codebase, though — it mirrors the pre-existing OAuth-metadata-
 * patching middleware in the same file.
 *
 * GET/POST /authorize is deliberately NOT covered — its grant/deny outcome
 * is signaled exclusively via res.redirect() to a URL that embeds the
 * authorization code (success) or an error code (denial) in the query
 * string itself. There is no status-code-only or body-only discriminator
 * the way there is for /token and /revoke; classifying it would require
 * inspecting a URL containing a live credential. See the accompanying
 * report's full feasibility findings.
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

async function readSdkFallbackAuditRows(operation: string): Promise<Array<Record<string, unknown>>> {
  return engine.executeRaw<Record<string, unknown>>(
    `SELECT token_name, agent_name, operation, latency_ms, status, error_message, params
       FROM mcp_request_log WHERE operation = $1 ORDER BY id ASC`,
    [operation],
  );
}

describe('extractSdkOAuthErrorCode() — the security-critical body-inspection decision, in isolation', () => {
  test('a 2xx status never yields an error code, even if the body looks like an error object', () => {
    expect(extractSdkOAuthErrorCode(200, { error: 'should_never_be_read' })).toBeNull();
    expect(extractSdkOAuthErrorCode(201, { access_token: 'gbrain_at_realtoken', error: 'x' })).toBeNull();
  });

  test('a 2xx body containing real token-shaped fields is never touched at all — function returns null without inspecting those fields', () => {
    const tokenBody = {
      access_token: 'gbrain_at_XPROBE_REAL_ACCESS_TOKEN_VALUE',
      refresh_token: 'gbrain_rt_XPROBE_REAL_REFRESH_TOKEN_VALUE',
      token_type: 'Bearer',
      expires_in: 3600,
    };
    expect(extractSdkOAuthErrorCode(200, tokenBody)).toBeNull();
  });

  test('a non-2xx status with a standard {error, error_description} body yields ONLY the error field', () => {
    const result = extractSdkOAuthErrorCode(400, { error: 'invalid_grant', error_description: 'the authorization code has expired' });
    expect(result).toBe('invalid_grant');
  });

  test('error_description and error_uri are never returned, even if present', () => {
    const result = extractSdkOAuthErrorCode(401, {
      error: 'invalid_client',
      error_description: 'XPROBE_SHOULD_NEVER_APPEAR_IN_RESULT',
      error_uri: 'https://XPROBE_SHOULD_NEVER_APPEAR.example',
    });
    expect(result).toBe('invalid_client');
    expect(result).not.toContain('XPROBE');
  });

  test('malformed/non-object/array/null bodies degrade to null rather than throwing', () => {
    expect(extractSdkOAuthErrorCode(400, null)).toBeNull();
    expect(extractSdkOAuthErrorCode(400, undefined)).toBeNull();
    expect(extractSdkOAuthErrorCode(400, 'a raw string body')).toBeNull();
    expect(extractSdkOAuthErrorCode(400, ['array', 'body'])).toBeNull();
    expect(extractSdkOAuthErrorCode(400, { error: 12345 })).toBeNull(); // non-string error field
    expect(extractSdkOAuthErrorCode(400, {})).toBeNull();
  });
});

describe('AUTHZ-INV-013: logSdkOAuthFallbackAudit() payload shape and classification', () => {
  test('a 200 status is classified success, with no reason', async () => {
    await logSdkOAuthFallbackAudit(engine, { endpoint: 'token', statusCode: 200, latencyMs: 3 });
    const rows = await readSdkFallbackAuditRows('oauth_token_sdk_fallback');
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe('success');
    expect(rows[0].error_message).toBeNull();
  });

  test('invalid_client/invalid_grant/access_denied/unauthorized_client classify as denied', async () => {
    for (const code of ['invalid_client', 'invalid_grant', 'access_denied', 'unauthorized_client']) {
      await logSdkOAuthFallbackAudit(engine, { endpoint: 'token', statusCode: 400, errorCode: code, latencyMs: 1 });
    }
    const rows = await readSdkFallbackAuditRows('oauth_token_sdk_fallback');
    expect(rows.every(r => r.status === 'denied')).toBe(true);
  });

  test('invalid_request/unsupported_grant_type/server_error classify as error, not denied', async () => {
    for (const code of ['invalid_request', 'unsupported_grant_type', 'server_error']) {
      await logSdkOAuthFallbackAudit(engine, { endpoint: 'revoke', statusCode: 400, errorCode: code, latencyMs: 1 });
    }
    const rows = await readSdkFallbackAuditRows('oauth_revoke_sdk_fallback');
    expect(rows.every(r => r.status === 'error')).toBe(true);
  });

  test('actor is always the fixed literal oauth-sdk-fallback, never a client_id or session value', async () => {
    await logSdkOAuthFallbackAudit(engine, { endpoint: 'token', statusCode: 200, latencyMs: 1 });
    const rows = await readSdkFallbackAuditRows('oauth_token_sdk_fallback');
    expect(rows[0].token_name).toBe('oauth-sdk-fallback');
    expect(rows[0].agent_name).toBe('oauth-sdk-fallback');
  });

  test('params is always null — no target/client identifier is ever recorded for this surface', async () => {
    await logSdkOAuthFallbackAudit(engine, { endpoint: 'revoke', statusCode: 200, latencyMs: 1 });
    const rows = await readSdkFallbackAuditRows('oauth_revoke_sdk_fallback');
    expect(rows[0].params).toBeNull();
  });

  test('exactly-once: one call writes exactly one row', async () => {
    await logSdkOAuthFallbackAudit(engine, { endpoint: 'token', statusCode: 200, latencyMs: 1 });
    const rows = await readSdkFallbackAuditRows('oauth_token_sdk_fallback');
    expect(rows.length).toBe(1);
  });

  test('no secrets — full-text search for token/secret-shaped markers finds nothing', async () => {
    await logSdkOAuthFallbackAudit(engine, { endpoint: 'token', statusCode: 200, latencyMs: 1 });
    await logSdkOAuthFallbackAudit(engine, { endpoint: 'token', statusCode: 400, errorCode: 'invalid_grant', latencyMs: 1 });
    await logSdkOAuthFallbackAudit(engine, { endpoint: 'revoke', statusCode: 200, latencyMs: 1 });
    const rows = [
      ...(await readSdkFallbackAuditRows('oauth_token_sdk_fallback')),
      ...(await readSdkFallbackAuditRows('oauth_revoke_sdk_fallback')),
    ];
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toMatch(/gbrain_(at|rt|cl|cs|code)_/);
    expect(serialized).not.toMatch(/^Basic /);
    expect(serialized).not.toMatch(/Bearer\s/);
  });

  test('Phase 12 secret-leak proof: adversarial response bodies with a full sentinel matrix (client secret, Authorization header, bearer token, authorization code, PKCE verifier, access token, refresh token, cookie/session, raw-body and query-string markers, client_id) — 0 occurrences in any persisted row', async () => {
    const SENTINELS = {
      client_secret: 'XPROBE_CLIENT_SECRET_9f8e7d6c5b4a3f2e1d0c',
      authorization_header: 'Basic XPROBE_BASIC_AUTH_B64_MARKER==',
      bearer_token: 'Bearer XPROBE_BEARER_TOKEN_MARKER_zzz111',
      authorization_code: 'XPROBE_AUTH_CODE_MARKER_abc123def456',
      pkce_verifier: 'XPROBE_PKCE_CODE_VERIFIER_MARKER_9988776655',
      access_token: 'gbrain_at_XPROBE_ACCESS_TOKEN_MARKER',
      refresh_token: 'gbrain_rt_XPROBE_REFRESH_TOKEN_MARKER',
      cookie_session: 'session=XPROBE_COOKIE_SESSION_MARKER_qqq999',
      request_body_sentinel: 'XPROBE_RAW_REQUEST_BODY_MARKER_zzzyyyxxx',
      query_string_sentinel: 'XPROBE_QUERY_STRING_MARKER_wwwvvvuuu',
      client_id_sentinel: 'XPROBE_CLIENT_ID_MARKER_mnbvcxz',
    };

    // Legitimate 2xx token-issuance body — genuinely contains real credentials.
    // extractSdkOAuthErrorCode must return null WITHOUT inspecting any field.
    const successBody = {
      access_token: SENTINELS.access_token,
      refresh_token: SENTINELS.refresh_token,
      token_type: 'Bearer',
      expires_in: 3600,
    };
    await logSdkOAuthFallbackAudit(engine, {
      endpoint: 'token', statusCode: 200, errorCode: extractSdkOAuthErrorCode(200, successBody), latencyMs: 5,
    });

    // Worst-case denial body: error_description/error_uri echo back secrets,
    // as a real SDK might when reflecting malformed request parameters.
    const denialBody = {
      error: 'invalid_grant',
      error_description: `code ${SENTINELS.authorization_code} verifier ${SENTINELS.pkce_verifier} expired`,
      error_uri: `https://example.com/errors?client_secret=${SENTINELS.client_secret}&query=${SENTINELS.query_string_sentinel}`,
    };
    await logSdkOAuthFallbackAudit(engine, {
      endpoint: 'token', statusCode: 400, errorCode: extractSdkOAuthErrorCode(400, denialBody), latencyMs: 3,
    });

    // Adversarial body with cookie/session/authorization/client_id sentinels
    // in unexpected top-level fields (simulating a hostile or buggy upstream).
    const revokeBody = {
      error: 'unauthorized_client',
      cookie: SENTINELS.cookie_session,
      authorization: SENTINELS.authorization_header,
      bearer: SENTINELS.bearer_token,
      raw_body: SENTINELS.request_body_sentinel,
      client_id: SENTINELS.client_id_sentinel,
    };
    await logSdkOAuthFallbackAudit(engine, {
      endpoint: 'revoke', statusCode: 401, errorCode: extractSdkOAuthErrorCode(401, revokeBody), latencyMs: 2,
    });

    const rows = [
      ...(await readSdkFallbackAuditRows('oauth_token_sdk_fallback')),
      ...(await readSdkFallbackAuditRows('oauth_revoke_sdk_fallback')),
    ];
    const serialized = JSON.stringify(rows);
    for (const [name, value] of Object.entries(SENTINELS)) {
      expect(serialized, `sentinel leaked: ${name}`).not.toContain(value);
    }
  });

  test('write failure is swallowed (best-effort, does not throw)', async () => {
    const brokenEngine = { executeRaw: async () => { throw new Error('no db'); } } as unknown as PGLiteEngine;
    await expect(
      logSdkOAuthFallbackAudit(brokenEngine, { endpoint: 'token', statusCode: 500, latencyMs: 0 }),
    ).resolves.toBeUndefined();
  });
});

describe('AUTHZ-INV-013: SDK-fallback middleware wiring and double-audit prevention', () => {
  const SERVE_HTTP_PATH = new URL('../src/commands/serve-http.ts', import.meta.url).pathname;
  const source = readFileSync(SERVE_HTTP_PATH, 'utf8');

  test('the interception middleware is registered before app.use(authRouter)', () => {
    const mwIdx = source.indexOf("req.path === '/token' || req.path === '/revoke'");
    const mountIdx = source.indexOf('app.use(authRouter);');
    expect(mwIdx).toBeGreaterThan(-1);
    expect(mountIdx).toBeGreaterThan(-1);
    expect(mwIdx).toBeLessThan(mountIdx);
  });

  test('the middleware wraps res.json and calls logSdkOAuthFallbackAudit + extractSdkOAuthErrorCode', () => {
    const mwIdx = source.indexOf("req.path === '/token' || req.path === '/revoke'");
    const mwBlock = source.slice(mwIdx, mwIdx + 1200);
    expect(mwBlock).toContain('res.json');
    expect(mwBlock).toContain('logSdkOAuthFallbackAudit(');
    expect(mwBlock).toContain('extractSdkOAuthErrorCode(');
  });

  test('the middleware never references req.body, req.headers, or req.query — only req.path', () => {
    const mwIdx = source.indexOf("app.use((req, res, next) => {\n    if (req.path === '/token'");
    expect(mwIdx).toBeGreaterThan(-1);
    const endIdx = source.indexOf('app.use(authRouter);', mwIdx);
    const mwBlock = source.slice(mwIdx, endIdx);
    expect(mwBlock).not.toMatch(/req\.body/);
    expect(mwBlock).not.toMatch(/req\.headers/);
    expect(mwBlock).not.toMatch(/req\.query/);
    expect(mwBlock).not.toMatch(/req\.cookies/);
  });

  test('double-audit prevention: every branch of the custom client_credentials /token handler either responds-and-returns or calls next() before any response is sent', () => {
    const startIdx = source.indexOf("app.post('/token', ccRateLimiter, express.urlencoded");
    const endIdx = source.indexOf("app.post('/token', ccRateLimiter, async (req, res, next)", startIdx);
    const body = source.slice(startIdx, endIdx);
    // The ONLY next() call must precede any res.status/res.json/logOAuthCredentialAudit call.
    const nextIdx = body.indexOf('return next();');
    const firstAuditIdx = body.indexOf('logOAuthCredentialAudit(');
    expect(nextIdx).toBeGreaterThan(-1);
    expect(firstAuditIdx).toBeGreaterThan(nextIdx);
  });

  test('double-audit prevention: the confidential authorization_code/refresh_token /token handler falls through via next() only before any secret is resolved, and audits (not next()) after', () => {
    const startIdx = source.indexOf("app.post('/token', ccRateLimiter, async (req, res, next)");
    const endIdx = source.indexOf("app.post('/revoke', ccRateLimiter, express.urlencoded", startIdx);
    const body = source.slice(startIdx, endIdx);
    const nextCalls: number[] = [];
    let m: RegExpExecArray | null;
    const regex = /return next\(\);/g;
    while ((m = regex.exec(body)) !== null) nextCalls.push(m.index);
    expect(nextCalls.length).toBe(2); // grant-type mismatch, and no-secret (public client) fallthrough
    const firstAuditIdx = body.indexOf('logOAuthCredentialAudit(');
    expect(firstAuditIdx).toBeGreaterThan(-1);
    // Every next() call happens before the first audit call in source order —
    // i.e. no path both falls through AND has already audited.
    for (const idx of nextCalls) {
      expect(idx).toBeLessThan(firstAuditIdx);
    }
  });

  test('double-audit prevention: the confidential /revoke handler has exactly one next() fallthrough, and it is a bare, unconditional return with no audit call in the same statement', () => {
    const startIdx = source.indexOf("app.post('/revoke', ccRateLimiter, express.urlencoded");
    const endIdx = source.indexOf('MCP SDK Auth Router', startIdx);
    const body = source.slice(startIdx, endIdx);
    const nextCalls: number[] = [];
    let m: RegExpExecArray | null;
    const regex = /return next\(\);/g;
    while ((m = regex.exec(body)) !== null) nextCalls.push(m.index);
    expect(nextCalls.length).toBe(1);
    // The exact, known-safe shape: a single-line, unconditional fallthrough
    // for the "no secret presented" (public client) case — not reachable
    // from any branch that already audited, since it's the ONLY statement
    // in its own if-block (verified against the real source directly:
    // `if (!clientId || !presentedSecret) return next();`).
    expect(body).toContain('if (!clientId || !presentedSecret) return next();');
    // Confirm this exact line is not itself inside a block that also
    // contains an audit call (i.e. it's genuinely a single bare statement,
    // not `{ await logOAuthCredentialAudit(...); return next(); }`).
    const lineIdx = body.indexOf('if (!clientId || !presentedSecret) return next();');
    const line = body.slice(lineIdx, body.indexOf('\n', lineIdx));
    expect(line).not.toContain('logOAuthCredentialAudit');
  });
});
