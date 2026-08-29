/**
 * Shared test-only helpers for scripts/release/*.sh regression tests
 * (dashboard-yct90). Not itself a *.test.ts file — imported by the files in
 * this directory. See scripts/release/lib.sh's own header comment for the
 * env-var contract every helper here respects (GBRAIN_PROD_ROOT,
 * GBRAIN_DATA_DIR must end in "/.gbrain", GBRAIN_HTTP_PORT,
 * GBRAIN_DEPLOY_TEST_MODE, GBRAIN_LAUNCHD_PLIST).
 *
 * NEVER points any of these at the real production root
 * (/Users/lab/AI_Production) or the real data dir (~/.gbrain) — every
 * caller must supply fresh mktemp-based paths.
 */
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const REPO_ROOT = join(import.meta.dir, '..', '..');
export const SCRIPTS_DIR = join(REPO_ROOT, 'scripts', 'release');

/**
 * A private `git worktree` checked out from REPO_ROOT's current HEAD, for
 * tests that invoke build-release.sh and need its OWN independent
 * "GBRAIN_REPO_ROOT" — decoupled from whatever the shared checkout's
 * dirty/clean state happens to be at the moment (another `.serial.test.ts`
 * file's temporary edit, or just an in-progress local edit). build-release.sh
 * `cd`s into `$GBRAIN_REPO_ROOT` and runs plain `git` commands there, so
 * pointing it at this worktree is enough — no script change needed.
 */
export interface IsolatedWorktree {
  path: string;
  headSha: string;
}

export function createIsolatedWorktree(prefix: string): IsolatedWorktree {
  const path = makeTempDir(prefix);
  // The temp dir must not exist yet for `git worktree add` to create it;
  // mkdtempSync already created it, so remove it first (still under tmpdir,
  // still guaranteed-unique).
  rmSync(path, { recursive: true, force: true });
  const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  execFileSync('git', ['worktree', 'add', '--detach', path, headSha], { cwd: REPO_ROOT, encoding: 'utf8' });
  return { path, headSha };
}

export function removeIsolatedWorktree(wt: IsolatedWorktree): void {
  try {
    execFileSync('git', ['worktree', 'remove', '--force', wt.path], { cwd: REPO_ROOT, encoding: 'utf8' });
  } catch {
    // Best effort: fall back to a manual remove + prune if `worktree
    // remove` itself failed (e.g. the dir was already gone).
    try {
      spawnSync('chmod', ['-R', 'u+w', wt.path]);
    } catch {
      /* best effort */
    }
    rmSync(wt.path, { recursive: true, force: true });
    try {
      execFileSync('git', ['worktree', 'prune'], { cwd: REPO_ROOT, encoding: 'utf8' });
    } catch {
      /* best effort */
    }
  }
}

export interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Runs one of scripts/release/*.sh synchronously via `bash <path> <args>`,
 * with a caller-supplied env layered on top of the current process env (so
 * PATH/HOME/etc. are preserved — bun and curl must still resolve).
 */
