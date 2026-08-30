/**
 * O-2 refresh audit: get_status_snapshot is admin-scope-gated at dispatch
 * (src/commands/serve-http.ts: hasScope(authInfo.scopes, op.scope ?? 'read')),
 * but its own handler runs an unscoped `SELECT ... FROM sources` with no
 * per-caller confinement — unlike get_stats/get_health/get_brain_identity,
 * which #4592 confined via diagnosticScope(ctx) in src/core/ops/admin.ts.
 *
 * This test proves, with real code (not just reading the source), exactly
 * where the caller-D (remote OAuth, read-only, no admin) protection lives:
 * the dispatch-layer scope gate, not the handler. It also documents (not
 * "fixes") the handler's residual unscoped behavior for any caller who DOES
 * hold admin scope — a real property of the current design (admin is the
 * documented "escape hatch for legacy + super-admin tokens", scope.ts:56),
 * not a caller-D-class bypass.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { hasScope } from '../src/core/scope.ts';

describe('get_status_snapshot admin-scope gate (dispatch-layer)', () => {
  test('a read-only remote grant cannot satisfy the admin requirement', () => {
    expect(hasScope(['read'], 'admin')).toBe(false);
  });
  test('a read+write remote grant still cannot satisfy the admin requirement', () => {
    expect(hasScope(['read', 'write'], 'admin')).toBe(false);
  });
  test('sources_admin alone does not imply admin (sibling, not parent)', () => {
    expect(hasScope(['sources_admin'], 'admin')).toBe(false);
  });
  test('an admin-scoped grant satisfies the admin requirement', () => {
    expect(hasScope(['admin'], 'admin')).toBe(true);
  });
});

describe('get_status_snapshot handler: residual unscoped source disclosure (documented, not fixed)', () => {
  let engine: PGLiteEngine;
  const SRCA = 'auditsrca';
  const SRCB = 'auditsrcb-secret-path-sentinel';

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite' } as never);
    await engine.initSchema();
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path) VALUES
         ('${SRCA}', 'Source A', NULL),
         ('${SRCB}', 'Source B SECRET', '/tmp/AUDIT_SECRET_PATH_SENTINEL')
       ON CONFLICT (id) DO NOTHING`,
    );
  }, 120_000);
  afterAll(async () => {
    await engine.disconnect();
  });

  test('handler discloses every source (id/name/local_path), unfiltered by ctx.sourceId or ctx.remote', async () => {
    const op = operationsByName.get_status_snapshot;
    expect(op).toBeDefined();
    // Simulate a caller who DID pass the dispatch-layer admin gate (the only
    // way to reach this handler at all) but whose intent is source-scoped —
    // ctx.remote=true, ctx.sourceId restricted to SRCA only.
    const ctx: OperationContext = {
      engine,
      remote: true,
      sourceId: SRCA,
      scopes: ['admin'],
    } as OperationContext;
    const result: any = await op!.handler(ctx);
    const ids = (result.sync?.sources ?? []).map((s: any) => s.source_id);
    // Documents current (v0.47.6) behavior: SRCB is visible even though the
    // context was source-scoped to SRCA. This is consistent with admin
    // being the "escape hatch" for legacy/super-admin tokens (scope.ts),
    // but is NOT source-scope-aware the way #4592's diagnosticScope is.
    expect(ids).toContain(SRCB);
    const srcBEntry = (result.sync?.sources ?? []).find((s: any) => s.source_id === SRCB);
    expect(srcBEntry.local_path).toBe('/tmp/AUDIT_SECRET_PATH_SENTINEL');
  });
});
