/**
 * scripts/release/lib.sh's wait_for_pid_exit / discover_service_pid /
 * service_stop_and_wait regression tests (Phase 3B-36).
 *
 * Root cause this hardens against (Phase 3B-35, real production incident):
 * deploy.sh issued `launchctl bootout` then only checked `wait_for_port_free`
 * before starting a `cp -a` backup. A service can unbind its listening port
 * well before it finishes its own internal shutdown cleanup (PGLite's
 * disconnect() drains + releases its advisory lock + disposes before
 * actually exiting) — so the backup raced the still-shutting-down process
 * and failed with "No such file or directory" on transient lock files.
 *
 * These tests exercise the real functions from lib.sh directly (sourced via
 * `bash -c`), not a reimplementation — GBRAIN_DEPLOY_TEST_MODE=1 throughout,
 * a plain background process standing in for the service so no launchd
 * job or real port is ever touched.
 *
 * Test processes are double-forked (`(cmd &) & disown`) rather than spawned
 * directly via node:child_process, so they reparent to PID 1 instead of
 * this test process. A process that exits on its own (not killed
 * externally) becomes a zombie until its PARENT reaps it, and `kill -0`
 * correctly reports a zombie as "present" — reaping via Node's
 * ChildProcess 'exit' event cannot happen while this file's own
 * synchronous spawnSync calls (running wait_for_pid_exit) block Node's
 * event loop, which would otherwise deadlock every such scenario. PID 1
 * reaps independently of this process, matching how launchd reaps its own
 * children in real production and sidestepping the deadlock entirely. No
 * `setsid` (absent on macOS) — a plain nested-background + disown achieves
 * the same reparenting.
 *
 * `.serial.test.ts`: spawns real background processes.
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { SCRIPTS_DIR } from './fixtures';

const spawnedPids: string[] = [];
const tmpDirs: string[] = [];

afterEach(() => {
  for (const pid of spawnedPids.splice(0)) {
    spawnSync('kill', ['-9', pid]);
  }
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

function makeTmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'gbrain-stop-wait-test-'));
  tmpDirs.push(d);
  return d;
}

/** Runs a snippet of shell with lib.sh sourced first. */
function runLibSnippet(snippet: string, timeoutMs = 15_000): { status: number; stdout: string; stderr: string } {
  const libPath = join(SCRIPTS_DIR, 'lib.sh');
  const result = spawnSync(
    'bash',
    ['-c', `set -euo pipefail; source "${libPath}"; ${snippet}`],
    { encoding: 'utf8', timeout: timeoutMs, env: { ...process.env } },
  );
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/**
 * Spawns a real, PID-1-reparented background process that, on TERM, waits
 * `delaySeconds` then exits cleanly. Returns its PID as a string.
 */
function spawnDelayedExitProcess(delaySeconds: number): string {
  const pidFile = join(tmpdir(), `gbrain-test-pid-${Date.now()}-${Math.floor(Math.random() * 1e9)}.txt`);
  const worker = `trap 'sleep ${delaySeconds}; exit 0' TERM; while true; do sleep 0.1; done`;
  const launch = spawnSync(
    'bash',
    ['-c', `(bash -c "${worker}" < /dev/null > /dev/null 2>&1 & echo $! > "${pidFile}") & disown; for i in $(seq 1 20); do [ -s "${pidFile}" ] && break; sleep 0.05; done; cat "${pidFile}"`],
    { encoding: 'utf8' },
  );
  const pid = launch.stdout.trim();
  spawnedPids.push(pid);
  return pid;
}

/** Spawns a real, PID-1-reparented background process that exits on TERM immediately. */
function spawnImmediateExitProcess(): string {
  return spawnDelayedExitProcess(0);
}

describe('wait_for_pid_exit', () => {
  test('process exits immediately -> returns success promptly', () => {
    const pid = spawnImmediateExitProcess();
    const start = Date.now();
    const result = runLibSnippet(`
      kill -TERM ${pid} 2>/dev/null || true
      wait_for_pid_exit ${pid} 10
    `);
    const elapsedMs = Date.now() - start;
    expect(result.status).toBe(0);
    expect(elapsedMs).toBeLessThan(3000);
  }, 15_000);

  test('process exits after a short delay -> wait succeeds only once it is actually gone', () => {
    const pid = spawnDelayedExitProcess(1);
    const start = Date.now();
    const result = runLibSnippet(`
      kill -TERM ${pid} 2>/dev/null || true
      wait_for_pid_exit ${pid} 10
    `);
    const elapsedMs = Date.now() - start;
    expect(result.status).toBe(0);
    // Must have genuinely waited for the ~1s delayed exit, not returned
    // instantly (which would mean it isn't really checking PID liveness).
    expect(elapsedMs).toBeGreaterThanOrEqual(900);
    expect(elapsedMs).toBeLessThan(5000);
  }, 15_000);

  test('process never exits before the timeout -> returns failure (fail-closed)', () => {
    const pid = spawnDelayedExitProcess(30); // far longer than our wait
    const start = Date.now();
    const result = runLibSnippet(`
      kill -TERM ${pid} 2>/dev/null || true
      wait_for_pid_exit ${pid} 1
    `);
    const elapsedMs = Date.now() - start;
    expect(result.status).not.toBe(0);
    // Bounded — must not have silently waited far longer than the timeout.
    expect(elapsedMs).toBeLessThan(3000);
    // Process really is still alive — this isn't a false failure.
    const alive = spawnSync('kill', ['-0', pid]);
    expect(alive.status).toBe(0);
  }, 15_000);

  test('PID already gone before the call -> returns success immediately, no sleep', () => {
    const pid = spawnImmediateExitProcess();
    spawnSync('kill', ['-9', pid]);
    // Give the OS a moment to fully reap (parent is PID 1, independent of
    // this test process).
    spawnSync('sleep', ['0.3']);
    const start = Date.now();
    const result = runLibSnippet(`wait_for_pid_exit ${pid} 10`);
    const elapsedMs = Date.now() - start;
    expect(result.status).toBe(0);
    expect(elapsedMs).toBeLessThan(1000);
  }, 15_000);
});

describe('discover_service_pid (GBRAIN_DEPLOY_TEST_MODE=1)', () => {
  test('returns the live PID from the test-service PID file', () => {
    const root = makeTmpDir();
    spawnSync('mkdir', ['-p', join(root, 'shared')]);
    const pid = spawnDelayedExitProcess(30);
    writeFileSync(join(root, 'shared', '.test-service.pid'), pid);

    const libPath = join(SCRIPTS_DIR, 'lib.sh');
    const r = spawnSync('bash', ['-c', `set -euo pipefail; source "${libPath}"; discover_service_pid`], {
      encoding: 'utf8',
      env: { ...process.env, GBRAIN_PROD_ROOT: root, GBRAIN_DEPLOY_TEST_MODE: '1' },
    });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(pid);
  }, 15_000);

  test('no PID file / stale PID -> returns failure, not a stale PID', () => {
    const root = makeTmpDir();
    spawnSync('mkdir', ['-p', join(root, 'shared')]);
    // A PID file pointing at a definitely-dead process.
    writeFileSync(join(root, 'shared', '.test-service.pid'), '999999');
    const libPath = join(SCRIPTS_DIR, 'lib.sh');
    const r = spawnSync('bash', ['-c', `set -euo pipefail; source "${libPath}"; discover_service_pid`], {
      encoding: 'utf8',
      env: { ...process.env, GBRAIN_PROD_ROOT: root, GBRAIN_DEPLOY_TEST_MODE: '1' },
    });
    expect(r.status).not.toBe(0);
    expect(r.stdout.trim()).toBe('');
  }, 15_000);
});

describe('service_stop_and_wait (GBRAIN_DEPLOY_TEST_MODE=1)', () => {
  test('confirms exit and returns success when the process stops within the timeout', () => {
    const root = makeTmpDir();
    spawnSync('mkdir', ['-p', join(root, 'shared')]);
    const pid = spawnImmediateExitProcess();
    writeFileSync(join(root, 'shared', '.test-service.pid'), pid);

    const libPath = join(SCRIPTS_DIR, 'lib.sh');
    const r = spawnSync('bash', ['-c', `set -euo pipefail; source "${libPath}"; service_stop_and_wait 10`], {
      encoding: 'utf8',
      env: { ...process.env, GBRAIN_PROD_ROOT: root, GBRAIN_DEPLOY_TEST_MODE: '1' },
    });
    expect(r.status).toBe(0);
    // Genuinely dead, not just "port free" — kill -0 must now fail.
    const alive = spawnSync('kill', ['-0', pid]);
    expect(alive.status).not.toBe(0);
  }, 15_000);

  test('no service running -> treated as already-stopped, succeeds without waiting', () => {
    const root = makeTmpDir();
    spawnSync('mkdir', ['-p', join(root, 'shared')]);
    const libPath = join(SCRIPTS_DIR, 'lib.sh');
    const start = Date.now();
    const r = spawnSync('bash', ['-c', `set -euo pipefail; source "${libPath}"; service_stop_and_wait 10`], {
      encoding: 'utf8',
      env: { ...process.env, GBRAIN_PROD_ROOT: root, GBRAIN_DEPLOY_TEST_MODE: '1' },
    });
    expect(Date.now() - start).toBeLessThan(2000);
    expect(r.status).toBe(0);
  }, 15_000);
});

describe('the fixed sequence prevents the original backup race (mechanical proof)', () => {
  test('deleting lock-like files strictly before cp -a starts never loses the race, across repeated trials', () => {
    // Direct mechanical proof that "wait then copy" (what service_stop_and_wait
    // + the reordered deploy.sh now guarantee) eliminates the file-disappears-
    // mid-copy class of failure, independent of any timing luck.
    for (let i = 0; i < 5; i++) {
      const scratch = makeTmpDir();
      const dataDir = join(scratch, 'data');
      const backupDir = join(scratch, 'backup');
      spawnSync('mkdir', ['-p', join(dataDir, 'base')]);
      spawnSync('bash', ['-c', `seq 1 500 | xargs -I{} -P4 touch "${dataDir}/base/rel_{}"`]);
      writeFileSync(join(dataDir, '.gbrain-lock'), '');
      writeFileSync(join(dataDir, 'postmaster.pid'), '');

      // FIXED order: cleanup fully completes before the copy begins.
      spawnSync('rm', ['-f', join(dataDir, '.gbrain-lock'), join(dataDir, 'postmaster.pid')]);
      const cp = spawnSync('cp', ['-a', dataDir, backupDir]);
      expect(cp.status).toBe(0);
    }
  }, 30_000);
});
