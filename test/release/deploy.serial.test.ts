/**
 * scripts/release/deploy.sh regression tests (dashboard-yct90).
 *
 * The heaviest file in test/release/ — builds two REAL releases (A, B) via
 * build-release.sh and actually initializes + serves a real gbrain PGLite
 * instance in GBRAIN_DEPLOY_TEST_MODE=1 (background process, no launchd),
 * so deploy.sh's atomic-swap / preflight / smoke-test / auto-rollback logic
 * is exercised end-to-end against the real thing, not a stand-in. Failure
 * scenarios use a lightweight hand-crafted fixture release (never a real
 * `bun install`) whose `serve` intentionally hangs forever without binding
 * the port — see fixtures.ts::makeFixtureRelease for why that's enough to
 * prove deploy.sh's OWN rollback logic without needing a second real build.
 *
 * `.serial.test.ts`: real subprocesses, real TCP port, a real background
 * service process tracked via PID file — must not run concurrently with
 * anything else touching the same port.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import {
  createIsolatedWorktree,
  freshEnv,
  makeFixtureRelease,
  removeIsolatedWorktree,
  runScript,
  type IsolatedWorktree,
} from './fixtures';

const PORT = 18902;

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
  const pid = parseInt(readFileSync(pidFile, 'utf8').trim(), 10);
  if (Number.isFinite(pid)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already dead */
    }
  }
}

