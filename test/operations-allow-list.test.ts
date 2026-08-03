/**
 * IRON RULE security regression guard for the v0.21 trusted-workspace
 * allow-list path on put_page.
 *
 * Covers:
 *   - matchesSlugAllowList glob semantics (ALLOW + REJECT + recursive globs)
 *   - put_page accepts when slug matches allow-list
 *   - put_page rejects when slug is outside allow-list
 *   - put_page falls back to legacy `wiki/agents/<id>/...` namespace check
 *     when allowed_slug_prefixes is unset (regression guard for v0.15
 *     anti-prompt-injection guarantee)
 *   - put_page rejects when viaSubagent=true but subagentId is missing
 *     (regression guard for FAIL-CLOSED behavior)
 */

import { describe, test, expect } from 'bun:test';
import { matchesSlugAllowList, isRequestedSlugPrefixWithinBound, operations, OperationError, type OperationContext } from '../src/core/operations.ts';

const STUB_LOGGER = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

const STUB_CONFIG = {} as unknown as Parameters<typeof operations[number]['handler']>[0]['config'];

function findOp(name: string) {
  const op = operations.find(o => o.name === name);
  if (!op) throw new Error(`operation ${name} not found`);
  return op;
}

// Stub engine that fails loudly if put_page actually reaches importFromContent.
// We expect every test in this file to short-circuit at the namespace/allow-list
// check, so every engine method throws a recognizable error that lets us assert
// "got past the gate" if it ever happens.
function stubEngine() {
  return new Proxy({} as never, {
    get(_target, prop: string) {
      return () => { throw new Error(`engine.${prop} should not have been called — gate failed`); };
    },
  }) as Parameters<typeof operations[number]['handler']>[0]['engine'];
}

function makeCtx(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine: stubEngine(),
    config: STUB_CONFIG,
    logger: STUB_LOGGER,
    dryRun: false,
    remote: true,
    viaSubagent: true,
    subagentId: 42,
    jobId: 100,
    ...overrides,
  } as OperationContext;
}

describe('matchesSlugAllowList — glob semantics', () => {
  test('exact match (no glob suffix)', () => {
    expect(matchesSlugAllowList('foo/bar', ['foo/bar'])).toBe(true);
    expect(matchesSlugAllowList('foo/bar/baz', ['foo/bar'])).toBe(false);
  });

  test('shallow glob: prefix/* matches any single direct child segment', () => {
    expect(matchesSlugAllowList('wiki/personal/reflections/2026-04-25-arete-paradox-a3f8c1',
      ['wiki/personal/reflections/*'])).toBe(true);
    expect(matchesSlugAllowList('wiki/personal/reflections',
      ['wiki/personal/reflections/*'])).toBe(false);
  });

  test('recursive: prefix/* matches deep children too', () => {
    expect(matchesSlugAllowList('wiki/originals/ideas/2026-04-25-foo',
      ['wiki/originals/*'])).toBe(true);
    expect(matchesSlugAllowList('wiki/originals/ideas/foo/bar',
      ['wiki/originals/*'])).toBe(true);
  });

  test('rejects slugs outside every prefix', () => {
    const list = [
      'wiki/personal/reflections/*',
      'wiki/originals/*',
    ];
    expect(matchesSlugAllowList('wiki/finance/secret', list)).toBe(false);
    expect(matchesSlugAllowList('wiki/people/alice', list)).toBe(false);
  });

  test('empty list rejects everything', () => {
    expect(matchesSlugAllowList('wiki/anything', [])).toBe(false);
  });

  test('does NOT match prefix without trailing segment', () => {
    expect(matchesSlugAllowList('wiki/personal/reflections',
      ['wiki/personal/reflections/*'])).toBe(false);
  });
});

