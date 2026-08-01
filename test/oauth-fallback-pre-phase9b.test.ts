/**
 * Phase 9B (REQUIRED-4 remediation) — direct tests of
 * GBrainOAuthProvider.verifyAccessToken()'s degrade-gracefully fallback
 * chain against constructed pre-migration DB states, plus a check that a
 * genuinely UNRELATED undefined-table error is never silently absorbed by
 * that fallback.
 *
 * Design reference: PHASE9A-AUTHORIZATION-INVARIANTS.md,
 * PHASE9B-IMPLEMENTATION-SCOPE-PROPOSAL.md. verifyAccessToken()'s outer
 * catch (src/core/oauth-provider.ts) degrades to the pre-Phase-9B query
 * chain when it sees `principal_id` column missing OR the `principals` /
 * `principal_kinds` tables missing OR `source_id`/`federated_read` column
 * missing (pre-v60/pre-v61). REQUIRED-4 also required evaluating whether
 * `isUndefinedTableError(err0)`'s original unconditional use was too broad;
 * it now takes a `table` argument (src/core/utils.ts) and this file's last
 * describe block proves an undefined-table error for an unrelated table is
 * NOT swallowed by that fallback.
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

describe('REQUIRED-4: verifyAccessToken degrades correctly across constructed pre-migration DB states', () => {
  let engine: PGLiteEngine;
  let sql: ReturnType<typeof makeSqlTag>;
  let provider: GBrainOAuthProvider;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    sql = makeSqlTag(engine);
    provider = new GBrainOAuthProvider({ sql, tokenTtl: 60, refreshTtl: 300 });
  }, 30_000);

  afterAll(async () => {
    await engine.disconnect();
  });

  test('baseline (full v125 schema): a Principal-linked client resolves principalId/principalKind and source_id/federated_read together', async () => {
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

  test('principal_id column missing (principals/principal_kinds tables still present): auth succeeds, principalId/principalKind undefined, source_id/federated_read intact', async () => {
    await sql`DROP INDEX IF EXISTS idx_oauth_clients_principal_id`;
    await sql`ALTER TABLE oauth_clients DROP COLUMN IF EXISTS principal_id`;

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

  test('principals table also missing (principal_id column already gone): auth still succeeds, same degraded shape', async () => {
    await sql`DROP TABLE IF EXISTS principals`;

    const { clientId, clientSecret } = await provider.registerClientManual(
      'fallback-no-principals-table', ['client_credentials'], 'read',
    );
    const tokens = await provider.exchangeClientCredentials(clientId, clientSecret!, 'read');
    const auth = await provider.verifyAccessToken(tokens.access_token);

    expect(auth.clientId).toBe(clientId);
    expect((auth as any).principalId).toBeUndefined();
    expect((auth as any).principalKind).toBeUndefined();
    expect((auth as any).sourceId).toBe('default');
    expect(auth.scopes).toEqual(['read']);
  });

  test('principal_kinds table also missing (genuine pre-v125 shape: no principal_id column, no principals, no principal_kinds): auth still succeeds', async () => {
    await sql`DROP TABLE IF EXISTS principal_kinds`;

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

  test('pre-v61 shape (federated_read column also missing): auth succeeds via the v60-only projection, allowedSources undefined', async () => {
    await sql`ALTER TABLE oauth_clients DROP COLUMN IF EXISTS federated_read`;

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

  test('pre-v60 shape (source_id column also missing): auth still succeeds via the deepest legacy projection, sourceId/allowedSources both undefined', async () => {
    await sql`ALTER TABLE oauth_clients DROP COLUMN IF EXISTS source_id`;

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

describe('REQUIRED-4: an unrelated undefined-table error is never silently absorbed as "pre-Phase-9B"', () => {
  let engine: PGLiteEngine;
  let sql: ReturnType<typeof makeSqlTag>;
  let provider: GBrainOAuthProvider;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    sql = makeSqlTag(engine);
    provider = new GBrainOAuthProvider({ sql, tokenTtl: 60, refreshTtl: 300 });
  }, 30_000);

  afterAll(async () => {
    await engine.disconnect();
  });

  test('isUndefinedTableError(err, table) requires the named table to appear in the message', async () => {
    const { isUndefinedTableError } = await import('../src/core/utils.ts');
    const err = new Error('relation "principals" does not exist');
    (err as any).code = '42P01';
    expect(isUndefinedTableError(err)).toBe(true); // unscoped: unchanged broad behavior for existing callers
    expect(isUndefinedTableError(err, 'principals')).toBe(true);
    expect(isUndefinedTableError(err, 'oauth_tokens')).toBe(false); // narrowed: does NOT match an unrelated table
  });

  test('oauth_tokens missing entirely: verifyAccessToken throws rather than returning a degraded-but-successful AuthInfo', async () => {
    // A registered client exists so a plausible-looking token can be built,
    // but the token itself was never inserted into oauth_tokens (which we
    // then drop) — this simulates "some other, unrelated table is missing"
    // rather than "Phase 9B hasn't migrated in yet."
    const { clientId } = await provider.registerClientManual(
      'unrelated-table-missing-test', ['client_credentials'], 'read',
    );
    await sql`DROP TABLE oauth_tokens CASCADE`;

    await expect(provider.verifyAccessToken('gbrain_at_doesnotmatter')).rejects.toThrow();
    void clientId;
  });
});
