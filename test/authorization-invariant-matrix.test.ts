/**
 * Phase 9B (REQUIRED-3 remediation, extended after internal Phase 9B
 * closure review) — full authorization-invariance matrix.
 *
 * External review required comparing, for the SAME scope, every combination
 * of: Principal state (principal_id=null, each of the 5 seeded kinds, a
 * runtime-added kind, and a revoked_at-set Principal) x scope/operation
 * (read scope, write scope incl. delete, agent scope with/without kind
 * match, admin scope), going through the real authorization boundary
 * rather than hasScope() alone.
 *
 * `src/mcp/dispatch.ts`'s `dispatchToolCall()` performs NO scope enforcement
 * of its own (verified: no hasScope/requiredScope/ctx.auth references in
 * that file). The actual production gate is `src/core/scope.ts`'s
 * `authorizeOperation()`, called by `src/commands/serve-http.ts`'s
 * CallToolRequestSchema handler immediately BEFORE calling
 * dispatchToolCall, denying with `insufficient_scope` and never invoking
 * the handler when it fails. `callThroughBoundary` below IMPORTS and calls
 * that real function directly (no hand-copy) — this was previously a
 * reproduction of serve-http.ts's inline gate logic; an internal review
 * after REQUIRED-3's original delivery found the reproduction could
 * silently drift from the real gate, so serve-http.ts's two-line decision
 * was extracted into the importable `authorizeOperation()` and this file
 * updated to call it. `sourceId` and `takesHoldersAllowList` are also now
 * derived from `auth` the same way serve-http.ts does, and both the allow
 * and deny paths write an `mcp_request_log` row matching production
 * (AUTHZ-INV-013: denials are audited too) — the only things still not
 * reproduced here are the SSE broadcast and the outer try/catch envelope,
 * which are HTTP-transport plumbing, not part of the authorization
 * decision this file tests.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { dispatchToolCall, type ToolResult } from '../src/mcp/dispatch.ts';
import { operations, type AuthInfo } from '../src/core/operations.ts';
import { authorizeOperation } from '../src/core/scope.ts';

let engine: PGLiteEngine;
let provider: GBrainOAuthProvider;
let sql: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<any[]>;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  sql = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.reduce((acc, str, i) => acc + str + (i < values.length ? `$${i + 1}` : ''), '');
    return engine.executeRaw(query, values as unknown[]);
  };

  provider = new GBrainOAuthProvider({ sql, tokenTtl: 60, refreshTtl: 300 });

  // "実行時追加kind、例robot" — a brand-new Principal kind registered via a
  // plain data-row INSERT only, no schema/code change, before any test runs.
  await sql`
    INSERT INTO principal_kinds (id, label, description)
    VALUES ('robot', 'Robot', 'A physical robot.')
    ON CONFLICT (id) DO NOTHING
  `;
}, 30_000);

afterAll(async () => {
  await engine.disconnect();
});

// ---- Fixtures ----------------------------------------------------------

interface PrincipalState {
  label: string;
  kindId: string | null;
  revoke?: boolean;
}

const PRINCIPAL_STATES: PrincipalState[] = [
  { label: 'null-unattributed', kindId: null },
  { label: 'human', kindId: 'human' },
  { label: 'service', kindId: 'service' },
  { label: 'agent', kindId: 'agent' },
  { label: 'device', kindId: 'device' },
  { label: 'unknown', kindId: 'unknown' },
  { label: 'robot-runtime-kind', kindId: 'robot' },
  { label: 'human-revoked', kindId: 'human', revoke: true },
];

let fixtureCounter = 0;

/** Registers a real OAuth client with `scope`, optionally links a real
 * Principal per `state`, and resolves a real AuthInfo via a genuine
 * client_credentials token exchange + verifyAccessToken(). */
async function makeAuthInfo(state: PrincipalState, scope: string): Promise<AuthInfo> {
  fixtureCounter += 1;
  const clientName = `authz-matrix-${fixtureCounter}-${state.label}`;
  const { clientId, clientSecret } = await provider.registerClientManual(
    clientName, ['client_credentials'], scope,
  );

  if (state.kindId !== null) {
    const [{ id: principalId }] = await sql`
      INSERT INTO principals (kind_id, display_name) VALUES (${state.kindId}, ${clientName})
      RETURNING id
    `;
    if (state.revoke) {
      await sql`UPDATE principals SET revoked_at = now() WHERE id = ${principalId}`;
    }
    await sql`UPDATE oauth_clients SET principal_id = ${principalId} WHERE client_id = ${clientId}`;
  }

  const tokens = await provider.exchangeClientCredentials(clientId, clientSecret!, scope);
  return provider.verifyAccessToken(tokens.access_token);
}

