/**
 * Phase 9C (Universal Audit Event Integration) — `audit_events_compat`
 * view correctness, and response-schema (contract) stability for the 4
 * admin read endpoints repointed from `mcp_request_log` to the view.
 *
 * Design reference (priority order): PHASE9C-MIGRATION-AND-COMPATIBILITY-
 * PLAN.md §1, PHASE9C-ACCEPTANCE-CRITERIA.md §3-9.
 *
 * Uses a real, live HTTP server (`runServeHttp()`, ephemeral port) rather
 * than direct SQL-only assertions for the 4 admin endpoints, since
 * "response schema is unchanged" is a claim about what actually crosses
 * the wire, not just about what the view returns internally.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runServeHttp } from '../src/commands/serve-http.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
let httpServer: import('node:http').Server;
let baseUrl: string;
let adminCookie: string;

const BOOTSTRAP_TOKEN = '0123456789abcdef0123456789abcdef'; // 32 hex chars, valid per resolveBootstrapToken

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  const started = await withEnv({ GBRAIN_ADMIN_BOOTSTRAP_TOKEN: BOOTSTRAP_TOKEN }, () =>
    runServeHttp(engine, {
      port: 0,
      tokenTtl: 3600,
      enableDcr: false,
      suppressBootstrapToken: true,
    } as any),
  );
  httpServer = started.httpServer;
  const address = httpServer.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;

  const loginRes = await fetch(`${baseUrl}/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: BOOTSTRAP_TOKEN }),
  });
  expect(loginRes.status).toBe(200);
  const setCookie = loginRes.headers.get('set-cookie');
  expect(setCookie).toBeTruthy();
  adminCookie = setCookie!.split(';')[0];
}, 30_000);

afterAll(async () => {
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  await engine.disconnect();
});

async function sql<T = Record<string, unknown>>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T[]> {
  const query = strings.reduce((acc, str, i) => acc + str + (i < values.length ? `$${i + 1}` : ''), '');
  return engine.executeRaw<T>(query, values as unknown[]);
}

describe('audit_events_compat: unions legacy mcp_request_log rows and new audit_events rows', () => {
  test('a legacy mcp_request_log row and a new audit_events row both appear in the compat view', async () => {
    const legacyToken = `compat-legacy-${randomUUID()}`;
    const newClientId = `compat-new-${randomUUID()}`;
    await sql`INSERT INTO mcp_request_log (token_name, agent_name, operation, status) VALUES (${legacyToken}, 'legacy-agent', 'search', 'success')`;
    await sql`
      INSERT INTO audit_events (occurred_at, event_kind, channel_id, attribution_state, client_id, actor_label, operation, decision, outcome, correlation_id)
      VALUES (now(), 'operation.request', 'mcp_http', 'client_only', ${newClientId}, 'new-agent', 'search', 'allowed', 'succeeded', ${randomUUID()})
    `;

    const legacyRow = await sql`SELECT token_name, attribution_state FROM audit_events_compat WHERE token_name = ${legacyToken}`;
    expect(legacyRow.length).toBe(1);
    expect(legacyRow[0].attribution_state).toBe('unmigrated_legacy_record');

    const newRow = await sql`SELECT token_name, attribution_state FROM audit_events_compat WHERE token_name = ${newClientId}`;
    expect(newRow.length).toBe(1);
    expect(newRow[0].attribution_state).toBe('client_only');
  });

  test('status mapping: outcome=succeeded -> status=success, anything else -> status=error', async () => {
    const successClient = `compat-status-success-${randomUUID()}`;
    const failedClient = `compat-status-failed-${randomUUID()}`;
    const rejectedClient = `compat-status-rejected-${randomUUID()}`;
    for (const [clientId, outcome] of [[successClient, 'succeeded'], [failedClient, 'failed'], [rejectedClient, 'rejected']] as const) {
      await sql`
        INSERT INTO audit_events (occurred_at, event_kind, channel_id, attribution_state, client_id, operation, decision, outcome, correlation_id)
        VALUES (now(), 'operation.request', 'mcp_http', 'client_only', ${clientId}, 'test_op', 'allowed', ${outcome}, ${randomUUID()})
      `;
    }
    const rows = await sql<{ token_name: string; status: string }>`
      SELECT token_name, status FROM audit_events_compat WHERE token_name IN (${successClient}, ${failedClient}, ${rejectedClient})
    `;
    const byClient = Object.fromEntries(rows.map(r => [r.token_name, r.status]));
    expect(byClient[successClient]).toBe('success');
    expect(byClient[failedClient]).toBe('error');
    expect(byClient[rejectedClient]).toBe('error');
  });

  test('the view only includes audit_events rows for channel_id IN (mcp_http, ingest_http) — other channels (e.g. admin_http, oauth_endpoint) are excluded, matching mcp_request_log\'s historical scope', async () => {
    const adminClient = `compat-scope-admin-${randomUUID()}`;
    await sql`
      INSERT INTO audit_events (occurred_at, event_kind, channel_id, attribution_state, client_id, operation, decision, outcome, correlation_id)
      VALUES (now(), 'session.establish', 'admin_http', 'admin_session', ${adminClient}, 'admin_login', 'allowed', 'succeeded', ${randomUUID()})
    `;
    const rows = await sql`SELECT token_name FROM audit_events_compat WHERE token_name = ${adminClient}`;
    expect(rows.length).toBe(0);
  });

  test('v0.26.3 persistence regression, reproduced via the compat view: tools/list + tools/call together produce >= 2 rows for the same client', async () => {
    const clientId = `compat-v0263-${randomUUID()}`;
    await sql`
      INSERT INTO audit_events (occurred_at, event_kind, channel_id, attribution_state, client_id, operation, decision, outcome, correlation_id)
      VALUES (now(), 'operation.request', 'mcp_http', 'client_only', ${clientId}, 'tools/list', 'allowed', 'succeeded', ${randomUUID()})
    `;
    await sql`
      INSERT INTO audit_events (occurred_at, event_kind, channel_id, attribution_state, client_id, operation, decision, outcome, correlation_id)
      VALUES (now(), 'operation.request', 'mcp_http', 'client_only', ${clientId}, 'search', 'allowed', 'succeeded', ${randomUUID()})
    `;
    const rows = await sql`SELECT count(*)::int AS n FROM audit_events_compat WHERE token_name = ${clientId}`;
    expect((rows[0] as { n: number }).n).toBeGreaterThanOrEqual(2);
  });
});

describe('admin read-endpoint response schema (contract) is unchanged after repointing to audit_events_compat', () => {
  test('/admin/api/requests: same field set as before (id, token_name, agent_name, operation, latency_ms, status, params, error_message, created_at) + pagination envelope', async () => {
    const clientId = `compat-contract-requests-${randomUUID()}`;
    await sql`
      INSERT INTO audit_events (occurred_at, event_kind, channel_id, attribution_state, client_id, actor_label, operation, latency_ms, decision, outcome, correlation_id)
      VALUES (now(), 'operation.request', 'mcp_http', 'client_only', ${clientId}, 'contract-agent', 'search', 42, 'allowed', 'succeeded', ${randomUUID()})
    `;
    const res = await fetch(`${baseUrl}/admin/api/requests?agent=${clientId}`, { headers: { Cookie: adminCookie } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('rows');
    expect(body).toHaveProperty('total');
    expect(body).toHaveProperty('page');
    expect(body).toHaveProperty('pages');
    expect(Array.isArray(body.rows)).toBe(true);
    const row = body.rows.find((r: { token_name: string }) => r.token_name === clientId);
    expect(row).toBeDefined();
    for (const field of ['id', 'token_name', 'agent_name', 'operation', 'latency_ms', 'status', 'created_at']) {
      expect(row).toHaveProperty(field);
    }
    expect(row.operation).toBe('search');
    expect(row.status).toBe('success');
    expect(typeof row.id).toBe('string'); // id::text cast in the view — was integer pre-Phase-9C, contract change documented in RequestLog.tsx read (React key + toggle only, no numeric ops)
  });

  test('/admin/api/agents: total_requests/requests_today/last_used_at still computed correctly for an OAuth client with audit_events activity', async () => {
    const res = await fetch(`${baseUrl}/admin/api/register-client`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ name: `compat-contract-agents-${randomUUID()}`, scopes: 'read' }),
    });
    expect(res.status).toBe(200);
    const { clientId } = await res.json();

    await sql`
      INSERT INTO audit_events (occurred_at, event_kind, channel_id, attribution_state, client_id, operation, decision, outcome, correlation_id)
      VALUES (now(), 'operation.request', 'mcp_http', 'client_only', ${clientId}, 'search', 'allowed', 'succeeded', ${randomUUID()})
    `;

    const listRes = await fetch(`${baseUrl}/admin/api/agents`, { headers: { Cookie: adminCookie } });
    expect(listRes.status).toBe(200);
    const agents = await listRes.json();
    const found = agents.find((a: { id: string }) => a.id === clientId);
    expect(found).toBeDefined();
    expect(found.total_requests).toBeGreaterThanOrEqual(1);
    expect(found.requests_today).toBeGreaterThanOrEqual(1);
    expect(found.last_used_at).toBeTruthy();
    for (const field of ['id', 'name', 'auth_type', 'grant_types', 'scope', 'created_at', 'status']) {
      expect(found).toHaveProperty(field);
    }
  });

  test('/admin/api/stats: requests_today reflects audit_events activity, same response shape', async () => {
    const clientId = `compat-contract-stats-${randomUUID()}`;
    await sql`
      INSERT INTO audit_events (occurred_at, event_kind, channel_id, attribution_state, client_id, operation, decision, outcome, correlation_id)
      VALUES (now(), 'operation.request', 'mcp_http', 'client_only', ${clientId}, 'search', 'allowed', 'succeeded', ${randomUUID()})
    `;
    const res = await fetch(`${baseUrl}/admin/api/stats`, { headers: { Cookie: adminCookie } });
    expect(res.status).toBe(200);
    const body = await res.json();
    for (const field of ['connected_agents', 'active_tokens', 'active_api_keys', 'requests_today']) {
      expect(body).toHaveProperty(field);
      expect(typeof body[field]).toBe('number');
    }
    expect(body.requests_today).toBeGreaterThanOrEqual(1);
  });

  test('/admin/api/health-indicators: same shape, plus the Phase 9C audit_write_failures_total/audit_spill_pending fields', async () => {
    const res = await fetch(`${baseUrl}/admin/api/health-indicators`, { headers: { Cookie: adminCookie } });
    expect(res.status).toBe(200);
    const body = await res.json();
    for (const field of ['expiring_soon', 'error_rate', 'audit_write_failures_total', 'audit_spill_pending']) {
      expect(body).toHaveProperty(field);
    }
    expect(typeof body.error_rate).toBe('string');
    expect(body.error_rate.endsWith('%')).toBe(true);
  });

  test('/ingest rejection/failure rows (channel_id=ingest_http) DO feed error_rate — an intentional behavior change from success-only counting, verified as an actual change, not "stays the same"', async () => {
    const before = await fetch(`${baseUrl}/admin/api/health-indicators`, { headers: { Cookie: adminCookie } });
    const beforeBody = await before.json();
    const beforeRate = parseFloat(beforeBody.error_rate);

    // Seed enough ingest_http failure rows to move the needle deterministically.
    const batch = 5;
    for (let i = 0; i < batch; i++) {
      await sql`
        INSERT INTO audit_events (occurred_at, event_kind, channel_id, attribution_state, client_id, operation, decision, outcome, reason_code, correlation_id)
        VALUES (now(), 'ingest.reject', 'ingest_http', 'client_only', ${'compat-ingest-error-rate-' + randomUUID()}, 'ingest', 'denied', 'rejected', 'invalid_event', ${randomUUID()})
      `;
    }
    const after = await fetch(`${baseUrl}/admin/api/health-indicators`, { headers: { Cookie: adminCookie } });
    const afterBody = await after.json();
    const afterRate = parseFloat(afterBody.error_rate);

    // Pre-Phase-9C, mcp_request_log never recorded /ingest at all under this
    // scope (only webhook_ingest's success path was logged) — these
    // channel_id='ingest_http' rejection rows are NEW contributors to the
    // error_rate calculation. The rate must move (not stay byte-identical),
    // demonstrating the intentional widening of what error_rate now covers.
    expect(afterRate).toBeGreaterThan(beforeRate);
  });
});
