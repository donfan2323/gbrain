/**
 * Phase 9E-1 (dashboard-f5jd5) — checkDelegationCapabilityHealth.
 *
 * Read-only doctor check surfacing risky-but-not-denied submit_agent
 * delegation OAuth-client bindings (AUTHZ-INV-016/017) and legacy
 * `allowed_slug_prefixes: []` job records from before the 9E-1
 * normalization fix. See doctor.ts's checkDelegationCapabilityHealth
 * docblock for the full rationale.
 *
 * Hermetic via PGLite. Mirrors test/doctor-v0_37_7_checks.test.ts's
 * fixture-insertion style (inline literals for scalar columns, $N params
 * for TEXT[] columns).
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { checkDelegationCapabilityHealth } from '../src/commands/doctor.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

async function truncate(): Promise<void> {
  await (engine as any).db.exec(`DELETE FROM oauth_clients`);
  await (engine as any).db.exec(`DELETE FROM minion_jobs`);
}

async function insertClient(opts: {
  clientId: string;
  scope: string;
  boundTools?: string[] | null;
  boundSlugPrefixes?: string[] | null;
  boundSourceId?: string | null;
}): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO oauth_clients (client_id, client_name, scope, bound_tools, bound_slug_prefixes, bound_source_id)
     VALUES ('${opts.clientId}', '${opts.clientId}', '${opts.scope}', $1, $2, ${opts.boundSourceId ? `'${opts.boundSourceId}'` : 'NULL'})`,
    [opts.boundTools ?? null, opts.boundSlugPrefixes ?? null],
  );
}

async function insertJob(name: string, allowedSlugPrefixes: unknown): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO minion_jobs (name, data) VALUES ($1, $2::jsonb)`,
    [name, JSON.stringify({ allowed_slug_prefixes: allowedSlugPrefixes })],
  );
}

describe('checkDelegationCapabilityHealth (Phase 9E-1)', () => {
  beforeEach(truncate);

  test('no agent-delegation-capable clients → ok', async () => {
    const r = await checkDelegationCapabilityHealth(engine);
    expect(r.status).toBe('ok');
    expect(r.message).toMatch(/no agent-delegation-capable/i);
  });

  test('unrelated client (no agent scope, no bound_tools) → ok, not counted', async () => {
    await insertClient({ clientId: 'plain-reader', scope: 'read' });
    const r = await checkDelegationCapabilityHealth(engine);
    expect(r.status).toBe('ok');
  });

  test('"agent" scope + no bound_tools → warn, names the client, no false "write" finding', async () => {
    await insertClient({ clientId: 'agent-no-tools', scope: 'read agent' });
    const r = await checkDelegationCapabilityHealth(engine);
    expect(r.status).toBe('warn');
    expect(r.message).toMatch(/no bound_tools/);
    expect(r.message).toMatch(/agent-no-tools/);
    expect(r.message).toMatch(/no_bindings/);
  });

  test('"agent" scope + bound_tools set → no "no bound_tools" finding', async () => {
    await insertClient({
      clientId: 'agent-with-tools', scope: 'read write agent',
      boundTools: ['get_page'], boundSourceId: 'src-a',
    });
    const r = await checkDelegationCapabilityHealth(engine);
    expect(r.message).not.toMatch(/no bound_tools/);
  });

  test('write-capable bound tool + no slug grant → warn (AUTHZ-INV-016 fallback)', async () => {
    await insertClient({
      clientId: 'writer-no-slug', scope: 'read write agent',
      boundTools: ['put_page'], boundSourceId: 'src-a',
    });
    const r = await checkDelegationCapabilityHealth(engine);
    expect(r.status).toBe('warn');
    expect(r.message).toMatch(/write-capable tool/);
    expect(r.message).toMatch(/writer-no-slug/);
  });

  test('write-capable bound tool + slug grant present → no write-without-slug-grant finding', async () => {
    await insertClient({
      clientId: 'writer-with-slug', scope: 'read write agent',
      boundTools: ['put_page'], boundSlugPrefixes: ['wiki/'], boundSourceId: 'src-a',
    });
    const r = await checkDelegationCapabilityHealth(engine);
    expect(r.message).not.toMatch(/write-capable tool/);
  });

  test('read-only bound tool + no slug grant → no write-without-slug-grant finding', async () => {
    await insertClient({
      clientId: 'reader-only', scope: 'read agent',
      boundTools: ['get_page'], boundSourceId: 'src-a',
    });
    const r = await checkDelegationCapabilityHealth(engine);
    expect(r.message).not.toMatch(/write-capable tool/);
  });

  test('bound_tools set + bound_source_id unset → warn (default-fallback finding)', async () => {
    await insertClient({
      clientId: 'no-source', scope: 'read agent',
      boundTools: ['get_page'],
    });
    const r = await checkDelegationCapabilityHealth(engine);
    expect(r.status).toBe('warn');
    expect(r.message).toMatch(/bound_source_id unset/);
    expect(r.message).toMatch(/no-source/);
    expect(r.message).toMatch(/dashboard-z7a1o/);
  });

  test('bound_tools set + bound_source_id set → no default-fallback finding', async () => {
    await insertClient({
      clientId: 'has-source', scope: 'read agent',
      boundTools: ['get_page'], boundSourceId: 'src-a',
    });
    const r = await checkDelegationCapabilityHealth(engine);
    expect(r.message).not.toMatch(/bound_source_id unset/);
  });

  test('bound tool requires a scope the client lacks → warn (AUTHZ-INV-017 shortfall)', async () => {
    // put_page requires "write"; client only has "agent" (+"read").
    await insertClient({
      clientId: 'shortfall-client', scope: 'read agent',
      boundTools: ['put_page'], boundSlugPrefixes: ['wiki/'], boundSourceId: 'src-a',
    });
    const r = await checkDelegationCapabilityHealth(engine);
    expect(r.status).toBe('warn');
    expect(r.message).toMatch(/AUTHZ-INV-017/);
    expect(r.message).toMatch(/shortfall-client/);
    expect(r.message).toMatch(/delegation_scope_shortfall/);
  });

  test('bound tool covered by held scopes → no AUTHZ-INV-017 finding', async () => {
    await insertClient({
      clientId: 'covered-client', scope: 'read write agent',
      boundTools: ['put_page'], boundSlugPrefixes: ['wiki/'], boundSourceId: 'src-a',
    });
    const r = await checkDelegationCapabilityHealth(engine);
    expect(r.message).not.toMatch(/AUTHZ-INV-017/);
  });

  test('"admin" scope covers every bound tool (scope hierarchy) → no AUTHZ-INV-017 finding', async () => {
    await insertClient({
      clientId: 'admin-client', scope: 'admin agent',
      boundTools: ['put_page'], boundSlugPrefixes: ['wiki/'], boundSourceId: 'src-a',
    });
    const r = await checkDelegationCapabilityHealth(engine);
    expect(r.message).not.toMatch(/AUTHZ-INV-017/);
  });

  test('fully well-formed client → ok, zero findings', async () => {
    await insertClient({
      clientId: 'well-formed', scope: 'read write agent',
      boundTools: ['get_page', 'put_page'], boundSlugPrefixes: ['wiki/'], boundSourceId: 'src-a',
    });
    const r = await checkDelegationCapabilityHealth(engine);
    expect(r.status).toBe('ok');
    expect(r.message).toMatch(/no risky configurations found/);
  });

  test('legacy allowed_slug_prefixes=[] job record → warn (informational)', async () => {
    await insertJob('agent-job-legacy', []);
    const r = await checkDelegationCapabilityHealth(engine);
    expect(r.status).toBe('warn');
    expect(r.message).toMatch(/legacy/);
    expect(r.message).toMatch(/allowed_slug_prefixes/);
  });

  test('non-empty allowed_slug_prefixes job record → NOT flagged as legacy', async () => {
    await insertJob('agent-job-normal', ['wiki/']);
    const r = await checkDelegationCapabilityHealth(engine);
    expect(r.message).not.toMatch(/legacy/);
  });

  test('job with no allowed_slug_prefixes key at all → NOT flagged as legacy', async () => {
    await engine.executeRaw(
      `INSERT INTO minion_jobs (name, data) VALUES ($1, $2::jsonb)`,
      ['unrelated-job', JSON.stringify({ some_other_field: 1 })],
    );
    const r = await checkDelegationCapabilityHealth(engine);
    expect(r.message).not.toMatch(/legacy/);
  });

  test('multiple findings on the same client are all reported, not mutually exclusive', async () => {
    await insertClient({
      clientId: 'multi-issue', scope: 'read agent',
      boundTools: ['put_page'], // write tool, no slug grant, no source, scope shortfall
    });
    const r = await checkDelegationCapabilityHealth(engine);
    expect(r.status).toBe('warn');
    expect(r.message).toMatch(/write-capable tool/);
    expect(r.message).toMatch(/bound_source_id unset/);
    expect(r.message).toMatch(/AUTHZ-INV-017/);
  });

  test('never returns status "fail" — all findings are warn-tier only', async () => {
    await insertClient({ clientId: 'a1', scope: 'read agent' });
    await insertClient({ clientId: 'a2', scope: 'read agent', boundTools: ['put_page'] });
    await insertJob('j1', []);
    const r = await checkDelegationCapabilityHealth(engine);
    expect(r.status).not.toBe('fail');
  });
});