export function runScript(
  scriptName: string,
  args: string[],
  env: Record<string, string>,
  timeoutMs = 30_000,
): RunResult {
  const scriptPath = join(SCRIPTS_DIR, scriptName);
  const result = spawnSync('bash', [scriptPath, ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    timedOut: Boolean(result.signal) && result.status === null,
  };
}

/** sha256 hex digest of a single file — matches `shasum -a 256 <path> | awk '{print $1}'`. */
export function sha256OfSync(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * Recomputes the aggregate node_modules digest EXACTLY the way
 * build-release.sh / preflight.sh do: `cd` into releaseDir first and use
 * paths relative to it, batched through xargs (see lib.sh / build-release.sh
 * comments on why absolute paths or `-exec ... \;` would both be wrong).
 */
export function nodeModulesDigestSync(releaseDir: string): string {
  const cmd =
    "find app/node_modules -type f -print0 2>/dev/null | sort -z | xargs -0 shasum -a 256 | shasum -a 256 | awk '{print $1}'";
  const result = spawnSync('bash', ['-c', cmd], { cwd: releaseDir, encoding: 'utf8' });
  return result.stdout.trim();
}

export function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * A fresh prod-root env block for one test/describe block. GBRAIN_DATA_DIR
 * is deliberately named `.../home/.gbrain` — service_start() in test mode
 * (lib.sh) requires basename === '.gbrain' and computes GBRAIN_HOME as its
 * parent itself.
 */
export function freshEnv(overrides: Record<string, string> = {}): {
  root: string;
  dataDir: string;
  homeParent: string;
  env: Record<string, string>;
} {
  const root = makeTempDir('gbrain-release-test-root-');
  const homeParent = makeTempDir('gbrain-release-test-home-');
  const dataDir = join(homeParent, '.gbrain');
  const env: Record<string, string> = {
    GBRAIN_PROD_ROOT: root,
    GBRAIN_DATA_DIR: dataDir,
    GBRAIN_HTTP_PORT: '18765',
    GBRAIN_DEPLOY_TEST_MODE: '1',
    GBRAIN_LAUNCHD_PLIST: join(root, 'nonexistent.plist'),
    ...overrides,
  };
  return { root, dataDir, homeParent, env };
}

/**
 * Removes BOTH temp dirs a `freshEnv()` call created (`root` AND
 * `homeParent` — easy to forget the latter since most assertions only
 * touch `root`). `chmod -R u+w` first: a real published release under
 * `root/releases/*` is chmod 555'd by build-release.sh, which blocks a
 * plain `rm -rf`.
 */
export function removeFreshEnv(fe: { root: string; homeParent: string }): void {
  for (const dir of [fe.root, fe.homeParent]) {
    try {
      spawnSync('chmod', ['-R', 'u+w', dir]);
    } catch {
      /* best effort */
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface FixtureReleaseOptions {
  port: number;
  version?: string;
  gitSha?: string;
}

/**
 * Hand-crafts a release directory that passes preflight.sh's structural +
 * checksum checks WITHOUT a real `bun install` / git-archive / bun-runtime
 * copy — used only for negative-path preflight tests (missing files,
 * tampering, port mismatch) and for deploy.sh double-failure fixtures where
 * the release must exist and preflight-pass but its `serve` must never
 * become healthy. `bin/gbrain --version` succeeds (exit 0); `bin/gbrain
 * serve ...` hangs forever (ignoring the smoke test) until killed by
 * service_stop — deliberately never binds the port, so smoke-test.sh's
 * /health wait always times out.
 *
 * The REAL build-release.sh pipeline (git archive + bun install + pinned
 * bun runtime) is exercised separately, by tests that actually invoke it —
 * this fixture only proves preflight.sh's/deploy.sh's OWN verification and
 * rollback logic, not gbrain's own runtime behavior.
 */
export function makeFixtureRelease(dir: string, opts: FixtureReleaseOptions): void {
  const version = opts.version ?? '0.0.0-fixture';
  const gitSha = opts.gitSha ?? '0'.repeat(40);
  mkdirSync(join(dir, 'app', 'src'), { recursive: true });
  mkdirSync(join(dir, 'app', 'node_modules'), { recursive: true });
  mkdirSync(join(dir, 'runtime'), { recursive: true });
  mkdirSync(join(dir, 'bin'), { recursive: true });

  writeFileSync(join(dir, 'app', 'src', 'cli.ts'), '// fixture cli.ts — not real gbrain\n');
  writeFileSync(join(dir, 'app', 'package.json'), '{"name":"gbrain-fixture"}\n');
  writeFileSync(join(dir, 'app', 'bun.lock'), '');

  writeFileSync(join(dir, 'runtime', 'bun'), '#!/usr/bin/env bash\necho "fixture-bun-stub"\n');
  chmodSync(join(dir, 'runtime', 'bun'), 0o555);

  const launcher = `#!/usr/bin/env bash
set -euo pipefail
case "\${1:-}" in
  --version)
    echo "gbrain ${version}"
    exit 0
    ;;
  serve)
    # Deliberately never binds the port and never responds — the fixture
    # used by tests that must make smoke-test.sh fail on purpose. Exits
    # cleanly on TERM/INT so service_stop's kill works without lingering.
    trap 'exit 0' TERM INT
    while true; do sleep 1; done
    ;;
  *)
    echo "fixture-gbrain: unsupported command: $*" >&2
    exit 1
    ;;
esac
`;
  writeFileSync(join(dir, 'bin', 'gbrain'), launcher);
  chmodSync(join(dir, 'bin', 'gbrain'), 0o555);

  const cliChecksum = sha256OfSync(join(dir, 'app', 'src', 'cli.ts'));
  const bunChecksum = sha256OfSync(join(dir, 'runtime', 'bun'));
  const launcherChecksum = sha256OfSync(join(dir, 'bin', 'gbrain'));
  const pkgChecksum = sha256OfSync(join(dir, 'app', 'package.json'));
  const lockChecksum = sha256OfSync(join(dir, 'app', 'bun.lock'));
  const nmDigest = nodeModulesDigestSync(dir);

  writeFileSync(
    join(dir, 'checksums.txt'),
    [
      `${cliChecksum}  app/src/cli.ts`,
      `${pkgChecksum}  app/package.json`,
      `${lockChecksum}  app/bun.lock`,
      `${bunChecksum}  runtime/bun`,
      `${launcherChecksum}  bin/gbrain`,
      '',
    ].join('\n'),
  );

  const manifest = {
    release_name: dir.split('/').pop(),
    version,
    git_sha: gitSha,
    git_sha_short: gitSha.slice(0, 7),
    source_dirty: false,
    built_at: new Date().toISOString(),
    bundle_type: 'runtime-bundle',
    port: opts.port,
    public_url: 'https://example.invalid',
    routes_expected: ['/mcp', '/mcp-v2', '/health'],
    launcher_checksum_sha256: launcherChecksum,
    bun_runtime: {
      source_path: join(dir, 'runtime', 'bun'),
      version: 'fixture',
      sha256: bunChecksum,
    },
    dependency_count: 0,
    node_modules_digest_sha256: nmDigest,
    install_flags: '--production --frozen-lockfile --ignore-scripts',
  };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  writeFileSync(join(dir, 'source.diff'), '');
}

/**
 * A fixture release whose `serve` genuinely binds the port and answers
 * smoke-test.sh's real checks (/health with matching version, /mcp and
 * /mcp-v2 both 401) — unlike makeFixtureRelease's launcher, which never
 * binds anything. Used for Phase 3B-36's end-to-end deploy simulation: on
 * TERM it releases its port IMMEDIATELY (mirroring how gbrain unbinds its
 * listener early) but only deletes its lock-like files, and actually
 * exits, after `shutdownDelaySeconds` — reproducing the real incident's
 * shape (port-free does not imply process-gone) against the REAL
 * deploy.sh, not a reimplementation. Requires a real `bun` on PATH (the
 * dev/test machine's own — never a fixture stub) to run the inline HTTP
 * server; `runtime/bun`'s own file content is irrelevant here since this
 * launcher never delegates to it.
 */
export function makeSlowShutdownFixtureRelease(
  dir: string,
  opts: FixtureReleaseOptions & { shutdownDelaySeconds: number; unhealthy?: boolean },
): void {
  mkdirSync(join(dir, 'app', 'src'), { recursive: true });
  mkdirSync(join(dir, 'app', 'node_modules'), { recursive: true });
  mkdirSync(join(dir, 'runtime'), { recursive: true });
  mkdirSync(join(dir, 'bin'), { recursive: true });

  const version = opts.version ?? '0.0.0-fixture';
  const gitSha = opts.gitSha ?? '0'.repeat(40);

  writeFileSync(join(dir, 'app', 'src', 'cli.ts'), '// fixture cli.ts — not real gbrain\n');
  writeFileSync(join(dir, 'app', 'package.json'), '{"name":"gbrain-fixture"}\n');
  writeFileSync(join(dir, 'app', 'bun.lock'), '');
  writeFileSync(join(dir, 'runtime', 'bun'), '#!/usr/bin/env bash\necho "fixture-bun-stub"\n');
  chmodSync(join(dir, 'runtime', 'bun'), 0o555);

  // Inline HTTP server run via the REAL system bun (not runtime/bun, which
  // stays a checksummed-but-inert stub here, matching the base fixture).
  const serverScript = `
const port = Number(process.env.GBRAIN_HTTP_PORT || '${opts.port}');
const dataDir = process.env.GBRAIN_DATA_DIR || process.env.GBRAIN_HOME + '/.gbrain';
const fs = require('fs');
try { fs.mkdirSync(dataDir, { recursive: true }); } catch {}
fs.writeFileSync(dataDir + '/.gbrain-lock', '');
fs.writeFileSync(dataDir + '/postmaster.pid', '');
const server = Bun.serve({
  port,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/health') {
      ${opts.unhealthy ? "return new Response('unhealthy', { status: 500 });" : `return new Response(JSON.stringify({ status: 'ok', version: '${version}', engine: 'fixture' }), {
        headers: { 'content-type': 'application/json' },
      });`}
    }
    if (url.pathname === '/mcp' || url.pathname === '/mcp-v2') {
      return new Response('unauthorized', { status: 401 });
    }
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      return new Response(JSON.stringify({ code_challenge_methods_supported: ['S256'] }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('not found', { status: 404 });
  },
});
process.on('SIGTERM', () => {
  server.stop(true); // port released immediately — mirrors the real race window
  setTimeout(() => {
    try { fs.unlinkSync(dataDir + '/.gbrain-lock'); } catch {}
    try { fs.unlinkSync(dataDir + '/postmaster.pid'); } catch {}
    process.exit(0);
  }, ${Math.round(opts.shutdownDelaySeconds * 1000)});
});
`;
  writeFileSync(join(dir, 'app', 'src', 'fixture-server.js'), serverScript);

  const launcher = `#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "${'${BASH_SOURCE[0]}'}")/.." && pwd)"
case "\${1:-}" in
  --version)
    echo "gbrain ${version}"
    exit 0
    ;;
  serve)
    exec bun "$DIR/app/src/fixture-server.js"
    ;;
  *)
    echo "fixture-gbrain: unsupported command: $*" >&2
    exit 1
    ;;
esac
`;
  writeFileSync(join(dir, 'bin', 'gbrain'), launcher);
  chmodSync(join(dir, 'bin', 'gbrain'), 0o555);

  const cliChecksum = sha256OfSync(join(dir, 'app', 'src', 'cli.ts'));
  const bunChecksum = sha256OfSync(join(dir, 'runtime', 'bun'));
  const launcherChecksum = sha256OfSync(join(dir, 'bin', 'gbrain'));
  const pkgChecksum = sha256OfSync(join(dir, 'app', 'package.json'));
  const lockChecksum = sha256OfSync(join(dir, 'app', 'bun.lock'));
  const nmDigest = nodeModulesDigestSync(dir);

  writeFileSync(
    join(dir, 'checksums.txt'),
    [
      `${cliChecksum}  app/src/cli.ts`,
      `${pkgChecksum}  app/package.json`,
      `${lockChecksum}  app/bun.lock`,
      `${bunChecksum}  runtime/bun`,
      `${launcherChecksum}  bin/gbrain`,
      '',
    ].join('\n'),
  );

  const manifest = {
    release_name: dir.split('/').pop(),
    version,
    git_sha: gitSha,
    git_sha_short: gitSha.slice(0, 7),
    source_dirty: false,
    built_at: new Date().toISOString(),
    bundle_type: 'runtime-bundle',
    port: opts.port,
    public_url: 'https://example.invalid',
    routes_expected: ['/mcp', '/mcp-v2', '/health'],
    launcher_checksum_sha256: launcherChecksum,
    bun_runtime: { source_path: join(dir, 'runtime', 'bun'), version: 'fixture', sha256: bunChecksum },
    dependency_count: 0,
    node_modules_digest_sha256: nmDigest,
    install_flags: '--production --frozen-lockfile --ignore-scripts',
  };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  writeFileSync(join(dir, 'source.diff'), '');
}

/** Reads and JSON.parses a release's manifest.json. */
export function readManifest(releaseDir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(releaseDir, 'manifest.json'), 'utf8'));
}

/**
 * Writes a minimal, valid launchd plist for preflight.sh's DCR-disabled
 * deployment invariant test (Phase 3B-34) — a real `plutil -lint`-clean XML
 * plist with a `ProgramArguments` array (the launch command/flags) and an
 * `EnvironmentVariables` dict carrying a fake, obviously-marked "token" so
 * tests can assert it never leaks into preflight's stdout/stderr (the
 * invariant must read ONLY :ProgramArguments, never :EnvironmentVariables).
 */
export function makeFixturePlist(path: string, opts: { programArgs: string[]; fakeToken?: string }): void {
  const argsXml = opts.programArgs.map(a => `        <string>${a}</string>`).join('\n');
  const token = opts.fakeToken ?? 'FIXTURE-TOKEN-MUST-NEVER-APPEAR-IN-PREFLIGHT-OUTPUT-9f2c';
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.user.gbrain.fixture</string>
    <key>ProgramArguments</key>
    <array>
${argsXml}
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>GBRAIN_ADMIN_BOOTSTRAP_TOKEN</key>
        <string>${token}</string>
    </dict>
</dict>
</plist>
`;
  writeFileSync(path, plist);
}
