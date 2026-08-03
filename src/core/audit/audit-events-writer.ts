/**
 * Phase 9C (Universal Audit Event Integration) — the `audit_events` Writer.
 *
 * Design reference: PHASE9C-FAILURE-AND-DURABILITY-POLICY.md (all of it).
 * One entry point, `writeAuditEvent()`, dispatches on `AuditFailureClass`:
 *
 *   - class1_issuance: fail-closed. If `opts.tx` is supplied, the caller
 *     has already opened `engine.transaction()` around a DB state change
 *     (§2-1) — the INSERT runs inside that SAME transaction via SAVEPOINT-
 *     scoped bounded retry, and a throw here propagates out to roll back
 *     the whole transaction (state change included). If `opts.tx` is
 *     omitted, the caller's state change is in-memory (§2-2, e.g.
 *     adminSessions.set) — this function opens its own top-level
 *     transaction for the INSERT, falls back to spill on failure, and
 *     returns `wrote: 'lost'` only if BOTH fail; the caller MUST NOT
 *     mutate its in-memory state when `wrote === 'lost'` and must return
 *     503.
 *   - class1_revocation / class2_denial / class3_success / class4_internal:
 *     fail-open, never throws. Single attempt, no retry, short timeout.
 *     class1_revocation additionally writes the critical-failures marker
 *     on ANY DB failure (even if spill succeeds) — PHASE9C-FAILURE-AND-
 *     DURABILITY-POLICY.md §2-4.
 *
 * §7-1's absolute rule applies throughout: a monitoring failure NEVER
 * changes an authorization outcome. This module has no path that reads
 * `principal_id`/`attribution_state`/etc. to decide anything — it only
 * persists what the caller already decided.
 */

import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import { isRetryableError } from '../retry-matcher.ts';
import { redactErrorMessage } from './audit-events-redact.ts';
import { spillAuditEvent, writeCriticalFailureMarker } from './audit-events-spill.ts';
import { incrementAuditWriteFailures } from './audit-events-metrics.ts';
import type { AuditEventEnvelope, AuditEventInput, AuditFailureClass } from './audit-events-types.ts';

const INSERT_SQL = `
  INSERT INTO audit_events (
    id, envelope_version, occurred_at, recorded_at, event_kind, channel_id,
    attribution_state, principal_id, client_id, actor_label, credential_ref,
    operation, required_scope, scopes_snapshot, decision, outcome,
    reason_code, resource_kind, resource_ref, source_id, job_id,
    correlation_id, parent_event_id, latency_ms, error_message,
    params_summary, adapter
  ) VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
    $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27
  )
`;

function envelopeToParams(e: AuditEventEnvelope): unknown[] {
  return [
    e.id, e.envelope_version, e.occurred_at, e.recorded_at, e.event_kind, e.channel_id,
    e.attribution_state, e.principal_id, e.client_id, e.actor_label, e.credential_ref,
    e.operation, e.required_scope, e.scopes_snapshot, e.decision, e.outcome,
    e.reason_code, e.resource_kind, e.resource_ref, e.source_id, e.job_id,
    e.correlation_id, e.parent_event_id, e.latency_ms, e.error_message,
    e.params_summary ? JSON.stringify(e.params_summary) : null,
    JSON.stringify(e.adapter ?? {}),
  ];
}

