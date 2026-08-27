/**
 * scripts/release/build-release.sh regression tests (dashboard-yct90).
 *
 * These tests temporarily edit README.md (a tracked file) to exercise the
 * dirty-tree gate and the secret scanner against a real `git diff HEAD` —
 * `git archive HEAD` only ever emits COMMITTED content (see
 * build-release.sh's own header comment), so a secret injected only into an
 * uncommitted edit can never leak into app/src itself; it can only ever
 * reach the built artifact via `source.diff` (git diff HEAD, captured
 * verbatim) when `--allow-dirty` is used. That's exactly what the secret-
 * rejection test below exploits, without ever committing anything.
 *
 * The edit happens inside a PRIVATE `git worktree` (createIsolatedWorktree),
 * not the shared repo checkout — build-release.sh is pointed at it via
 * GBRAIN_REPO_ROOT. This is what makes the file `.serial.test.ts`-safe
 * without actually needing cross-file serialization: it no longer shares
 * any mutable state with deploy.serial.test.ts (whose own build-release.sh
 * calls use their own separate isolated worktree) or with the developer's
 * own in-progress edits to the real checkout.
 *
 * Every edit here is reverted in a `finally` block and verified via a real
 * `git diff HEAD` before AND after, per this repo's git-safety norms — no
 * `git checkout`/`git restore`/`git reset` is ever used (those are also the
 * literal strings build-release.sh itself must never use).
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  createIsolatedWorktree,
  freshEnv,
  nodeModulesDigestSync,
  readManifest,
  removeFreshEnv,
  removeIsolatedWorktree,
  runScript,
  type IsolatedWorktree,
} from './fixtures';

let repoWt: IsolatedWorktree;
let README_PATH: string;

beforeAll(() => {
  repoWt = createIsolatedWorktree('gbrain-buildrelease-test-repo-');
  README_PATH = join(repoWt.path, 'README.md');
});

afterAll(() => {
  removeIsolatedWorktree(repoWt);
});

/**
 * Mirrors build-release.sh's OWN dirty-tree check exactly (`git diff --quiet
 * HEAD --`) — i.e. tracked-file modifications only, against the isolated
 * worktree.
 */
function trackedDiffFromHead(): string {
  return execFileSync('git', ['diff', 'HEAD', '--'], { cwd: repoWt.path, encoding: 'utf8' });
}

/** Appends `line` to README.md, returns a restore function. Verifies clean before editing. */
function withTemporaryReadmeEdit<T>(line: string, fn: () => T): T {
  const before = trackedDiffFromHead();
  expect(before).toBe(''); // must start from a clean tracked-file state
  const original = readFileSync(README_PATH, 'utf8');
  writeFileSync(README_PATH, original + line);
  try {
    return fn();
  } finally {
    writeFileSync(README_PATH, original);
    const after = trackedDiffFromHead();
    expect(after).toBe('');
  }
}

const pendingEnvs: Array<{ root: string; homeParent: string }> = [];
afterAll(() => {
  for (const fe of pendingEnvs.splice(0)) {
    // A successfully published release is chmod 555'd (build-release.sh
    // step 8, "read-only-ish + atomic publish") — `rm -rf` needs write
    // permission on every directory in the tree to unlink its entries.
    // removeFreshEnv() handles that chmod, and also cleans up the
    // (otherwise-unused-by-this-file, but still created) homeParent dir.
    removeFreshEnv(fe);
  }
});

