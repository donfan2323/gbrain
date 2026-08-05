/**
 * Subagent brain-tool registry tests. Covers:
 *   - every allow-list name exists in OPERATIONS (catches renames upstream)
 *   - Anthropic tool-name constraint enforced
 *   - put_page schema is namespace-wrapped per subagent
 *   - execute() invokes the op handler with viaSubagent=true + subagentId
 *   - filterAllowedTools narrows registry + rejects unknown names
 *   - denied ops (file_upload etc.) do NOT appear in the registry
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, OperationError } from '../src/core/operations.ts';
import {
  BRAIN_TOOL_ALLOWLIST,
  buildBrainTools,
  filterAllowedTools,
  __testing,
} from '../src/core/minions/tools/brain-allowlist.ts';
import type { GBrainConfig } from '../src/core/config.ts';
import type { ToolCtx } from '../src/core/minions/types.ts';

let engine: PGLiteEngine;
const config: GBrainConfig = { engine: 'pglite' } as GBrainConfig;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
}, 60_000); // OAuth v25 + full migration chain needs breathing room

afterAll(async () => {
  if (engine) await engine.disconnect();
}, 60_000);

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM pages');
  // Phase 9E-2d: fixtures below seed oauth_clients rows per test (Case J
  // isolation requirement) — wipe both tables so a client_id reused across
  // tests never inherits a prior test's scope/deleted_at state.
  await engine.executeRaw('DELETE FROM oauth_tokens');
  await engine.executeRaw('DELETE FROM oauth_clients');
});

/** Phase 9E-2d test fixture: seed a minimal oauth_clients row. */
interface SeedDelegatingClientOpts {
  clientId: string;
  scope?: string;
  deleted?: boolean;
}