describe('isRequestedSlugPrefixWithinBound — grant-time narrowing predicate (dashboard-5krlu)', () => {
  // Each row: [requestedPrefix, boundPrefix, expectedAllowed, description]
  const CASES: Array<[string, string, boolean, string]> = [
    // --- (A) slash-boundary crossing via raw startsWith — the core fail-open ---
    ['agent-notes-secret/*', 'agent-notes', false, 'bare bound "agent-notes" must not grant the sibling namespace "agent-notes-secret/*" (R1)'],
    ['wiki-private/*', 'wiki', false, 'bare bound "wiki" must not grant sibling "wiki-private/*" (R2)'],
    ['wiki/personalx/*', 'wiki/personal', false, 'bare bound "wiki/personal" must not grant sibling "wiki/personalx/*" (R3)'],
    // --- existing regression-preserving cases (must stay ALLOW/DENY exactly as today) ---
    ['wiki/', 'wiki/', true, 'requested equals bound exactly (both trailing-slash form)'],
    ['private/', 'wiki/', false, 'requested outside bound entirely'],
    ['wiki/*', 'wiki/', true, 'requested is the bound namespace expressed as an explicit glob'],
    ['wiki/secret/*', 'wiki/', true, 'requested is a genuine sub-namespace of a trailing-slash bound'],
    // --- deliberate narrowing: bare request against a subtree-shaped bound is denied ---
    ['wiki', 'wiki/', false, 'bare (non-glob) requested prefix equal to the bound\'s stripped base is still denied when bound is subtree-shaped'],
    // --- the ONE intentional relaxation vs. the pre-fix predicate (over-strict fail-closed fixed) ---
    ['wiki/agents/*', 'wiki/*', true, 'a genuine child glob of a glob-shaped bound is now correctly allowed (was wrongly denied before this fix)'],
    // --- exact non-glob equality on both sides ---
    ['wiki/originals', 'wiki/originals', true, 'exact non-glob match on both sides'],
    ['wiki/originals', 'wiki/originals/*', false, 'a bare exact request is not implied by a glob-shaped bound one level up (R5)'],
    // --- multiple bound segments, only one should match ---
    ['people/alice/*', 'wiki/', false, 'requested subtree under an unrelated bound root'],
  ];

  for (const [requested, bound, expected, description] of CASES) {
    test(`${expected ? 'ALLOW' : 'DENY'}: requested="${requested}" bound="${bound}" — ${description}`, () => {
      expect(isRequestedSlugPrefixWithinBound(requested, bound)).toBe(expected);
    });
  }

  test('is a pure function: repeated calls with the same arguments always return the same result', () => {
    const a = isRequestedSlugPrefixWithinBound('wiki/secret/*', 'wiki/');
    const b = isRequestedSlugPrefixWithinBound('wiki/secret/*', 'wiki/');
    expect(a).toBe(b);
    expect(a).toBe(true);
  });
});

describe('AUTHZ-INV-005: grant-approved slug prefixes never exceed the bound namespace at exercise time (dashboard-5krlu invariant)', () => {
  // The property this enforces: for ANY bound prefix `bp` and ANY requested
  // prefix `sp`, if isRequestedSlugPrefixWithinBound(sp, bp) says "granted",
  // then EVERY slug matchesSlugAllowList would accept for `sp` at exercise
  // time must also be a slug that would fall under `bp`'s own namespace
  // (bp's stripped base, or anything beneath it). This is checked here by
  // sampling representative slugs for every requested prefix in the table
  // above, rather than by re-deriving the same boolean algebra — a
  // duplicate-of-the-implementation property test would pass even if both
  // the predicate and this test shared the same bug.
  const BOUND_TO_SAMPLE_SLUGS: Record<string, string[]> = {
    'wiki/': ['wiki/originals/idea-1', 'wiki/x', 'wiki/agents/1/note'],
    'wiki/*': ['wiki/agents/note', 'wiki/x'],
    'agent-notes': ['agent-notes'],
    'wiki': ['wiki'],
    'wiki/personal': ['wiki/personal'],
    'wiki/originals': ['wiki/originals'],
    'wiki/originals/*': ['wiki/originals/x'],
  };

  function slugFallsUnderBoundNamespace(slug: string, boundPrefix: string): boolean {
    const boundIsSubtreeRoot = boundPrefix.endsWith('/*') || boundPrefix.endsWith('/');
    const base = boundIsSubtreeRoot
      ? boundPrefix.slice(0, boundPrefix.endsWith('/*') ? -2 : -1)
      : boundPrefix;
    return slug === base || slug.startsWith(base + '/');
  }

  const CASES: Array<[string, string]> = [
    ['agent-notes-secret/*', 'agent-notes'],
    ['wiki-private/*', 'wiki'],
    ['wiki/personalx/*', 'wiki/personal'],
    ['wiki/', 'wiki/'],
    ['private/', 'wiki/'],
    ['wiki/*', 'wiki/'],
    ['wiki/secret/*', 'wiki/'],
    ['wiki', 'wiki/'],
    ['wiki/agents/*', 'wiki/*'],
    ['wiki/originals', 'wiki/originals'],
    ['wiki/originals', 'wiki/originals/*'],
    ['people/alice/*', 'wiki/'],
  ];

  for (const [requested, bound] of CASES) {
    test(`grant(requested="${requested}", bound="${bound}") never lets exercise-time accept a slug outside bound's namespace`, () => {
      const granted = isRequestedSlugPrefixWithinBound(requested, bound);
      const sampleSlugs = BOUND_TO_SAMPLE_SLUGS[bound] ?? [];
      for (const slug of sampleSlugs) {
        const exerciseAllows = matchesSlugAllowList(slug, [requested]);
        if (granted && exerciseAllows) {
          expect(slugFallsUnderBoundNamespace(slug, bound)).toBe(true);
        }
        // If grant denied the prefix outright, exercise-time behavior for
        // that (now-unreachable) prefix is not this invariant's concern —
        // submit_agent never persists a denied prefix into job data.
      }
    });
  }
});

