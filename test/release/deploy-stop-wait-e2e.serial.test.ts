/**
 * End-to-end disposable deploy simulation for Phase 3B-36 (deploy pipeline
 * stop/backup race hardening). Runs the REAL scripts/release/deploy.sh
 * against a disposable prod root, using makeSlowShutdownFixtureRelease's
 * fixture — a real HTTP server (bun, via Bun.serve) that answers
 * smoke-test.sh's actual checks (/health with matching version, /mcp and
 * /mcp-v2 both 401), unbinds its port IMMEDIATELY on TERM (mirroring the
 * real incident: the listener can drop before internal cleanup finishes),
 * and only deletes its `.gbrain-lock`/`postmaster.pid` files — then
 * actually exits — after a configurable delay.
 *
 * Verifies the exact required sequence end-to-end through the real script,
 * not a reimplementation:
 *   STOP REQUEST -> OLD PID STILL EXISTS -> WAIT -> OLD PID GONE -> BACKUP
 *   -> SWAP -> START -> SMOKE
 * with no backup-race failure, repeated across multiple sequential deploys.
 *
 * `.serial.test.ts`: real subprocesses, real TCP port.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { freshEnv, makeSlowShutdownFixtureRelease, runScript } from './fixtures';

const PORT = 18903;
const SHUTDOWN_DELAY_S = 1; // exceeds cp -a's near-instant duration on a tiny fixture dir many times over

function forceRemove(path: string): void {
  try {
    execFileSync('chmod', ['-R', 'u+w', path]);
  } catch {
    /* best effort */
  }
  rmSync(path, { recursive: true, force: true });
}

function killTestServicePid(root: string): void {
  const pidFile = join(root, 'shared', '.test-service.pid');
  if (!existsSync(pidFile)) return;
  const pid = parseInt(spawnSync('cat', [pidFile]).stdout.toString().trim(), 10);
  if (Number.isFinite(pid)) {
    spawnSync('kill', ['-9', String(pid)]);
  }
}

describe('deploy.sh end-to-end: repeated deploys against a genuinely slow-shutdown service', () => {
  let root: string;
  let dataDir: string;
  let homeParent: string;
  let env: Record<string, string>;
  const RUNS = 5;
  const releaseDirs: string[] = [];

  beforeAll(() => {
    const fe = freshEnv({ GBRAIN_HTTP_PORT: String(PORT) });
    root = fe.root;
    dataDir = fe.dataDir;
    homeParent = fe.homeParent;
    env = fe.env;
    mkdirSync(dataDir, { recursive: true });

    // RUNS + 1 distinct releases (unique timestamp-ish names) so every
    // deploy in the loop targets a genuinely new, never-yet-current release.
    for (let i = 0; i <= RUNS; i++) {
      const relDir = join(root, 'releases', `2026010100000${i}-slow0000${i}`);
      makeSlowShutdownFixtureRelease(relDir, {
        port: PORT,
        version: `0.0.${i}-fixture`,
        shutdownDelaySeconds: SHUTDOWN_DELAY_S,
      });
      releaseDirs.push(relDir);
    }
  }, 60_000);

  afterAll(() => {
    try {
      killTestServicePid(root);
    } catch {
      /* best effort */
    }
    try {
      forceRemove(root);
    } catch {
      /* best effort */
    }
    try {
      forceRemove(homeParent);
    } catch {
      /* best effort */
    }
  });

  test(`first deploy establishes release 0 as current (nothing running yet, no stop-wait needed)`, () => {
    const result = runScript(
      'deploy.sh',
      [releaseDirs[0]],
      { ...env, GBRAIN_SMOKE_MAX_WAIT: '10', GBRAIN_SMOKE_CONSECUTIVE_PASSES: '2' },
      30_000,
    );
    expect(result.status).toBe(0);
    expect(readlinkSync(join(root, 'current'))).toBe(releaseDirs[0]);
  }, 40_000);

  for (let i = 1; i <= RUNS; i++) {
    test(`deploy run ${i}/${RUNS}: stop (slow shutdown) -> wait -> backup -> swap -> start -> smoke, no race`, () => {
      const backupsBefore = readdirSync(join(root, 'shared', 'backups')).length;
      const start = Date.now();

      const result = runScript(
        'deploy.sh',
        [releaseDirs[i]],
        { ...env, GBRAIN_SMOKE_MAX_WAIT: '10', GBRAIN_SMOKE_CONSECUTIVE_PASSES: '2' },
        30_000,
      );
      const elapsedMs = Date.now() - start;

      // The whole deploy must SUCCEED — if the backup had raced the still-
      // shutting-down process (the old bug), cp -a would fail and deploy.sh
      // would abort well before ever reaching current -> new release.
      expect(result.status).toBe(0);
      expect(result.stdout + result.stderr).not.toMatch(/No such file or directory/);
      expect(readlinkSync(join(root, 'current'))).toBe(releaseDirs[i]);
      expect(readlinkSync(join(root, 'previous'))).toBe(releaseDirs[i - 1]);

      // A new backup was actually created (not skipped).
      const backupsAfter = readdirSync(join(root, 'shared', 'backups'));
      expect(backupsAfter.length).toBe(backupsBefore + 1);

      // Proves the wait genuinely happened — the whole deploy took at least
      // the shutdown delay (stop is not overlapping with backup/start).
      expect(elapsedMs).toBeGreaterThanOrEqual(SHUTDOWN_DELAY_S * 1000 * 0.8);

      // The backed-up data dir must NOT contain the transient lock files —
      // the fixture only deletes them once it's confirmed fully stopped, so
      // if the wait worked, they were already gone before cp -a ran.
      const newestBackup = backupsAfter
        .filter(b => !b.endsWith('.bak'))
        .sort()
        .pop()!;
      const backedUpFiles = readdirSync(join(root, 'shared', 'backups', newestBackup));
      expect(backedUpFiles).not.toContain('.gbrain-lock');
      expect(backedUpFiles).not.toContain('postmaster.pid');

      // Confirmed healthy via a real, independent HTTP check — not just
      // "symlink says so".
      const health = spawnSync('curl', ['-s', '-m', '3', `http://127.0.0.1:${PORT}/health`], { encoding: 'utf8' });
      expect(health.stdout).toMatch(new RegExp(`"version":"0\\.0\\.${i}-fixture"`));
    }, 40_000);
  }
});

