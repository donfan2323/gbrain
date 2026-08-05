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
  MAX_DELEGATION_DEPTH,
  canRedelegate,
  nextDelegationDepth,
  validateRedelegatedCapability,
  validateRedelegatedConstraint,
  evaluateRedelegation,
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

// -----------------------------------------------------------------------
// Phase 9E-2e-1 (AUTHZ-INV-005/006/008): multi-level delegation constraint
// primitives. Pure functions only — no queue, no DB, no audit, no
// OperationContext. Multi-hop delegation itself is NOT enabled by this
// module; these are the building blocks a future adapter will call.
// MAX_DELEGATION_DEPTH=5 is fixed, not configurable, and deliberately
// distinct from both self-fix's chain-depth (which counts a DIFFERENT
// thing — self-fix retries, marked via data.is_self_fix_child — not
// delegation hops) and MinionQueue's generic maxSpawnDepth (which counts
// ALL parent_job_id hops regardless of whether they are delegation,
// self-fix, or aggregator fan-out).
// -----------------------------------------------------------------------

const DELEGATED_SUBMIT_TOOL_NAME = 'submit_agent_delegated';

describe('MAX_DELEGATION_DEPTH — fixed constant, not configurable', () => {
  test('[Case 25] is exactly 5', () => {
    expect(MAX_DELEGATION_DEPTH).toBe(5);
  });
});

describe('canRedelegate — AUTHZ-INV-008 explicit redelegation grant', () => {
  test('[Case 1] adapter name present in allowed tools -> true', () => {
    expect(canRedelegate(['search', DELEGATED_SUBMIT_TOOL_NAME], DELEGATED_SUBMIT_TOOL_NAME)).toBe(true);
  });

  test('[Case 2] adapter name absent -> false', () => {
    expect(canRedelegate(['search', 'put_page'], DELEGATED_SUBMIT_TOOL_NAME)).toBe(false);
  });

  test('[Case 3] null -> false', () => {
    expect(canRedelegate(null, DELEGATED_SUBMIT_TOOL_NAME)).toBe(false);
  });

  test('[Case 4] undefined -> false', () => {
    expect(canRedelegate(undefined, DELEGATED_SUBMIT_TOOL_NAME)).toBe(false);
  });

  test('[Case 5] empty array -> false', () => {
    expect(canRedelegate([], DELEGATED_SUBMIT_TOOL_NAME)).toBe(false);
  });

  test('[Case 6] only the plain "submit_agent" (not the delegated adapter) -> false', () => {
    expect(canRedelegate(['submit_agent'], DELEGATED_SUBMIT_TOOL_NAME)).toBe(false);
  });

  test('[Case 7] a prefix/partial match of the adapter name -> false (no substring matching)', () => {
    expect(canRedelegate(['submit_agent_delegated_v2', 'xsubmit_agent_delegated'], DELEGATED_SUBMIT_TOOL_NAME)).toBe(false);
  });

  test('[Case 8] a case-different name -> false (no case folding)', () => {
    expect(canRedelegate(['SUBMIT_AGENT_DELEGATED', 'Submit_Agent_Delegated'], DELEGATED_SUBMIT_TOOL_NAME)).toBe(false);
  });

  test('[Case 9] duplicate entries of the adapter name -> true (result unaffected by duplication)', () => {
    expect(canRedelegate([DELEGATED_SUBMIT_TOOL_NAME, DELEGATED_SUBMIT_TOOL_NAME, 'search'], DELEGATED_SUBMIT_TOOL_NAME)).toBe(true);
  });

  test('[Case 10] an empty-string adapter name never matches (defensive — no vacuous grant)', () => {
    expect(canRedelegate(['', 'search'], '')).toBe(false);
  });
});