describe('build-release.sh', () => {
  test('refuses to build from a dirty tree without --allow-dirty', () => {
    withTemporaryReadmeEdit('\n<!-- dashboard-yct90 test-writer dirty-tree probe -->\n', () => {
      const fe = freshEnv();
      const { root, env } = fe;
      pendingEnvs.push(fe);
      const result = runScript('build-release.sh', [], { ...env, GBRAIN_REPO_ROOT: repoWt.path }, 30_000);
      expect(result.status).not.toBe(0);
      expect(result.stdout + result.stderr).toMatch(/uncommitted changes|dirty tree/);
      // Nothing published under releases/.
      const releasesDir = join(root, 'releases');
      const entries = existsSync(releasesDir) ? readdirSync(releasesDir) : [];
      expect(entries).toEqual([]);
    });
  }, 40_000);

  test(
    '--allow-dirty publishes a release with source_dirty:true and a non-empty source.diff, ' +
      'and the resulting artifact is internally consistent (digest determinism, git_sha, ' +
      'no secrets, --ignore-scripts)',
    () => {
      withTemporaryReadmeEdit(
        '\n<!-- dashboard-yct90 test-writer allow-dirty probe (benign, not secret-shaped) -->\n',
        () => {
          const fe = freshEnv();
          const { root, env } = fe;
          pendingEnvs.push(fe);
          const expectedHeadSha = repoWt.headSha;

          const result = runScript('build-release.sh', ['--allow-dirty'], { ...env, GBRAIN_REPO_ROOT: repoWt.path }, 60_000);
          expect(result.status).toBe(0);
          const releaseDir = result.stdout.trim().split('\n').pop()!;
          expect(existsSync(releaseDir)).toBe(true);

          const manifest = readManifest(releaseDir) as Record<string, any>;
          expect(manifest.source_dirty).toBe(true);
          expect(manifest.bundle_type).toBe('runtime-bundle');
          expect(manifest.install_flags).toContain('--ignore-scripts');

          const diff = readFileSync(join(releaseDir, 'source.diff'), 'utf8');
          expect(diff.length).toBeGreaterThan(0);
          expect(diff).toMatch(/allow-dirty probe/);

          // #12: working-tree independence — manifest git_sha is HEAD's sha
          // regardless of the dirty diff (git archive never includes it).
          expect(manifest.git_sha).toBe(expectedHeadSha);

          // #2: node_modules digest determinism — recompute independently
          // (relative-path xargs method, matching build-release.sh's own
          // rationale for why absolute paths would be wrong) twice, both
          // must match manifest's recorded value.
          const digest1 = nodeModulesDigestSync(releaseDir);
          expect(digest1).toBe(manifest.node_modules_digest_sha256);
          const digest2 = nodeModulesDigestSync(releaseDir);
          expect(digest2).toBe(manifest.node_modules_digest_sha256);

          // #14: secrets must never be present in the published artifact
          // itself (re-testing #3's refusal path from the artifact side).
          const secretPattern = /sk-[A-Za-z0-9_-]{10,}|gbrain_cl_[a-f0-9]{16,}|gbrain_cs_[a-f0-9]{16,}|gbrain_code_[a-f0-9]{16,}|AKIA[A-Z0-9]{16}|ghp_[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/;
          const manifestText = readFileSync(join(releaseDir, 'manifest.json'), 'utf8');
          const checksumsText = readFileSync(join(releaseDir, 'checksums.txt'), 'utf8');
          expect(manifestText).not.toMatch(secretPattern);
          expect(checksumsText).not.toMatch(secretPattern);
        },
      );
    },
    90_000,
  );

  test('refuses to publish when a secret-shaped string is present in the dirty diff', () => {
    const fakeSecret = 'sk-' + 'aB3dE7gH1jK4mN6p'.repeat(2).slice(0, 24);
    withTemporaryReadmeEdit(
      `\n<!-- dashboard-yct90 test-writer secret probe: ${fakeSecret} -->\n`,
      () => {
        const fe = freshEnv();
        const { root, env } = fe;
        pendingEnvs.push(fe);
        const result = runScript('build-release.sh', ['--allow-dirty'], { ...env, GBRAIN_REPO_ROOT: repoWt.path }, 60_000);
        expect(result.status).not.toBe(0);
        expect(result.stdout + result.stderr).toMatch(/secret-shaped pattern found/);
        // No directory should appear under releases/ afterward — the
        // staging dir is cleaned up on any failure (trap cleanup_staging).
        const releasesDir = join(root, 'releases');
        const entries = existsSync(releasesDir)
          ? readdirSync(releasesDir).filter((e) => !e.startsWith('.staging.'))
          : [];
        expect(entries).toEqual([]);
        const stagingLeftover = existsSync(releasesDir)
          ? readdirSync(releasesDir).filter((e) => e.startsWith('.staging.'))
          : [];
        expect(stagingLeftover).toEqual([]);
      },
    );
  }, 90_000);
});
