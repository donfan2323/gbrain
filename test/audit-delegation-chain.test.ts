/**
 * Phase 9C (Universal Audit Event Integration) — AUTHZ-INV-009 proof:
 * "あるExecution Instanceについて、それがどの委任チェーン(どのPrincipal/
 * Client→どのDelegation→どのExecution Instance)から生じたかを、監査ログ
 * から遡って再構成できなければならない。"
 *
 * Design reference (priority order): PHASE9C-ACCEPTANCE-CRITERIA.md §1-1/
 * §3-8, PHASE9A-AUTHORIZATION-INVARIANTS.md AUTHZ-INV-009.
 *
 * `submit_agent` (src/core/operations.ts) is transport-independent —
 * exercised via `dispatchToolCall()` directly (the same function both
 * `src/commands/serve-http.ts` (HTTP) and `src/mcp/server.ts` (stdio)
 * call), constructing the exact context shape each transport actually
 * builds (confirmed by reading both files): HTTP sets `ctx.auth` from
 * `requireBearerAuth`'s resolved AuthInfo; stdio's `startMcpServer()`
 * NEVER sets `ctx.auth` at all (`remote: true` with no `auth` field).
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import type { AuthInfo } from '../src/core/operations.ts';

let engine: PGLiteEngine;
let provider: GBrainOAuthProvider;
let sql: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<any[]>;
let fixtureCounter = 0;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  sql = async (strings, ...values) => {
    const query = strings.reduce((acc, str, i) => acc + str + (i < values.length ? `$${i + 1}` : ''), '');
    return engine.executeRaw(query, values as unknown[]);
  };
  provider = new GBrainOAuthProvider({ sql, tokenTtl: 60, refreshTtl: 300 });
}, 30_000);

afterAll(async () => {
  await engine.disconnect();
});

async function registerAgentClient(overrides: Partial<{
  boundTools: string[]; boundSourceId: string; boundMaxConcurrent: number; boundSlugPrefixes: string[] | null;
}> = {}): Promise<{ clientId: string; auth: AuthInfo }> {
  fixtureCounter += 1;
  const clientName = `delegation-chain-${fixtureCounter}`;
  const { clientId, clientSecret } = await provider.registerClientManual(
    clientName, ['client_credentials'], 'agent', [], 'default', undefined, undefined,
    {
      boundTools: overrides.boundTools ?? ['search', 'get_page'],
      boundSourceId: overrides.boundSourceId ?? 'default',
      boundMaxConcurrent: overrides.boundMaxConcurrent ?? 5,
      // dashboard-5krlu: distinguish "key not provided" (default to
      // ['agent-notes/'], preserving every pre-existing test's fixture)
      // from "explicitly passed null" (used by the NULL-binding test
      // below — registerClientManual's own `? pgArray(...) : null` only
      // stores a real NULL when this is null/undefined, and an explicit
      // `[]` is truthy in JS so it would NOT produce NULL here).
      boundSlugPrefixes: 'boundSlugPrefixes' in overrides ? (overrides.boundSlugPrefixes ?? undefined) : ['agent-notes/'],
    },
  );
  const tokens = await provider.exchangeClientCredentials(clientId, clientSecret!, 'agent');
  const auth = await provider.verifyAccessToken(tokens.access_token);
  return { clientId, auth };
}

describe('AUTHZ-INV-009: submit_agent over HTTP — a successful delegation is bidirectionally reconstructable from audit_events alone', () => {
  test('job_id -> delegation.grant row, and delegation.grant row -> job_id, both resolve uniquely, using ONLY audit_events', async () => {
    const { clientId, auth } = await registerAgentClient();

    const result = await dispatchToolCall(engine, 'submit_agent', { prompt: 'audit chain test', allowed_tools: ['search'] }, {
      remote: true,
      auth,
      sourceId: auth.sourceId ?? 'default',
      takesHoldersAllowList: ['world'],
    });
    expect(result.isError).not.toBe(true);
    const body = JSON.parse(result.content[0].text);
    const jobId: number = body.id;
    expect(typeof jobId).toBe('number');

    // Forward: job_id -> the audit_events row that granted it.
    const forward = await sql`
      SELECT id, event_kind, client_id, decision, outcome, correlation_id, channel_id
      FROM audit_events WHERE job_id = ${jobId} AND event_kind = 'delegation.grant'
    `;
    expect(forward.length).toBe(1);
    expect(forward[0].client_id).toBe(clientId);
    expect(forward[0].decision).toBe('allowed');
    expect(forward[0].outcome).toBe('succeeded');
    expect(forward[0].channel_id).toBe('mcp_http');

    // Reverse: the delegation.grant row's own job_id column points back
    // to the exact same job — no join through minion_jobs required, the
    // column is directly on the audit_events row.
    const reverse = await sql`SELECT job_id FROM audit_events WHERE id = ${forward[0].id}`;
    expect(reverse[0].job_id).toBe(jobId);

    // This reconstruction used audit_events exclusively — no read from
    // mcp_request_log or the agent-audit.ts JSONL was needed for either
    // direction, which this test's own query set (visibly, above)
    // demonstrates by construction: neither table/file was touched.
  });

  test('the underlying minion_jobs row genuinely exists and matches (sanity: the job_id is real, not a vacuous number)', async () => {
    const { auth } = await registerAgentClient();
    const result = await dispatchToolCall(engine, 'submit_agent', { prompt: 'sanity check' }, {
      remote: true, auth, sourceId: 'default', takesHoldersAllowList: ['world'],
    });
    const jobId = JSON.parse(result.content[0].text).id;
    const jobRows = await sql`SELECT id, name FROM minion_jobs WHERE id = ${jobId}`;
    expect(jobRows.length).toBe(1);
    expect(jobRows[0].name).toBe('subagent');
  });
});

describe('AUTHZ-INV-009: submit_agent over stdio — always denied (no credential concept), and the denial itself is recorded', () => {
  test('a stdio-shaped call (remote:true, auth omitted — exactly what src/mcp/server.ts constructs) is denied with permission_denied', async () => {
    const result = await dispatchToolCall(engine, 'submit_agent', { prompt: 'stdio attempt' }, {
      remote: true,
      // No `auth` field at all — this is the exact shape startMcpServer()
      // in src/mcp/server.ts builds for every stdio tool call.
      sourceId: 'default',
      takesHoldersAllowList: ['world'],
    });
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    const errorType = typeof body.error === 'string' ? body.error : (body.error?.type ?? body.error?.code);
    expect(errorType).toBe('permission_denied');
  });

  test('the stdio denial is recorded as delegation.deny with attribution_state=unauthenticated and channel_id=mcp_stdio', async () => {
    const before = await sql`SELECT count(*)::int AS n FROM audit_events WHERE event_kind = 'delegation.deny' AND channel_id = 'mcp_stdio'`;
    await dispatchToolCall(engine, 'submit_agent', { prompt: 'stdio attempt 2' }, {
      remote: true,
      sourceId: 'default',
      takesHoldersAllowList: ['world'],
    });
    const after = await sql`
      SELECT attribution_state, decision, outcome, reason_code, client_id, principal_id
      FROM audit_events WHERE event_kind = 'delegation.deny' AND channel_id = 'mcp_stdio'
      ORDER BY recorded_at DESC LIMIT 1
    `;
    expect(after.length).toBe(1);
    expect(after[0].attribution_state).toBe('unauthenticated');
    expect(after[0].decision).toBe('denied');
    expect(after[0].outcome).toBe('rejected');
    expect(after[0].reason_code).toBe('no_credential');
    expect(after[0].client_id).toBeNull();
    expect(after[0].principal_id).toBeNull();
  });
});

describe('AUTHZ-INV-009: delegation.grant and delegation.deny are distinguishable event_kinds — success and denial never collapse into one bucket', () => {
  test('a successful submission and a denied submission from the SAME client produce rows with different event_kind values', async () => {
    const { auth } = await registerAgentClient({ boundTools: ['search'] });

    const allowed = await dispatchToolCall(engine, 'submit_agent', { prompt: 'ok', allowed_tools: ['search'] }, {
      remote: true, auth, sourceId: 'default', takesHoldersAllowList: ['world'],
    });
    expect(allowed.isError).not.toBe(true);

    // Request a tool NOT in bound_tools -> denied.
    const denied = await dispatchToolCall(engine, 'submit_agent', { prompt: 'not ok', allowed_tools: ['delete_page'] }, {
      remote: true, auth, sourceId: 'default', takesHoldersAllowList: ['world'],
    });
    expect(denied.isError).toBe(true);

    const rows = await sql`
      SELECT event_kind, decision, reason_code FROM audit_events
      WHERE client_id = ${auth.clientId} ORDER BY recorded_at ASC
    `;
    const kinds = rows.map((r: { event_kind: string }) => r.event_kind);
    expect(kinds).toContain('delegation.grant');
    expect(kinds).toContain('delegation.deny');
    const denyRow = rows.find((r: { event_kind: string }) => r.event_kind === 'delegation.deny');
    expect(denyRow.reason_code).toBe('tool_not_bound');
  });
});

describe('AUTHZ-INV-009: every documented submit_agent denial reason is recorded as delegation.deny with a distinguishing reason_code', () => {
  test('no OAuth client bindings row at all (agent scope granted, but no --bound-* set at registration)', async () => {
    fixtureCounter += 1;
    const clientName = `delegation-chain-nobind-${fixtureCounter}`;
    const { clientId, clientSecret } = await provider.registerClientManual(clientName, ['client_credentials'], 'agent');
    const tokens = await provider.exchangeClientCredentials(clientId, clientSecret!, 'agent');
    const auth = await provider.verifyAccessToken(tokens.access_token);

    const result = await dispatchToolCall(engine, 'submit_agent', { prompt: 'no bindings' }, {
      remote: true, auth, sourceId: 'default', takesHoldersAllowList: ['world'],
    });
    expect(result.isError).toBe(true);

    const rows = await sql`SELECT reason_code FROM audit_events WHERE client_id = ${clientId} AND event_kind = 'delegation.deny' ORDER BY recorded_at DESC LIMIT 1`;
    expect(rows[0].reason_code).toBe('no_bindings');
  });

  test('slug_prefix not under any bound_slug_prefixes', async () => {
    const { auth, clientId } = await registerAgentClient({ boundSlugPrefixes: ['agent-notes/'] });
    const result = await dispatchToolCall(engine, 'submit_agent', { prompt: 'bad slug', allowed_slug_prefixes: ['forbidden-zone/'] }, {
      remote: true, auth, sourceId: 'default', takesHoldersAllowList: ['world'],
    });
    expect(result.isError).toBe(true);
    const rows = await sql`SELECT reason_code FROM audit_events WHERE client_id = ${clientId} AND event_kind = 'delegation.deny' ORDER BY recorded_at DESC LIMIT 1`;
    expect(rows[0].reason_code).toBe('slug_prefix_not_bound');
  });

  test('concurrency cap exceeded (bound_max_concurrent=1, two in-flight submissions)', async () => {
    const { auth, clientId } = await registerAgentClient({ boundMaxConcurrent: 1 });
    const first = await dispatchToolCall(engine, 'submit_agent', { prompt: 'first', queue: 'default' }, {
      remote: true, auth, sourceId: 'default', takesHoldersAllowList: ['world'],
    });
    expect(first.isError).not.toBe(true);

    const second = await dispatchToolCall(engine, 'submit_agent', { prompt: 'second, should be capped', queue: 'default' }, {
      remote: true, auth, sourceId: 'default', takesHoldersAllowList: ['world'],
    });
    expect(second.isError).toBe(true);

    const rows = await sql`SELECT reason_code FROM audit_events WHERE client_id = ${clientId} AND event_kind = 'delegation.deny' ORDER BY recorded_at DESC LIMIT 1`;
    expect(rows[0].reason_code).toBe('concurrency_cap_exceeded');
  });

  // --- dashboard-5krlu: new fail-closed reason_codes, each independently
  // distinguishable in audit_events (requirement: denial reasons must be
  // identifiable from the audit trail alone, not collapsed into one bucket) ---

  test('[dashboard-5krlu] bound_slug_prefixes is NULL but slug prefixes were requested -> reason_code=no_slug_prefix_binding', async () => {
    const { auth, clientId } = await registerAgentClient({ boundSlugPrefixes: null });
    const result = await dispatchToolCall(engine, 'submit_agent', { prompt: 'no binding', allowed_slug_prefixes: ['wiki/*'] }, {
      remote: true, auth, sourceId: 'default', takesHoldersAllowList: ['world'],
    });
    expect(result.isError).toBe(true);
    const rows = await sql`SELECT reason_code FROM audit_events WHERE client_id = ${clientId} AND event_kind = 'delegation.deny' ORDER BY recorded_at DESC LIMIT 1`;
    expect(rows[0].reason_code).toBe('no_slug_prefix_binding');
  });

  test('[dashboard-5krlu] slash-boundary-crossing sibling prefix -> reason_code=slug_prefix_not_bound (distinguishes the fixed fail-open case from the pre-existing one)', async () => {
    const { auth, clientId } = await registerAgentClient({ boundSlugPrefixes: ['agent-notes'] });
    const result = await dispatchToolCall(engine, 'submit_agent', { prompt: 'sibling escape', allowed_slug_prefixes: ['agent-notes-secret/*'] }, {
      remote: true, auth, sourceId: 'default', takesHoldersAllowList: ['world'],
    });
    expect(result.isError).toBe(true);
    const rows = await sql`SELECT reason_code FROM audit_events WHERE client_id = ${clientId} AND event_kind = 'delegation.deny' ORDER BY recorded_at DESC LIMIT 1`;
    expect(rows[0].reason_code).toBe('slug_prefix_not_bound');
  });

  test('[dashboard-5krlu] non-string requested slug prefix element -> reason_code=invalid_slug_prefix_requested', async () => {
    const { auth, clientId } = await registerAgentClient({ boundSlugPrefixes: ['wiki/'] });
    const result = await dispatchToolCall(engine, 'submit_agent', { prompt: 'bad type', allowed_slug_prefixes: [123 as unknown as string] }, {
      remote: true, auth, sourceId: 'default', takesHoldersAllowList: ['world'],
    });
    expect(result.isError).toBe(true);
    const rows = await sql`SELECT reason_code FROM audit_events WHERE client_id = ${clientId} AND event_kind = 'delegation.deny' ORDER BY recorded_at DESC LIMIT 1`;
    expect(rows[0].reason_code).toBe('invalid_slug_prefix_requested');
  });

  test('[dashboard-5krlu] denial audit rows never contain page content or secrets — only client_id/prefix strings/generic text', async () => {
    const { auth, clientId } = await registerAgentClient({ boundSlugPrefixes: ['agent-notes'] });
    await dispatchToolCall(engine, 'submit_agent', {
      prompt: 'a prompt that must never appear in the audit trail: TOP-SECRET-PROMPT-CONTENT-XYZ',
      allowed_slug_prefixes: ['agent-notes-secret/*'],
    }, {
      remote: true, auth, sourceId: 'default', takesHoldersAllowList: ['world'],
    });
    const rows = await sql`SELECT reason_code, error_message FROM audit_events WHERE client_id = ${clientId} AND event_kind = 'delegation.deny' ORDER BY recorded_at DESC LIMIT 1`;
    expect(rows[0].reason_code).toBe('slug_prefix_not_bound');
    expect(String(rows[0].error_message ?? '')).not.toContain('TOP-SECRET-PROMPT-CONTENT-XYZ');
  });
});

// ---- Phase 9E-1 (dashboard-f5jd5): AUTHZ-INV-017 warn-only ---------------
//
// `agent` is a committal-only OAuth scope (does not imply read/write/admin,
// scope.ts's IMPLIES table). A client can be bound to tools its own scopes
// don't cover — AUTHZ-INV-017 (2026-08-03) requires this to be recorded,
// but Phase 9E-1 is explicitly warn-only: the delegation must still
// SUCCEED (job created, decision='allowed'), only the audit trail gains a
// distinguishing reason_code. Enforcement (denial) is Phase 9E-2, not
// implemented here.
describe('AUTHZ-INV-017 (Phase 9E-1, warn-only): delegation_scope_shortfall is recorded but never denies', () => {
  test('scope sufficient (agent+read covers a read-only bound tool) -> delegation.grant with reason_code=null, no shortfall recorded', async () => {
    fixtureCounter += 1;
    const clientName = `scope-shortfall-ok-${fixtureCounter}`;
    const { clientId, clientSecret } = await provider.registerClientManual(
      clientName, ['client_credentials'], 'agent read', [], 'default', undefined, undefined,
      { boundTools: ['search'], boundSourceId: 'default', boundMaxConcurrent: 5 },
    );
    const tokens = await provider.exchangeClientCredentials(clientId, clientSecret!, 'agent read');
    const auth = await provider.verifyAccessToken(tokens.access_token);

    const result = await dispatchToolCall(engine, 'submit_agent', { prompt: 'ok', allowed_tools: ['search'] }, {
      remote: true, auth, sourceId: 'default', takesHoldersAllowList: ['world'],
    });
    expect(result.isError).not.toBe(true);

    const rows = await sql`SELECT decision, outcome, reason_code, params_summary FROM audit_events WHERE client_id = ${clientId} AND event_kind = 'delegation.grant' ORDER BY recorded_at DESC LIMIT 1`;
    expect(rows[0].decision).toBe('allowed');
    expect(rows[0].outcome).toBe('succeeded');
    expect(rows[0].reason_code).toBeNull();
  });

  test('scope insufficient (agent-only client bound to a write tool) -> delegation still SUCCEEDS, delegation.grant carries reason_code=delegation_scope_shortfall', async () => {
    fixtureCounter += 1;
    const clientName = `scope-shortfall-write-${fixtureCounter}`;
    const { clientId, clientSecret } = await provider.registerClientManual(
      clientName, ['client_credentials'], 'agent', [], 'default', undefined, undefined,
      { boundTools: ['put_page'], boundSourceId: 'default', boundSlugPrefixes: ['wiki/'], boundMaxConcurrent: 5 },
    );
    const tokens = await provider.exchangeClientCredentials(clientId, clientSecret!, 'agent');
    const auth = await provider.verifyAccessToken(tokens.access_token);

    const result = await dispatchToolCall(engine, 'submit_agent', { prompt: 'write deleg', allowed_tools: ['put_page'] }, {
      remote: true, auth, sourceId: 'default', takesHoldersAllowList: ['world'],
    });
    // Phase 9E-1 is warn-only: the delegation must still succeed.
    expect(result.isError).not.toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(typeof body.id).toBe('number');

    const rows = await sql`SELECT decision, outcome, reason_code, params_summary FROM audit_events WHERE client_id = ${clientId} AND event_kind = 'delegation.grant' ORDER BY recorded_at DESC LIMIT 1`;
    expect(rows[0].decision).toBe('allowed');
    expect(rows[0].outcome).toBe('succeeded');
    expect(rows[0].reason_code).toBe('delegation_scope_shortfall');
  });

  test('the shortfall detail identifies which tool/scope was missing, without secrets or prompt content', async () => {
    fixtureCounter += 1;
    const clientName = `scope-shortfall-detail-${fixtureCounter}`;
    const { clientId, clientSecret } = await provider.registerClientManual(
      clientName, ['client_credentials'], 'agent', [], 'default', undefined, undefined,
      { boundTools: ['put_page'], boundSourceId: 'default', boundSlugPrefixes: ['wiki/'], boundMaxConcurrent: 5 },
    );
    const tokens = await provider.exchangeClientCredentials(clientId, clientSecret!, 'agent');
    const auth = await provider.verifyAccessToken(tokens.access_token);

    await dispatchToolCall(engine, 'submit_agent', {
      prompt: 'a prompt that must never appear in the audit trail: SCOPE-SHORTFALL-SECRET-XYZ',
      allowed_tools: ['put_page'],
    }, {
      remote: true, auth, sourceId: 'default', takesHoldersAllowList: ['world'],
    });

    const rows = await sql`SELECT params_summary FROM audit_events WHERE client_id = ${clientId} AND event_kind = 'delegation.grant' AND reason_code = 'delegation_scope_shortfall' ORDER BY recorded_at DESC LIMIT 1`;
    expect(rows.length).toBe(1);
    const summary = typeof rows[0].params_summary === 'string' ? JSON.parse(rows[0].params_summary) : rows[0].params_summary;
    const serialized = JSON.stringify(summary);
    expect(serialized).toContain('put_page');
    expect(serialized).toContain('write');
    expect(serialized).not.toContain('SCOPE-SHORTFALL-SECRET-XYZ');
  });

  test('multiple tools with multiple missing scopes are all recorded (not just the first)', async () => {
    fixtureCounter += 1;
    const clientName = `scope-shortfall-multi-${fixtureCounter}`;
    const { clientId, clientSecret } = await provider.registerClientManual(
      clientName, ['client_credentials'], 'agent', [], 'default', undefined, undefined,
      { boundTools: ['put_page', 'search'], boundSourceId: 'default', boundSlugPrefixes: ['wiki/'], boundMaxConcurrent: 5 },
    );
    const tokens = await provider.exchangeClientCredentials(clientId, clientSecret!, 'agent');
    const auth = await provider.verifyAccessToken(tokens.access_token);

    await dispatchToolCall(engine, 'submit_agent', { prompt: 'multi', allowed_tools: ['put_page', 'search'] }, {
      remote: true, auth, sourceId: 'default', takesHoldersAllowList: ['world'],
    });

    const rows = await sql`SELECT params_summary FROM audit_events WHERE client_id = ${clientId} AND event_kind = 'delegation.grant' AND reason_code = 'delegation_scope_shortfall' ORDER BY recorded_at DESC LIMIT 1`;
    expect(rows.length).toBe(1);
    const summary = typeof rows[0].params_summary === 'string' ? JSON.parse(rows[0].params_summary) : rows[0].params_summary;
    const serialized = JSON.stringify(summary);
    // Both put_page (needs write) and search (needs read) are missing from an agent-only client.
    expect(serialized).toContain('put_page');
    expect(serialized).toContain('search');
    expect(serialized).toContain('write');
    expect(serialized).toContain('read');
  });

  test('admin scope covers every bound tool -> no shortfall recorded even for write tools', async () => {
    fixtureCounter += 1;
    const clientName = `scope-shortfall-admin-${fixtureCounter}`;
    const { clientId, clientSecret } = await provider.registerClientManual(
      clientName, ['client_credentials'], 'agent admin', [], 'default', undefined, undefined,
      { boundTools: ['put_page'], boundSourceId: 'default', boundSlugPrefixes: ['wiki/'], boundMaxConcurrent: 5 },
    );
    const tokens = await provider.exchangeClientCredentials(clientId, clientSecret!, 'agent admin');
    const auth = await provider.verifyAccessToken(tokens.access_token);

    await dispatchToolCall(engine, 'submit_agent', { prompt: 'admin ok', allowed_tools: ['put_page'] }, {
      remote: true, auth, sourceId: 'default', takesHoldersAllowList: ['world'],
    });

    const rows = await sql`SELECT reason_code FROM audit_events WHERE client_id = ${clientId} AND event_kind = 'delegation.grant' ORDER BY recorded_at DESC LIMIT 1`;
    expect(rows[0].reason_code).toBeNull();
  });

  test('correlation_id on the shortfall-carrying delegation.grant row matches this submit_agent call\'s own correlation_id (no new correlation_id split introduced)', async () => {
    fixtureCounter += 1;
    const clientName = `scope-shortfall-corr-${fixtureCounter}`;
    const { clientId, clientSecret } = await provider.registerClientManual(
      clientName, ['client_credentials'], 'agent', [], 'default', undefined, undefined,
      { boundTools: ['put_page'], boundSourceId: 'default', boundSlugPrefixes: ['wiki/'], boundMaxConcurrent: 5 },
    );
    const tokens = await provider.exchangeClientCredentials(clientId, clientSecret!, 'agent');
    const auth = await provider.verifyAccessToken(tokens.access_token);

    const result = await dispatchToolCall(engine, 'submit_agent', { prompt: 'corr', allowed_tools: ['put_page'] }, {
      remote: true, auth, sourceId: 'default', takesHoldersAllowList: ['world'],
    });
    const jobId = JSON.parse(result.content[0].text).id;

    const rows = await sql`SELECT correlation_id, job_id FROM audit_events WHERE client_id = ${clientId} AND event_kind = 'delegation.grant' AND reason_code = 'delegation_scope_shortfall' ORDER BY recorded_at DESC LIMIT 1`;
    expect(rows.length).toBe(1);
    expect(rows[0].job_id).toBe(jobId);
    expect(typeof rows[0].correlation_id).toBe('string');
    expect((rows[0].correlation_id as string).length).toBeGreaterThan(0);
  });
});
