/**
 * Phase 9C (Universal Audit Event Integration) — real-Postgres verification
 * of the `audit_events` table, its 3 registry tables, and the 2 compat
 * views (v126-v128).
 *
 * Everything Phase 9C shipped was verified against PGLite only (see
 * test/audit-event-foundation.test.ts, test/audit-event-schema-parity.test.ts,
 * test/audit-event-rollback-pglite.test.ts) because Docker/Postgres was not
 * reliably available during development. This file closes that gap the same
 * way test/e2e/principal-postgres.test.ts closed it for Phase 9B, and is
 * deliberately structured to mirror that file. It covers, against a REAL
 * disposable Postgres instance (docker-compose.test.yml,
 * postgres://postgres:postgres@localhost:5434/gbrain_test):
 *
 *   - RLS is genuinely enabled (pg_class.relrowsecurity) on audit_events,
 *     the 3 registry tables (v126), and principals/principal_kinds (v128) —
 *     none of this is exercisable on PGLite, which has no RLS concept at all
 *     (PHASE9C-MIGRATION-AND-COMPATIBILITY-PLAN.md §2-1/§2-3).
 *   - All 7 documented indexes on audit_events exist, and the 4 documented
 *     partial indexes (idx_audit_events_principal/client/job/denied) carry a
 *     genuine WHERE predicate (pg_index.indpred), while the other 3 do not.
 *   - TEXT[] (scopes_snapshot) and JSONB (params_summary, adapter) round-trip
 *     through a real INSERT/SELECT, including empty-array and null-jsonb
 *     edge shapes.
 *   - The documented manual rollback SQL (PHASE9C-MIGRATION-AND-
 *     COMPATIBILITY-PLAN.md §6-2) executed via postgres.js's
 *     sql.begin(async tx => {...}) (§6-3's second paragraph, mirroring
 *     Phase 9B's test/e2e/principal-postgres.test.ts precedent): version
 *     reverts to 125, every Phase 9C object is gone, mcp_request_log
 *     survives untouched, and v126-v128 re-apply cleanly.
 *
 * Run: DATABASE_URL=postgresql://postgres:postgres@localhost:5434/gbrain_test \
 *      bun test test/e2e/audit-event-postgres.test.ts
 *
 * Skips gracefully when DATABASE_URL is unset (matches the existing E2E
 * pattern in test/e2e/principal-postgres.test.ts / test/e2e/schema-drift.test.ts).
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL;
const describeE2E = skip ? describe.skip : describe;

if (skip) {
  console.log('Skipping E2E Audit Event/Postgres verification (DATABASE_URL not set)');
}

/** Same safety floor as test/e2e/principal-postgres.test.ts / schema-drift.test.ts:
 * only ever DROP SCHEMA / CREATE DATABASE against an obviously-test-shaped,
 * local database. */
