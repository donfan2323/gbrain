#!/usr/bin/env bun
/**
 * Phase 9C (Universal Audit Event Integration) — `gbrain audit` CLI.
 *
 * Design reference: PHASE9C-FAILURE-AND-DURABILITY-POLICY.md §6-4, §6-6.
 *
 *   gbrain audit replay-spill              Re-insert spilled audit_events
 *                                           rows (ON CONFLICT DO NOTHING,
 *                                           idempotent). Quarantines
 *                                           malformed/rejected rows to
 *                                           audit-spill-corrupt.jsonl
 *                                           rather than dropping them.
 *   gbrain audit prune --older-than <days> [--dry-run] [--tables audit_events,mcp_request_log]
 *                                           Delete audit_events and/or
 *                                           mcp_request_log rows older
 *                                           than N days. No default
 *                                           period — omitting --older-than
 *                                           deletes nothing (§0(d):
 *                                           the default is no automatic
 *                                           deletion; this command is the
 *                                           explicit opt-in operators use).
 *   gbrain audit delegation-scope-shortfalls [--since-days N | --all-time]
 *                                           [--client-id ID] [--source-id ID] [--limit N] [--json]
 *                                           Phase 9E-2 prep (dashboard-v3mjk):
 *                                           aggregates AUTHZ-INV-017 warn-only
 *                                           `delegation_scope_shortfall` audit
 *                                           events per OAuth client, so an
 *                                           operator can see which clients
 *                                           would actually be denied if
 *                                           AUTHZ-INV-017 were switched from
 *                                           warn-only to enforce. Read-only —
 *                                           does not deny delegations, does
 *                                           not modify any client's scope.
 *                                           This is a DYNAMIC report over
 *                                           events that have actually
 *                                           occurred; `gbrain doctor`'s
 *                                           delegation_capability_health
 *                                           check is the complementary
 *                                           STATIC diagnosis of current
 *                                           oauth_clients configuration
 *                                           regardless of whether it has
 *                                           ever been exercised.
 */
import { loadConfig, toEngineConfig } from '../core/config.ts';
import { createEngine } from '../core/engine-factory.ts';
import type { BrainEngine } from '../core/engine.ts';
import { replaySpill, countPendingSpillLines, isCorruptSpillNonEmpty, isCriticalFailuresNonEmpty } from '../core/audit/audit-events-spill.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';
import {
  aggregateDelegationScopeShortfalls,
  type RawShortfallEvent,
  type ClientScopeSnapshot,
} from '../core/audit/delegation-scope-shortfall-report.ts';
import { operationsByName } from '../core/operations.ts';

async function withEngine<T>(fn: (engine: BrainEngine) => Promise<T>): Promise<T> {
  const config = loadConfig();
  if (!config) {
    console.error('No GBrain config found. Run `gbrain init` first, or set DATABASE_URL / GBRAIN_DATABASE_URL.');
    process.exit(1);
  }
  const engineConfig = toEngineConfig(config);
  const engine = await createEngine(engineConfig);
  await engine.connect(engineConfig);
  try {
    return await fn(engine);
  } finally {
    await engine.disconnect();
  }
}

async function replaySpillCommand(): Promise<void> {
  const before = await countPendingSpillLines();
  if (before === 0) {
    console.log('No pending spill lines.');
    return;
  }
  console.log(`${before} pending spill line(s) found. Replaying...`);
  await withEngine(async (engine) => {
    const results = await replaySpill(engine);
    let totalReplayed = 0;
    let totalQuarantined = 0;
    let anyAborted = false;
    for (const r of results) {
      totalReplayed += r.replayed;
      totalQuarantined += r.quarantined;
      if (r.aborted) anyAborted = true;
      console.log(`  ${r.file}: replayed=${r.replayed} quarantined=${r.quarantined}${r.aborted ? ' (ABORTED — DB unreachable, left in-progress for next run)' : ' (done)'}`);
    }
    console.log(`\nTotal: ${totalReplayed} replayed, ${totalQuarantined} quarantined.`);
    if (totalQuarantined > 0) {
      console.log('Quarantined rows were malformed JSON or rejected by the DB (NOT NULL/CHECK/FK violation) and were appended to audit-spill-corrupt.jsonl instead of being silently dropped.');
    }
    if (anyAborted) {
      console.log('\nSome files could not be fully replayed (DB unreachable partway through). Run `gbrain audit replay-spill` again once the DB is healthy.');
      setCliExitVerdict(1);
    }
  });
}

