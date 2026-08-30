# G-Brain maintenance state

G-Brain planned maintenance program 3B is CLOSED after Phase 3B-39.

## Production baseline

- Release: `official-first/v0.47.4` @ `03c318efee4e0d3fa36b59b5b6e0df713d44c79f`, version `0.47.4.0`, schema `v144`.
- Pure official base it was built from: `official-tracking/v0.47.4` @ `c860a411f6fee694a9668cf9d5ffb60af9a7b1eb` — zero local commits on this branch, ever.
- Deployed via the hardened pipeline (Phase 3B-36/37); rollback target `previous` (`20260828044700-04f905750`, v0.46.32.0) is proven direct-rollback-safe against schema v144.

## Upgrade mechanism

Documented in full in [`docs/OFFICIAL-FIRST-UPGRADE.md`](OFFICIAL-FIRST-UPGRADE.md). In short: freeze the new official SHA, run `scripts/release/official-first-plan.sh <old> <new>`, act on its Tier A/B/C classification, create a fresh `official-tracking/<version>` from the frozen SHA, replay `official-first-patchset.json`'s `patches[]` via cherry-pick/rebase in listed order, run the tier's gates, build, deploy, then re-run `--drift` before pushing. `fork/master` is historical/reference lineage only — never the base for a future upgrade. Historical fork-wide diff reconstruction is permanently forbidden (see that file's "Forbidden reconciliation methods").

## Standing patch budget

10 patches tracked in `scripts/release/official-first-patchset.json`. By required-cadence classification:

| Class | Patches |
|---|---|
| MUST REPLAY EVERY OFFICIAL UPDATE (until upstreamed) | `authz-005-006`, `authz-016-017`, `authz-test-fixture-fix` |
| REPLAY ONLY WHILE CLIENT DEPENDENCY EXISTS | the `/mcp-v2` portion of `mcp-v2-authz-013`, `mcp-v2-metrics-fix` |
| MUST REPLAY EVERY OFFICIAL UPDATE (until upstreamed) | the AUTHZ-INV-013 audit-trail portion of `mcp-v2-authz-013` (bundled with the above — see upstream package for the required split) |
| OPTIONAL TOOLING (revisit if it ever conflicts) | `worker-registry-etime` |
| OPS/TEST — no upstream conflict cost | `release-ops-governance`, `dcr-deployment-invariant`, `dcr-invariant-test`, `deploy-stop-backup-race-fix` |

Runtime-source-touching count: **3 essential security/compatibility patch groups** (`authz-005-006`, `authz-016-017`, `mcp-v2-authz-013`) **+ 1 optional tooling patch** (`worker-registry-etime`), reported as two separate numbers, never combined. The 3 security/compat groups are the target for eventual elimination via upstream acceptance (see Upstream contribution below); the ops/test/deploy patches are additive-only against official's file tree and carry effectively zero future conflict cost regardless of upstream churn.

### /mcp-v2 policy

Decision: **KEEP LOCAL ALIAS.** `/mcp-v2` backs a live, configured external Connector; reconfiguring it is a separate, low-risk *operational* task (not a code change), out of scope for this phase. Recommended future step, whenever convenient: confirm the Connector can be repointed at official's own `/mcp`, migrate it, then drop this half of the `mcp-v2-authz-013` patch in the next Official-First refresh once confirmed unused. `/mcp-v2` itself is not an upstream PR candidate — it is a fork-specific compatibility alias for a historical local rename, not a generally useful official feature.

### worker-registry policy

Decision: **KEEP OPTIONAL TOOLING PATCH.** Non-security, test-determinism-only (avoids a timezone-sensitive PID-reuse guard flake under `bun test`'s UTC pinning). A prior attempt to move this entirely into the test harness (Phase 3B-34) was inconclusive — the original failure couldn't be reproduced to validate a harness-only fix against. It has replayed with zero conflicts across two official version bumps (v0.47.3, v0.47.4), so there is no urgency to change it; revisit only if a future replay ever produces a conflict.

### DCR policy

Confirmed design: DCR has no source-level ceiling (the old `DCR_ALLOWED_SCOPES` patch is intentionally dropped — see manifest `dropped_from_old_fork`). It is enforced entirely by `dcr-deployment-invariant`, a deployment-time gate in `preflight.sh` that fails closed if `--enable-dcr` appears in the launchd `ProgramArguments`. Production DCR is currently **disabled**. Future rule: any future *intentional* request to enable DCR triggers a mandatory Tier B security review before deployment — it is never a routine flag flip. No further DCR source work is required now.

## Rollback model

Unchanged from Phase 3B-37: `previous` symlink points at the last-known-good release; `scripts/release/rollback.sh` is governed by the same hardened stop-and-wait sequencing as forward deploys (Phase 3B-36). No manual DB repair path exists or is condoned.

## Deployment pipeline hardening

Phase 3B-36/37: `deploy.sh`'s stop→backup sequencing now blocks on confirmed process exit (`service_stop_and_wait`, PID-based, portable, fail-closed on timeout) instead of a port-check that only warned. Auto-recovery is narrow: it only fires when a stop-wait has *already* confirmed the old process is gone. Proven closed against a real production deployment in Phase 3B-37.

## Upstream contribution roadmap

Packages for the 3 security/compat groups are in [`docs/upstream-patches/`](upstream-patches/): `authz-005-006-delegated-owner-reauth.md`, `authz-016-017-submit-agent-validation.md`, `authz-013-admin-oauth-webhook-audit-trail.md`. Readiness and priority order:

1. `authz-005-006` — HIGH readiness, submit first (isolated, 4 files, 37/37 tests standalone, zero fork dependency).
2. `authz-016-017` — MEDIUM-HIGH readiness, submit after/with #1 (depends on its `logAgentGrantDecision` audit helper).
3. `authz-013` (audit trail) — MEDIUM readiness, needs a mechanical commit split from `/mcp-v2` first (confirmed analytically and physically separable — zero audit calls found inside the `/mcp-v2` route handlers).

`worker-registry-etime` and `/mcp-v2` are not upstream candidates (LOW upstream-usefulness — local test-environment tooling and fork-specific compatibility naming, respectively).

**PRs opened by this maintenance program: NO.** These packages are preparation only, for a future, separately authorized contribution effort.

## Maintenance mode — resume triggers

G-Brain 3B maintenance work resumes only when one of these is true:

1. The upstream planner (`official-first-plan.sh`) classifies a new upstream release as Tier B or Tier C.
2. A P0/P1 security issue is discovered, in G-Brain itself or a dependency.
3. A production defect requires code-level investigation or a fix.
4. A feature is specifically needed for Hermes, Obsidian, or Vibe Trading integration work.
5. A local patch becomes unnecessary because upstream accepts or independently implements an equivalent control — this triggers *removal* work, not new engineering.

Do **not** resume merely because a minor upstream release exists. A Tier A release requires no phase — just the routine replay documented in `OFFICIAL-FIRST-UPGRADE.md`.