function resetAllowedFor(url: URL): boolean {
  const dbName = url.pathname.replace(/^\//, '');
  const host = url.hostname;
  const isLocalhost = host === 'localhost' || host === '127.0.0.1' || host.endsWith('.local');
  const looksLikeTestDb = /^(gbrain_test|.*_test|test_.*|.*_e2e)$/i.test(dbName);
  const ciOptIn = process.env.GBRAIN_TEST_DB === '1';
  return looksLikeTestDb && (isLocalhost || ciOptIn);
}

type PgSql = ((strings: TemplateStringsArray, ...values: unknown[]) => Promise<any[]>) & {
  unsafe: (query: string) => Promise<any[]>;
  begin: <T>(fn: (tx: PgSql) => Promise<T>) => Promise<T>;
};

function pgSqlOf(engine: PostgresEngine): PgSql {
  return (engine as any).sql as PgSql;
}

/** The rollback SQL exactly as published in
 * PHASE9C-MIGRATION-AND-COMPATIBILITY-PLAN.md §6-2 (BEGIN/COMMIT stripped —
 * sql.begin() supplies the transaction, per the note in
 * test/e2e/principal-postgres.test.ts about postgres.js refusing a raw
 * multi-statement BEGIN/COMMIT string over a pooled connection). */
const ROLLBACK_STATEMENTS = [
  'DROP VIEW IF EXISTS audit_events_attribution_gaps',
  'DROP VIEW IF EXISTS audit_events_compat',
  'DROP TABLE IF EXISTS audit_events',
  'DROP TABLE IF EXISTS audit_attribution_states',
  'DROP TABLE IF EXISTS audit_channels',
  'DROP TABLE IF EXISTS audit_event_kinds',
  "UPDATE config SET value = '125' WHERE key = 'version'",
];

describeE2E('Phase 9C: Universal Audit Event Integration against real Postgres', () => {
  let pg: PostgresEngine;
  let sql: ReturnType<typeof pgSqlOf>;

  beforeAll(async () => {
    const url = new URL(DATABASE_URL!);
    if (!resetAllowedFor(url)) {
      throw new Error(`DATABASE_URL db name "${url.pathname}" is not test-shaped; refusing to run (see resetAllowedFor).`);
    }

    pg = new PostgresEngine();
    await pg.connect({ database_url: DATABASE_URL! });
    sql = pgSqlOf(pg);
    await sql.unsafe('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    await pg.initSchema(); // real fresh install: bootstrap + schema replay + migrations through v128
  }, 60_000);

  afterAll(async () => {
    if (pg) await pg.disconnect();
  });

  test('fresh schema: audit_events, the 3 registries, and the 2 compat views all exist', async () => {
    const objects = await sql`
      SELECT to_regclass('public.audit_events') AS audit_events,
             to_regclass('public.audit_event_kinds') AS audit_event_kinds,
             to_regclass('public.audit_channels') AS audit_channels,
             to_regclass('public.audit_attribution_states') AS audit_attribution_states,
             to_regclass('public.audit_events_compat') AS audit_events_compat,
             to_regclass('public.audit_events_attribution_gaps') AS audit_events_attribution_gaps
    `;
    for (const [key, value] of Object.entries(objects[0])) {
      expect(value, `${key} should exist`).not.toBeNull();
    }
  });

  test('RLS is genuinely enabled on audit_events, its 3 registries (v126), and principals/principal_kinds (v128)', async () => {
    const rows = await sql`
      SELECT relname, relrowsecurity
      FROM pg_class
      WHERE relname IN ('audit_events', 'audit_event_kinds', 'audit_channels', 'audit_attribution_states', 'principals', 'principal_kinds')
        AND relnamespace = 'public'::regnamespace
      ORDER BY relname
    `;
    expect(rows.length).toBe(6);
    for (const row of rows as any[]) {
      expect(row.relrowsecurity, `${row.relname}.relrowsecurity should be true`).toBe(true);
    }
  });

  test('all 7 documented indexes on audit_events exist; the 4 documented partial indexes carry a real predicate, the other 3 do not', async () => {
    const rows = await sql`
      SELECT c.relname AS indexname, (i.indpred IS NOT NULL) AS is_partial
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      JOIN pg_class t ON t.oid = i.indrelid
      WHERE t.relname = 'audit_events' AND t.relnamespace = 'public'::regnamespace
      ORDER BY c.relname
    `;
    const byName = new Map((rows as any[]).map((r) => [r.indexname, r.is_partial]));

    const partial = ['idx_audit_events_principal', 'idx_audit_events_client', 'idx_audit_events_job', 'idx_audit_events_denied'];
    const full = ['idx_audit_events_occurred', 'idx_audit_events_correlation', 'idx_audit_events_channel'];

    for (const name of partial) {
      expect(byName.has(name), `${name} should exist`).toBe(true);
      expect(byName.get(name), `${name} should be a partial index`).toBe(true);
    }
    for (const name of full) {
      expect(byName.has(name), `${name} should exist`).toBe(true);
      expect(byName.get(name), `${name} should NOT be a partial index`).toBe(false);
    }
  });

  test('TEXT[] scopes_snapshot and JSONB params_summary/adapter round-trip through a real INSERT/SELECT', async () => {
    await sql.unsafe(`
      INSERT INTO audit_events (
        occurred_at, event_kind, channel_id, attribution_state, operation,
        decision, outcome, correlation_id, scopes_snapshot, params_summary, adapter
      ) VALUES (
        now(), 'operation.request', 'mcp_http', 'client_only', 'pg-e2e-roundtrip-op',
        'allowed', 'succeeded', 'corr-pg-roundtrip-1',
        ARRAY['read','write']::text[],
        '{"tool":"search","args":{"q":"pg-e2e"}}'::jsonb,
        '{"ip":"127.0.0.1","ua":"pg-e2e-test"}'::jsonb
      )
    `);

    const rows = await sql`
      SELECT scopes_snapshot, params_summary, adapter
      FROM audit_events WHERE correlation_id = ${'corr-pg-roundtrip-1'}
    `;
    expect(rows.length).toBe(1);
    const row = rows[0] as any;
    expect([...row.scopes_snapshot].sort()).toEqual(['read', 'write']);
    expect(row.params_summary).toEqual({ tool: 'search', args: { q: 'pg-e2e' } });
    expect(row.adapter).toEqual({ ip: '127.0.0.1', ua: 'pg-e2e-test' });
  });

  test('empty TEXT[] and absent JSONB round-trip as [] and null/default, not as NULL-vs-[] ambiguity', async () => {
    await sql.unsafe(`
      INSERT INTO audit_events (
        occurred_at, event_kind, channel_id, attribution_state, operation,
        decision, outcome, correlation_id, scopes_snapshot
      ) VALUES (
        now(), 'operation.request', 'mcp_http', 'client_only', 'pg-e2e-empty-op',
        'allowed', 'succeeded', 'corr-pg-roundtrip-2',
        ARRAY[]::text[]
      )
    `);

    const rows = await sql`
      SELECT scopes_snapshot, params_summary, adapter
      FROM audit_events WHERE correlation_id = ${'corr-pg-roundtrip-2'}
    `;
    expect(rows.length).toBe(1);
    const row = rows[0] as any;
    expect(row.scopes_snapshot).toEqual([]);
    expect(row.params_summary).toBeNull();
    expect(row.adapter).toEqual({}); // NOT NULL DEFAULT '{}'
  });

  test('manual rollback SQL (PHASE9C-MIGRATION-AND-COMPATIBILITY-PLAN.md §6-2), executed via sql.begin(): version reverts to 125, every Phase 9C object is gone, mcp_request_log survives, and v126-v128 re-apply cleanly', async () => {
    await sql`INSERT INTO mcp_request_log (token_name, agent_name, operation, status) VALUES ('pg-rollback-legacy-token', 'pg-rollback-legacy-agent', 'search', 'success')`;

    const preVersion = await sql`SELECT value FROM config WHERE key = 'version'`;
    expect(Number(preVersion[0].value)).toBeGreaterThanOrEqual(128);

    // postgres.js refuses a raw multi-statement BEGIN/COMMIT string over a
    // pooled connection (UNSAFE_TRANSACTION). sql.begin(...) reserves a
    // single connection and runs the callback's statements as a real
    // transaction — the same approach test/e2e/principal-postgres.test.ts
    // uses for Phase 9B's own §4-2 rollback, and what §6-3's second
    // paragraph calls for here.
    await sql.begin(async (tx: typeof sql) => {
      for (const stmt of ROLLBACK_STATEMENTS) {
        await tx.unsafe(stmt);
      }
    });

    const postVersion = await sql`SELECT value FROM config WHERE key = 'version'`;
    expect(postVersion[0].value).toBe('125');

    const gone = await sql`
      SELECT to_regclass('public.audit_events') AS audit_events,
             to_regclass('public.audit_event_kinds') AS audit_event_kinds,
             to_regclass('public.audit_channels') AS audit_channels,
             to_regclass('public.audit_attribution_states') AS audit_attribution_states,
             to_regclass('public.audit_events_compat') AS audit_events_compat,
             to_regclass('public.audit_events_attribution_gaps') AS audit_events_attribution_gaps
    `;
    for (const [key, value] of Object.entries(gone[0])) {
      expect(value, `${key} should be gone after rollback`).toBeNull();
    }

    const legacyRows = await sql`SELECT token_name, agent_name, operation, status FROM mcp_request_log WHERE token_name = 'pg-rollback-legacy-token'`;
    expect(legacyRows.length).toBe(1);
    expect(legacyRows[0]).toMatchObject({
      token_name: 'pg-rollback-legacy-token',
      agent_name: 'pg-rollback-legacy-agent',
      operation: 'search',
      status: 'success',
    });

    // v126-v128 re-apply cleanly (real upgrade path).
    await pg.initSchema();

    const versionAfterReapply = await sql`SELECT value FROM config WHERE key = 'version'`;
    expect(Number(versionAfterReapply[0].value)).toBeGreaterThanOrEqual(128);

    const restored = await sql`
      SELECT to_regclass('public.audit_events') AS audit_events,
             to_regclass('public.audit_event_kinds') AS audit_event_kinds,
             to_regclass('public.audit_channels') AS audit_channels,
             to_regclass('public.audit_attribution_states') AS audit_attribution_states,
             to_regclass('public.audit_events_compat') AS audit_events_compat,
             to_regclass('public.audit_events_attribution_gaps') AS audit_events_attribution_gaps
    `;
    for (const [key, value] of Object.entries(restored[0])) {
      expect(value, `${key} should be restored after initSchema() re-run`).not.toBeNull();
    }

    // Registries are freshly re-seeded (15 kinds), not resurrected state —
    // the pre-rollback audit_events row (if any survived until this point)
    // is confirmed gone for good, same pin as
    // test/audit-event-rollback-pglite.test.ts's §6-1 regression test.
    const kindRows = await sql`SELECT count(*)::int AS n FROM audit_event_kinds`;
    expect(kindRows[0].n).toBe(15);
    const rlsAfterReapply = await sql`SELECT relrowsecurity FROM pg_class WHERE relname = 'audit_events' AND relnamespace = 'public'::regnamespace`;
    expect(rlsAfterReapply[0].relrowsecurity).toBe(true);
  }, 30_000);
});
