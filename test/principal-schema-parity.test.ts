/**
 * Phase 9B (REQUIRED-2 remediation) — fresh-install vs. migrated-brain
 * schema parity for the Principal Identity Foundation objects
 * (principal_kinds, principals, oauth_clients.principal_id + its index).
 *
 * Two PGLite instances:
 *   - "fresh": brand-new engine, natural `initSchema()` (bootstrap no-op +
 *     schema replay creates the objects inline + migrations 1..125 run,
 *     all no-ops against the already-replayed schema).
 *   - "migrated": an engine that is first fully initialised (so it has the
 *     complete pre-Phase-9B v124 shape), then has every Phase 9B object
 *     surgically stripped (mirroring test/schema-bootstrap-coverage.test.ts's
 *     drop block) to look like a genuine pre-v125 brain, then has
 *     `initSchema()` re-run — the real-world upgrade path (every gbrain
 *     start calls `initSchema()`, which always runs bootstrap + schema
 *     replay + migrations together; there is no "migration-only" code path,
 *     confirmed by reading pglite-engine.ts/postgres-engine.ts).
 *
 * Both engines are created and torn down via the canonical beforeAll/
 * afterAll lifecycle (test/helpers/reset-pglite.ts JSDoc / CLAUDE.md R3+R4;
 * enforced by scripts/check-test-isolation.sh) even though this file needs
 * two independently-lifecycled engines rather than the single shared one
 * that pattern usually implies — all engine construction, DDL surgery, and
 * disconnects happen in beforeAll/afterAll; the test body only asserts.
 *
 * Compares columns (via schema-diff.ts's snapshotSchema/diffSnapshots),
 * indexes (via snapshotIndexes/diffIndexSnapshots), and foreign keys (via a
 * custom information_schema query) for exactly these 3 tables, and asserts
 * the two engines converge on an identical final shape.
 *
 * Postgres-side parity is NOT covered by this file (no Postgres available in
 * this sandbox — see PHASE9B-TEST-EVIDENCE.md / PHASE9B-POSTGRES-*.txt for
 * what could and could not be verified against real Postgres).
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { tmpdir } from 'os';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  snapshotSchema,
  diffSnapshots,
  snapshotIndexes,
  diffIndexSnapshots,
  type SnapshotQueryRow,
  type IndexSnapshotRow,
} from './helpers/schema-diff.ts';

const RELEVANT_TABLES = new Set(['oauth_clients', 'principals', 'principal_kinds']);

function filterSnapshotToRelevantTables<T extends Map<string, unknown>>(snap: T): T {
  const filtered = new Map() as T;
  for (const [table, value] of snap) {
    if (RELEVANT_TABLES.has(table)) filtered.set(table, value as never);
  }
  return filtered;
}

interface FkRow {
  table_name: string;
  column_name: string;
  foreign_table_name: string;
  foreign_column_name: string;
  delete_rule: string;
}

const FK_SNAPSHOT_SQL = `
  SELECT
    tc.table_name,
    kcu.column_name,
    ccu.table_name AS foreign_table_name,
    ccu.column_name AS foreign_column_name,
    rc.delete_rule
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
  JOIN information_schema.constraint_column_usage ccu
    ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
  JOIN information_schema.referential_constraints rc
    ON tc.constraint_name = rc.constraint_name AND tc.constraint_schema = rc.constraint_schema
  WHERE tc.constraint_type = 'FOREIGN KEY'
    AND tc.table_schema = 'public'
    AND tc.table_name IN ('oauth_clients', 'principals', 'principal_kinds')
  ORDER BY tc.table_name, kcu.column_name
`;

async function snapshotForeignKeys(pgliteDb: { query: (sql: string) => Promise<{ rows: FkRow[] }> }): Promise<FkRow[]> {
  const { rows } = await pgliteDb.query(FK_SNAPSHOT_SQL);
  return rows;
}

describe('Phase 9B: fresh vs. migrated schema parity (Principal objects)', () => {
  let fresh: PGLiteEngine;
  let migrated: PGLiteEngine;
  let freshDb: { query: (sql: string) => Promise<{ rows: any[] }> };
  let migratedDb: { query: (sql: string) => Promise<{ rows: any[] }> };
  let freshDir: string;
  let migratedDir: string;

  beforeAll(async () => {
    // Each engine gets its own on-disk data dir (mkdtemp'd, cleaned up in
    // afterAll below). A real database_path (rather than the default
    // in-memory connection) makes the `!dataDir` guard in
    // pglite-engine.ts's connect() skip the GBRAIN_PGLITE_SNAPSHOT
    // fast-restore path unconditionally, so this file's second
    // initSchema() call on the "migrated" engine genuinely replays
    // bootstrap + schema + migrations instead of risking a snapshot
    // short-circuit turning it into a no-op — without needing to mutate
    // process.env (scripts/check-test-isolation.sh R1).
    freshDir = mkdtempSync(join(tmpdir(), 'principal-schema-parity-fresh-'));
    migratedDir = mkdtempSync(join(tmpdir(), 'principal-schema-parity-migrated-'));

    // --- Fresh engine ---
    fresh = new PGLiteEngine();
    await fresh.connect({ database_path: freshDir });
    await fresh.initSchema();
    freshDb = (fresh as any).db;

    // --- "Migrated" engine: fully init, then strip Phase 9B objects to
    // simulate a pre-v125 brain, then re-run initSchema (the real upgrade path).
    migrated = new PGLiteEngine();
    await migrated.connect({ database_path: migratedDir });
    await migrated.initSchema();
    migratedDb = (migrated as any).db;

    // Multi-statement DDL block — needs .exec(), not .query() (PGLite's
    // .query() is single-statement, like pg.query(); .exec() is the
    // documented multi-statement runner used elsewhere in this codebase
    // for schema replay).
    await (migrated as any).db.exec(`
      DROP INDEX IF EXISTS idx_oauth_clients_principal_id;
      ALTER TABLE oauth_clients DROP COLUMN IF EXISTS principal_id;
      DROP TABLE IF EXISTS principals;
      DROP TABLE IF EXISTS principal_kinds;
    `);
    // Roll config.version back to 124 so runMigrations sees v125 as pending
    // (mirrors a genuine pre-v125 brain rather than one merely missing
    // objects while still stamped at the latest version).
    await (migrated as any).db.exec(`UPDATE config SET value = '124' WHERE key = 'version';`);

    await migrated.initSchema(); // real upgrade path: bootstrap + replay + migrations
  }, 30000);

  afterAll(async () => {
    await fresh.disconnect();
    await migrated.disconnect();
    rmSync(freshDir, { recursive: true, force: true });
    rmSync(migratedDir, { recursive: true, force: true });
  });

  test('columns, indexes, and foreign keys converge to an identical shape', async () => {
    // --- Columns ---
    const freshCols = filterSnapshotToRelevantTables(
      await snapshotSchema(async (sql) => {
        const r = await freshDb.query(sql);
        return r.rows as SnapshotQueryRow[];
      }),
    );
    const migratedCols = filterSnapshotToRelevantTables(
      await snapshotSchema(async (sql) => {
        const r = await migratedDb.query(sql);
        return r.rows as SnapshotQueryRow[];
      }),
    );
    const colDiff = diffSnapshots(freshCols, migratedCols, { allowlistPgOnlyTables: [] });
    expect(colDiff.tablesMissingInPGLite).toEqual([]);
    expect(colDiff.tablesUnexpectedlyInPGLite).toEqual([]);
    expect(colDiff.columnsMissingInPGLite).toEqual([]);
    expect(colDiff.columnsMissingInPostgres).toEqual([]);
    expect(colDiff.typeMismatches).toEqual([]);

    // --- Indexes ---
    const filterIdx = (snap: Map<string, unknown>) => {
      const out = new Map();
      for (const [name, info] of snap as Map<string, { tableName: string }>) {
        if (RELEVANT_TABLES.has(info.tableName)) out.set(name, info);
      }
      return out;
    };
    const freshIdx = filterIdx(
      await snapshotIndexes(async (sql) => {
        const r = await freshDb.query(sql);
        return r.rows as IndexSnapshotRow[];
      }),
    );
    const migratedIdx = filterIdx(
      await snapshotIndexes(async (sql) => {
        const r = await migratedDb.query(sql);
        return r.rows as IndexSnapshotRow[];
      }),
    );
    const idxDiff = diffIndexSnapshots(freshIdx as any, migratedIdx as any, {});
    expect(idxDiff.pgOnly).toEqual([]);
    expect(idxDiff.pgliteOnly).toEqual([]);
    expect(idxDiff.mismatched).toEqual([]);
    // Explicitly assert the index this REQUIRED-2 fix is about exists on
    // BOTH sides (not just "no diff" — belt-and-suspenders against a
    // vacuous pass if both sides were somehow missing it).
    expect(freshIdx.has('idx_oauth_clients_principal_id')).toBe(true);
    expect(migratedIdx.has('idx_oauth_clients_principal_id')).toBe(true);

    // --- Foreign keys ---
    const freshFks = await snapshotForeignKeys(freshDb);
    const migratedFks = await snapshotForeignKeys(migratedDb);
    const normalize = (rows: FkRow[]) =>
      rows.map(r => `${r.table_name}.${r.column_name}->${r.foreign_table_name}.${r.foreign_column_name}(${r.delete_rule})`).sort();
    expect(normalize(migratedFks)).toEqual(normalize(freshFks));
    // Sanity: the specific FKs Phase 9B adds are actually present.
    const freshFkSet = new Set(normalize(freshFks));
    expect(freshFkSet.has('oauth_clients.principal_id->principals.id(RESTRICT)')).toBe(true);
    expect(freshFkSet.has('principals.kind_id->principal_kinds.id(NO ACTION)')).toBe(true);
  }, 30000);
});
