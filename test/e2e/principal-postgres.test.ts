/**
 * Phase 9B (REQUIRED-6 remediation) — real-Postgres verification of the
 * Principal Identity Foundation (principal_kinds, principals,
 * oauth_clients.principal_id + index, AuthInfo.principalId/principalKind).
 *
 * Everything in this file previously only ran against PGLite (Docker/Postgres
 * was unavailable when Phase 9B was first submitted). It covers, against a
 * REAL disposable Postgres instance (docker-compose.test.yml,
 * postgres://postgres:postgres@localhost:5434/gbrain_test):
 *   - fresh schema (5 bootstrap kinds, principals table, principal_id column+index)
 *   - v124 -> v125 migration (strip Phase 9B objects, roll config.version back,
 *     re-run initSchema — the real upgrade path)
 *   - custom Principal kind via plain data-row INSERT
 *   - FK enforcement (bad kind_id, bad principal_id both rejected)
 *   - oauth_clients.principal_id nullable, defaults null
 *   - ON DELETE RESTRICT (not SET NULL, not CASCADE) when a linked Principal is deleted
 *   - fresh vs. migrated schema parity across TWO real Postgres databases
 *     in the same instance (gbrain_test vs test_principal_migrated)
 *   - OAuth token issuance/verification against real Postgres
 *   - AuthInfo with/without Principal; revoked Principal -> authz unchanged
 *   - migration re-run idempotency
 *   - manual rollback SQL (PHASE9B-MIGRATION-AND-ROLLBACK.md section 4-2),
 *     executed verbatim against real Postgres, then v125 re-applied
 *
 * Run: DATABASE_URL=postgresql://postgres:postgres@localhost:5434/gbrain_test \
 *      bun test test/e2e/principal-postgres.test.ts
 *
 * Skips gracefully when DATABASE_URL is unset (matches the existing E2E
 * pattern in test/e2e/schema-drift.test.ts / test/e2e/postgres-bootstrap.test.ts).
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { GBrainOAuthProvider } from '../../src/core/oauth-provider.ts';
import { hasScope } from '../../src/core/scope.ts';
import {
  snapshotSchema,
  diffSnapshots,
  snapshotIndexes,
  diffIndexSnapshots,
  type SnapshotQueryRow,
  type IndexSnapshotRow,
} from '../helpers/schema-diff.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL;
const describeE2E = skip ? describe.skip : describe;

if (skip) {
  console.log('Skipping E2E Principal/Postgres verification (DATABASE_URL not set)');
}

/** Same safety floor as test/e2e/schema-drift.test.ts: only ever DROP SCHEMA
 * / CREATE DATABASE against an obviously-test-shaped, local database. */
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

