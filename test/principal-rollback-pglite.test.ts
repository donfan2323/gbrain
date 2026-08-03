/**
 * Phase 9B (REQUIRED-7 remediation) — mechanical verification that the
 * documented manual rollback procedure actually works.
 *
 * PHASE9B-MIGRATION-AND-ROLLBACK.md section 4-2 publishes a rollback SQL
 * block operators are told to run to back v125 out of a live brain. This
 * file executes that block VERBATIM against a disposable in-memory PGLite
 * brain and proves the four claims the document makes:
 *
 *   1. (4-2) The block runs cleanly on a real v125 schema and leaves
 *      config.version at exactly '124'.
 *   2. (4-2) Every Phase 9B object is genuinely gone afterwards:
 *      principal_kinds, principals, oauth_clients.principal_id, and
 *      idx_oauth_clients_principal_id.
 *   3. (4-4) "ロールバック後も既存のOAuthクライアント・トークンはそのまま
 *      機能する" — a client registered BEFORE the rollback still
 *      authenticates afterwards, with principalId/principalKind degrading to
 *      undefined. This reaches verifyAccessToken's fallback chain (already
 *      unit-tested in test/oauth-fallback-pre-phase9b.test.ts) via a genuine
 *      rollback rather than a hand-constructed pre-migration state.
 *   4. The rollback is not one-way: re-running initSchema() re-applies v125
 *      and restores full Principal functionality, not merely the version
 *      stamp.
 *
 * PGLite only — see PHASE9B-POSTGRES-*.txt for what was/wasn't verifiable
 * against real Postgres in this sandbox.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { tmpdir } from 'os';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';

function makeSqlTag(engine: PGLiteEngine) {
  return async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.reduce((acc, str, i) => acc + str + (i < values.length ? `$${i + 1}` : ''), '');
    return engine.executeRaw(query, values as unknown[]);
  };
}

/** The rollback SQL exactly as published in PHASE9B-MIGRATION-AND-ROLLBACK.md 4-2. */
const DOCUMENTED_ROLLBACK_SQL = `
BEGIN;

-- 1. oauth_clientsからFK列を削除(principalsテーブルへの依存を先に断つ)
ALTER TABLE oauth_clients DROP COLUMN IF EXISTS principal_id;

-- 2. 念のためインデックスを個別にも削除(列削除で自動的に削除されるはずだが明示)
DROP INDEX IF EXISTS idx_oauth_clients_principal_id;

-- 3. principalsテーブルを削除(principal_kindsへの依存を先に断つ)
DROP TABLE IF EXISTS principals;

-- 4. principal_kindsテーブルを削除
DROP TABLE IF EXISTS principal_kinds;

-- 5. スキーマバージョンを125→124に巻き戻す
UPDATE config SET value = '124' WHERE key = 'version';

COMMIT;
`;

/**
 * Phase 9C (migrate.ts v126-v128) added audit_events.principal_id, an FK
 * to principals — this test's engine runs initSchema() to LATEST_VERSION
 * (currently 128), so DOCUMENTED_ROLLBACK_SQL's `DROP TABLE principals`
 * now fails with 2BP01 unless Phase 9C's own objects are rolled back
 * first (PHASE9B-MIGRATION-AND-ROLLBACK.md §4-1 v5 addendum;
 * PHASE9C-MIGRATION-AND-COMPATIBILITY-PLAN.md §6-2 for the source SQL).
 * This mirrors what a real operator must do: newest layer first.
 */
const PHASE9C_ROLLBACK_SQL = `
BEGIN;

DROP VIEW IF EXISTS audit_events_attribution_gaps;
DROP VIEW IF EXISTS audit_events_compat;
DROP TABLE IF EXISTS audit_events;
DROP TABLE IF EXISTS audit_attribution_states;
DROP TABLE IF EXISTS audit_channels;
DROP TABLE IF EXISTS audit_event_kinds;

UPDATE config SET value = '125' WHERE key = 'version';

COMMIT;
`;

