import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { operationsByName } from '../src/core/operations.ts';

/**
 * v0.38 Slice 3 — `submit_agent` MCP op tests.
 *
 * Covers the load-bearing trust-boundary surface:
 *   - Per-dispatch binding enforcement against oauth_clients.bound_*
 *   - allowed_tools ⊆ bound_tools subset check
 *   - allowed_slug_prefixes prefix-match against bound_slug_prefixes
 *   - bound_max_concurrent concurrency cap
 *   - Local CLI bypass (ctx.remote === false → invalid_request)
 *   - Refusal when client has scope but missing bindings
 *   - Refusal for unknown client_id
 *   - dry_run path
 *   - Happy-path submission writes audit row + queue row
 *
 * Audit-trail writes go to a tmpdir via GBRAIN_AUDIT_DIR (withEnv-wrapped).
 */

const submit_agent = operationsByName['submit_agent'];
if (!submit_agent) {
  throw new Error('submit_agent op missing from operations registry — test fixture invalid');
}

let engine: PGLiteEngine;
let tmpAuditDir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  // resetPgliteState truncates `config` table; restore the version row so
  // MinionQueue.ensureSchema() sees the migrated state. The schema itself
  // is preserved (initSchema applied in beforeAll); only the config-table
  // marker row needs re-seeding.
  await engine.setConfig('version', '85');
  tmpAuditDir = fs.mkdtempSync(path.join(os.tmpdir(), 'submit-agent-audit-'));
});

interface SeedOpts {
  bound_tools?: string[] | null;
  bound_source_id?: string | null;
  bound_brain_id?: string | null;
  bound_slug_prefixes?: string[] | null;
  bound_max_concurrent?: number;
  budget_usd_per_day?: number | null;
  scope?: string;
}

