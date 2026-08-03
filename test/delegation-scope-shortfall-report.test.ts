/**
 * Pure unit tests for aggregateDelegationScopeShortfalls
 * (src/core/audit/delegation-scope-shortfall-report.ts), dashboard-v3mjk.
 *
 * No DB, no engine — engine-integration coverage (real audit_events rows,
 * time-range/client_id filtering, cross-driver params_summary shape) lives
 * in test/audit-delegation-scope-shortfalls.test.ts.
 */
import { describe, test, expect } from 'bun:test';
import {
  aggregateDelegationScopeShortfalls,
  type RawShortfallEvent,
  type ClientScopeSnapshot,
} from '../src/core/audit/delegation-scope-shortfall-report.ts';

const requiredScopeForTool = (tool: string): string => {
  const table: Record<string, string> = {
    put_page: 'write',
    get_page: 'read',
    delete_page: 'write',
    admin_op: 'admin',
  };
  return table[tool] ?? 'read';
};

function ev(overrides: Partial<RawShortfallEvent> & { clientId: string }): RawShortfallEvent {
  return {
    occurredAt: '2026-08-01T00:00:00.000Z',
    correlationId: 'corr-default',
    paramsSummary: { missing_scopes: ['write'], shortfall_tools: ['put_page'] },
    ...overrides,
  };
}

function scopes(clientId: string, scope: string | null, deletedAt: string | null = null): [string, ClientScopeSnapshot] {
  return [clientId, { clientId, scope, deletedAt }];
}