async function seedDelegatingClient(opts: SeedDelegatingClientOpts): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO oauth_clients
       (client_id, client_name, client_secret_hash, scope, grant_types,
        redirect_uris, token_endpoint_auth_method, created_at, deleted_at)
     VALUES ($1, $1, '', $2, ARRAY['client_credentials'],
             ARRAY[]::text[], 'client_secret_post', now(), $3)`,
    [opts.clientId, opts.scope ?? 'read agent', opts.deleted ? new Date().toISOString() : null],
  );
}

describe('BRAIN_TOOL_ALLOWLIST', () => {
  test('every name exists in src/core/operations.ts OPERATIONS', () => {
    const opNames = new Set(operations.map(o => o.name));
    const missing = [...BRAIN_TOOL_ALLOWLIST].filter(n => !opNames.has(n));
    expect(missing).toEqual([]);
  });

  test('contains the v0.15 read-only 10 + put_page + v0.29 salience pair + v114 list_link_sources', () => {
    // v0.29 added get_recent_salience + find_anomalies (read-only).
    // get_recent_transcripts is deliberately excluded — subagent calls always
    // have ctx.remote=true, and the v0.29 trust gate rejects remote callers.
    // v114 (#1941) added list_link_sources (read-only provenance discovery);
    // the edge-WRITE ops add_link/remove_link stay out (separate trust call).
    // #2778 added add_timeline_entry (write, fenced like put_page via
    // operations.ts:enforceSubagentSlugFence).
    expect(BRAIN_TOOL_ALLOWLIST.size).toBe(15);
    expect(BRAIN_TOOL_ALLOWLIST.has('add_timeline_entry')).toBe(true);
    expect(BRAIN_TOOL_ALLOWLIST.has('query')).toBe(true);
    expect(BRAIN_TOOL_ALLOWLIST.has('search')).toBe(true);
    expect(BRAIN_TOOL_ALLOWLIST.has('get_page')).toBe(true);
    expect(BRAIN_TOOL_ALLOWLIST.has('list_pages')).toBe(true);
    expect(BRAIN_TOOL_ALLOWLIST.has('put_page')).toBe(true);
    expect(BRAIN_TOOL_ALLOWLIST.has('get_recent_salience')).toBe(true);
    expect(BRAIN_TOOL_ALLOWLIST.has('find_anomalies')).toBe(true);
    expect(BRAIN_TOOL_ALLOWLIST.has('list_link_sources')).toBe(true);
    expect(BRAIN_TOOL_ALLOWLIST.has('add_link')).toBe(false);
    expect(BRAIN_TOOL_ALLOWLIST.has('remove_link')).toBe(false);
    expect(BRAIN_TOOL_ALLOWLIST.has('get_recent_transcripts')).toBe(false);
  });

  test('does NOT contain destructive ops', () => {
    expect(BRAIN_TOOL_ALLOWLIST.has('file_upload')).toBe(false);
    expect(BRAIN_TOOL_ALLOWLIST.has('delete_page')).toBe(false);
    expect(BRAIN_TOOL_ALLOWLIST.has('delete_file')).toBe(false);
    expect(BRAIN_TOOL_ALLOWLIST.has('sync')).toBe(false);
  });
});

describe('buildBrainTools', () => {
  test('produces one ToolDef per allow-listed op that exists in operations.ts', () => {
    const tools = buildBrainTools({ subagentId: 42, engine, config });
    const opNames = new Set(operations.map(o => o.name));
    const expected = [...BRAIN_TOOL_ALLOWLIST].filter(n => opNames.has(n)).length;
    expect(tools.length).toBe(expected);
  });

  test('tool names are brain_<op> and match Anthropic constraint', () => {
    const tools = buildBrainTools({ subagentId: 7, engine, config });
    for (const t of tools) {
      expect(t.name).toMatch(__testing.ANTHROPIC_NAME_RE);
      expect(t.name.startsWith('brain_')).toBe(true);
    }
  });

  test('tools are flagged idempotent in v0.15', () => {
    const tools = buildBrainTools({ subagentId: 1, engine, config });
    expect(tools.every(t => t.idempotent === true)).toBe(true);
  });

  test('tools carry the op description verbatim', () => {
    const tools = buildBrainTools({ subagentId: 1, engine, config });
    const getPage = tools.find(t => t.name === 'brain_get_page');
    const op = operations.find(o => o.name === 'get_page');
    expect(getPage?.description).toBe(op!.description);
  });

  test('put_page schema is namespace-wrapped per subagent', () => {
    const tools42 = buildBrainTools({ subagentId: 42, engine, config });
    const putPage42 = tools42.find(t => t.name === 'brain_put_page');
    const slug42 = ((putPage42!.input_schema as any).properties as any).slug;
    expect(slug42.pattern).toBe('^wiki/agents/42/.+');
    expect(slug42.description).toContain('wiki/agents/42/');

    const tools7 = buildBrainTools({ subagentId: 7, engine, config });
    const putPage7 = tools7.find(t => t.name === 'brain_put_page');
    const slug7 = ((putPage7!.input_schema as any).properties as any).slug;
    expect(slug7.pattern).toBe('^wiki/agents/7/.+');
  });

  test('non-put_page tools do NOT get a pattern on slug', () => {
    const tools = buildBrainTools({ subagentId: 42, engine, config });
    const getPage = tools.find(t => t.name === 'brain_get_page');
    const slug = ((getPage!.input_schema as any).properties as any).slug;
    expect(slug).toBeDefined();
    expect(slug.pattern).toBeUndefined();
  });

  test('execute() on put_page with valid namespace slug succeeds', async () => {
    const tools = buildBrainTools({ subagentId: 42, engine, config });
    const putPage = tools.find(t => t.name === 'brain_put_page');
    const ctx: ToolCtx = { engine, jobId: 1, remote: true };
    const res = await putPage!.execute(
      { slug: 'wiki/agents/42/notes', content: '---\ntitle: Notes\n---\nbody' },
      ctx,
    );
    expect(res).toBeTruthy();
  });

  test('execute() on put_page with out-of-namespace slug throws permission_denied', async () => {
    const tools = buildBrainTools({ subagentId: 42, engine, config });
    const putPage = tools.find(t => t.name === 'brain_put_page');
    const ctx: ToolCtx = { engine, jobId: 1, remote: true };
    await expect(
      putPage!.execute(
        { slug: 'wiki/analysis/stomp', content: '---\ntitle: x\n---\nb' },
        ctx,
      ),
    ).rejects.toBeInstanceOf(OperationError);
  });

  // #1586: sourceId threads through buildBrainTools → buildOpContext →
  // put_page → importFromContent, so subagent writes land in the cycle's
  // resolved source instead of the hardcoded 'default'.
  test('execute() on put_page writes to the configured sourceId (#1586)', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config, archived, created_at)
       VALUES ('mybrain', 'My Brain', '/tmp/mybrain', '{}'::jsonb, false, now())
       ON CONFLICT (id) DO NOTHING`,
    );
    const tools = buildBrainTools({
      subagentId: 42,
      engine,
      config,
      allowedSlugPrefixes: ['wiki/personal/reflections/*'],
      sourceId: 'mybrain',
    });
    const putPage = tools.find(t => t.name === 'brain_put_page');
    const ctx: ToolCtx = { engine, jobId: 1, remote: true };
    await putPage!.execute(
      { slug: 'wiki/personal/reflections/2026-07-17-scoped', content: '---\ntitle: Scoped\n---\nbody' },
      ctx,
    );
    const rows = await engine.executeRaw<{ source_id: string }>(
      `SELECT source_id FROM pages WHERE slug = 'wiki/personal/reflections/2026-07-17-scoped'`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0].source_id).toBe('mybrain');
  });

  test('buildBrainTools rejects a malformed sourceId at build time (#1586)', () => {
    expect(() =>
      buildBrainTools({ subagentId: 1, engine, config, sourceId: '../evil' }),
    ).toThrow();
  });
});

