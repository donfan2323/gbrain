/**
 * Phase 9E-1 (dashboard-f5jd5): unit tests for the Capability / Namespace /
 * Delegation Constraint types and pure functions in
 * `src/core/delegation-capability.ts`.
 *
 * These are pure-function tests (no DB, no engine) — the integration of
 * these functions into `submit_agent`'s grant logic (behavior-preserving
 * refactor) is covered separately by the existing `test/submit-agent.test.ts`
 * and `test/audit-delegation-chain.test.ts` regression suites, which must
 * pass unchanged.
 */
import { describe, test, expect } from 'bun:test';
import {
  capabilityFromBinding,
  requestedCapability,
  capabilitySubset,
  normalizeRequestedSlugPrefixes,
  delegationScopeShortfalls,
  delegationConstraintFromBinding,
  type Capability,
  type DelegationConstraint,
} from '../src/core/delegation-capability.ts';

describe('normalizeRequestedSlugPrefixes — AUTHZ-INV-016 request-side [] folding', () => {
  test('null passes through as null', () => {
    expect(normalizeRequestedSlugPrefixes(null)).toBeNull();
  });
  test('undefined passes through as null', () => {
    expect(normalizeRequestedSlugPrefixes(undefined)).toBeNull();
  });
  test('explicit empty array folds to null', () => {
    expect(normalizeRequestedSlugPrefixes([])).toBeNull();
  });
  test('non-empty array passes through unchanged', () => {
    expect(normalizeRequestedSlugPrefixes(['wiki/'])).toEqual(['wiki/']);
  });
});

describe('capabilityFromBinding — Namespace representation (direction/source_id/slug_prefix_set)', () => {
  test('preserves bound_slug_prefixes NULL as null (does not fold to [])', () => {
    const cap = capabilityFromBinding({ tools: ['put_page'], sourceId: 'default', slugPrefixes: null });
    expect(cap.write.slugPrefixes).toBeNull();
  });

  test('preserves bound_slug_prefixes [] as [] (does NOT fold to null — dashboard-5krlu regression guard)', () => {
    const cap = capabilityFromBinding({ tools: ['put_page'], sourceId: 'default', slugPrefixes: [] });
    expect(cap.write.slugPrefixes).toEqual([]);
    expect(cap.write.slugPrefixes).not.toBeNull();
  });

  test('preserves non-empty bound_slug_prefixes verbatim', () => {
    const cap = capabilityFromBinding({ tools: ['put_page'], sourceId: 'default', slugPrefixes: ['wiki/'] });
    expect(cap.write.slugPrefixes).toEqual(['wiki/']);
  });

  test('tools become a Set (dedupe, order-independent membership)', () => {
    const cap = capabilityFromBinding({ tools: ['search', 'get_page', 'search'], sourceId: null, slugPrefixes: null });
    expect(cap.tools.size).toBe(2);
    expect(cap.tools.has('search')).toBe(true);
    expect(cap.tools.has('get_page')).toBe(true);
  });

  test('null tools binding becomes an empty Set', () => {
    const cap = capabilityFromBinding({ tools: null, sourceId: null, slugPrefixes: null });
    expect(cap.tools.size).toBe(0);
  });

  test('write.sourceId and read.sourceId both mirror the binding source_id (no independent read scoping represented yet, dashboard-444rs)', () => {
    const cap = capabilityFromBinding({ tools: [], sourceId: 'my-source', slugPrefixes: null });
    expect(cap.write.sourceId).toBe('my-source');
    expect(cap.read.sourceId).toBe('my-source');
  });
});

describe('requestedCapability — request-side Namespace construction', () => {
  test('builds tools/write/read from resolved request parameters', () => {
    const cap = requestedCapability(['put_page'], 'default', ['wiki/']);
    expect([...cap.tools]).toEqual(['put_page']);
    expect(cap.write.sourceId).toBe('default');
    expect(cap.write.slugPrefixes).toEqual(['wiki/']);
    expect(cap.read.sourceId).toBe('default');
  });
});

