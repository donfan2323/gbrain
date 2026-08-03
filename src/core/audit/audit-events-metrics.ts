/**
 * Phase 9C (Universal Audit Event Integration) — process-local counter.
 *
 * `audit_write_failures_total` is deliberately in-memory only
 * (PHASE9C-FAILURE-AND-DURABILITY-POLICY.md §6-5): it is NOT visible to
 * `gbrain doctor` (a separately-spawned CLI process can't read another
 * process's memory) — doctor relies solely on the file-based indicators
 * in audit-events-spill.ts. This counter is exposed only via
 * `/admin/api/health-indicators`, which runs in the same HTTP server
 * process that incremented it.
 */

let auditWriteFailuresTotal = 0;

/** Call whenever `writeAuditEvent()` returns `wrote !== 'db'` (spilled or lost). */
export function incrementAuditWriteFailures(): void {
  auditWriteFailuresTotal += 1;
}

export function getAuditWriteFailuresTotal(): number {
  return auditWriteFailuresTotal;
}

/** Test-only reset so suites don't leak counter state across cases. */
export function _resetAuditWriteFailuresForTests(): void {
  auditWriteFailuresTotal = 0;
}
