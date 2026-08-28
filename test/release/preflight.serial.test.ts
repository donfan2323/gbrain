/**
 * scripts/release/preflight.sh regression tests (dashboard-yct90).
 *
 * Uses hand-crafted fixture releases (fixtures.ts::makeFixtureRelease) —
 * preflight.sh's checksum/manifest verification is 100% mechanical and
 * doesn't care whether a release came from a real `bun install` or not.
 * The REAL build pipeline's compatibility with preflight.sh is proven
 * separately by deploy.serial.test.ts, which drives preflight.sh
 * indirectly against genuine build-release.sh output.
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { freshEnv, makeFixtureRelease, removeFreshEnv, runScript } from './fixtures';

const pendingEnvs: Array<{ root: string; homeParent: string }> = [];
afterEach(() => {
  for (const fe of pendingEnvs.splice(0)) {
    removeFreshEnv(fe);
  }
});

const PORT = 18901;

describe('preflight.sh', () => {
  test('a valid fixture release passes cleanly (control case)', () => {
    const fe = freshEnv({ GBRAIN_HTTP_PORT: String(PORT) });
    const { root, dataDir, env } = fe;
    pendingEnvs.push(fe);
    mkdirSync(dataDir, { recursive: true });
    const releaseDir = join(root, 'releases', '20260101000000-fixture');
    makeFixtureRelease(releaseDir, { port: PORT });

    const result = runScript('preflight.sh', [releaseDir], env, 20_000);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/preflight PASSED/);
  });

  test('rejects a release missing manifest.json', () => {
    const fe = freshEnv({ GBRAIN_HTTP_PORT: String(PORT) });
    const { root, dataDir, env } = fe;
    pendingEnvs.push(fe);
    mkdirSync(dataDir, { recursive: true });
    const releaseDir = join(root, 'releases', '20260101000000-fixture');
    makeFixtureRelease(releaseDir, { port: PORT });
    unlinkSync(join(releaseDir, 'manifest.json'));

    const result = runScript('preflight.sh', [releaseDir], env, 20_000);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toMatch(/missing manifest\.json/);
  });

  test('rejects a release missing bin/gbrain', () => {
    const fe = freshEnv({ GBRAIN_HTTP_PORT: String(PORT) });
    const { root, dataDir, env } = fe;
    pendingEnvs.push(fe);
    mkdirSync(dataDir, { recursive: true });
    const releaseDir = join(root, 'releases', '20260101000000-fixture');
    makeFixtureRelease(releaseDir, { port: PORT });
    unlinkSync(join(releaseDir, 'bin', 'gbrain'));

    const result = runScript('preflight.sh', [releaseDir], env, 20_000);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toMatch(/missing bin\/gbrain launcher/);
  });

  test('rejects a release whose app/src file was tampered with after building (checksum mismatch)', () => {
    const fe = freshEnv({ GBRAIN_HTTP_PORT: String(PORT) });
    const { root, dataDir, env } = fe;
    pendingEnvs.push(fe);
    mkdirSync(dataDir, { recursive: true });
    const releaseDir = join(root, 'releases', '20260101000000-fixture');
    makeFixtureRelease(releaseDir, { port: PORT });

    // Tamper app/src/cli.ts AFTER the fixture's checksums.txt/manifest were
    // computed — this must be caught by preflight's per-file verification.
    writeFileSync(join(releaseDir, 'app', 'src', 'cli.ts'), '// TAMPERED CONTENT\n');

    const result = runScript('preflight.sh', [releaseDir], env, 20_000);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toMatch(/checksum verification|CHECKSUM MISMATCH/);
  });

  test('rejects a release whose manifest port disagrees with GBRAIN_HTTP_PORT', () => {
    const fe = freshEnv({ GBRAIN_HTTP_PORT: String(PORT + 1) });
    const { root, dataDir, env } = fe;
    pendingEnvs.push(fe);
    mkdirSync(dataDir, { recursive: true });
    const releaseDir = join(root, 'releases', '20260101000000-fixture');
    // Fixture is built recording PORT, but GBRAIN_HTTP_PORT for this
    // preflight invocation is PORT + 1 — Caddy hardcodes the port, so this
    // must be rejected before ever being eligible for deploy.
    makeFixtureRelease(releaseDir, { port: PORT });

    const result = runScript('preflight.sh', [releaseDir], env, 20_000);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toMatch(/does not match configured GBRAIN_HTTP_PORT/);
  });
});