export interface PruneOpts {
  olderThanDays?: number;
  dryRun: boolean;
  tables: Array<'audit_events' | 'mcp_request_log'>;
}

/** Exported for test/audit-failure-policy.test.ts — §0(d)'s "no default
 *  deletion period" is a pure parsing behavior, testable without a live
 *  engine/config. Behavior unchanged; only the export keyword was added. */
export function parsePruneArgs(args: string[]): PruneOpts {
  const opts: PruneOpts = { dryRun: false, tables: ['audit_events', 'mcp_request_log'] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--older-than') {
      const v = args[++i];
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) {
        console.error(`--older-than requires a positive integer number of days, got: ${v}`);
        process.exit(1);
      }
      opts.olderThanDays = n;
    } else if (a === '--dry-run') {
      opts.dryRun = true;
    } else if (a === '--tables') {
      const v = args[++i] ?? '';
      const parsed = v.split(',').map((s) => s.trim()).filter(Boolean);
      const valid = new Set(['audit_events', 'mcp_request_log']);
      for (const t of parsed) {
        if (!valid.has(t)) {
          console.error(`Unknown table for --tables: ${t}. Valid: audit_events, mcp_request_log`);
          process.exit(1);
        }
      }
      if (parsed.length > 0) opts.tables = parsed as PruneOpts['tables'];
    }
  }
  return opts;
}

async function pruneCommand(args: string[]): Promise<void> {
  const opts = parsePruneArgs(args);
  if (opts.olderThanDays === undefined) {
    // §0(d): no default period. Omitting --older-than is a no-op, not an
    // error — this is the concrete enforcement of "default: no automatic
    // deletion."
    console.log('No --older-than given: nothing deleted (default is no automatic deletion). Pass --older-than <days> to prune.');
    return;
  }

  const cutoffExpr = `now() - interval '${opts.olderThanDays} days'`;

  await withEngine(async (engine) => {
    for (const table of opts.tables) {
      const timeCol = table === 'audit_events' ? 'occurred_at' : 'created_at';
      const countRows = await engine.executeRaw<{ n: string }>(
        `SELECT count(*)::text AS n FROM ${table} WHERE ${timeCol} < ${cutoffExpr}`,
      );
      const n = Number(countRows[0]?.n ?? '0');
      if (opts.dryRun) {
        console.log(`[dry-run] ${table}: ${n} row(s) older than ${opts.olderThanDays} day(s) would be deleted.`);
        continue;
      }
      if (n === 0) {
        console.log(`${table}: no rows older than ${opts.olderThanDays} day(s).`);
        continue;
      }
      await engine.executeRaw(`DELETE FROM ${table} WHERE ${timeCol} < ${cutoffExpr}`);
      console.log(`${table}: deleted ${n} row(s) older than ${opts.olderThanDays} day(s).`);
    }
  });
}

export interface DelegationScopeShortfallsArgs {
  /** null means --all-time (no lower bound). Default: 30. */
  sinceDays: number | null;
  allTime: boolean;
  clientId: string | undefined;
  /** audit_events.source_id is always NULL on delegation.grant rows (see
   *  delegationAuditBase in operations.ts) — there is no source_id column
   *  to filter on directly. This filters via the client's OWN registered
   *  oauth_clients.source_id instead (resolved to a client_id list before
   *  the audit_events query runs), which is the only semantically
   *  meaningful proxy the current schema offers. */
  sourceId: string | undefined;
  /** Caps the number of raw audit_events rows fetched (most-recent-first),
   *  not the number of clients in the report — a single very-active client
   *  could otherwise dominate an unbounded scan. Default: 500. */
  limit: number;
  json: boolean;
}