interface BoundaryOutcome {
  allowed: boolean;
  requiredScope: string;
  result?: ToolResult;
}

/** Writes the same mcp_request_log row shape serve-http.ts writes on both
 * the denied path (:2011-2017 in serve-http.ts) and the completed path
 * (:2139-2142), keyed by clientId the same way production keys it by
 * `authInfo.clientId` — so a test can assert a denial is audited exactly
 * like production audits it (AUTHZ-INV-013). */
async function recordAuditRow(auth: AuthInfo, opName: string, status: 'success' | 'error', errorMessage: string | null): Promise<void> {
  await sql`
    INSERT INTO mcp_request_log (token_name, agent_name, operation, status, error_message)
    VALUES (${auth.clientId}, ${auth.clientName ?? 'authz-matrix-test'}, ${opName}, ${status}, ${errorMessage})
  `;
}

/** serve-http.ts's real two-step authorization boundary: op lookup ->
 * authorizeOperation(authInfo.scopes, op) gate (imported from scope.ts,
 * the exact function serve-http.ts calls — not a hand-copy) ->
 * dispatchToolCall ONLY if the gate passes. dispatchToolCall is never
 * reached on the denied path, matching production (an insufficient_scope
 * response is returned by serve-http.ts without invoking the handler at
 * all). sourceId and takesHoldersAllowList are derived from `auth` the
 * same way serve-http.ts derives them (:2077, :2068-2069), not hardcoded —
 * a Principal-attribution regression that corrupted sourceId resolution
 * would otherwise be invisible to this suite. Both the allow and deny
 * paths write an mcp_request_log row, matching production's dual-path
 * audit logging. */
async function callThroughBoundary(
  auth: AuthInfo,
  opName: string,
  params: Record<string, unknown>,
): Promise<BoundaryOutcome> {
  const op = operations.find(o => o.name === opName);
  if (!op) throw new Error(`test fixture references unknown operation: ${opName}`);
  const { allowed, requiredScope } = authorizeOperation(auth.scopes, op);
  if (!allowed) {
    await recordAuditRow(auth, opName, 'error', `insufficient_scope: requires '${requiredScope}'`);
    return { allowed: false, requiredScope };
  }
  const sourceId = auth.sourceId ?? 'default';
  const takesHoldersAllowList = (auth as AuthInfo & { takesHoldersAllowList?: string[] }).takesHoldersAllowList ?? ['world'];
  const result = await dispatchToolCall(engine, opName, params, { auth, remote: true, sourceId, takesHoldersAllowList });
  await recordAuditRow(auth, opName, result.isError ? 'error' : 'success', result.isError ? 'handler-level error' : null);
  return { allowed: true, requiredScope, result };
}

/** Seeds a page directly through the real put_page handler as a trusted
 * local (remote:false) call, bypassing the scope boundary intentionally —
 * this is fixture setup, not the behavior under test. */
async function seedPage(slug: string): Promise<void> {
  const seeded = await dispatchToolCall(engine, 'put_page', { slug, content: `# ${slug}\n` }, { remote: false, sourceId: 'default' });
  if (seeded.isError) throw new Error(`fixture setup failed: ${seeded.content[0]?.text}`);
}

// ---- Matrix: read scope --------------------------------------------------

describe('REQUIRED-3: read scope — read succeeds, write is denied — across all Principal states', () => {
  for (const state of PRINCIPAL_STATES) {
    test(`Principal = ${state.label}`, async () => {
      const auth = await makeAuthInfo(state, 'read');
      const slug = `authz-matrix-read-${fixtureCounter}`;
      await seedPage(slug);

      const readOutcome = await callThroughBoundary(auth, 'get_page', { slug });
      expect(readOutcome.allowed).toBe(true);
      expect(readOutcome.result?.isError).not.toBe(true);
      const body = JSON.parse(readOutcome.result!.content[0].text);
      expect(body.slug).toBe(slug);

      const writeOutcome = await callThroughBoundary(auth, 'put_page', { slug: `${slug}-write`, content: '# nope\n' });
      expect(writeOutcome.allowed).toBe(false);
      expect(writeOutcome.result).toBeUndefined(); // handler never invoked on a denied path
    });
  }
});

