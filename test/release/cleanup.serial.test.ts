/**
 * scripts/release/cleanup.sh regression tests (dashboard-yct90).
 *
 * cleanup.sh only inspects directory NAMES under releases/ (mindepth 1,
 * maxdepth 1, not `.staging.*`) and re-resolves current/previous via
 * realpath at delete time — it never preflights a release's contents. So
 * every fixture here is a bare directory with one marker file, no manifest
 * needed. Cheap: no subprocess spawning of gbrain, no bun install.
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { freshEnv, removeFreshEnv, runScript } from './fixtures';

const pendingEnvs: Array<{ root: string; homeParent: string }> = [];

function makeReleaseStub(releasesDir: string, name: string): string {
  const dir = join(releasesDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'marker.txt'), name);
  return dir;
}

afterEach(() => {
  for (const fe of pendingEnvs.splice(0)) {
    removeFreshEnv(fe);
  }
});

describe('cleanup.sh', () => {
  test('never deletes whatever current/previous resolve to, regardless of age', () => {
    const fe = freshEnv();
    const { root, env } = fe;
    pendingEnvs.push(fe);
    const releasesDir = join(root, 'releases');
    // Oldest-first lexical names (timestamp-like prefixes).
    const names = ['20260101000000-a', '20260102000000-b', '20260103000000-c', '20260104000000-d'];
    for (const n of names) makeReleaseStub(releasesDir, n);

    // Point current/previous at the two OLDEST releases on purpose — the
    // exact scenario that must survive `--max-keep 1`.
    symlinkSync(join(releasesDir, names[0]), join(root, 'previous'));
    symlinkSync(join(releasesDir, names[1]), join(root, 'current'));

    const result = runScript('cleanup.sh', ['--max-keep', '1', '--apply'], env, 30_000);
    expect(result.status).toBe(0);

    // Protected releases survive even though they're the two oldest.
    expect(existsSync(join(releasesDir, names[0]))).toBe(true);
    expect(existsSync(join(releasesDir, names[1]))).toBe(true);
    // Newest (within max-keep window) survives too.
    expect(existsSync(join(releasesDir, names[3]))).toBe(true);
    // The only non-protected, non-newest release is deleted.
    expect(existsSync(join(releasesDir, names[2]))).toBe(false);
  });

  test('dry-run (no --apply) deletes nothing', () => {
    const fe = freshEnv();
    const { root, env } = fe;
    pendingEnvs.push(fe);
    const releasesDir = join(root, 'releases');
    const names = ['20260101000000-a', '20260102000000-b', '20260103000000-c'];
    for (const n of names) makeReleaseStub(releasesDir, n);

    const result = runScript('cleanup.sh', ['--max-keep', '1'], env, 30_000);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/DRY-RUN/);
    for (const n of names) {
      expect(existsSync(join(releasesDir, n))).toBe(true);
    }
  });
});
