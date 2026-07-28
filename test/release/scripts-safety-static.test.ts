/**
 * Static safety checks over scripts/release/*.sh (dashboard-yct90).
 *
 * These never touch git state or the filesystem beyond reading the scripts
 * themselves — pure text checks, safe to run in the fast parallel loop.
 */
import { describe, test, expect } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SCRIPTS_DIR } from './fixtures';

const shellScripts = readdirSync(SCRIPTS_DIR)
  .filter((f) => f.endsWith('.sh'))
  .sort();

describe('scripts/release/*.sh static safety', () => {
  test('at least the expected release scripts are present', () => {
    // Regression guard: if this list shrinks unexpectedly, something got
    // deleted/renamed and every other test/release/* file's assumptions
    // about which scripts exist would silently stop being exercised.
    expect(shellScripts).toEqual(
      expect.arrayContaining([
        'build-release.sh',
        'cleanup.sh',
        'deploy.sh',
        'lib.sh',
        'preflight.sh',
        'rollback.sh',
        'smoke-test.sh',
        'status.sh',
      ]),
    );
  });

  test('none of scripts/release/*.sh ever invoke git stash/checkout/reset', () => {
    // This whole pipeline's working-tree-independence guarantee (git
    // archive HEAD only) depends on NEVER touching the working tree via
    // these commands. Verify absence directly rather than trusting the
    // design doc/comments. Comment-only lines are excluded (build-release.sh
    // documents the `git archive` rationale by NAME-DROPPING `git stash` in
    // prose — that's a description of what it does NOT do, not an
    // invocation; every real invocation would appear as executable code).
    const forbidden = [/git\s+stash/, /git\s+checkout/, /git\s+reset/];
    const offenders: string[] = [];
    for (const file of shellScripts) {
      const contents = readFileSync(join(SCRIPTS_DIR, file), 'utf8');
      const codeLines = contents.split('\n').filter((line) => !line.trim().startsWith('#'));
      for (const pattern of forbidden) {
        for (const line of codeLines) {
          if (pattern.test(line)) {
            offenders.push(`${file}: matched ${pattern} in: ${line.trim()}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
