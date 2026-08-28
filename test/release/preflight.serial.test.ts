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
import { mkdirSync, unlinkSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { freshEnv, makeFixtureRelease, makeFixturePlist, removeFreshEnv, runScript } from './fixtures';

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

  // --- DCR-disabled deployment invariant (Phase 3B-34, Phase 17). Official
  // upstream's DCR registration path has no scope ceiling; official-first
  // does not carry the fork's DCR_ALLOWED_SCOPES source patch, so this
  // deployment-gate check is the entire control. Every scenario here uses
  // a fixture plist under the test's own fresh temp root — the real
  // production plist is never read, and GBRAIN_LAUNCHD_PLIST always points
  // at a throwaway fixture the test itself creates and owns.
  describe('DCR-disabled deployment invariant', () => {
    const FAKE_TOKEN = 'FIXTURE-TOKEN-MUST-NEVER-APPEAR-IN-PREFLIGHT-OUTPUT-9f2c';

    test('normal launch args (no --enable-dcr) → PASS', () => {
      const fe = freshEnv({ GBRAIN_HTTP_PORT: String(PORT) });
      const { root, dataDir, env } = fe;
      pendingEnvs.push(fe);
      mkdirSync(dataDir, { recursive: true });
      const releaseDir = join(root, 'releases', '20260101000000-fixture');
      makeFixtureRelease(releaseDir, { port: PORT });
      const plistPath = join(root, 'fixture.plist');
      makeFixturePlist(plistPath, { programArgs: ['/opt/gbrain/bin/gbrain', 'serve'], fakeToken: FAKE_TOKEN });

      const result = runScript('preflight.sh', [releaseDir], { ...env, GBRAIN_LAUNCHD_PLIST: plistPath }, 20_000);
      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/preflight PASSED/);
      expect(result.stdout).not.toContain(FAKE_TOKEN);
      expect(result.stderr).not.toContain(FAKE_TOKEN);
    });

    for (const [label, args] of [
      ['as the last argument', ['/opt/gbrain/bin/gbrain', 'serve', '--enable-dcr']],
      ['as the first argument', ['--enable-dcr', '/opt/gbrain/bin/gbrain', 'serve']],
      ['in the middle', ['/opt/gbrain/bin/gbrain', '--enable-dcr', 'serve']],
    ] as const) {
      test(`--enable-dcr present ${label} → FAIL CLOSED (no bypass by reordering)`, () => {
        const fe = freshEnv({ GBRAIN_HTTP_PORT: String(PORT) });
        const { root, dataDir, env } = fe;
        pendingEnvs.push(fe);
        mkdirSync(dataDir, { recursive: true });
        const releaseDir = join(root, 'releases', '20260101000000-fixture');
        makeFixtureRelease(releaseDir, { port: PORT });
        const plistPath = join(root, 'fixture.plist');
        makeFixturePlist(plistPath, { programArgs: args as unknown as string[], fakeToken: FAKE_TOKEN });
        const before = readFileSync(plistPath, 'utf8');

        const result = runScript('preflight.sh', [releaseDir], { ...env, GBRAIN_LAUNCHD_PLIST: plistPath }, 20_000);
        expect(result.status).not.toBe(0);
        expect(result.stdout).toMatch(/DCR enabled.*deployment blocked/);
        expect(result.stdout).not.toMatch(/preflight PASSED/);

        // No token exposure: the check reads ONLY :ProgramArguments, never
        // :EnvironmentVariables — the fake bootstrap token must never appear
        // in any output stream, pass or fail.
        expect(result.stdout).not.toContain(FAKE_TOKEN);
        expect(result.stderr).not.toContain(FAKE_TOKEN);

        // No mutation: Print-only, never Save — the fixture plist must be
        // byte-identical after the run.
        const after = readFileSync(plistPath, 'utf8');
        expect(after).toBe(before);
      });
    }

    test('a missing plist (no GBRAIN_LAUNCHD_PLIST target) is not itself a failure — the block is skipped, not fail-open on DCR', () => {
      // freshEnv()'s own default GBRAIN_LAUNCHD_PLIST already points at a
      // nonexistent path, matching the release environment's first-ever
      // deploy (no plist installed yet) — must not crash preflight.sh.
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
  });
});