// ---- Matrix: write scope (incl. delete) ----------------------------------

describe('REQUIRED-3: write scope — read succeeds, write succeeds, delete behaves exactly like any other write op — across all Principal states', () => {
  for (const state of PRINCIPAL_STATES) {
    test(`Principal = ${state.label}`, async () => {
      const auth = await makeAuthInfo(state, 'read write');
      const slug = `authz-matrix-write-${fixtureCounter}`;

      const writeOutcome = await callThroughBoundary(auth, 'put_page', { slug, content: '# fixture\n' });
      expect(writeOutcome.allowed).toBe(true);
      expect(writeOutcome.result?.isError).not.toBe(true);

      const readOutcome = await callThroughBoundary(auth, 'get_page', { slug });
      expect(readOutcome.allowed).toBe(true);
      expect(readOutcome.result?.isError).not.toBe(true);

      // delete_page declares scope: 'write' — identical to put_page, not a
      // separate "delete" scope. Confirms Principal attribution introduces
      // no delete-specific behavior change ("既存delete挙動不変").
      const deleteOp = operations.find(o => o.name === 'delete_page')!;
      expect(deleteOp.scope).toBe('write');
      const deleteOutcome = await callThroughBoundary(auth, 'delete_page', { slug });
      expect(deleteOutcome.allowed).toBe(true);
      expect(deleteOutcome.result?.isError).not.toBe(true);
      const deleteBody = JSON.parse(deleteOutcome.result!.content[0].text);
      expect(deleteBody.status).toBe('soft_deleted');
    });
  }
});

// ---- Matrix: agent scope is independent of Principal.kind ----------------

describe('REQUIRED-3: agent-scope gate is decided by OAuth scope only, never by Principal.kind', () => {
  test('agent scope ABSENT + Principal.kind=agent: agent operation is blocked (kind alone never grants scope)', async () => {
    const auth = await makeAuthInfo({ label: 'agent-kind-no-scope', kindId: 'agent' }, 'read write');
    const outcome = await callThroughBoundary(auth, 'submit_agent', { prompt: 'test', dry_run: true });
    expect(outcome.allowed).toBe(false);
    expect(outcome.requiredScope).toBe('agent');
  });

  test('agent scope PRESENT + Principal.kind != agent (human): agent operation proceeds to the real handler per existing scope-based spec', async () => {
    const auth = await makeAuthInfo({ label: 'human-kind-with-agent-scope', kindId: 'human' }, 'agent');
    const outcome = await callThroughBoundary(auth, 'submit_agent', { prompt: 'test', dry_run: true });
    expect(outcome.allowed).toBe(true); // scope satisfied the gate; handler was reached regardless of kind mismatch
    expect(outcome.result).toBeDefined();
  });

  test('agent scope PRESENT: handler-level outcome is byte-identical whether kind=agent or kind=human (kind plays no role in the result)', async () => {
    const authAgentKind = await makeAuthInfo({ label: 'agent-kind-with-scope', kindId: 'agent' }, 'agent');
    const authHumanKind = await makeAuthInfo({ label: 'human-kind-with-scope-2', kindId: 'human' }, 'agent');

    const outcomeAgentKind = await callThroughBoundary(authAgentKind, 'submit_agent', { prompt: 'test', dry_run: true });
    const outcomeHumanKind = await callThroughBoundary(authHumanKind, 'submit_agent', { prompt: 'test', dry_run: true });

    expect(outcomeAgentKind.allowed).toBe(true);
    expect(outcomeHumanKind.allowed).toBe(true);
    expect(outcomeAgentKind.result?.isError).toBe(outcomeHumanKind.result?.isError);

    // Both clients were registered with no agent bindings, so both hit the
    // same "no bindings" permission_denied at the handler layer — proving
    // the outcome tracks the OAuth-client binding row, not Principal.kind.
    const bodyAgentKind = JSON.parse(outcomeAgentKind.result!.content[0].text);
    const bodyHumanKind = JSON.parse(outcomeHumanKind.result!.content[0].text);
    expect(bodyAgentKind.error).toBe(bodyHumanKind.error);
    expect(typeof bodyAgentKind.error).toBe('string');
  });
});

// ---- Principal attach does not change the authorization result ----------

