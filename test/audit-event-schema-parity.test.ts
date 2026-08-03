/**
 * Phase 9C (Universal Audit Event Integration) — fresh-install vs. migrated-
 * brain schema parity for the audit objects (audit_events, audit_event_kinds,
 * audit_channels, audit_attribution_states, audit_events_compat,
 * audit_events_attribution_gaps).
 *
 * Structure mirrors test/principal-schema-parity.test.ts exactly (Phase 9B's
 * established pattern, see PHASE9C-ACCEPTANCE-CRITERIA.md §3 row 3), extended
 * per the acceptance criteria to also compare CHECK constraints — Phase 9B's
 * parity test only covered columns/indexes/FKs, this file adds CHECK because
 * audit_events has two closed-vocabulary CHECKs (decision/outcome) plus the
 * bidirectional chk_audit_attribution, none of which existed in Phase 9B's
 * scope.
 *
 * Two PGLite instances:
 *   - "fresh": brand-new engine, natural initSchema() (bootstrap + schema
 *     replay creates the objects inline; migrations 1..128 all no-op).
 *   - "migrated": fully initialised (so it has the complete pre-Phase-9C
 *     v125 shape, including Phase 9B's principals/principal_kinds — a hard
 *     prerequisite of Phase 9C, left untouched here), then has every Phase
 *     9C object surgically stripped to look like a genuine pre-v126 brain,
 *     then has initSchema() re-run — the real upgrade path.
 *
 * Postgres-side parity is NOT covered here (no Postgres in this sandbox) —
 * see test/e2e/audit-event-postgres.test.ts.
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

const RELEVANT_TABLES = new Set([
  'audit_events',
  'audit_event_kinds',
  'audit_channels',
  'audit_attribution_states',
  'audit_events_compat',
  'audit_events_attribution_gaps',
]);

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
    AND tc.table_name = 'audit_events'
  ORDER BY tc.table_name, kcu.column_name
`;

async function snapshotForeignKeys(pgliteDb: { query: (sql: string) => Promise<{ rows: FkRow[] }> }): Promise<FkRow[]> {
  const { rows } = await pgliteDb.query(FK_SNAPSHOT_SQL);
  return rows;
}

interface CheckRow {
  constraint_name: string;
  check_clause: string;
}

// information_schema.check_constraints has no table_name column directly —
// join through table_constraints to scope to audit_events. NOT NULL is
// implemented as an implicit CHECK in Postgres's catalog (visible here too),
// so this also incidentally covers NOT NULL parity for the two named
// CHECKs — column-level NOT NULL is already covered by snapshotSchema's
// is_nullable comparison above.
const CHECK_SNAPSHOT_SQL = `
  SELECT cc.constraint_name, cc.check_clause
  FROM information_schema.check_constraints cc
  JOIN information_schema.table_constraints tc
    ON tc.constraint_name = cc.constraint_name AND tc.constraint_schema = cc.constraint_schema
  WHERE tc.table_schema = 'public'
    AND tc.table_name = 'audit_events'
    AND cc.constraint_name IN ('audit_events_decision_check', 'audit_events_outcome_check', 'chk_audit_attribution')
  ORDER BY cc.constraint_name
`;

async function snapshotChecks(pgliteDb: { query: (sql: string) => Promise<{ rows: CheckRow[] }> }): Promise<CheckRow[]> {
  const { rows } = await pgliteDb.query(CHECK_SNAPSHOT_SQL);
  return rows;
}

describe('Phase 9C: fresh vs. migrated schema parity (audit objects)', () => {
  let fresh: PGLiteEngine;
  let migrated: PGLiteEngine;
  let freshDb: { query: (sql: string) => Promise<{ rows: any[] }> };
  let migratedDb: { query: (sql: string) => Promise<{ rows: any[] }> };
  let freshDir: string;
  let migratedDir: string;

  beforeAll(async () => {
    freshDir = mkdtempSync(join(tmpdir(), 'audit-event-schema-parity-fresh-'));
    migratedDir = mkdtempSync(join(tmpdir(), 'audit-event-schema-parity-migrated-'));

    fresh = new PGLiteEngine();
    await fresh.connect({ database_path: freshDir });
    await fresh.initSchema();
    freshDb = (fresh as any).db;

    migrated = new PGLiteEngine();
    await migrated.connect({ database_path: migratedDir });
    await migrated.initSchema();
    migratedDb = (migrated as any).db;

    // Strip only the Phase 9C objects — Phase 9B's principals/principal_kinds
    // stay in place, since a genuine pre-v126 (post-v125) brain has them.
    await (migrated as any).db.exec(`
      DROP VIEW IF EXISTS audit_events_attribution_gaps;
      DROP VIEW IF EXISTS audit_events_compat;
      DROP TABLE IF EXISTS audit_events;
      DROP TABLE IF EXISTS audit_attribution_states;
      DROP TABLE IF EXISTS audit_channels;
      DROP TABLE IF EXISTS audit_event_kinds;
    `);
    await (migrated as any).db.exec(`UPDATE config SET value = '125' WHERE key = 'version';`);

    await migrated.initSchema(); // real upgrade path: bootstrap + replay + migrations
  }, 30000);

  afterAll(async () => {
    await fresh.disconnect();
    await migrated.disconnect();
    rmSync(freshDir, { recursive: true, force: true });
    rmSync(migratedDir, { recursive: true, force: true });
  });

  test('columns, indexes, foreign keys, and CHECK constraints converge to an identical shape', async () => {
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
    // Sanity: both sides actually have the 27-column audit_events shape,
    // not a vacuous pass from both being equally empty.
    expect(freshCols.get('audit_events')?.size).toBe(27);
    expect(migratedCols.get('audit_events')?.size).toBe(27);

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
    // Belt-and-suspenders: the 6 non-PK audit_events indexes exist on both sides.
    for (const idx of [
      'idx_audit_events_occurred', 'idx_audit_events_principal', 'idx_audit_events_client',
      'idx_audit_events_correlation', 'idx_audit_events_job', 'idx_audit_events_denied',
      'idx_audit_events_channel',
    ]) {
      expect(freshIdx.has(idx)).toBe(true);
      expect(migratedIdx.has(idx)).toBe(true);
    }

    // --- Foreign keys ---
    const freshFks = await snapshotForeignKeys(freshDb);
    const migratedFks = await snapshotForeignKeys(migratedDb);
    const normalizeFks = (rows: FkRow[]) =>
      rows.map(r => `${r.table_name}.${r.column_name}->${r.foreign_table_name}.${r.foreign_column_name}(${r.delete_rule})`).sort();
    expect(normalizeFks(migratedFks)).toEqual(normalizeFks(freshFks));
    const freshFkSet = new Set(normalizeFks(freshFks));
    // The 4 FKs audit_events carries: 3 to the open-world registries + 1 to principals.
    expect(freshFkSet.has('audit_events.event_kind->audit_event_kinds.id(NO ACTION)')).toBe(true);
    expect(freshFkSet.has('audit_events.channel_id->audit_channels.id(NO ACTION)')).toBe(true);
    expect(freshFkSet.has('audit_events.attribution_state->audit_attribution_states.id(NO ACTION)')).toBe(true);
    expect(freshFkSet.has('audit_events.principal_id->principals.id(RESTRICT)')).toBe(true);
    // client_id/job_id/parent_event_id deliberately carry NO FK (§0-b, §1-2) —
    // confirm the FK set has exactly 4 entries, not more.
    expect(freshFkSet.size).toBe(4);

    // --- CHECK constraints ---
    const freshChecks = await snapshotChecks(freshDb);
    const migratedChecks = await snapshotChecks(migratedDb);
    const normalizeChecks = (rows: CheckRow[]) =>
      rows.map(r => `${r.constraint_name}::${r.check_clause}`).sort();
    expect(normalizeChecks(migratedChecks)).toEqual(normalizeChecks(freshChecks));
    expect(freshChecks.map(c => c.constraint_name).sort()).toEqual([
      'audit_events_decision_check', 'audit_events_outcome_check', 'chk_audit_attribution',
    ]);
  }, 30000);
});
