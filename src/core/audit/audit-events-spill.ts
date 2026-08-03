/**
 * Phase 9C (Universal Audit Event Integration) — durable spill for
 * `audit_events` rows that could not be written to the DB.
 *
 * Design reference: PHASE9C-FAILURE-AND-DURABILITY-POLICY.md §6-2..§6-5.
 *
 * Deliberately independent of `createAuditWriter()` (audit-writer.ts):
 * that primitive's `log()` is synchronous (`fs.appendFileSync`), which
 * would block the event loop on the highest-frequency MCP path during a
 * DB outage with concurrent traffic. Spill here uses `fs.promises.*`
 * throughout. `readRecent()`'s silent-skip-on-parse-failure semantics
 * are also intentionally NOT reused — replay quarantines corrupt rows
 * instead of dropping them (see `replayOneFile` below).
 */

import * as fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { resolveAuditDir, computeIsoWeekFilename } from './audit-writer.ts';
import type { AuditEventEnvelope } from './audit-events-types.ts';

const SPILL_PREFIX = 'audit-spill';
const CORRUPT_FILENAME = 'audit-spill-corrupt.jsonl';
const CRITICAL_FAILURES_FILENAME = 'audit-critical-failures.log';
const FILE_MODE = 0o600;

function spillFilePath(now: Date = new Date()): string {
  return path.join(resolveAuditDir(), computeIsoWeekFilename(SPILL_PREFIX, now));
}

function corruptFilePath(): string {
  return path.join(resolveAuditDir(), CORRUPT_FILENAME);
}

function criticalFailuresPath(): string {
  return path.join(resolveAuditDir(), CRITICAL_FAILURES_FILENAME);
}

/**
 * Append one envelope to this week's spill file. Non-blocking I/O, mode
 * 0600 (spill rows carry actor_label, redacted error_message, masked IPs,
 * credential_ref — sensitive enough to protect even after redaction).
 * Returns true on success, false on failure (caller decides what "both
 * DB and spill failed" means for its class).
 */
export async function spillAuditEvent(envelope: AuditEventEnvelope): Promise<boolean> {
  const dir = resolveAuditDir();
  const file = spillFilePath();
  try {
    await fsp.mkdir(dir, { recursive: true });
    await fsp.appendFile(file, JSON.stringify(envelope) + '\n', { encoding: 'utf8', mode: FILE_MODE });
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[audit_events] spill write failed (${msg})\n`);
    return false;
  }
}

/**
 * Append one line verbatim to the double-failure marker log
 * (PHASE9C-FAILURE-AND-DURABILITY-POLICY.md §4/§5/§6-5): timestamp +
 * a short reason, nothing else. `gbrain doctor` treats this file's
 * non-empty existence as a non-zero-exit condition.
 */
export async function writeCriticalFailureMarker(reason: string): Promise<void> {
  const dir = resolveAuditDir();
  const line = `${new Date().toISOString()} ${reason}\n`;
  try {
    await fsp.mkdir(dir, { recursive: true });
    await fsp.appendFile(criticalFailuresPath(), line, { encoding: 'utf8', mode: FILE_MODE });
  } catch (err) {
    // Last-resort fallback per §4: never let this itself throw into a
    // request path. stderr is the final backstop.
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[audit_events] CRITICAL: failed to write critical-failures marker (${msg}); original reason: ${reason}\n`);
  }
}

/** List spill files pending replay: `audit-spill-*.jsonl` and any leftover `.inprogress` from an aborted prior replay. Excludes `.replayed` (already done) and the corrupt/critical-failures files themselves. */
function listPendingSpillFiles(): string[] {
  const dir = resolveAuditDir();
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.startsWith(`${SPILL_PREFIX}-`) && n !== CORRUPT_FILENAME && (n.endsWith('.jsonl') || n.endsWith('.jsonl.inprogress')))
    .sort();
}

/** Count lines across all pending (not-yet-replayed) spill files. Used by doctor / /admin/api/health-indicators as `audit_spill_pending`. */
export async function countPendingSpillLines(): Promise<number> {
  const dir = resolveAuditDir();
  let total = 0;
  for (const name of listPendingSpillFiles()) {
    try {
      const content = await fsp.readFile(path.join(dir, name), 'utf8');
      for (const line of content.split('\n')) {
        if (line.length > 0) total += 1;
      }
    } catch {
      // File vanished between listing and read (e.g. a concurrent
      // replay finished it) — not pending anymore, don't count it.
    }
  }
  return total;
}

export async function isCorruptSpillNonEmpty(): Promise<boolean> {
  try {
    const stat = await fsp.stat(corruptFilePath());
    return stat.size > 0;
  } catch {
    return false;
  }
}

