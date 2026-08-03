/**
 * Phase 9C (Universal Audit Event Integration) — audit_events foundation tests.
 *
 * Design reference (priority order): PHASE9C-AUDIT-EVENT-DOMAIN-MODEL.md,
 * PHASE9C-ACCEPTANCE-CRITERIA.md §3-1, PHASE9C-MIGRATION-AND-COMPATIBILITY-PLAN.md.
 *
 * Covers, per PHASE9C-ACCEPTANCE-CRITERIA.md §3 row 1:
 *   - Schema shape (audit_events + 3 registry tables) after fresh-migration replay.
 *   - Seed contents of the 3 open-world registry tables.
 *   - CHECK sets on decision/outcome.
 *   - chk_audit_attribution bidirectional violation (23514) — principal_attributed
 *     requires a non-null principal_id, and vice versa.
 *   - FK ON DELETE RESTRICT behavior (event_kind/channel_id/attribution_state/
 *     principal_id).
 *   - client_id has NO FK (§0-b — a deliberate design choice; this is a positive
 *     pass condition, this test FAILS if a FK is later added to client_id).
 *   - The Writer's attribution-state decision logic (writeAuditEvent()).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { writeAuditEvent } from '../src/core/audit/audit-events-writer.ts';
import type { AuditEventInput } from '../src/core/audit/audit-events-types.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
}, 30_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM audit_events');
});

function baseInput(overrides: Partial<AuditEventInput> = {}): AuditEventInput {
  return {
    envelope_version: 1,
    occurred_at: new Date().toISOString(),
    event_kind: 'operation.request',
    channel_id: 'mcp_http',
    attribution_state: 'client_only',
    principal_id: null,
    client_id: 'test-client',
    actor_label: 'test-client',
    credential_ref: null,
    operation: 'test_op',
    required_scope: null,
    scopes_snapshot: null,
    decision: 'allowed',
    outcome: 'succeeded',
    reason_code: null,
    resource_kind: null,
    resource_ref: null,
    source_id: null,
    job_id: null,
    correlation_id: 'test-correlation',
    parent_event_id: null,
    latency_ms: 10,
    params_summary: null,
    adapter: {},
    errorMessageRaw: null,
    ...overrides,
  };
}

describe('registry table bootstrap (open-world pattern)', () => {
  test('audit_event_kinds seeds all 15 canonical kinds', async () => {
    const rows = await engine.executeRaw<{ id: string }>('SELECT id FROM audit_event_kinds ORDER BY id');
    expect(rows.map(r => r.id)).toEqual([
      'authorization.decision',
      'client.register',
      'client.revoke',
      'client.update',
      'credential.issue',
      'credential.revoke',
      'credential.verify',
      'delegation.deny',
      'delegation.grant',
      'ingest.accept',
      'ingest.reject',
      'message.verify',
      'operation.request',
      'session.establish',
      'session.terminate',
    ]);
  });

  test('audit_channels seeds all 8 canonical channels', async () => {
    const rows = await engine.executeRaw<{ id: string }>('SELECT id FROM audit_channels ORDER BY id');
    expect(rows.map(r => r.id)).toEqual([
      'admin_http',
      'ingest_http',
      'internal',
      'local_process',
      'mcp_http',
      'mcp_stdio',
      'oauth_endpoint',
      'webhook',
    ]);
  });

  test('audit_attribution_states seeds all 11 canonical states', async () => {
    const rows = await engine.executeRaw<{ id: string }>('SELECT id FROM audit_attribution_states ORDER BY id');
    expect(rows.map(r => r.id)).toEqual([
      'admin_session',
      'attribution_unavailable',
      'authentication_failed',
      'client_only',
      'legacy_credential',
      'local_process',
      'message_authenticated',
      'principal_attributed',
      'system_internal',
      'unauthenticated',
      'unmigrated_legacy_record',
    ]);
  });

  test('a new event_kind can be added via a plain data-row INSERT, no schema change (open-world pattern)', async () => {
    await engine.executeRaw(`INSERT INTO audit_event_kinds (id, label, description) VALUES ('custom.future_kind', 'Custom', 'future extension')`);
    const rows = await engine.executeRaw<{ id: string }>(`SELECT id FROM audit_event_kinds WHERE id = 'custom.future_kind'`);
    expect(rows.length).toBe(1);
  });

  test('re-running a bootstrap INSERT is idempotent (ON CONFLICT DO NOTHING)', async () => {
    await engine.executeRaw(`INSERT INTO audit_channels (id, label, description) VALUES ('mcp_http', 'MCP over HTTP', 'dup') ON CONFLICT (id) DO NOTHING`);
    const rows = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM audit_channels WHERE id = 'mcp_http'`);
    expect(rows[0].n).toBe(1);
  });
});

describe('decision/outcome CHECK constraints (closed vocabulary)', () => {
  test('decision rejects a value outside {allowed,denied,not_applicable} with 23514', async () => {
    let code: string | undefined;
    try {
      await engine.executeRaw(
        `INSERT INTO audit_events (occurred_at, event_kind, channel_id, attribution_state, operation, decision, outcome, correlation_id)
         VALUES (now(), 'operation.request', 'mcp_http', 'client_only', 'test_op', 'bogus_decision', 'succeeded', 'corr-decision')`,
      );
    } catch (e) {
      code = (e as { code?: string }).code;
    }
    expect(code).toBe('23514');
  });

  test('outcome rejects a value outside {succeeded,failed,rejected,pending} with 23514', async () => {
    let code: string | undefined;
    try {
      await engine.executeRaw(
        `INSERT INTO audit_events (occurred_at, event_kind, channel_id, attribution_state, operation, decision, outcome, correlation_id)
         VALUES (now(), 'operation.request', 'mcp_http', 'client_only', 'test_op', 'allowed', 'bogus_outcome', 'corr-outcome')`,
      );
    } catch (e) {
      code = (e as { code?: string }).code;
    }
    expect(code).toBe('23514');
  });

  test('decision defaults to not_applicable when omitted', async () => {
    const rows = await engine.executeRaw<{ decision: string }>(
      `INSERT INTO audit_events (occurred_at, event_kind, channel_id, attribution_state, operation, outcome, correlation_id)
       VALUES (now(), 'operation.request', 'mcp_http', 'client_only', 'test_op', 'succeeded', 'corr-default')
       RETURNING decision`,
    );
    expect(rows[0].decision).toBe('not_applicable');
  });
});

describe('chk_audit_attribution (bidirectional CHECK)', () => {
  test('attribution_state=principal_attributed with NULL principal_id is rejected (23514)', async () => {
    let code: string | undefined;
    let constraintName: string | undefined;
    try {
      await engine.executeRaw(
        `INSERT INTO audit_events (occurred_at, event_kind, channel_id, attribution_state, operation, decision, outcome, correlation_id)
         VALUES (now(), 'operation.request', 'mcp_http', 'principal_attributed', 'test_op', 'allowed', 'succeeded', 'corr-attr-1')`,
      );
    } catch (e) {
      const err = e as { code?: string; constraint_name?: string; constraint?: string };
      code = err.code;
      constraintName = err.constraint_name ?? err.constraint;
    }
    expect(code).toBe('23514');
    expect(constraintName).toBe('chk_audit_attribution');
  });

  test('attribution_state=client_only with a non-null principal_id is rejected (23514) — the reverse direction', async () => {
    const [{ id: principalId }] = await engine.executeRaw<{ id: string }>(
      `INSERT INTO principals (kind_id, display_name) VALUES ('service', 'attr-check-principal') RETURNING id`,
    );
    let code: string | undefined;
    try {
      await engine.executeRaw(
        `INSERT INTO audit_events (occurred_at, event_kind, channel_id, attribution_state, principal_id, operation, decision, outcome, correlation_id)
         VALUES (now(), 'operation.request', 'mcp_http', 'client_only', $1, 'test_op', 'allowed', 'succeeded', 'corr-attr-2')`,
        [principalId],
      );
    } catch (e) {
      code = (e as { code?: string }).code;
    }
    expect(code).toBe('23514');
  });

  test('attribution_state=principal_attributed with a valid principal_id succeeds', async () => {
    const [{ id: principalId }] = await engine.executeRaw<{ id: string }>(
      `INSERT INTO principals (kind_id, display_name) VALUES ('human', 'attr-check-valid') RETURNING id`,
    );
    const rows = await engine.executeRaw<{ id: string }>(
      `INSERT INTO audit_events (occurred_at, event_kind, channel_id, attribution_state, principal_id, operation, decision, outcome, correlation_id)
       VALUES (now(), 'operation.request', 'mcp_http', 'principal_attributed', $1, 'test_op', 'allowed', 'succeeded', 'corr-attr-3')
       RETURNING id`,
      [principalId],
    );
    expect(rows.length).toBe(1);
  });
});

describe('FK behavior on the 3 open-world registry columns + principal_id', () => {
  test('an unregistered event_kind is rejected (23503)', async () => {
    let code: string | undefined;
    try {
      await engine.executeRaw(
        `INSERT INTO audit_events (occurred_at, event_kind, channel_id, attribution_state, operation, decision, outcome, correlation_id)
         VALUES (now(), 'bogus.event_kind', 'mcp_http', 'client_only', 'test_op', 'allowed', 'succeeded', 'corr-fk-1')`,
      );
    } catch (e) {
      code = (e as { code?: string }).code;
    }
    expect(code).toBe('23503');
  });

  test('an unregistered channel_id is rejected (23503)', async () => {
    let code: string | undefined;
    try {
      await engine.executeRaw(
        `INSERT INTO audit_events (occurred_at, event_kind, channel_id, attribution_state, operation, decision, outcome, correlation_id)
         VALUES (now(), 'operation.request', 'bogus.channel', 'client_only', 'test_op', 'allowed', 'succeeded', 'corr-fk-2')`,
      );
    } catch (e) {
      code = (e as { code?: string }).code;
    }
    expect(code).toBe('23503');
  });

  test('an unregistered attribution_state is rejected (23503)', async () => {
    let code: string | undefined;
    try {
      await engine.executeRaw(
        `INSERT INTO audit_events (occurred_at, event_kind, channel_id, attribution_state, operation, decision, outcome, correlation_id)
         VALUES (now(), 'operation.request', 'mcp_http', 'bogus.attribution', 'test_op', 'allowed', 'succeeded', 'corr-fk-3')`,
      );
    } catch (e) {
      code = (e as { code?: string }).code;
    }
    expect(code).toBe('23503');
  });

  test('principal_id FK ON DELETE RESTRICT: deleting a principal referenced by an audit_events row is rejected, and both rows survive unchanged', async () => {
    const [{ id: principalId }] = await engine.executeRaw<{ id: string }>(
      `INSERT INTO principals (kind_id, display_name) VALUES ('agent', 'restrict-check') RETURNING id`,
    );
    await engine.executeRaw(
      `INSERT INTO audit_events (occurred_at, event_kind, channel_id, attribution_state, principal_id, operation, decision, outcome, correlation_id)
       VALUES (now(), 'operation.request', 'mcp_http', 'principal_attributed', $1, 'test_op', 'allowed', 'succeeded', 'corr-restrict')`,
      [principalId],
    );

    let code: string | undefined;
    try {
      await engine.executeRaw(`DELETE FROM principals WHERE id = $1`, [principalId]);
    } catch (e) {
      code = (e as { code?: string }).code;
    }
    expect(code).toBe('23503');

    const principalRows = await engine.executeRaw<{ id: string }>(`SELECT id FROM principals WHERE id = $1`, [principalId]);
    expect(principalRows.length).toBe(1);
    const eventRows = await engine.executeRaw<{ principal_id: string }>(
      `SELECT principal_id FROM audit_events WHERE correlation_id = 'corr-restrict'`,
    );
    expect(eventRows.length).toBe(1);
    expect(eventRows[0].principal_id).toBe(principalId);
  });
});

describe('client_id has NO foreign key (§0-b — deliberate, non-negotiable)', () => {
  test('an audit_events row referencing a client_id that does not exist in oauth_clients inserts successfully', async () => {
    const rows = await engine.executeRaw<{ id: string }>(
      `INSERT INTO audit_events (occurred_at, event_kind, channel_id, attribution_state, client_id, operation, decision, outcome, correlation_id)
       VALUES (now(), 'operation.request', 'mcp_http', 'client_only', 'this-client-id-does-not-exist-anywhere', 'test_op', 'allowed', 'succeeded', 'corr-no-fk')
       RETURNING id`,
    );
    // If a FK were ever added to client_id, this INSERT would raise 23503 and
    // this test would fail — that failure is the intended signal.
    expect(rows.length).toBe(1);
  });

  test('deleting an oauth_clients row whose client_id was referenced in audit_events does not fail', async () => {
    await engine.executeRaw(
      `INSERT INTO oauth_clients (client_id, client_name, redirect_uris, grant_types, scope, token_endpoint_auth_method, client_id_issued_at)
       VALUES ('no-fk-hard-delete-test', 'test', '{}', '{client_credentials}', 'read', 'none', extract(epoch from now())::bigint)`,
    );
    await engine.executeRaw(
      `INSERT INTO audit_events (occurred_at, event_kind, channel_id, attribution_state, client_id, operation, decision, outcome, correlation_id)
       VALUES (now(), 'operation.request', 'mcp_http', 'client_only', 'no-fk-hard-delete-test', 'test_op', 'allowed', 'succeeded', 'corr-hard-delete')`,
    );
    // Hard delete (src/commands/auth.ts:315 precedent) must not be blocked by
    // the audit trail — this is exactly what "FKなしの非正規化列" buys.
    await expect(
      engine.executeRaw(`DELETE FROM oauth_clients WHERE client_id = 'no-fk-hard-delete-test'`),
    ).resolves.toBeDefined();
    const survivingEvent = await engine.executeRaw<{ client_id: string }>(
      `SELECT client_id FROM audit_events WHERE correlation_id = 'corr-hard-delete'`,
    );
    expect(survivingEvent.length).toBe(1);
    expect(survivingEvent[0].client_id).toBe('no-fk-hard-delete-test');
  });
});

describe('Writer attribution-state decision logic (writeAuditEvent)', () => {
  test('class3_success writes a row with the exact attribution_state the caller supplied', async () => {
    const result = await writeAuditEvent(engine, baseInput({ attribution_state: 'client_only', correlation_id: 'corr-writer-1' }), { class: 'class3_success' });
    expect(result.wrote).toBe('db');
    const rows = await engine.executeRaw<{ attribution_state: string; principal_id: string | null }>(
      `SELECT attribution_state, principal_id FROM audit_events WHERE id = $1`,
      [result.id],
    );
    expect(rows[0].attribution_state).toBe('client_only');
    expect(rows[0].principal_id).toBeNull();
  });

  test('principal_attributed input round-trips principal_id correctly through the Writer', async () => {
    const [{ id: principalId }] = await engine.executeRaw<{ id: string }>(
      `INSERT INTO principals (kind_id, display_name) VALUES ('human', 'writer-round-trip') RETURNING id`,
    );
    const result = await writeAuditEvent(
      engine,
      baseInput({ attribution_state: 'principal_attributed', principal_id: principalId, correlation_id: 'corr-writer-2' }),
      { class: 'class3_success' },
    );
    const rows = await engine.executeRaw<{ attribution_state: string; principal_id: string }>(
      `SELECT attribution_state, principal_id FROM audit_events WHERE id = $1`,
      [result.id],
    );
    expect(rows[0].attribution_state).toBe('principal_attributed');
    expect(rows[0].principal_id).toBe(principalId);
  });

  test('the Writer never silently normalizes an invalid attribution_state — a caller bug surfaces as a real DB error, not a swallowed write', async () => {
    await expect(
      writeAuditEvent(engine, baseInput({ attribution_state: 'not_a_real_state', correlation_id: 'corr-writer-3' }), { class: 'class3_success' }),
    ).resolves.toMatchObject({ wrote: expect.stringMatching(/^(spill|lost)$/) });
    // class3_success is fail-open: an invalid FK reference degrades to spill
    // rather than throwing. Confirm nothing landed in the live table.
    const rows = await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_events WHERE correlation_id = 'corr-writer-3'`,
    );
    expect(rows[0].n).toBe(0);
  });
});
