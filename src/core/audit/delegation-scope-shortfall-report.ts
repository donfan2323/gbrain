/**
 * AUTHZ-INV-017 warn-only migration readiness report (dashboard-v3mjk,
 * Phase 9E-2 prep — NOT part of enforcement itself).
 *
 * Aggregates `audit_events` rows written by `submit_agent`
 * (`event_kind: 'delegation.grant'`, `reason_code: 'delegation_scope_shortfall'`,
 * see `src/core/operations.ts`) into a per-client summary so an operator can
 * see, before ever flipping AUTHZ-INV-017 to enforce, which currently-warned
 * clients would actually start being denied.
 *
 * Pure, engine-free — no I/O. The SQL-fetching glue lives in
 * `src/commands/audit.ts`'s `delegationScopeShortfallsCommand`. This split
 * mirrors `src/core/delegation-capability.ts`'s pure-core/thin-glue pattern.
 *
 * `enforcementImpact` is computed by re-running `delegationScopeShortfalls()`
 * (the exact function `submit_agent` already calls) against the client's
 * CURRENT `oauth_clients.scope` — not the scope recorded at event time. A
 * client may have already been re-registered with broader scopes since the
 * shortfall was logged; re-checking against current state is what makes
 * `enforcementImpact` answer "would enforce deny THIS client TODAY", not
 * "did this client ever trigger a shortfall in the past".
 */

import { delegationScopeShortfalls } from '../delegation-capability.ts';

export interface RawShortfallEvent {
  readonly clientId: string;
  /** ISO 8601 string (audit_events.occurred_at). */
  readonly occurredAt: string;
  readonly correlationId: string;
  /**
   * The raw driver value for audit_events.params_summary. Different engines
   * return JSONB columns differently (already-parsed object on one engine,
   * a JSON string on another — see test/audit-delegation-chain.test.ts's
   * own `typeof x === 'string' ? JSON.parse(x) : x` normalization for the
   * same column). Accepting `unknown` here and normalizing internally keeps
   * that quirk out of every caller.
   */
  readonly paramsSummary: unknown;
}

export interface ClientScopeSnapshot {
  readonly clientId: string;
  readonly scope: string | null;
  readonly deletedAt: string | null;
}

export type EnforcementImpact = 'would_be_denied' | 'resolved' | 'client_no_longer_exists';

export interface ShortfallReportRow {
  readonly clientId: string;
  readonly eventCount: number;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly missingScopes: readonly string[];
  readonly shortfallTools: readonly string[];
  readonly sampleCorrelationIds: readonly string[];
  /** Count of events for this client whose params_summary could not be
   *  parsed into the expected {missing_scopes, shortfall_tools} shape.
   *  Still counted in eventCount/firstSeenAt/lastSeenAt; contributes
   *  nothing to missingScopes/shortfallTools. Surfaced so an operator
   *  knows the aggregate undercounts this client's true scope/tool sets. */
  readonly malformedEventCount: number;
  /** Null when the client no longer exists in oauth_clients at all. */
  readonly currentScopes: readonly string[] | null;
  readonly recommendedScopes: readonly string[];
  readonly enforcementImpact: EnforcementImpact;
}

function parseParamsSummary(raw: unknown): { missingScopes: string[]; shortfallTools: string[] } | null {
  let value: unknown = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (value === null || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  const missingScopes = obj.missing_scopes;
  const shortfallTools = obj.shortfall_tools;
  if (!Array.isArray(missingScopes) || !Array.isArray(shortfallTools)) return null;
  if (!missingScopes.every(s => typeof s === 'string') || !shortfallTools.every(s => typeof s === 'string')) {
    return null;
  }
  return { missingScopes: missingScopes as string[], shortfallTools: shortfallTools as string[] };
}

function parseScopeList(scope: string | null): string[] {
  if (!scope) return [];
  return scope.split(' ').map(s => s.trim()).filter(Boolean);
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

/** Deduplicates while preserving first-occurrence order (JS Set iteration
 *  order) — unlike sortedUnique, does NOT alphabetize. Used for
 *  sampleCorrelationIds, where "most-recent-first" is the whole point. */
function uniqueInOrder(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/**
 * requiredScopeForTool mirrors submit_agent's own lookup
 * (`operationsByName[tool]?.scope ?? 'read'`) — passed in by the caller
 * (src/commands/audit.ts) so this module stays engine/operations-registry
 * free and independently unit-testable.
 */
export function aggregateDelegationScopeShortfalls(
  events: readonly RawShortfallEvent[],
  clientScopes: ReadonlyMap<string, ClientScopeSnapshot>,
  requiredScopeForTool: (tool: string) => string,
): ShortfallReportRow[] {
  const byClient = new Map<string, RawShortfallEvent[]>();
  for (const e of events) {
    const list = byClient.get(e.clientId);
    if (list) list.push(e);
    else byClient.set(e.clientId, [e]);
  }

  const rows: ShortfallReportRow[] = [];
  for (const [clientId, clientEvents] of byClient) {
    const sortedByTime = [...clientEvents].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
    const missingScopes: string[] = [];
    const shortfallTools: string[] = [];
    let malformedEventCount = 0;
    for (const e of clientEvents) {
      const parsed = parseParamsSummary(e.paramsSummary);
      if (!parsed) {
        malformedEventCount++;
        continue;
      }
      missingScopes.push(...parsed.missingScopes);
      shortfallTools.push(...parsed.shortfallTools);
    }

    const snapshot = clientScopes.get(clientId);
    const currentScopes = snapshot ? parseScopeList(snapshot.scope) : null;
    const dedupedShortfallTools = sortedUnique(shortfallTools);
    const dedupedMissingScopes = sortedUnique(missingScopes);

    let enforcementImpact: EnforcementImpact;
    if (!snapshot || snapshot.deletedAt) {
      enforcementImpact = 'client_no_longer_exists';
    } else {
      const liveShortfalls = delegationScopeShortfalls(dedupedShortfallTools, currentScopes ?? [], requiredScopeForTool);
      enforcementImpact = liveShortfalls.length > 0 ? 'would_be_denied' : 'resolved';
    }

    const recommendedScopes = sortedUnique([...(currentScopes ?? []), ...dedupedMissingScopes]);

    rows.push({
      clientId,
      eventCount: clientEvents.length,
      firstSeenAt: sortedByTime[sortedByTime.length - 1].occurredAt,
      lastSeenAt: sortedByTime[0].occurredAt,
      missingScopes: dedupedMissingScopes,
      shortfallTools: dedupedShortfallTools,
      sampleCorrelationIds: uniqueInOrder(sortedByTime.map(e => e.correlationId)).slice(0, 3),
      malformedEventCount,
      currentScopes,
      recommendedScopes,
      enforcementImpact,
    });
  }

  rows.sort((a, b) => b.eventCount - a.eventCount || a.clientId.localeCompare(b.clientId));
  return rows;
}
