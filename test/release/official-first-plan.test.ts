/**
 * Official-First maintenance planner tests (Phase 3B-38).
 *
 * Two kinds of coverage:
 *   1. Synthetic scenarios (Phase 13 items 1-9) against a fully isolated
 *      disposable git repo — never touches the real gbrain repo's history,
 *      so every tier-boundary case can be constructed deterministically
 *      rather than hoping real upstream history happens to contain one.
 *   2. Real-history validation (Phase 13 item 10 / Phase 14) against the
 *      ACTUAL gbrain repo, using the frozen v0.47.3 -> v0.47.4 refs.
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { plan, driftCheck, loadManifest, PlanFailure, type Manifest } from '../../scripts/release/official-first-plan';

const REPO_ROOT_FOR_TESTS = join(import.meta.dir, '..', '..');

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

// ---------------------------------------------------------------------------
// Disposable fixture repo builder
// ---------------------------------------------------------------------------

function g(repo: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

interface FixtureFiles {
  version: string;
  migrateCeiling: number;
  touchServeHttp?: boolean;
  touchJobs?: boolean;
  touchOauth?: boolean;
  extraFiles?: Record<string, string>;
}

function writeFixtureTree(repo: string, f: FixtureFiles): void {
  mkdirSync(join(repo, 'src', 'commands'), { recursive: true });
  mkdirSync(join(repo, 'src', 'core', 'ops'), { recursive: true });
  mkdirSync(join(repo, 'src', 'core'), { recursive: true });
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'fixture', version: f.version }, null, 2));
  writeFileSync(join(repo, 'src', 'commands', 'serve-http.ts'), `// serve-http fixture\nexport const MARK = ${f.touchServeHttp ? '"touched"' : '"base"'};\n`);
  writeFileSync(join(repo, 'src', 'core', 'ops', 'jobs.ts'), `// jobs fixture\nexport const MARK = ${f.touchJobs ? '"touched"' : '"base"'};\n`);
  writeFileSync(join(repo, 'src', 'core', 'oauth-provider.ts'), `// oauth fixture\nexport const MARK = ${f.touchOauth ? '"touched"' : '"base"'};\n`);
  writeFileSync(join(repo, 'src', 'core', 'migrate.ts'), `export const MIGRATIONS = [\n${Array.from({ length: f.migrateCeiling - 99 }, (_, i) => `  { version: ${100 + i} },`).join('\n')}\n];\n`);
  writeFileSync(join(repo, 'src', 'core', 'scope.ts'), `export const SCOPE = 'base';\n`);
  for (const [path, content] of Object.entries(f.extraFiles ?? {})) {
    mkdirSync(join(repo, path, '..'), { recursive: true });
    writeFileSync(join(repo, path), content);
  }
}

function initFixtureRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'ofp-fixture-'));
  dirs.push(repo);
  g(repo, ['init', '-q']);
  g(repo, ['config', 'user.email', 'test@example.com']);
  g(repo, ['config', 'user.name', 'test']);
  return repo;
}

function commitFixture(repo: string, f: FixtureFiles, message: string): string {
  writeFixtureTree(repo, f);
  g(repo, ['add', '-A']);
  g(repo, ['commit', '-q', '-m', message, '--allow-empty']);
  return g(repo, ['rev-parse', 'HEAD']);
}

function makeManifest(repo: string, baseSha: string, headSha: string): Manifest {
  return {
    official_base: { version: '1.0.0', sha: baseSha, branch: 'fixture-base' },
    official_first_head: { branch: 'fixture-head', sha: headSha },
    migration_ceiling: 144,
    patches: [
      {
        id: 'fixture-serve-http-patch',
        commit: headSha,
        subject: 'fixture patch touching serve-http.ts',
        category: 'SECURITY_RUNTIME',
        required: true,
        risk: 'high',
        files: ['src/commands/serve-http.ts'],
      },
      {
        id: 'fixture-jobs-patch',
        commit: headSha,
        subject: 'fixture patch touching jobs.ts',
        category: 'SECURITY_RUNTIME',
        required: true,
        risk: 'high',
        files: ['src/core/ops/jobs.ts'],
      },
    ],
    approved_runtime_files: ['src/commands/serve-http.ts', 'src/core/ops/jobs.ts'],
    high_risk_files: [
      { path: 'src/commands/serve-http.ts', reason: 'fixture' },
      { path: 'src/core/ops/jobs.ts', reason: 'fixture' },
    ],
    security_sensitive_upstream_areas: ['oauth', 'dcr', 'source-scope-privacy', 'migration-schema', 'auth-session', 'remote-file-upload', 'path-confinement', 'credential-redaction'],
    dropped_from_old_fork: [],
    forbidden_reconciliation_methods: [],
    approved_reconciliation_method: 'fixture',
  };
}

function writeManifestFile(dir: string, m: Manifest): string {
  const p = join(dir, 'manifest.json');
  writeFileSync(p, JSON.stringify(m, null, 2));
  return p;
}

// ---------------------------------------------------------------------------
// Phase 13 item 1: no changed high-risk files -> Tier A
// ---------------------------------------------------------------------------

test('no local-patch/security-area/migration change -> TIER A', () => {
  const repo = initFixtureRepo();
  const oldSha = commitFixture(repo, { version: '1.0.0', migrateCeiling: 144 }, 'base');
  const newSha = commitFixture(repo, { version: '1.0.1', migrateCeiling: 144, extraFiles: { 'README.md': 'docs only\n' } }, 'docs update');
  const manifest = makeManifest(repo, oldSha, newSha);
  const manifestPath = writeManifestFile(repo, manifest);
  const loaded = loadManifest(manifestPath, repo);

  const result = plan(oldSha, newSha, loaded, repo);
  expect(result.ok).toBe(true);
  expect(result.tier).toBe('TIER A');
  expect(result.patch_overlap).toEqual([]);
  expect(result.security_areas_touched).toEqual([]);
});

// ---------------------------------------------------------------------------
// Phase 13 item 2: serve-http.ts changed -> Tier B
// ---------------------------------------------------------------------------

test('serve-http.ts changed upstream -> TIER B', () => {
  const repo = initFixtureRepo();
  const oldSha = commitFixture(repo, { version: '1.0.0', migrateCeiling: 144 }, 'base');
  const newSha = commitFixture(repo, { version: '1.0.1', migrateCeiling: 144, touchServeHttp: true }, 'serve-http change');
  const manifest = makeManifest(repo, oldSha, newSha);
  const loaded = loadManifest(writeManifestFile(repo, manifest), repo);

  const result = plan(oldSha, newSha, loaded, repo);
  expect(result.tier).toBe('TIER B');
  expect(result.patch_overlap!.some(p => p.id === 'fixture-serve-http-patch')).toBe(true);
});

// ---------------------------------------------------------------------------
// Phase 13 item 3: jobs.ts changed -> Tier B
// ---------------------------------------------------------------------------

test('jobs.ts changed upstream -> TIER B', () => {
  const repo = initFixtureRepo();
  const oldSha = commitFixture(repo, { version: '1.0.0', migrateCeiling: 144 }, 'base');
  const newSha = commitFixture(repo, { version: '1.0.1', migrateCeiling: 144, touchJobs: true }, 'jobs change');
  const manifest = makeManifest(repo, oldSha, newSha);
  const loaded = loadManifest(writeManifestFile(repo, manifest), repo);

  const result = plan(oldSha, newSha, loaded, repo);
  expect(result.tier).toBe('TIER B');
  expect(result.patch_overlap!.some(p => p.id === 'fixture-jobs-patch')).toBe(true);
});

// ---------------------------------------------------------------------------
// Phase 13 item 4: OAuth/security surface changed (no patch overlap) -> Tier B
// ---------------------------------------------------------------------------

test('OAuth/security surface changed, independent of patch overlap -> TIER B', () => {
  const repo = initFixtureRepo();
  const oldSha = commitFixture(repo, { version: '1.0.0', migrateCeiling: 144 }, 'base');
  const newSha = commitFixture(repo, { version: '1.0.1', migrateCeiling: 144, touchOauth: true }, 'oauth change');
  const manifest = makeManifest(repo, oldSha, newSha);
  const loaded = loadManifest(writeManifestFile(repo, manifest), repo);

  const result = plan(oldSha, newSha, loaded, repo);
  expect(result.tier).toBe('TIER B');
  expect(result.patch_overlap).toEqual([]); // proves this is the security-area path, not patch overlap
  expect(result.security_areas_touched).toContain('oauth');
});

// ---------------------------------------------------------------------------
// Phase 13 item 5: new migration -> at least Tier B
// ---------------------------------------------------------------------------

test('single new migration -> at least TIER B (ADDITIVE_SCHEMA_CHANGE_REVIEW_REQUIRED)', () => {
  const repo = initFixtureRepo();
  const oldSha = commitFixture(repo, { version: '1.0.0', migrateCeiling: 144 }, 'base');
  const newSha = commitFixture(repo, { version: '1.0.1', migrateCeiling: 145 }, 'one new migration');
  const manifest = makeManifest(repo, oldSha, newSha);
  const loaded = loadManifest(writeManifestFile(repo, manifest), repo);

  const result = plan(oldSha, newSha, loaded, repo);
  expect(['TIER B', 'TIER C']).toContain(result.tier!);
  expect(result.migration!.classification).toBe('ADDITIVE_SCHEMA_CHANGE_REVIEW_REQUIRED');
  expect(result.migration!.delta).toBe(1);
});

// ---------------------------------------------------------------------------
// Phase 13 item 6: multiple/unknown migration change -> Tier C
// ---------------------------------------------------------------------------

test('multiple new migrations -> TIER C (MULTIPLE_OR_UNKNOWN_SCHEMA_CHANGE)', () => {
  const repo = initFixtureRepo();
  const oldSha = commitFixture(repo, { version: '1.0.0', migrateCeiling: 144 }, 'base');
  const newSha = commitFixture(repo, { version: '1.0.1', migrateCeiling: 147 }, 'three new migrations');
  const manifest = makeManifest(repo, oldSha, newSha);
  const loaded = loadManifest(writeManifestFile(repo, manifest), repo);

  const result = plan(oldSha, newSha, loaded, repo);
  expect(result.tier).toBe('TIER C');
  expect(result.migration!.classification).toBe('MULTIPLE_OR_UNKNOWN_SCHEMA_CHANGE');
  expect(result.migration!.delta).toBe(3);
});

// ---------------------------------------------------------------------------
// Phase 13 item 7: broad wave threshold -> Tier C
// ---------------------------------------------------------------------------

test('broad commit wave (>= 15 commits) -> TIER C even with no other trigger', () => {
  const repo = initFixtureRepo();
  const oldSha = commitFixture(repo, { version: '1.0.0', migrateCeiling: 144 }, 'base');
  let lastSha = oldSha;
  for (let i = 0; i < 15; i++) {
    lastSha = commitFixture(repo, { version: '1.0.0', migrateCeiling: 144, extraFiles: { [`docs/note-${i}.md`]: `note ${i}\n` } }, `docs commit ${i}`);
  }
  const manifest = makeManifest(repo, oldSha, lastSha);
  const loaded = loadManifest(writeManifestFile(repo, manifest), repo);

  const result = plan(oldSha, lastSha, loaded, repo);
  expect(result.tier).toBe('TIER C');
  expect(result.upstream_commit_count).toBeGreaterThanOrEqual(15);
  expect(result.reasons!.some(r => r.includes('broad-wave'))).toBe(true);
});

// ---------------------------------------------------------------------------
// Phase 13 item 8: missing patch manifest -> fail closed
// ---------------------------------------------------------------------------

test('missing patchset manifest -> fail closed, throws PlanFailure', () => {
  expect(() => loadManifest('/nonexistent/path/to/manifest.json')).toThrow(PlanFailure);
});

test('malformed patchset manifest (bad JSON) -> fail closed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ofp-badjson-'));
  dirs.push(dir);
  const p = join(dir, 'manifest.json');
  writeFileSync(p, '{ not valid json');
  expect(() => loadManifest(p)).toThrow(PlanFailure);
});

test('patchset manifest declaring a nonexistent commit -> fail closed', () => {
  const repo = initFixtureRepo();
  const oldSha = commitFixture(repo, { version: '1.0.0', migrateCeiling: 144 }, 'base');
  const newSha = commitFixture(repo, { version: '1.0.1', migrateCeiling: 144 }, 'next');
  const manifest = makeManifest(repo, oldSha, newSha);
  manifest.patches[0].commit = 'deadbeef00000000000000000000000000000000';
  const manifestPath = writeManifestFile(repo, manifest);
  expect(() => loadManifest(manifestPath, repo)).toThrow(PlanFailure);
});

// ---------------------------------------------------------------------------
// Phase 13 item 9: unexpected local runtime divergence -> fail (drift check)
// ---------------------------------------------------------------------------

test('drift check: extra unregistered runtime file -> UNEXPECTED LOCAL RUNTIME DELTA: FAIL', () => {
  const repo = initFixtureRepo();
  g(repo, ['checkout', '-q', '-b', 'fixture-base']);
  const baseSha = commitFixture(repo, { version: '1.0.0', migrateCeiling: 144 }, 'base');
  g(repo, ['checkout', '-q', '-b', 'fixture-head']);
  // Approved change (serve-http.ts) PLUS an unregistered extra runtime file.
  writeFixtureTree(repo, { version: '1.0.0', migrateCeiling: 144, touchServeHttp: true });
  mkdirSync(join(repo, 'src', 'core', 'ops'), { recursive: true });
  writeFileSync(join(repo, 'src', 'core', 'ops', 'sneaky-new-file.ts'), 'export const X = 1;\n');
  g(repo, ['add', '-A']);
  g(repo, ['commit', '-q', '-m', 'head with unregistered extra file']);

  const manifest = makeManifest(repo, baseSha, baseSha); // approved_runtime_files only lists serve-http.ts + jobs.ts
  const manifestPath = writeManifestFile(repo, manifest);
  const loaded = loadManifest(manifestPath, repo);

  const result = driftCheck(loaded, 'fixture-base', 'fixture-head', repo);
  expect(result.ok).toBe(true);
  expect(result.pass).toBe(false);
  expect(result.unregistered_files).toContain('src/core/ops/sneaky-new-file.ts');
});

test('drift check: clean delta exactly matching manifest -> APPROVED LOCAL RUNTIME DELTA: PASS', () => {
  const repo = initFixtureRepo();
  g(repo, ['checkout', '-q', '-b', 'fixture-base']);
  const baseSha = commitFixture(repo, { version: '1.0.0', migrateCeiling: 144 }, 'base');
  g(repo, ['checkout', '-q', '-b', 'fixture-head']);
  commitFixture(repo, { version: '1.0.0', migrateCeiling: 144, touchServeHttp: true, touchJobs: true }, 'head, approved delta only');

  const manifest = makeManifest(repo, baseSha, baseSha);
  const loaded = loadManifest(writeManifestFile(repo, manifest), repo);

  const result = driftCheck(loaded, 'fixture-base', 'fixture-head', repo);
  expect(result.pass).toBe(true);
  expect(result.unregistered_files).toEqual([]);
  expect(result.missing_approved_files).toEqual([]);
});

test('drift check: dropped DCR source ceiling reappearing -> flagged', () => {
  const repo = initFixtureRepo();
  g(repo, ['checkout', '-q', '-b', 'fixture-base']);
  const baseSha = commitFixture(repo, { version: '1.0.0', migrateCeiling: 144 }, 'base');
  g(repo, ['checkout', '-q', '-b', 'fixture-head']);
  writeFixtureTree(repo, { version: '1.0.0', migrateCeiling: 144, touchServeHttp: true, touchJobs: true });
  writeFileSync(join(repo, 'src', 'core', 'scope.ts'), `export const DCR_ALLOWED_SCOPES = ['read', 'write'];\n`);
  g(repo, ['add', '-A']);
  g(repo, ['commit', '-q', '-m', 'DCR ceiling accidentally reintroduced']);

  const manifest = makeManifest(repo, baseSha, baseSha);
  const loaded = loadManifest(writeManifestFile(repo, manifest), repo);

  const result = driftCheck(loaded, 'fixture-base', 'fixture-head', repo);
  expect(result.pass).toBe(false);
  expect(result.reappeared_dropped_features.some(f => f.includes('DCR_ALLOWED_SCOPES'))).toBe(true);
});

// ---------------------------------------------------------------------------
// NO UPDATE case (same SHA -> same SHA)
// ---------------------------------------------------------------------------

test('identical old/new SHA -> NO UPDATE, not a false Tier classification', () => {
  const repo = initFixtureRepo();
  const sha = commitFixture(repo, { version: '1.0.0', migrateCeiling: 144 }, 'base');
  const manifest = makeManifest(repo, sha, sha);
  const loaded = loadManifest(writeManifestFile(repo, manifest), repo);

  const result = plan(sha, sha, loaded, repo);
  expect(result.tier).toBe('NO UPDATE');
});

// ---------------------------------------------------------------------------
// Reversed ancestry -> fail closed
// ---------------------------------------------------------------------------

test('new SHA is an ancestor of old SHA (reversed) -> fail closed, not silently Tier A', () => {
  const repo = initFixtureRepo();
  const oldSha = commitFixture(repo, { version: '1.0.0', migrateCeiling: 144 }, 'first');
  const newSha = commitFixture(repo, { version: '1.0.1', migrateCeiling: 144 }, 'second');
  const manifest = makeManifest(repo, oldSha, newSha);
  const loaded = loadManifest(writeManifestFile(repo, manifest), repo);

  const result = plan(newSha, oldSha, loaded, repo); // reversed on purpose
  expect(result.ok).toBe(false);
  expect(result.fatal).toMatch(/not an ancestor/);
});

// ---------------------------------------------------------------------------
// Phase 13 item 10 / Phase 14: real v0.47.3 -> v0.47.4 history
// ---------------------------------------------------------------------------

describe('real gbrain repo history validation', () => {
  test('v0.47.3 -> v0.47.4 (17eff27c -> c860a411f) classifies as TIER B', () => {
    const result = plan(
      '17eff27cf0466e7ce43154c31bb7079f76439253',
      'c860a411f6fee694a9668cf9d5ffb60af9a7b1eb',
      loadManifest(undefined, REPO_ROOT_FOR_TESTS),
      REPO_ROOT_FOR_TESTS,
    );
    expect(result.ok).toBe(true);
    expect(result.tier).toBe('TIER B');
    // At least one of the two independent real-world triggers must be present.
    expect(result.patch_overlap!.length).toBeGreaterThan(0);
    expect(result.security_areas_touched!.length).toBeGreaterThan(0);
    expect(result.migration!.classification).toBe('NO_SCHEMA_CHANGE'); // ceiling stayed at 144
  });

  test('current official-first/v0.47.4 drift check against official-tracking/v0.47.4 passes', () => {
    const result = driftCheck(loadManifest(undefined, REPO_ROOT_FOR_TESTS), 'official-tracking/v0.47.4', 'official-first/v0.47.4', REPO_ROOT_FOR_TESTS);
    expect(result.ok).toBe(true);
    expect(result.pass).toBe(true);
  });
});
