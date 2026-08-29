# Upstream candidate: revalidate delegated owner authority at execution time

Status: READY FOR UPSTREAM PR (no PR opened — see repo policy below)
Local id: `authz-005-006` (manifest: `scripts/release/official-first-patchset.json`)

## Problem statement

A subagent job can be registered with a `bound_slug_prefixes` delegation from
an owning OAuth client. Once registered, the job may run for an extended
period. If the owning client is revoked or rescoped *after* registration but
*before* the job's tool calls actually execute, the current (upstream)
authorization model still trusts the original registration-time grant for
the tool's entire in-flight lifetime — there is no re-check at execution.

## Security impact

A revoked or narrowed OAuth client's delegated authority silently outlives
the revocation/narrowing for any job already in flight. An attacker (or a
legitimately revoked integration) who registered a long-running job before
being cut off retains effective access until the job naturally completes.

## Minimal reproduction

1. Register a subagent job with `bound_slug_prefixes` delegated from client `A`.
2. Revoke (or narrow the scope of) client `A`.
3. Let the already-registered job execute a delegated tool call.
4. Upstream: the call succeeds using the stale, pre-revocation grant.
   Expected: the call should fail closed once `A`'s live authority no longer
   covers it.

## Patch scope

4 files, 225 insertions / 7 deletions, zero shared lines with any other
local patch, zero fork-specific dependencies:

- `src/core/minions/types.ts` — shared types for the re-authorization check
- `src/core/minions/tools/brain-allowlist.ts` — execution-time owner-authority
  re-validation (the core trust-boundary check)
- `src/core/minions/handlers/subagent.ts` — job-handler wiring
- `src/core/minions/agent-audit.ts` — audit-log producer for grant decisions
  (`logAgentGrantDecision`), also consumed by `authz-016-017` — see Local
  dependency below

Verified in isolation: cherry-picks cleanly onto pure official
(`c860a411f6fee694a9668cf9d5ffb60af9a7b1eb`) with zero conflicts.

## Tests

7 required security tests, all passing standalone against pure official
(37/37 in `test/brain-allowlist.serial.test.ts` — official's own 20 plus 17
added by this patch):

1. valid, unrevoked, unnarrowed owner → allow
2. revoked owner → deny
3. narrowed scope (no longer covers the delegated tool) → deny
4. narrowed source grant → deny
5. authority lookup error → fail closed (deny, not allow)
6. trusted/local execution path → unchanged (no new friction for non-delegated calls)
7. no owner substitution possible (re-check binds to the *original* owner, not a swapped one)

## Expected behavior after patch

Every delegated tool execution re-validates the owning client's live
authority immediately before running, not just at registration time. A
revocation or narrowing takes effect for the next tool call, not just the
next job registration.

## Upstream benefit

Closes a real time-of-check/time-of-use gap in any deployment that supports
long-running delegated subagent jobs — not specific to this fork's
deployment shape.

## Local dependency

None for this patch's own files. It is, however, a **dependency of**
`authz-016-017`: `jobs.ts` calls `agent-audit.ts`'s `logAgentGrantDecision`
(8 call sites) — confirmed by a `tsc --noEmit` failure when `authz-016-017`
was isolated without this patch present. Recommended upstream sequencing:
land this patch first (or in the same PR series before) `authz-016-017`.

## Notes

- No secrets, credentials, or production topology in this package.
- No GitHub PR or issue has been opened for this — repository policy
  (Phase 3B-39) explicitly forbids upstream PR/issue creation from within
  this maintenance program. This package exists so a *future*, explicitly
  authorized contribution effort has everything it needs without re-deriving
  it from scratch.