describe('aggregateDelegationScopeShortfalls', () => {
  test('no events → empty report', () => {
    const report = aggregateDelegationScopeShortfalls([], new Map(), requiredScopeForTool);
    expect(report).toEqual([]);
  });

  test('1 client, 1 event', () => {
    const events = [ev({ clientId: 'c1', occurredAt: '2026-08-01T00:00:00.000Z', correlationId: 'corr-1' })];
    const report = aggregateDelegationScopeShortfalls(events, new Map([scopes('c1', 'read agent')]), requiredScopeForTool);
    expect(report).toHaveLength(1);
    expect(report[0].clientId).toBe('c1');
    expect(report[0].eventCount).toBe(1);
    expect(report[0].firstSeenAt).toBe('2026-08-01T00:00:00.000Z');
    expect(report[0].lastSeenAt).toBe('2026-08-01T00:00:00.000Z');
    expect(report[0].missingScopes).toEqual(['write']);
    expect(report[0].shortfallTools).toEqual(['put_page']);
    expect(report[0].sampleCorrelationIds).toEqual(['corr-1']);
    expect(report[0].malformedEventCount).toBe(0);
  });

  test('1 client, multiple events → firstSeenAt/lastSeenAt span the full range, eventCount accumulates', () => {
    const events = [
      ev({ clientId: 'c1', occurredAt: '2026-08-01T00:00:00.000Z', correlationId: 'corr-1' }),
      ev({ clientId: 'c1', occurredAt: '2026-08-03T00:00:00.000Z', correlationId: 'corr-2' }),
      ev({ clientId: 'c1', occurredAt: '2026-08-02T00:00:00.000Z', correlationId: 'corr-3' }),
    ];
    const report = aggregateDelegationScopeShortfalls(events, new Map([scopes('c1', 'read agent')]), requiredScopeForTool);
    expect(report).toHaveLength(1);
    expect(report[0].eventCount).toBe(3);
    expect(report[0].firstSeenAt).toBe('2026-08-01T00:00:00.000Z');
    expect(report[0].lastSeenAt).toBe('2026-08-03T00:00:00.000Z');
  });

  test('multiple clients → one row per client, sorted by eventCount desc then clientId', () => {
    const events = [
      ev({ clientId: 'low-count', occurredAt: '2026-08-01T00:00:00.000Z' }),
      ev({ clientId: 'high-count', occurredAt: '2026-08-01T00:00:00.000Z' }),
      ev({ clientId: 'high-count', occurredAt: '2026-08-02T00:00:00.000Z' }),
    ];
    const report = aggregateDelegationScopeShortfalls(
      events,
      new Map([scopes('low-count', 'read agent'), scopes('high-count', 'read agent')]),
      requiredScopeForTool,
    );
    expect(report.map(r => r.clientId)).toEqual(['high-count', 'low-count']);
    expect(report[0].eventCount).toBe(2);
    expect(report[1].eventCount).toBe(1);
  });

  test('deduplicates identical scope/tool across repeated events for the same client', () => {
    const events = [
      ev({ clientId: 'c1', occurredAt: '2026-08-01T00:00:00.000Z', paramsSummary: { missing_scopes: ['write'], shortfall_tools: ['put_page'] } }),
      ev({ clientId: 'c1', occurredAt: '2026-08-02T00:00:00.000Z', paramsSummary: { missing_scopes: ['write'], shortfall_tools: ['put_page'] } }),
    ];
    const report = aggregateDelegationScopeShortfalls(events, new Map([scopes('c1', 'read agent')]), requiredScopeForTool);
    expect(report[0].missingScopes).toEqual(['write']);
    expect(report[0].shortfallTools).toEqual(['put_page']);
    expect(report[0].eventCount).toBe(2);
  });

  test('multiple distinct missing scopes across events are unioned and sorted', () => {
    const events = [
      ev({ clientId: 'c1', occurredAt: '2026-08-01T00:00:00.000Z', paramsSummary: { missing_scopes: ['write'], shortfall_tools: ['put_page'] } }),
      ev({ clientId: 'c1', occurredAt: '2026-08-02T00:00:00.000Z', paramsSummary: { missing_scopes: ['admin'], shortfall_tools: ['admin_op'] } }),
    ];
    const report = aggregateDelegationScopeShortfalls(events, new Map([scopes('c1', 'read agent')]), requiredScopeForTool);
    expect(report[0].missingScopes).toEqual(['admin', 'write']);
  });

  test('multiple distinct shortfall tools within a single event are all retained', () => {
    const events = [
      ev({ clientId: 'c1', occurredAt: '2026-08-01T00:00:00.000Z', paramsSummary: { missing_scopes: ['write', 'admin'], shortfall_tools: ['put_page', 'admin_op'] } }),
    ];
    const report = aggregateDelegationScopeShortfalls(events, new Map([scopes('c1', 'read agent')]), requiredScopeForTool);
    expect(report[0].shortfallTools).toEqual(['admin_op', 'put_page']);
    expect(report[0].missingScopes).toEqual(['admin', 'write']);
  });

  describe('malformed params_summary handling', () => {
    test('null params_summary → malformedEventCount increments, event still counted', () => {
      const events = [ev({ clientId: 'c1', paramsSummary: null })];
      const report = aggregateDelegationScopeShortfalls(events, new Map([scopes('c1', 'read agent')]), requiredScopeForTool);
      expect(report[0].malformedEventCount).toBe(1);
      expect(report[0].eventCount).toBe(1);
      expect(report[0].missingScopes).toEqual([]);
      expect(report[0].shortfallTools).toEqual([]);
    });

    test('params_summary missing expected keys → treated as malformed', () => {
      const events = [ev({ clientId: 'c1', paramsSummary: { some_other_field: 1 } })];
      const report = aggregateDelegationScopeShortfalls(events, new Map([scopes('c1', 'read agent')]), requiredScopeForTool);
      expect(report[0].malformedEventCount).toBe(1);
    });

    test('params_summary with non-array missing_scopes → treated as malformed', () => {
      const events = [ev({ clientId: 'c1', paramsSummary: { missing_scopes: 'write', shortfall_tools: ['put_page'] } })];
      const report = aggregateDelegationScopeShortfalls(events, new Map([scopes('c1', 'read agent')]), requiredScopeForTool);
      expect(report[0].malformedEventCount).toBe(1);
    });

    test('params_summary with non-string array elements → treated as malformed', () => {
      const events = [ev({ clientId: 'c1', paramsSummary: { missing_scopes: [1, 2], shortfall_tools: ['put_page'] } })];
      const report = aggregateDelegationScopeShortfalls(events, new Map([scopes('c1', 'read agent')]), requiredScopeForTool);
      expect(report[0].malformedEventCount).toBe(1);
    });

    test('params_summary as an unparseable JSON string → treated as malformed, not thrown', () => {
      const events = [ev({ clientId: 'c1', paramsSummary: '{not valid json' })];
      expect(() => aggregateDelegationScopeShortfalls(events, new Map([scopes('c1', 'read agent')]), requiredScopeForTool)).not.toThrow();
      const report = aggregateDelegationScopeShortfalls(events, new Map([scopes('c1', 'read agent')]), requiredScopeForTool);
      expect(report[0].malformedEventCount).toBe(1);
    });

    test('params_summary as a valid JSON string (cross-driver shape) parses identically to an object', () => {
      const events = [ev({ clientId: 'c1', paramsSummary: JSON.stringify({ missing_scopes: ['write'], shortfall_tools: ['put_page'] }) })];
      const report = aggregateDelegationScopeShortfalls(events, new Map([scopes('c1', 'read agent')]), requiredScopeForTool);
      expect(report[0].malformedEventCount).toBe(0);
      expect(report[0].missingScopes).toEqual(['write']);
    });

    test('mix of malformed and well-formed events for the same client: only well-formed contribute scopes/tools', () => {
      const events = [
        ev({ clientId: 'c1', occurredAt: '2026-08-01T00:00:00.000Z', paramsSummary: { missing_scopes: ['write'], shortfall_tools: ['put_page'] } }),
        ev({ clientId: 'c1', occurredAt: '2026-08-02T00:00:00.000Z', paramsSummary: null }),
      ];
      const report = aggregateDelegationScopeShortfalls(events, new Map([scopes('c1', 'read agent')]), requiredScopeForTool);
      expect(report[0].eventCount).toBe(2);
      expect(report[0].malformedEventCount).toBe(1);
      expect(report[0].missingScopes).toEqual(['write']);
    });
  });

  describe('enforcementImpact', () => {
    test('current scope still lacks the shortfall tool\'s required scope → would_be_denied', () => {
      const events = [ev({ clientId: 'c1', paramsSummary: { missing_scopes: ['write'], shortfall_tools: ['put_page'] } })];
      const report = aggregateDelegationScopeShortfalls(events, new Map([scopes('c1', 'read agent')]), requiredScopeForTool);
      expect(report[0].enforcementImpact).toBe('would_be_denied');
    });

    test('client has since been re-registered with the missing scope → resolved', () => {
      const events = [ev({ clientId: 'c1', paramsSummary: { missing_scopes: ['write'], shortfall_tools: ['put_page'] } })];
      const report = aggregateDelegationScopeShortfalls(events, new Map([scopes('c1', 'read write agent')]), requiredScopeForTool);
      expect(report[0].enforcementImpact).toBe('resolved');
    });

    test('client no longer present in the scope snapshot map → client_no_longer_exists', () => {
      const events = [ev({ clientId: 'ghost-client' })];
      const report = aggregateDelegationScopeShortfalls(events, new Map(), requiredScopeForTool);
      expect(report[0].enforcementImpact).toBe('client_no_longer_exists');
      expect(report[0].currentScopes).toBeNull();
    });

    test('client present but deletedAt set (revoked) → client_no_longer_exists', () => {
      const events = [ev({ clientId: 'c1' })];
      const report = aggregateDelegationScopeShortfalls(
        events,
        new Map([scopes('c1', 'read agent', '2026-08-02T00:00:00.000Z')]),
        requiredScopeForTool,
      );
      expect(report[0].enforcementImpact).toBe('client_no_longer_exists');
    });

    test('"admin" current scope covers every shortfall tool → resolved', () => {
      const events = [ev({ clientId: 'c1', paramsSummary: { missing_scopes: ['write', 'admin'], shortfall_tools: ['put_page', 'admin_op'] } })];
      const report = aggregateDelegationScopeShortfalls(events, new Map([scopes('c1', 'admin agent')]), requiredScopeForTool);
      expect(report[0].enforcementImpact).toBe('resolved');
    });
  });

  describe('recommendedScopes', () => {
    test('is the union of current scopes and missing scopes, deduped and sorted', () => {
      const events = [ev({ clientId: 'c1', paramsSummary: { missing_scopes: ['write'], shortfall_tools: ['put_page'] } })];
      const report = aggregateDelegationScopeShortfalls(events, new Map([scopes('c1', 'read agent')]), requiredScopeForTool);
      expect(report[0].recommendedScopes).toEqual(['agent', 'read', 'write']);
    });

    test('client no longer exists → recommendedScopes falls back to just the missing scopes', () => {
      const events = [ev({ clientId: 'ghost', paramsSummary: { missing_scopes: ['write'], shortfall_tools: ['put_page'] } })];
      const report = aggregateDelegationScopeShortfalls(events, new Map(), requiredScopeForTool);
      expect(report[0].recommendedScopes).toEqual(['write']);
    });
  });

  test('sampleCorrelationIds is capped at 3, most-recent-first, deduplicated', () => {
    const events = [
      ev({ clientId: 'c1', occurredAt: '2026-08-01T00:00:00.000Z', correlationId: 'corr-1' }),
      ev({ clientId: 'c1', occurredAt: '2026-08-02T00:00:00.000Z', correlationId: 'corr-2' }),
      ev({ clientId: 'c1', occurredAt: '2026-08-03T00:00:00.000Z', correlationId: 'corr-3' }),
      ev({ clientId: 'c1', occurredAt: '2026-08-04T00:00:00.000Z', correlationId: 'corr-4' }),
    ];
    const report = aggregateDelegationScopeShortfalls(events, new Map([scopes('c1', 'read agent')]), requiredScopeForTool);
    expect(report[0].sampleCorrelationIds).toHaveLength(3);
    expect(report[0].sampleCorrelationIds).toEqual(['corr-4', 'corr-3', 'corr-2']);
  });

  test('output rows never contain a secret-shaped key (structural safety check)', () => {
    const events = [ev({ clientId: 'c1' })];
    const report = aggregateDelegationScopeShortfalls(events, new Map([scopes('c1', 'read agent')]), requiredScopeForTool);
    const serialized = JSON.stringify(report).toLowerCase();
    for (const banned of ['secret', 'token', 'credential', 'password', 'prompt']) {
      expect(serialized).not.toContain(banned);
    }
  });

  test('JSON.stringify output is stable across repeated calls with identical input (deterministic ordering)', () => {
    const events = [
      ev({ clientId: 'c1', occurredAt: '2026-08-01T00:00:00.000Z', paramsSummary: { missing_scopes: ['admin', 'write'], shortfall_tools: ['admin_op', 'put_page'] } }),
      ev({ clientId: 'c2', occurredAt: '2026-08-01T00:00:00.000Z' }),
    ];
    const clientMap = new Map([scopes('c1', 'read agent'), scopes('c2', 'read agent')]);
    const a = JSON.stringify(aggregateDelegationScopeShortfalls(events, clientMap, requiredScopeForTool));
    const b = JSON.stringify(aggregateDelegationScopeShortfalls(events, clientMap, requiredScopeForTool));
    expect(a).toBe(b);
  });
});
