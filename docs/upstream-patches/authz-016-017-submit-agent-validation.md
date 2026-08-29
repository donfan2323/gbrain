# Upstream candidate: submit_agent registration-time delegation validation

Status: READY FOR UPSTREAM PR, sequenced AFTER `authz-005-006` (no PR opened
— see repo policy below)
Local id: `authz-016-017` (manifest: `scripts/release/official-first-patchset.json`)

## Problem statement

Two related gaps in `submit_agent`'s registration-time validation of a
delegated job:

- **INV-016**: a `bound_slug_prefixes` value of `null` was being treated by
  a downstream check as "no restriction" (i.e. unrestricted delegation)
  instead of folding to the empty set (i.e. no delegation at all). `null`
  and "unrestricted" must never be conflated.
- **INV-017**: a delegating client could register a job that hands off a
  tool scope the delegating client does not itself currently hold in its own
  live OAuth scope set — i.e. a client could delegate authority it doesn't
  actually have.

## Security impact

INV-016: a caller could pass `null` for `bound_slug_prefixes` and receive
effectively unrestricted delegated access, bypassing the intended allowlist
model entirely.

INV-017: privilege escalation via delegation — a narrowly-scoped client
could grant a subagent broader tool access than the client itself is
authorized for, because nothing checked the delegator's own live scope set
at registration time.

## Minimal reproduction

- INV-016: register a job with `bound_slug_prefixes: null`. Upstream: the
  downstream check treats this as unrestricted. Expected: `null` folds to
  empty (deny-by-default), same as an explicit empty array.
- INV-017: as client `B` (scoped only to `tool:read`), register a job that
  delegates `tool:write`. Upstream: registration succeeds. Expected:
  registration is rejected because `B`'s own live scope set does not cover
  `tool:write`.

## Patch scope

1 file, 178 insertions / 22 deletions:

- `src/core/ops/jobs.ts` — registration-time validation for both invariants

Verified in isolation: cherry-picks cleanly onto pure official plus
`authz-005-006` (required — see Local dependency below); does **not**
cherry-pick standalone onto pure official alone (`tsc --noEmit` fails with
`TS2339: Property 'logAgentGrantDecision' does not exist`).

## Tests

Focused tests for both invariants, 21/21 passing in
`test/submit-agent.test.ts` when layered on `authz-005-006` + this patch in
isolation from the rest of the local stack.

## Expected behavior after patch

`submit_agent` registration fails closed in both scenarios: `null`
delegation is treated as no delegation, and a delegating client can never
hand off scope broader than its own current live grant.

## Upstream benefit

Closes two real privilege-escalation-adjacent gaps in delegated job
registration — general to any deployment using scope-delegated subagents,
not fork-specific.

## Local dependency (real, not incidental)

This patch's `jobs.ts` calls `agent-audit.ts`'s `logAgentGrantDecision` (8
call sites, via `await import('../minions/agent-audit.ts')`) — a function
only defined by `authz-005-006`'s changes. Confirmed by direct isolation
testing: cherry-picking this patch alone onto pure official produces a
`tsc --noEmit` failure; cherry-picking `authz-005-006` first resolves it
cleanly. **This patch must be proposed upstream after, or together with,
`authz-005-006` — never alone.**

## One patch vs. two

INV-016 and INV-017 are analytically distinct invariants but are kept as
**one** upstream patch: both live in the same function's registration-time
validation flow in the same file, share the same test suite, and landing
either alone would leave registration validation in a visibly incomplete
state (e.g. INV-017 without INV-016 still lets `null` bypass the new
scope-coverage check). One cohesive, well-tested PR is more reviewable here
than two PRs that each look partial in isolation.

## Notes

- No secrets, credentials, or production topology in this package.
- No GitHub PR or issue has been opened — forbidden by this maintenance
  program's repository policy (Phase 3B-39).