export async function isCriticalFailuresNonEmpty(): Promise<boolean> {
  try {
    const stat = await fsp.stat(criticalFailuresPath());
    return stat.size > 0;
  } catch {
    return false;
  }
}

async function quarantineCorruptLine(rawLine: string): Promise<void> {
  const dir = resolveAuditDir();
  try {
    await fsp.mkdir(dir, { recursive: true });
    await fsp.appendFile(corruptFilePath(), rawLine.endsWith('\n') ? rawLine : rawLine + '\n', {
      encoding: 'utf8',
      mode: FILE_MODE,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[audit_events] failed to quarantine corrupt spill line (${msg}); line dropped: ${rawLine.slice(0, 200)}\n`);
  }
}

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
  ON CONFLICT (id) DO NOTHING
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

export interface ReplayFileResult {
  file: string;
  replayed: number; // successfully inserted or already-present (ON CONFLICT no-op)
  quarantined: number; // malformed JSON or DB-rejected rows moved to the corrupt file
  aborted: boolean; // true if a non-data-shape error (e.g. DB unreachable) stopped this file early
}

/**
 * Replay one pending spill file. Rename-then-read (not read-then-rename):
 * the file is renamed to `.inprogress` FIRST, so any concurrent
 * `spillAuditEvent()` call for the same ISO week immediately starts a
 * fresh file at the original name instead of racing an append against
 * this read (PHASE9C-FAILURE-AND-DURABILITY-POLICY.md §6-3 TOCTOU fix).
 *
 * A line that fails `JSON.parse`, or that parses but is rejected by the
 * DB for a data-shape reason (Postgres SQLSTATE class 23 — NOT NULL/
 * CHECK/FK violation), is quarantined to `audit-spill-corrupt.jsonl` and
 * processing continues with the next line — never silently dropped, per
 * the "no silent catch{}" rule. A non-data-shape failure (DB unreachable,
 * timeout) aborts processing of THIS file immediately; the `.inprogress`
 * file is left in place for the next `replaySpill()` call to retry (rows
 * already inserted are safely re-attempted via `ON CONFLICT DO NOTHING`;
 * rows already quarantined may be quarantined again — a redundant but not
 * lossy outcome).
 */
async function replayOneFile(engine: BrainEngine, dir: string, name: string): Promise<ReplayFileResult> {
  const originalPath = path.join(dir, name);
  const inProgressPath = name.endsWith('.inprogress') ? originalPath : `${originalPath}.inprogress`;
  if (!name.endsWith('.inprogress')) {
    await fsp.rename(originalPath, inProgressPath);
  }

  let content: string;
  try {
    content = await fsp.readFile(inProgressPath, 'utf8');
  } catch (err) {
    // File vanished (e.g. two replay-spill runs raced) — nothing to do.
    return { file: inProgressPath, replayed: 0, quarantined: 0, aborted: false };
  }

  const lines = content.split('\n').filter((l) => l.length > 0);
  let replayed = 0;
  let quarantined = 0;

  for (const line of lines) {
    let envelope: AuditEventEnvelope;
    try {
      envelope = JSON.parse(line) as AuditEventEnvelope;
    } catch {
      await quarantineCorruptLine(line);
      quarantined += 1;
      continue;
    }

    try {
      await engine.executeRaw(INSERT_SQL, envelopeToParams(envelope));
      replayed += 1;
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (typeof code === 'string' && code.startsWith('23')) {
        // Data-shape rejection (NOT NULL / CHECK / FK) — retrying won't
        // help; quarantine so the file can still be marked processed.
        await quarantineCorruptLine(line);
        quarantined += 1;
        continue;
      }
      // Anything else (DB unreachable, timeout, ...): abort this file.
      // Leave it as `.inprogress` for the next replay-spill invocation.
      return { file: inProgressPath, replayed, quarantined, aborted: true };
    }
  }

  const donePath = originalPath.endsWith('.jsonl') ? `${originalPath}.replayed` : `${inProgressPath}.replayed`;
  await fsp.rename(inProgressPath, donePath);
  return { file: donePath, replayed, quarantined, aborted: false };
}

/** Replay every pending spill file. Files that abort mid-way (DB unreachable) are left `.inprogress` and reported with `aborted: true`; call again later. */
export async function replaySpill(engine: BrainEngine): Promise<ReplayFileResult[]> {
  const dir = resolveAuditDir();
  const results: ReplayFileResult[] = [];
  for (const name of listPendingSpillFiles()) {
    results.push(await replayOneFile(engine, dir, name));
  }
  return results;
}

export { spillFilePath, corruptFilePath, criticalFailuresPath };