describe('capabilitySubset — Capability containment (operation set + write namespace)', () => {
  test('ok=true when requested tools and slug prefixes are both within bound', () => {
    const bound = capabilityFromBinding({ tools: ['search', 'put_page'], sourceId: 'default', slugPrefixes: ['wiki/'] });
    const requested = requestedCapability(['put_page'], 'default', ['wiki/originals/*']);
    const result = capabilitySubset(requested, bound);
    expect(result.ok).toBe(true);
    expect(result.excessTools).toEqual([]);
    expect(result.excessSlugPrefixes).toEqual([]);
  });

  test('reports the excess tool, in requested order, when a tool is not bound', () => {
    const bound = capabilityFromBinding({ tools: ['search'], sourceId: null, slugPrefixes: null });
    const requested = requestedCapability(['search', 'delete_page'], null, null);
    const result = capabilitySubset(requested, bound);
    expect(result.ok).toBe(false);
    expect(result.excessTools).toEqual(['delete_page']);
  });

  test('reports the excess slug prefix when it is outside every bound prefix (dashboard-5krlu slash-boundary semantics preserved)', () => {
    const bound = capabilityFromBinding({ tools: [], sourceId: null, slugPrefixes: ['agent-notes'] });
    const requested = requestedCapability([], null, ['agent-notes-secret/*']);
    const result = capabilitySubset(requested, bound);
    expect(result.ok).toBe(false);
    expect(result.excessSlugPrefixes).toEqual(['agent-notes-secret/*']);
  });

  test('bound.write.slugPrefixes=null (ungranted) treats every non-empty requested prefix as excess', () => {
    const bound = capabilityFromBinding({ tools: [], sourceId: null, slugPrefixes: null });
    const requested = requestedCapability([], null, ['wiki/']);
    const result = capabilitySubset(requested, bound);
    expect(result.ok).toBe(false);
    expect(result.excessSlugPrefixes).toEqual(['wiki/']);
  });

  test('a dimension left at its empty default (tools=[] or slugPrefixes=null) reports no excess for that dimension, allowing single-dimension checks', () => {
    const bound = capabilityFromBinding({ tools: ['search'], sourceId: null, slugPrefixes: ['wiki/'] });
    // Only checking the tool dimension (slugPrefixes intentionally omitted).
    const toolsOnly = requestedCapability(['search'], null, null);
    const toolsResult = capabilitySubset(toolsOnly, bound);
    expect(toolsResult.ok).toBe(true);
    // Only checking the slug dimension (tools intentionally omitted).
    const slugsOnly = requestedCapability([], null, ['wiki/originals/*']);
    const slugsResult = capabilitySubset(slugsOnly, bound);
    expect(slugsResult.ok).toBe(true);
  });
});

