import { describe, expect, test, beforeAll, afterAll, beforeEach } from 'bun:test';
import { readFileSync } from 'node:fs';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { logGithubWebhookAudit } from '../src/commands/serve-http.ts';

/**
 * Phase 3B-7 — AUTHZ-INV-013, POST /webhooks/github.
 *
 * Historical Phase 9C (4a33a63e) precedent for this EXACT route audited
 * exactly 6 of its 13 terminal branches — missing_signature,
 * webhook_not_configured, the two signature-mismatch branches, sync-job
 * success, and sync-job queue-submission failure. The other 7 (event!=push
 * ignore, empty_body, malformed_json, missing_fields, source lookup_failed,
 * unknown_repo, ref_mismatch ignore) were deliberately excluded — they
 * either fire on unverified pre-HMAC-verification payload content or are
 * legitimate webhook-protocol no-ops. This port follows the same split.
 *
 * Actor: 'github-webhook', a fixed non-secret literal — AUTHZ-INV-010's own
 * source-of-truth text names this exact adapter shape (no principal/client
 * identification) as the documented exception; never invent a fake OAuth
 * client for it.
 *
 * Same two-proof-style structure as the /ingest, OAuth, and admin audit
 * coverage tests, for the same reason: test/sources-webhook.test.ts's own
 * doc comment says the handler "is hard to invoke without bringing up the
 * full Express app," and no DATABASE_URL-gated E2E exists for this route
 * yet either.
 */

let engine: PGLiteEngine;

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
});

async function readWebhookAuditRows(): Promise<Array<Record<string, unknown>>> {
  return engine.executeRaw<Record<string, unknown>>(
    `SELECT token_name, agent_name, operation, latency_ms, status, error_message, params
       FROM mcp_request_log WHERE operation = 'webhooks_github' ORDER BY id ASC`,
  );
}

describe('AUTHZ-INV-013: logGithubWebhookAudit() payload shape', () => {
  test('GH-A1: a valid, signed, supported webhook writes exactly one success row', async () => {
    await logGithubWebhookAudit(engine, { status: 'success', target: 'source-uuid-1', latencyMs: 4 });
    const rows = await readWebhookAuditRows();
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe('success');
    expect((rows[0].params as any)?.target).toBe('source-uuid-1');
  });

  test('GH-A2/GH-A3: signature denial is audited with a fixed reason, no signature value present', async () => {
    await logGithubWebhookAudit(engine, { status: 'denied', reason: 'signature_mismatch', target: 'source-uuid-2', latencyMs: 1 });
    await logGithubWebhookAudit(engine, { status: 'denied', reason: 'missing_signature', latencyMs: 1 });
    const rows = await readWebhookAuditRows();
    expect(rows.find(r => r.error_message === 'signature_mismatch')).toBeTruthy();
    const missingSigRow = rows.find(r => r.error_message === 'missing_signature');
    expect(missingSigRow).toBeTruthy();
    expect((missingSigRow!.params as any)).toBeNull(); // no source resolved yet at this point in the handler
  });

  test('GH-A6: a downstream (queue submission) failure is audited as error, with an internal (not GitHub-controlled) message', async () => {
    await logGithubWebhookAudit(engine, {
      status: 'error', reason: 'queue_submission_failed: connection reset', target: 'source-uuid-3', latencyMs: 2,
    });
    const rows = await readWebhookAuditRows();
    expect(rows[0].status).toBe('error');
    expect(rows[0].error_message).toBe('queue_submission_failed: connection reset');
  });

  test('GH-A7/GH-A8: no secrets — audit rows never contain a webhook-secret- or signature-shaped marker, or raw body content', async () => {
    const FAKE_WEBHOOK_SECRET = 'XPROBE_WEBHOOK_SECRET_MARKER_9f8e7d6c5b4a';
    const FAKE_SIGNATURE = 'sha256=XPROBE_SIGNATURE_HEX_MARKER_1a2b3c4d5e6f';
    const FAKE_COMMIT_MESSAGE = 'XPROBE_COMMIT_MESSAGE_BODY_CONTENT_MARKER';
    const FAKE_REPO_FULLNAME = 'xprobe-org/xprobe-repo-marker';
    await logGithubWebhookAudit(engine, { status: 'success', target: 'source-uuid-4', latencyMs: 3 });
    await logGithubWebhookAudit(engine, { status: 'denied', reason: 'signature_mismatch', target: 'source-uuid-4', latencyMs: 1 });
    await logGithubWebhookAudit(engine, { status: 'error', reason: 'queue_submission_failed: db down', target: 'source-uuid-4', latencyMs: 1 });
    const rows = await readWebhookAuditRows();
    const serialized = JSON.stringify(rows);
    for (const marker of [FAKE_WEBHOOK_SECRET, FAKE_SIGNATURE, FAKE_COMMIT_MESSAGE, FAKE_REPO_FULLNAME]) {
      expect(serialized).not.toContain(marker);
    }
    expect(serialized).not.toMatch(/^sha256=/);
  });

  test('GH-A9: exactly-once — one call writes exactly one row', async () => {
    await logGithubWebhookAudit(engine, { status: 'success', target: 'source-uuid-5', latencyMs: 1 });
    const rows = await readWebhookAuditRows();
    expect(rows.length).toBe(1);
  });

  test('actor is always the fixed literal github-webhook, never a repository name or delivery ID', async () => {
    await logGithubWebhookAudit(engine, { status: 'success', target: 'source-uuid-6', latencyMs: 1 });
    const rows = await readWebhookAuditRows();
    expect(rows[0].token_name).toBe('github-webhook');
    expect(rows[0].agent_name).toBe('github-webhook');
  });

  test('write failure is swallowed (best-effort, does not throw)', async () => {
    const brokenEngine = { executeRaw: async () => { throw new Error('no db'); } } as unknown as PGLiteEngine;
    await expect(
      logGithubWebhookAudit(brokenEngine, { status: 'error', reason: 'x', latencyMs: 0 }),
    ).resolves.toBeUndefined();
  });
});

