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
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, OperationError } from '../src/core/operations.ts';
import {
  BRAIN_TOOL_ALLOWLIST,
  buildBrainTools,
  filterAllowedTools,
  __testing,
} from '../src/core/minions/tools/brain-allowlist.ts';
import { withEnv } from './helpers/with-env.ts';
import type { GBrainConfig } from '../src/core/config.ts';
import type { ToolCtx } from '../src/core/minions/types.ts';

let engine: PGLiteEngine;
const config: GBrainConfig = { engine: 'pglite' } as GBrainConfig;
let tmpAuditDir: string;

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
  // Phase 3B-13 fixtures below seed oauth_clients rows per test — wipe so a
  // client_id reused across tests never inherits a prior test's scope/
  // deleted_at state (mirrors submit-agent.test.ts's own isolation need).
  await engine.executeRaw('DELETE FROM oauth_clients');
  tmpAuditDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-allowlist-audit-'));
});

/** Phase 3B-13 (AUTHZ-INV-005/006) test fixture: seed a minimal oauth_clients row. */
interface SeedOwnerClientOpts {
  clientId: string;
  scope?: string;
  deleted?: boolean;
}

async function seedOwnerClient(opts: SeedOwnerClientOpts): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO oauth_clients
       (client_id, client_name, client_secret_hash, scope, grant_types,
        redirect_uris, token_endpoint_auth_method, created_at, deleted_at)
     VALUES ($1, $1, '', $2, ARRAY['client_credentials'],
             ARRAY[]::text[], 'client_secret_post', now(), $3)`,
    [opts.clientId, opts.scope ?? 'read agent', opts.deleted ? new Date().toISOString() : null],
  );
}

/** Read the exercise-time-denial JSONL audit trail written under GBRAIN_AUDIT_DIR. */
function readAuditLines(): Array<Record<string, unknown>> {
  const auditFiles = fs.readdirSync(tmpAuditDir).filter(f => f.startsWith('agent-jobs-'));
  if (auditFiles.length === 0) return [];
  const content = fs.readFileSync(path.join(tmpAuditDir, auditFiles[0]), 'utf8');
  return content.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
}

/** Every execute() call in this describe block must see GBRAIN_AUDIT_DIR. */
async function withAuditDir<T>(fn: () => Promise<T>): Promise<T> {
  return withEnv({ GBRAIN_AUDIT_DIR: tmpAuditDir }, fn);
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
    // Write-through needs a real directory for this source's local_path —
    // put_page now rejects a write whose file can't be written to disk.
    fs.mkdirSync('/tmp/mybrain', { recursive: true });
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
// Phase 3B-13 (AUTHZ-INV-005/006): a delegated (submit_agent-owned) tool
// call must re-authorize against the OWNER CLIENT's CURRENT oauth_clients
// row (scope + deleted_at) at exercise time, not the grant-time snapshot
// baked into the job payload. Gate only activates when ownerClientId is
// supplied — cycle.ts's non-delegated child jobs never set it (Case H), so
// their existing behavior is untouched by design.
// ---------------------------------------------------------------------------
describe('delegated tool execution re-authorization (Phase 3B-13, AUTHZ-INV-005/006)', () => {
  test('[Case A] valid owner client + sufficient scope -> succeeds', async () => {
    await seedOwnerClient({ clientId: 'agent-a', scope: 'write agent' });
    const tools = buildBrainTools({
      subagentId: 1, engine, config, ownerClientId: 'agent-a',
      allowedSlugPrefixes: ['wiki/personal/*'], sourceId: 'default',
    });
    const putPage = tools.find(t => t.name === 'brain_put_page')!;
    const ctx: ToolCtx = { engine, jobId: 601, remote: true };
    const res = await withAuditDir(() => putPage.execute(
      { slug: 'wiki/personal/case-a', content: '---\ntitle: A\n---\nbody' },
      ctx,
    ));
    expect(res).toBeTruthy();
  });

  test('[Case B] owner client not found in DB (e.g. CLI hard-delete) -> fail-closed, tool body not executed', async () => {
    const tools = buildBrainTools({ subagentId: 1, engine, config, ownerClientId: 'ghost-client' });
    const putPage = tools.find(t => t.name === 'brain_put_page')!;
    const ctx: ToolCtx = { engine, jobId: 602, remote: true };
    await expect(withAuditDir(() => putPage.execute(
      { slug: 'wiki/agents/1/case-b', content: '---\ntitle: x\n---\nb' }, ctx,
    ))).rejects.toBeInstanceOf(OperationError);
    const rows = await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM pages WHERE slug = 'wiki/agents/1/case-b'`,
    );
    expect(rows[0].n).toBe(0);
  });

  test('[Case C] owner client soft-deleted (admin revoke) -> exercise-time deny, static job payload alone is not trusted', async () => {
    await seedOwnerClient({ clientId: 'agent-c', scope: 'write agent', deleted: true });
    const tools = buildBrainTools({ subagentId: 1, engine, config, ownerClientId: 'agent-c' });
    const putPage = tools.find(t => t.name === 'brain_put_page')!;
    const ctx: ToolCtx = { engine, jobId: 603, remote: true };
    await expect(withAuditDir(() => putPage.execute(
      { slug: 'wiki/agents/1/case-c', content: '---\ntitle: x\n---\nb' }, ctx,
    ))).rejects.toBeInstanceOf(OperationError);
    const rows = await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM pages WHERE slug = 'wiki/agents/1/case-c'`,
    );
    expect(rows[0].n).toBe(0);
  });

  test('[Case D] owner client scope no longer covers the tool -> denied, tool body not executed', async () => {
    await seedOwnerClient({ clientId: 'agent-d', scope: 'read agent' }); // no write
    const tools = buildBrainTools({ subagentId: 1, engine, config, ownerClientId: 'agent-d' });
    const putPage = tools.find(t => t.name === 'brain_put_page')!;
    const ctx: ToolCtx = { engine, jobId: 604, remote: true };
    await expect(withAuditDir(() => putPage.execute(
      { slug: 'wiki/agents/1/case-d', content: '---\ntitle: x\n---\nb' }, ctx,
    ))).rejects.toBeInstanceOf(OperationError);
    const rows = await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM pages WHERE slug = 'wiki/agents/1/case-d'`,
    );
    expect(rows[0].n).toBe(0);
  });

  test('[Case D2] admin-scoped tool (file_list) denied for an owner client with no admin scope', async () => {
    await seedOwnerClient({ clientId: 'agent-d2', scope: 'write agent' }); // no admin
    const tools = buildBrainTools({ subagentId: 1, engine, config, ownerClientId: 'agent-d2' });
    const fileList = tools.find(t => t.name === 'brain_file_list')!;
    const ctx: ToolCtx = { engine, jobId: 605, remote: true };
    await expect(withAuditDir(() => fileList.execute({}, ctx))).rejects.toBeInstanceOf(OperationError);
  });

  test('[Case E] source scoping is unchanged by the new authz gate — still writes to the job-scoped sourceId', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config, archived, created_at)
       VALUES ('case-e-source', 'Case E', '/tmp/case-e', '{}'::jsonb, false, now())
       ON CONFLICT (id) DO NOTHING`,
    );
    await seedOwnerClient({ clientId: 'agent-e', scope: 'write agent' });
    const tools = buildBrainTools({
      subagentId: 1, engine, config, ownerClientId: 'agent-e',
      allowedSlugPrefixes: ['wiki/personal/*'], sourceId: 'case-e-source',
    });
    const putPage = tools.find(t => t.name === 'brain_put_page')!;
    const ctx: ToolCtx = { engine, jobId: 606, remote: true };
    await withAuditDir(() => putPage.execute(
      { slug: 'wiki/personal/case-e', content: '---\ntitle: E\n---\nbody' }, ctx,
    ));
    const rows = await engine.executeRaw<{ source_id: string }>(
      `SELECT source_id FROM pages WHERE slug = 'wiki/personal/case-e'`,
    );
    expect(rows[0].source_id).toBe('case-e-source');
  });

  test('[Case F] slug-prefix fence still rejects out-of-bound writes even with a valid delegated auth context (no double-judgment conflict)', async () => {
    await seedOwnerClient({ clientId: 'agent-f', scope: 'write agent' });
    const tools = buildBrainTools({
      subagentId: 1, engine, config, ownerClientId: 'agent-f',
      allowedSlugPrefixes: ['wiki/personal/*'],
    });
    const putPage = tools.find(t => t.name === 'brain_put_page')!;
    const ctx: ToolCtx = { engine, jobId: 607, remote: true };
    await expect(withAuditDir(() => putPage.execute(
      { slug: 'wiki/forbidden/x', content: '---\ntitle: x\n---\nb' }, ctx,
    ))).rejects.toBeInstanceOf(OperationError);
  });

  test('[Case G] a tool outside grant-time allowed_tools is unreachable regardless of the owner client\'s scope', async () => {
    await seedOwnerClient({ clientId: 'agent-g', scope: 'admin agent' }); // full scope
    const tools = buildBrainTools({ subagentId: 1, engine, config, ownerClientId: 'agent-g' });
    const filtered = filterAllowedTools(tools, ['get_page']); // grant-time only allowed get_page
    expect(filtered.find(t => t.name === 'brain_put_page')).toBeUndefined();
  });

  test('[Case H] ownerClientId unset (cycle/dream non-delegated path) -> authz gate is skipped, existing behavior unchanged', async () => {
    // No oauth_clients row seeded at all — if the gate ran unconditionally,
    // this would fail-closed. It must not: cycle.ts's child jobs never set
    // ownerClientId and must keep working exactly as before Phase 3B-13.
    const tools = buildBrainTools({
      subagentId: 1, engine, config,
      allowedSlugPrefixes: ['wiki/personal/*'],
    });
    const putPage = tools.find(t => t.name === 'brain_put_page')!;
    const ctx: ToolCtx = { engine, jobId: 608, remote: true };
    const res = await withAuditDir(() => putPage.execute(
      { slug: 'wiki/personal/case-h', content: '---\ntitle: H\n---\nbody' }, ctx,
    ));
    expect(res).toBeTruthy();
  });

  test('[Case I] deny is audited exactly once via the existing agent-audit JSONL stream, with reason_code + job_id', async () => {
    await seedOwnerClient({ clientId: 'agent-i', scope: 'read agent' }); // no write
    const tools = buildBrainTools({ subagentId: 1, engine, config, ownerClientId: 'agent-i' });
    const putPage = tools.find(t => t.name === 'brain_put_page')!;
    const ctx: ToolCtx = { engine, jobId: 609, remote: true };
    await expect(withAuditDir(() => putPage.execute(
      { slug: 'wiki/agents/1/case-i', content: '---\ntitle: x\n---\nb' }, ctx,
    ))).rejects.toBeInstanceOf(OperationError);
    const lines = readAuditLines().filter(l => l.client_id === 'agent-i');
    expect(lines.length).toBe(1);
    expect(lines[0].decision).toBe('denied');
    expect(lines[0].reason_code).toBe('owner_scope_insufficient');
    expect(lines[0].job_id).toBe(609);
  });

  test('[Case J] test isolation: a client_id seeded fresh (not deleted) in a later test is not tainted by an earlier test that soft-deleted the same id', async () => {
    // beforeEach wipes oauth_clients entirely — a fresh valid seed of the
    // SAME id Case C soft-deleted must succeed here, proving no leakage.
    await seedOwnerClient({ clientId: 'agent-c', scope: 'write agent' }); // NOT deleted this time
    const tools = buildBrainTools({
      subagentId: 1, engine, config, ownerClientId: 'agent-c',
      allowedSlugPrefixes: ['wiki/personal/*'],
    });
    const putPage = tools.find(t => t.name === 'brain_put_page')!;
    const ctx: ToolCtx = { engine, jobId: 610, remote: true };
    const res = await withAuditDir(() => putPage.execute(
      { slug: 'wiki/personal/case-j', content: '---\ntitle: J\n---\nbody' }, ctx,
    ));
    expect(res).toBeTruthy();
  });

  test('[Case K] DB lookup failure (disconnected engine) fails closed with a distinct reason_code, no raw error leaked to the client message', async () => {
    const isolated = new PGLiteEngine();
    await isolated.connect({ database_url: '' });
    await isolated.initSchema();
    await isolated.disconnect();
    const tools = buildBrainTools({ subagentId: 1, engine: isolated, config, ownerClientId: 'agent-k' });
    const putPage = tools.find(t => t.name === 'brain_put_page')!;
    const ctx: ToolCtx = { engine: isolated, jobId: 611, remote: true };
    let caught: unknown;
    try {
      await withAuditDir(() => putPage.execute(
        { slug: 'wiki/agents/1/case-k', content: '---\ntitle: x\n---\nb' }, ctx,
      ));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(OperationError);
    const msg = caught instanceof Error ? caught.message : String(caught);
    // Fail-closed message must be legible without echoing a raw driver/SQL string.
    expect(msg).not.toMatch(/SELECT|pg_|ECONNREFUSED/i);
  });

  // -------------------------------------------------------------------------
  // Exercise-time monotonicity (AUTHZ-INV-005) — the "key regression" test
  // per Phase 3B-13 §11: a job validly created while the owner had authority
  // must later deny once that authority disappears, WITHOUT any new grant
  // and WITHOUT touching submit_agent's own grant-time check (AUTHZ-INV-017,
  // unmodified — see test/submit-agent.test.ts).
  // -------------------------------------------------------------------------
  describe('exercise-time monotonicity (EX matrix)', () => {
    test('[EX-1/EX-3] owner scope shrinks write -> read between two calls of the SAME job: first succeeds, second (same op) denies', async () => {
      await seedOwnerClient({ clientId: 'agent-ex13', scope: 'write agent' });
      const tools = buildBrainTools({ subagentId: 1, engine, config, ownerClientId: 'agent-ex13' });
      const putPage = tools.find(t => t.name === 'brain_put_page')!;
      const ctx: ToolCtx = { engine, jobId: 612, remote: true };

      const before = await withAuditDir(() => putPage.execute(
        { slug: 'wiki/agents/1/ex13-before', content: '---\ntitle: before\n---\nbody' }, ctx,
      ));
      expect(before).toBeTruthy();

      // Same already-delegated job, no new grant — the owner's authority
      // changes underneath it (operator rescope, or scope-shortfall fix-up).
      await engine.executeRaw(`UPDATE oauth_clients SET scope = 'read agent' WHERE client_id = 'agent-ex13'`);

      await expect(withAuditDir(() => putPage.execute(
        { slug: 'wiki/agents/1/ex13-after', content: '---\ntitle: after\n---\nbody' }, ctx,
      ))).rejects.toBeInstanceOf(OperationError);
    });

    test('[EX-4] owner scope shrinks write -> read; the delegated READ operation still succeeds', async () => {
      await seedOwnerClient({ clientId: 'agent-ex4', scope: 'read agent' });
      const tools = buildBrainTools({ subagentId: 1, engine, config, ownerClientId: 'agent-ex4' });
      const listPages = tools.find(t => t.name === 'brain_list_pages')!;
      const ctx: ToolCtx = { engine, jobId: 613, remote: true };
      // A read-scoped op must clear the authz gate under a read-only owner
      // (list_pages never throws on an empty result, unlike get_page).
      const res = await withAuditDir(() => listPages.execute({}, ctx));
      expect(res).toBeTruthy();
    });

    test('[EX-6] owner has admin scope -> canonical implication grants a write-scoped tool', async () => {
      await seedOwnerClient({ clientId: 'agent-ex6', scope: 'admin agent' });
      const tools = buildBrainTools({ subagentId: 1, engine, config, ownerClientId: 'agent-ex6' });
      const putPage = tools.find(t => t.name === 'brain_put_page')!;
      const ctx: ToolCtx = { engine, jobId: 614, remote: true };
      const res = await withAuditDir(() => putPage.execute(
        { slug: 'wiki/agents/1/ex6', content: '---\ntitle: EX6\n---\nbody' }, ctx,
      ));
      expect(res).toBeTruthy();
    });

    test('[EX-7] owner has ONLY agent scope (no write) -> a write-scoped tool is still denied; agent does not imply unrelated scope', async () => {
      await seedOwnerClient({ clientId: 'agent-ex7', scope: 'agent' });
      const tools = buildBrainTools({ subagentId: 1, engine, config, ownerClientId: 'agent-ex7' });
      const putPage = tools.find(t => t.name === 'brain_put_page')!;
      const ctx: ToolCtx = { engine, jobId: 615, remote: true };
      await expect(withAuditDir(() => putPage.execute(
        { slug: 'wiki/agents/1/ex7', content: '---\ntitle: x\n---\nb' }, ctx,
      ))).rejects.toBeInstanceOf(OperationError);
    });
  });

  test('audit-write failure does not bypass the denial (security decision and audit persistence are separate)', async () => {
    await seedOwnerClient({ clientId: 'agent-auditfail', scope: 'read agent' }); // insufficient for write
    const tools = buildBrainTools({ subagentId: 1, engine, config, ownerClientId: 'agent-auditfail' });
    const putPage = tools.find(t => t.name === 'brain_put_page')!;
    const ctx: ToolCtx = { engine, jobId: 616, remote: true };
    // Point GBRAIN_AUDIT_DIR at a path that cannot be created (parent is a
    // file, not a directory) — logAgentGrantDecision's own best-effort
    // try/catch must swallow the write failure, but the permission_denied
    // MUST still be thrown.
    const blockerFile = path.join(tmpAuditDir, 'blocker-is-a-file');
    fs.writeFileSync(blockerFile, 'x');
    const unwritableDir = path.join(blockerFile, 'nested', 'audit');
    await expect(withEnv({ GBRAIN_AUDIT_DIR: unwritableDir }, () => putPage.execute(
      { slug: 'wiki/agents/1/case-auditfail', content: '---\ntitle: x\n---\nb' }, ctx,
    ))).rejects.toBeInstanceOf(OperationError);
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
