# gbrain Production Deployment

Versioned-release deployment pipeline (bd task `dashboard-yct90`). Replaces
the prior setup where the production `com.user.gbrain` launchd service ran
`bun` directly against the live git working tree at
`/Users/lab/AI_Workspace/gbrain` — meaning any uncommitted edit, `git
stash`, or `git checkout` in that repo took effect on the next service
restart. That's exactly what caused an incident: a session temporarily
stashed unrelated uncommitted changes and unknowingly broke the live
ChatGPT Connector's `/mcp-v2` route until the stash was restored.

## Design

```
/Users/lab/AI_Production/gbrain/
  releases/
    <YYYYMMDDHHMMSS>-<git-short-sha>/
      app/                  git-archive snapshot of HEAD at build time:
                             src/, package.json, bun.lock, node_modules/
                             (installed fresh — see "Runtime bundle" below)
      runtime/
        bun                 pinned COPY of the bun executable used to build
                             this release (see "Why the Bun runtime is
                             pinned")
      bin/
        gbrain              thin launcher — the ONLY thing launchd ever
                             invokes (see "Launch contract")
      manifest.json
      checksums.txt
      source.diff           full `git diff HEAD` at build time (empty file
                             if the tree was clean)
  current -> releases/<...>  atomically-swapped symlink; what's live now
  previous -> releases/<...> the release before `current`; rollback target
  shared/
    data -> /Users/lab/.gbrain    (symlink — see "Persistent data")
    config -> /Users/lab/.gbrain  (same target; config.json and
                                   brain.pglite live together)
    logs/       deploy tooling's own logs (build-release.log,
                preflight.log, deploy.log, rollback.log, cleanup.log,
                status.log) — NOT gbrain's own service log, which stays at
                /Users/lab/Library/Logs/gbrain.log (unchanged)
    backups/    pre-cutover data snapshots (see "Backups")
```

### Runtime bundle, not a single binary — see ADR-0001

