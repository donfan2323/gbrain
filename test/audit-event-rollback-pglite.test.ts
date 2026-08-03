/**
 * Phase 9C (Universal Audit Event Integration) — mechanical verification
 * that the documented manual rollback procedure (PHASE9C-MIGRATION-AND-
 * COMPATIBILITY-PLAN.md §6-2) actually works, executed for real against a
 * disposable PGLite brain.
 *
 * Distinct from test/principal-rollback-pglite.test.ts (Phase 9B's own
 * rollback claims, which already treats "roll back Phase 9C's objects
 * first" as a precondition step) — this file is about Phase 9C's OWN
 * rollback SQL and its own claims:
 *
 *   1. (§6-2) The rollback SQL runs cleanly against a real v128 schema and
 *      leaves config.version at exactly '125'.
 *   2. (§6-2) audit_events, the 3 registry tables, and the 2 compat views
 *      are genuinely gone afterwards (catalog + real query).
 *   3. (§6-2) mcp_request_log is untouched by the rollback — its existing
 *      rows survive exactly as they were.
 *   4. (§6-2) audit_events rows recorded BEFORE the rollback are lost
 *      after it (the documented, accepted data-loss scope — audit history
 *      recorded during Phase 9C operation, not otherwise dumped).
 *   5. (§6-3) initSchema() re-run fully restores v126-v128.
 *   6. (§6-1) THE SELF-HEALING DEFECT, pinned as a regression: this is the
 *      exact failure mode Phase 9B v3 discovered and that §6-1 exists to
 *      warn operators away from. Running the rollback SQL ALONE, while the
 *      code/binary is still Phase-9C-aware (i.e. still defines migrations
 *      up to v128), and then letting gbrain reconnect (initSchema()) undoes
 *      the rollback within moments — because the code sees
 *      current_version=125 < LATEST_VERSION=128 and simply re-applies
 *      v126-v128. This is NOT a bug to fix; it is why §6-1 mandates
 *      "roll back the CODE first, deploy it, THEN run the SQL." This test
 *      pins the self-healing behavior itself, so a future change that
 *      accidentally makes it either silently non-self-healing (masking a
 *      real operator mistake) or destructive in some new way is caught.
 *
 * PGLite only — see test/e2e/audit-event-postgres.test.ts for the
 * sql.begin()-based real-Postgres equivalent (§6-3's second paragraph).
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { tmpdir } from 'os';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

function makeSqlTag(engine: PGLiteEngine) {
  return async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.reduce((acc, str, i) => acc + str + (i < values.length ? `$${i + 1}` : ''), '');
    return engine.executeRaw(query, values as unknown[]);
  };
}

/** The rollback SQL exactly as published in PHASE9C-MIGRATION-AND-COMPATIBILITY-PLAN.md §6-2. */
const DOCUMENTED_ROLLBACK_SQL = `
BEGIN;

-- v127分の取り消し
DROP VIEW IF EXISTS audit_events_attribution_gaps;
DROP VIEW IF EXISTS audit_events_compat;

-- v126分の取り消し(依存の逆順)
DROP TABLE IF EXISTS audit_events;
DROP TABLE IF EXISTS audit_attribution_states;
DROP TABLE IF EXISTS audit_channels;
DROP TABLE IF EXISTS audit_event_kinds;

-- config.versionの巻き戻し
UPDATE config SET value = '125' WHERE key = 'version';

COMMIT;
`;