describe('REQUIRED-7: the documented manual rollback procedure, executed for real on PGLite', () => {
  let engine: PGLiteEngine;
  let sql: ReturnType<typeof makeSqlTag>;
  let provider: GBrainOAuthProvider;

  /** Registered BEFORE the rollback; re-used AFTER it to prove survival. */
  const preExisting: { clientId: string; clientSecret: string; principalId: string } = {
    clientId: '',
    clientSecret: '',
    principalId: '',
  };

  const schemaVersion = async (): Promise<number> => {
    const rows = await sql`SELECT value FROM config WHERE key = 'version'`;
    return Number((rows[0] as { value: string }).value);
  };

  const tableExists = async (name: string): Promise<boolean> => {
    const rows = await sql`SELECT to_regclass(${'public.' + name}) AS reg`;
    return (rows[0] as { reg: string | null }).reg !== null;
  };

  const columnCount = async (table: string, column: string): Promise<number> => {
    const rows = await sql`
      SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ${table} AND column_name = ${column}
    `;
    return (rows[0] as { n: number }).n;
  };

  const indexCount = async (indexName: string): Promise<number> => {
    const rows = await sql`
      SELECT count(*)::int AS n FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = ${indexName}
    `;
    return (rows[0] as { n: number }).n;
  };

  let dbDir: string;

  beforeAll(async () => {
    // A real database_path (rather than the default in-memory connection)
    // makes the `!dataDir` guard in pglite-engine.ts's connect() skip the
    // GBRAIN_PGLITE_SNAPSHOT fast-restore path unconditionally, so claim 4's
    // second initSchema() call genuinely replays bootstrap + schema +
    // migrations after the rollback strips Phase 9B objects, instead of
    // risking a snapshot short-circuit turning it into a no-op — without
    // needing to mutate process.env (scripts/check-test-isolation.sh R1).
    dbDir = mkdtempSync(join(tmpdir(), 'principal-rollback-pglite-'));
    engine = new PGLiteEngine();
    await engine.connect({ database_path: dbDir });
    await engine.initSchema(); // full, fresh v125 schema
    sql = makeSqlTag(engine);
    provider = new GBrainOAuthProvider({ sql, tokenTtl: 60, refreshTtl: 300 });
  }, 30_000);

  afterAll(async () => {
    await engine.disconnect();
    rmSync(dbDir, { recursive: true, force: true });
  });

  test('pre-rollback baseline: v125 is live and a Principal-linked client authenticates with full attribution', async () => {
    expect(await schemaVersion()).toBeGreaterThanOrEqual(125);
    expect(await tableExists('principal_kinds')).toBe(true);
    expect(await tableExists('principals')).toBe(true);
    expect(await columnCount('oauth_clients', 'principal_id')).toBe(1);
    expect(await indexCount('idx_oauth_clients_principal_id')).toBe(1);

    const [{ id: principalId }] = (await sql`
      INSERT INTO principals (kind_id, display_name) VALUES ('human', 'rollback-pre-existing-owner') RETURNING id
    `) as Array<{ id: string }>;

    const { clientId, clientSecret } = await provider.registerClientManual(
      'rollback-pre-existing-client', ['client_credentials'], 'read write',
    );
    await sql`UPDATE oauth_clients SET principal_id = ${principalId} WHERE client_id = ${clientId}`;

    const tokens = await provider.exchangeClientCredentials(clientId, clientSecret!, 'read write');
    const auth = await provider.verifyAccessToken(tokens.access_token);

    expect(auth.clientId).toBe(clientId);
    expect((auth as any).principalId).toBe(principalId);
    expect((auth as any).principalKind).toBe('human');
    expect(auth.scopes.sort()).toEqual(['read', 'write']);

    preExisting.clientId = clientId;
    preExisting.clientSecret = clientSecret!;
    preExisting.principalId = principalId;
  });

  test('executing the documented 4-2 rollback SQL verbatim reverts config.version to 124 and removes every Phase 9B object', async () => {
    expect(await schemaVersion()).toBeGreaterThanOrEqual(126);
    expect(await tableExists('audit_events')).toBe(true);

    // Phase 9C first (newest layer), per the v5 addendum — then Phase 9B's
    // documented SQL verbatim, unmodified from what operators are told to run.
    await engine.db.exec(PHASE9C_ROLLBACK_SQL);
    expect(await tableExists('audit_events')).toBe(false);
    expect(await tableExists('audit_event_kinds')).toBe(false);

    // Multi-statement block (BEGIN/…/COMMIT) — needs .exec(), which is
    // PGLite's documented multi-statement runner (.query() is single-statement).
    await engine.db.exec(DOCUMENTED_ROLLBACK_SQL);

    const rows = await sql`SELECT value FROM config WHERE key = 'version'`;
    expect((rows[0] as { value: string }).value).toBe('124');

    expect(await tableExists('principal_kinds')).toBe(false);
    expect(await tableExists('principals')).toBe(false);
    expect(await columnCount('oauth_clients', 'principal_id')).toBe(0);
    expect(await indexCount('idx_oauth_clients_principal_id')).toBe(0);

    // Not just absent from the catalogs — actually unqueryable.
    await expect(sql`SELECT 1 FROM principals`).rejects.toThrow();
    await expect(sql`SELECT 1 FROM principal_kinds`).rejects.toThrow();
    await expect(sql`SELECT principal_id FROM oauth_clients`).rejects.toThrow();
  });

  test('4-4 claim: an OAuth client registered BEFORE the rollback still authenticates after it, degrading attribution to undefined', async () => {
    // Same credentials issued in the first test, against the now-rolled-back schema.
    const tokens = await provider.exchangeClientCredentials(
      preExisting.clientId, preExisting.clientSecret, 'read write',
    );
    const auth = await provider.verifyAccessToken(tokens.access_token);

    expect(auth.clientId).toBe(preExisting.clientId);
    expect((auth as any).clientName).toBe('rollback-pre-existing-client');
    expect(auth.scopes.sort()).toEqual(['read', 'write']);
    // Principal tables are gone: verifyAccessToken falls back rather than throwing.
    expect((auth as any).principalId).toBeUndefined();
    expect((auth as any).principalKind).toBeUndefined();
    // source_id/federated_read compatibility is untouched by a Phase 9B rollback.
    expect((auth as any).sourceId).toBe('default');
  });

  test('the rollback is reversible: re-running initSchema() re-applies v125 and restores full Principal functionality', async () => {
    await engine.initSchema();

    expect(await schemaVersion()).toBeGreaterThanOrEqual(125);
    expect(await tableExists('principal_kinds')).toBe(true);
    expect(await tableExists('principals')).toBe(true);
    expect(await columnCount('oauth_clients', 'principal_id')).toBe(1);
    expect(await indexCount('idx_oauth_clients_principal_id')).toBe(1);

    const kindRows = (await sql`SELECT id FROM principal_kinds ORDER BY id`) as Array<{ id: string }>;
    expect(kindRows.map((r) => r.id)).toEqual(['agent', 'device', 'human', 'service', 'unknown']);

    // The pre-existing client survived the round trip and is still unattributed
    // (its principal_id was destroyed by the rollback, not resurrected by it).
    const preRows = (await sql`
      SELECT principal_id FROM oauth_clients WHERE client_id = ${preExisting.clientId}
    `) as Array<{ principal_id: string | null }>;
    expect(preRows.length).toBe(1);
    expect(preRows[0].principal_id).toBeNull();

    // And a brand-new end-to-end Principal linkage works exactly as it did pre-rollback.
    const [{ id: principalId }] = (await sql`
      INSERT INTO principals (kind_id, display_name) VALUES ('service', 'post-restore-owner') RETURNING id
    `) as Array<{ id: string }>;
    const { clientId, clientSecret } = await provider.registerClientManual(
      'rollback-post-restore-client', ['client_credentials'], 'read write',
    );
    await sql`UPDATE oauth_clients SET principal_id = ${principalId} WHERE client_id = ${clientId}`;

    const tokens = await provider.exchangeClientCredentials(clientId, clientSecret!, 'read write');
    const auth = await provider.verifyAccessToken(tokens.access_token);

    expect(auth.clientId).toBe(clientId);
    expect((auth as any).principalId).toBe(principalId);
    expect((auth as any).principalKind).toBe('service');
    expect(auth.scopes.sort()).toEqual(['read', 'write']);
  }, 30_000);
});