`docs/adr/0001-single-binary-rejected.md` records why: a `bun build
--compile` binary fails to initialize PGLite's embedded WASM payload on
this machine's Bun version, for BOTH a fresh `gbrain init` and opening an
already-initialized database. The runtime bundle instead packages the
currently-proven-working execution mode ("bun running the TypeScript
source directly") into an immutable, versioned copy:

- `app/` is a `git archive HEAD` snapshot — physically incapable of
  including uncommitted changes, since `git archive` only ever emits
  committed content.
- Dependencies are installed FRESH into the snapshot via `bun install
  --production --frozen-lockfile --ignore-scripts` — never a copy of the
  dev repo's own `node_modules`. `--ignore-scripts` is load-bearing, not
  optional: gbrain's own `package.json` has a `postinstall` hook that
  shells out to `which('gbrain')` and runs `apply-migrations` against
  whatever that resolves to — on this machine, that's the live production
  symlink chain. Without `--ignore-scripts`, building a release could
  silently run a migration command against the real production database.

### Why the Bun runtime is pinned

Each release carries its own COPY of the `bun` executable (`runtime/bun`),
not just a recorded version string. This makes a release immune to a
future global `bun upgrade` — the exact bug ADR-0001 documents was
Bun-version-specific, so "the same `bun.lock`" is not a strong enough
guarantee; "the same `bun`" is. `manifest.json` records the source path,
version, and SHA-256 of the pinned binary.

### Launch contract

launchd's `ProgramArguments[0]` is **only ever**
`/Users/lab/AI_Production/gbrain/current/bin/gbrain`. `bin/gbrain` is a
thin launcher:

```bash
#!/usr/bin/env bash
set -euo pipefail
RELEASE_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec "$RELEASE_DIR/runtime/bun" "$RELEASE_DIR/app/src/cli.ts" "$@"
```

This is the entire contract launchd depends on. It resolves its own real
directory via `cd -P` (physically, following symlinks) rather than trusting
`current` — this matters because a rollback can repoint `current` while a
process from the OLD release is still shutting down; the launcher must
resolve to ITS OWN release, not whatever `current` happens to point at by
the time it runs. If single-binary packaging ever becomes viable (see
ADR-0001's re-evaluation conditions), only `build-release.sh`'s internals
need to change — launchd, Caddy, and the deploy/rollback/smoke-test scripts
never need to know or care what's inside a release.

**`WorkingDirectory` in the launchd plist stays `/Users/lab`, unchanged.**
gbrain's config/data path resolution (`configDir()` in
`src/core/config.ts`) is `$HOME`-relative via `GBRAIN_HOME` (or `homedir()`
when unset), never cwd-relative — confirmed empirically. Changing
`WorkingDirectory` has no benefit and one real risk: `serve-http.ts` has a
`process.cwd() + 'admin/dist'` dev-convenience fallback for serving the
admin UI from disk instead of the embedded bundle; leaving `WorkingDirectory`
at `/Users/lab` (where no `admin/dist` exists) keeps that fallback
inert, exactly as it is today.

**Only `ProgramArguments[0]` changes.** `--port 8765`, `--public-url`,
`KeepAlive`, `ThrottleInterval`, and the log paths are untouched — Caddy
(`/Users/lab/AI_Tools/gbrain-chatgpt-connector/e7b-canary/proxy-config/Caddyfile`)
hardcodes port 8765 for `/mcp`, `/mcp-v2`, and the OAuth endpoints; this is
a hard constraint, not a preference, and Caddy/Tailscale configuration is
out of scope for this pipeline entirely.

### Persistent data

`shared/data` and `shared/config` are symlinks to the SAME existing
directory (`/Users/lab/.gbrain` in production) — never copied, never
migrated, never initialized by this pipeline. PGLite DB, OAuth client
records (stored in the `oauth_clients` table inside that same PGLite DB —
not a separate file), config, and the `remote_auto_link`/
`remote_auto_timeline` feature flags all live there and are completely
unaffected by which release is `current`. Switching releases changes ONLY
which binary/source is running against that unchanged data directory.

### Backups

`deploy.sh` copies `$GBRAIN_DATA_DIR` (real data dir) to
`shared/backups/<timestamp>-pre-<release>/` AFTER stopping the service
(never against a live, actively-written directory) — the same manual
`cp -a` pattern already used once before this pipeline existed
(`~/.gbrain_backup_<timestamp>`), not a new mechanism. There is no
dedicated `gbrain backup` command; this is the existing informal procedure,
automated.

## Operator commands

All scripts are in `scripts/release/` and read their configuration from
environment variables (see `lib.sh` for the full list and defaults) —
running them with no environment overrides targets the real production
root (`/Users/lab/AI_Production/gbrain`) and real data
(`/Users/lab/.gbrain`).

### Build a release

```
scripts/release/build-release.sh
```

Refuses to build from a dirty working tree by default (pass
`--allow-dirty` to override — `source.diff` in the release records exactly
what was uncommitted; a `git archive` snapshot never includes uncommitted
changes either way, so this gate exists purely so nobody is surprised that
uncommitted work silently didn't make it in). Prints the release's absolute
path on success; on any failure, nothing is left under `releases/`.

### Deploy

```
scripts/release/deploy.sh <release-name-or-absolute-path>
```

Preflights the release, stops the service, backs up data, atomically swaps
`current` (and `previous`), starts the service, and runs the smoke test. On
smoke-test failure, automatically rolls back to whatever was `current`
before this deploy and re-verifies — exit code 2 means "deploy failed, but
automatic rollback succeeded and is confirmed healthy"; exit code 3 means
"deploy failed AND there was nothing to roll back to, or the rollback
itself also failed its smoke test" — this needs a human (see "Emergency
recovery" below). Refuses to run if another deploy/rollback is already in
progress (a `mkdir`-based lock under `$GBRAIN_PROD_ROOT/.deploy-lock`, with
stale-PID reaping).

### Rollback (manual)

```
scripts/release/rollback.sh
```

Swaps `current` and `previous` (so a second call re-forwards cleanly),
restarts, smoke-tests. Never attempts a second automatic rollback if its
own smoke test fails — prints manual-recovery instructions instead.

### Status

```
scripts/release/status.sh
```

Read-only: shows `current`/`previous` and their manifests, the full
release list, and a live `/health` ping.

### Cleanup

```
scripts/release/cleanup.sh [--max-keep N] [--apply]
```

Dry-run by default (lists only). `--apply` deletes releases older than the
newest N — but never whatever `current` or `previous` currently resolve to
(re-resolved via `realpath` at delete time, not a cached name, so a
concurrent deploy repointing either symlink mid-cleanup can't slip a live
release past the guard).

### Enabling the remote-auto-link feature flags safely

`remote_auto_link` / `remote_auto_timeline` (see the put_page remote-caller
work, bd `dashboard-h0cfe`) are stored in the shared config/data directory,
completely independent of which release is `current` — a release swap
never resets, enables, or disables them. To change them, the server must be
stopped first (PGLite is single-writer — see `src/core/pglite-lock.ts`):

```
launchctl bootout gui/$(id -u)/com.user.gbrain
gbrain config set remote_auto_link true      # or remote_auto_timeline
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.user.gbrain.plist
```

Never run `gbrain config set` while the service is running — this is the
same PGLite exclusivity constraint every script in this pipeline respects
(build/preflight never touch the production DB; only a stopped service's
data directory is ever mutated directly).

## PGLite exclusivity (read this before touching anything by hand)

`src/core/pglite-lock.ts` implements a strict single-writer lock. Verified
empirically this session: attempting to open the production data directory
from a second process while the service was running produced a clean
`Timed out waiting for PGLite lock` — not corruption, but also not
progress. Every script in this pipeline (`build-release.sh`,
`preflight.sh`) that needs to run a release binary for a sanity check does
so under an **isolated, throwaway `GBRAIN_HOME`**, never the real data
directory, specifically to make this race structurally impossible rather
than relying on timing.

**`GBRAIN_HOME` is a PARENT directory** — gbrain always appends `.gbrain`
itself (`configDir()` in `src/core/config.ts`). If you ever invoke a
release's `bin/gbrain` by hand against a test data directory, set
`GBRAIN_HOME` to that directory's PARENT, not the `.gbrain` directory
itself (a real mistake made — and caught — while validating this pipeline:
setting `GBRAIN_HOME` directly to a `.gbrain`-named directory makes gbrain
look for a nonexistent nested `.gbrain/.gbrain` and report "No brain
configured").

## Emergency recovery

If `rollback.sh` itself reports its own smoke test failed:

1. Check the service log: `tail -100 /Users/lab/Library/Logs/gbrain.log`.
2. Check for a stuck PGLite lock — `pglite-lock.ts`'s own error message
   names the holding PID; only remove the lock if that PID is confirmed
   dead (`ps -p <PID>`):
   `ls -la /Users/lab/.gbrain/.gbrain-lock` → `rm -rf` only if genuinely stale.
3. Check which release `current` actually points to: `readlink
   /Users/lab/AI_Production/gbrain/current`.
4. Restart the service by hand and re-run `scripts/release/smoke-test.sh`.
5. Last resort: point launchd's plist back at the pre-migration
   `ProgramArguments` (`/Users/lab/.bun/bin/gbrain`) — every plist edit this
   pipeline ever makes is preceded by a timestamped backup under
   `shared/backups/`.

Do not attempt a second automatic rollback — this system only tracks two
named slots (`current`/`previous`); repeatedly swapping them makes the
state more confusing, not less.

## What this pipeline deliberately does NOT do

- Does not touch OAuth client registration, PKCE, the Caddy config, or
  Tailscale Funnel configuration — all of that continues to work exactly
  as before, unaware that `current` now points somewhere new.
- Does not migrate, copy into a release, or otherwise touch the actual
  PGLite database beyond a post-stop backup copy.
- Does not branch on which MCP client is calling (ChatGPT vs Claude vs
  Gemini vs anything else) — nothing in this pipeline is client-aware at
  all; it operates purely on the HTTP surface at `127.0.0.1:8765`.
- Does not run `git stash`/`checkout`/`reset` at any point (verified by a
  static test — `test/release/scripts-safety-static.test.ts` — that greps
  every script in `scripts/release/` for these literal strings).
