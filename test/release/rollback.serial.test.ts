/**
 * scripts/release/rollback.sh regression tests (dashboard-yct90).
 *
 * Only covers the "nothing to roll back to" contract (#13) — the
 * swap-and-restart-and-smoke-test success path shares its core logic
 * (atomic_symlink + service_stop/start + smoke-test.sh) with deploy.sh's
 * own inline auto-rollback, which test/release/deploy.serial.test.ts
 * already exercises against a real running release.
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { freshEnv, removeFreshEnv, runScript } from './fixtures';

const pendingEnvs: Array<{ root: string; homeParent: string }> = [];
afterEach(() => {
  for (const fe of pendingEnvs.splice(0)) {
    removeFreshEnv(fe);
  }
});

describe('rollback.sh', () => {
  test('fails cleanly when there is no current release at all', () => {
    const fe = freshEnv();
    const { root, env } = fe;
    pendingEnvs.push(fe);

    const result = runScript('rollback.sh', [], env, 15_000);
    expect(result.status).not.toBe(0);
    // die()/log() write to stdout (see lib.sh log()), not stderr.
    expect(result.stdout).toMatch(/no 'current' release exists/);
    // Not destructive: no current/previous created out of nothing.
    expect(existsSync(join(root, 'current'))).toBe(false);
    expect(existsSync(join(root, 'previous'))).toBe(false);
  });

  test('fails cleanly when current exists but there is no previous to roll back to', () => {
    const fe = freshEnv();
    const { root, env } = fe;
    pendingEnvs.push(fe);
    const releasesDir = join(root, 'releases');
    const releaseDir = join(releasesDir, '20260101000000-a');
    mkdirSync(releaseDir, { recursive: true });
    symlinkSync(releaseDir, join(root, 'current'));

    const result = runScript('rollback.sh', [], env, 15_000);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toMatch(/no 'previous' release exists/);
    // current untouched — still points at the same release.
    expect(existsSync(join(root, 'current'))).toBe(true);
    expect(existsSync(join(root, 'previous'))).toBe(false);
  });
});
