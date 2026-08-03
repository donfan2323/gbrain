/**
 * Phase 9C (Universal Audit Event Integration) — shared types for the
 * `audit_events` writer, spill/replay, and entrypoint registry.
 *
 * Design reference: PHASE9C-AUDIT-EVENT-DOMAIN-MODEL.md §1-2 (column
 * list), PHASE9C-FAILURE-AND-DURABILITY-POLICY.md §1 (failure classes).
 */

/** The four failure-policy classes (PHASE9C-FAILURE-AND-DURABILITY-POLICY.md §1). */
export type AuditFailureClass =
  | 'class1_issuance'   // fail-closed, same-transaction or pre-condition on the caller
  | 'class1_revocation' // exceptionally fail-open, critical-failures.log on any DB+spill failure
  | 'class2_denial'     // degraded-durable, response never blocked on audit success
  | 'class3_success'    // fail-open + durable spill + alert
  | 'class4_internal';  // fail-open, same mechanics as class3

/**
 * Full `audit_events` row shape, including columns the Writer fills in
 * itself (id, recorded_at). This is also the exact envelope shape written
 * to spill files, so a spilled row and a live-inserted row are
 * byte-identical in field set.
 */
export interface AuditEventEnvelope {
  id: string; // UUID, generated client-side (crypto.randomUUID()) before any I/O
  envelope_version: number;
  occurred_at: string; // ISO 8601
  recorded_at: string; // ISO 8601, stamped at write-attempt time
  event_kind: string;
  channel_id: string;
  attribution_state: string;
  principal_id: string | null;
  client_id: string | null;
  actor_label: string | null;
  credential_ref: string | null;
  operation: string;
  required_scope: string | null;
  scopes_snapshot: string[] | null;
  decision: 'allowed' | 'denied' | 'not_applicable';
  outcome: 'succeeded' | 'failed' | 'rejected' | 'pending';
  reason_code: string | null;
  resource_kind: string | null;
  resource_ref: string | null;
  source_id: string | null;
  job_id: number | null;
  correlation_id: string;
  parent_event_id: string | null;
  latency_ms: number | null;
  error_message: string | null;
  params_summary: Record<string, unknown> | null;
  adapter: Record<string, unknown>;
}

/**
 * What a call site provides. The Writer fills in `id` (crypto.randomUUID())
 * and `recorded_at` (write-attempt time) — everything else must be
 * supplied. `error_message` is redacted by the Writer before it is ever
 * persisted (audit-events-redact.ts); callers pass the raw message.
 */
export type AuditEventInput = Omit<AuditEventEnvelope, 'id' | 'recorded_at' | 'error_message'> & {
  errorMessageRaw?: string | null;
};
