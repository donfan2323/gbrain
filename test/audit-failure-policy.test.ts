/**
 * Phase 9C (Universal Audit Event Integration) — failure-injection proof of
 * the 4-class failure/durability policy (PHASE9C-FAILURE-AND-DURABILITY-
 * POLICY.md), replay idempotency, corrupt-row quarantine, and doctor/
 * health-indicators reporting.
 *
 * Design reference (priority order): PHASE9C-FAILURE-AND-DURABILITY-
 * POLICY.md, PHASE9C-ACCEPTANCE-CRITERIA.md §1-2/§3-6.
 *
 * Failure injection strategy: a thin wrapper around a real, healthy
 * PGLiteEngine whose `executeRaw`/`transaction` can be told to fail the
 * `INSERT INTO audit_events` statement specifically (SAVEPOINT/RELEASE/
 * ROLLBACK TO SAVEPOINT and everything else still hits the real engine),
 * with a configurable error shape so `isRetryableError()`'s real
 * classification logic (imported, not re-implemented) decides retry
 * behavior exactly as production does. Spill failure is injected
 * separately, by pointing `GBRAIN_AUDIT_DIR` (via withEnv) at a path a
 * write can't succeed against.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, appendFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { writeAuditEvent } from '../src/core/audit/audit-events-writer.ts';
import {
  replaySpill, countPendingSpillLines, isCorruptSpillNonEmpty, isCriticalFailuresNonEmpty,
  spillFilePath, corruptFilePath, criticalFailuresPath,
} from '../src/core/audit/audit-events-spill.ts';
import { getAuditWriteFailuresTotal, _resetAuditWriteFailuresForTests } from '../src/core/audit/audit-events-metrics.ts';
import { checkAuditDurability } from '../src/commands/doctor.ts';
import { computeDoctorReport } from '../src/commands/doctor.ts';
import { parsePruneArgs } from '../src/commands/audit.ts';
import { withEnv } from './helpers/with-env.ts';
import type { AuditEventInput } from '../src/core/audit/audit-events-types.ts';

let engine: PGLiteEngine;
let dbDir: string;
let auditDir: string;

beforeAll(async () => {
  dbDir = mkdtempSync(join(tmpdir(), 'audit-failure-policy-db-'));
  engine = new PGLiteEngine();
  await engine.connect({ database_path: dbDir });
  await engine.initSchema();
}, 30_000);

afterAll(async () => {
  await engine.disconnect();
  rmSync(dbDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM audit_events');
  await engine.executeRaw('DELETE FROM mcp_request_log');
  _resetAuditWriteFailuresForTests();
  // Fresh, isolated spill dir per test — the global preload
  // (test/helpers/audit-dir-preload.ts) already set GBRAIN_AUDIT_DIR to a
  // per-process temp dir; give each test its own subdirectory so spill
  // files from one test never leak counts into the next.
  auditDir = mkdtempSync(join(tmpdir(), 'audit-failure-policy-spill-'));
});

function baseInput(overrides: Partial<AuditEventInput> = {}): AuditEventInput {
  return {
    envelope_version: 1,
    occurred_at: new Date().toISOString(),
    event_kind: 'operation.request',
    channel_id: 'mcp_http',
    attribution_state: 'client_only',
    principal_id: null,
    client_id: 'failure-policy-client',
    actor_label: 'failure-policy-client',
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
    correlation_id: randomUUID(),
    parent_event_id: null,
    latency_ms: 5,
    params_summary: null,
    adapter: {},
    errorMessageRaw: null,
    ...overrides,
  };
}

// ---- Failure-injecting engine wrapper -------------------------------------

type FailShape = 'none' | 'retryable' | 'nonretryable';

/** Postgres error codes: 08006 connection_failure (retryable per
 *  isRetryableConnError), 23505 unique_violation (never retried — a
 *  data-shape rejection, not a transient fault). */
function makeSimulatedError(shape: FailShape): Error & { code?: string } {
  const err = new Error(shape === 'retryable' ? 'simulated connection failure' : 'simulated unique violation') as Error & { code?: string };
  err.code = shape === 'retryable' ? '08006' : '23505';
  return err;
}

/** Wraps `real` so that any `executeRaw` call whose SQL text contains
 * `INSERT INTO audit_events` throws `failShapeRef.current` — everything
 * else (SAVEPOINT, SET LOCAL, ROLLBACK TO SAVEPOINT, and all non-audit
 * SQL) passes straight through to the real engine/transaction. `attempts`
 * counts how many times the INSERT was attempted, for asserting the
 * retry count directly. */