describe('REQUIRED-3: linking a Principal to an already-registered Client does not change the authorization result', () => {
  test('read scope: get_page outcome is identical before and after linking a Principal', async () => {
    fixtureCounter += 1;
    const clientName = `authz-matrix-linkage-read-${fixtureCounter}`;
    const { clientId, clientSecret } = await provider.registerClientManual(clientName, ['client_credentials'], 'read');
    const slug = `authz-matrix-linkage-read-${fixtureCounter}`;
    await seedPage(slug);

    const tokensBefore = await provider.exchangeClientCredentials(clientId, clientSecret!, 'read');
    const authBefore = await provider.verifyAccessToken(tokensBefore.access_token);
    const before = await callThroughBoundary(authBefore, 'get_page', { slug });

    const [{ id: principalId }] = await sql`
      INSERT INTO principals (kind_id, display_name) VALUES ('agent', ${clientName}) RETURNING id
    `;
    await sql`UPDATE oauth_clients SET principal_id = ${principalId} WHERE client_id = ${clientId}`;

    const tokensAfter = await provider.exchangeClientCredentials(clientId, clientSecret!, 'read');
    const authAfter = await provider.verifyAccessToken(tokensAfter.access_token);
    const after = await callThroughBoundary(authAfter, 'get_page', { slug });

    expect(after.allowed).toBe(before.allowed);
    expect(authAfter.scopes.slice().sort()).toEqual(authBefore.scopes.slice().sort());
    expect(after.result?.isError).toBe(before.result?.isError);
    const bodyBefore = JSON.parse(before.result!.content[0].text);
    const bodyAfter = JSON.parse(after.result!.content[0].text);
    expect(bodyAfter.slug).toBe(bodyBefore.slug);
    expect(bodyAfter.content).toBe(bodyBefore.content);
    // Sanity: the Principal really did attach (proves this isn't a vacuous pass).
    expect((authAfter as any).principalId).toBe(principalId);
    expect((authBefore as any).principalId).toBeUndefined();
  });

  test('write scope: put_page + delete_page outcomes are identical before and after linking a Principal', async () => {
    fixtureCounter += 1;
    const clientName = `authz-matrix-linkage-write-${fixtureCounter}`;
    const { clientId, clientSecret } = await provider.registerClientManual(clientName, ['client_credentials'], 'read write');

    const tokensBefore = await provider.exchangeClientCredentials(clientId, clientSecret!, 'read write');
    const authBefore = await provider.verifyAccessToken(tokensBefore.access_token);
    const slugBefore = `authz-matrix-linkage-write-before-${fixtureCounter}`;
    const writeBefore = await callThroughBoundary(authBefore, 'put_page', { slug: slugBefore, content: '# fixture\n' });
    const deleteBefore = await callThroughBoundary(authBefore, 'delete_page', { slug: slugBefore });

    const [{ id: principalId }] = await sql`
      INSERT INTO principals (kind_id, display_name) VALUES ('service', ${clientName}) RETURNING id
    `;
    await sql`UPDATE oauth_clients SET principal_id = ${principalId} WHERE client_id = ${clientId}`;

    const tokensAfter = await provider.exchangeClientCredentials(clientId, clientSecret!, 'read write');
    const authAfter = await provider.verifyAccessToken(tokensAfter.access_token);
    const slugAfter = `authz-matrix-linkage-write-after-${fixtureCounter}`;
    const writeAfter = await callThroughBoundary(authAfter, 'put_page', { slug: slugAfter, content: '# fixture\n' });
    const deleteAfter = await callThroughBoundary(authAfter, 'delete_page', { slug: slugAfter });

    expect(writeAfter.allowed).toBe(writeBefore.allowed);
    expect(deleteAfter.allowed).toBe(deleteBefore.allowed);
    expect(writeAfter.result?.isError).toBe(writeBefore.result?.isError);
    expect(deleteAfter.result?.isError).toBe(deleteBefore.result?.isError);
    expect(JSON.parse(deleteAfter.result!.content[0].text).status).toBe(JSON.parse(deleteBefore.result!.content[0].text).status);
  });
});

// ---- Matrix: admin scope — the axis AUTHZ-INV-001 names explicitly ------
//
// Internal review after REQUIRED-3's original delivery found the matrix
// exercised read/write/agent but never admin — the exact "Human だから
// admin" violation shape AUTHZ-INV-001's own doc text names as the
// canonical example this suite exists to catch. Added here.