function buildEnvelope(input: AuditEventInput): AuditEventEnvelope {
  return {
    id: randomUUID(),
    recorded_at: new Date().toISOString(),
    envelope_version: input.envelope_version ?? 1,
    occurred_at: input.occurred_at,
    event_kind: input.event_kind,
    channel_id: input.channel_id,
    attribution_state: input.attribution_state,
    principal_id: input.principal_id ?? null,
    client_id: input.client_id ?? null,
    actor_label: input.actor_label ?? null,
    credential_ref: input.credential_ref ?? null,
    operation: input.operation,
    required_scope: input.required_scope ?? null,
    scopes_snapshot: input.scopes_snapshot ?? null,
    decision: input.decision,
    outcome: input.outcome,
    reason_code: input.reason_code ?? null,
    resource_kind: input.resource_kind ?? null,
    resource_ref: input.resource_ref ?? null,
    source_id: input.source_id ?? null,
    job_id: input.job_id ?? null,
    correlation_id: input.correlation_id,
    parent_event_id: input.parent_event_id ?? null,
    latency_ms: input.latency_ms ?? null,
    error_message: redactErrorMessage(input.errorMessageRaw) ?? null,
    params_summary: input.params_summary ?? null,
    adapter: input.adapter ?? {},
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Insert one row on a given (already-open-or-fresh) transaction handle,
 * with an explicit per-attempt statement_timeout and optional bounded
 * SAVEPOINT-based retry for transient errors only (constraint violations
 * are never retried — PHASE9C-FAILURE-AND-DURABILITY-POLICY.md §6-1).
 *
 * `tx` MUST be a `BrainEngine` obtained from `engine.transaction()` (or
 * a nested SAVEPOINT context on one) — `SET LOCAL statement_timeout`
 * requires an open transaction to avoid leaking the GUC onto a pooled
 * connection (existing codebase convention, see postgres-engine.ts).
 */
async function insertWithBoundedRetry(
  tx: BrainEngine,
  envelope: AuditEventEnvelope,
  opts: { timeoutMs: number; maxRetries: number; backoffsMs: number[] },
): Promise<void> {
  await tx.executeRaw(`SET LOCAL statement_timeout = '${Math.max(1, Math.round(opts.timeoutMs))}ms'`);

  if (opts.maxRetries === 0) {
    await tx.executeRaw(INSERT_SQL, envelopeToParams(envelope));
    return;
  }

  const params = envelopeToParams(envelope);
  for (let attempt = 0; ; attempt++) {
    await tx.executeRaw('SAVEPOINT audit_ins');
    try {
      await tx.executeRaw(INSERT_SQL, params);
      await tx.executeRaw('RELEASE SAVEPOINT audit_ins');
      return;
    } catch (err) {
      await tx.executeRaw('ROLLBACK TO SAVEPOINT audit_ins');
      const retryable = isRetryableError(err);
      if (!retryable || attempt >= opts.maxRetries) throw err;
      const backoff = opts.backoffsMs[attempt] ?? opts.backoffsMs[opts.backoffsMs.length - 1] ?? 100;
      await sleep(backoff);
    }
  }
}

export interface WriteAuditEventOptions {
  class: AuditFailureClass;
  /** class1_issuance only: the transaction the caller already opened around its DB state change. Ignored for other classes. */
  tx?: BrainEngine;
}

export interface WriteAuditEventResult {
  id: string;
  wrote: 'db' | 'spill' | 'lost';
}

const ISSUANCE_TIMEOUT_MS = 2000;
const ISSUANCE_MAX_RETRIES = 2;
const ISSUANCE_BACKOFFS_MS = [25, 100];
const FAST_TIMEOUT_MS = 300;

export async function writeAuditEvent(
  engine: BrainEngine,
  input: AuditEventInput,
  opts: WriteAuditEventOptions,
): Promise<WriteAuditEventResult> {
  const envelope = buildEnvelope(input);

  if (opts.class === 'class1_issuance' && opts.tx) {
    // §2-1: same-transaction-as-state-change. Let failures propagate —
    // the caller's engine.transaction() call rolls back the state change
    // along with this INSERT. No spill fallback here: spilling before an
    // abort would record an event for something that never happened.
    await insertWithBoundedRetry(opts.tx, envelope, {
      timeoutMs: ISSUANCE_TIMEOUT_MS,
      maxRetries: ISSUANCE_MAX_RETRIES,
      backoffsMs: ISSUANCE_BACKOFFS_MS,
    });
    return { id: envelope.id, wrote: 'db' };
  }

  if (opts.class === 'class1_issuance') {
    // §2-2: in-memory state change. Try DB, then spill; if both fail the
    // caller must not mutate its state and must return 503.
    try {
      await engine.transaction(async (tx) => {
        await insertWithBoundedRetry(tx, envelope, {
          timeoutMs: ISSUANCE_TIMEOUT_MS,
          maxRetries: ISSUANCE_MAX_RETRIES,
          backoffsMs: ISSUANCE_BACKOFFS_MS,
        });
      });
      return { id: envelope.id, wrote: 'db' };
    } catch (dbErr) {
      const spilled = await spillAuditEvent(envelope);
      incrementAuditWriteFailures();
      if (spilled) return { id: envelope.id, wrote: 'spill' };
      return { id: envelope.id, wrote: 'lost' };
    }
  }

  // class1_revocation / class2_denial / class3_success / class4_internal:
  // fail-open, single attempt, no retry, short timeout, never throws.
  try {
    await engine.transaction(async (tx) => {
      await insertWithBoundedRetry(tx, envelope, { timeoutMs: FAST_TIMEOUT_MS, maxRetries: 0, backoffsMs: [] });
    });
    return { id: envelope.id, wrote: 'db' };
  } catch (dbErr) {
    const spilled = await spillAuditEvent(envelope);
    incrementAuditWriteFailures();
    const dbMsg = dbErr instanceof Error ? dbErr.message : String(dbErr);
    if (spilled) {
      if (opts.class === 'class1_revocation') {
        // §2-4: revocation's audit gap is high-severity regardless of
        // whether spill itself succeeded — always mark it critical.
        await writeCriticalFailureMarker(`class1_revocation: DB insert failed (spill succeeded), event=${envelope.event_kind} op=${envelope.operation}: ${dbMsg}`);
      }
      return { id: envelope.id, wrote: 'spill' };
    }
    // Double failure: DB insert AND spill both failed.
    await writeCriticalFailureMarker(`${opts.class}: DB insert AND spill both failed, event=${envelope.event_kind} op=${envelope.operation}: ${dbMsg}`);
    process.stderr.write(`[audit_events] write failed and spill failed (${opts.class}): ${dbMsg}\n`);
    return { id: envelope.id, wrote: 'lost' };
  }
}

export { buildEnvelope };