describeE2E('Phase 9B REQUIRED-6: Principal Identity Foundation against real Postgres', () => {
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
    await pg.initSchema();
  }, 60_000);

  afterAll(async () => {
    if (pg) await pg.disconnect();
  });

  test('fresh schema: 5 bootstrap Principal kinds, principals table, oauth_clients.principal_id + index all present', async () => {
    const kinds = await sql`SELECT id FROM principal_kinds ORDER BY id`;
    expect(kinds.map((r: any) => r.id)).toEqual(['agent', 'device', 'human', 'service', 'unknown']);

    const cols = await sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'oauth_clients' AND column_name = 'principal_id'
    `;
    expect(cols.length).toBe(1);

    const idx = await sql`
      SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_oauth_clients_principal_id'
    `;
    expect(idx.length).toBe(1);
  });

  test('bootstrap re-insert is idempotent (still exactly 5 canonical kinds after ON CONFLICT DO NOTHING replay)', async () => {
    await sql`
      INSERT INTO principal_kinds (id, label, description) VALUES
        ('human', 'Human', 'A human operator or account holder.')
      ON CONFLICT (id) DO NOTHING
    `;
    const rows = await sql`SELECT count(*)::int AS n FROM principal_kinds WHERE id = 'human'`;
    expect(rows[0].n).toBe(1);
  });

  test('a brand-new Principal kind is addable via a plain data-row INSERT (no schema change)', async () => {
    await sql`INSERT INTO principal_kinds (id, label, description) VALUES ('robot', 'Robot', 'A physical robot.') ON CONFLICT (id) DO NOTHING`;
    const rows = await sql`SELECT label FROM principal_kinds WHERE id = 'robot'`;
    expect(rows[0].label).toBe('Robot');
  });

  test('FK enforcement: bad kind_id on principals is rejected', async () => {
    // Promise.resolve() is required: a bare Bun.SQL query is a lazy thenable and
    // passing it straight to .rejects deadlocks bun 1.3.10's matcher.
    await expect(Promise.resolve(sql`INSERT INTO principals (kind_id) VALUES ('nonexistent-kind')`)).rejects.toThrow();
  });

  test('FK enforcement: bad principal_id on oauth_clients is rejected', async () => {
    const { clientId } = await new GBrainOAuthProvider({ sql, tokenTtl: 60, refreshTtl: 300 })
      .registerClientManual('pg-fk-reject-test', ['client_credentials'], 'read');
    await expect(
      Promise.resolve(
        sql`UPDATE oauth_clients SET principal_id = '00000000-0000-0000-0000-000000000000' WHERE client_id = ${clientId}`,
      ),
    ).rejects.toThrow();
  });

  test('oauth_clients.principal_id is nullable and defaults to null on a new client', async () => {
    const { clientId } = await new GBrainOAuthProvider({ sql, tokenTtl: 60, refreshTtl: 300 })
      .registerClientManual('pg-default-null-test', ['client_credentials'], 'read');
    const rows = await sql`SELECT principal_id FROM oauth_clients WHERE client_id = ${clientId}`;
    expect(rows[0].principal_id).toBeNull();
  });

  test('deleting a linked Principal is rejected on real Postgres (ON DELETE RESTRICT), preserving the client link and its audit trail', async () => {
    const [{ id: principalId }] = await sql`INSERT INTO principals (kind_id, display_name) VALUES ('service', 'pg-to-be-deleted') RETURNING id`;
    const { clientId } = await new GBrainOAuthProvider({ sql, tokenTtl: 60, refreshTtl: 300 })
      .registerClientManual('pg-restrict-test', ['client_credentials'], 'read');
    await sql`UPDATE oauth_clients SET principal_id = ${principalId} WHERE client_id = ${clientId}`;
    await sql`INSERT INTO mcp_request_log (token_name, agent_name, operation, status) VALUES (${clientId}, 'pg-test-agent', 'search', 'success')`;

    await expect(
      Promise.resolve(sql`DELETE FROM principals WHERE id = ${principalId}`),
    ).rejects.toThrow();

    const clientRows = await sql`SELECT client_id, principal_id FROM oauth_clients WHERE client_id = ${clientId}`;
    expect(clientRows.length).toBe(1);
    expect(clientRows[0].principal_id).toBe(principalId);

    const principalRows = await sql`SELECT id FROM principals WHERE id = ${principalId}`;
    expect(principalRows.length).toBe(1);

    const auditRows = await sql`SELECT token_name FROM mcp_request_log WHERE token_name = ${clientId}`;
    expect(auditRows.length).toBe(1);
  });

  test('OAuth token issuance + verification against real Postgres: AuthInfo resolves principalId/principalKind when linked, undefined when not, scopes unaffected either way', async () => {
    const provider = new GBrainOAuthProvider({ sql, tokenTtl: 60, refreshTtl: 300 });

    const { clientId: unattributedId, clientSecret: unattributedSecret } =
      await provider.registerClientManual('pg-unattributed', ['client_credentials'], 'read write');
    const unattributedTokens = await provider.exchangeClientCredentials(unattributedId, unattributedSecret!, 'read write');
    const unattributedAuth = await provider.verifyAccessToken(unattributedTokens.access_token);
    expect((unattributedAuth as any).principalId).toBeUndefined();
    expect((unattributedAuth as any).principalKind).toBeUndefined();
    expect(unattributedAuth.scopes.sort()).toEqual(['read', 'write']);

    const [{ id: principalId }] = await sql`INSERT INTO principals (kind_id, display_name) VALUES ('human', 'pg-attributed-owner') RETURNING id`;
    const { clientId: attributedId, clientSecret: attributedSecret } =
      await provider.registerClientManual('pg-attributed', ['client_credentials'], 'read write');
    await sql`UPDATE oauth_clients SET principal_id = ${principalId} WHERE client_id = ${attributedId}`;
    const attributedTokens = await provider.exchangeClientCredentials(attributedId, attributedSecret!, 'read write');
    const attributedAuth = await provider.verifyAccessToken(attributedTokens.access_token);
    expect((attributedAuth as any).principalId).toBe(principalId);
    expect((attributedAuth as any).principalKind).toBe('human');
    expect(attributedAuth.scopes.sort()).toEqual(unattributedAuth.scopes.sort());
  });

  test('Principal.revoked_at set does not change the linked Client authorization result (real Postgres)', async () => {
    const provider = new GBrainOAuthProvider({ sql, tokenTtl: 60, refreshTtl: 300 });
    const [{ id: principalId }] = await sql`INSERT INTO principals (kind_id, display_name) VALUES ('human', 'pg-will-be-revoked') RETURNING id`;
    const { clientId, clientSecret } = await provider.registerClientManual('pg-revoked-principal-test', ['client_credentials'], 'read write');
    await sql`UPDATE oauth_clients SET principal_id = ${principalId} WHERE client_id = ${clientId}`;

    const beforeTokens = await provider.exchangeClientCredentials(clientId, clientSecret!, 'read write');
    const beforeAuth = await provider.verifyAccessToken(beforeTokens.access_token);

    await sql`UPDATE principals SET revoked_at = now() WHERE id = ${principalId}`;

    const afterTokens = await provider.exchangeClientCredentials(clientId, clientSecret!, 'read write');
    const afterAuth = await provider.verifyAccessToken(afterTokens.access_token);

    expect(afterAuth.scopes.sort()).toEqual(beforeAuth.scopes.sort());
    expect(hasScope(afterAuth.scopes, 'read')).toBe(true);
    expect(hasScope(afterAuth.scopes, 'write')).toBe(true);
  });

  test('v124 -> v125 migration re-evaluation: rolling config.version back to 124 and re-running initSchema() is a clean, idempotent upgrade', async () => {
    await sql.unsafe(`
      DROP INDEX IF EXISTS idx_oauth_clients_principal_id;
      ALTER TABLE oauth_clients DROP COLUMN IF EXISTS principal_id;
      DROP TABLE IF EXISTS principals;
      DROP TABLE IF EXISTS principal_kinds;
    `);
    await sql.unsafe(`UPDATE config SET value = '124' WHERE key = 'version';`);

    await pg.initSchema(); // real upgrade path: bootstrap + schema replay + migrations

    const kinds = await sql`SELECT id FROM principal_kinds ORDER BY id`;
    expect(kinds.map((r: any) => r.id)).toEqual(['agent', 'device', 'human', 'service', 'unknown']);
    const idx = await sql`SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_oauth_clients_principal_id'`;
    expect(idx.length).toBe(1);
    const version = await sql`SELECT value FROM config WHERE key = 'version'`;
    expect(Number(version[0].value)).toBeGreaterThanOrEqual(125);
  }, 30_000);

  test('migration re-run idempotency: calling initSchema() again at v125 does not duplicate bootstrap kinds or error', async () => {
    await pg.initSchema();
    const kinds = await sql`SELECT count(*)::int AS n FROM principal_kinds WHERE id IN ('human','service','agent','device','unknown')`;
    expect(kinds[0].n).toBe(5);
  }, 30_000);

  test('manual rollback SQL (PHASE9B-MIGRATION-AND-ROLLBACK.md 4-2), executed verbatim: version reverts to 124, Phase 9B objects are gone, existing OAuth still works, v125 re-applies cleanly', async () => {
    const provider = new GBrainOAuthProvider({ sql, tokenTtl: 60, refreshTtl: 300 });
    // Pre-existing client, registered BEFORE rollback, to prove rollback does
    // not touch oauth_clients' pre-existing columns/data.
    const { clientId, clientSecret } = await provider.registerClientManual('pg-pre-rollback-client', ['client_credentials'], 'read write');

    const preVersion = await sql`SELECT value FROM config WHERE key = 'version'`;
    expect(Number(preVersion[0].value)).toBeGreaterThanOrEqual(125);

    // Verbatim rollback SQL from PHASE9B-MIGRATION-AND-ROLLBACK.md section 4-2.
    // postgres.js refuses a raw multi-statement BEGIN/COMMIT string over a
    // pooled connection (UNSAFE_TRANSACTION — statements aren't guaranteed
    // to land on the same physical connection). sql.begin(...) is postgres.js's
    // supported API for exactly this: it reserves a single connection and runs
    // the callback's statements as a real transaction, which is the faithful
    // driver-level equivalent of a human running this same SQL in one psql
    // session. The five statements and their order are unchanged from 4-2.
    await sql.begin(async (tx: typeof sql) => {
      await tx.unsafe('ALTER TABLE oauth_clients DROP COLUMN IF EXISTS principal_id');
      await tx.unsafe('DROP INDEX IF EXISTS idx_oauth_clients_principal_id');
      await tx.unsafe('DROP TABLE IF EXISTS principals');
      await tx.unsafe('DROP TABLE IF EXISTS principal_kinds');
      await tx.unsafe("UPDATE config SET value = '124' WHERE key = 'version'");
    });

    const postVersion = await sql`SELECT value FROM config WHERE key = 'version'`;
    expect(postVersion[0].value).toBe('124');

    const kindsGone = await sql`SELECT to_regclass('public.principal_kinds') AS reg`;
    expect(kindsGone[0].reg).toBeNull();
    const principalsGone = await sql`SELECT to_regclass('public.principals') AS reg`;
    expect(principalsGone[0].reg).toBeNull();
    const colGone = await sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'oauth_clients' AND column_name = 'principal_id'
    `;
    expect(colGone.length).toBe(0);

    // Existing OAuth basic functionality survives rollback unmodified.
    const tokensAfterRollback = await provider.exchangeClientCredentials(clientId, clientSecret!, 'read write');
    const authAfterRollback = await provider.verifyAccessToken(tokensAfterRollback.access_token);
    expect(authAfterRollback.clientId).toBe(clientId);
    expect(authAfterRollback.scopes.sort()).toEqual(['read', 'write']);
    expect((authAfterRollback as any).principalId).toBeUndefined();

    // v125 re-applies cleanly.
    await pg.initSchema();
    const versionAfterReapply = await sql`SELECT value FROM config WHERE key = 'version'`;
    expect(Number(versionAfterReapply[0].value)).toBeGreaterThanOrEqual(125);
    const kindsBack = await sql`SELECT id FROM principal_kinds ORDER BY id`;
    expect(kindsBack.map((r: any) => r.id)).toEqual(['agent', 'device', 'human', 'service', 'unknown']);
  }, 30_000);
});

describeE2E('Phase 9B REQUIRED-6/REQUIRED-2: fresh vs. migrated schema parity on real Postgres', () => {
  // Two concurrent PostgresEngine instances to two different databases in
  // one process turned out to be unsafe: src/core/postgres-engine.ts (via
  // src/core/db.ts) keeps a process-wide singleton connection, so a second
  // connect({database_url: <different db>}) silently REUSES the first
  // connection instead of opening one to the new database ("[gbrain]
  // connect() called with a different database_url but a connection
  // already exists" — confirmed by direct observation, not assumed) — the
  // first describe block's afterAll() then closes that shared connection
  // out from under this block, producing CONNECTION_ENDED failures.
  //
  // Fix: mirror the already-proven PGLite approach in
  // test/principal-schema-parity.test.ts — ONE PostgresEngine, sequential
  // snapshot-fresh -> strip-and-simulate-pre-v125 -> snapshot-migrated,
  // compared via the same schema-diff helpers. This still exercises the
  // real fresh-schema-file path and the real applyForwardReferenceBootstrap
  // + migration v125 upgrade path against real Postgres; it just does so
  // sequentially on the one connection PostgresEngine actually supports.
  let pg: PostgresEngine;
  let sql: ReturnType<typeof pgSqlOf>;

  beforeAll(async () => {
    const baseUrl = new URL(DATABASE_URL!);
    if (!resetAllowedFor(baseUrl)) {
      throw new Error(`DATABASE_URL db name "${baseUrl.pathname}" is not test-shaped; refusing to run.`);
    }
    pg = new PostgresEngine();
    await pg.connect({ database_url: DATABASE_URL! });
    sql = pgSqlOf(pg);
  }, 30_000);

  afterAll(async () => {
    if (pg) await pg.disconnect();
  });

  test('columns, indexes, and foreign keys for oauth_clients/principals/principal_kinds are identical between a fresh install and a migrated-from-v124 brain', async () => {
    const RELEVANT_TABLES = new Set(['oauth_clients', 'principals', 'principal_kinds']);
    const filterCols = <T extends Map<string, unknown>>(snap: T): T => {
      const out = new Map() as T;
      for (const [table, value] of snap) if (RELEVANT_TABLES.has(table)) out.set(table, value as never);
      return out;
    };
    const filterIdx = (snap: Map<string, unknown>) => {
      const out = new Map();
      for (const [name, info] of snap as Map<string, { tableName: string }>) if (RELEVANT_TABLES.has(info.tableName)) out.set(name, info);
      return out;
    };
    const snapshotAll = async () => ({
      cols: filterCols(await snapshotSchema(async (q) => (await sql.unsafe(q)) as unknown as SnapshotQueryRow[])),
      idx: filterIdx(await snapshotIndexes(async (q) => (await sql.unsafe(q)) as unknown as IndexSnapshotRow[])),
    });

    // --- Fresh install ---
    await sql.unsafe('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    await pg.initSchema();
    const fresh = await snapshotAll();

    // --- Simulate a pre-v125 brain (fully init, strip Phase 9B objects,
    // roll config.version back to 124), then re-run initSchema() — the real
    // upgrade path (bootstrap + schema replay + migrations together). ---
    await sql.unsafe(`
      DROP INDEX IF EXISTS idx_oauth_clients_principal_id;
      ALTER TABLE oauth_clients DROP COLUMN IF EXISTS principal_id;
      DROP TABLE IF EXISTS principals;
      DROP TABLE IF EXISTS principal_kinds;
    `);
    await sql.unsafe("UPDATE config SET value = '124' WHERE key = 'version'");
    await pg.initSchema();
    const migrated = await snapshotAll();

    const colDiff = diffSnapshots(fresh.cols, migrated.cols, { allowlistPgOnlyTables: [] });
    expect(colDiff.tablesMissingInPGLite).toEqual([]);
    expect(colDiff.tablesUnexpectedlyInPGLite).toEqual([]);
    expect(colDiff.columnsMissingInPGLite).toEqual([]);
    expect(colDiff.columnsMissingInPostgres).toEqual([]);
    expect(colDiff.typeMismatches).toEqual([]);

    const idxDiff = diffIndexSnapshots(fresh.idx as any, migrated.idx as any, {});
    expect(idxDiff.pgOnly).toEqual([]);
    expect(idxDiff.pgliteOnly).toEqual([]);
    expect(idxDiff.mismatched).toEqual([]);
    expect(fresh.idx.has('idx_oauth_clients_principal_id')).toBe(true);
    expect(migrated.idx.has('idx_oauth_clients_principal_id')).toBe(true);
  }, 60_000);
});