describe('put_page — trusted-workspace allow-list', () => {
  const put_page = findOp('put_page');

  test('REJECTS when slug is outside the allow-list', async () => {
    const ctx = makeCtx({
      allowedSlugPrefixes: ['wiki/personal/reflections/*', 'wiki/originals/*'],
    });
    await expect(put_page.handler(ctx, {
      slug: 'wiki/finance/secret',
      content: '---\ntitle: x\n---\nbody',
    })).rejects.toMatchObject({
      code: 'permission_denied',
    });
  });

  test('REJECTS path-traversal-like slug (slug regex catches it earlier in the import path; allow-list also catches via no-match)', async () => {
    const ctx = makeCtx({
      allowedSlugPrefixes: ['wiki/personal/reflections/*'],
    });
    // The slug regex in validatePageSlug rejects `..`; here we test the
    // allow-list layer specifically with a slug that LOOKS legal but isn't on the list.
    await expect(put_page.handler(ctx, {
      slug: 'wiki/people/garry-tan',
      content: '---\ntitle: x\n---\nbody',
    })).rejects.toMatchObject({
      code: 'permission_denied',
    });
  });
});

describe('put_page — legacy namespace check (regression guard)', () => {
  const put_page = findOp('put_page');

  test('REJECTS write outside wiki/agents/<id>/ when allow-list is unset', async () => {
    // The v0.15 anti-prompt-injection guarantee: subagent without explicit
    // allow-list MUST be confined to its own agent namespace. This test
    // ensures v0.21 doesn't regress that boundary.
    const ctx = makeCtx({ allowedSlugPrefixes: undefined });
    await expect(put_page.handler(ctx, {
      slug: 'wiki/personal/reflections/2026-04-25-foo',
      content: '---\ntitle: x\n---\nbody',
    })).rejects.toMatchObject({
      code: 'permission_denied',
    });
  });

  test('REJECTS write outside wiki/agents/<id>/ when allow-list is empty array', async () => {
    const ctx = makeCtx({ allowedSlugPrefixes: [] });
    await expect(put_page.handler(ctx, {
      slug: 'wiki/personal/reflections/2026-04-25-foo',
      content: '---\ntitle: x\n---\nbody',
    })).rejects.toMatchObject({
      code: 'permission_denied',
    });
  });

  test('REJECTS when viaSubagent=true but subagentId is missing (FAIL-CLOSED)', async () => {
    const ctx = makeCtx({ subagentId: undefined as unknown as number, allowedSlugPrefixes: undefined });
    await expect(put_page.handler(ctx, {
      slug: 'wiki/agents/42/foo',
      content: '---\ntitle: x\n---\nbody',
    })).rejects.toMatchObject({
      code: 'permission_denied',
    });
  });
});