describe('AUTHZ-INV-013: POST /webhooks/github wires logGithubWebhookAudit at exactly the historically-scoped 6 branches', () => {
  const SERVE_HTTP_PATH = new URL('../src/commands/serve-http.ts', import.meta.url).pathname;
  const source = readFileSync(SERVE_HTTP_PATH, 'utf8');

  function webhookRouteBody(): string {
    const startIdx = source.indexOf("'/webhooks/github',");
    expect(startIdx).toBeGreaterThan(-1);
    const endIdx = source.indexOf('// Start server', startIdx);
    expect(endIdx).toBeGreaterThan(startIdx);
    return source.slice(startIdx, endIdx);
  }

  const body = webhookRouteBody();

  test('GH-A2: missing-signature 401 is audited', () => {
    const idx = body.indexOf("json({ error: 'missing_signature'");
    expect(idx).toBeGreaterThan(-1);
    expect(body.slice(Math.max(0, idx - 250), idx)).toContain('logGithubWebhookAudit(');
  });

  test('signature-mismatch (both branches) and webhook_not_configured 401s are audited', () => {
    const positions: number[] = [];
    let m: RegExpExecArray | null;
    const regex = /res\.status\(401\)/g;
    while ((m = regex.exec(body)) !== null) positions.push(m.index);
    expect(positions.length).toBeGreaterThanOrEqual(3); // missing_signature, webhook_not_configured, x2 signature_mismatch = 4 total 401s
    for (const pos of positions) {
      expect(body.slice(Math.max(0, pos - 350), pos)).toContain('logGithubWebhookAudit(');
    }
  });

  test('GH-A1: sync-job success (202 with job_id) is audited', () => {
    const idx = body.indexOf('json({ job_id: job.id, source_id: source.id })');
    expect(idx).toBeGreaterThan(-1);
    expect(body.slice(Math.max(0, idx - 250), idx)).toContain('logGithubWebhookAudit(');
  });

  test('GH-A6: queue-submission-failure 500 is audited', () => {
    const idx = body.indexOf("json({ error: 'queue_submission_failed'");
    expect(idx).toBeGreaterThan(-1);
    expect(body.slice(Math.max(0, idx - 300), idx)).toContain('logGithubWebhookAudit(');
  });

  test('GH-A5: intentional protocol no-ops (event!=push, ref_mismatch) are NOT audited — matches historical, avoids noise/spoofable-content audit entries', () => {
    const eventIgnoreIdx = body.indexOf("json({ status: 'ignored', reason: `event=");
    expect(eventIgnoreIdx).toBeGreaterThan(-1);
    expect(body.slice(Math.max(0, eventIgnoreIdx - 200), eventIgnoreIdx)).not.toContain('logGithubWebhookAudit(');

    const refMismatchIdx = body.indexOf("reason: `ref_mismatch`");
    expect(refMismatchIdx).toBeGreaterThan(-1);
    expect(body.slice(Math.max(0, refMismatchIdx - 200), refMismatchIdx)).not.toContain('logGithubWebhookAudit(');
  });

  test('unverified-payload validation branches (empty_body, malformed_json, missing_fields, unknown_repo, lookup_failed) are NOT audited — matches historical', () => {
    for (const marker of ["error: 'empty_body'", "error: 'malformed_json'", "error: 'missing_fields'", "error: 'unknown_repo'", "error: 'lookup_failed'"]) {
      const idx = body.indexOf(marker);
      expect(idx, `expected to find branch: ${marker}`).toBeGreaterThan(-1);
      expect(body.slice(Math.max(0, idx - 150), idx), `${marker} should NOT be audited`).not.toContain('logGithubWebhookAudit(');
    }
  });

  test('total logGithubWebhookAudit call count is exactly 6, matching the historically-scoped branch set', () => {
    const count = (body.match(/logGithubWebhookAudit\(/g) ?? []).length;
    expect(count).toBe(6);
  });

  test('no call site passes req, headers, body, payload, or signature to the audit helper', () => {
    const callSites = body.match(/await logGithubWebhookAudit\(engine, \{[\s\S]{0,200}?\}\);/g) ?? [];
    expect(callSites.length).toBe(6);
    for (const site of callSites) {
      expect(site).not.toMatch(/\breq\b/);
      expect(site).not.toMatch(/\bpayload\b/);
      expect(site).not.toMatch(/\bsigHeader\b/);
      expect(site).not.toMatch(/\bsecret\b/);
      expect(site).not.toMatch(/\bcfg\b/);
    }
  });
});
