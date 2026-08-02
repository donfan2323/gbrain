/**
 * Phase 9B (REQUIRED-4 remediation, extended after internal Phase 9B
 * closure review) — direct tests of GBrainOAuthProvider.verifyAccessToken()'s
 * degrade-gracefully fallback chain against constructed pre-migration DB
 * states, plus a check that a genuinely UNRELATED undefined-table error is
 * never silently absorbed by that fallback.
 *
 * Design reference: PHASE9A-AUTHORIZATION-INVARIANTS.md,
 * PHASE9B-IMPLEMENTATION-SCOPE-PROPOSAL.md. verifyAccessToken()'s outer
 * catch (src/core/oauth-provider.ts) degrades to the pre-Phase-9B query
 * chain when it sees `principal_id` column missing OR the `principals`
 * table missing OR `source_id`/`federated_read` column missing
 * (pre-v60/pre-v61). REQUIRED-4 also required evaluating whether
 * `isUndefinedTableError(err0)`'s original unconditional use was too broad;
 * it now takes a `table` argument (src/core/utils.ts) and this file's last
 * describe block proves an undefined-table error for an unrelated table is
 * NOT swallowed by that fallback.
 *
 * REQUIRED-1 (Phase 9B performance review, addressed after the gaps below):
 * the query no longer LEFT JOINs `principal_kinds` — `principal_kind` is
 * read directly off `principals.kind_id` (a NOT NULL FK column, so the
 * JOIN was a provable no-op) — so a missing `principal_kinds` table no
 * longer affects resolution at all; see the
 * "principal_kinds table missing" describe block below, which now asserts
 * successful resolution instead of degraded fallback.
 *
 * Internal review after REQUIRED-4's original delivery found two real
 * gaps, both fixed in this revision:
 *
 *   1. Every state test shared ONE engine and applied its DROP
 *      cumulatively on top of every prior test's DROPs (monotonic single-
 *      engine design). Because `principal_id` was always dropped before
 *      `principals`/`principal_kinds` in test declaration order, the
 *      state "principal_id column still exists but principals/
 *      principal_kinds table is gone" was never actually reached — so
 *      `isUndefinedTableError(err0, 'principals')` and `(..., 'principal_kinds')`
 *      in the outer catch had zero test coverage despite the file's own
 *      docstring implying otherwise. Rewritten so every state gets a
 *      fresh, independently-initialized engine and applies only the
 *      drops that state actually needs — the two previously-unreachable
 *      states are now their own tests below. (The `principal_kinds` side
 *      of this — and its disjunct in the outer catch — was later removed
 *      by REQUIRED-1 above; only the `principals` disjunct remains live.)
 *
 *   2. The "unrelated undefined-table error is not swallowed" test used a
 *      bare `.rejects.toThrow()` with no matcher. Both the narrowed and
 *      the pre-narrowing behavior throw for that specific scenario (every
 *      fallback query in the chain also references `oauth_tokens`, so an
 *      `oauth_tokens`-missing error propagates as a throw either way) —
 *      the assertion could not actually have detected a regression back
 *      to the unconditional `isUndefinedTableError(err0)`. Strengthened
 *      to assert on the propagated error's identity (SQLSTATE + message
 *      still names the real missing table), so a future change that
 *      silently substitutes a different, wrongly-absorbed error would be
 *      caught.
 *
 * Isolation note (scripts/check-test-isolation.sh R3+R4): each state below
 * is its own `describe()` with its own `beforeAll` (creates + initializes
 * the engine, applies that state's drops) and `afterAll` (disconnects it).
 * `initStateEngine()` factors out the "apply drops, build sql tag + OAuth
 * provider" steps shared across states, but each `beforeAll` directly
 * constructs its own PGLiteEngine instance so every construction site sits
 * inside a `beforeAll()` block, and every engine is disconnected in that
 * same describe's `afterAll()` — preserving the original one-engine-per-
 * state design while satisfying the lint's per-file text-proximity rule.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';

function makeSqlTag(engine: PGLiteEngine) {
  return async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.reduce((acc, str, i) => acc + str + (i < values.length ? `$${i + 1}` : ''), '');
    return engine.executeRaw(query, values as unknown[]);
  };
}

/** Applies exactly the given DDL statements to an already-connected,
 * freshly-initialized (v125) engine, then returns the sql tag + OAuth
 * provider bound to it. Callers create the engine themselves (inside their
 * own beforeAll, so the PGLiteEngine construction call sits directly under
 * a beforeAll per scripts/check-test-isolation.sh R3) and disconnect it
 * themselves (inside their own afterAll, per R4) — this helper only owns
 * the "apply drops + build sql/provider" part of the per-state setup. */