describe('Phase 3B-36 failure injection', () => {
  test('shutdown never completes -> timeout, no backup created, no swap, current unchanged', () => {
    const PORT_A = PORT + 10;
    const fe = freshEnv({ GBRAIN_HTTP_PORT: String(PORT_A) });
    mkdirSync(fe.dataDir, { recursive: true });
    const releaseOld = join(fe.root, 'releases', '20260101000000-fi0001old');
    // Never exits on TERM within any reasonable test window.
    makeSlowShutdownFixtureRelease(releaseOld, { port: PORT_A, version: '0.0.old', shutdownDelaySeconds: 300 });
    const first = runScript(
      'deploy.sh',
      [releaseOld],
      { ...fe.env, GBRAIN_SMOKE_MAX_WAIT: '10', GBRAIN_SMOKE_CONSECUTIVE_PASSES: '2' },
      30_000,
    );
    expect(first.status).toBe(0);

    const releaseNew = join(fe.root, 'releases', '20260101000000-fi0001new');
    makeSlowShutdownFixtureRelease(releaseNew, { port: PORT_A, version: '0.0.new', shutdownDelaySeconds: 0 });
    const backupsBefore = readdirSync(join(fe.root, 'shared', 'backups')).length;

    const result = runScript(
      'deploy.sh',
      [releaseNew],
      { ...fe.env, GBRAIN_SERVICE_STOP_MAX_WAIT: '2', GBRAIN_SMOKE_MAX_WAIT: '5', GBRAIN_SMOKE_CONSECUTIVE_PASSES: '2' },
      20_000,
    );

    expect(result.status).toBe(3);
    expect(result.stdout + result.stderr).toMatch(/did not stop within timeout/);
    expect(result.stdout + result.stderr).toMatch(/Current release UNCHANGED/);
    // No backup/swap/migration happened.
    expect(readdirSync(join(fe.root, 'shared', 'backups')).length).toBe(backupsBefore);
    expect(readlinkSync(join(fe.root, 'current'))).toBe(releaseOld);
    expect(existsSync(join(fe.root, 'previous'))).toBe(false);

    killTestServicePid(fe.root);
    forceRemove(fe.root);
    forceRemove(fe.homeParent);
  }, 30_000);

  test('backup fails (permission denied) -> no swap, narrow auto-recovery restarts the unchanged release', () => {
    const PORT_B = PORT + 11;
    const fe = freshEnv({ GBRAIN_HTTP_PORT: String(PORT_B) });
    mkdirSync(fe.dataDir, { recursive: true });
    const releaseOld = join(fe.root, 'releases', '20260101000000-fi0002old');
    makeSlowShutdownFixtureRelease(releaseOld, { port: PORT_B, version: '0.0.oldb', shutdownDelaySeconds: 0 });
    const first = runScript(
      'deploy.sh',
      [releaseOld],
      { ...fe.env, GBRAIN_SMOKE_MAX_WAIT: '10', GBRAIN_SMOKE_CONSECUTIVE_PASSES: '2' },
      30_000,
    );
    expect(first.status).toBe(0);

    // Fail cp -a on the SOURCE side (an unreadable subdirectory inside the
    // data dir), not by making $SHARED_BACKUPS_DIR itself unwritable —
    // preflight.sh explicitly gates on backups-dir writability BEFORE
    // deploy.sh's own stop/backup logic ever runs, which would trip the
    // wrong failure path entirely (preflight FAILED, not a backup failure
    // during a real deploy attempt).
    const unreadableSub = join(fe.dataDir, 'unreadable_sub');
    mkdirSync(unreadableSub, { recursive: true });
    writeFileSync(join(unreadableSub, 'secret'), 'x');
    execFileSync('chmod', ['0000', unreadableSub]);

    const releaseNew = join(fe.root, 'releases', '20260101000000-fi0002new');
    makeSlowShutdownFixtureRelease(releaseNew, { port: PORT_B, version: '0.0.newb', shutdownDelaySeconds: 0 });

    let result;
    try {
      result = runScript(
        'deploy.sh',
        [releaseNew],
        { ...fe.env, GBRAIN_SMOKE_MAX_WAIT: '10', GBRAIN_SMOKE_CONSECUTIVE_PASSES: '2' },
        30_000,
      );
    } finally {
      execFileSync('chmod', ['0755', unreadableSub]);
    }

    expect(result.status).toBe(3);
    expect(result.stdout + result.stderr).toMatch(/backup failed/);
    expect(result.stdout + result.stderr).toMatch(/auto-recovery restarted the unchanged release .* confirmed healthy/);
    // current was never swapped to the new release.
    expect(readlinkSync(join(fe.root, 'current'))).toBe(releaseOld);

    // Really healthy, not just claimed — a real independent HTTP check.
    const health = spawnSync('curl', ['-s', '-m', '3', `http://127.0.0.1:${PORT_B}/health`], { encoding: 'utf8' });
    expect(health.stdout).toMatch(/"version":"0\.0\.oldb"/);

    killTestServicePid(fe.root);
    forceRemove(fe.root);
    forceRemove(fe.homeParent);
  }, 40_000);

  test('smoke test fails after swap, even against a slow-shutdown failed release -> existing automatic rollback still works', () => {
    const PORT_C = PORT + 12;
    const fe = freshEnv({ GBRAIN_HTTP_PORT: String(PORT_C) });
    mkdirSync(fe.dataDir, { recursive: true });
    const releaseGood = join(fe.root, 'releases', '20260101000000-fi0003good');
    makeSlowShutdownFixtureRelease(releaseGood, { port: PORT_C, version: '0.0.good', shutdownDelaySeconds: 0 });
    const first = runScript(
      'deploy.sh',
      [releaseGood],
      { ...fe.env, GBRAIN_SMOKE_MAX_WAIT: '10', GBRAIN_SMOKE_CONSECUTIVE_PASSES: '2' },
      30_000,
    );
    expect(first.status).toBe(0);

    // A fixture release that binds the port (so smoke-test.sh gets SOME
    // response, exercising the real rollback stop-wait path once it's
    // stopped) but never answers /health correctly — smoke-test.sh must
    // fail, triggering deploy.sh's own automatic rollback. Also has a
    // non-zero shutdown delay, so the rollback branch's own
    // service_stop_and_wait call is genuinely exercised, not a no-op.
    const releaseBad = join(fe.root, 'releases', '20260101000000-fi0003bad');
    makeSlowShutdownFixtureRelease(releaseBad, { port: PORT_C, version: '0.0.bad', shutdownDelaySeconds: 1, unhealthy: true });

    const result = runScript(
      'deploy.sh',
      [releaseBad],
      { ...fe.env, GBRAIN_SMOKE_MAX_WAIT: '5', GBRAIN_SMOKE_CONSECUTIVE_PASSES: '2' },
      30_000,
    );

    expect(result.status).toBe(2);
    expect(result.stdout + result.stderr).toMatch(/automatic rollback to .* SUCCEEDED/);
    expect(readlinkSync(join(fe.root, 'current'))).toBe(releaseGood);

    const health = spawnSync('curl', ['-s', '-m', '3', `http://127.0.0.1:${PORT_C}/health`], { encoding: 'utf8' });
    expect(health.stdout).toMatch(/"version":"0\.0\.good"/);

    killTestServicePid(fe.root);
    forceRemove(fe.root);
    forceRemove(fe.homeParent);
  }, 40_000);
});
