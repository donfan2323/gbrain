/**
 * Phase 3B-30 — migration v142 (takes_embedding_dimension_matches_config,
 * reconciled from upstream v0.46.32.0 / #2089).
 *
 * v141 hard-coded `takes.embedding vector(1536)`. v142 resizes it to the
 * brain's configured `embedding_dimensions`, since a mismatched column width
 * silently breaks the vector writer. This is a real, non-additive schema
 * migration (drops the HNSW index, nulls existing take embeddings, replaces
 * the column) — unlike most migrations in this file, it destroys regenerable
 * derived data by design. These tests simulate a realistic pre-migration
 * brain (populated take row, non-null embedding at the OLD hard-coded width,
 * a live HNSW index, a non-default configured dimension) rather than only
 * exercising the fresh-bootstrap path that every other migration test in
 * this suite implicitly covers via initSchema().
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MIGRATIONS, LATEST_VERSION, runMigrations } from '../src/core/migrate.ts';

const OLD_HARDCODED_DIM = 1536;
const CONFIGURED_DIM = 768; // matches this deployment's real embedding_dimensions

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema(); // brings a fresh DB straight to LATEST_VERSION (142)
});

afterAll(async () => {
  await engine.disconnect();
});

function fakeVector(dims: number): string {
  return `[${Array.from({ length: dims }, (_, i) => ((i % 7) * 0.01).toFixed(4)).join(',')}]`;
}

describe('migration v142 registry pin', () => {
  test('v142 exists, is idempotent, has no collision with v141', () => {
    const v142 = MIGRATIONS.find(m => m.version === 142);
    expect(v142).toBeDefined();
    expect(v142?.name).toBe('takes_embedding_dimension_matches_config');
    const versions = MIGRATIONS.map(m => m.version);
    expect(new Set(versions).size).toBe(versions.length); // no duplicate version numbers
    expect(v142?.handler).toBeDefined(); // all logic lives in the handler, sql is empty
  });
});

describe('v141 → v142 upgrade path with realistic pre-existing data', () => {
  test('simulate a pre-v142 brain: hard-coded vector(1536), a real take row with embedding + embedded_at, a live HNSW index', async () => {
    await engine.executeRaw(`DROP INDEX IF EXISTS idx_takes_embedding_hnsw`);
    await engine.executeRaw(`ALTER TABLE takes DROP COLUMN IF EXISTS embedding`);
    await engine.executeRaw(`ALTER TABLE takes ADD COLUMN embedding VECTOR(${OLD_HARDCODED_DIM})`);
    await engine.executeRaw(
      `CREATE INDEX IF NOT EXISTS idx_takes_embedding_hnsw ON takes
         USING hnsw (embedding vector_cosine_ops)
         WHERE active AND embedding IS NOT NULL`,
    );

    await engine.executeRaw(
      `INSERT INTO pages (slug, type, title, compiled_truth, timeline, page_kind, chunker_version)
       VALUES ('people/probe', 'note', 'probe', 'Phase 3B-30 pre-migration probe page.', '', 'markdown', 1)`,
    );
    const pageRows = await engine.executeRaw<{ id: number }>(`SELECT id FROM pages WHERE slug = 'people/probe'`);
    const pageId = pageRows[0].id;

    await engine.executeRaw(
      `INSERT INTO takes (page_id, row_num, claim, kind, holder, active, embedding, embedded_at)
       VALUES ($1, 1, 'Phase 3B-30 pre-migration probe take — must survive the v142 upgrade unchanged.',
               'take', 'author', true, $2::vector, now())`,
      [pageId, fakeVector(OLD_HARDCODED_DIM)],
    );

    await engine.executeRaw(`UPDATE config SET value = ${CONFIGURED_DIM} WHERE key = 'embedding_dimensions'`);

    const before = await engine.executeRaw<{ embedding: string | null; embedded_at: string | null; claim: string }>(
      `SELECT embedding::text AS embedding, embedded_at::text AS embedded_at, claim FROM takes WHERE page_id = ${pageId} AND row_num = 1`,
    );
    expect(before[0].embedding).not.toBeNull();
    expect(before[0].embedded_at).not.toBeNull();

    await engine.setConfig('version', '141'); // rewind the ledger — the standard pattern this suite uses (see test/migrations-v126.test.ts)
  });

  test('runMigrations reaches v142 (LATEST_VERSION) cleanly from the simulated v141 state', async () => {
    const res = await runMigrations(engine);
    expect(res.applied).toBeGreaterThanOrEqual(1);
    expect(res.current).toBe(LATEST_VERSION);
    expect(await engine.getConfig('version')).toBe(String(LATEST_VERSION));
  }, 30000);

  test('take CONTENT (permanent data) survived unchanged — only the embedding cache was touched', async () => {
    const rows = await engine.executeRaw<{ claim: string; kind: string; holder: string; active: boolean }>(
      `SELECT claim, kind, holder, active FROM takes
        WHERE page_id = (SELECT id FROM pages WHERE slug = 'people/probe') AND row_num = 1`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0].claim).toBe('Phase 3B-30 pre-migration probe take — must survive the v142 upgrade unchanged.');
    expect(rows[0].kind).toBe('take');
    expect(rows[0].holder).toBe('author');
    expect(rows[0].active).toBe(true);
  });

  test('embedding (regenerable cache) was intentionally nulled — embedding and embedded_at both NULL', async () => {
    const rows = await engine.executeRaw<{ embedding: string | null; embedded_at: string | null }>(
      `SELECT embedding::text AS embedding, embedded_at::text AS embedded_at FROM takes
        WHERE page_id = (SELECT id FROM pages WHERE slug = 'people/probe') AND row_num = 1`,
    );
    expect(rows[0].embedding).toBeNull();
    expect(rows[0].embedded_at).toBeNull();
  });

  test('takes.embedding column now matches the CONFIGURED dimension, not the old hard-coded 1536', async () => {
    const rows = await engine.executeRaw<{ formatted: string | null }>(
      `SELECT format_type(a.atttypid, a.atttypmod) AS formatted
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = 'takes' AND a.attname = 'embedding' AND NOT a.attisdropped`,
    );
    expect(rows[0].formatted).toBe(`vector(${CONFIGURED_DIM})`);
  });

  test('HNSW index was recreated at the new dimension (768 is well under the pgvector HNSW cap)', async () => {
    const rows = await engine.executeRaw<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'takes' AND indexname = 'idx_takes_embedding_hnsw'`,
    );
    expect(rows.length).toBe(1);
  });

  test('engine can boot/query the DB after migration — a fresh write + read round-trips through the new column width', async () => {
    const where = `page_id = (SELECT id FROM pages WHERE slug = 'people/probe') AND row_num = 1`;
    await engine.executeRaw(
      `UPDATE takes SET embedding = $1::vector, embedded_at = now() WHERE ${where}`,
      [fakeVector(CONFIGURED_DIM)],
    );
    const rows = await engine.executeRaw<{ embedding: string | null }>(
      `SELECT embedding::text AS embedding FROM takes WHERE ${where}`,
    );
    expect(rows[0].embedding).not.toBeNull();
    // A stale-width vector must now be REJECTED by the column (proves the
    // resize actually took effect, not just the introspection query above).
    await expect(
      engine.executeRaw(`UPDATE takes SET embedding = $1::vector WHERE ${where}`, [fakeVector(OLD_HARDCODED_DIM)]),
    ).rejects.toThrow();
  });

  test('re-running migrations after reaching v142 is idempotent (0 applied) — the ledger gate short-circuits before the handler runs at all', async () => {
    const res = await runMigrations(engine);
    expect(res.applied).toBe(0);
  }, 30000);

  test("re-invoking v142's handler directly (simulating a stray retry) is a safe no-op when the column already matches — does NOT re-null a freshly-repopulated embedding", async () => {
    const v142 = MIGRATIONS.find(m => m.version === 142)!;
    const where = `page_id = (SELECT id FROM pages WHERE slug = 'people/probe') AND row_num = 1`;
    // Confirm the embedding written by the previous test is still there
    // going in, so a failure below can only mean the handler re-nulled it.
    const before = await engine.executeRaw<{ embedding: string | null }>(
      `SELECT embedding::text AS embedding FROM takes WHERE ${where}`,
    );
    expect(before[0].embedding).not.toBeNull();

    await v142.handler!(engine as never);

    const after = await engine.executeRaw<{ embedding: string | null }>(
      `SELECT embedding::text AS embedding FROM takes WHERE ${where}`,
    );
    expect(after[0].embedding).not.toBeNull(); // untouched — dimension already matched, handler returned early
  });
});