async function initStateEngine(engine: PGLiteEngine, drops: string[]) {
  await engine.connect({});
  await engine.initSchema();
  for (const ddl of drops) {
    await engine.executeRaw(ddl, []);
  }
  const sql = makeSqlTag(engine);
  const provider = new GBrainOAuthProvider({ sql, tokenTtl: 60, refreshTtl: 300 });
  return { sql, provider };
}

describe('REQUIRED-4: verifyAccessToken degrades correctly across constructed pre-migration DB states', () => {
  describe('baseline (full v125 schema)', () => {
    let engine: PGLiteEngine;
    let sql: ReturnType<typeof makeSqlTag>;
    let provider: GBrainOAuthProvider;

    beforeAll(async () => {
      engine = new PGLiteEngine();
      ({ sql, provider } = await initStateEngine(engine, []));
    });

    afterAll(async () => {
      await engine.disconnect();
    });

    test('a Principal-linked client resolves principalId/principalKind and source_id/federated_read together', async () => {
      const [{ id: principalId }] = await sql`
        INSERT INTO principals (kind_id, display_name) VALUES ('human', 'baseline-owner') RETURNING id
      `;
      const { clientId, clientSecret } = await provider.registerClientManual(
        'fallback-baseline', ['client_credentials'], 'read write',
      );
      await sql`UPDATE oauth_clients SET principal_id = ${principalId} WHERE client_id = ${clientId}`;
      const tokens = await provider.exchangeClientCredentials(clientId, clientSecret!, 'read write');
      const auth = await provider.verifyAccessToken(tokens.access_token);

      expect(auth.clientId).toBe(clientId);
      expect((auth as any).principalId).toBe(principalId);
      expect((auth as any).principalKind).toBe('human');
      expect((auth as any).sourceId).toBe('default');
      expect(auth.scopes.sort()).toEqual(['read', 'write']);
    });
  });

  describe('principal_id column missing (principals/principal_kinds tables still present)', () => {
    let engine: PGLiteEngine;
    let provider: GBrainOAuthProvider;

    beforeAll(async () => {
      engine = new PGLiteEngine();
      ({ provider } = await initStateEngine(engine, [
        'DROP INDEX IF EXISTS idx_oauth_clients_principal_id',
        'ALTER TABLE oauth_clients DROP COLUMN IF EXISTS principal_id',
      ]));
    });

    afterAll(async () => {
      await engine.disconnect();
    });

    test('auth succeeds, principalId/principalKind undefined, source_id/federated_read intact', async () => {
      const { clientId, clientSecret } = await provider.registerClientManual(
        'fallback-no-principal-id-column', ['client_credentials'], 'read write',
      );
      const tokens = await provider.exchangeClientCredentials(clientId, clientSecret!, 'read write');
      const auth = await provider.verifyAccessToken(tokens.access_token);

      expect(auth.clientId).toBe(clientId);
      expect((auth as any).principalId).toBeUndefined();
      expect((auth as any).principalKind).toBeUndefined();
      expect((auth as any).sourceId).toBe('default'); // source_id/federated_read compatibility unaffected
      expect(auth.scopes.sort()).toEqual(['read', 'write']);
    });
  });

  describe('principals table missing but principal_id column STILL PRESENT (previously-unreachable branch: isUndefinedTableError(err0, "principals") actually fires)', () => {
    let engine: PGLiteEngine;
    let provider: GBrainOAuthProvider;

    beforeAll(async () => {
      engine = new PGLiteEngine();
      // CASCADE drops the FK constraint referencing principals, but leaves
      // oauth_clients.principal_id itself in place — exactly the state the
      // monotonic single-engine design could never reach, because it always
      // dropped principal_id before dropping principals.
      ({ provider } = await initStateEngine(engine, [
        'DROP TABLE IF EXISTS principals CASCADE',
      ]));
    });

    afterAll(async () => {
      await engine.disconnect();
    });

    test('auth succeeds, principalId/principalKind undefined', async () => {
      const { clientId, clientSecret } = await provider.registerClientManual(
        'fallback-no-principals-table-column-present', ['client_credentials'], 'read',
      );
      const tokens = await provider.exchangeClientCredentials(clientId, clientSecret!, 'read');
      const auth = await provider.verifyAccessToken(tokens.access_token);

      expect(auth.clientId).toBe(clientId);
      expect((auth as any).principalId).toBeUndefined();
      expect((auth as any).principalKind).toBeUndefined();
      expect((auth as any).sourceId).toBe('default');
      expect(auth.scopes).toEqual(['read']);
    });
  });

  describe('principal_kinds table missing but principals + principal_id STILL PRESENT (REQUIRED-1 perf remediation: query no longer JOINs principal_kinds, so this drop no longer affects resolution)', () => {
    let engine: PGLiteEngine;
    let sql: ReturnType<typeof makeSqlTag>;
    let provider: GBrainOAuthProvider;

    beforeAll(async () => {
      engine = new PGLiteEngine();
      ({ sql, provider } = await initStateEngine(engine, [
        'DROP TABLE IF EXISTS principal_kinds CASCADE',
      ]));
    });

    afterAll(async () => {
      await engine.disconnect();
    });

    test('principalId/principalKind resolve normally from principals.kind_id even with principal_kinds dropped, because the query no longer depends on that table', async () => {
      const [{ id: principalId }] = await sql`
        INSERT INTO principals (kind_id, display_name) VALUES ('human', 'kinds-missing-owner') RETURNING id
      `;
      const { clientId, clientSecret } = await provider.registerClientManual(
        'fallback-no-principal-kinds-table', ['client_credentials'], 'read',
      );
      await sql`UPDATE oauth_clients SET principal_id = ${principalId} WHERE client_id = ${clientId}`;
      const tokens = await provider.exchangeClientCredentials(clientId, clientSecret!, 'read');
      const auth = await provider.verifyAccessToken(tokens.access_token);

      expect(auth.clientId).toBe(clientId);
      expect((auth as any).principalId).toBe(principalId);
      expect((auth as any).principalKind).toBe('human');
      expect((auth as any).sourceId).toBe('default');
      expect(auth.scopes).toEqual(['read']);
    });
  });

  describe('genuine pre-v125 shape (principal_id column, principals, and principal_kinds all missing)', () => {
    let engine: PGLiteEngine;
    let provider: GBrainOAuthProvider;

    beforeAll(async () => {
      engine = new PGLiteEngine();
      ({ provider } = await initStateEngine(engine, [
        'DROP INDEX IF EXISTS idx_oauth_clients_principal_id',
        'ALTER TABLE oauth_clients DROP COLUMN IF EXISTS principal_id',
        'DROP TABLE IF EXISTS principals CASCADE',
        'DROP TABLE IF EXISTS principal_kinds CASCADE',
      ]));
    });

    afterAll(async () => {
      await engine.disconnect();
    });

    test('auth still succeeds', async () => {
      const { clientId, clientSecret } = await provider.registerClientManual(
        'fallback-pre-v125-full', ['client_credentials'], 'read write',
      );
      const tokens = await provider.exchangeClientCredentials(clientId, clientSecret!, 'read write');
      const auth = await provider.verifyAccessToken(tokens.access_token);

      expect(auth.clientId).toBe(clientId);
      expect((auth as any).principalId).toBeUndefined();
      expect((auth as any).principalKind).toBeUndefined();
      expect((auth as any).sourceId).toBe('default');
      expect(auth.scopes.sort()).toEqual(['read', 'write']);
    });
  });

  describe('pre-v61 shape (federated_read column also missing, on top of full pre-v125)', () => {
    let engine: PGLiteEngine;
    let provider: GBrainOAuthProvider;

    beforeAll(async () => {
      engine = new PGLiteEngine();
      ({ provider } = await initStateEngine(engine, [
        'DROP INDEX IF EXISTS idx_oauth_clients_principal_id',
        'ALTER TABLE oauth_clients DROP COLUMN IF EXISTS principal_id',
        'DROP TABLE IF EXISTS principals CASCADE',
        'DROP TABLE IF EXISTS principal_kinds CASCADE',
        'ALTER TABLE oauth_clients DROP COLUMN IF EXISTS federated_read',
      ]));
    });

    afterAll(async () => {
      await engine.disconnect();
    });

    test('auth succeeds via the v60-only projection, allowedSources undefined', async () => {
      const { clientId, clientSecret } = await provider.registerClientManual(
        'fallback-pre-v61', ['client_credentials'], 'read',
      );
      const tokens = await provider.exchangeClientCredentials(clientId, clientSecret!, 'read');
      const auth = await provider.verifyAccessToken(tokens.access_token);

      expect(auth.clientId).toBe(clientId);
      expect((auth as any).principalId).toBeUndefined();
      expect((auth as any).principalKind).toBeUndefined();
      expect((auth as any).sourceId).toBe('default'); // source_id still present at this depth
      expect((auth as any).allowedSources).toBeUndefined();
      expect(auth.scopes).toEqual(['read']);
    });
  });

  describe('pre-v60 shape (source_id column also missing, deepest legacy projection)', () => {
    let engine: PGLiteEngine;
    let provider: GBrainOAuthProvider;

    beforeAll(async () => {
      engine = new PGLiteEngine();
      ({ provider } = await initStateEngine(engine, [
        'DROP INDEX IF EXISTS idx_oauth_clients_principal_id',
        'ALTER TABLE oauth_clients DROP COLUMN IF EXISTS principal_id',
        'DROP TABLE IF EXISTS principals CASCADE',
        'DROP TABLE IF EXISTS principal_kinds CASCADE',
        'ALTER TABLE oauth_clients DROP COLUMN IF EXISTS federated_read',
        'ALTER TABLE oauth_clients DROP COLUMN IF EXISTS source_id',
      ]));
    });

    afterAll(async () => {
      await engine.disconnect();
    });

    test('auth still succeeds, sourceId/allowedSources both undefined', async () => {
      const { clientId, clientSecret } = await provider.registerClientManual(
        'fallback-pre-v60', ['client_credentials'], 'read write',
      );
      const tokens = await provider.exchangeClientCredentials(clientId, clientSecret!, 'read write');
      const auth = await provider.verifyAccessToken(tokens.access_token);

      expect(auth.clientId).toBe(clientId);
      expect((auth as any).clientName).toBe('fallback-pre-v60');
      expect((auth as any).principalId).toBeUndefined();
      expect((auth as any).principalKind).toBeUndefined();
      expect((auth as any).sourceId).toBeUndefined();
      expect((auth as any).allowedSources).toBeUndefined();
      expect(auth.scopes.sort()).toEqual(['read', 'write']);
    });
  });
});

