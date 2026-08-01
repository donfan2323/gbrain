/**
 * Phase 9B (REQUIRED-3 remediation) — full authorization-invariance matrix.
 *
 * External review required comparing, for the SAME scope, every combination
 * of: Principal state (principal_id=null, each of the 5 seeded kinds, a
 * runtime-added kind, and a revoked_at-set Principal) x scope/operation
 * (read scope, write scope incl. delete, agent scope with/without kind
 * match), going through the real authorization boundary rather than
 * hasScope() alone.
 *
 * `src/mcp/dispatch.ts`'s `dispatchToolCall()` performs NO scope enforcement
 * of its own (verified: no hasScope/requiredScope/ctx.auth references in
 * that file). The actual production gate is the explicit
 * `hasScope(authInfo.scopes, op.scope || 'read')` check that
 * `src/commands/serve-http.ts`'s CallToolRequestSchema handler runs
 * immediately BEFORE calling dispatchToolCall, denying with
 * `insufficient_scope` and never invoking the handler when it fails.
 * serve-http.ts is out of Phase 9B's editable scope, so `callThroughBoundary`
 * below reproduces that exact two-step sequence (gate, then dispatch) rather
 * than importing it, and every test in this file goes through it — never
 * calling hasScope() or dispatchToolCall() directly as a standalone check.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { dispatchToolCall, type ToolResult } from '../src/mcp/dispatch.ts';
import { operations, type AuthInfo } from '../src/core/operations.ts';
import { hasScope } from '../src/core/scope.ts';

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

/** Reproduces serve-http.ts's real two-step authorization boundary:
 * op lookup -> hasScope(authInfo.scopes, op.scope) gate -> dispatchToolCall
 * ONLY if the gate passes. dispatchToolCall is never reached on the denied
 * path, matching production (an insufficient_scope response is returned by
 * serve-http.ts without invoking the handler at all). */
async function callThroughBoundary(
  auth: AuthInfo,
  opName: string,
  params: Record<string, unknown>,
): Promise<BoundaryOutcome> {
  const op = operations.find(o => o.name === opName);
  if (!op) throw new Error(`test fixture references unknown operation: ${opName}`);
  const requiredScope = op.scope || 'read';
  const allowed = hasScope(auth.scopes, requiredScope);
  if (!allowed) return { allowed: false, requiredScope };
  const result = await dispatchToolCall(engine, opName, params, { auth, remote: true, sourceId: 'default' });
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