describe('nextDelegationDepth — AUTHZ-INV-005 monotonic depth, MAX_DELEGATION_DEPTH=5 fail-closed', () => {
  test('[Case 11] parent depth 0 -> child depth 1', () => {
    const d = nextDelegationDepth(0);
    expect(d).toEqual({ allowed: true, childDelegationDepth: 1 });
  });

  test('[Case 12] parent depth 1 -> child depth 2', () => {
    expect(nextDelegationDepth(1)).toEqual({ allowed: true, childDelegationDepth: 2 });
  });

  test('[Case 13] parent depth 2 -> child depth 3', () => {
    expect(nextDelegationDepth(2)).toEqual({ allowed: true, childDelegationDepth: 3 });
  });

  test('[Case 14] parent depth 3 -> child depth 4', () => {
    expect(nextDelegationDepth(3)).toEqual({ allowed: true, childDelegationDepth: 4 });
  });

  test('[Case 15] parent depth 4 -> child depth 5', () => {
    expect(nextDelegationDepth(4)).toEqual({ allowed: true, childDelegationDepth: 5 });
  });

  test('[Case 16] parent depth 5 (already at max) -> delegation_depth_exceeded', () => {
    const d = nextDelegationDepth(5);
    expect(d.allowed).toBe(false);
    expect((d as { reason: string }).reason).toBe('delegation_depth_exceeded');
  });

  test('[Case 17] parent depth 6 -> delegation_depth_exceeded', () => {
    const d = nextDelegationDepth(6);
    expect(d.allowed).toBe(false);
    expect((d as { reason: string }).reason).toBe('delegation_depth_exceeded');
  });

  test('[Case 18] parent depth 100 -> delegation_depth_exceeded', () => {
    const d = nextDelegationDepth(100);
    expect(d.allowed).toBe(false);
    expect((d as { reason: string }).reason).toBe('delegation_depth_exceeded');
  });

  test('[Case 19] depth -1 -> invalid_delegation_depth', () => {
    const d = nextDelegationDepth(-1);
    expect(d.allowed).toBe(false);
    expect((d as { reason: string }).reason).toBe('invalid_delegation_depth');
  });

  test('[Case 20] depth -100 -> invalid_delegation_depth', () => {
    const d = nextDelegationDepth(-100);
    expect((d as { reason: string }).reason).toBe('invalid_delegation_depth');
  });

  test('[Case 21] depth 0.5 (non-integer) -> invalid_delegation_depth', () => {
    const d = nextDelegationDepth(0.5);
    expect((d as { reason: string }).reason).toBe('invalid_delegation_depth');
  });

  test('[Case 22] depth NaN -> invalid_delegation_depth', () => {
    const d = nextDelegationDepth(NaN);
    expect((d as { reason: string }).reason).toBe('invalid_delegation_depth');
  });

  test('[Case 23] depth Infinity -> invalid_delegation_depth', () => {
    const d = nextDelegationDepth(Infinity);
    expect((d as { reason: string }).reason).toBe('invalid_delegation_depth');
  });

  test('[Case 24] depth -Infinity -> invalid_delegation_depth', () => {
    const d = nextDelegationDepth(-Infinity);
    expect((d as { reason: string }).reason).toBe('invalid_delegation_depth');
  });
});