describe('filterAllowedTools', () => {
  test('passes prefixed names through', () => {
    const tools = buildBrainTools({ subagentId: 1, engine, config });
    const filtered = filterAllowedTools(tools, ['brain_get_page', 'brain_search']);
    expect(filtered.map(t => t.name)).toEqual(['brain_get_page', 'brain_search']);
  });

  test('accepts un-prefixed names as a convenience', () => {
    const tools = buildBrainTools({ subagentId: 1, engine, config });
    const filtered = filterAllowedTools(tools, ['get_page', 'search']);
    expect(filtered.map(t => t.name)).toEqual(['brain_get_page', 'brain_search']);
  });

  test('rejects unknown tool names (no silent ignore)', () => {
    const tools = buildBrainTools({ subagentId: 1, engine, config });
    expect(() => filterAllowedTools(tools, ['brain_typo_nope'])).toThrow(/unknown tool/);
  });

  test('deduplicates when both prefixed + unprefixed given', () => {
    const tools = buildBrainTools({ subagentId: 1, engine, config });
    const filtered = filterAllowedTools(tools, ['brain_get_page', 'get_page']);
    expect(filtered.length).toBe(1);
  });

  test('empty array yields empty registry', () => {
    const tools = buildBrainTools({ subagentId: 1, engine, config });
    expect(filterAllowedTools(tools, [])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Phase 9E-2d (dashboard-2i56j, AUTHZ-INV-005/006/010/013): delegated tool
// execution must go through authorizeOperation() using the OWNER CLIENT's
// CURRENT scope (re-resolved from DB at exercise time), not a static grant-
// time snapshot. Gate only activates when ownerClientId is supplied — cycle/
// dream's non-delegated child jobs never set it (Case H), so their existing
// behavior is untouched by design (see PHASE9E-IMPLEMENTATION-SCOPE.md §... /
// AUTHZ-INV-010 "protocol adapters cannot bypass the authorization core").
// ---------------------------------------------------------------------------
describe('delegated tool execution authorization (Phase 9E-2d, AUTHZ-INV-005/006/010/013)', () => {
  test('[Case A] valid owner client + sufficient scope + explicit source/slug binding -> succeeds via authorizeOperation()', async () => {
    await seedDelegatingClient({ clientId: 'agent-a', scope: 'write agent' });
    const tools = buildBrainTools({
      subagentId: 1, engine, config, ownerClientId: 'agent-a',
      allowedSlugPrefixes: ['wiki/personal/*'], sourceId: 'default',
    });
    const putPage = tools.find(t => t.name === 'brain_put_page')!;
    const ctx: ToolCtx = { engine, jobId: 501, remote: true };
    const res = await putPage.execute(
      { slug: 'wiki/personal/case-a', content: '---\ntitle: A\n---\nbody' },
      ctx,
    );
    expect(res).toBeTruthy();
  });

  test('[Case B] owner client not found in DB -> fail-closed, tool body not executed', async () => {
    const tools = buildBrainTools({ subagentId: 1, engine, config, ownerClientId: 'ghost-client' });
    const putPage = tools.find(t => t.name === 'brain_put_page')!;
    const ctx: ToolCtx = { engine, jobId: 502, remote: true };
    await expect(
      putPage.execute({ slug: 'wiki/agents/1/x', content: '---\ntitle: x\n---\nb' }, ctx),
    ).rejects.toBeInstanceOf(OperationError);
    const rows = await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM pages WHERE slug = 'wiki/agents/1/x'`,
    );
    expect(rows[0].n).toBe(0);
  });

  test('[Case C] owner client soft-deleted -> exercise-time deny, static job payload alone is not trusted', async () => {
    await seedDelegatingClient({ clientId: 'agent-c-revoked', scope: 'write agent', deleted: true });
    const tools = buildBrainTools({ subagentId: 1, engine, config, ownerClientId: 'agent-c-revoked' });
    const putPage = tools.find(t => t.name === 'brain_put_page')!;
    const ctx: ToolCtx = { engine, jobId: 503, remote: true };
    await expect(
      putPage.execute({ slug: 'wiki/agents/1/x', content: '---\ntitle: x\n---\nb' }, ctx),
    ).rejects.toBeInstanceOf(OperationError);
  });

  test('[Case D] owner client scope no longer covers the tool -> authorizeOperation() denies, tool body not executed', async () => {
    await seedDelegatingClient({ clientId: 'agent-d', scope: 'read agent' }); // no write
    const tools = buildBrainTools({ subagentId: 1, engine, config, ownerClientId: 'agent-d' });
    const putPage = tools.find(t => t.name === 'brain_put_page')!;
    const ctx: ToolCtx = { engine, jobId: 504, remote: true };
    await expect(
      putPage.execute({ slug: 'wiki/agents/1/x', content: '---\ntitle: x\n---\nb' }, ctx),
    ).rejects.toBeInstanceOf(OperationError);
    const rows = await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM pages WHERE slug = 'wiki/agents/1/x'`,
    );
    expect(rows[0].n).toBe(0);
  });

  test('[Case D variant] admin-scoped tool (file_list) denied for an owner client with no admin scope', async () => {
    await seedDelegatingClient({ clientId: 'agent-d2', scope: 'write agent' }); // no admin
    const tools = buildBrainTools({ subagentId: 1, engine, config, ownerClientId: 'agent-d2' });
    const fileList = tools.find(t => t.name === 'brain_file_list')!;
    const ctx: ToolCtx = { engine, jobId: 505, remote: true };
    await expect(fileList.execute({}, ctx)).rejects.toBeInstanceOf(OperationError);
  });

  test('[Case E] source scoping is unchanged by the new authz gate — no implicit default, still writes to the job-scoped sourceId', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config, archived, created_at)
       VALUES ('case-e-source', 'Case E', '/tmp/case-e', '{}'::jsonb, false, now())
       ON CONFLICT (id) DO NOTHING`,
    );
    await seedDelegatingClient({ clientId: 'agent-e', scope: 'write agent' });
    const tools = buildBrainTools({
      subagentId: 1, engine, config, ownerClientId: 'agent-e',
      allowedSlugPrefixes: ['wiki/personal/*'], sourceId: 'case-e-source',
    });
    const putPage = tools.find(t => t.name === 'brain_put_page')!;
    const ctx: ToolCtx = { engine, jobId: 506, remote: true };
    await putPage.execute(
      { slug: 'wiki/personal/case-e', content: '---\ntitle: E\n---\nbody' },
      ctx,
    );
    const rows = await engine.executeRaw<{ source_id: string }>(
      `SELECT source_id FROM pages WHERE slug = 'wiki/personal/case-e'`,
    );
    expect(rows[0].source_id).toBe('case-e-source');
  });

  test('[Case F] slug-prefix fence still rejects out-of-bound writes even with a valid delegated auth context (no double-judgment conflict)', async () => {
    await seedDelegatingClient({ clientId: 'agent-f', scope: 'write agent' });
    const tools = buildBrainTools({
      subagentId: 1, engine, config, ownerClientId: 'agent-f',
      allowedSlugPrefixes: ['wiki/personal/*'],
    });
    const putPage = tools.find(t => t.name === 'brain_put_page')!;
    const ctx: ToolCtx = { engine, jobId: 507, remote: true };
    await expect(
      putPage.execute({ slug: 'wiki/forbidden/x', content: '---\ntitle: x\n---\nb' }, ctx),
    ).rejects.toBeInstanceOf(OperationError);
  });

  test('[Case G] a tool outside grant-time allowed_tools is unreachable regardless of the owner client\'s scope', async () => {
    await seedDelegatingClient({ clientId: 'agent-g', scope: 'admin agent' }); // full scope
    const tools = buildBrainTools({ subagentId: 1, engine, config, ownerClientId: 'agent-g' });
    const filtered = filterAllowedTools(tools, ['get_page']); // grant-time only allowed get_page
    expect(filtered.find(t => t.name === 'brain_put_page')).toBeUndefined();
  });

  test('[Case H] ownerClientId unset (cycle/dream non-delegated path) -> authz gate is skipped, existing behavior unchanged', async () => {
    // No oauth_clients row seeded at all — if the gate ran unconditionally,
    // this would fail-closed. It must not: cycle.ts's child jobs never set
    // ownerClientId and must keep working exactly as before Phase 9E-2d.
    const tools = buildBrainTools({
      subagentId: 1, engine, config,
      allowedSlugPrefixes: ['wiki/personal/*'],
    });
    const putPage = tools.find(t => t.name === 'brain_put_page')!;
    const ctx: ToolCtx = { engine, jobId: 508, remote: true };
    const res = await putPage.execute(
      { slug: 'wiki/personal/case-h', content: '---\ntitle: H\n---\nbody' },
      ctx,
    );
    expect(res).toBeTruthy();
  });

  test('[Case I] deny audit event records the actual denial with reason_code + correlation_id', async () => {
    await seedDelegatingClient({ clientId: 'agent-i', scope: 'read agent' }); // no write
    const tools = buildBrainTools({ subagentId: 1, engine, config, ownerClientId: 'agent-i' });
    const putPage = tools.find(t => t.name === 'brain_put_page')!;
    const ctx: ToolCtx = { engine, jobId: 509, remote: true };
    await expect(
      putPage.execute({ slug: 'wiki/agents/1/x', content: '---\ntitle: x\n---\nb' }, ctx),
    ).rejects.toBeInstanceOf(OperationError);
    const rows = await engine.executeRaw<Record<string, unknown>>(
      `SELECT decision, outcome, reason_code, client_id, correlation_id FROM audit_events
        WHERE client_id = $1 ORDER BY recorded_at DESC LIMIT 1`,
      ['agent-i'],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].decision).toBe('denied');
    expect(rows[0].outcome).toBe('rejected');
    expect(rows[0].reason_code).toBe('insufficient_scope');
    expect(rows[0].correlation_id).toBeTruthy();
  });

  test('[Case J] test isolation: a client_id seeded fresh (not deleted) in a later test is not tainted by an earlier test that soft-deleted the same id', async () => {
    // beforeEach wipes oauth_clients entirely — a fresh valid seed of the
    // SAME id Case C soft-deleted must succeed here, proving no leakage.
    await seedDelegatingClient({ clientId: 'agent-c-revoked', scope: 'write agent' }); // NOT deleted this time
    const tools = buildBrainTools({
      subagentId: 1, engine, config, ownerClientId: 'agent-c-revoked',
      allowedSlugPrefixes: ['wiki/personal/*'],
    });
    const putPage = tools.find(t => t.name === 'brain_put_page')!;
    const ctx: ToolCtx = { engine, jobId: 510, remote: true };
    const res = await putPage.execute(
      { slug: 'wiki/personal/case-j', content: '---\ntitle: J\n---\nbody' },
      ctx,
    );
    expect(res).toBeTruthy();
  });
});

describe('sanitizeToolName', () => {
  test('returns within 64 chars', () => {
    // Synthetic: simulate an op name long enough to need slicing.
    const long = 'a'.repeat(100);
    expect(__testing.sanitizeToolName(long).length).toBeLessThanOrEqual(64);
  });

  test('replaces non-conforming chars with _', () => {
    expect(__testing.sanitizeToolName('foo.bar')).toBe('brain_foo_bar');
  });
});
