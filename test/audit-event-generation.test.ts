/**
 * Phase 9C (Universal Audit Event Integration) — direct verification that
 * each of the 6 IN routes, under NORMAL operation (no failure injection),
 * produces an `audit_events` row with the expected `event_kind`/
 * `channel_id`/`decision`/`outcome` for representative success/denial/
 * failure branches.
 *
 * Design reference (priority order): PHASE9C-ACCEPTANCE-CRITERIA.md §1-2/
 * §3-11. Distinct from test/audit-failure-policy.test.ts (failure
 * injection into the Writer itself) and test/audit-entrypoint-coverage.test.ts
 * (route existence only, no behavioral assertions). Overlaps intentionally
 * exist with test/audit-compat-view.test.ts (register-client) and
 * test/audit-delegation-chain.test.ts (submit_agent) — those files assert
 * different things about the same routes; this file is the single place
 * that sweeps all 6 IN categories for the basic event-shape claim.
 *
 * Real HTTP server (`runServeHttp()`, ephemeral port) throughout — these
 * are the actual wire-level request/response paths, not direct handler
 * calls.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { randomUUID, createHmac } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runServeHttp } from '../src/commands/serve-http.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
let httpServer: import('node:http').Server;
let baseUrl: string;
let adminCookie: string;
let provider: GBrainOAuthProvider;

const BOOTSTRAP_TOKEN = 'fedcba9876543210fedcba9876543210';

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  const started = await withEnv({ GBRAIN_ADMIN_BOOTSTRAP_TOKEN: BOOTSTRAP_TOKEN }, () =>
    runServeHttp(engine, { port: 0, tokenTtl: 3600, enableDcr: false, suppressBootstrapToken: true } as any),
  );
  httpServer = started.httpServer;
  const address = httpServer.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;

  const loginRes = await fetch(`${baseUrl}/admin/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: BOOTSTRAP_TOKEN }),
  });
  adminCookie = loginRes.headers.get('set-cookie')!.split(';')[0];

  const sql = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.reduce((acc, str, i) => acc + str + (i < values.length ? `$${i + 1}` : ''), '');
    return engine.executeRaw(query, values as unknown[]);
  };
  provider = new GBrainOAuthProvider({ sql: sql as any, tokenTtl: 3600, refreshTtl: 86400 });
}, 30_000);

afterAll(async () => {
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  await engine.disconnect();
});

async function sql<T = Record<string, unknown>>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T[]> {
  const query = strings.reduce((acc, str, i) => acc + str + (i < values.length ? `$${i + 1}` : ''), '');
  return engine.executeRaw<T>(query, values as unknown[]);
}

async function latestAuditRow(clientId: string, eventKind?: string) {
  const rows = eventKind
    ? await sql<Record<string, unknown>>`SELECT * FROM audit_events WHERE client_id = ${clientId} AND event_kind = ${eventKind} ORDER BY recorded_at DESC LIMIT 1`
    : await sql<Record<string, unknown>>`SELECT * FROM audit_events WHERE client_id = ${clientId} ORDER BY recorded_at DESC LIMIT 1`;
  return rows[0];
}

// ---- IN-3: /token, /revoke -------------------------------------------------

describe('IN-3: POST /token (client_credentials)', () => {
  test('success: credential.issue, class-consistent decision=allowed/outcome=succeeded', async () => {
    const { clientId, clientSecret } = await provider.registerClientManual(`gen-token-${randomUUID()}`, ['client_credentials'], 'read');
    const res = await fetch(`${baseUrl}/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret! }),
    });
    expect(res.status).toBe(200);
    const row = await latestAuditRow(clientId, 'credential.issue');
    expect(row).toBeDefined();
    expect(row!.decision).toBe('allowed');
    expect(row!.outcome).toBe('succeeded');
    expect(row!.channel_id).toBe('oauth_endpoint');
  });

  test('denial: missing client_secret -> class2_denial shape (denied/rejected)', async () => {
    const clientId = `gen-token-missing-${randomUUID()}`;
    const res = await fetch(`${baseUrl}/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId }),
    });
    expect(res.status).toBe(400);
    const row = await latestAuditRow(clientId, 'credential.issue');
    expect(row).toBeDefined();
    expect(row!.decision).toBe('denied');
    expect(row!.outcome).toBe('rejected');
    expect(row!.reason_code).toBe('missing_credentials');
  });
});

describe('IN-3: POST /revoke', () => {
  test('success: credential.revoke, class1_revocation shape', async () => {
    const { clientId, clientSecret } = await provider.registerClientManual(`gen-revoke-${randomUUID()}`, ['client_credentials'], 'read');
    const tokenRes = await fetch(`${baseUrl}/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret! }),
    });
    const { access_token } = await tokenRes.json();

    const revokeRes = await fetch(`${baseUrl}/revoke`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: access_token, client_id: clientId, client_secret: clientSecret! }),
    });
    expect(revokeRes.status).toBe(200);
    const row = await latestAuditRow(clientId, 'credential.revoke');
    expect(row).toBeDefined();
    expect(row!.decision).toBe('allowed');
    expect(row!.outcome).toBe('succeeded');
  });
});

// ---- IN-2: /ingest ----------------------------------------------------------

describe('IN-2: POST /ingest', () => {
  test('success: ingest.accept, class3_success shape', async () => {
    const { clientId, clientSecret } = await provider.registerClientManual(`gen-ingest-${randomUUID()}`, ['client_credentials'], 'write');
    const tokenRes = await fetch(`${baseUrl}/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret! }),
    });
    const { access_token } = await tokenRes.json();

    const res = await fetch(`${baseUrl}/ingest`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'text/plain' },
      body: 'hello from audit-event-generation test',
    });
    expect(res.status).toBe(202);
    const row = await latestAuditRow(clientId, 'ingest.accept');
    expect(row).toBeDefined();
    expect(row!.decision).toBe('allowed');
    expect(row!.outcome).toBe('succeeded');
    expect(row!.channel_id).toBe('ingest_http');
  });

  test('rejection: empty body -> ingest.reject, class2_denial shape', async () => {
    const { clientId, clientSecret } = await provider.registerClientManual(`gen-ingest-empty-${randomUUID()}`, ['client_credentials'], 'write');
    const tokenRes = await fetch(`${baseUrl}/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret! }),
    });
    const { access_token } = await tokenRes.json();

    const res = await fetch(`${baseUrl}/ingest`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'text/plain' },
      body: '',
    });
    expect(res.status).toBe(400);
    const row = await latestAuditRow(clientId, 'ingest.reject');
    expect(row).toBeDefined();
    expect(row!.decision).toBe('denied');
    expect(row!.outcome).toBe('rejected');
    expect(row!.reason_code).toBe('empty_body');
  });
});

// ---- IN-1: /mcp --------------------------------------------------------------

describe('IN-1: POST /mcp', () => {
  test('tools/call success: operation.request, class3_success shape', async () => {
    const { clientId, clientSecret } = await provider.registerClientManual(`gen-mcp-${randomUUID()}`, ['client_credentials'], 'read');
    const tokenRes = await fetch(`${baseUrl}/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret! }),
    });
    const { access_token } = await tokenRes.json();

    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(res.status).toBe(200);
    const row = await latestAuditRow(clientId, 'operation.request');
    expect(row).toBeDefined();
    expect(row!.operation).toBe('tools/list');
    expect(row!.decision).toBe('allowed');
    expect(row!.outcome).toBe('succeeded');
    expect(row!.channel_id).toBe('mcp_http');
  });
});

// ---- IN-5: /webhooks/github ---------------------------------------------

describe('IN-5: POST /webhooks/github', () => {
  async function seedSource(secret: string) {
    const id = `gen-webhook-source-${randomUUID()}`;
    await sql`
      INSERT INTO sources (id, name, config)
      VALUES (${id}, ${id}, ${JSON.stringify({ github_repo: `octocat/${id}`, tracked_branch: 'main', webhook_secret: secret })}::jsonb)
    `;
    return id;
  }

  test('success: HMAC-verified push -> operation.request, message_authenticated, class3_success', async () => {
    const secret = 'test-webhook-secret';
    const sourceId = await seedSource(secret);
    const payload = JSON.stringify({ repository: { full_name: `octocat/${sourceId}` }, ref: 'refs/heads/main' });
    const sig = 'sha256=' + createHmac('sha256', secret).update(payload).digest('hex');

    const res = await fetch(`${baseUrl}/webhooks/github`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-GitHub-Event': 'push', 'X-Hub-Signature-256': sig },
      body: payload,
    });
    expect(res.status).toBe(202);

    const rows = await sql<Record<string, unknown>>`
      SELECT * FROM audit_events WHERE source_id = ${sourceId} AND event_kind = 'operation.request' ORDER BY recorded_at DESC LIMIT 1
    `;
    expect(rows.length).toBe(1);
    expect(rows[0].attribution_state).toBe('message_authenticated');
    expect(rows[0].decision).toBe('allowed');
    expect(rows[0].outcome).toBe('succeeded');
  });

  test('denial: wrong signature -> authorization.decision, authentication_failed, class2_denial', async () => {
    const secret = 'another-webhook-secret';
    const sourceId = await seedSource(secret);
    const payload = JSON.stringify({ repository: { full_name: `octocat/${sourceId}` }, ref: 'refs/heads/main' });

    const res = await fetch(`${baseUrl}/webhooks/github`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-GitHub-Event': 'push', 'X-Hub-Signature-256': 'sha256=' + '0'.repeat(64) },
      body: payload,
    });
    expect(res.status).toBe(401);

    const rows = await sql<Record<string, unknown>>`
      SELECT * FROM audit_events WHERE source_id = ${sourceId} AND event_kind = 'authorization.decision' ORDER BY recorded_at DESC LIMIT 1
    `;
    expect(rows.length).toBe(1);
    expect(rows[0].attribution_state).toBe('authentication_failed');
    expect(rows[0].decision).toBe('denied');
    expect(rows[0].reason_code).toBe('signature_mismatch');
  });
});

// ---- IN-4: admin Authority routes not yet exercised via real HTTP elsewhere --

describe('IN-4: admin Authority-changing routes', () => {
  test('POST /admin/api/api-keys: success -> credential.issue, class1_issuance shape', async () => {
    const res = await fetch(`${baseUrl}/admin/api/api-keys`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ name: `gen-apikey-${randomUUID()}` }),
    });
    expect(res.status).toBe(200);
    const { id } = await res.json();
    const rows = await sql<Record<string, unknown>>`SELECT * FROM audit_events WHERE resource_ref = ${id} AND event_kind = 'credential.issue' ORDER BY recorded_at DESC LIMIT 1`;
    expect(rows.length).toBe(1);
    expect(rows[0].decision).toBe('allowed');
    expect(rows[0].outcome).toBe('succeeded');
  });

  test('POST /admin/api/api-keys/revoke: success -> credential.revoke, class1_revocation shape', async () => {
    const name = `gen-apikey-revoke-${randomUUID()}`;
    await fetch(`${baseUrl}/admin/api/api-keys`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ name }),
    });
    const res = await fetch(`${baseUrl}/admin/api/api-keys/revoke`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ name }),
    });
    expect(res.status).toBe(200);
    const rows = await sql<Record<string, unknown>>`SELECT * FROM audit_events WHERE resource_ref = ${name} AND event_kind = 'credential.revoke' ORDER BY recorded_at DESC LIMIT 1`;
    expect(rows.length).toBe(1);
    expect(rows[0].decision).toBe('allowed');
    expect(rows[0].outcome).toBe('succeeded');
  });

  test('POST /admin/api/update-client-ttl: success -> client.update, class1_issuance shape', async () => {
    const regRes = await fetch(`${baseUrl}/admin/api/register-client`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ name: `gen-ttl-${randomUUID()}`, scopes: 'read' }),
    });
    const { clientId } = await regRes.json();
    const res = await fetch(`${baseUrl}/admin/api/update-client-ttl`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ clientId, tokenTtl: 7200 }),
    });
    expect(res.status).toBe(200);
    const rows = await sql<Record<string, unknown>>`SELECT * FROM audit_events WHERE resource_ref = ${clientId} AND event_kind = 'client.update' ORDER BY recorded_at DESC LIMIT 1`;
    expect(rows.length).toBe(1);
    expect(rows[0].decision).toBe('allowed');
  });

  test('POST /admin/api/revoke-client: success -> client.revoke, class1_revocation shape', async () => {
    const regRes = await fetch(`${baseUrl}/admin/api/register-client`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ name: `gen-revoke-client-${randomUUID()}`, scopes: 'read' }),
    });
    const { clientId } = await regRes.json();
    const res = await fetch(`${baseUrl}/admin/api/revoke-client`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ clientId }),
    });
    expect(res.status).toBe(200);
    const rows = await sql<Record<string, unknown>>`SELECT * FROM audit_events WHERE resource_ref = ${clientId} AND event_kind = 'client.revoke' ORDER BY recorded_at DESC LIMIT 1`;
    expect(rows.length).toBe(1);
    expect(rows[0].decision).toBe('allowed');
    expect(rows[0].outcome).toBe('succeeded');
  });

  test('POST /admin/api/issue-magic-link + GET /admin/auth/:token: both steps recorded as session.establish, class1_issuance shape', async () => {
    const issueRes = await fetch(`${baseUrl}/admin/api/issue-magic-link`, {
      method: 'POST', headers: { Authorization: `Bearer ${BOOTSTRAP_TOKEN}` },
    });
    expect(issueRes.status).toBe(200);
    const { url } = await issueRes.json();
    const nonce = new URL(url).pathname.split('/').pop()!;

    const issueRow = await sql<Record<string, unknown>>`
      SELECT * FROM audit_events WHERE operation = 'issue_magic_link' AND event_kind = 'credential.issue' ORDER BY recorded_at DESC LIMIT 1
    `;
    expect(issueRow.length).toBe(1);
    expect(issueRow[0].decision).toBe('allowed');

    const redeemRes = await fetch(`${baseUrl}/admin/auth/${nonce}`, { redirect: 'manual' });
    expect(redeemRes.status).toBe(302);
    const redeemRow = await sql<Record<string, unknown>>`
      SELECT * FROM audit_events WHERE operation = 'admin_magic_link_redeem' AND event_kind = 'session.establish' ORDER BY recorded_at DESC LIMIT 1
    `;
    expect(redeemRow.length).toBe(1);
    expect(redeemRow[0].decision).toBe('allowed');
  });

  test('POST /admin/api/sign-out-everywhere: success -> session.terminate, class1_revocation shape', async () => {
    // Use a SEPARATE login so this doesn't invalidate adminCookie for later tests.
    const loginRes = await fetch(`${baseUrl}/admin/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: BOOTSTRAP_TOKEN }),
    });
    const cookie = loginRes.headers.get('set-cookie')!.split(';')[0];

    const res = await fetch(`${baseUrl}/admin/api/sign-out-everywhere`, { method: 'POST', headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    const rows = await sql<Record<string, unknown>>`
      SELECT * FROM audit_events WHERE operation = 'admin_sign_out_everywhere' AND event_kind = 'session.terminate' ORDER BY recorded_at DESC LIMIT 1
    `;
    expect(rows.length).toBe(1);
    expect(rows[0].decision).toBe('allowed');
    expect(rows[0].outcome).toBe('succeeded');

    // Re-establish adminCookie for any tests that run after this one in the
    // same file (sign-out-everywhere invalidates ALL sessions, including
    // the one captured in beforeAll).
    const reLogin = await fetch(`${baseUrl}/admin/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: BOOTSTRAP_TOKEN }),
    });
    adminCookie = reLogin.headers.get('set-cookie')!.split(';')[0];
  });
});