describe('delegationScopeShortfalls — AUTHZ-INV-017 warn-only detection', () => {
  test('no shortfall when the delegator scope covers every requested tool\'s required scope', () => {
    const shortfalls = delegationScopeShortfalls(
      ['search', 'get_page'],
      ['read', 'agent'],
      () => 'read',
    );
    expect(shortfalls).toEqual([]);
  });

  test('reports a shortfall for a tool whose required scope the delegator lacks', () => {
    const shortfalls = delegationScopeShortfalls(
      ['put_page'],
      ['agent'], // agent-only: does not imply write (scope.ts IMPLIES)
      () => 'write',
    );
    expect(shortfalls).toEqual([{ tool: 'put_page', requiredScope: 'write' }]);
  });

  test('reports multiple distinct shortfalls when multiple tools each lack coverage', () => {
    const requiredScopeFor: Record<string, string> = { put_page: 'write', delete_source: 'sources_admin' };
    const shortfalls = delegationScopeShortfalls(
      ['put_page', 'delete_source'],
      ['agent'],
      tool => requiredScopeFor[tool],
    );
    expect(shortfalls).toEqual([
      { tool: 'put_page', requiredScope: 'write' },
      { tool: 'delete_source', requiredScope: 'sources_admin' },
    ]);
  });

  test('admin scope covers everything (IMPLIES table: admin implies read/write/sources_admin/users_admin)', () => {
    const shortfalls = delegationScopeShortfalls(
      ['put_page', 'search'],
      ['admin'],
      tool => (tool === 'put_page' ? 'write' : 'read'),
    );
    expect(shortfalls).toEqual([]);
  });

  test('does not include tool names or scope names that look like secrets — output is pure vocabulary (tool name + scope name), safe to persist to audit', () => {
    const shortfalls = delegationScopeShortfalls(['put_page'], [], () => 'write');
    expect(shortfalls).toEqual([{ tool: 'put_page', requiredScope: 'write' }]);
    // Structural guarantee, not a string-content check: the return type is
    // {tool, requiredScope} only — there is no field this function could
    // populate with prompt text or credentials even if the caller wanted it to.
    expect(Object.keys(shortfalls[0]).sort()).toEqual(['requiredScope', 'tool']);
  });
});

describe('delegationConstraintFromBinding', () => {
  test('maps bound_max_concurrent and budget_usd_per_day verbatim', () => {
    const c = delegationConstraintFromBinding({ maxConcurrent: 3, budgetUsdPerDay: 5.0 });
    expect(c.maxConcurrent).toBe(3);
    expect(c.budgetUsdPerDay).toBe(5.0);
  });

  test('null values pass through as null', () => {
    const c = delegationConstraintFromBinding({ maxConcurrent: null, budgetUsdPerDay: null });
    expect(c.maxConcurrent).toBeNull();
    expect(c.budgetUsdPerDay).toBeNull();
  });
});

describe('AUTHZ-INV-005 (2026-08-03): Capability and DelegationConstraint are structurally disjoint types', () => {
  test('Capability has no budget/concurrency/depth/expiry fields', () => {
    const cap: Capability = capabilityFromBinding({ tools: ['search'], sourceId: 'default', slugPrefixes: ['wiki/'] });
    const keys = Object.keys(cap);
    expect(keys).toEqual(['tools', 'write', 'read']);
    for (const forbidden of ['maxConcurrent', 'budgetUsdPerDay', 'depth', 'expiry', 'maxDepth']) {
      expect(keys).not.toContain(forbidden);
    }
  });

  test('DelegationConstraint has no tools/namespace fields', () => {
    const constraint: DelegationConstraint = delegationConstraintFromBinding({ maxConcurrent: 1, budgetUsdPerDay: null });
    const keys = Object.keys(constraint);
    expect(keys).toEqual(['maxConcurrent', 'budgetUsdPerDay']);
    for (const forbidden of ['tools', 'write', 'read', 'slugPrefixes', 'sourceId']) {
      expect(keys).not.toContain(forbidden);
    }
  });

  test('the two types never appear merged into a single object anywhere in this module\'s public surface (source-level check)', async () => {
    const { readFileSync } = await import('node:fs');
    const path = new URL('../src/core/delegation-capability.ts', import.meta.url).pathname;
    const source = readFileSync(path, 'utf8');
    // No interface/type in this file should combine a Capability-ish field
    // (tools/write/read) with a Constraint-ish field (maxConcurrent/budget)
    // in the same declaration block.
    const interfaceBlocks = source.match(/export interface \w+ \{[^}]*\}/gs) ?? [];
    expect(interfaceBlocks.length).toBeGreaterThan(0); // sanity: extractor found something
    for (const block of interfaceBlocks) {
      const hasCapabilityField = /\b(tools|write|read)\s*:/.test(block);
      const hasConstraintField = /\b(maxConcurrent|budgetUsdPerDay)\s*:/.test(block);
      expect(hasCapabilityField && hasConstraintField).toBe(false);
    }
  });
});
