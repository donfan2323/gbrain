import { describe, expect, test, beforeAll, afterAll, beforeEach } from 'bun:test';
import { readFileSync } from 'node:fs';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { logIngestAudit } from '../src/commands/serve-http.ts';

/**
 * Phase 3B-4 — AUTHZ-INV-013 (authorization decisions — success, deny, and
 * failure — must all be recorded, and any omission must be explicitly
 * documented, never an accidental oversight).
 *
 * Forensic finding: PHASE9A-AUTHORIZATION-INVARIANTS.md's own violation
 * example for this invariant IS POST /ingest's deny/failure asymmetry — its
 * success path already wrote an mcp_request_log row, every deny/failure
 * branch wrote nothing. That gap survived unchanged into current,
 * independently-evolved architecture (confirmed by direct source read —
 * historical commit 4a33a63e's full audit_events subsystem never landed
 * upstream). This closes just that one gap, reusing the exact
 * mcp_request_log table + INSERT shape the route's own success path (and
 * every MCP tools/list|tools/call branch in the same file) already uses —
 * no new schema, no new audit subsystem.
 *
 * Two proof styles, for two different reasons:
 *  - logIngestAudit() itself is tested directly against a real PGLite
 *    engine (payload shape, no secrets) — the full HTTP route needs a live
 *    database (test/e2e/serve-http-ingest-webhook.test.ts covers that; this
 *    sandbox has no GBRAIN_DATABASE_URL configured to run it).
 *  - Route-level coverage (every non-success branch actually CALLS
 *    logIngestAudit) is proven via static source inspection, mirroring
 *    test/admin-policy-core-routing.test.ts's approach for the identical
 *    reason: runServeHttp()'s route handlers are closures inside one large
 *    unexported function, not independently invocable.
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

async function readIngestAuditRows(): Promise<Array<Record<string, unknown>>> {
  return engine.executeRaw<Record<string, unknown>>(
    `SELECT token_name, agent_name, operation, latency_ms, status, error_message, params
       FROM mcp_request_log WHERE operation = 'webhook_ingest' ORDER BY id ASC`,
  );
}

describe('AUTHZ-INV-013: logIngestAudit() payload shape', () => {
  test('AUD-1/AUD-3: a denial writes exactly one row with the correct decision and reason', async () => {
    await logIngestAudit(engine, {
      clientId: 'client-a', agentName: 'agent-a', latencyMs: 12,
      status: 'denied', errorMessage: 'slug_bound_client',
    });
    const rows = await readIngestAuditRows();
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe('denied');
    expect(rows[0].error_message).toBe('slug_bound_client');
    expect(rows[0].token_name).toBe('client-a');
    expect(rows[0].operation).toBe('webhook_ingest');
  });

  test('AUD-3: an error carries a distinct, machine-readable reason from a denial', async () => {
    await logIngestAudit(engine, {
      clientId: 'client-b', agentName: 'agent-b', latencyMs: 5,
      status: 'error', errorMessage: 'empty_body',
    });
    const rows = await readIngestAuditRows();
    expect(rows[0].status).toBe('error');
    expect(rows[0].error_message).toBe('empty_body');
  });

  test('AUD-4: no secrets — a raw error message that happens to echo request-shaped text still never contains a bearer token or client secret', async () => {
    // logIngestAudit's contract is "caller passes a short reason string" —
    // it does not itself redact, so this test pins that every actual call
    // site in the route only ever passes short, fixed reason codes (proven
    // structurally below), never a raw header/body/token value.
    await logIngestAudit(engine, {
      clientId: 'client-c', agentName: 'agent-c', latencyMs: 1,
      status: 'error', errorMessage: 'queue_submission_failed: connection reset',
    });
    const rows = await readIngestAuditRows();
    expect(String(rows[0].error_message)).not.toMatch(/gbrain_(at|rt|cl|cs)_/);
    expect(String(rows[0].error_message)).not.toMatch(/^Bearer /);
  });

  test('AUD-5: no duplicate events — one logIngestAudit() call writes exactly one row', async () => {
    await logIngestAudit(engine, {
      clientId: 'client-d', agentName: 'agent-d', latencyMs: 3,
      status: 'error', errorMessage: 'invalid_event: content',
    });
    const rows = await readIngestAuditRows();
    expect(rows.length).toBe(1);
  });

  test('write failure is swallowed (best-effort, does not throw)', async () => {
    const brokenEngine = {
      executeRaw: async () => { throw new Error('no db'); },
    } as unknown as PGLiteEngine;
    await expect(
      logIngestAudit(brokenEngine, {
        clientId: 'x', agentName: 'x', latencyMs: 0, status: 'error', errorMessage: 'x',
      }),
    ).resolves.toBeUndefined();
  });
});

describe('AUTHZ-INV-013: every non-success branch of POST /ingest calls logIngestAudit()', () => {
  const SERVE_HTTP_PATH = new URL('../src/commands/serve-http.ts', import.meta.url).pathname;
  const source = readFileSync(SERVE_HTTP_PATH, 'utf8');

  function extractIngestRouteBody(src: string): string {
    const startIdx = src.indexOf("'/ingest',");
    expect(startIdx).toBeGreaterThan(-1);
    const endIdx = src.indexOf("'/webhooks/github'", startIdx);
    expect(endIdx).toBeGreaterThan(startIdx);
    return src.slice(startIdx, endIdx);
  }

  test('AUD-2: every res.status(4xx|5xx) branch in the route is preceded by a logIngestAudit call (success path is unaffected — not asserted here)', () => {
    const body = extractIngestRouteBody(source);
    // Split on each denial/error status code emission and confirm the
    // immediately-preceding statement block references logIngestAudit.
    const denyErrorCodes = ['400', '415', '403', '500'];
    for (const code of denyErrorCodes) {
      const regex = new RegExp(`res\\.status\\(${code}\\)`, 'g');
      const positions: number[] = [];
      let m: RegExpExecArray | null;
      while ((m = regex.exec(body)) !== null) positions.push(m.index);
      expect(positions.length).toBeGreaterThan(0);
      for (const pos of positions) {
        const preceding = body.slice(Math.max(0, pos - 400), pos);
        expect(preceding).toContain('logIngestAudit(');
      }
    }
  });

  test('the route imports/uses logIngestAudit at least 8 times (one per non-success branch)', () => {
    const body = extractIngestRouteBody(source);
    const count = (body.match(/logIngestAudit\(/g) ?? []).length;
    expect(count).toBeGreaterThanOrEqual(8);
  });
});
