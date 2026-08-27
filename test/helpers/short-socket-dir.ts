/**
 * Short, unique temp directories for tests that bind a real AF_UNIX socket
 * inside them (resolve-ipc's `.gbrain-resolve.sock`, 20 bytes including the
 * leading `/`).
 *
 * `os.tmpdir()` returns `process.env.TMPDIR` when set, which some CI/sandbox
 * environments point at a long, deeply-nested path — e.g. a workspace root
 * under a repo/job-id directory. `resolveSocketPath()`'s own socket suffix is
 * fixed, so a long-enough TMPDIR pushes `<dir>/.gbrain-resolve.sock` past the
 * platform's AF_UNIX `sun_path` limit (~104 bytes on macOS, ~108 on Linux) —
 * the bind then silently fails and `startResolveIpcServer()` returns null,
 * which is NOT the production behavior being tested (a real `~/.gbrain` path
 * is always short) and NOT something resolveSocketPath() itself should have
 * to defend against on production's behalf. The fix belongs here, in the
 * test fixture: always build these specific dirs under a short, fixed root,
 * regardless of what TMPDIR happens to be.
 */
import { mkdtempSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A short, fixed, real (non-symlinked — sockets bind on the resolved path)
 * root, independent of the ambient TMPDIR. `/tmp` is the shortest path any
 * POSIX system guarantees; macOS additionally symlinks it to `/private/tmp`,
 * so this resolves that once up front rather than per call.
 */
const SHORT_ROOT = realpathSync('/tmp');

/**
 * Creates a fresh, uniquely-named directory under SHORT_ROOT — short enough
 * that `<dir>/.gbrain-resolve.sock` always stays well under every platform's
 * AF_UNIX path limit, no matter how long the ambient TMPDIR is. `prefix`
 * should be short too (a couple of characters is enough — uniqueness comes
 * from mkdtemp's own random suffix, not from a descriptive name).
 */
export function shortSocketTestDir(prefix = 'sk-'): string {
  return mkdtempSync(join(SHORT_ROOT, prefix));
}
