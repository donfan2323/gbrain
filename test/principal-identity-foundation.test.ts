/**
 * Phase 9B (Universal Identity Foundation) — Principal foundation tests.
 *
 * Design reference (priority order): PHASE9A-IDENTITY-MODEL-DECISION.md,
 * PHASE9A-AUTHORIZATION-INVARIANTS.md, PHASE9B-IMPLEMENTATION-SCOPE-PROPOSAL.md.
 *
 * Covers the 10 minimum automated checks specified for Phase 9B:
 *   1. Different Principal kinds, same scope -> same authorization result
 *   2. Principal-unattributed Client -> behaves exactly as before (scope-only)
 *   3. Attributing a Principal does not increase or decrease Capability
 *   4. Principal.revoked_at set -> no change to Client auth/authz result
 *   5. New Principal kind addable via data row only (no schema change)
 *   6. Unknown kind works with zero authorization-core changes
 *   7. Product/vendor/client-name/Principal-kind never auto-grants scope
 *   8. New Client registration defaults principal_id to null
 *   9. FK to a non-existent Principal is rejected
 *  10. Deleting a Principal that is linked to a Client is rejected (ON DELETE
 *      RESTRICT, not SET NULL and not CASCADE) — the Client row, its
 *      principal_id link, and its audit trail (mcp_request_log) all survive
 *      unchanged, because the delete itself never happens.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { PGLITE_SCHEMA_SQL } from '../src/core/pglite-schema.ts';
import { hasScope } from '../src/core/scope.ts';

let db: PGlite;
let sql: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<any>;
let provider: GBrainOAuthProvider;

beforeAll(async () => {
  db = new PGlite({ extensions: { vector, pg_trgm } });
  await db.exec(PGLITE_SCHEMA_SQL);

  sql = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.reduce((acc, str, i) => acc + str + (i < values.length ? `$${i + 1}` : ''), '');
    const result = await db.query(query, values as any[]);
    return result.rows;
  };

  provider = new GBrainOAuthProvider({ sql, tokenTtl: 60, refreshTtl: 300 });
}, 30_000);

afterAll(async () => {
  if (db) await db.close();
});

describe('principal_kinds bootstrap', () => {
  test('5 canonical kinds are present after fresh schema replay', async () => {
    const rows = await sql`SELECT id, label FROM principal_kinds ORDER BY id`;
    const ids = rows.map((r: any) => r.id).sort();
    expect(ids).toEqual(['agent', 'device', 'human', 'service', 'unknown']);
  });

  test('re-running the bootstrap INSERT is idempotent (ON CONFLICT DO NOTHING)', async () => {
    await sql`
      INSERT INTO principal_kinds (id, label, description) VALUES
        ('human', 'Human', 'A human operator or account holder.')
      ON CONFLICT (id) DO NOTHING
    `;
    const rows = await sql`SELECT count(*)::int AS n FROM principal_kinds WHERE id = 'human'`;
    expect(rows[0].n).toBe(1);
  });

  test('#5: a brand-new kind can be added via a plain data-row INSERT, no schema change', async () => {
    await sql`INSERT INTO principal_kinds (id, label, description) VALUES ('robot', 'Robot', 'A physical robot.')`;
    const rows = await sql`SELECT id, label FROM principal_kinds WHERE id = 'robot'`;
    expect(rows.length).toBe(1);
    expect(rows[0].label).toBe('Robot');
  });
});

describe('principals table', () => {
  test('default kind_id is unknown when not specified', async () => {
    const rows = await sql`INSERT INTO principals (display_name) VALUES ('test principal') RETURNING id, kind_id`;
    expect(rows[0].kind_id).toBe('unknown');
  });

  test('#9: FK to a non-existent principal_kinds row is rejected', async () => {
    await expect(
      sql`INSERT INTO principals (kind_id, display_name) VALUES ('nonexistent-kind', 'bad')`,
    ).rejects.toBeTruthy();
  });

  test('revoked_at can be set without deleting the row (soft state only)', async () => {
    const [{ id }] = await sql`INSERT INTO principals (kind_id, display_name) VALUES ('human', 'revocable') RETURNING id`;
    await sql`UPDATE principals SET revoked_at = now() WHERE id = ${id}`;
    const rows = await sql`SELECT revoked_at FROM principals WHERE id = ${id}`;
    expect(rows[0].revoked_at).not.toBeNull();
  });
});

describe('oauth_clients.principal_id', () => {
  test('#8: new client registration defaults principal_id to null', async () => {
    const { clientId } = await provider.registerClientManual(
      'principal-default-null-test', ['client_credentials'], 'read write',
    );
    const rows = await sql`SELECT principal_id FROM oauth_clients WHERE client_id = ${clientId}`;
    expect(rows[0].principal_id).toBeNull();
  });

  test('#9: FK to a non-existent principal is rejected', async () => {
    const { clientId } = await provider.registerClientManual(
      'principal-fk-reject-test', ['client_credentials'], 'read',
    );
    await expect(
      sql`UPDATE oauth_clients SET principal_id = '00000000-0000-0000-0000-000000000000' WHERE client_id = ${clientId}`,
    ).rejects.toBeTruthy();
  });

  test('#10: deleting a linked principal is rejected (ON DELETE RESTRICT), preserving the client link and its audit trail', async () => {
    const [{ id: principalId }] = await sql`INSERT INTO principals (kind_id, display_name) VALUES ('service', 'to-be-deleted') RETURNING id`;
    const { clientId } = await provider.registerClientManual(
      'principal-restrict-test', ['client_credentials'], 'read',
    );
    await sql`UPDATE oauth_clients SET principal_id = ${principalId} WHERE client_id = ${clientId}`;
    // Seed an audit row attributed to this client — the invariant under test
    // is that this remains reachable via token_name after the rejected delete.
    await sql`INSERT INTO mcp_request_log (token_name, agent_name, operation, status) VALUES (${clientId}, 'test-agent', 'search', 'success')`;

    await expect(
      sql`DELETE FROM principals WHERE id = ${principalId}`,
    ).rejects.toThrow();

    const clientRows = await sql`SELECT client_id, principal_id FROM oauth_clients WHERE client_id = ${clientId}`;
    expect(clientRows.length).toBe(1); // client survives
    expect(clientRows[0].principal_id).toBe(principalId); // link is untouched — the delete never happened

    const principalRows = await sql`SELECT id FROM principals WHERE id = ${principalId}`;
    expect(principalRows.length).toBe(1); // principal itself survives

    const auditRows = await sql`SELECT token_name FROM mcp_request_log WHERE token_name = ${clientId}`;
    expect(auditRows.length).toBe(1); // audit trail is unaffected and still resolves by token_name
  });
});

describe('AuthInfo Principal resolution (via verifyAccessToken)', () => {
  test('#2: unattributed client resolves AuthInfo with principalId/principalKind undefined, scopes unaffected', async () => {
    const { clientId, clientSecret } = await provider.registerClientManual(
      'unattributed-auth-test', ['client_credentials'], 'read write',
    );
    const tokens = await provider.exchangeClientCredentials(clientId, clientSecret!, 'read write');
    const authInfo = await provider.verifyAccessToken(tokens.access_token);

    expect(authInfo.clientId).toBe(clientId);
    expect((authInfo as any).principalId).toBeUndefined();
    expect((authInfo as any).principalKind).toBeUndefined();
    expect(authInfo.scopes).toContain('read');
    expect(authInfo.scopes).toContain('write');
  });

  test('#3/#7: attributing a Principal populates principalId/principalKind but does not change scopes', async () => {
    const [{ id: principalId, kind_id: kindId }] = await sql`
      INSERT INTO principals (kind_id, display_name) VALUES ('human', 'attributed-owner') RETURNING id, kind_id
    `;
    const { clientId, clientSecret } = await provider.registerClientManual(
      'attributed-auth-test', ['client_credentials'], 'read write',
    );
    await sql`UPDATE oauth_clients SET principal_id = ${principalId} WHERE client_id = ${clientId}`;

    const tokens = await provider.exchangeClientCredentials(clientId, clientSecret!, 'read write');
    const authInfo = await provider.verifyAccessToken(tokens.access_token);

    expect((authInfo as any).principalId).toBe(principalId);
    expect((authInfo as any).principalKind).toBe(kindId);
    // Capability set is identical in shape/content to the unattributed case —
    // attribution changed WHO is on record, not WHAT the client can do.
    expect(authInfo.scopes).toContain('read');
    expect(authInfo.scopes).toContain('write');
  });

  test('#1/#6: two clients with different Principal kinds and identical scope get identical authorization results', async () => {
    const [{ id: humanPrincipal }] = await sql`INSERT INTO principals (kind_id) VALUES ('human') RETURNING id`;
    const [{ id: agentPrincipal }] = await sql`INSERT INTO principals (kind_id) VALUES ('agent') RETURNING id`;
    const [{ id: unknownKindPrincipal }] = await sql`INSERT INTO principals (kind_id) VALUES ('unknown') RETURNING id`;

    const clients = await Promise.all(
      [
        ['kind-cmp-human', humanPrincipal],
        ['kind-cmp-agent', agentPrincipal],
        ['kind-cmp-unknown', unknownKindPrincipal],
      ].map(async ([name, principalId]) => {
        const { clientId, clientSecret } = await provider.registerClientManual(
          name as string, ['client_credentials'], 'read',
        );
        await sql`UPDATE oauth_clients SET principal_id = ${principalId} WHERE client_id = ${clientId}`;
        const tokens = await provider.exchangeClientCredentials(clientId, clientSecret!, 'read');
        return provider.verifyAccessToken(tokens.access_token);
      }),
    );

    const authResults = clients.map((a) => hasScope(a.scopes, 'read'));
    expect(authResults).toEqual([true, true, true]);
    // And all three are equally denied a scope none of them were granted.
    const deniedResults = clients.map((a) => hasScope(a.scopes, 'admin'));
    expect(deniedResults).toEqual([false, false, false]);
  });

  test('#4: Principal.revoked_at set does not change the Client\'s authentication/authorization result (Phase 9B: not wired to Policy Decision)', async () => {
    const [{ id: principalId }] = await sql`INSERT INTO principals (kind_id, display_name) VALUES ('human', 'will-be-revoked') RETURNING id`;
    const { clientId, clientSecret } = await provider.registerClientManual(
      'revoked-principal-test', ['client_credentials'], 'read write',
    );
    await sql`UPDATE oauth_clients SET principal_id = ${principalId} WHERE client_id = ${clientId}`;

    const beforeTokens = await provider.exchangeClientCredentials(clientId, clientSecret!, 'read write');
    const beforeAuth = await provider.verifyAccessToken(beforeTokens.access_token);

    await sql`UPDATE principals SET revoked_at = now() WHERE id = ${principalId}`;

    // Re-verify the SAME already-issued token, and also issue + verify a NEW
    // token, after the Principal (not the Client/token) was revoked.
    const afterAuthSameToken = await provider.verifyAccessToken(beforeTokens.access_token);
    const afterTokens = await provider.exchangeClientCredentials(clientId, clientSecret!, 'read write');
    const afterAuthNewToken = await provider.verifyAccessToken(afterTokens.access_token);

    expect(afterAuthSameToken.scopes.sort()).toEqual(beforeAuth.scopes.sort());
    expect(afterAuthNewToken.scopes.sort()).toEqual(beforeAuth.scopes.sort());
    expect(hasScope(afterAuthSameToken.scopes, 'read')).toBe(true);
    expect(hasScope(afterAuthNewToken.scopes, 'write')).toBe(true);
  });
});