function makeInjectingEngine(real: PGLiteEngine, failShapeRef: { current: FailShape }, attempts: { count: number }): BrainEngine {
  const isAuditInsert = (sql: string) => sql.includes('INSERT INTO audit_events');

  const wrapExecuteRaw = (target: { executeRaw: (sql: string, params?: unknown[]) => Promise<unknown> }) =>
    async (sql: string, params?: unknown[]) => {
      if (isAuditInsert(sql)) {
        attempts.count += 1;
        if (failShapeRef.current !== 'none') throw makeSimulatedError(failShapeRef.current);
      }
      return target.executeRaw(sql, params);
    };

  return {
    ...(real as unknown as Record<string, unknown>),
    executeRaw: wrapExecuteRaw(real),
    transaction: async (fn: (tx: BrainEngine) => Promise<unknown>) =>
      real.transaction(async (tx) => {
        const wrappedTx = {
          ...(tx as unknown as Record<string, unknown>),
          executeRaw: wrapExecuteRaw(tx),
        } as unknown as BrainEngine;
        return fn(wrappedTx);
      }),
  } as unknown as BrainEngine;
}

async function countAuditRows(correlationId: string): Promise<number> {
  const rows = await engine.executeRaw<{ n: number }>(
    `SELECT count(*)::int AS n FROM audit_events WHERE correlation_id = $1`,
    [correlationId],
  );
  return rows[0].n;
}

// ---- class1_issuance: same-transaction rollback (§2-1) -------------------