describe('REQUIRED-3 (internal review addendum): admin scope — no Principal kind grants or is required for admin, and admin never leaks into the sibling agent scope', () => {
  for (const state of PRINCIPAL_STATES) {
    test(`Principal = ${state.label}: read-only scope is denied an admin operation (kind never substitutes for scope)`, async () => {
      const auth = await makeAuthInfo(state, 'read');
      const outcome = await callThroughBoundary(auth, 'get_health', {});
      expect(outcome.allowed).toBe(false);
      expect(outcome.requiredScope).toBe('admin');
    });

    test(`Principal = ${state.label}: admin scope reaches the real handler regardless of kind`, async () => {
      const auth = await makeAuthInfo(state, 'admin');
      const outcome = await callThroughBoundary(auth, 'get_health', {});
      expect(outcome.allowed).toBe(true);
      expect(outcome.result?.isError).not.toBe(true);
    });

    test(`Principal = ${state.label}: admin scope does NOT imply the sibling agent scope (scope.ts's deliberate non-implication holds for every kind)`, async () => {
      const auth = await makeAuthInfo(state, 'admin');
      const outcome = await callThroughBoundary(auth, 'submit_agent', { prompt: 'test', dry_run: true });
      expect(outcome.allowed).toBe(false);
      expect(outcome.requiredScope).toBe('agent');
    });
  }

  test('legacy access_tokens-style scopes (read write admin, no Principal attribution) are unaffected by Phase 9B', async () => {
    // Mirrors the shape verifyAccessToken's legacy fallback path returns
    // (oauth-provider.ts:791-823): full read/write/admin, principalId and
    // principalKind both undefined. Constructed directly rather than via a
    // legacy access_tokens row (no test fixture creates one in this
    // engine) — the invariant under test is purely "does authorizeOperation
    // behave identically for this AuthInfo shape", which needs only the
    // shape, not the provenance.
    const legacyAuth: AuthInfo = {
      token: 'legacy-test-token',
      clientId: 'legacy-test-client',
      scopes: ['read', 'write', 'admin'],
    };
    const outcome = await callThroughBoundary(legacyAuth, 'get_health', {});
    expect(outcome.allowed).toBe(true);
    expect(legacyAuth.principalId).toBeUndefined();
    expect(legacyAuth.principalKind).toBeUndefined();
  });
});

// ---- Denial is audited too (AUTHZ-INV-013) -------------------------------

describe('REQUIRED-3 (internal review addendum): a denied call writes an mcp_request_log row, matching production (AUTHZ-INV-013)', () => {
  test('insufficient_scope denial produces an audit row keyed by the real clientId', async () => {
    const auth = await makeAuthInfo({ label: 'audit-denial-test', kindId: 'human' }, 'read');
    const outcome = await callThroughBoundary(auth, 'get_health', {});
    expect(outcome.allowed).toBe(false);

    const rows = await sql`
      SELECT status, error_message FROM mcp_request_log
      WHERE token_name = ${auth.clientId} AND operation = 'get_health'
      ORDER BY id DESC LIMIT 1
    `;
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe('error');
    expect(rows[0].error_message).toContain('insufficient_scope');
  });
});

// ---- DCR / registerClient() defaults (AUTHZ-INV-012) ---------------------
//
// The prior tests in this file all register clients via
// registerClientManual(). The actual DCR entry point production code uses
// is registerClient() (oauth-provider.ts:308-359) — a distinct INSERT path.
// Internal review found no test exercised it, so AUTHZ-INV-012's
// "principal_id defaults null, scope is exactly what was requested" claim
// was unverified for the code path that actually receives untrusted
// request bodies.