describe('Phase 9C §6-2: the documented manual rollback procedure, executed for real on PGLite', () => {
  let engine: PGLiteEngine;
  let sql: ReturnType<typeof makeSqlTag>;
  let dbDir: string;

  const schemaVersion = async (): Promise<number> => {
    const rows = await sql`SELECT value FROM config WHERE key = 'version'`;
    return Number((rows[0] as { value: string }).value);
  };

  const tableExists = async (name: string): Promise<boolean> => {
    const rows = await sql`SELECT to_regclass(${'public.' + name}) AS reg`;
    return (rows[0] as { reg: string | null }).reg !== null;
  };

  beforeAll(async () => {
    // A real database_path (not the default in-memory connection) makes
    // the `!dataDir` guard in pglite-engine.ts's connect() skip the
    // GBRAIN_PGLITE_SNAPSHOT fast-restore path unconditionally, so the
    // post-rollback initSchema() calls genuinely replay migrations instead
    // of risking a snapshot short-circuit — same rationale as Phase 9B's
    // rollback test.
    dbDir = mkdtempSync(join(tmpdir(), 'audit-event-rollback-pglite-'));
    engine = new PGLiteEngine();
    await engine.connect({ database_path: dbDir });
    await engine.initSchema(); // full v128 schema
    sql = makeSqlTag(engine);
  }, 30_000);

  afterAll(async () => {
    await engine.disconnect();
    rmSync(dbDir, { recursive: true, force: true });
  });

  test('pre-rollback baseline: v128 audit objects exist, and mcp_request_log + audit_events both hold rows', async () => {
    expect(await schemaVersion()).toBeGreaterThanOrEqual(128);
    expect(await tableExists('audit_events')).toBe(true);
    expect(await tableExists('audit_event_kinds')).toBe(true);
    expect(await tableExists('audit_channels')).toBe(true);
    expect(await tableExists('audit_attribution_states')).toBe(true);
    expect(await tableExists('audit_events_compat')).toBe(true);
    expect(await tableExists('audit_events_attribution_gaps')).toBe(true);

    await sql`INSERT INTO mcp_request_log (token_name, agent_name, operation, status) VALUES ('rollback-legacy-token', 'legacy-agent', 'search', 'success')`;
    await sql`
      INSERT INTO audit_events (occurred_at, event_kind, channel_id, attribution_state, operation, decision, outcome, correlation_id)
      VALUES (now(), 'operation.request', 'mcp_http', 'client_only', 'pre_rollback_op', 'allowed', 'succeeded', 'corr-pre-rollback')
    `;

    const legacyRows = await sql`SELECT token_name FROM mcp_request_log WHERE token_name = 'rollback-legacy-token'`;
    expect(legacyRows.length).toBe(1);
    const auditRows = await sql`SELECT id FROM audit_events WHERE correlation_id = 'corr-pre-rollback'`;
    expect(auditRows.length).toBe(1);
  });

  test('executing the documented §6-2 rollback SQL verbatim reverts config.version to 125 and removes every Phase 9C object', async () => {
    // Multi-statement block (BEGIN/…/COMMIT) — needs .exec(), which is
    // PGLite's documented multi-statement runner (.query() is single-statement).
    await engine.db.exec(DOCUMENTED_ROLLBACK_SQL);

    expect(await schemaVersion()).toBe(125);
    expect(await tableExists('audit_events')).toBe(false);
    expect(await tableExists('audit_event_kinds')).toBe(false);
    expect(await tableExists('audit_channels')).toBe(false);
    expect(await tableExists('audit_attribution_states')).toBe(false);
    expect(await tableExists('audit_events_compat')).toBe(false);
    expect(await tableExists('audit_events_attribution_gaps')).toBe(false);

    // Not just absent from the catalogs — actually unqueryable.
    await expect(sql`SELECT 1 FROM audit_events`).rejects.toThrow();
    await expect(sql`SELECT 1 FROM audit_event_kinds`).rejects.toThrow();
  });

  test('mcp_request_log is untouched by the rollback — its pre-existing row survives exactly', async () => {
    const rows = await sql`SELECT token_name, agent_name, operation, status FROM mcp_request_log WHERE token_name = 'rollback-legacy-token'`;
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({
      token_name: 'rollback-legacy-token',
      agent_name: 'legacy-agent',
      operation: 'search',
      status: 'success',
    });
  });

  test('audit_events rows recorded before the rollback are genuinely lost (documented, accepted data-loss scope)', async () => {
    // The table itself is gone (verified above); this test exists to make
    // the accepted loss explicit and separately assertable rather than
    // implied by "the table doesn't exist so of course the row is gone."
    expect(await tableExists('audit_events')).toBe(false);
  });

  test('§6-1 self-healing defect, pinned as a regression: re-running initSchema() with Phase-9C-aware code undoes an SQL-only rollback within one call', async () => {
    // This IS the mistake §6-1 warns operators against: running the SQL
    // rollback while the deployed code still defines migrations through
    // v128, then letting the process reconnect. gbrain's migration runner
    // sees current_version=125 < LATEST_VERSION=128 and simply re-applies
    // v126-v128 — the "rollback" self-heals (self-invalidates) as soon as
    // initSchema() runs again, with no special recovery code involved.
    expect(await schemaVersion()).toBe(125);

    await engine.initSchema();

    expect(await schemaVersion()).toBeGreaterThanOrEqual(128);
    expect(await tableExists('audit_events')).toBe(true);
    expect(await tableExists('audit_event_kinds')).toBe(true);
    expect(await tableExists('audit_channels')).toBe(true);
    expect(await tableExists('audit_attribution_states')).toBe(true);
    expect(await tableExists('audit_events_compat')).toBe(true);
    expect(await tableExists('audit_events_attribution_gaps')).toBe(true);

    // Restored registries are freshly re-seeded (not carried over — the
    // pre-rollback audit_events row is gone for good, confirming this is
    // recreation, not resurrection of prior state).
    const auditRows = await sql`SELECT id FROM audit_events WHERE correlation_id = 'corr-pre-rollback'`;
    expect(auditRows.length).toBe(0);
    const kindRows = await sql`SELECT count(*)::int AS n FROM audit_event_kinds`;
    expect(kindRows[0].n).toBe(15);
  }, 30_000);
});
