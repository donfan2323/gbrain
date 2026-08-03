/**
 * `gbrain audit delegation-scope-shortfalls` (dashboard-v3mjk, Phase 9E-2
 * prep). Two layers:
 *
 *  - parseDelegationScopeShortfallsArgs: pure CLI-arg validation, no DB.
 *  - queryDelegationScopeShortfalls: engine-injectable (PGLiteEngine),
 *    covers time-range/client-id/source-id filtering, the --limit
 *    truncation flag, cross-driver params_summary shapes, and secret
 *    non-leakage against real `audit_events`/`oauth_clients` rows.
 *
 * Aggregation-logic edge cases (dedup, enforcementImpact states,
 * malformed-shape classification) are covered in
 * test/delegation-scope-shortfall-report.test.ts (pure, no DB) — not
 * re-tested here to avoid duplicate-of-the-implementation coverage.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { writeAuditEvent } from '../src/core/audit/audit-events-writer.ts';
import type { AuditEventInput } from '../src/core/audit/audit-events-types.ts';
import {
  parseDelegationScopeShortfallsArgs,
  queryDelegationScopeShortfalls,
} from '../src/commands/audit.ts';

describe('parseDelegationScopeShortfallsArgs', () => {
  test('no args → defaults (30 days, limit 500, not all-time, no filters, human output)', () => {
    const opts = parseDelegationScopeShortfallsArgs([]);
    expect(opts).toEqual({
      sinceDays: 30,
      allTime: false,
      clientId: undefined,
      sourceId: undefined,
      limit: 500,
      json: false,
    });
  });

  test('--since-days N sets a positive integer window', () => {
    const opts = parseDelegationScopeShortfallsArgs(['--since-days', '7']);
    expect(opts.sinceDays).toBe(7);
    expect(opts.allTime).toBe(false);
  });

  test('--since-days rejects non-positive-integer values', () => {
    expect(() => parseDelegationScopeShortfallsArgs(['--since-days', '0'])).toThrow(/positive integer/);
    expect(() => parseDelegationScopeShortfallsArgs(['--since-days', '-3'])).toThrow(/positive integer/);
    expect(() => parseDelegationScopeShortfallsArgs(['--since-days', '1.5'])).toThrow(/positive integer/);
    expect(() => parseDelegationScopeShortfallsArgs(['--since-days', 'abc'])).toThrow(/positive integer/);
  });

  test('--all-time clears sinceDays to null', () => {
    const opts = parseDelegationScopeShortfallsArgs(['--all-time']);
    expect(opts.allTime).toBe(true);
    expect(opts.sinceDays).toBeNull();
  });

  test('--all-time together with --since-days is rejected regardless of flag order', () => {
    expect(() => parseDelegationScopeShortfallsArgs(['--since-days', '7', '--all-time'])).toThrow(/mutually exclusive/);
    expect(() => parseDelegationScopeShortfallsArgs(['--all-time', '--since-days', '7'])).toThrow(/mutually exclusive/);
  });

  test('--client-id / --source-id are captured', () => {
    const opts = parseDelegationScopeShortfallsArgs(['--client-id', 'c1', '--source-id', 'dept-x']);
    expect(opts.clientId).toBe('c1');
    expect(opts.sourceId).toBe('dept-x');
  });

  test('--limit rejects non-positive-integer values', () => {
    expect(() => parseDelegationScopeShortfallsArgs(['--limit', '0'])).toThrow(/positive integer/);
    expect(() => parseDelegationScopeShortfallsArgs(['--limit', '-1'])).toThrow(/positive integer/);
  });

  test('--json sets json output mode', () => {
    const opts = parseDelegationScopeShortfallsArgs(['--json']);
    expect(opts.json).toBe(true);
  });

  test('a flag missing its value throws', () => {
    expect(() => parseDelegationScopeShortfallsArgs(['--client-id'])).toThrow(/requires a value/);
    expect(() => parseDelegationScopeShortfallsArgs(['--client-id', '--json'])).toThrow(/requires a value/);
  });

  test('unknown flag throws', () => {
    expect(() => parseDelegationScopeShortfallsArgs(['--frobnicate'])).toThrow(/Unknown flag/);
  });
});

describe('queryDelegationScopeShortfalls (PGLite)', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });

  afterAll(async () => {
    await engine.disconnect();
  });

  async function truncate(): Promise<void> {
    await (engine as any).db.exec(`DELETE FROM audit_events`);
    await (engine as any).db.exec(`DELETE FROM oauth_clients`);
  }
  beforeEach(truncate);

  async function insertClient(clientId: string, scope: string, opts: { sourceId?: string; secretHash?: string; deletedAt?: string } = {}): Promise<void> {
    if (opts.sourceId) {
      // oauth_clients.source_id has a FK to sources(id) — seed it first
      // (ON CONFLICT so repeated calls with the same sourceId across tests
      // in this describe block don't collide).
      await engine.executeRaw(
        `INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING`,
        [opts.sourceId],
      );
    }
    await engine.executeRaw(
      `INSERT INTO oauth_clients (client_id, client_name, scope, source_id, client_secret_hash, deleted_at)
       VALUES ($1, $1, $2, $3, $4, ${opts.deletedAt ? `'${opts.deletedAt}'` : 'NULL'})`,
      [clientId, scope, opts.sourceId ?? null, opts.secretHash ?? null],
    );
  }

  function shortfallEvent(overrides: Partial<AuditEventInput> = {}): AuditEventInput {
    const now = new Date().toISOString();
    return {
      envelope_version: 1,
      occurred_at: now,
      event_kind: 'delegation.grant',
      channel_id: 'mcp_http',
      attribution_state: 'client_only',
      principal_id: null,
      client_id: 'test-client',
      actor_label: 'test-client',
      credential_ref: null,
      operation: 'submit_agent',
      required_scope: 'agent',
      scopes_snapshot: ['agent'],
      decision: 'allowed',
      outcome: 'succeeded',
      reason_code: 'delegation_scope_shortfall',
      resource_kind: 'oauth_client',
      resource_ref: 'test-client',
      source_id: null,
      job_id: null,
      correlation_id: 'corr-test',
      parent_event_id: null,
      latency_ms: 5,
      params_summary: { missing_scopes: ['write'], shortfall_tools: ['put_page'] },
      adapter: { jsonrpc_method: 'tools/call', tool: 'submit_agent' },
      errorMessageRaw: null,
      ...overrides,
    };
  }

  async function insertShortfall(overrides: Partial<AuditEventInput> = {}): Promise<void> {
    await writeAuditEvent(engine, shortfallEvent(overrides), { class: 'class1_issuance' });
  }

  test('no shortfall events → empty report', async () => {
    await insertClient('c1', 'read agent');
    const { report, truncated } = await queryDelegationScopeShortfalls(engine, {
      sinceDays: 30, allTime: false, clientId: undefined, sourceId: undefined, limit: 500, json: false,
    });
    expect(report).toEqual([]);
    expect(truncated).toBe(false);
  });

  test('only delegation.grant + delegation_scope_shortfall rows are matched — other event_kind/reason_code rows are excluded', async () => {
    await insertClient('c1', 'read agent');
    await insertShortfall({ client_id: 'c1' });
    // A delegation.deny row (different event_kind) — must not be counted.
    await writeAuditEvent(engine, shortfallEvent({ client_id: 'c1', event_kind: 'delegation.deny', decision: 'denied', outcome: 'rejected', reason_code: 'tool_not_bound', params_summary: null }), { class: 'class2_denial' });
    // A delegation.grant row with a different reason_code — must not be counted.
    await writeAuditEvent(engine, shortfallEvent({ client_id: 'c1', reason_code: null, params_summary: null }), { class: 'class1_issuance' });

    const { report } = await queryDelegationScopeShortfalls(engine, {
      sinceDays: 30, allTime: false, clientId: undefined, sourceId: undefined, limit: 500, json: false,
    });
    expect(report).toHaveLength(1);
    expect(report[0].eventCount).toBe(1);
  });

  test('--since-days excludes events older than the window', async () => {
    await insertClient('c1', 'read agent');
    const old = new Date(Date.now() - 60 * 24 * 3600 * 1000).toISOString(); // 60 days ago
    await insertShortfall({ client_id: 'c1', occurred_at: old });

    const { report: within } = await queryDelegationScopeShortfalls(engine, {
      sinceDays: 90, allTime: false, clientId: undefined, sourceId: undefined, limit: 500, json: false,
    });
    expect(within).toHaveLength(1);

    const { report: outside } = await queryDelegationScopeShortfalls(engine, {
      sinceDays: 7, allTime: false, clientId: undefined, sourceId: undefined, limit: 500, json: false,
    });
    expect(outside).toHaveLength(0);
  });

  test('--all-time includes events regardless of age', async () => {
    await insertClient('c1', 'read agent');
    const veryOld = new Date(Date.now() - 400 * 24 * 3600 * 1000).toISOString();
    await insertShortfall({ client_id: 'c1', occurred_at: veryOld });

    const { report } = await queryDelegationScopeShortfalls(engine, {
      sinceDays: null, allTime: true, clientId: undefined, sourceId: undefined, limit: 500, json: false,
    });
    expect(report).toHaveLength(1);
  });

  test('--client-id filters to a single client', async () => {
    await insertClient('c1', 'read agent');
    await insertClient('c2', 'read agent');
    await insertShortfall({ client_id: 'c1' });
    await insertShortfall({ client_id: 'c2' });

    const { report } = await queryDelegationScopeShortfalls(engine, {
      sinceDays: 30, allTime: false, clientId: 'c1', sourceId: undefined, limit: 500, json: false,
    });
    expect(report).toHaveLength(1);
    expect(report[0].clientId).toBe('c1');
  });

  test('--source-id filters via oauth_clients.source_id (audit_events.source_id itself is always NULL for these rows)', async () => {
    await insertClient('dept-x-client', 'read agent', { sourceId: 'dept-x' });
    await insertClient('dept-y-client', 'read agent', { sourceId: 'dept-y' });
    await insertShortfall({ client_id: 'dept-x-client' });
    await insertShortfall({ client_id: 'dept-y-client' });

    const { report } = await queryDelegationScopeShortfalls(engine, {
      sinceDays: 30, allTime: false, clientId: undefined, sourceId: 'dept-x', limit: 500, json: false,
    });
    expect(report).toHaveLength(1);
    expect(report[0].clientId).toBe('dept-x-client');
  });

  test('--source-id matching zero clients short-circuits to an empty report without erroring', async () => {
    await insertClient('c1', 'read agent', { sourceId: 'dept-x' });
    await insertShortfall({ client_id: 'c1' });

    const { report, truncated } = await queryDelegationScopeShortfalls(engine, {
      sinceDays: 30, allTime: false, clientId: undefined, sourceId: 'no-such-source', limit: 500, json: false,
    });
    expect(report).toEqual([]);
    expect(truncated).toBe(false);
  });

  test('--limit caps the raw event fetch and sets truncated=true when hit', async () => {
    await insertClient('c1', 'read agent');
    for (let i = 0; i < 5; i++) {
      await insertShortfall({ client_id: 'c1', correlation_id: `corr-${i}` });
    }
    const { report, truncated } = await queryDelegationScopeShortfalls(engine, {
      sinceDays: 30, allTime: false, clientId: undefined, sourceId: undefined, limit: 3, json: false,
    });
    expect(truncated).toBe(true);
    expect(report[0].eventCount).toBe(3);
  });

  test('--limit not hit → truncated=false', async () => {
    await insertClient('c1', 'read agent');
    await insertShortfall({ client_id: 'c1' });
    const { truncated } = await queryDelegationScopeShortfalls(engine, {
      sinceDays: 30, allTime: false, clientId: undefined, sourceId: undefined, limit: 500, json: false,
    });
    expect(truncated).toBe(false);
  });

  test('malformed params_summary (raw-inserted, bypassing the writer) is safely excluded from scope/tool sets, event still counted', async () => {
    await insertClient('c1', 'read agent');
    await insertShortfall({ client_id: 'c1' }); // one well-formed
    // One malformed row inserted directly (writer's AuditEventInput type
    // would reject this shape at compile time — this simulates a
    // pre-existing/foreign-written row with an unexpected shape).
    await engine.executeRaw(
      `INSERT INTO audit_events (occurred_at, event_kind, channel_id, attribution_state, client_id, operation, decision, outcome, reason_code, correlation_id, params_summary, adapter)
       VALUES (now(), 'delegation.grant', 'mcp_http', 'client_only', 'c1', 'submit_agent', 'allowed', 'succeeded', 'delegation_scope_shortfall', 'corr-malformed', $1::jsonb, '{}'::jsonb)`,
      [JSON.stringify('not an object')],
    );

    const { report } = await queryDelegationScopeShortfalls(engine, {
      sinceDays: 30, allTime: false, clientId: undefined, sourceId: undefined, limit: 500, json: false,
    });
    expect(report).toHaveLength(1);
    expect(report[0].eventCount).toBe(2);
    expect(report[0].malformedEventCount).toBe(1);
    expect(report[0].missingScopes).toEqual(['write']); // only from the well-formed row
  });

  test('client_secret_hash is never selected — a seeded secret never appears anywhere in the report or its JSON serialization', async () => {
    const secret = 'sk-super-secret-value-should-never-leak';
    await insertClient('c1', 'read agent', { secretHash: secret });
    await insertShortfall({ client_id: 'c1' });

    const { report } = await queryDelegationScopeShortfalls(engine, {
      sinceDays: 30, allTime: false, clientId: undefined, sourceId: undefined, limit: 500, json: false,
    });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(secret);
    expect(serialized.toLowerCase()).not.toContain('secret_hash');
  });

  test('a revoked client (deleted_at set) reports enforcementImpact=client_no_longer_exists', async () => {
    await insertClient('c1', 'read agent', { deletedAt: new Date().toISOString() });
    await insertShortfall({ client_id: 'c1' });

    const { report } = await queryDelegationScopeShortfalls(engine, {
      sinceDays: 30, allTime: false, clientId: undefined, sourceId: undefined, limit: 500, json: false,
    });
    expect(report[0].enforcementImpact).toBe('client_no_longer_exists');
  });

  test('JSON.stringify(report) is stable across two identical queries against unchanged data', async () => {
    await insertClient('c1', 'read agent');
    await insertClient('c2', 'read agent');
    await insertShortfall({ client_id: 'c1' });
    await insertShortfall({ client_id: 'c2' });

    const optsArg = { sinceDays: 30, allTime: false, clientId: undefined, sourceId: undefined, limit: 500, json: false } as const;
    const a = JSON.stringify((await queryDelegationScopeShortfalls(engine, optsArg)).report);
    const b = JSON.stringify((await queryDelegationScopeShortfalls(engine, optsArg)).report);
    expect(a).toBe(b);
  });
});
