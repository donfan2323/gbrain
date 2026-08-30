#!/usr/bin/env bun
/**
 * Official-First maintenance planner (Phase 3B-38).
 *
 * Turns the proven Official-First reconciliation process (Phase 3B-33
 * through 3B-37) into deterministic, repository-local tooling instead of
 * prose reports + operator memory. Two modes:
 *
 *   official-first-plan.sh <old-official-sha> <new-official-sha> [--json]
 *     READ-ONLY. Reports what changed upstream between two official
 *     commits, whether it overlaps the local patch stack or any
 *     security-sensitive area, whether the migration ceiling moved, and a
 *     deterministic Tier A/B/C classification with reasons and a
 *     recommended test plan. Never merges, rebases, cherry-picks, builds,
 *     or deploys anything.
 *
 *   official-first-plan.sh --drift [--json]
 *     READ-ONLY. Compares official-tracking/<version> against
 *     official-first/<version> and confirms the actual runtime file delta
 *     matches official-first-patchset.json's approved_runtime_files
 *     exactly — no more, no less. Catches fork creep (an unregistered
 *     runtime file, a returned DCR source patch, a returned
 *     remote_auto_link/timeline) before it gets committed.
 *
 * Never merges/rebases/cherry-picks/deploys. Every git operation here is
 * read-only (rev-parse, diff, show, merge-base, log).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..', '..');
const MANIFEST_PATH = join(REPO_ROOT, 'scripts', 'release', 'official-first-patchset.json');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PatchEntry {
  id: string;
  commit: string;
  subject: string;
  category: string | string[];
  required: boolean;
  risk: 'low' | 'high';
  files: string[];
  test_files?: string[];
  notes?: string;
}

export interface HighRiskFile {
  path: string;
  reason: string;
}

export interface Manifest {
  official_base: { version: string; sha: string; branch: string; committed_at?: string };
  official_first_head: { branch: string; sha: string };
  migration_ceiling: number;
  patches: PatchEntry[];
  approved_runtime_files: string[];
  high_risk_files: HighRiskFile[];
  security_sensitive_upstream_areas: string[];
  dropped_from_old_fork: Array<{ feature: string; replaced_by?: string; reason?: string }>;
  forbidden_reconciliation_methods: string[];
  approved_reconciliation_method: string;
}

export type Tier = 'TIER A' | 'TIER B' | 'TIER C' | 'NO UPDATE';

export interface MigrationInfo {
  old_ceiling: number | null;
  new_ceiling: number | null;
  delta: number | null;
  migrate_file_changed: boolean;
  classification: 'NO_SCHEMA_CHANGE' | 'ADDITIVE_SCHEMA_CHANGE_REVIEW_REQUIRED' | 'MULTIPLE_OR_UNKNOWN_SCHEMA_CHANGE';
}

export interface PlanResult {
  ok: boolean;
  fatal?: string;
  old_official?: { sha: string; version?: string };
  new_official?: { sha: string; version?: string };
  upstream_commit_count?: number;
  upstream_changed_file_count?: number;
  patch_overlap?: Array<{ id: string; files_touched: string[]; risk: string }>;
  security_areas_touched?: string[];
  migration?: MigrationInfo;
  tier?: Tier;
  reasons?: string[];
  test_plan?: string[];
}

export interface DriftResult {
  ok: boolean;
  fatal?: string;
  pass?: boolean;
  official_tracking_sha?: string;
  official_first_sha?: string;
  approved_files: string[];
  actual_changed_files: string[];
  unregistered_files: string[];
  missing_approved_files: string[];
  reappeared_dropped_features: string[];
}

// ---------------------------------------------------------------------------
// Git helpers (all read-only)
// ---------------------------------------------------------------------------

function git(args: string[], repoRoot: string, opts: { allowFail?: boolean } = {}): string {
  try {
    return execFileSync('git', args, {
      cwd: repoRoot, encoding: 'utf8',
      stdio: opts.allowFail ? ['ignore', 'pipe', 'ignore'] : undefined,
    }).trim();
  } catch (e) {
    if (opts.allowFail) return '';
    throw e;
  }
}

function shaExists(sha: string, repoRoot: string): boolean {
  try {
    execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: repoRoot, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function showFileAt(sha: string, path: string, repoRoot: string): string | null {
  try {
    // stdio: pipe for stderr too — a missing path at this SHA is an
    // expected, silently-handled case (returns null), not worth the git
    // error noise on the caller's own stderr.
    return execFileSync('git', ['show', `${sha}:${path}`], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

function migrationCeilingAt(sha: string, repoRoot: string): number | null {
  const content = showFileAt(sha, 'src/core/migrate.ts', repoRoot);
  if (content === null) return null;
  const matches = [...content.matchAll(/version:\s*(\d{2,4})/g)].map(m => Number(m[1]));
  if (matches.length === 0) return null;
  return Math.max(...matches);
}

function versionAt(sha: string, repoRoot: string): string | undefined {
  const pkg = showFileAt(sha, 'package.json', repoRoot);
  if (!pkg) return undefined;
  try {
    return JSON.parse(pkg).version;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Manifest loading — fail closed on anything malformed (Phase 7).
// ---------------------------------------------------------------------------

export function loadManifest(path: string = MANIFEST_PATH, repoRoot: string = REPO_ROOT): Manifest {
  if (!existsSync(path)) {
    throw new PlanFailure(`patchset manifest not found at ${path} — cannot plan without a source of truth`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new PlanFailure(`patchset manifest at ${path} is not valid JSON: ${(e as Error).message}`);
  }
  const m = raw as Partial<Manifest>;
  const required: (keyof Manifest)[] = [
    'official_base', 'official_first_head', 'migration_ceiling', 'patches',
    'approved_runtime_files', 'high_risk_files', 'security_sensitive_upstream_areas',
  ];
  for (const key of required) {
    if (m[key] === undefined) throw new PlanFailure(`patchset manifest is missing required field "${key}"`);
  }
  if (!Array.isArray(m.patches) || m.patches.length === 0) {
    throw new PlanFailure('patchset manifest has no patches[] entries — refusing to plan against an empty source of truth');
  }
  for (const p of m.patches!) {
    if (!p.id || !p.commit || !p.subject || !p.category || !Array.isArray(p.files)) {
      throw new PlanFailure(`patchset manifest patch entry is malformed: ${JSON.stringify(p).slice(0, 200)}`);
    }
    if (!shaExists(p.commit, repoRoot)) {
      throw new PlanFailure(`patchset manifest declares commit "${p.commit}" (${p.id}) but it does not exist in this repository's history`);
    }
    for (const f of p.files) {
      if (p.category !== 'TEST_ONLY' && p.category !== 'DEPLOY_OPS'
          && !(Array.isArray(p.category) ? p.category : [p.category]).includes('DEPLOY_OPS')) {
        // Runtime-relevant patch — its declared files should still exist at
        // official_first_head, or the manifest has drifted from reality.
        if (showFileAt(m.official_first_head!.sha, f, repoRoot) === null) {
          throw new PlanFailure(`patchset manifest patch "${p.id}" declares file "${f}" but it does not exist at official_first_head (${m.official_first_head!.sha}) — manifest drift`);
        }
      }
    }
  }
  if (!shaExists(m.official_base!.sha, repoRoot)) {
    throw new PlanFailure(`patchset manifest's official_base.sha "${m.official_base!.sha}" does not exist in this repository's history`);
  }
  if (!shaExists(m.official_first_head!.sha, repoRoot)) {
    throw new PlanFailure(`patchset manifest's official_first_head.sha "${m.official_first_head!.sha}" does not exist in this repository's history`);
  }
  return m as Manifest;
}

export class PlanFailure extends Error {}

// ---------------------------------------------------------------------------
// Phase 6/10/5 — the planner itself
// ---------------------------------------------------------------------------

const BROAD_WAVE_COMMIT_THRESHOLD = 15;

function classifyMigration(oldCeiling: number | null, newCeiling: number | null, migrateFileChanged: boolean): MigrationInfo {
  if (oldCeiling === null || newCeiling === null) {
    // Unknown ceiling is itself a fail-closed-toward-caution signal — never
    // silently assume NO_SCHEMA_CHANGE just because we couldn't read it.
    return {
      old_ceiling: oldCeiling, new_ceiling: newCeiling, delta: null,
      migrate_file_changed: migrateFileChanged,
      classification: 'MULTIPLE_OR_UNKNOWN_SCHEMA_CHANGE',
    };
  }
  const delta = newCeiling - oldCeiling;
  let classification: MigrationInfo['classification'];
  if (delta === 0) classification = 'NO_SCHEMA_CHANGE';
  else if (delta === 1) classification = 'ADDITIVE_SCHEMA_CHANGE_REVIEW_REQUIRED';
  else classification = 'MULTIPLE_OR_UNKNOWN_SCHEMA_CHANGE'; // delta > 1 or negative (unexpected) — never assume additive safety from count alone
  return { old_ceiling: oldCeiling, new_ceiling: newCeiling, delta, migrate_file_changed: migrateFileChanged, classification };
}

function matchesSecurityArea(path: string, areas: string[]): string[] {
  const p = path.toLowerCase();
  const hits: string[] = [];
  const patterns: Record<string, RegExp> = {
    oauth: /oauth/,
    dcr: /dcr|register-client|dynamic.?client/,
    'source-scope-privacy': /source-scope|privacy|salience|source_scope/,
    'migration-schema': /migrate\.ts|schema-pack/,
    'auth-session': /\bauth\b|session|admin.?login|magic-link/,
    'remote-file-upload': /file-upload|files\.ts/,
    'path-confinement': /path.?confine|raw-data|raw_data/,
    'credential-redaction': /redact|credential|token/,
  };
  for (const area of areas) {
    const re = patterns[area];
    if (re && re.test(p)) hits.push(area);
  }
  return hits;
}

export function plan(oldSha: string, newSha: string, manifest: Manifest = loadManifest(), repoRoot: string = REPO_ROOT): PlanResult {
  if (!shaExists(oldSha, repoRoot)) return { ok: false, fatal: `old official SHA "${oldSha}" is not available in this repository's history` };
  if (!shaExists(newSha, repoRoot)) return { ok: false, fatal: `new official SHA "${newSha}" is not available in this repository's history` };

  if (oldSha === newSha) {
    return {
      ok: true,
      old_official: { sha: oldSha, version: versionAt(oldSha, repoRoot) },
      new_official: { sha: newSha, version: versionAt(newSha, repoRoot) },
      upstream_commit_count: 0,
      upstream_changed_file_count: 0,
      patch_overlap: [],
      security_areas_touched: [],
      migration: { old_ceiling: migrationCeilingAt(oldSha, repoRoot), new_ceiling: migrationCeilingAt(newSha, repoRoot), delta: 0, migrate_file_changed: false, classification: 'NO_SCHEMA_CHANGE' },
      tier: 'NO UPDATE',
      reasons: ['old and new official SHAs are identical — nothing to plan'],
      test_plan: [],
    };
  }

  const isAncestor = (() => {
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', oldSha, newSha], { cwd: repoRoot, stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();
  if (!isAncestor) {
    return { ok: false, fatal: `old official SHA "${oldSha}" is not an ancestor of new official SHA "${newSha}" — unexpected upstream history relationship, refusing to plan (this usually means the SHAs were swapped, or "new" is not actually a descendant of "old")` };
  }

  const commitCount = Number(git(['rev-list', '--count', `${oldSha}..${newSha}`], repoRoot));
  const changedFiles = git(['diff', '--name-only', oldSha, newSha], repoRoot).split('\n').filter(Boolean);

  const patchOverlap: PlanResult['patch_overlap'] = [];
  for (const patch of manifest.patches) {
    const touched = patch.files.filter(f => changedFiles.includes(f));
    if (touched.length > 0) patchOverlap.push({ id: patch.id, files_touched: touched, risk: patch.risk });
  }

  const securityAreasTouched = new Set<string>();
  for (const f of changedFiles) {
    for (const area of matchesSecurityArea(f, manifest.security_sensitive_upstream_areas)) securityAreasTouched.add(area);
  }

  const oldCeiling = migrationCeilingAt(oldSha, repoRoot);
  const newCeiling = migrationCeilingAt(newSha, repoRoot);
  const migrateFileChanged = changedFiles.includes('src/core/migrate.ts');
  const migration = classifyMigration(oldCeiling, newCeiling, migrateFileChanged);

  // --- Tier classification (Phase 5). Deterministic, most-severe-wins.
  const reasons: string[] = [];
  let tier: Tier = 'TIER A';

  if (patchOverlap.length > 0) {
    tier = 'TIER B';
    reasons.push(`upstream touched ${patchOverlap.length} local patch file(s): ${patchOverlap.map(p => `${p.id} (${p.files_touched.join(', ')})`).join('; ')}`);
  }
  if (securityAreasTouched.size > 0) {
    if (tier === 'TIER A') tier = 'TIER B';
    reasons.push(`upstream touched security-sensitive area(s): ${[...securityAreasTouched].join(', ')}`);
  }
  if (migration.classification === 'ADDITIVE_SCHEMA_CHANGE_REVIEW_REQUIRED') {
    if (tier === 'TIER A') tier = 'TIER B';
    reasons.push(`migration ceiling advanced by 1 (${migration.old_ceiling} -> ${migration.new_ceiling}) — additive change requires review`);
  }
  if (migration.classification === 'MULTIPLE_OR_UNKNOWN_SCHEMA_CHANGE') {
    tier = 'TIER C';
    reasons.push(
      migration.old_ceiling === null || migration.new_ceiling === null
        ? 'migration ceiling could not be determined at one or both SHAs — escalating to TIER C rather than assuming safety'
        : `migration ceiling advanced by ${migration.delta} (${migration.old_ceiling} -> ${migration.new_ceiling}) — multiple/unknown schema change, cannot assume additive safety from count alone`,
    );
  }
  if (commitCount >= BROAD_WAVE_COMMIT_THRESHOLD) {
    tier = 'TIER C';
    reasons.push(`${commitCount} upstream commits >= broad-wave threshold (${BROAD_WAVE_COMMIT_THRESHOLD}) — large squash-wave, needs full intake`);
  }

  if (reasons.length === 0) {
    reasons.push('no local patch file, security-sensitive area, or migration ceiling change detected — routine update');
  }

  return {
    ok: true,
    old_official: { sha: oldSha, version: versionAt(oldSha, repoRoot) },
    new_official: { sha: newSha, version: versionAt(newSha, repoRoot) },
    upstream_commit_count: commitCount,
    upstream_changed_file_count: changedFiles.length,
    patch_overlap: patchOverlap,
    security_areas_touched: [...securityAreasTouched],
    migration,
    tier,
    reasons,
    test_plan: generateTestPlan(tier),
  };
}

// ---------------------------------------------------------------------------
// Phase 11 — test plan generator
// ---------------------------------------------------------------------------

export function generateTestPlan(tier: Tier): string[] {
  const tierA = [
    'patch replay verification (cherry-pick/rebase each manifest patch[], record clean/trivial/semantic-conflict)',
    'affected-area tests for any file with reported patch overlap',
    'existing release-tooling tests (build-release, deploy, rollback, preflight, cleanup, secret-scan, scripts-safety-static)',
    'tsc --noEmit',
    'build + preflight against the replayed candidate',
  ];
  if (tier === 'NO UPDATE') return [];
  if (tier === 'TIER A') return tierA;
  const tierB = [
    ...tierA,
    'focused semantic audit of every high_risk_files[] entry touched, diffed against pure official at both SHAs',
    'full AUTHZ-INV-005/006/016/017 security suite',
    'source-scope / privacy / OAuth surface test sweep',
    'migration rehearsal against a disposable DB if the migration ceiling changed at all',
    'full test suite if the touched area is broad enough to warrant it (operator judgment call, not automatic)',
  ];
  if (tier === 'TIER B') return tierB;
  // TIER C
  return [
    ...tierB,
    'full Phase-3B-33-style intake/reconciliation audit (do not skip straight to patch replay)',
    'disposable migration test against a realistic seeded DB',
    'rollback rehearsal using the ACTUAL current production binary against the new migration ceiling',
    'one-time full test suite run (not just targeted)',
    'a fully governed deployment plan (pre-deploy freeze, backup verification, stability window) before any production attempt',
  ];
}

// ---------------------------------------------------------------------------
// Phase 8 — drift check
// ---------------------------------------------------------------------------

export function driftCheck(manifest: Manifest = loadManifest(), trackingRef = 'official-tracking/v0.47.4', firstRef = 'official-first/v0.47.4', repoRoot: string = REPO_ROOT): DriftResult {
  if (!shaExists(trackingRef, repoRoot)) return { ok: false, fatal: `official-tracking ref "${trackingRef}" not found`, approved_files: [], actual_changed_files: [], unregistered_files: [], missing_approved_files: [], reappeared_dropped_features: [] };
  if (!shaExists(firstRef, repoRoot)) return { ok: false, fatal: `official-first ref "${firstRef}" not found`, approved_files: [], actual_changed_files: [], unregistered_files: [], missing_approved_files: [], reappeared_dropped_features: [] };

  const trackingSha = git(['rev-parse', trackingRef], repoRoot);
  const firstSha = git(['rev-parse', firstRef], repoRoot);
  const actualChanged = git(['diff', '--name-only', trackingRef, firstRef, '--', 'src/'], repoRoot).split('\n').filter(Boolean);
  const approved = manifest.approved_runtime_files;

  const unregistered = actualChanged.filter(f => !approved.includes(f));
  const missing = approved.filter(f => !actualChanged.includes(f));

  const reappeared: string[] = [];
  const dcrRegistrationDiff = git(['diff', trackingRef, firstRef, '--', 'src/core/scope.ts'], repoRoot, { allowFail: true });
  if (/DCR_ALLOWED_SCOPES/.test(dcrRegistrationDiff)) {
    reappeared.push('DCR_ALLOWED_SCOPES source-level ceiling has returned to src/core/scope.ts — this was intentionally replaced by the deployment invariant');
  }
  for (const f of ['remote_auto_link', 'remote_auto_timeline']) {
    // Scoped to the SAME src/-only file list as actualChanged — a docs page
    // or the manifest itself mentioning the feature name as a documented,
    // intentional drop must never register as it "reappearing" in runtime.
    const hit = actualChanged.some(path => git(['diff', trackingRef, firstRef, '--', path], repoRoot, { allowFail: true }).includes(f));
    if (hit) reappeared.push(`${f} references have reappeared in the runtime diff — this feature was confirmed unused and dropped`);
  }

  const pass = unregistered.length === 0 && missing.length === 0 && reappeared.length === 0;

  return {
    ok: true,
    pass,
    official_tracking_sha: trackingSha,
    official_first_sha: firstSha,
    approved_files: approved,
    actual_changed_files: actualChanged,
    unregistered_files: unregistered,
    missing_approved_files: missing,
    reappeared_dropped_features: reappeared,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function formatPlanHuman(r: PlanResult): string {
  if (!r.ok) return `FAIL-CLOSED: ${r.fatal}\n`;
  const lines: string[] = [];
  lines.push(`Official-First update plan`);
  lines.push(`  old official: ${r.old_official!.sha}${r.old_official!.version ? ` (v${r.old_official!.version})` : ''}`);
  lines.push(`  new official: ${r.new_official!.sha}${r.new_official!.version ? ` (v${r.new_official!.version})` : ''}`);
  if (r.tier === 'NO UPDATE') {
    lines.push(`  => NO UPDATE (identical SHAs)`);
    return lines.join('\n') + '\n';
  }
  lines.push(`  upstream commits: ${r.upstream_commit_count}, changed files: ${r.upstream_changed_file_count}`);
  lines.push('');
  lines.push('Local patch overlap:');
  if (r.patch_overlap!.length === 0) lines.push('  none');
  for (const p of r.patch_overlap!) lines.push(`  - ${p.id} [${p.risk}]: ${p.files_touched.join(', ')}`);
  lines.push('');
  lines.push(`Security-sensitive areas touched: ${r.security_areas_touched!.length ? r.security_areas_touched!.join(', ') : 'none'}`);
  lines.push('');
  lines.push(`Migration: ${r.migration!.old_ceiling ?? '?'} -> ${r.migration!.new_ceiling ?? '?'} (${r.migration!.classification})`);
  lines.push('');
  lines.push(`>>> ${r.tier} <<<`);
  for (const reason of r.reasons!) lines.push(`  - ${reason}`);
  lines.push('');
  lines.push('Recommended checks:');
  for (const step of r.test_plan!) lines.push(`  - ${step}`);
  return lines.join('\n') + '\n';
}

function formatDriftHuman(r: DriftResult): string {
  if (!r.ok) return `FAIL-CLOSED: ${r.fatal}\n`;
  const lines: string[] = [];
  lines.push(`Official-First runtime drift check`);
  lines.push(`  official-tracking: ${r.official_tracking_sha}`);
  lines.push(`  official-first:    ${r.official_first_sha}`);
  lines.push('');
  if (r.pass) {
    lines.push('APPROVED LOCAL RUNTIME DELTA: PASS');
  } else {
    lines.push('UNEXPECTED LOCAL RUNTIME DELTA: FAIL');
    if (r.unregistered_files.length) lines.push(`  unregistered runtime file(s): ${r.unregistered_files.join(', ')}`);
    if (r.missing_approved_files.length) lines.push(`  missing approved patch file(s): ${r.missing_approved_files.join(', ')}`);
    if (r.reappeared_dropped_features.length) for (const f of r.reappeared_dropped_features) lines.push(`  ${f}`);
  }
  return lines.join('\n') + '\n';
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const positional = args.filter(a => !a.startsWith('--'));

  try {
    if (args.includes('--drift')) {
      const trackingRef = positional[0] || 'official-tracking/v0.47.4';
      const firstRef = positional[1] || 'official-first/v0.47.4';
      const result = driftCheck(loadManifest(), trackingRef, firstRef);
      if (json) console.log(JSON.stringify(result, null, 2));
      else process.stdout.write(formatDriftHuman(result));
      process.exit(result.ok && result.pass ? 0 : 1);
    } else {
      if (positional.length < 2) {
        console.error('usage: official-first-plan.sh <old-official-sha> <new-official-sha> [--json]');
        console.error('   or: official-first-plan.sh --drift [official-tracking-ref] [official-first-ref] [--json]');
        process.exit(2);
      }
      const result = plan(positional[0], positional[1]);
      if (json) console.log(JSON.stringify(result, null, 2));
      else process.stdout.write(formatPlanHuman(result));
      process.exit(result.ok ? 0 : 1);
    }
  } catch (e) {
    if (e instanceof PlanFailure) {
      console.error(`FAIL-CLOSED: ${e.message}`);
      process.exit(1);
    }
    throw e;
  }
}