describe('validateRedelegatedCapability — reuses capabilitySubset() as the single source of truth', () => {
  test('[Case 26] identical parent/requested Capability -> allow', () => {
    const cap = capabilityFromBinding({ tools: ['search', 'put_page'], sourceId: 'default', slugPrefixes: ['wiki/'] });
    const d = validateRedelegatedCapability(cap, cap);
    expect(d.ok).toBe(true);
  });

  test('[Case 27] requested tools a subset of parent -> allow', () => {
    const parent = capabilityFromBinding({ tools: ['search', 'put_page'], sourceId: 'default', slugPrefixes: null });
    const requested = requestedCapability(['search'], 'default', null);
    expect(validateRedelegatedCapability(parent, requested).ok).toBe(true);
  });

  test('[Case 28] requested tools exceed parent -> deny', () => {
    const parent = capabilityFromBinding({ tools: ['search'], sourceId: 'default', slugPrefixes: null });
    const requested = requestedCapability(['search', 'put_page'], 'default', null);
    const d = validateRedelegatedCapability(parent, requested);
    expect(d.ok).toBe(false);
    expect(d.excessTools).toEqual(['put_page']);
  });

  test('[Case 29] requested slug prefixes a subset of parent -> allow', () => {
    const parent = capabilityFromBinding({ tools: [], sourceId: 'default', slugPrefixes: ['wiki/'] });
    const requested = requestedCapability([], 'default', ['wiki/originals/*']);
    expect(validateRedelegatedCapability(parent, requested).ok).toBe(true);
  });

  test('[Case 30] requested slug prefixes exceed parent -> deny', () => {
    const parent = capabilityFromBinding({ tools: [], sourceId: 'default', slugPrefixes: ['wiki/'] });
    const requested = requestedCapability([], 'default', ['private/']);
    const d = validateRedelegatedCapability(parent, requested);
    expect(d.ok).toBe(false);
    expect(d.excessSlugPrefixes).toEqual(['private/']);
  });

  test('[Case 31] a slash-boundary-crossing sibling prefix -> deny (isRequestedSlugPrefixWithinBound semantics preserved)', () => {
    const parent = capabilityFromBinding({ tools: [], sourceId: 'default', slugPrefixes: ['agent-notes'] });
    const requested = requestedCapability([], 'default', ['agent-notes-secret/*']);
    expect(validateRedelegatedCapability(parent, requested).ok).toBe(false);
  });

  test('[Case 32] parent prefix NULL (ungranted) + child requests a prefix -> deny', () => {
    const parent = capabilityFromBinding({ tools: [], sourceId: 'default', slugPrefixes: null });
    const requested = requestedCapability([], 'default', ['wiki/']);
    expect(validateRedelegatedCapability(parent, requested).ok).toBe(false);
  });

  test('[Case 33] parent prefix [] (also ungranted per AUTHZ-INV-016) + child requests a prefix -> deny', () => {
    const parent = capabilityFromBinding({ tools: [], sourceId: 'default', slugPrefixes: [] });
    const requested = requestedCapability([], 'default', ['wiki/']);
    expect(validateRedelegatedCapability(parent, requested).ok).toBe(false);
  });

  test('[Case 34] parent unset + child unset (both empty defaults) -> follows existing capabilitySubset norm (ok, no excess)', () => {
    const parent = capabilityFromBinding({ tools: [], sourceId: null, slugPrefixes: null });
    const requested = requestedCapability([], null, null);
    const d = validateRedelegatedCapability(parent, requested);
    expect(d.ok).toBe(true);
    expect(d.excessTools).toEqual([]);
    expect(d.excessSlugPrefixes).toEqual([]);
  });

  test('[Case 35] child tools left unspecified ([]) while checking only slug prefixes -> follows existing single-dimension norm', () => {
    const parent = capabilityFromBinding({ tools: ['search'], sourceId: 'default', slugPrefixes: ['wiki/'] });
    const requested = requestedCapability([], 'default', ['wiki/x/*']);
    const d = validateRedelegatedCapability(parent, requested);
    expect(d.ok).toBe(true);
  });

  test('[Case 38] several requested tools where only one is out of bound -> deny for the WHOLE request, not partial', () => {
    const parent = capabilityFromBinding({ tools: ['search', 'get_page'], sourceId: 'default', slugPrefixes: null });
    const requested = requestedCapability(['search', 'get_page', 'put_page'], 'default', null);
    const d = validateRedelegatedCapability(parent, requested);
    expect(d.ok).toBe(false);
    expect(d.excessTools).toEqual(['put_page']);
  });

  test('[Case 39] both tools AND slug prefixes exceed parent simultaneously -> deny, both excesses reported', () => {
    const parent = capabilityFromBinding({ tools: ['search'], sourceId: 'default', slugPrefixes: ['wiki/'] });
    const requested = requestedCapability(['search', 'put_page'], 'default', ['private/']);
    const d = validateRedelegatedCapability(parent, requested);
    expect(d.ok).toBe(false);
    expect(d.excessTools).toEqual(['put_page']);
    expect(d.excessSlugPrefixes).toEqual(['private/']);
  });

  test('[Case 40] the parent Capability object is not mutated by validation', () => {
    const parent = capabilityFromBinding({ tools: ['search'], sourceId: 'default', slugPrefixes: ['wiki/'] });
    const parentToolsBefore = [...parent.tools];
    const parentPrefixesBefore = parent.write.slugPrefixes ? [...parent.write.slugPrefixes] : null;
    const requested = requestedCapability(['search', 'put_page'], 'default', ['private/']);
    validateRedelegatedCapability(parent, requested);
    expect([...parent.tools]).toEqual(parentToolsBefore);
    expect(parent.write.slugPrefixes ? [...parent.write.slugPrefixes] : null).toEqual(parentPrefixesBefore);
  });

  test('[Case 41] the requested Capability object is not mutated by validation', () => {
    const parent = capabilityFromBinding({ tools: ['search'], sourceId: 'default', slugPrefixes: ['wiki/'] });
    const requested = requestedCapability(['search', 'put_page'], 'default', ['private/']);
    const requestedToolsBefore = [...requested.tools];
    const requestedPrefixesBefore = requested.write.slugPrefixes ? [...requested.write.slugPrefixes] : null;
    validateRedelegatedCapability(parent, requested);
    expect([...requested.tools]).toEqual(requestedToolsBefore);
    expect(requested.write.slugPrefixes ? [...requested.write.slugPrefixes] : null).toEqual(requestedPrefixesBefore);
  });
});

