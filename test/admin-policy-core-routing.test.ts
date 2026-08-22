import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

/**
 * Phase 3B-3 — AUTHZ-INV-010 (protocol adapters must not complete their own
 * final allow/deny decision; they must route it through the shared Policy
 * Decision function). Reimplements the intent of historical commit 7fa7cc7f
 * ("route admin session auth through the shared Policy Decision core") on
 * current architecture.
 *
 * Historical finding, re-confirmed here: `requireAdmin` is a closure defined
 * inside `runServeHttp()`'s function body, not independently exported, and
 * the existing admin HTTP integration tests (admin-embed-spawn.serial.test.ts)
 * exercise the real server via `Bun.spawn` — a genuine subprocess boundary
 * `bun:test`'s `mock.module` cannot intercept. A live-request test spying on
 * `hasScope()` was considered and rejected for the same reason history
 * rejected it: an established admin session always resolves to the literal
 * scope 'admin' (the strongest/catch-all scope — scope.ts's IMPLIES table),
 * so there is no existing seam through which a real request could observe a
 * denial without inventing new admin-route scope granularity, which is out
 * of scope for this task (Phase 3B-3 explicitly forbids inventing new
 * capability models). This file follows the same static-source-proof
 * pattern the historical `authorization-invariant-matrix.test.ts` used for
 * the identical reason.
 */

const SERVE_HTTP_PATH = new URL('../src/commands/serve-http.ts', import.meta.url).pathname;
const source = readFileSync(SERVE_HTTP_PATH, 'utf8');

function extractRequireAdminBody(src: string): string {
  const match = src.match(/function requireAdmin\([^)]*\)[^{]*\{([\s\S]*?)\n  \}/);
  if (!match) throw new Error('requireAdmin() not found in serve-http.ts — has it been renamed or moved?');
  return match[1];
}

describe('AUTHZ-INV-010: requireAdmin() routes its final allow/deny decision through the shared Policy Decision function', () => {
  test('ADMIN-1: requireAdmin() body calls hasScope() — not just a bare adminSessions membership+expiry check', () => {
    const body = extractRequireAdminBody(source);
    expect(body).toContain('adminSessions'); // sanity: we captured the real body
    expect(/\bhasScope\s*\(/.test(body)).toBe(true);
  });

  test('ADMIN-2: requireAdmin() checks the shared decision\'s result and only calls next() when it is true', () => {
    const body = extractRequireAdminBody(source);
    const hasScopeCallIndex = body.search(/\bhasScope\s*\(/);
    const allowedCheckIndex = body.search(/if\s*\(\s*!\s*allowed\b/);
    const nextIndex = body.lastIndexOf('next()');
    expect(hasScopeCallIndex).toBeGreaterThan(-1);
    expect(allowedCheckIndex).toBeGreaterThan(-1);
    expect(nextIndex).toBeGreaterThan(-1);
    // The hasScope() call, then the allowed check, then next() — in that order.
    expect(hasScopeCallIndex).toBeLessThan(allowedCheckIndex);
    expect(allowedCheckIndex).toBeLessThan(nextIndex);
  });

  test('ADMIN-3: unauthenticated/expired-session denial branches are unchanged (still 401, still return before next())', () => {
    const body = extractRequireAdminBody(source);
    expect(body).toMatch(/status\(401\)\.json\(\{\s*error:\s*'Admin authentication required'\s*\}\)/);
    expect(body).toMatch(/status\(401\)\.json\(\{\s*error:\s*'Session expired'\s*\}\)/);
  });

  test('ADMIN-4: requireAdmin() uses the SAME hasScope binding as the MCP tool-call dispatch path (genuinely shared, not a second copy)', () => {
    // scope.ts's hasScope is imported exactly once, module-level — every
    // call site (requireAdmin, ListTools filter, CallTool enforcement)
    // necessarily resolves to the same function reference.
    const importLines = source.match(/^import\s*\{[^}]*\}\s*from\s*'\.\.\/core\/scope\.ts';?$/m);
    expect(importLines).not.toBeNull();
    expect(importLines![0]).toMatch(/\bhasScope\b/);
    const hasScopeImportCount = (source.match(/from\s*['"].*\/scope\.ts['"]/g) ?? []).length;
    expect(hasScopeImportCount).toBe(1); // one import site => one binding, no parallel reimplementation
  });

  test('ADMIN-5: the shared-decision denial branch returns 403 Forbidden', () => {
    const body = extractRequireAdminBody(source);
    expect(body).toMatch(/status\(403\)\.json\(\{\s*error:\s*'Forbidden'\s*\}\)/);
  });
});

describe('AUTHZ-INV-010: exhaustive admin-route coverage — every privileged /admin/api route (and /admin/events) is requireAdmin-gated', () => {
  // The 3 routes that MUST NOT be gated — they're the login flow itself
  // (issuing/consuming the very credential requireAdmin checks).
  const LOGIN_FLOW_EXEMPT = new Set(['/admin/login', '/admin/api/issue-magic-link', '/admin/auth/:token']);

  test('every app.<method>(\'/admin/...\', ...) route registration either is the login flow or includes requireAdmin', () => {
    const routeCallRegex = /app\.(get|post|put|delete|patch)\(\s*'(\/admin\/[^']*)'\s*,\s*([^)]*)\)/g;
    const found: Array<{ method: string; path: string; args: string }> = [];
    let m: RegExpExecArray | null;
    while ((m = routeCallRegex.exec(source)) !== null) {
      found.push({ method: m[1], path: m[2], args: m[3] });
    }
    // Sanity: we actually found routes, and specifically found the known
    // privileged ones — an empty/short list would mean the regex silently
    // stopped matching (e.g. after a serve-http.ts refactor) and this test
    // would otherwise pass vacuously.
    expect(found.length).toBeGreaterThanOrEqual(19);
    expect(found.some(r => r.path === '/admin/api/revoke-client')).toBe(true);
    expect(found.some(r => r.path === '/admin/api/register-client')).toBe(true);

    const unguarded = found.filter(
      r => !LOGIN_FLOW_EXEMPT.has(r.path) && !/^\/admin\/\{\*path\}$/.test(r.path) && !r.args.includes('requireAdmin'),
    );
    expect(unguarded).toEqual([]);
  });

  test('the two static-asset catchall routes (/admin/{*path}) are not treated as privileged (they explicitly defer /admin/api/*, /admin/events, /admin/login to their own gated/exempt handlers)', () => {
    const catchallBlocks = source.match(/app\.get\('\/admin\/\{\*path\}'[\s\S]{0,300}/g) ?? [];
    expect(catchallBlocks.length).toBeGreaterThanOrEqual(1);
    for (const block of catchallBlocks) {
      expect(block).toMatch(/req\.path\.startsWith\('\/admin\/api\/'\)/);
    }
  });
});