/** Exported for test/audit-delegation-scope-shortfalls.test.ts. Throws
 *  (not process.exit) so validation is unit-testable without killing the
 *  test process — the caller (delegationScopeShortfallsCommand) converts
 *  the throw into a printed error + exit(1), matching auth.ts's
 *  parseRegisterClientArgs/registerClient() split. */
export function parseDelegationScopeShortfallsArgs(args: string[]): DelegationScopeShortfallsArgs {
  const opts: DelegationScopeShortfallsArgs = {
    sinceDays: 30,
    allTime: false,
    clientId: undefined,
    sourceId: undefined,
    limit: 500,
    json: false,
  };
  let sinceDaysExplicit = false;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    const requireValue = () => {
      const v = args[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${flag} requires a value`);
      return v;
    };
    switch (flag) {
      case '--since-days': {
        const v = Number(requireValue());
        if (!Number.isInteger(v) || v <= 0) throw new Error('--since-days requires a positive integer');
        opts.sinceDays = v;
        sinceDaysExplicit = true;
        break;
      }
      case '--all-time':
        opts.allTime = true;
        opts.sinceDays = null;
        break;
      case '--client-id':
        opts.clientId = requireValue();
        break;
      case '--source-id':
        opts.sourceId = requireValue();
        break;
      case '--limit': {
        const v = Number(requireValue());
        if (!Number.isInteger(v) || v <= 0) throw new Error('--limit requires a positive integer');
        opts.limit = v;
        break;
      }
      case '--json':
        opts.json = true;
        break;
      default:
        throw new Error(`Unknown flag: ${flag}`);
    }
  }
  if (opts.allTime && sinceDaysExplicit) {
    throw new Error('--all-time and --since-days are mutually exclusive');
  }
  return opts;
}

function toIsoTimestamp(v: unknown): string {
  return v instanceof Date ? v.toISOString() : String(v);
}

export interface DelegationScopeShortfallsQueryResult {
  report: ReturnType<typeof aggregateDelegationScopeShortfalls>;
  /** true if the raw event fetch hit --limit — the report may be missing
   *  matching clients/events beyond what was fetched. */
  truncated: boolean;
}

/**
 * Exported (engine-injectable, no config/CLI-arg parsing) so
 * test/audit-delegation-scope-shortfalls.test.ts can seed a PGLiteEngine
 * directly and assert on the aggregated report — the same testability
 * pattern doctor.ts's checkOauthConfidentialHealth(engine) uses.
 */
export async function queryDelegationScopeShortfalls(
  engine: BrainEngine,
  opts: DelegationScopeShortfallsArgs,
): Promise<DelegationScopeShortfallsQueryResult> {
  // --source-id resolves via oauth_clients.source_id (the client's OWN
  // registered source), NOT audit_events.source_id — that column is always
  // NULL on delegation.grant rows (see delegationAuditBase in
  // operations.ts). If --source-id matches zero clients, short-circuit to
  // an empty result rather than issuing `client_id = ANY('{}')`, which is
  // valid SQL but wastes a round trip for a result we already know is empty.
  let sourceScopedClientIds: string[] | null = null;
  if (opts.sourceId) {
    const rows = await engine.executeRaw<{ client_id: string }>(
      `SELECT client_id FROM oauth_clients WHERE source_id = $1`,
      [opts.sourceId],
    );
    sourceScopedClientIds = rows.map(r => r.client_id);
    if (sourceScopedClientIds.length === 0) {
      return { report: [], truncated: false };
    }
  }

  const params: unknown[] = [];
  let clientFilter = '';
  if (opts.clientId) {
    params.push(opts.clientId);
    clientFilter = ` AND client_id = $${params.length}`;
  }
  let sourceFilter = '';
  if (sourceScopedClientIds) {
    params.push(sourceScopedClientIds);
    sourceFilter = ` AND client_id = ANY($${params.length})`;
  }
  // sinceDays is validated as a positive integer by the caller (or null for
  // --all-time) — safe to interpolate, not a string-injectable value.
  const timeFilter = opts.sinceDays !== null ? ` AND occurred_at >= now() - interval '${opts.sinceDays} days'` : '';
  params.push(opts.limit);
  const limitPlaceholder = `$${params.length}`;

  const rawRows = await engine.executeRaw<{
    client_id: string;
    occurred_at: unknown;
    correlation_id: string;
    params_summary: unknown;
  }>(
    `SELECT client_id, occurred_at, correlation_id, params_summary
       FROM audit_events
      WHERE event_kind = 'delegation.grant'
        AND reason_code = 'delegation_scope_shortfall'
        ${timeFilter}
        ${clientFilter}
        ${sourceFilter}
      ORDER BY occurred_at DESC
      LIMIT ${limitPlaceholder}`,
    params,
  );

  const clientIds = [...new Set(rawRows.map(r => r.client_id))];
  const clientScopes = new Map<string, ClientScopeSnapshot>();
  if (clientIds.length > 0) {
    const scopeRows = await engine.executeRaw<{ client_id: string; scope: string | null; deleted_at: unknown }>(
      `SELECT client_id, scope, deleted_at FROM oauth_clients WHERE client_id = ANY($1)`,
      [clientIds],
    );
    for (const r of scopeRows) {
      clientScopes.set(r.client_id, {
        clientId: r.client_id,
        scope: r.scope,
        deletedAt: r.deleted_at ? toIsoTimestamp(r.deleted_at) : null,
      });
    }
  }

  const events: RawShortfallEvent[] = rawRows.map(r => ({
    clientId: r.client_id,
    occurredAt: toIsoTimestamp(r.occurred_at),
    correlationId: r.correlation_id,
    paramsSummary: r.params_summary,
  }));

  const report = aggregateDelegationScopeShortfalls(
    events,
    clientScopes,
    tool => (operationsByName[tool]?.scope as string | undefined) ?? 'read',
  );
  return { report, truncated: rawRows.length >= opts.limit };
}

/**
 * dashboard-v3mjk: not itself audit-logged. Rationale (per user request to
 * document this decision rather than assume): this is a read-only local CLI
 * command requiring pre-existing DB/config access (same trust boundary as
 * `gbrain doctor` and `gbrain audit status`, neither of which self-audit),
 * makes no authorization decision (AUTHZ-INV-013's "record the decision"
 * scope doesn't apply — there is no decision here, only a read), and cannot
 * mutate any client, scope, or delegation state. Logging its invocation
 * would add an audit_events write path for a command whose entire purpose
 * is reading audit_events, without a corresponding security question it
 * would help answer.
 */
async function delegationScopeShortfallsCommand(args: string[]): Promise<void> {
  let opts: DelegationScopeShortfallsArgs;
  try {
    opts = parseDelegationScopeShortfallsArgs(args);
  } catch (e: any) {
    console.error(`Error: ${e.message}`);
    console.error('Usage: gbrain audit delegation-scope-shortfalls [--since-days N | --all-time] [--client-id ID] [--source-id ID] [--limit N] [--json]');
    process.exit(1);
  }

  await withEngine(async (engine) => {
    const { report, truncated } = await queryDelegationScopeShortfalls(engine, opts);

    if (opts.json) {
      console.log(JSON.stringify({
        generated_at: new Date().toISOString(),
        filters: {
          since_days: opts.sinceDays,
          all_time: opts.allTime,
          client_id: opts.clientId ?? null,
          source_id: opts.sourceId ?? null,
          limit: opts.limit,
        },
        truncated,
        clients: report.map(r => ({
          client_id: r.clientId,
          event_count: r.eventCount,
          first_seen_at: r.firstSeenAt,
          last_seen_at: r.lastSeenAt,
          missing_scopes: r.missingScopes,
          shortfall_tools: r.shortfallTools,
          sample_correlation_ids: r.sampleCorrelationIds,
          malformed_event_count: r.malformedEventCount,
          current_scopes: r.currentScopes,
          recommended_scopes: r.recommendedScopes,
          enforcement_impact: r.enforcementImpact,
        })),
      }, null, 2));
      return;
    }

    const rangeLabel = opts.allTime ? 'all time' : `last ${opts.sinceDays} day(s)`;
    const filterSuffix = `${opts.clientId ? `, client_id=${opts.clientId}` : ''}${opts.sourceId ? `, source_id=${opts.sourceId}` : ''}`;
    if (report.length === 0) {
      console.log(`No AUTHZ-INV-017 scope-shortfall events found (${rangeLabel}${filterSuffix}). Nothing would be newly denied by switching AUTHZ-INV-017 to enforce, based on this window.`);
      return;
    }

    console.log(`AUTHZ-INV-017 scope-shortfall migration report (${rangeLabel}${filterSuffix})`);
    console.log(`${report.length} client(s) with recorded shortfalls:\n`);
    for (const r of report) {
      console.log(`  ${r.clientId}`);
      console.log(`    events: ${r.eventCount}  first: ${r.firstSeenAt}  last: ${r.lastSeenAt}`);
      console.log(`    missing scopes: ${r.missingScopes.join(', ') || '<none — all malformed events>'}`);
      console.log(`    shortfall tools: ${r.shortfallTools.join(', ') || '<none — all malformed events>'}`);
      console.log(`    sample correlation_id(s): ${r.sampleCorrelationIds.join(', ')}`);
      if (r.malformedEventCount > 0) {
        console.log(`    WARNING: ${r.malformedEventCount} event(s) had unparseable params_summary and were excluded from the scope/tool sets above`);
      }
      console.log(`    enforcement impact if AUTHZ-INV-017 is switched to enforce: ${r.enforcementImpact}`);
      console.log(`    current scopes: ${r.currentScopes ? r.currentScopes.join(', ') || '<none>' : '<client no longer found>'}`);
      console.log(`    recommended scopes: ${r.recommendedScopes.join(', ')}`);
      console.log('');
    }
    if (truncated) {
      console.log(`NOTE: hit --limit ${opts.limit}; there may be more matching events not shown. Re-run with a higher --limit or a narrower --client-id/--since-days for a complete picture.`);
    }
  });
}

async function statusCommand(): Promise<void> {
  const pending = await countPendingSpillLines();
  const corrupt = await isCorruptSpillNonEmpty();
  const critical = await isCriticalFailuresNonEmpty();
  console.log(`audit_spill_pending: ${pending}`);
  console.log(`audit-spill-corrupt.jsonl non-empty: ${corrupt}`);
  console.log(`audit-critical-failures.log non-empty: ${critical}`);
  if (pending > 0 || corrupt || critical) setCliExitVerdict(1);
}

export async function runAudit(args: string[]): Promise<void> {
  const [cmd, ...rest] = args;
  switch (cmd) {
    case 'replay-spill': await replaySpillCommand(); return;
    case 'prune': await pruneCommand(rest); return;
    case 'status': await statusCommand(); return;
    case 'delegation-scope-shortfalls': await delegationScopeShortfallsCommand(rest); return;
    default:
      console.log(`GBrain Audit Event management (Phase 9C)

Usage:
  gbrain audit replay-spill                          Re-insert spilled audit_events rows (idempotent).
  gbrain audit prune --older-than <days> [--dry-run] [--tables audit_events,mcp_request_log]
                                                      Delete audit rows older than N days. No default
                                                      period: omitting --older-than deletes nothing.
  gbrain audit status                                Print audit_spill_pending / corrupt / critical-failures
                                                      indicators (same ones \`gbrain doctor\` checks).
  gbrain audit delegation-scope-shortfalls [--since-days N | --all-time] [--client-id ID] [--source-id ID] [--limit N] [--json]
                                                      Phase 9E-2 prep: aggregate AUTHZ-INV-017 warn-only
                                                      delegation_scope_shortfall events per client, so you can
                                                      see who would be denied if enforce were switched on.
                                                      Read-only — denies nothing, changes no client's scope.
`);
      if (cmd) setCliExitVerdict(1);
      return;
  }
}