describe('validateRedelegatedConstraint — DelegationConstraint monotonicity (budget), kept structurally separate from Capability', () => {
  test('[Case 36] requested budget <= parent budget -> allow', () => {
    const parent = delegationConstraintFromBinding({ maxConcurrent: null, budgetUsdPerDay: 10 });
    const requested = delegationConstraintFromBinding({ maxConcurrent: null, budgetUsdPerDay: 5 });
    expect(validateRedelegatedConstraint(parent, requested).ok).toBe(true);
  });

  test('[Case 37] requested budget > parent budget -> deny', () => {
    const parent = delegationConstraintFromBinding({ maxConcurrent: null, budgetUsdPerDay: 5 });
    const requested = delegationConstraintFromBinding({ maxConcurrent: null, budgetUsdPerDay: 10 });
    const d = validateRedelegatedConstraint(parent, requested);
    expect(d.ok).toBe(false);
    expect(d.budgetExceeded).toBe(true);
  });

  test('parent budget null (unconstrained) + requested budget set -> allow (parent has no ceiling to violate)', () => {
    const parent = delegationConstraintFromBinding({ maxConcurrent: null, budgetUsdPerDay: null });
    const requested = delegationConstraintFromBinding({ maxConcurrent: null, budgetUsdPerDay: 5 });
    expect(validateRedelegatedConstraint(parent, requested).ok).toBe(true);
  });

  test('parent budget set + requested budget null (inherits parent) -> allow', () => {
    const parent = delegationConstraintFromBinding({ maxConcurrent: null, budgetUsdPerDay: 5 });
    const requested = delegationConstraintFromBinding({ maxConcurrent: null, budgetUsdPerDay: null });
    expect(validateRedelegatedConstraint(parent, requested).ok).toBe(true);
  });
});