describe('REQUIRED-4: an unrelated undefined-table error is never silently absorbed as "pre-Phase-9B"', () => {
  test('isUndefinedTableError(err, table) requires the named table to appear in the message', async () => {
    const { isUndefinedTableError } = await import('../src/core/utils.ts');
    const err = new Error('relation "principals" does not exist');
    (err as any).code = '42P01';
    expect(isUndefinedTableError(err)).toBe(true); // unscoped: unchanged broad behavior for existing callers
    expect(isUndefinedTableError(err, 'principals')).toBe(true);
    expect(isUndefinedTableError(err, 'oauth_tokens')).toBe(false); // narrowed: does NOT match an unrelated table
  });

  describe('oauth_tokens missing entirely', () => {
    let engine: PGLiteEngine;
    let provider: GBrainOAuthProvider;

    beforeAll(async () => {
      engine = new PGLiteEngine();
      ({ provider } = await initStateEngine(engine, []));
    });

    afterAll(async () => {
      await engine.disconnect();
    });

    test('verifyAccessToken throws the real oauth_tokens error, not a substituted/absorbed one', async () => {
      // A registered client exists so a plausible-looking token can be built,
      // but the token itself was never inserted into oauth_tokens (which we
      // then drop) — this simulates "some other, unrelated table is missing"
      // rather than "Phase 9B hasn't migrated in yet."
      await provider.registerClientManual('unrelated-table-missing-test', ['client_credentials'], 'read');
      await engine.executeRaw('DROP TABLE oauth_tokens CASCADE', []);

      let caught: unknown;
      try {
        await provider.verifyAccessToken('gbrain_at_doesnotmatter');
        throw new Error('expected verifyAccessToken to throw');
      } catch (e) {
        caught = e;
      }
      // Strengthened per internal review: a bare .rejects.toThrow() passes
      // whether or not narrowing is in effect (every fallback query in the
      // chain also references oauth_tokens, so this scenario throws either
      // way) — it could not have detected a regression to the unconditional
      // isUndefinedTableError(err0). Assert on the propagated error's
      // actual identity instead: it must be the real "oauth_tokens missing"
      // error, not some other error a broken narrowing could substitute.
      expect((caught as any)?.code).toBe('42P01');
      expect(String((caught as any)?.message ?? '')).toContain('oauth_tokens');
    });
  });
});
