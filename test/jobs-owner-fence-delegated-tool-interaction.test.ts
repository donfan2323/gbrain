/**
 * Phase 3B-16A (X-1..X-5) — cross-interaction tests between two independent
 * consumers of the SAME `data->>'__owner_client_id'` job field:
 *
 *   - agentOwnerFence() / assertJobOwned() (upstream #4098, src/core/ops/jobs.ts):
 *     gates get_job/list_jobs/cancel_job/get_job_progress visibility by
 *     matching the CALLER's own ctx.auth.clientId against the job's stored
 *     owner. Identity-match only — no live authority re-check.
 *   - resolveOwnerAuthority() / the delegated-tool exercise-time gate
 *     (candidate Phase 3B-13, AUTHZ-INV-005/006, src/core/minions/tools/
 *     brain-allowlist.ts): re-queries the owner client's CURRENT
 *     oauth_clients row (scope, deleted_at) at the moment a delegated brain_*
 *     tool actually executes inside a subagent job.
 *
 * These two gates were never previously tested together — job-visibility
 * fencing did not exist before the upstream merge. This file exists
 * specifically to prove neither one silently weakens the other now that
 * both read the same field.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { buildBrainTools } from '../src/core/minions/tools/brain-allowlist.ts';
import { hasScope, DCR_ALLOWED_SCOPES } from '../src/core/scope.ts';
import { withEnv } from './helpers/with-env.ts';
import type { GBrainConfig } from '../src/core/config.ts';
import type { ToolCtx } from '../src/core/minions/types.ts';

let engine: PGLiteEngine;
let queue: MinionQueue;
const config: GBrainConfig = { engine: 'pglite' } as GBrainConfig;
let tmpAuditDir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
  queue = new MinionQueue(engine);
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM minion_inbox');
  await engine.executeRaw('DELETE FROM minion_jobs');
  await engine.executeRaw('DELETE FROM oauth_clients');
  await engine.executeRaw('DELETE FROM pages');
  tmpAuditDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-owner-fence-interaction-audit-'));
});

function ctx(over: Partial<OperationContext> = {}): OperationContext {
  return {
    engine,
    config: {} as OperationContext['config'],
    logger: { info() {}, warn() {}, error() {}, debug() {} } as unknown as OperationContext['logger'],
    dryRun: false,
    remote: true,
    sourceId: 'default',
    ...over,
  } as OperationContext;
}
const agentCtx = (clientId: string) =>
  ctx({ auth: { clientId, scopes: ['agent'] } as OperationContext['auth'] });

async function seedOwnerClient(clientId: string, opts: { scope?: string; deleted?: boolean } = {}): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO oauth_clients
       (client_id, client_name, client_secret_hash, scope, grant_types,
        redirect_uris, token_endpoint_auth_method, created_at, deleted_at)
     VALUES ($1, $1, '', $2, ARRAY['client_credentials'],
             ARRAY[]::text[], 'client_secret_post', now(), $3)`,
    [clientId, opts.scope ?? 'write agent', opts.deleted ? new Date().toISOString() : null],
  );
}

let seedSeq = 0;
async function seedJob(owner: string | null, name = 'subagent'): Promise<number> {
  const data: Record<string, unknown> = { prompt: `x-${++seedSeq}` };
  if (owner) data.__owner_client_id = owner;
  const job = await queue.add(name, data, { queue: 'default' }, { allowProtectedSubmit: true });
  return job.id;
}

function readAuditLines(): Array<Record<string, unknown>> {
  const auditFiles = fs.readdirSync(tmpAuditDir).filter(f => f.startsWith('agent-jobs-'));
  if (auditFiles.length === 0) return [];
  const content = fs.readFileSync(path.join(tmpAuditDir, auditFiles[0]), 'utf8');
  return content.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
}
async function withAuditDir<T>(fn: () => Promise<T>): Promise<T> {
  return withEnv({ GBRAIN_AUDIT_DIR: tmpAuditDir }, fn);
}

const get_job = operationsByName['get_job']!;
const list_jobs = operationsByName['list_jobs']!;
const get_job_progress = operationsByName['get_job_progress']!;

describe('Phase 3B-16A X-1: job-visibility fencing does not interfere with delegated-tool exercise-time reauth', () => {
  test('a valid, active owner: both gates independently succeed on the same job', async () => {
    await seedOwnerClient('agent-x1', { scope: 'write agent' });
    const jobId = await seedJob('agent-x1');

    // Gate 1: upstream job-visibility fence (agentOwnerFence/assertJobOwned).
    const job = (await get_job.handler(agentCtx('agent-x1'), { id: jobId })) as { id: number };
    expect(job.id).toBe(jobId);

    // Gate 2: candidate delegated-tool exercise-time reauth (Phase 3B-13),
    // same owner identity, independent code path (brain-allowlist.ts).
    const tools = buildBrainTools({ subagentId: 1, engine, config, ownerClientId: 'agent-x1' });
    const putPage = tools.find(t => t.name === 'brain_put_page')!;
    const toolCtx: ToolCtx = { engine, jobId, remote: true };
    const res = await withAuditDir(() => putPage.execute(
      { slug: 'wiki/agents/1/x1', content: '---\ntitle: x1\n---\nb' }, toolCtx,
    ));
    expect(res).toBeTruthy();
  });
});

describe('Phase 3B-16A X-2: __owner_client_id is the same identity, coherently, in both systems', () => {
  test('two distinct owners never cross-resolve in either gate for the same job set', async () => {
    await seedOwnerClient('agent-x2a', { scope: 'write agent' });
    await seedOwnerClient('agent-x2b', { scope: 'write agent' });
    const jobA = await seedJob('agent-x2a');
    const jobB = await seedJob('agent-x2b');

    // Visibility fence: each owner sees only its own job.
    expect(((await get_job.handler(agentCtx('agent-x2a'), { id: jobA })) as { id: number }).id).toBe(jobA);
    expect(((await get_job.handler(agentCtx('agent-x2b'), { id: jobB })) as { id: number }).id).toBe(jobB);
    await expect(get_job.handler(agentCtx('agent-x2a'), { id: jobB })).rejects.toThrow();
    await expect(get_job.handler(agentCtx('agent-x2b'), { id: jobA })).rejects.toThrow();

    // Delegated-tool exercise: each ownerClientId resolves against its OWN
    // live oauth_clients row — agent-x2b's identity is never used to
    // authorize a tool call made under agent-x2a's ownerClientId, or vice
    // versa (no field aliasing / no shared mutable resolution state).
    const toolsA = buildBrainTools({ subagentId: 1, engine, config, ownerClientId: 'agent-x2a' });
    const toolsB = buildBrainTools({ subagentId: 1, engine, config, ownerClientId: 'agent-x2b' });
    const resA = await withAuditDir(() => toolsA.find(t => t.name === 'brain_put_page')!.execute(
      { slug: 'wiki/agents/1/x2a', content: '---\ntitle: a\n---\nb' }, { engine, jobId: jobA, remote: true },
    ));
    const resB = await withAuditDir(() => toolsB.find(t => t.name === 'brain_put_page')!.execute(
      { slug: 'wiki/agents/1/x2b', content: '---\ntitle: b\n---\nb' }, { engine, jobId: jobB, remote: true },
    ));
    expect(resA).toBeTruthy();
    expect(resB).toBeTruthy();
  });
});

describe('Phase 3B-16A X-3: a revoked (soft-deleted) owner', () => {
  test('cannot exercise the delegated tool — resolveOwnerAuthority re-checks deleted_at live', async () => {
    await seedOwnerClient('agent-x3', { scope: 'write agent', deleted: true });
    const jobId = await seedJob('agent-x3');
    const tools = buildBrainTools({ subagentId: 1, engine, config, ownerClientId: 'agent-x3' });
    const putPage = tools.find(t => t.name === 'brain_put_page')!;
    await expect(withAuditDir(() => putPage.execute(
      { slug: 'wiki/agents/1/x3', content: '---\ntitle: x\n---\nb' }, { engine, jobId, remote: true },
    ))).rejects.toThrow();
    const rows = await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM pages WHERE slug = 'wiki/agents/1/x3'`,
    );
    expect(rows[0].n).toBe(0);
  });

  // Documented, evidence-backed nuance rather than an assumption: at the
  // OPERATION-HANDLER level (this test's harness, which constructs
  // ctx.auth directly the same way jobs-agent-scope.test.ts does),
  // agentOwnerFence()/assertJobOwned() do NOT themselves re-check
  // oauth_clients.deleted_at — only identity-match. That is correct, not a
  // gap: get_job/list_jobs/cancel_job/get_job_progress are live HTTP MCP
  // calls, and the REAL end-to-end revocation path
  // (POST /admin/api/revoke-client, src/commands/serve-http.ts) does
  //   UPDATE oauth_clients SET deleted_at = now() ...
  //   DELETE FROM oauth_tokens WHERE client_id = ...
  // — i.e. it deletes the client's outstanding tokens in the SAME
  // operation. verifyAccessToken() (src/core/oauth-provider.ts) then fails
  // that client's very next request outright (proven pre-existing, merge-
  // untouched: test/oauth.test.ts "revoked token no longer verifies"), so
  // in the real system agentOwnerFence is never even reached — the 401
  // happens one layer up, at HTTP auth. Phase 3B-13's exercise-time gate
  // needs its OWN explicit deleted_at re-check (proven above) precisely
  // BECAUSE a delegated tool runs inside an async job with no live bearer
  // token to re-verify — agentOwnerFence has no equivalent need, and adding
  // a redundant check there would duplicate, not strengthen, the invariant.
  test('at the operation layer alone (bypassing HTTP auth), agentOwnerFence does identity-match only — by design, not a gap', async () => {
    await seedOwnerClient('agent-x3b', { scope: 'write agent', deleted: true });
    const jobId = await seedJob('agent-x3b');
    const job = (await get_job.handler(agentCtx('agent-x3b'), { id: jobId })) as { id: number };
    expect(job.id).toBe(jobId);
  });
});

describe('Phase 3B-16A X-4: DCR clients cannot use job APIs as an authority-escalation path', () => {
  test('DCR ceiling {read,write} never satisfies the agentCallable carve-out (hasScope(scopes, "agent"))', () => {
    // Pins the exact precondition enforced at the three real dispatch
    // gates (src/commands/serve-http.ts:2950 tools/list filter, :3028
    // tools/call dispatch, src/core/ops/request-tools.ts:108) — all three
    // use this identical `op.agentCallable === true && hasScope(scopes,
    // 'agent')` condition, none reachable by a DCR-ceilinged token.
    const dcrScopes = Array.from(DCR_ALLOWED_SCOPES);
    expect(dcrScopes).toEqual(['read', 'write']);
    expect(hasScope(dcrScopes, 'agent')).toBe(false);
    expect(hasScope(dcrScopes, 'admin')).toBe(false);
  });

  test('even called directly (bypassing the dispatch gate), a DCR-scoped identity owns no job and gains nothing', async () => {
    await seedOwnerClient('agent-x4-real-owner', { scope: 'write agent' });
    const realJob = await seedJob('agent-x4-real-owner');
    const dcrCtx = ctx({ auth: { clientId: 'dcr-client-x4', scopes: ['read', 'write'] } as OperationContext['auth'] });

    // A DCR identity can never be a job's __owner_client_id (submit_agent's
    // own grant-time gate requires 'agent' scope to bind one), so it never
    // matches assertJobOwned's predicate for ANY job, including one it did
    // not submit.
    await expect(get_job.handler(dcrCtx, { id: realJob })).rejects.toThrow();
    const mine = (await list_jobs.handler(dcrCtx, {})) as unknown[];
    expect(mine.length).toBe(0);
  });
});

describe('Phase 3B-16A X-5: grant-denial audit stays exactly-once despite the merged job-visibility ops', () => {
  test('a delegated-tool denial writes one audit row; subsequent get_job/list_jobs/get_job_progress calls add none', async () => {
    await seedOwnerClient('agent-x5', { scope: 'write agent', deleted: true });
    const jobId = await seedJob('agent-x5');
    const tools = buildBrainTools({ subagentId: 1, engine, config, ownerClientId: 'agent-x5' });
    const putPage = tools.find(t => t.name === 'brain_put_page')!;

    await expect(withAuditDir(() => putPage.execute(
      { slug: 'wiki/agents/1/x5', content: '---\ntitle: x\n---\nb' }, { engine, jobId, remote: true },
    ))).rejects.toThrow();
    expect(readAuditLines().length).toBe(1);

    // get_job/list_jobs/get_job_progress never call logAgentGrantDecision
    // (confirmed by source inspection: that function is only invoked from
    // submit_agent's own grant-time logic elsewhere in jobs.ts, not from
    // agentOwnerFence/assertJobOwned) — exercising them must not add rows.
    await get_job.handler(agentCtx('agent-x5'), { id: jobId });
    await get_job_progress.handler(agentCtx('agent-x5'), { id: jobId });
    await list_jobs.handler(agentCtx('agent-x5'), {});
    expect(readAuditLines().length).toBe(1);
  });
});