describe('deploy.sh', () => {
  let root: string;
  let dataDir: string;
  let homeParent: string;
  let env: Record<string, string>;
  let releaseA: string;
  let releaseB: string;
  let repoWt: IsolatedWorktree;

  beforeAll(() => {
    const fe = freshEnv({ GBRAIN_HTTP_PORT: String(PORT) });
    root = fe.root;
    dataDir = fe.dataDir;
    homeParent = fe.homeParent;
    env = fe.env;

    // build-release.sh's dirty-tree gate checks whatever GBRAIN_REPO_ROOT
    // resolves to; pointing it at a private worktree (rather than the
    // default, the shared repo checkout) means these builds are immune to
    // another test file's temporary edits, or ordinary in-progress local
    // edits, to the real working tree.
    repoWt = createIsolatedWorktree('gbrain-deploy-test-repo-');
    env = { ...env, GBRAIN_REPO_ROOT: repoWt.path };

    const buildA = runScript('build-release.sh', [], env, 90_000);
    if (buildA.status !== 0) {
      throw new Error(`build A failed: ${buildA.stdout}\n${buildA.stderr}`);
    }
    releaseA = buildA.stdout.trim().split('\n').pop()!;

    // release_name is second-granularity timestamp + git-short-sha; since
    // HEAD doesn't change between these two builds, they'd collide (and
    // build-release.sh would refuse to overwrite) without a >1s gap.
    spawnSync('sleep', ['1.5']);

    const buildB = runScript('build-release.sh', [], env, 90_000);
    if (buildB.status !== 0) {
      throw new Error(`build B failed: ${buildB.stdout}\n${buildB.stderr}`);
    }
    releaseB = buildB.stdout.trim().split('\n').pop()!;
    expect(releaseB).not.toBe(releaseA);

    // Real data dir init (gotcha #2: creates .gbrain under GBRAIN_HOME
    // itself — GBRAIN_HOME here is homeParent, the PARENT of dataDir).
    const init = spawnSync('bash', ['-c', `"${releaseA}/bin/gbrain" init --pglite --no-embedding --non-interactive`], {
      env: { ...process.env, GBRAIN_HOME: homeParent },
      encoding: 'utf8',
      timeout: 60_000,
    });
    if (init.status !== 0) {
      throw new Error(`gbrain init failed: ${init.stdout}\n${init.stderr}`);
    }
    expect(existsSync(dataDir)).toBe(true);
  }, 180_000);

  afterAll(() => {
    // Each step runs independently — an exception from an earlier step (e.g.
    // forceRemove hitting a file a just-killed process hasn't fully released
    // yet) must never skip a later one, or cleanup silently leaks state
    // (observed: a leaked `git worktree` registration when this was a
    // straight-line sequence).
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
    try {
      removeIsolatedWorktree(repoWt);
    } catch {
      /* best effort */
    }
  });

  test('first deploy: current -> A, no previous release exists', () => {
    const result = runScript('deploy.sh', [releaseA], env, 60_000);
    expect(result.status).toBe(0);
    expect(readlinkSync(join(root, 'current'))).toBe(releaseA);
    expect(existsSync(join(root, 'previous'))).toBe(false);
  }, 90_000);

  test('second deploy: current -> B, previous -> A', () => {
    const result = runScript('deploy.sh', [releaseB], env, 60_000);
    expect(result.status).toBe(0);
    expect(readlinkSync(join(root, 'current'))).toBe(releaseB);
    expect(readlinkSync(join(root, 'previous'))).toBe(releaseA);
  }, 90_000);

  test('a smoke-test failure triggers automatic rollback to the prior current (exit 2)', () => {
    // Current is B (real, healthy, running) after the previous test. Deploy
    // a fixture release whose `serve` never responds — smoke-test.sh must
    // fail, and deploy.sh must roll back to B automatically.
    const releaseF = join(root, 'releases', '20260101000000-fake0001');
    makeFixtureRelease(releaseF, { port: PORT });

    const result = runScript(
      'deploy.sh',
      [releaseF],
      { ...env, GBRAIN_SMOKE_MAX_WAIT: '8', GBRAIN_SMOKE_CONSECUTIVE_PASSES: '2' },
      60_000,
    );
    expect(result.status).toBe(2);
    expect(result.stdout + result.stderr).toMatch(/automatic rollback to .* SUCCEEDED/);

    // Rolled back to B (the current release BEFORE this failed attempt).
    expect(readlinkSync(join(root, 'current'))).toBe(releaseB);

    // Confirmed healthy afterward — not just "symlink says so".
    const health = spawnSync('curl', ['-s', '-m', '3', `http://127.0.0.1:${PORT}/health`], {
      encoding: 'utf8',
    });
    expect(health.stdout).toMatch(/"status":"ok"/);
  }, 90_000);

  test('no previous release to roll back to: first-ever deploy failing smoke test dies with exit 3, current left on the failed release', () => {
    const fe2 = freshEnv({ GBRAIN_HTTP_PORT: String(PORT + 1) });
    // preflight.sh requires GBRAIN_DATA_DIR to already exist; this fixture's
    // `serve` never touches it (hangs immediately), so no real init needed.
    mkdirSync(fe2.dataDir, { recursive: true });
    const releaseFp = join(fe2.root, 'releases', '20260101000000-fake0002');
    makeFixtureRelease(releaseFp, { port: PORT + 1 });

    const result = runScript(
      'deploy.sh',
      [releaseFp],
      { ...fe2.env, GBRAIN_SMOKE_MAX_WAIT: '4', GBRAIN_SMOKE_CONSECUTIVE_PASSES: '2' },
      30_000,
    );
    expect(result.status).toBe(3);
    expect(result.stdout + result.stderr).toMatch(/no previous release/);
    expect(readlinkSync(join(fe2.root, 'current'))).toBe(releaseFp);
    expect(existsSync(join(fe2.root, 'previous'))).toBe(false);

    killTestServicePid(fe2.root);
    forceRemove(fe2.root);
    forceRemove(fe2.homeParent);
  }, 40_000);

  test('refuses a second concurrent deploy while the lock is held by a live process', () => {
    const fe3 = freshEnv({ GBRAIN_HTTP_PORT: String(PORT + 2) });
    const lockDir = join(fe3.root, '.deploy-lock');
    mkdirSync(lockDir, { recursive: true });

    // A real, live long-sleeping process stands in for "another deploy in
    // progress" — acquire_deploy_lock's staleness check is `kill -0 <pid>`.
    const holder = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
    writeFileSync(join(lockDir, 'pid'), String(holder.pid));

    try {
      const result = runScript(
        'deploy.sh',
        ['some-release-name-that-need-not-exist'],
        { ...fe3.env, GBRAIN_DEPLOY_LOCK_MAX_TRIES: '2', GBRAIN_DEPLOY_LOCK_SLEEP: '0' },
        15_000,
      );
      expect(result.status).not.toBe(0);
      // Message unified in lib.sh's shared acquire_deploy_lock (previously
      // duplicated per-script with slightly different wording) — asserting
      // on the "refusing" verb + "concurrent"/"progress" framing rather
      // than the exact pre-refactor string.
      expect(result.stdout + result.stderr).toMatch(/refusing to run concurrently|already.*in progress/);
      // Lock dir left in place (not silently removed out from under the
      // "other" in-progress deploy).
      expect(existsSync(lockDir)).toBe(true);
    } finally {
      try {
        holder.kill('SIGKILL');
      } catch {
        /* already dead */
      }
      forceRemove(fe3.root);
      forceRemove(fe3.homeParent);
    }
  }, 20_000);
});
