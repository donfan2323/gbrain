/**
 * scripts/release/lib.sh's scan_for_secrets() — direct unit tests for the
 * gbrain_cs_ (OAuth client_secret) detection gap (dashboard-foe12).
 *
 * RED PHASE (TDD, do not merge a fix here): scan_for_secrets()'s pattern
 * currently covers gbrain_cl_ (client ID) and gbrain_code_ (auth code) but
 * is MISSING gbrain_cs_ (client secret, minted by
 * generateToken('gbrain_cs_') in src/core/oauth-provider.ts:299,964) —
 * arguably the most sensitive of the three token shapes. The identical gap
 * also exists in build-release.serial.test.ts's own duplicated regex
 * (~line 131); that file is intentionally left untouched here.
 *
 * The "BUG" test and the directory-mode test below are EXPECTED TO FAIL
 * against the current, unfixed lib.sh — they encode the missing behavior
 * this bd task will add. Do NOT edit scripts/release/lib.sh from this file;
 * the fix lands in a separate (green-phase) change.
 *
 * Sources scripts/release/lib.sh directly in a bash subprocess and calls
 * scan_for_secrets() against real temp files/dirs — no full
 * build-release.sh/preflight.sh run (see build-release.serial.test.ts for
 * that slower, end-to-end coverage).
 *
 * GBRAIN_PROD_ROOT is pointed at a path that is deliberately never created,
 * so scan_for_secrets()'s log() call (fired only on a match) can never
 * append to the REAL production shared/logs/*.log tree (log() only writes
 * to a file when "$SHARED_LOGS_DIR" already exists as a directory).
 *
 * Every test only touches an isolated mktemp dir cleaned up in afterEach —
 * never the repo working tree or shared state — safe for the fast parallel
 * loop (no `.serial.test.ts` suffix needed, unlike build-release.serial.test.ts).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SCRIPTS_DIR } from './fixtures';

const LIB_SH = join(SCRIPTS_DIR, 'lib.sh');

// Never created on purpose — see file header. scan_for_secrets()'s log()
// only appends to a file under "$GBRAIN_PROD_ROOT/shared/logs" when that
// directory already exists, so a nonexistent GBRAIN_PROD_ROOT keeps this
// suite from ever touching the real production log tree.
const ISOLATED_PROD_ROOT = join(tmpdir(), `gbrain-scan-secrets-test-isolated-root-${process.pid}`);

/** Sources lib.sh and calls scan_for_secrets(target); returns its exit code. */
function scanForSecrets(target: string): number {
  try {
    execFileSync('bash', ['-c', `source "${LIB_SH}"; scan_for_secrets "$1"`, '--', target], {
      encoding: 'utf8',
      env: { ...process.env, GBRAIN_PROD_ROOT: ISOLATED_PROD_ROOT },
    });
    return 0;
  } catch (err: any) {
    if (typeof err.status === 'number') return err.status;
    throw err;
  }
}

const tempDirs: string[] = [];

function makeTempFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-scan-secrets-file-'));
  tempDirs.push(dir);
  const filePath = join(dir, 'sample.txt');
  writeFileSync(filePath, content);
  return filePath;
}

function makeTempDirWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-scan-secrets-dir-'));
  tempDirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('scan_for_secrets() — gbrain_cs_ (client secret) detection gap (dashboard-foe12)', () => {
  test('normal/clean: ordinary prose has no match (exit 0)', () => {
    const file = makeTempFile('This is just a normal config file.\nNo secrets here.\nversion: 1.2.3\n');
    expect(scanForSecrets(file)).toBe(0);
  });

  test('BUG (must currently fail): gbrain_cs_ + 16+ hex chars is detected (exit 1)', () => {
    const file = makeTempFile('GBRAIN_CLIENT_SECRET=gbrain_cs_1234567890abcdef1234567890abcdef\n');
    expect(scanForSecrets(file)).toBe(1);
  });

  test('boundary: exactly 16 hex chars after gbrain_cs_ matches (exit 1)', () => {
    const file = makeTempFile('gbrain_cs_1234567890abcdef\n'); // 16 hex chars — inclusive lower bound of {16,}
    expect(scanForSecrets(file)).toBe(1);
  });

  test('boundary: exactly 15 hex chars after gbrain_cs_ does NOT match (exit 0)', () => {
    const file = makeTempFile('gbrain_cs_123456789abcdef\n'); // 15 hex chars — below the {16,} minimum
    expect(scanForSecrets(file)).toBe(0);
  });

  test('false positive avoidance: gbrain_cs_ followed by a too-short/non-hex tail is clean (exit 0)', () => {
    const file = makeTempFile('client_secret_env_var_name = gbrain_cs_test\n');
    expect(scanForSecrets(file)).toBe(0);
  });

  test('false positive avoidance: mentioning the gbrain_cs_ prefix in prose (no hex payload) is clean (exit 0)', () => {
    const file = makeTempFile(
      'Token prefixes: gbrain_cl_ for client id, gbrain_code_ for auth code, ' +
        'and gbrain_cs_ for client secret.\n',
    );
    expect(scanForSecrets(file)).toBe(0);
  });

  describe('regression: existing patterns must keep working', () => {
    test('sk- (OpenAI/Anthropic-style key) is detected (exit 1)', () => {
      const file = makeTempFile('OPENAI_API_KEY=sk-aB3dE7gH1jK4mN6p9Qr2sT5\n');
      expect(scanForSecrets(file)).toBe(1);
    });

    test('gbrain_cl_ (client id) is detected (exit 1)', () => {
      const file = makeTempFile('gbrain_cl_1234567890abcdef1234567890abcdef\n');
      expect(scanForSecrets(file)).toBe(1);
    });

    test('gbrain_code_ (auth code) is detected (exit 1)', () => {
      const file = makeTempFile('gbrain_code_1234567890abcdef1234567890abcdef\n');
      expect(scanForSecrets(file)).toBe(1);
    });

    test('AKIA (AWS-style key) is detected (exit 1)', () => {
      const file = makeTempFile('AWS_ACCESS_KEY_ID=AKIA1234567890ABCDEF\n');
      expect(scanForSecrets(file)).toBe(1);
    });

    test('ghp_ (GitHub token) is detected (exit 1)', () => {
      const file = makeTempFile('GITHUB_TOKEN=ghp_1234567890abcdefghij1234\n');
      expect(scanForSecrets(file)).toBe(1);
    });

    test('PEM private key header is detected (exit 1)', () => {
      const file = makeTempFile('-----BEGIN RSA PRIVATE KEY-----\nMIIEow...\n-----END RSA PRIVATE KEY-----\n');
      expect(scanForSecrets(file)).toBe(1);
    });
  });

  test('directory mode (must currently fail): a dir with one clean file and one gbrain_cs_-shaped secret file is detected (exit 1)', () => {
    const dir = makeTempDirWith({
      'clean.txt': 'Nothing sensitive in here.\n',
      'secret.txt': 'gbrain_cs_1234567890abcdef1234567890abcdef\n',
    });
    expect(scanForSecrets(dir)).toBe(1);
  });
});