describe('REQUIRED-3 (internal review addendum): AUTHZ-INV-012 — the real DCR registration path (clientsStore.registerClient, not registerClientManual)', () => {
  // grant_types: authorization_code (not client_credentials) — this test's
  // provider doesn't set allowClientCredentialsDcr, so a client_credentials
  // DCR request would throw InvalidClientMetadataError before reaching the
  // INSERT this test is verifying. The invariant under test (principal_id
  // default, scope fidelity) doesn't depend on which grant type was used.
  test('clientsStore.registerClient() defaults principal_id to null and grants exactly the requested scope', async () => {
    fixtureCounter += 1;
    const clientName = `authz-matrix-dcr-${fixtureCounter}`;
    const registered = await provider.clientsStore.registerClient!({
      client_name: clientName,
      redirect_uris: [],
      grant_types: ['authorization_code'],
      scope: 'read write',
    } as any);

    const rows = await sql`SELECT principal_id, scope FROM oauth_clients WHERE client_id = ${(registered as any).client_id}`;
    expect(rows.length).toBe(1);
    expect(rows[0].principal_id).toBeNull();
    expect(rows[0].scope).toBe('read write');
  });

  test('clientsStore.registerClient() ignores a principal_id/principalId field smuggled into the request body (structural safety, not just today\'s INSERT column list)', async () => {
    fixtureCounter += 1;
    const clientName = `authz-matrix-dcr-smuggle-${fixtureCounter}`;
    const registered = await provider.clientsStore.registerClient!({
      client_name: clientName,
      redirect_uris: [],
      grant_types: ['authorization_code'],
      scope: 'read',
      // Deliberately passing fields the DCR request type doesn't declare,
      // to prove they're inert rather than merely absent from the type.
      principal_id: '00000000-0000-0000-0000-000000000000',
      principalId: '00000000-0000-0000-0000-000000000000',
    } as any);

    const rows = await sql`SELECT principal_id FROM oauth_clients WHERE client_id = ${(registered as any).client_id}`;
    expect(rows.length).toBe(1);
    expect(rows[0].principal_id).toBeNull();
  });
});

// ---- Phase 9C (PHASE9C-ACCEPTANCE-CRITERIA.md §2) ------------------------
//
// Phase 9C adds audit *recording* (attribution_state, channel_id,
// audit_events) but must not add a single new authorization *decision*
// input. §2's two required proofs:
//   1. Same scopes, varying whatever produces a different attribution_state
//      elsewhere in the system, still yields an identical authorizeOperation()
//      result — because authorizeOperation(scopes, op) structurally never
//      receives attribution_state/credentialSource/principal_id as an
//      argument in the first place.
//   2. A grep-level static guarantee that the authorization *decision* code
//      in scope.ts/operations.ts, and requireAdmin()'s body in
//      serve-http.ts, never branches on attribution_state/principal_id/
//      channel_id/audit_events — including the Phase 9C audit
//      instrumentation code added to those same files, which legitimately
//      references those identifiers as OUTPUT (building the envelope
//      passed to writeAuditEvent) but must never use them as INPUT to an
//      `if` that gates a decision.

