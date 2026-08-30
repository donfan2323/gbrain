# Official-First upgrade workflow

Production runs on `official-first/<version>`: a pure official base plus a
small, explicit, manifest-tracked set of local patches. This replaced the
old `fork/master` full-history reconciliation model (Phase 3B-33 through
3B-37). `fork/master` remains historical/reference lineage — it is **not**
the base for future upgrades.

## Source of truth

- `scripts/release/official-first-patchset.json` — every local patch: which
  commit, which files, why it's required, its risk level. This is the
  authoritative list, not any prose report.
- `scripts/release/official-first-plan.ts` (invoked via
  `official-first-plan.sh`) — reads the manifest and answers "what changed,
  does it matter, what tier is this" without merging or touching anything.

## Normal future workflow

1. Upstream monitor reports a meaningful release.
2. Freeze the exact official SHA — don't track a moving branch.
3. Run the planner:
   ```
   scripts/release/official-first-plan.sh <old-official-sha> <new-official-sha>
   ```
   It reports upstream commit/file counts, whether any local patch file or
   security-sensitive area was touched, whether the migration ceiling
   moved, and a `TIER A` / `TIER B` / `TIER C` classification with reasons
   and a recommended check list. Add `--json` for machine-readable output.
4. Act on the tier (see below).
5. Create a fresh `official-tracking/<new-version>` branch pointing exactly
   at the frozen SHA — zero local commits on it, ever.
6. Create `official-first/<new-version>` from that pure base and replay the
   manifest's `patches[]` in listed order via cherry-pick/rebase. **Never**
   reconstruct via a diff against an old fork snapshot (see below).
7. Run the tier-specific gates the planner recommended.
8. Build via `scripts/release/build-release.sh`.
9. Deploy via `scripts/release/deploy.sh` (governed, hardened stop→backup
   sequencing — see Phase 3B-36).
10. After a successful deploy, regenerate the manifest's `patches[].commit`
    SHAs to match the new branch's actual commits, and run
    `official-first-plan.sh --drift` to confirm the runtime delta still
    matches exactly what's approved before pushing.

## Tier reference

| Tier | Trigger | Required checks |
|---|---|---|
| **A** — routine | No local patch file, security area, or migration touched | Patch replay, affected-area tests, release-tooling tests, `tsc`, build/preflight |
| **B** — security-sensitive | Upstream touches a local AUTHZ patch file, OAuth/auth, privacy/source-scope, remote access, credential handling, or HTTP auth surface; or exactly one new migration | Tier A, plus: focused semantic audit of touched high-risk files, full AUTHZ suite, source-scope/OAuth sweep, migration rehearsal, full suite if broad enough |
| **C** — major/high-risk | Multiple/unknown migrations, destructive migration, DB engine change, ≥15-commit squash wave, architecture replacement, broad auth rewrite, or rollback compatibility uncertainty | Tier B, plus: full intake/reconciliation audit, disposable migration test, rollback rehearsal against the actual current production binary, one-time full suite, a fully governed deployment plan |

The planner never downgrades an unknown state to Tier A — an undeterminable
migration ceiling, a missing manifest, or a broken history relationship all
fail closed (non-zero exit, explicit error) rather than silently reporting
routine.

## Forbidden reconciliation methods

Do **not** use, for any future update:

- merging historical `fork/master` into a new official base
- a broad old-fork → new-fork whole-tree diff applied onto current official
- any reconstruction method that diffs against a fork snapshot older than
  the *current* official base

These methods were used exactly once, out of necessity, to bootstrap the
very first `official-first/v0.47.3` candidate (Phase 3B-34) — and that one
use silently reverted an unrelated official feature (`/metrics`, #3893)
that the old fork snapshot simply predated. It was caught by the one-time
full-suite gate, not by inspection. The approved model going forward is
strictly:

> pure official base → cherry-pick/rebase-replay the manifest's clean patch
> commits, in order, resolving conflicts only in the files
> `official-first-patchset.json`'s `high_risk_files` already flags.

## Drift check

`official-first-plan.sh --drift` compares `official-tracking/<version>`
against `official-first/<version>` and confirms the actual `src/` delta is
*exactly* the manifest's `approved_runtime_files` — no more, no less. It
also flags two specific known regressions: the old `DCR_ALLOWED_SCOPES`
source-level ceiling (replaced by a deployment invariant) or
`remote_auto_link`/`remote_auto_timeline` (confirmed unused, dropped)
silently reappearing. Run it before every commit that touches
`official-first/<version>`'s runtime files.