async function seedClient(clientId: string, opts: SeedOpts = {}): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO oauth_clients
       (client_id, client_name, client_secret_hash, scope, grant_types,
        redirect_uris, token_endpoint_auth_method,
        bound_tools, bound_source_id, bound_brain_id, bound_slug_prefixes,
        bound_max_concurrent, budget_usd_per_day, created_at, deleted_at)
     VALUES ($1, $1, '', $2, ARRAY['client_credentials'],
             ARRAY[]::text[], 'client_secret_post',
             $3, $4, $5, $6, $7, $8, now(), NULL)
     ON CONFLICT (client_id) DO UPDATE SET
       bound_tools = EXCLUDED.bound_tools,
       bound_source_id = EXCLUDED.bound_source_id,
       bound_slug_prefixes = EXCLUDED.bound_slug_prefixes,
       bound_max_concurrent = EXCLUDED.bound_max_concurrent,
       budget_usd_per_day = EXCLUDED.budget_usd_per_day,
       scope = EXCLUDED.scope`,
    [
      clientId,
      opts.scope ?? 'read agent',
      opts.bound_tools ?? null,
      opts.bound_source_id ?? null,
      opts.bound_brain_id ?? null,
      opts.bound_slug_prefixes ?? null,
      opts.bound_max_concurrent ?? 1,
      opts.budget_usd_per_day ?? null,
    ],
  );
}

function makeCtx(opts: { clientId?: string; remote?: boolean; dryRun?: boolean; scopes?: string[] } = {}): any {
  return {
    engine,
    config: {},
    logger: console,
    dryRun: opts.dryRun ?? false,
    remote: opts.remote ?? true,
    auth: opts.clientId ? { clientId: opts.clientId, scopes: opts.scopes ?? [] } : undefined,
  };
}

async function callSubmitAgent(ctx: any, params: Record<string, unknown>): Promise<any> {
  return await withEnv({ GBRAIN_AUDIT_DIR: tmpAuditDir }, async () => {
    return await submit_agent.handler(ctx, params);
  });
}

/** Shared by the Phase 3B-1 and Phase 3B-9 grant-decision-audit blocks below. */
function readAuditLines(): Array<Record<string, unknown>> {
  const auditFiles = fs.readdirSync(tmpAuditDir).filter(f => f.startsWith('agent-jobs-'));
  if (auditFiles.length === 0) return [];
  const content = fs.readFileSync(path.join(tmpAuditDir, auditFiles[0]), 'utf8');
  return content.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
}

describe('submit_agent op (v0.38 Slice 3 — remote-callable agent dispatch with binding enforcement)', () => {
  describe('op surface', () => {
    it('declares scope=agent + mutating=true', () => {
      // Minions-visibility wave: 'agent' is a first-class member of the
      // Operation scope union now (amendment 16) — no `as any` escape hatch.
      expect(submit_agent.scope).toBe('agent');
      expect(submit_agent.mutating).toBe(true);
    });
    it('declares required prompt param', () => {
      expect(submit_agent.params.prompt).toBeDefined();
      expect((submit_agent.params.prompt as any).required).toBe(true);
    });
  });

  describe('local CLI bypass (ctx.remote === false)', () => {
    it('throws invalid_request — local CLI must use gbrain agent run', async () => {
      const ctx = makeCtx({ remote: false });
      await expect(callSubmitAgent(ctx, { prompt: 'hi' })).rejects.toThrow(
        /local CLI.*gbrain agent run/i,
      );
    });
  });

  describe('OAuth client requirement', () => {
    it('refuses when no clientId in ctx.auth', async () => {
      const ctx = makeCtx(); // no clientId
      await expect(callSubmitAgent(ctx, { prompt: 'hi' })).rejects.toThrow(
        /requires an OAuth client with the `agent` scope/i,
      );
    });

    it('refuses when client_id is unknown', async () => {
      const ctx = makeCtx({ clientId: 'nobody-here' });
      await expect(callSubmitAgent(ctx, { prompt: 'hi' })).rejects.toThrow(
        /client_id nobody-here not found/,
      );
    });
  });

  describe('binding requirement (D13 — opt-in only)', () => {
    it('refuses when client has agent scope but bound_tools is NULL', async () => {
      // Legacy admin client gets agent scope appended via re-registration but
      // forgot to set --bound-tools. Refuse with the paste-ready hint.
      await seedClient('legacy-admin', { bound_tools: null });
      const ctx = makeCtx({ clientId: 'legacy-admin' });
      await expect(callSubmitAgent(ctx, { prompt: 'hi' })).rejects.toThrow(
        /has the agent scope but no bindings.*re-register/i,
      );
    });
  });

  describe('allowed_tools subset enforcement', () => {
    it('passes when allowed_tools ⊆ bound_tools', async () => {
      await seedClient('cursor', {
        bound_tools: ['search', 'get_page', 'put_page'],
        bound_source_id: 'default',
        bound_slug_prefixes: ['wiki/'],
        bound_max_concurrent: 3,
      });
      const ctx = makeCtx({ clientId: 'cursor', dryRun: true, scopes: ['read', 'agent'] });
      const result = await callSubmitAgent(ctx, {
        prompt: 'go',
        allowed_tools: ['search', 'get_page'],
      });
      expect(result.dry_run).toBe(true);
      expect(result.action).toBe('submit_agent');
    });

    it('refuses when allowed_tools requests a tool outside bound_tools', async () => {
      await seedClient('cursor', {
        bound_tools: ['search', 'get_page'],
        bound_source_id: 'default',
        bound_slug_prefixes: ['wiki/'],
      });
      const ctx = makeCtx({ clientId: 'cursor' });
      await expect(
        callSubmitAgent(ctx, { prompt: 'go', allowed_tools: ['put_page'] }),
      ).rejects.toThrow(/tool "put_page" is not in client cursor's bound_tools/);
    });

    it('defaults to bound_tools when allowed_tools omitted', async () => {
      await seedClient('cursor', {
        bound_tools: ['search'],
        bound_source_id: 'default',
        bound_slug_prefixes: ['wiki/'],
      });
      const ctx = makeCtx({ clientId: 'cursor', dryRun: true, scopes: ['read', 'agent'] });
      const result = await callSubmitAgent(ctx, { prompt: 'go' });
      expect(result.dry_run).toBe(true);
    });

    // An EXPLICIT [] used to pass both subset loops vacuously and reach the
    // worker, which reads empty allowed_tools as "the whole registry" — so a
    // client bound to ['search'] got put_page. `??` doesn't substitute for an
    // empty array, only for null/undefined.
    it('collapses an explicit empty allowed_tools to the binding, not the full registry', async () => {
      await seedClient('cursor', {
        bound_tools: ['search'],
        bound_source_id: 'default',
        bound_slug_prefixes: ['wiki/'],
      });
      const ctx = makeCtx({ clientId: 'cursor', dryRun: true, scopes: ['read', 'agent'] });
      const result = await callSubmitAgent(ctx, { prompt: 'go', allowed_tools: [] });
      expect(result.dry_run).toBe(true);
      expect(result.resolved_tools).toEqual(['search']);
    });

    // Empty prefixes reached the subagent as "use the legacy
    // wiki/agents/<job-id>/ namespace" — outside every bound prefix.
    it('collapses an explicit empty allowed_slug_prefixes to the binding', async () => {
      await seedClient('cursor', {
        bound_tools: ['put_page'],
        bound_source_id: 'default',
        bound_slug_prefixes: ['emp-alice/'],
      });
      const ctx = makeCtx({ clientId: 'cursor', dryRun: true, scopes: ['write', 'agent'] });
      const result = await callSubmitAgent(ctx, { prompt: 'go', allowed_slug_prefixes: [] });
      // Normalized into the glob the delegated matcher understands, so the
      // subagent can write descendants rather than one exact slug.
      expect(result.resolved_slug_prefixes).toEqual(['emp-alice/*']);
    });
  });

  describe('allowed_slug_prefixes enforcement', () => {
    it('passes when each requested prefix is under a bound prefix', async () => {
      await seedClient('cursor', {
        bound_tools: ['put_page'],
        bound_source_id: 'default',
        bound_slug_prefixes: ['wiki/', 'people/'],
      });
      const ctx = makeCtx({ clientId: 'cursor', dryRun: true, scopes: ['write', 'agent'] });
      // 'wiki/' starts with 'wiki/' (exact prefix match)
      const r1 = await callSubmitAgent(ctx, {
        prompt: 'go',
        allowed_slug_prefixes: ['wiki/'],
      });
      expect(r1.dry_run).toBe(true);
    });

    it('refuses when a requested prefix has no bound parent', async () => {
      await seedClient('cursor', {
        bound_tools: ['put_page'],
        bound_source_id: 'default',
        bound_slug_prefixes: ['wiki/'],
      });
      const ctx = makeCtx({ clientId: 'cursor' });
      await expect(
        callSubmitAgent(ctx, {
          prompt: 'go',
          allowed_slug_prefixes: ['private/'],
        }),
      ).rejects.toThrow(/slug_prefix "private\/" is not under any.*bound_slug_prefixes/);
    });
  });

  describe('concurrency cap enforcement', () => {
    it('refuses when inflight count >= bound_max_concurrent', async () => {
      await seedClient('cursor', {
        bound_tools: ['search'],
        bound_source_id: 'default',
        bound_slug_prefixes: ['wiki/'],
        bound_max_concurrent: 2,
      });
      // Seed 2 already-running subagent jobs for this client.
      for (let i = 0; i < 2; i++) {
        await engine.executeRaw(
          `INSERT INTO minion_jobs (name, status, data, queue, priority, created_at)
           VALUES ('subagent', 'active', $1::jsonb, 'default', 0, now())`,
          [JSON.stringify({ prompt: `existing-${i}`, __owner_client_id: 'cursor' })],
        );
      }
      const ctx = makeCtx({ clientId: 'cursor' });
      await expect(callSubmitAgent(ctx, { prompt: 'one too many' })).rejects.toThrow(
        /at concurrency cap \(2\/2\)/,
      );
    });

    it('allows submit when inflight count < cap', async () => {
      await seedClient('cursor', {
        bound_tools: ['search'],
        bound_source_id: 'default',
        bound_slug_prefixes: ['wiki/'],
        bound_max_concurrent: 3,
      });
      await engine.executeRaw(
        `INSERT INTO minion_jobs (name, status, data, queue, priority, created_at)
         VALUES ('subagent', 'active', $1::jsonb, 'default', 0, now())`,
        [JSON.stringify({ prompt: 'one', __owner_client_id: 'cursor' })],
      );
      const ctx = makeCtx({ clientId: 'cursor', dryRun: true, scopes: ['read', 'agent'] });
      const result = await callSubmitAgent(ctx, { prompt: 'two' });
      expect(result.dry_run).toBe(true);
      expect(result.bound_max_concurrent).toBe(3);
    });

    it('does NOT count terminal-state jobs toward the cap', async () => {
      await seedClient('cursor', {
        bound_tools: ['search'],
        bound_source_id: 'default',
        bound_slug_prefixes: ['wiki/'],
        bound_max_concurrent: 1,
      });
      // 5 completed jobs — none counted (status filter is waiting/active/waiting-children).
      for (let i = 0; i < 5; i++) {
        await engine.executeRaw(
          `INSERT INTO minion_jobs (name, status, data, queue, priority, created_at)
           VALUES ('subagent', 'completed', $1::jsonb, 'default', 0, now())`,
          [JSON.stringify({ prompt: `done-${i}`, __owner_client_id: 'cursor' })],
        );
      }
      const ctx = makeCtx({ clientId: 'cursor', dryRun: true, scopes: ['read', 'agent'] });
      const result = await callSubmitAgent(ctx, { prompt: 'fresh' });
      expect(result.dry_run).toBe(true);
    });

    it('isolates inflight count by client_id (no cross-client leakage)', async () => {
      await seedClient('alice', {
        bound_tools: ['search'],
        bound_source_id: 'default',
        bound_slug_prefixes: ['wiki/'],
        bound_max_concurrent: 1,
      });
      await seedClient('bob', {
        bound_tools: ['search'],
        bound_source_id: 'default',
        bound_slug_prefixes: ['wiki/'],
        bound_max_concurrent: 1,
      });
      // Alice has 1 active — at her cap.
      await engine.executeRaw(
        `INSERT INTO minion_jobs (name, status, data, queue, priority, created_at)
         VALUES ('subagent', 'active', $1::jsonb, 'default', 0, now())`,
        [JSON.stringify({ prompt: 'alice-busy', __owner_client_id: 'alice' })],
      );
      // Bob's submit should succeed — his cap (1) is independent.
      const ctxBob = makeCtx({ clientId: 'bob', dryRun: true, scopes: ['read', 'agent'] });
      const result = await callSubmitAgent(ctxBob, { prompt: 'bob-fresh' });
      expect(result.dry_run).toBe(true);
    });
  });

  describe('happy-path submission', () => {
    it('inserts a subagent job + writes audit row', async () => {
      await seedClient('cursor', {
        bound_tools: ['search', 'get_page'],
        bound_source_id: 'default',
        bound_slug_prefixes: ['wiki/'],
        bound_max_concurrent: 3,
        budget_usd_per_day: 5.00,
      });
      const ctx = makeCtx({ clientId: 'cursor', scopes: ['read', 'agent'] });
      const result = await callSubmitAgent(ctx, {
        prompt: 'research the YC W26 batch',
        allowed_tools: ['search'],
      });
      expect(result.id).toBeGreaterThan(0);
      expect(result.name).toBe('subagent');
      expect(result.client_id).toBe('cursor');
      // Minions-visibility wave (amendments 24/25): every successful submit
      // carries a queue-state probe. Either a real snapshot (depth counts the
      // job just enqueued) or the fail-open {probe_failed: true} marker —
      // never absent, never an error.
      expect(result.queue_state).toBeDefined();
      if (!result.queue_state.probe_failed) {
        expect(result.queue_state.depth).toBeGreaterThanOrEqual(1);
        expect(typeof result.queue_state.worker_alive).toBe('boolean');
      }

      // Job persisted with correct shape.
      const rows = await engine.executeRaw<Record<string, unknown>>(
        `SELECT name, status, data FROM minion_jobs WHERE id = $1`,
        [result.id],
      );
      expect(rows.length).toBe(1);
      expect(rows[0].name).toBe('subagent');
      const data = typeof rows[0].data === 'string'
        ? JSON.parse(rows[0].data as string)
        : (rows[0].data as Record<string, unknown>);
      expect(data.prompt).toBe('research the YC W26 batch');
      expect(data.allowed_tools).toEqual(['search']);
      expect(data.__owner_client_id).toBe('cursor');
      expect(data.source_id).toBe('default'); // auto-set from bound_source_id

      // Audit file written.
      const auditFiles = fs.readdirSync(tmpAuditDir).filter(f => f.startsWith('agent-jobs-'));
      expect(auditFiles.length).toBe(1);
      const auditContent = fs.readFileSync(path.join(tmpAuditDir, auditFiles[0]), 'utf8');
      const auditLine = JSON.parse(auditContent.trim().split('\n')[0]);
      expect(auditLine.client_id).toBe('cursor');
      expect(auditLine.job_id).toBe(result.id);
      expect(auditLine.bound_tools).toEqual(['search']);
      expect(auditLine.bound_source).toBe('default');
      expect(auditLine.budget_remaining_cents).toBe(500); // 5.00 USD → 500 cents
      expect(auditLine.outcome).toBe('submitted');
      // CRITICAL: prompt text MUST NOT be in audit (only byte count).
      expect(auditContent).not.toContain('YC W26 batch');
    });

    it('caps max_turns at 100', async () => {
      await seedClient('cursor', {
        bound_tools: ['search'],
        bound_source_id: 'default',
        bound_slug_prefixes: ['wiki/'],
      });
      const ctx = makeCtx({ clientId: 'cursor', scopes: ['read', 'agent'] });
      const result = await callSubmitAgent(ctx, {
        prompt: 'long',
        max_turns: 9999, // way over cap
      });
      const rows = await engine.executeRaw<Record<string, unknown>>(
        `SELECT data FROM minion_jobs WHERE id = $1`,
        [result.id],
      );
      const data = typeof rows[0].data === 'string'
        ? JSON.parse(rows[0].data as string)
        : (rows[0].data as Record<string, unknown>);
      expect(data.max_turns).toBe(100);
    });
  });

  describe('Phase 3B-1: grant-decision audit (rejections + unfenced-null-slug warning)', () => {
    it('no-binding rejection is audited (decision=denied, reason_code=no_binding)', async () => {
      await seedClient('legacy-admin', { bound_tools: null });
      const ctx = makeCtx({ clientId: 'legacy-admin' });
      await expect(callSubmitAgent(ctx, { prompt: 'hi' })).rejects.toThrow();
      const lines = readAuditLines();
      const denial = lines.find(l => l.reason_code === 'no_binding');
      expect(denial).toBeTruthy();
      expect(denial!.decision).toBe('denied');
      expect(denial!.client_id).toBe('legacy-admin');
    });

    it('tool-widening rejection is audited with requested vs bound tools, no prompt/secret leakage', async () => {
      await seedClient('cursor', {
        bound_tools: ['search'],
        bound_source_id: 'default',
        bound_slug_prefixes: ['wiki/'],
      });
      const ctx = makeCtx({ clientId: 'cursor' });
      await expect(
        callSubmitAgent(ctx, { prompt: 'super-secret-prompt-text', allowed_tools: ['put_page'] }),
      ).rejects.toThrow();
      const lines = readAuditLines();
      const denial = lines.find(l => l.reason_code === 'tool_widening');
      expect(denial).toBeTruthy();
      expect(denial!.decision).toBe('denied');
      expect(denial!.requested_tools).toEqual(['put_page']);
      expect(denial!.bound_tools).toEqual(['search']);
      const raw = JSON.stringify(lines);
      expect(raw).not.toContain('super-secret-prompt-text');
    });

    it('slug-widening rejection is audited with requested vs bound slug prefixes', async () => {
      await seedClient('cursor', {
        bound_tools: ['put_page'],
        bound_source_id: 'default',
        bound_slug_prefixes: ['emp-alice/'],
      });
      const ctx = makeCtx({ clientId: 'cursor' });
      await expect(
        callSubmitAgent(ctx, { prompt: 'hi', allowed_slug_prefixes: ['emp-alice-2/'] }),
      ).rejects.toThrow();
      const lines = readAuditLines();
      const denial = lines.find(l => l.reason_code === 'slug_widening');
      expect(denial).toBeTruthy();
      expect(denial!.decision).toBe('denied');
      expect(denial!.requested_slug_prefixes).toEqual(['emp-alice-2/']);
      expect(denial!.bound_slug_prefixes).toEqual(['emp-alice/']);
    });

    it('source-disagreement rejection is audited with requested vs bound source', async () => {
      await seedClient('cursor', {
        bound_tools: ['search'],
        bound_source_id: 'source-a',
        bound_slug_prefixes: ['wiki/'],
      });
      // scopes must cover 'search' (read) so this request reaches the
      // source_disagreement check rather than being denied earlier by
      // AUTHZ-INV-017's scope-shortfall enforcement (Phase 3B-9) — this
      // test is specifically about source disagreement, not scope.
      const ctx = makeCtx({ clientId: 'cursor', scopes: ['read', 'agent'] });
      (ctx as any).auth.sourceId = 'source-b';
      await expect(callSubmitAgent(ctx, { prompt: 'hi' })).rejects.toThrow();
      const lines = readAuditLines();
      const denial = lines.find(l => l.reason_code === 'source_disagreement');
      expect(denial).toBeTruthy();
      expect(denial!.decision).toBe('denied');
      expect(denial!.requested_source).toBe('source-b');
      expect(denial!.bound_source).toBe('source-a');
    });

    it('client with bound_slug_prefixes=NULL is ALLOWED (not enforced) but produces an allowed_with_warning audit event', async () => {
      await seedClient('legacy-unfenced', {
        bound_tools: ['put_page'],
        bound_source_id: 'default',
        bound_slug_prefixes: null,
      });
      // scopes must cover 'put_page' (write) so this request isn't instead
      // denied earlier by AUTHZ-INV-017's scope-shortfall enforcement
      // (Phase 3B-9) — this test is specifically about the AUTHZ-INV-016
      // null-slug-binding gap, which (unlike AUTHZ-INV-017) remains warn-only.
      const ctx = makeCtx({ clientId: 'legacy-unfenced', dryRun: true, scopes: ['write', 'agent'] });
      // Must NOT throw — this gap is warn-only, not enforced, per the
      // compatibility gate (production usage could not be safely confirmed).
      const result = await callSubmitAgent(ctx, {
        prompt: 'hi',
        allowed_slug_prefixes: ['anyone/private-slug'],
      });
      expect(result.dry_run).toBe(true);
      const lines = readAuditLines();
      const warning = lines.find(l => l.reason_code === 'unfenced_null_slug_binding');
      expect(warning).toBeTruthy();
      expect(warning!.decision).toBe('allowed_with_warning');
      expect(warning!.client_id).toBe('legacy-unfenced');
      expect(warning!.bound_slug_prefixes).toBeNull();
    });

    it('valid submission still produces exactly the existing "submitted" audit line — no spurious denial events', async () => {
      await seedClient('cursor', {
        bound_tools: ['search'],
        bound_source_id: 'default',
        bound_slug_prefixes: ['wiki/'],
      });
      // 'search' requires the 'read' scope (src/core/ops/search.ts) — the
      // client must actually hold it, or Phase 3B-9's scope-enforcement
      // check (below) would deny this submission outright. This test's
      // premise is "a fully valid, fully-scoped submission produces no
      // warnings or denials of any kind" — see the Phase 3B-9 block for
      // the shortfall/denial case itself.
      const ctx = makeCtx({ clientId: 'cursor', scopes: ['read', 'agent'] });
      await callSubmitAgent(ctx, { prompt: 'hi', allowed_tools: ['search'] });
      const lines = readAuditLines();
      expect(lines.length).toBe(1);
      expect(lines[0].outcome).toBe('submitted');
      expect(lines.some(l => l.decision === 'denied')).toBe(false);
      expect(lines.some(l => l.decision === 'allowed_with_warning')).toBe(false);
    });
  });

  // Phase 3B-9 — AUTHZ-INV-017 confused-deputy scope enforcement (RESTORED/
  // ENFORCED). Historical commit 1f5243e9 (2026-08-03) computed this exact
  // shortfall — via `delegationScopeShortfalls` in delegation-capability.ts
  // — at this exact point in the handler (after narrowing, before dry-run/
  // queue.add), but only ever recorded it: "Phase 9E-1 records but does not
  // deny... Phase 9E-2 will switch this to a denial." Phase 9E-2 never
  // shipped historically (no commit in this repo's full history implements
  // it). This project's own Phase 3B-2 ported only the warn-only half onto
  // current architecture (see git history: 4504e704), deliberately
  // deferring hard denial pending a production-usage compatibility check it
  // judged unsafe to perform from this worktree.
  //
  // Phase 3B-9 completes that never-shipped enforce stage: does the
  // delegating client's OWN OAuth scope cover the required_scope of every
  // tool it is about to hand to the child job? `agent` implies nothing else
  // (scope.ts's IMPLIES table), so a client can be *bound* to a tool its
  // own scope doesn't cover — that's the confused-deputy shape. A shortfall
  // now DENIES the entire delegation, before any job is queued. CD-1..CD-8
  // preserve the original Phase 3B-2 test matrix's numbering and coverage
  // intent, updated for DENY semantics; CD-9 onward add the Phase 3B-9
  // multi-tool/side-effect/dry-run/duplicate/unknown-tool matrix.
  describe('Phase 3B-9: AUTHZ-INV-017 confused-deputy scope enforcement (DENY)', () => {
    it('CD-1: delegator scopes fully cover the requested tool → ALLOW, no shortfall', async () => {
      await seedClient('cursor', {
        bound_tools: ['search'],
        bound_source_id: 'default',
        bound_slug_prefixes: ['wiki/'],
      });
      // 'search' requires 'read' (src/core/ops/search.ts).
      const ctx = makeCtx({ clientId: 'cursor', scopes: ['read', 'agent'] });
      const result = await callSubmitAgent(ctx, { prompt: 'hi', allowed_tools: ['search'] });
      expect(result.id).toBeGreaterThan(0);
      const lines = readAuditLines();
      expect(lines.some(l => l.reason_code === 'delegation_scope_shortfall')).toBe(false);
    });

    it('CD-2: delegator (agent-only) attempts to delegate a bound write tool it does not itself possess → DENIED — the confused-deputy case AUTHZ-INV-017 exists for', async () => {
      await seedClient('cursor', {
        bound_tools: ['put_page'],
        bound_source_id: 'default',
        bound_slug_prefixes: ['wiki/'],
      });
      // 'put_page' requires 'write' (src/core/ops/pages.ts); client only has
      // 'agent' — the client is legitimately BOUND to put_page (an operator
      // set that binding) but does not itself hold 'write'. Binding !=
      // scope possession — the exact distinction this invariant enforces.
      const ctx = makeCtx({ clientId: 'cursor', scopes: ['agent'] });
      await expect(
        callSubmitAgent(ctx, { prompt: 'hi', allowed_tools: ['put_page'] }),
      ).rejects.toThrow(/own OAuth scopes.*do not cover.*put_page.*needs "write"/);
      const lines = readAuditLines();
      const denial = lines.find(l => l.reason_code === 'delegation_scope_shortfall');
      expect(denial).toBeTruthy();
      expect(denial!.decision).toBe('denied');
      expect(denial!.client_id).toBe('cursor');
      expect(denial!.requested_tools).toEqual(['put_page']);
      expect(denial!.missing_scopes).toEqual(['write']);
      // No job was created for the denied delegation.
      const rows = await engine.executeRaw<Record<string, unknown>>(
        `SELECT id FROM minion_jobs WHERE data->>'__owner_client_id' = 'cursor'`,
      );
      expect(rows.length).toBe(0);
    });

    it('CD-3: multiple tools, one missing scope → the ENTIRE delegation is denied, not just the uncovered tool', async () => {
      await seedClient('cursor', {
        bound_tools: ['search', 'put_page'],
        bound_source_id: 'default',
        bound_slug_prefixes: ['wiki/'],
      });
      // Covers 'search' (read) but not 'put_page' (write).
      const ctx = makeCtx({ clientId: 'cursor', scopes: ['read', 'agent'] });
      await expect(
        callSubmitAgent(ctx, { prompt: 'hi', allowed_tools: ['search', 'put_page'] }),
      ).rejects.toThrow();
      const lines = readAuditLines();
      const denial = lines.find(l => l.reason_code === 'delegation_scope_shortfall');
      expect(denial).toBeTruthy();
      expect(denial!.decision).toBe('denied');
      expect(denial!.requested_tools).toEqual(['put_page']);
      expect(denial!.missing_scopes).toEqual(['write']);
      // No partial grant: zero jobs created, not a job restricted to 'search'.
      const rows = await engine.executeRaw<Record<string, unknown>>(
        `SELECT id FROM minion_jobs WHERE data->>'__owner_client_id' = 'cursor'`,
      );
      expect(rows.length).toBe(0);
    });

    it('CD-4: scope hierarchy respected — admin covers write, no false-positive denial', async () => {
      await seedClient('cursor', {
        bound_tools: ['put_page'],
        bound_source_id: 'default',
        bound_slug_prefixes: ['wiki/'],
      });
      // admin implies write (scope.ts IMPLIES table) even though it's not
      // spelled 'write' literally.
      const ctx = makeCtx({ clientId: 'cursor', scopes: ['admin', 'agent'] });
      const result = await callSubmitAgent(ctx, { prompt: 'hi', allowed_tools: ['put_page'] });
      expect(result.id).toBeGreaterThan(0);
      const lines = readAuditLines();
      expect(lines.some(l => l.reason_code === 'delegation_scope_shortfall')).toBe(false);
    });

    it('CD-5: tool-widening still denies before any scope-shortfall consideration, even with broad delegator scopes', async () => {
      await seedClient('cursor', {
        bound_tools: ['search'],
        bound_source_id: 'default',
        bound_slug_prefixes: ['wiki/'],
      });
      // Delegator holds every scope there is — irrelevant, since bound_tools
      // narrowing is a completely independent check that runs first.
      const ctx = makeCtx({ clientId: 'cursor', scopes: ['admin', 'agent'] });
      await expect(
        callSubmitAgent(ctx, { prompt: 'hi', allowed_tools: ['put_page'] }),
      ).rejects.toThrow(/not in client cursor's bound_tools/);
      const lines = readAuditLines();
      expect(lines.some(l => l.reason_code === 'delegation_scope_shortfall')).toBe(false);
      const denial = lines.find(l => l.reason_code === 'tool_widening');
      expect(denial).toBeTruthy();
    });

    it('CD-6: slug-widening still denies before any scope-shortfall consideration, even with full tool-scope coverage', async () => {
      await seedClient('cursor', {
        bound_tools: ['put_page'],
        bound_source_id: 'default',
        bound_slug_prefixes: ['emp-alice/'],
      });
      // Delegator fully covers put_page's required scope — irrelevant, since
      // slug-prefix narrowing is a completely independent check.
      const ctx = makeCtx({ clientId: 'cursor', scopes: ['write', 'agent'] });
      await expect(
        callSubmitAgent(ctx, { prompt: 'hi', allowed_slug_prefixes: ['emp-alice-2/'] }),
      ).rejects.toThrow(/not under any of client cursor's bound_slug_prefixes/);
      const lines = readAuditLines();
      expect(lines.some(l => l.reason_code === 'delegation_scope_shortfall')).toBe(false);
      const denial = lines.find(l => l.reason_code === 'slug_widening');
      expect(denial).toBeTruthy();
    });

    it('CD-7: denial audit event carries reconstructable detail with no prompt/secret leakage', async () => {
      await seedClient('cursor', {
        bound_tools: ['put_page'],
        bound_source_id: 'default',
        bound_slug_prefixes: ['wiki/'],
      });
      const ctx = makeCtx({ clientId: 'cursor', scopes: ['agent'] });
      await expect(
        callSubmitAgent(ctx, { prompt: 'super-secret-prompt-text', allowed_tools: ['put_page'] }),
      ).rejects.toThrow();
      const lines = readAuditLines();
      const denial = lines.find(l => l.reason_code === 'delegation_scope_shortfall');
      expect(denial).toBeTruthy();
      expect(denial!.decision).toBe('denied');
      expect(denial!.bound_tools).toEqual(['put_page']);
      expect(typeof denial!.reason).toBe('string');
      expect(denial!.reason as string).toMatch(/AUTHZ-INV-017/);
      const raw = JSON.stringify(lines);
      expect(raw).not.toContain('super-secret-prompt-text');
      // Exactly one audit line for this denial — no double-audit.
      expect(lines.length).toBe(1);
    });

    it('CD-8: a shortfall now DENIES — no job row is created, no delegated authority is left behind', async () => {
      await seedClient('cursor', {
        bound_tools: ['put_page'],
        bound_source_id: 'default',
        bound_slug_prefixes: ['wiki/'],
      });
      const ctx = makeCtx({ clientId: 'cursor', scopes: [] }); // no scopes at all
      await expect(
        callSubmitAgent(ctx, { prompt: 'hi', allowed_tools: ['put_page'] }),
      ).rejects.toThrow();
      const rows = await engine.executeRaw<Record<string, unknown>>(
        `SELECT id FROM minion_jobs WHERE data->>'__owner_client_id' = 'cursor'`,
      );
      expect(rows.length).toBe(0);
    });

    it('CD-9: binding vs possession — a client legitimately BOUND to a tool (operator allowed it to reference the tool) but lacking that tool\'s own OAuth scope is still DENIED; being bound is not sufficient', async () => {
      // The operator explicitly bound this client to 'put_page' at
      // registration time (bound_tools) — the client is fully entitled to
      // NAME put_page in allowed_tools, and tool-widening will not reject
      // it. AUTHZ-INV-017 is the second, independent gate: possession of
      // put_page's own required scope, which this client's OAuth grant
      // never included.
      await seedClient('cursor', {
        bound_tools: ['put_page'],
        bound_source_id: 'default',
        bound_slug_prefixes: ['wiki/'],
      });
      const ctx = makeCtx({ clientId: 'cursor', scopes: ['agent'] }); // bound, but scope-less
      await expect(
        callSubmitAgent(ctx, { prompt: 'hi', allowed_tools: ['put_page'] }),
      ).rejects.toThrow(/permission_denied|do not cover/);
    });

    it('CD-10: multi-tool matrix — agent + every required tool scope → ALLOWED', async () => {
      await seedClient('cursor', {
        bound_tools: ['search', 'get_page', 'put_page'],
        bound_source_id: 'default',
        bound_slug_prefixes: ['wiki/'],
      });
      const ctx = makeCtx({ clientId: 'cursor', scopes: ['read', 'write', 'agent'] });
      const result = await callSubmitAgent(ctx, {
        prompt: 'hi',
        allowed_tools: ['search', 'get_page', 'put_page'],
      });
      expect(result.id).toBeGreaterThan(0);
    });

    it('CD-11: duplicate requested tool names do not create inconsistent behavior (still denied once, missing_scopes deduped)', async () => {
      await seedClient('cursor', {
        bound_tools: ['put_page'],
        bound_source_id: 'default',
        bound_slug_prefixes: ['wiki/'],
      });
      const ctx = makeCtx({ clientId: 'cursor', scopes: ['agent'] });
      // allowed_tools with a duplicate — tool-widening's subset check passes
      // vacuously for duplicates (both entries are in bound_tools).
      await expect(
        callSubmitAgent(ctx, { prompt: 'hi', allowed_tools: ['put_page', 'put_page'] }),
      ).rejects.toThrow();
      const lines = readAuditLines();
      const denial = lines.find(l => l.reason_code === 'delegation_scope_shortfall');
      expect(denial).toBeTruthy();
      expect(denial!.missing_scopes).toEqual(['write']); // deduped, not ['write','write']
    });

    it('CD-12: a bound tool absent from the operation registry defaults its required scope to "read" (matches historical + pre-existing fallback), rather than crashing or being treated specially', async () => {
      await seedClient('cursor', {
        bound_tools: ['totally_unregistered_tool_xyz'],
        bound_source_id: 'default',
        bound_slug_prefixes: ['wiki/'],
      });
      // Client has 'agent' only — no 'read' — so the 'read' fallback should
      // still produce a shortfall denial (proving the fallback is live),
      // not a crash or a silent allow.
      const ctxNoRead = makeCtx({ clientId: 'cursor', scopes: ['agent'] });
      await expect(
        callSubmitAgent(ctxNoRead, { prompt: 'hi', allowed_tools: ['totally_unregistered_tool_xyz'] }),
      ).rejects.toThrow();
      const lines1 = readAuditLines();
      expect(lines1.find(l => l.reason_code === 'delegation_scope_shortfall')?.missing_scopes).toEqual(['read']);

      // With 'read' held, the same unregistered tool passes (defaulted
      // requirement is satisfied) — confirms this is a real default, not an
      // unconditional deny for unregistered tools.
      const ctxWithRead = makeCtx({ clientId: 'cursor', scopes: ['read', 'agent'] });
      const result = await callSubmitAgent(ctxWithRead, { prompt: 'hi', allowed_tools: ['totally_unregistered_tool_xyz'] });
      expect(result.id).toBeGreaterThan(0);
    });

    it('CD-13: empty bound_tools (client bound to nothing) → requestedTools resolves to [] → vacuously no shortfall, existing empty-binding behavior preserved', async () => {
      await seedClient('cursor', {
        bound_tools: [],
        bound_source_id: 'default',
        bound_slug_prefixes: ['wiki/'],
      });
      const ctx = makeCtx({ clientId: 'cursor', scopes: [] });
      const result = await callSubmitAgent(ctx, { prompt: 'hi' });
      expect(result.id).toBeGreaterThan(0);
      const lines = readAuditLines();
      expect(lines.some(l => l.reason_code === 'delegation_scope_shortfall')).toBe(false);
    });

    it('CD-14: dry-run sees the same denial as the real submission — no misleading success preview for a delegation that would actually be denied', async () => {
      await seedClient('cursor', {
        bound_tools: ['put_page'],
        bound_source_id: 'default',
        bound_slug_prefixes: ['wiki/'],
      });
      const ctx = makeCtx({ clientId: 'cursor', dryRun: true, scopes: ['agent'] });
      await expect(
        callSubmitAgent(ctx, { prompt: 'hi', allowed_tools: ['put_page'] }),
      ).rejects.toThrow(/do not cover/);
    });

    it('CD-15: valid delegation protocol is unchanged — a fully-scoped submission still returns the identical success shape (id, name, client_id, queue_state)', async () => {
      await seedClient('cursor', {
        bound_tools: ['search'],
        bound_source_id: 'default',
        bound_slug_prefixes: ['wiki/'],
      });
      const ctx = makeCtx({ clientId: 'cursor', scopes: ['read', 'agent'] });
      const result = await callSubmitAgent(ctx, { prompt: 'hi', allowed_tools: ['search'] });
      expect(result.id).toBeGreaterThan(0);
      expect(result.name).toBe('subagent');
      expect(result.client_id).toBe('cursor');
      expect(result.queue_state).toBeDefined();
    });
  });
});