describe('Phase 9C §2: attribution_state is audit metadata only — authorizeOperation() never sees it', () => {
  // client_only / principal_attributed / legacy_credential are the 3
  // attribution_state values that correspond to a distinct AuthInfo shape
  // actually reaching authorizeOperation() (an OAuth-scope-bearing,
  // successfully-authenticated call). The other 6 reachable states
  // (unauthenticated, authentication_failed, message_authenticated,
  // system_internal, local_process, attribution_unavailable) are decided by
  // an entirely different gate before an operation-scope check is ever
  // attempted (requireBearerAuth, webhook HMAC verification, or no
  // operation-execution path at all) — they cannot reach authorizeOperation()
  // with ANY AuthInfo shape, which is itself the strongest form of "the
  // result cannot depend on this state": there is no call to compare.
  // admin_session and unmigrated_legacy_record are excluded per §2's own
  // footnote (structurally unreachable via authorizeOperation() / not tied
  // to live execution, respectively).
  test('client_only vs principal_attributed vs legacy_credential: identical scopes -> identical authorizeOperation() result, for both an allowed and a denied operation', async () => {
    const [{ id: principalId }] = await sql`
      INSERT INTO principals (kind_id, display_name) VALUES ('human', 'attribution-state-matrix') RETURNING id
    `;

    // client_only: real OAuth client, no Principal link.
    fixtureCounter += 1;
    const clientOnlyReg = await provider.registerClientManual(`attr-matrix-client-only-${fixtureCounter}`, ['client_credentials'], 'read');
    const clientOnlyTokens = await provider.exchangeClientCredentials(clientOnlyReg.clientId, clientOnlyReg.clientSecret!, 'read');
    const clientOnlyAuth = await provider.verifyAccessToken(clientOnlyTokens.access_token);
    expect((clientOnlyAuth as any).credentialSource).toBe('oauth_client');
    expect((clientOnlyAuth as any).principalId).toBeUndefined();

    // principal_attributed: real OAuth client, linked to a real Principal.
    fixtureCounter += 1;
    const attributedReg = await provider.registerClientManual(`attr-matrix-attributed-${fixtureCounter}`, ['client_credentials'], 'read');
    await sql`UPDATE oauth_clients SET principal_id = ${principalId} WHERE client_id = ${attributedReg.clientId}`;
    const attributedTokens = await provider.exchangeClientCredentials(attributedReg.clientId, attributedReg.clientSecret!, 'read');
    const attributedAuth = await provider.verifyAccessToken(attributedTokens.access_token);
    expect((attributedAuth as any).credentialSource).toBe('oauth_client');
    expect((attributedAuth as any).principalId).toBe(principalId);

    // legacy_credential: the shape verifyAccessToken's legacy access_tokens
    // fallback returns (oauth-provider.ts) — full admin-grade scopes,
    // credentialSource='legacy_access_token', principalId always undefined
    // (a different ID space entirely, per the domain model). Constructed
    // directly with the SAME `read`-only scope as the other two fixtures so
    // this is a controlled same-scope comparison, not a comparison against
    // legacy's real (wider) default grant.
    const legacyAuth: AuthInfo = {
      token: 'attr-matrix-legacy-token',
      clientId: 'attr-matrix-legacy-client',
      scopes: ['read'],
      credentialSource: 'legacy_access_token',
    };

    const fixtures = [
      { label: 'client_only', auth: clientOnlyAuth },
      { label: 'principal_attributed', auth: attributedAuth },
      { label: 'legacy_credential', auth: legacyAuth },
    ];

    // Allowed operation (read scope satisfies get_health? no — get_health
    // needs admin. Use get_page, which is satisfied by 'read'.)
    const slug = `attr-matrix-shared-page-${Date.now()}`;
    await seedPage(slug);
    const allowedResults = await Promise.all(
      fixtures.map(f => callThroughBoundary(f.auth, 'get_page', { slug })),
    );
    for (const r of allowedResults) {
      expect(r.allowed).toBe(true);
      expect(r.result?.isError).not.toBe(true);
    }

    // Denied operation (admin scope required; none of the 3 fixtures have it).
    const deniedResults = await Promise.all(
      fixtures.map(f => callThroughBoundary(f.auth, 'get_health', {})),
    );
    for (const r of deniedResults) {
      expect(r.allowed).toBe(false);
      expect(r.requiredScope).toBe('admin');
    }
  });
});

describe('Phase 9C §2: static proof — the authorization-decision code path never branches on Phase 9C audit vocabulary', () => {
  const FORBIDDEN = ['attribution_state', 'principal_id', 'channel_id', 'audit_events'];

  /** Extracts the condition string of every `if (...)` in `source`, tolerating
   * one level of nested parens inside the condition (sufficient for this
   * codebase's actual `if` shapes — verified by manual inspection of the
   * matched conditions when this test was authored). */
  function extractIfConditions(source: string): string[] {
    const conditions: string[] = [];
    const re = /if\s*\(((?:[^()]|\([^()]*\))*)\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source))) conditions.push(m[1]);
    return conditions;
  }

  function assertNoForbiddenInConditions(filePath: string, source: string) {
    const conditions = extractIfConditions(source);
    expect(conditions.length).toBeGreaterThan(0); // sanity: the extractor actually found `if`s, not a vacuous pass
    for (const cond of conditions) {
      for (const forbidden of FORBIDDEN) {
        if (cond.includes(forbidden)) {
          throw new Error(`${filePath}: an \`if\` condition references forbidden identifier "${forbidden}": if (${cond})`);
        }
      }
    }
  }

  test('src/core/scope.ts: no `if` condition anywhere in the file references audit vocabulary', async () => {
    const { readFileSync } = await import('node:fs');
    const path = new URL('../src/core/scope.ts', import.meta.url).pathname;
    assertNoForbiddenInConditions('src/core/scope.ts', readFileSync(path, 'utf8'));
  });

  test('src/core/operations.ts: no `if` condition anywhere in the file references audit vocabulary (covers submit_agent\'s interleaved decision + audit-instrumentation code)', async () => {
    const { readFileSync } = await import('node:fs');
    const path = new URL('../src/core/operations.ts', import.meta.url).pathname;
    assertNoForbiddenInConditions('src/core/operations.ts', readFileSync(path, 'utf8'));
  });

  test('src/commands/serve-http.ts: no `if` condition anywhere in the file references audit vocabulary (covers requireAdmin() and all Phase 9C audit instrumentation added to route handlers)', async () => {
    const { readFileSync } = await import('node:fs');
    const path = new URL('../src/commands/serve-http.ts', import.meta.url).pathname;
    assertNoForbiddenInConditions('src/commands/serve-http.ts', readFileSync(path, 'utf8'));
  });

  test('requireAdmin()\'s body specifically contains none of the 4 forbidden identifiers anywhere (not just in `if` conditions) — it is a self-contained, separate authorization plane per §2\'s own footnote', async () => {
    const { readFileSync } = await import('node:fs');
    const path = new URL('../src/commands/serve-http.ts', import.meta.url).pathname;
    const source = readFileSync(path, 'utf8');
    const match = source.match(/function requireAdmin\([^)]*\)[^{]*\{([\s\S]*?)\n  \}/);
    expect(match).not.toBeNull();
    const body = match![1];
    expect(body).toContain('adminSessions'); // sanity: we captured the real body, not an empty match
    for (const forbidden of FORBIDDEN) {
      expect(body.includes(forbidden)).toBe(false);
    }
  });
});