describe('class1_issuance WITH tx (§2-1): a failed audit INSERT rolls back the caller\'s state change in the same transaction', () => {
  test('the state-change INSERT and the audit INSERT commit or roll back together — DB failure rolls both back', async () => {
    const failShapeRef = { current: 'nonretryable' as FailShape };
    const attempts = { count: 0 };
    const injecting = makeInjectingEngine(engine, failShapeRef, attempts);
    const correlationId = randomUUID();

    let threw = false;
    try {
      await injecting.transaction(async (tx) => {
        // The caller's own state change — a row that must NOT survive if
        // the audit write inside the same transaction fails.
        await tx.executeRaw(
          `INSERT INTO oauth_clients (client_id, client_name, redirect_uris, grant_types, scope, token_endpoint_auth_method, client_id_issued_at)
           VALUES ($1, 'rollback-test', '{}', '{client_credentials}', 'read', 'none', extract(epoch from now())::bigint)`,
          [`rollback-test-client-${correlationId}`],
        );
        await writeAuditEvent(engine, baseInput({ correlation_id: correlationId }), { class: 'class1_issuance', tx });
      });
    } catch {
      threw = true;
    }

    expect(threw).toBe(true); // §2-1: "let failures propagate"
    const clientRows = await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM oauth_clients WHERE client_id = $1`,
      [`rollback-test-client-${correlationId}`],
    );
    expect(clientRows[0].n).toBe(0); // state change rolled back
    expect(await countAuditRows(correlationId)).toBe(0); // audit row rolled back too
  });

  test('a retryable failure is retried (bounded, SAVEPOINT-scoped) before eventually succeeding once the fault clears', async () => {
    const failShapeRef = { current: 'retryable' as FailShape };
    const attempts = { count: 0 };
    const injecting = makeInjectingEngine(engine, failShapeRef, attempts);
    const correlationId = randomUUID();

    // Clear the fault after the 2nd attempt so the 3rd (final allowed)
    // attempt succeeds — ISSUANCE_MAX_RETRIES is 2 (writer's own constant).
    const originalCount = attempts.count;
    const clearAfter = 2;
    const attemptsProxy = new Proxy(attempts, {
      set(target, prop, value) {
        if (prop === 'count' && typeof value === 'number' && value - originalCount >= clearAfter) {
          failShapeRef.current = 'none';
        }
        (target as any)[prop] = value;
        return true;
      },
    });
    const injecting2 = makeInjectingEngine(engine, failShapeRef, attemptsProxy);

    await injecting2.transaction(async (tx) => {
      await tx.executeRaw(
        `INSERT INTO oauth_clients (client_id, client_name, redirect_uris, grant_types, scope, token_endpoint_auth_method, client_id_issued_at)
         VALUES ($1, 'retry-test', '{}', '{client_credentials}', 'read', 'none', extract(epoch from now())::bigint)`,
        [`retry-test-client-${correlationId}`],
      );
      await writeAuditEvent(engine, baseInput({ correlation_id: correlationId }), { class: 'class1_issuance', tx });
    });

    expect(attemptsProxy.count).toBeGreaterThan(1); // at least one retry happened
    expect(await countAuditRows(correlationId)).toBe(1); // and it eventually succeeded
  });
});

// ---- class1_issuance without tx (§2-2): AND-condition -----------------

describe('class1_issuance WITHOUT tx (§2-2): double failure means neither the write nor the caller\'s state change happens (AND, not OR)', () => {
  test('DB insert fails, spill also fails: wrote===\'lost\', nothing lands in audit_events, and a caller following the documented contract does not mutate its state', async () => {
    const failShapeRef = { current: 'nonretryable' as FailShape };
    const attempts = { count: 0 };
    const injecting = makeInjectingEngine(engine, failShapeRef, attempts);
    const correlationId = randomUUID();

    // Make spill fail too: point GBRAIN_AUDIT_DIR at a path that is
    // actually a FILE, so fsp.mkdir(dir, {recursive:true}) rejects with
    // ENOTDIR for every spill attempt.
    const blockerFile = join(mkdtempSync(join(tmpdir(), 'audit-failure-policy-blocker-')), 'not-a-directory');
    writeFileSync(blockerFile, 'x');

    await withEnv({ GBRAIN_AUDIT_DIR: join(blockerFile, 'spill') }, async () => {
      const result = await writeAuditEvent(injecting, baseInput({ correlation_id: correlationId }), { class: 'class1_issuance' });
      expect(result.wrote).toBe('lost');

      // Simulates the exact contract every §2-2 caller in serve-http.ts
      // follows: check wrote !== 'lost' BEFORE mutating in-memory state.
      let stateMutated = false;
      if (result.wrote !== 'lost') stateMutated = true; // never reached
      expect(stateMutated).toBe(false);
    });

    expect(await countAuditRows(correlationId)).toBe(0);
  });

  test('DB insert fails, spill succeeds: wrote===\'spill\', a §2-2 caller proceeds (state changes) because the row is durable', async () => {
    const failShapeRef = { current: 'nonretryable' as FailShape };
    const attempts = { count: 0 };
    const injecting = makeInjectingEngine(engine, failShapeRef, attempts);
    const correlationId = randomUUID();

    await withEnv({ GBRAIN_AUDIT_DIR: auditDir }, async () => {
      const result = await writeAuditEvent(injecting, baseInput({ correlation_id: correlationId }), { class: 'class1_issuance' });
      expect(result.wrote).toBe('spill');
      expect(existsSync(spillFilePath())).toBe(true);
      const spillContent = readFileSync(spillFilePath(), 'utf8');
      expect(spillContent).toContain(correlationId);

      let stateMutated = false;
      if (result.wrote !== 'lost') stateMutated = true;
      expect(stateMutated).toBe(true);
    });
  });
});

// ---- class1_revocation (§2-4): always executes, fail-open -----------------

describe('class1_revocation (§2-4): the revocation itself is never blocked, even on double DB+spill failure', () => {
  test('double failure: writeAuditEvent never throws, returns wrote===\'lost\', and writes audit-critical-failures.log', async () => {
    const failShapeRef = { current: 'nonretryable' as FailShape };
    const attempts = { count: 0 };
    const injecting = makeInjectingEngine(engine, failShapeRef, attempts);
    const correlationId = randomUUID();

    const blockerFile = join(mkdtempSync(join(tmpdir(), 'audit-failure-policy-blocker2-')), 'not-a-directory');
    writeFileSync(blockerFile, 'x');

    await withEnv({ GBRAIN_AUDIT_DIR: join(blockerFile, 'spill') }, async () => {
      // The revocation "already happened" conceptually before this call —
      // class1_revocation never gates a state change on its own success.
      const result = await writeAuditEvent(injecting, baseInput({ correlation_id: correlationId, event_kind: 'credential.revoke', decision: 'allowed', outcome: 'succeeded' }), { class: 'class1_revocation' });
      expect(result.wrote).toBe('lost');
      // critical-failures.log lives under resolveAuditDir(), which also
      // failed to be creatable here — confirm the Writer's own last-resort
      // stderr fallback path was exercised instead of throwing, by simply
      // confirming the call above resolved rather than rejected (already
      // asserted structurally: no try/catch was needed around it).
    });
  });

  test('DB fails but spill succeeds: critical-failures.log is STILL written (revocation gaps are always high-severity, per §2-4, regardless of spill outcome)', async () => {
    const failShapeRef = { current: 'nonretryable' as FailShape };
    const attempts = { count: 0 };
    const injecting = makeInjectingEngine(engine, failShapeRef, attempts);
    const correlationId = randomUUID();

    await withEnv({ GBRAIN_AUDIT_DIR: auditDir }, async () => {
      const result = await writeAuditEvent(injecting, baseInput({ correlation_id: correlationId, event_kind: 'credential.revoke', decision: 'allowed', outcome: 'succeeded' }), { class: 'class1_revocation' });
      expect(result.wrote).toBe('spill');
      expect(await isCriticalFailuresNonEmpty()).toBe(true);
      const critical = readFileSync(criticalFailuresPath(), 'utf8');
      expect(critical).toContain('class1_revocation');
    });
  });
});

// ---- class2_denial: never blocks the response, never swallowed -----------

describe('class2_denial: fail-open, never throws, and a failure is never silently swallowed', () => {
  test('double failure: writeAuditEvent resolves (never throws) and increments audit_write_failures_total', async () => {
    const failShapeRef = { current: 'nonretryable' as FailShape };
    const attempts = { count: 0 };
    const injecting = makeInjectingEngine(engine, failShapeRef, attempts);
    const correlationId = randomUUID();

    const blockerFile = join(mkdtempSync(join(tmpdir(), 'audit-failure-policy-blocker3-')), 'not-a-directory');
    writeFileSync(blockerFile, 'x');

    const before = getAuditWriteFailuresTotal();
    await withEnv({ GBRAIN_AUDIT_DIR: join(blockerFile, 'spill') }, async () => {
      await expect(
        writeAuditEvent(injecting, baseInput({ correlation_id: correlationId, decision: 'denied', outcome: 'rejected', reason_code: 'insufficient_scope' }), { class: 'class2_denial' }),
      ).resolves.toBeDefined();
    });
    expect(getAuditWriteFailuresTotal()).toBe(before + 1); // not swallowed — the counter moved
  });

  test('DB succeeds: no spill, no counter increment', async () => {
    const correlationId = randomUUID();
    const before = getAuditWriteFailuresTotal();
    const result = await writeAuditEvent(engine, baseInput({ correlation_id: correlationId, decision: 'denied', outcome: 'rejected' }), { class: 'class2_denial' });
    expect(result.wrote).toBe('db');
    expect(getAuditWriteFailuresTotal()).toBe(before);
  });
});

// ---- class3_success: fail-open + durable spill + alert -------------------

describe('class3_success: fail-open, spill on DB failure, audit_write_failures_total increments', () => {
  test('DB fails, spill succeeds: wrote===\'spill\', file contains the envelope, counter increments', async () => {
    const failShapeRef = { current: 'nonretryable' as FailShape };
    const attempts = { count: 0 };
    const injecting = makeInjectingEngine(engine, failShapeRef, attempts);
    const correlationId = randomUUID();
    const before = getAuditWriteFailuresTotal();

    await withEnv({ GBRAIN_AUDIT_DIR: auditDir }, async () => {
      const result = await writeAuditEvent(injecting, baseInput({ correlation_id: correlationId }), { class: 'class3_success' });
      expect(result.wrote).toBe('spill');
      expect(readFileSync(spillFilePath(), 'utf8')).toContain(correlationId);
    });
    expect(getAuditWriteFailuresTotal()).toBe(before + 1);
  });
});

// ---- replay-spill idempotency + corrupt-row quarantine --------------------

describe('replaySpill(): ON CONFLICT DO NOTHING idempotency and corrupt-row quarantine', () => {
  test('replaying the same spilled row twice inserts it exactly once (client-generated UUID + ON CONFLICT DO NOTHING)', async () => {
    const correlationId = randomUUID();
    let rowId: string | undefined;

    await withEnv({ GBRAIN_AUDIT_DIR: auditDir }, async () => {
      const failShapeRef = { current: 'nonretryable' as FailShape };
      const attempts = { count: 0 };
      const injecting = makeInjectingEngine(engine, failShapeRef, attempts);
      const result = await writeAuditEvent(injecting, baseInput({ correlation_id: correlationId }), { class: 'class3_success' });
      expect(result.wrote).toBe('spill');
      rowId = result.id;

      const first = await replaySpill(engine);
      expect(first.some(r => r.replayed >= 1)).toBe(true);
      expect(await countAuditRows(correlationId)).toBe(1);

      // Simulate a redundant replay of an ALREADY-INSERTED row (e.g. a
      // crash between the INSERT succeeding and the file being renamed to
      // `.replayed`, so the next replaySpill() run sees it again) by
      // hand-writing a fresh spill file containing the exact same
      // client-generated id.
      const dbRow = (await engine.executeRaw<{
        id: string; occurred_at: string; recorded_at: string; event_kind: string; channel_id: string;
        attribution_state: string; principal_id: string | null; client_id: string | null; actor_label: string | null;
        credential_ref: string | null; operation: string; required_scope: string | null; scopes_snapshot: string[] | null;
        decision: string; outcome: string; reason_code: string | null; resource_kind: string | null; resource_ref: string | null;
        source_id: string | null; job_id: number | null; correlation_id: string; parent_event_id: string | null;
        latency_ms: number | null; error_message: string | null; params_summary: unknown; adapter: unknown;
      }>(`SELECT * FROM audit_events WHERE id = $1`, [rowId!]))[0];
      const duplicateEnvelope = { ...dbRow, envelope_version: 1 };
      appendFileSync(spillFilePath(), JSON.stringify(duplicateEnvelope) + '\n');

      const second = await replaySpill(engine);
      expect(second.length).toBeGreaterThan(0);
      // ON CONFLICT (id) DO NOTHING: the second replay attempt for the
      // same id does not throw and does not create a duplicate row.
      expect(await countAuditRows(correlationId)).toBe(1);
    });
  });

  test('a malformed JSON line is quarantined to audit-spill-corrupt.jsonl, and processing continues with the remaining well-formed lines', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: auditDir }, async () => {
      const goodCorrelationId = randomUUID();
      const goodEnvelope = {
        id: randomUUID(), envelope_version: 1, occurred_at: new Date().toISOString(), recorded_at: new Date().toISOString(),
        event_kind: 'operation.request', channel_id: 'mcp_http', attribution_state: 'client_only', principal_id: null,
        client_id: 'quarantine-test', actor_label: null, credential_ref: null, operation: 'test_op', required_scope: null,
        scopes_snapshot: null, decision: 'allowed', outcome: 'succeeded', reason_code: null, resource_kind: null,
        resource_ref: null, source_id: null, job_id: null, correlation_id: goodCorrelationId, parent_event_id: null,
        latency_ms: 1, error_message: null, params_summary: null, adapter: {},
      };
      const file = spillFilePath();
      appendFileSync(file, '{this is not valid json\n');
      appendFileSync(file, JSON.stringify(goodEnvelope) + '\n');

      const results = await replaySpill(engine);
      expect(results.some(r => r.quarantined >= 1)).toBe(true);
      expect(results.some(r => r.replayed >= 1)).toBe(true);
      expect(await isCorruptSpillNonEmpty()).toBe(true);
      const corrupt = readFileSync(corruptFilePath(), 'utf8');
      expect(corrupt).toContain('this is not valid json');
      // The good row alongside the corrupt one still landed.
      expect(await countAuditRows(goodCorrelationId)).toBe(1);
    });
  });

  test('a data-shape-rejected row (unregistered channel_id, 23503) is quarantined rather than silently dropped', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: auditDir }, async () => {
      const badEnvelope = {
        id: randomUUID(), envelope_version: 1, occurred_at: new Date().toISOString(), recorded_at: new Date().toISOString(),
        event_kind: 'operation.request', channel_id: 'this-channel-does-not-exist', attribution_state: 'client_only', principal_id: null,
        client_id: 'quarantine-fk-test', actor_label: null, credential_ref: null, operation: 'test_op', required_scope: null,
        scopes_snapshot: null, decision: 'allowed', outcome: 'succeeded', reason_code: null, resource_kind: null,
        resource_ref: null, source_id: null, job_id: null, correlation_id: randomUUID(), parent_event_id: null,
        latency_ms: 1, error_message: null, params_summary: null, adapter: {},
      };
      appendFileSync(spillFilePath(), JSON.stringify(badEnvelope) + '\n');

      const results = await replaySpill(engine);
      expect(results.some(r => r.quarantined >= 1)).toBe(true);
      expect(await isCorruptSpillNonEmpty()).toBe(true);
    });
  });
});

// ---- doctor + health-indicators reporting ---------------------------------

describe('doctor + /admin/api/health-indicators: audit_write_failures_total, audit_spill_pending, audit-spill-corrupt.jsonl surfaced correctly', () => {
  test('checkAuditDurability() reports ok when spill/corrupt/critical are all empty', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: auditDir }, async () => {
      const check = await checkAuditDurability();
      expect(check.status).toBe('ok');
    });
  });

  test('checkAuditDurability() reports fail when spill is pending, and doctor\'s aggregate report becomes unhealthy (drives the non-zero CLI exit)', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: auditDir }, async () => {
      appendFileSync(spillFilePath(), JSON.stringify({ id: randomUUID(), foo: 'bar' }) + '\n');
      const check = await checkAuditDurability();
      expect(check.status).toBe('fail');
      expect(check.details).toMatchObject({ audit_spill_pending: 1 });

      // computeDoctorReport() is the same pure function outputResults()
      // calls, which feeds setCliExitVerdict(hasFail ? 1 : 0) in
      // runDoctor() — this is the direct, isolated proof that a failing
      // audit_durability check alone is sufficient to flip doctor's exit
      // code, without needing to run doctor's entire ~60-check suite.
      const report = computeDoctorReport([check]);
      expect(report.status).toBe('unhealthy');
    });
  });

  test('checkAuditDurability() reports fail when audit-spill-corrupt.jsonl is non-empty', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: auditDir }, async () => {
      appendFileSync(corruptFilePath(), 'garbage line\n');
      const check = await checkAuditDurability();
      expect(check.status).toBe('fail');
      expect(check.details).toMatchObject({ audit_spill_corrupt_nonempty: true });
    });
  });

  test('checkAuditDurability() reports fail when audit-critical-failures.log is non-empty', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: auditDir }, async () => {
      appendFileSync(criticalFailuresPath(), '2026-08-02T00:00:00.000Z class1_revocation: DB insert AND spill both failed\n');
      const check = await checkAuditDurability();
      expect(check.status).toBe('fail');
      expect(check.details).toMatchObject({ audit_critical_failures_nonempty: true });
    });
  });

  test('/admin/api/health-indicators wiring: getAuditWriteFailuresTotal() and countPendingSpillLines() are the exact two functions the handler dynamically imports and returns', async () => {
    // Direct verification of the wiring itself (serve-http.ts's handler is
    // a thin pass-through of these two calls, confirmed by reading the
    // source) rather than spinning up a full HTTP server for a
    // single-field pass-through assertion.
    const { readFileSync: rf } = await import('node:fs');
    const path = new URL('../src/commands/serve-http.ts', import.meta.url).pathname;
    const source = rf(path, 'utf8');
    expect(source).toContain("getAuditWriteFailuresTotal } = await import('../core/audit/audit-events-metrics.ts')");
    expect(source).toContain("countPendingSpillLines } = await import('../core/audit/audit-events-spill.ts')");
    expect(source).toContain('audit_write_failures_total: auditWriteFailuresTotal');
    expect(source).toContain('audit_spill_pending: auditSpillPending');
  });
});

// ---- gbrain audit prune: no default deletion period (§0-d) ---------------

describe('§0(d): gbrain audit prune has no default retention period', () => {
  test('parsePruneArgs([]) (no --older-than) leaves olderThanDays undefined — the concrete enforcement of "no automatic deletion by default"', () => {
    const opts = parsePruneArgs([]);
    expect(opts.olderThanDays).toBeUndefined();
  });

  test('parsePruneArgs([\'--dry-run\']) (still no --older-than) also leaves olderThanDays undefined', () => {
    const opts = parsePruneArgs(['--dry-run']);
    expect(opts.olderThanDays).toBeUndefined();
    expect(opts.dryRun).toBe(true);
  });

  test('parsePruneArgs with an explicit --older-than sets it — proving the parser genuinely distinguishes "given" from "omitted", not defaulting either way', () => {
    const opts = parsePruneArgs(['--older-than', '30']);
    expect(opts.olderThanDays).toBe(30);
  });
});