describe('evaluateRedelegation — composite decision, stable reason-code priority', () => {
  const boundCap = capabilityFromBinding({ tools: ['search', 'put_page'], sourceId: 'default', slugPrefixes: ['wiki/'] });
  const okRequested = requestedCapability(['search'], 'default', ['wiki/x/*']);
  const excessRequested = requestedCapability(['search', 'delete_page'], 'default', ['wiki/x/*']);

  test('[Case 42] granted + depth 0 + subset ok -> allow, childDelegationDepth=1', () => {
    const d = evaluateRedelegation({
      parentAllowedTools: [DELEGATED_SUBMIT_TOOL_NAME],
      delegatedSubmitToolName: DELEGATED_SUBMIT_TOOL_NAME,
      parentDelegationDepth: 0,
      parentEffectiveCapability: boundCap,
      requestedChildCapability: okRequested,
    });
    expect(d).toEqual({ allowed: true, childDelegationDepth: 1 });
  });

  test('[Case 43] granted + depth 4 + subset ok -> allow, childDelegationDepth=5 (at the max)', () => {
    const d = evaluateRedelegation({
      parentAllowedTools: [DELEGATED_SUBMIT_TOOL_NAME],
      delegatedSubmitToolName: DELEGATED_SUBMIT_TOOL_NAME,
      parentDelegationDepth: 4,
      parentEffectiveCapability: boundCap,
      requestedChildCapability: okRequested,
    });
    expect(d).toEqual({ allowed: true, childDelegationDepth: 5 });
  });

  test('[Case 44] redelegation not granted -> "redelegation_not_granted"', () => {
    const d = evaluateRedelegation({
      parentAllowedTools: ['search'], // no adapter name
      delegatedSubmitToolName: DELEGATED_SUBMIT_TOOL_NAME,
      parentDelegationDepth: 0,
      parentEffectiveCapability: boundCap,
      requestedChildCapability: okRequested,
    });
    expect(d.allowed).toBe(false);
    expect((d as { reason: string }).reason).toBe('redelegation_not_granted');
  });

  test('[Case 45] depth already at 5 -> "delegation_depth_exceeded"', () => {
    const d = evaluateRedelegation({
      parentAllowedTools: [DELEGATED_SUBMIT_TOOL_NAME],
      delegatedSubmitToolName: DELEGATED_SUBMIT_TOOL_NAME,
      parentDelegationDepth: 5,
      parentEffectiveCapability: boundCap,
      requestedChildCapability: okRequested,
    });
    expect(d.allowed).toBe(false);
    expect((d as { reason: string }).reason).toBe('delegation_depth_exceeded');
  });

  test('[Case 46] invalid depth (negative) -> "invalid_delegation_depth"', () => {
    const d = evaluateRedelegation({
      parentAllowedTools: [DELEGATED_SUBMIT_TOOL_NAME],
      delegatedSubmitToolName: DELEGATED_SUBMIT_TOOL_NAME,
      parentDelegationDepth: -1,
      parentEffectiveCapability: boundCap,
      requestedChildCapability: okRequested,
    });
    expect(d.allowed).toBe(false);
    expect((d as { reason: string }).reason).toBe('invalid_delegation_depth');
  });

  test('[Case 47] redelegation granted + depth ok + requested Capability exceeds parent -> "delegated_capability_exceeds_parent"', () => {
    const d = evaluateRedelegation({
      parentAllowedTools: [DELEGATED_SUBMIT_TOOL_NAME],
      delegatedSubmitToolName: DELEGATED_SUBMIT_TOOL_NAME,
      parentDelegationDepth: 0,
      parentEffectiveCapability: boundCap,
      requestedChildCapability: excessRequested,
    });
    expect(d.allowed).toBe(false);
    expect((d as { reason: string }).reason).toBe('delegated_capability_exceeds_parent');
  });

  test('[Case 48] redelegation NOT granted AND depth exceeded simultaneously -> "redelegation_not_granted" wins (stable priority: redelegation check runs first)', () => {
    const d = evaluateRedelegation({
      parentAllowedTools: ['search'], // no adapter name
      delegatedSubmitToolName: DELEGATED_SUBMIT_TOOL_NAME,
      parentDelegationDepth: 5, // also exceeded
      parentEffectiveCapability: boundCap,
      requestedChildCapability: okRequested,
    });
    expect(d.allowed).toBe(false);
    expect((d as { reason: string }).reason).toBe('redelegation_not_granted');
  });

  test('[Case 49] invalid depth AND Capability excess simultaneously -> "invalid_delegation_depth" wins (depth check runs before Capability check)', () => {
    const d = evaluateRedelegation({
      parentAllowedTools: [DELEGATED_SUBMIT_TOOL_NAME],
      delegatedSubmitToolName: DELEGATED_SUBMIT_TOOL_NAME,
      parentDelegationDepth: NaN,
      parentEffectiveCapability: boundCap,
      requestedChildCapability: excessRequested,
    });
    expect(d.allowed).toBe(false);
    expect((d as { reason: string }).reason).toBe('invalid_delegation_depth');
  });

  test('[Case 50] on allow, the returned decision does not silently narrow or rewrite the requested Capability (grant-time Capability is the adapter\'s responsibility, not this function\'s)', () => {
    const d = evaluateRedelegation({
      parentAllowedTools: [DELEGATED_SUBMIT_TOOL_NAME],
      delegatedSubmitToolName: DELEGATED_SUBMIT_TOOL_NAME,
      parentDelegationDepth: 0,
      parentEffectiveCapability: boundCap,
      requestedChildCapability: okRequested,
    });
    // The decision on allow carries ONLY {allowed, childDelegationDepth} —
    // no capability field to silently mutate/narrow at all.
    expect(Object.keys(d).sort()).toEqual(['allowed', 'childDelegationDepth']);
  });

  test('depth-exceeded vs invalid-depth reasons are mutually exclusive by construction (no depth value can trigger both)', () => {
    // Documents the priority-list ordering claim structurally: exceeding
    // the max only ever happens for a valid (integer, non-negative) depth.
    for (const depth of [5, 6, 100]) {
      const d = nextDelegationDepth(depth);
      expect((d as { reason?: string }).reason).toBe('delegation_depth_exceeded');
    }
    for (const depth of [-1, 0.5, NaN, Infinity, -Infinity]) {
      const d = nextDelegationDepth(depth);
      expect((d as { reason?: string }).reason).toBe('invalid_delegation_depth');
    }
  });
});
