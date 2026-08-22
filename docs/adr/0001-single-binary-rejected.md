# ADR-0001: `bun build --compile` single-binary rejected for production release packaging

Status: Rejected (this round). See "Conditions for re-evaluation" below.

Related: dashboard-yct90 (gbrain versioned production deployment and rollback).

## Context

The initial design for a versioned-release production deployment pipeline
proposed packaging each release as a single compiled binary via
`bun build --compile --outfile bin/gbrain src/cli.ts`. This was chosen
because `package.json` already ships a `"build"` script using this exact
command, `src/admin-embedded.ts` (the admin UI's embedded assets) is
pre-generated and git-tracked, and a CI guard
(`scripts/check-wasm-embedded.sh`) already asserts that compiled binaries
correctly embed the tree-sitter WASM grammars used for code chunking.

## What was actually tested

Environment: Bun `1.3.10` (Mach-O 64-bit arm64, installed at
`/Users/lab/.bun/bin/bun`), macOS, this machine (Mac mini). Compile command:

```
bun build --compile --outfile <staging>/bin/gbrain src/cli.ts
```

This compile step itself always succeeded and produced a runnable binary —
`<binary> --version` printed the correct version string every time it was
tried. That is the full extent of what had actually been verified before
this ADR's investigation; earlier apparent "successes" in this same working
session had only ever exercised `--version` (which does not touch the
database) or hit a PGLite advisory-lock timeout when pointed at the live
production data directory while the production server was already running
(which proves the process got far enough to attempt a lock acquisition, not
that database initialization itself succeeded).

Two further tests were run, safely, with the real production `com.user.
gbrain` launchd service stopped for the minimum time needed and immediately
restarted afterward (a full production-data backup was taken beforehand;
both tests were read-only with respect to production data):

1. **Fresh database initialization** — `<compiled-binary> init --pglite
   --no-embedding --yes` against an empty, isolated `GBRAIN_HOME`. Result:
   failed immediately with:

   ```
   PGLite failed to initialize its WASM runtime.
     This looks like a Bun vfs issue: `/$$bunfs/root` is read-only on
     your system, so PGLite cannot extract its pglite.data WASM payload.
     Fix: `bun upgrade` (newer Bun mounts the vfs writable). If that
     does not help, run via Node: `node src/cli.ts` or install gbrain
     using the Node-based path. See #1340 for details.
     Original error: ENOENT: no such file or directory, open '/$bunfs/root/pglite.data'
   [unhandledRejection] Error: Extension bundle not found: file:///$bunfs/vector.tar.gz
   [unhandledRejection] Error: Extension bundle not found: file:///$bunfs/pg_trgm.tar.gz
   ```

2. **Opening an already-initialized, real-shape database** — the compiled
   binary was started as `serve --http --port 18765` (a throwaway test port,
   never the production port) with `GBRAIN_HOME` pointed at the actual
   production data directory (real `~/.gbrain`, containing an
   already-initialized `brain.pglite`), with the real production service
   stopped so there was no lock contention. Result: the identical failure —
   the same `pglite.data` / `vector.tar.gz` / `pg_trgm.tar.gz` extraction
   errors, and the process never came up (no response on `/health` within
   the wait window). This is the finding that killed the design: the
   failure is not specific to fresh-`init` — it also prevents opening an
   existing, already-working database, which is the actual, everyday
   production case.

Both times, the real production service was restarted immediately
afterward and confirmed healthy via an authenticated MCP `whoami` call.

## Root cause attribution — what we can and cannot claim

The compiled binary's own error message attributes this to a Bun VFS
(virtual filesystem) issue: `bun build --compile` embeds asset payloads
(here, PGLite's `pglite.data` WASM blob and its `vector`/`pg_trgm` extension
`.tar.gz` bundles) inside the compiled executable and extracts them at
runtime into a synthetic `/$bunfs/` filesystem; the error indicates that
filesystem is read-only in a way that prevents the extraction Bun performs
on demand, and the message names a specific upstream tracking issue
(referenced as "#1340" in gbrain's own source) and suggests `bun upgrade`
as a possible fix ("newer Bun mounts the vfs writable").

We have **not** independently reproduced this against a different Bun
version to confirm the fix works, and have **not** obtained a primary
upstream source (Bun's own issue tracker) confirming the exact scope of the
bug. Per the standard of evidence for this ADR: we do **not** claim this is
uniquely "a Bun 1.3.10 bug" as a general fact. What is verified, precisely:

> **This fails, reproducibly, for the current Bun version (1.3.10) + the
> current PGLite version (`@electric-sql/pglite` as pinned in this repo's
> `bun.lock`) + the current `bun build --compile` invocation, on this
> machine — for both fresh-init and open-existing-database code paths.**

## Decision

Reject the single-binary packaging approach for this iteration of the
production deployment pipeline. Adopt a **runtime bundle** instead: each
release packages a `git archive`-clean snapshot of `src/` (+ `package.json`
+ `bun.lock`) with dependencies installed fresh via `bun install
--production --frozen-lockfile --ignore-scripts`, plus a **pinned copy of
the currently-validated `bun` executable itself** (not just a recorded
version string — a future global `bun upgrade` must not silently change
what a previously-built release does), run via a thin launcher script. This
exactly reproduces the execution mode already proven to work in production
today (`bun` running the TypeScript source directly), just from an
immutable, versioned, working-tree-independent copy instead of the live git
working tree.

See `scripts/release/build-release.sh` for the implementation and
`docs/PRODUCTION-DEPLOYMENT.md` for the resulting release layout and launch
contract.

## Conditions for re-evaluating single-binary packaging

Single-binary packaging may be worth revisiting, as an independent,
separate unit of work (explicitly **not** bundled into production-pipeline
work), if:

- A newer Bun version is verified — in an isolated environment, never via
  an unreviewed global `bun upgrade` — to actually fix PGLite WASM
  extraction for both fresh-init and open-existing-database cases, with the
  same two-part test this ADR ran (not just `--version`).
- Or PGLite/its Bun integration changes to avoid the embedded-archive
  extraction step entirely.
- Or the specific upstream Bun issue this error message references is
  confirmed fixed and the fix is verified in this repo's actual toolchain,
  not assumed from the issue being closed upstream.

Because `bin/gbrain`'s external launch contract (docs/PRODUCTION-
DEPLOYMENT.md, "Launch contract") is fixed regardless of what's inside a
release, switching a future release back to single-binary packaging (if and
when the above is verified) would not require any change to launchd, Caddy,
or the deploy/rollback/smoke-test scripts — only to `build-release.sh`'s
internals.