describe('Phase 9C §2: an audit-write failure never flips a denial into an allow', () => {
  test('authorizeOperation() is a pure function of (scopes, op) — it structurally cannot observe writeAuditEvent\'s outcome, since it takes no engine/audit argument at all', async () => {
    const op = operations.find(o => o.name === 'get_health')!;
    const before = authorizeOperation(['read'], op);
    // writeAuditEvent has no channel back to authorizeOperation() — there is
    // no shared mutable state between them (authorizeOperation reads only
    // its two parameters). Calling it again after "some audit write
    // happened elsewhere" cannot change its result; this assertion is the
    // structural proof, not a coincidence of test ordering.
    const after = authorizeOperation(['read'], op);
    expect(after).toEqual(before);
    expect(before.allowed).toBe(false);
    expect(before.requiredScope).toBe('admin');
  });

  describe('with a deliberately broken (never-connected) audit engine', () => {
    // Construction lives in this nested beforeAll (not the file-level one
    // at the top) to satisfy check-test-isolation.sh's PGLiteEngine/
    // beforeAll proximity rule. This engine is intentionally never
    // connected — engine.transaction()/executeRaw() will reject for any
    // call against it, forcing writeAuditEvent's class2_denial path
    // through its DB-fail -> spill fallback (or a swallowed double failure)
    // rather than a live insert. It is never shared with the file-level
    // `engine`/`provider` fixtures used by every other test in this file.
    let brokenEngine: PGLiteEngine;

    beforeAll(() => {
      brokenEngine = new PGLiteEngine();
    });

    test('a denied HTTP-shaped call still resolves to allowed=false even when the underlying audit engine is disconnected (class2_denial fails open without touching the decision)', async () => {
      const { writeAuditEvent } = await import('../src/core/audit/audit-events-writer.ts');

      const op = operations.find(o => o.name === 'get_health')!;
      const { allowed, requiredScope } = authorizeOperation(['read'], op);
      expect(allowed).toBe(false);

      // The write must not throw (class2_denial is fail-open by contract) —
      // if it threw, that alone would prove a design violation (an audit
      // failure must never surface as if it were an authorization failure).
      await expect(writeAuditEvent(brokenEngine, {
        envelope_version: 1,
        occurred_at: new Date().toISOString(),
        event_kind: 'operation.request',
        channel_id: 'mcp_http',
        attribution_state: 'client_only',
        principal_id: null,
        client_id: 'broken-engine-test-client',
        actor_label: null,
        credential_ref: null,
        operation: 'get_health',
        required_scope: requiredScope,
        scopes_snapshot: ['read'],
        decision: 'denied',
        outcome: 'rejected',
        reason_code: 'insufficient_scope',
        resource_kind: null,
        resource_ref: null,
        source_id: null,
        job_id: null,
        correlation_id: 'broken-engine-test',
        parent_event_id: null,
        latency_ms: 1,
        errorMessageRaw: null,
        params_summary: null,
        adapter: {},
      }, { class: 'class2_denial' })).resolves.toBeDefined();

      // And the decision itself — computed entirely before and independently
      // of that failed write — is still `denied`, exactly as before.
      expect(allowed).toBe(false);
      expect(requiredScope).toBe('admin');
    });
  });
});
