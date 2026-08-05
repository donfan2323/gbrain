/**
 * Phase 9E-1 (dashboard-f5jd5): Capability / Namespace / Delegation
 * Constraint types and pure conversion/comparison functions, per
 * `PHASE9E-DELEGATION-DOMAIN-MODEL.md`§1-2 and the 2026-08-03 revision of
 * AUTHZ-INV-005 in `PHASE9A-AUTHORIZATION-INVARIANTS.md`.
 *
 * Pure, engine-free — no I/O, no audit writes. `submit_agent`
 * (`src/core/operations.ts`) expresses its existing narrowing checks
 * through these types without changing their pass/fail outcome (a
 * behavior-preserving refactor — see `PHASE9E-IMPLEMENTATION-SCOPE.md`§1).
 *
 * Constraints intentionally NOT represented here (out of scope for
 * Capability, tracked separately as DelegationConstraint below): budget,
 * concurrency, credential expiry, delegation depth. AUTHZ-INV-005 (2026-08-03)
 * judges Capability by set inclusion and DelegationConstraint by
 * monotonicity (child <= parent) — deliberately different comparison
 * techniques, kept in separate types so they can't be conflated.
 */

import { isRequestedSlugPrefixWithinBound } from './operations.ts';
import { hasScope } from './scope.ts';

export type Direction = 'read' | 'write';

/**
 * Write-side namespace: governs where a delegated caller may write.
 *
 * `slugPrefixes: null` means "no explicit prefix grant" (AUTHZ-INV-016 —
 * ungranted, NOT unrestricted; exercise time falls back to the legacy
 * per-job sandbox). This mirrors the exact NULL/`[]`/non-empty three-way
 * distinction `oauth_clients.bound_slug_prefixes` already has in the
 * database.
 *
 * IMPORTANT: callers constructing a WriteNamespace from an existing DB
 * binding row MUST pass the raw column value through unchanged (`null`
 * stays `null`, `[]` stays `[]`) — do NOT fold `[]` into `null` for the
 * bound side, that would change the `no_slug_prefix_binding` vs
 * `slug_prefix_not_bound` reason_code an existing client sees
 * (`dashboard-5krlu` regression). `[]`-folding (AUTHZ-INV-016) applies
 * only to freshly-arriving REQUEST input — see
 * `normalizeRequestedSlugPrefixes`.
 */
export interface WriteNamespace {
  readonly sourceId: string | null;
  readonly slugPrefixes: readonly string[] | null;
}

/**
 * Read-side namespace. Per `PHASE9E-DELEGATION-DOMAIN-MODEL.md`§1, there is
 * currently no slug-prefix axis on the read side (`dashboard-444rs`,
 * tracked as an out-of-scope upstream gap — dream cycle's synthesize/
 * patterns phases depend on reading the full source) — only source
 * scoping applies.
 */
export interface ReadNamespace {
  readonly sourceId: string | null;
}

/** Capability = (operation set × namespace), AUTHZ-INV-005 (2026-08-03). */
export interface Capability {
  readonly tools: ReadonlySet<string>;
  readonly write: WriteNamespace;
  readonly read: ReadNamespace;
}

/**
 * Constraints that are NOT part of Capability: judged by monotonicity
 * (child's value must not be looser than the parent's), not set inclusion.
 * Phase 9E-1 only represents the fields `submit_agent` already enforces
 * today (`bound_max_concurrent`); `budgetUsdPerDay` is represented
 * structurally but its runtime enforcement is unconfirmed (`dashboard-037qj`
 * — tracked separately, not addressed by this module). Credential expiry
 * and delegation depth are reserved fields for Phase 9E-2 (multi-hop
 * delegation is out of scope for 9E-1) and are intentionally absent from
 * this interface rather than present-but-unused, to keep the type honest
 * about what Phase 9E-1 actually threads through.
 */
export interface DelegationConstraint {
  readonly maxConcurrent: number | null;
  readonly budgetUsdPerDay: number | null;
}

/**
 * AUTHZ-INV-016 (2026-08-03): fold an explicit empty array into "ungranted"
 * (null) for freshly-arriving REQUEST input only (e.g. `submit_agent`'s
 * `allowed_slug_prefixes` param). Do NOT apply this to values read from an
 * existing `bound_slug_prefixes` column — see the WriteNamespace doc
 * comment. This normalization is behaviorally inert at both grant time
 * (an empty array already short-circuits the narrowing-check block via a
 * `.length > 0` guard, identically to how null/absent does) and exercise
 * time (`enforceSubagentSlugFence`'s `allowList && allowList.length > 0`
 * treats null and `[]` identically) — it only changes what gets persisted
 * into `minion_jobs.data.allowed_slug_prefixes` for newly-created jobs.
 */
export function normalizeRequestedSlugPrefixes(
  requested: readonly string[] | null | undefined,
): readonly string[] | null {
  if (requested == null) return null;
  if (requested.length === 0) return null;
  return requested;
}

/** Build a Capability from an OAuth client's `bound_*` binding row values,
 * unchanged (see WriteNamespace doc comment for why `slugPrefixes` is not
 * normalized here). */
export function capabilityFromBinding(binding: {
  readonly tools: readonly string[] | null;
  readonly sourceId: string | null;
  readonly slugPrefixes: readonly string[] | null;
}): Capability {
  return {
    tools: new Set(binding.tools ?? []),
    write: { sourceId: binding.sourceId, slugPrefixes: binding.slugPrefixes },
    read: { sourceId: binding.sourceId },
  };
}

/** Build a Capability from a submit_agent request's resolved parameters
 * (already-normalized `slugPrefixes`, already-resolved `tools`). */
export function requestedCapability(
  tools: readonly string[],
  sourceId: string | null,
  slugPrefixes: readonly string[] | null,
): Capability {
  return {
    tools: new Set(tools),
    write: { sourceId, slugPrefixes },
    read: { sourceId },
  };
}

export interface CapabilitySubsetResult {
  readonly ok: boolean;
  /** Requested tools not present in bound.tools, in requested-array order. */
  readonly excessTools: readonly string[];
  /** Requested write slug prefixes not contained within any bound write
   * slug prefix (per `isRequestedSlugPrefixWithinBound`'s slash-boundary
   * semantics), in requested-array order. */
  readonly excessSlugPrefixes: readonly string[];
}

/**
 * Is `requested` entirely contained within `bound`? Operation-set check is
 * plain set inclusion. Write-namespace slug-prefix check reuses
 * `isRequestedSlugPrefixWithinBound` (`dashboard-5krlu`) unchanged — this
 * function does not alter that predicate's semantics, it only expresses
 * the existing two checks (tool subset, slug narrowing) as a single
 * Capability comparison so `submit_agent` can call one function instead of
 * two hand-written loops.
 *
 * `source_id` is intentionally not compared here: `submit_agent` has no
 * request parameter for it today (the job always inherits `bound.sourceId`
 * verbatim, see `dashboard-z7a1o` for the Phase 9E-2 fix that will make
 * source narrowing meaningful). Comparing it now would either be a no-op
 * (requested always equals bound) or would require inventing a request
 * shape that does not exist yet — out of scope for a behavior-preserving
 * refactor.
 *
 * Callers that only want to check one dimension (e.g. tools before slug
 * prefixes are even validated) may pass an empty/null value for the
 * dimension they are not yet ready to check — that dimension trivially
 * reports no excess and does not affect `ok` for the dimension being
 * checked.
 */
export function capabilitySubset(requested: Capability, bound: Capability): CapabilitySubsetResult {
  const excessTools = [...requested.tools].filter(t => !bound.tools.has(t));
  const boundWritePrefixes = bound.write.slugPrefixes ?? [];
  const excessSlugPrefixes = (requested.write.slugPrefixes ?? []).filter(
    sp => !boundWritePrefixes.some(bp => isRequestedSlugPrefixWithinBound(sp, bp)),
  );
  return {
    ok: excessTools.length === 0 && excessSlugPrefixes.length === 0,
    excessTools,
    excessSlugPrefixes,
  };
}

export interface ScopeShortfall {
  readonly tool: string;
  readonly requiredScope: string;
}

/**
 * AUTHZ-INV-017 (2026-08-03, warn-only in Phase 9E-1): does the delegating
 * client's own OAuth scopes cover the required_scope of every tool it is
 * about to hand to the child job? `agent` is a committal-only scope (does
 * not imply `read`/`write`/`admin`, see `scope.ts`'s `IMPLIES` table) — a
 * client can bind tools its own OAuth scopes don't cover, which is the
 * confused-deputy shape AUTHZ-INV-017 names.
 *
 * Returns the list of shortfalls (empty = fully covered). Phase 9E-1
 * records but does not deny on a non-empty result — see `submit_agent`'s
 * use of this function, which writes `reason_code:
 * 'delegation_scope_shortfall'` on the `delegation.grant` audit row but
 * still completes the delegation. Phase 9E-2 will switch this to a denial.
 */
export function delegationScopeShortfalls(
  requestedTools: readonly string[],
  delegatorScopes: readonly string[],
  requiredScopeForTool: (tool: string) => string,
): readonly ScopeShortfall[] {
  const shortfalls: ScopeShortfall[] = [];
  for (const tool of requestedTools) {
    const requiredScope = requiredScopeForTool(tool);
    if (!hasScope(delegatorScopes, requiredScope)) {
      shortfalls.push({ tool, requiredScope });
    }
  }
  return shortfalls;
}

/** Build a DelegationConstraint from an OAuth client's binding row values. */
export function delegationConstraintFromBinding(binding: {
  readonly maxConcurrent: number | null;
  readonly budgetUsdPerDay: number | null;
}): DelegationConstraint {
  return {
    maxConcurrent: binding.maxConcurrent,
    budgetUsdPerDay: binding.budgetUsdPerDay,
  };
}

/**
 * Phase 9E-2e-1 (AUTHZ-INV-005/006/008): multi-level delegation constraint
 * primitives. Pure, engine-free, queue-free, audit-free — a future adapter
 * (not built by this module) is responsible for wiring these into
 * `queue.add()`/`parent_job_id`/`writeAuditEvent`. Multi-hop delegation
 * itself remains disabled until that adapter exists and is wired into
 * `BRAIN_TOOL_ALLOWLIST`.
 *
 * AUTHZ-INV-007 (delegation expiry inheritance) is INTENTIONALLY not
 * addressed here — no expiry field exists on Capability or
 * DelegationConstraint, and none is added by this module. AUTHZ-INV-007
 * remains an unmet invariant (already flagged as such in Phase 9E-1);
 * `minion_jobs.timeout_ms`/`timeout_at` are per-job EXECUTION timeouts,
 * not a delegation lifetime, and are not repurposed as one here.
 */

/**
 * Fixed maximum delegation chain depth: root→child is depth 1, up through
 * depth 5 (grandchild-of-grandchild-of-grandchild). NOT configurable — no
 * GBrainConfig field, env var, CLI flag, or oauth_clients column reads
 * this value. Deliberately distinct from two other, unrelated depth
 * counters already in the codebase:
 *   - self-fix's `SelfFixOpts.max_depth` (default 2, `self-fix.ts`) counts
 *     self-fix RETRY hops (marked via `data.is_self_fix_child`), not
 *     delegation hops. Reusing that constant here would conflate two
 *     independent chain-depth concepts that happen to share a name.
 *   - `MinionQueue`'s generic `maxSpawnDepth` (default 5, `queue.ts`)
 *     counts EVERY `parent_job_id` hop regardless of cause (delegation,
 *     self-fix, or aggregator fan-out). This module's delegation depth is
 *     a semantically distinct counter a future adapter will track via its
 *     own job-data marker (the same pattern self-fix already uses for its
 *     own depth), NOT `minion_jobs.depth` itself.
 */
export const MAX_DELEGATION_DEPTH = 5;

/**
 * AUTHZ-INV-008: re-delegation is permitted ONLY when the CURRENT job's own
 * effective `allowed_tools` (already narrowed at its own grant time — never
 * the root OAuth client's raw `bound_tools`) contains the dedicated
 * delegated-submit adapter tool name. Exact string match only: no case
 * folding, no prefix/substring matching, no fuzzy comparison. An
 * empty-string adapter name never matches (defensive — prevents a
 * mis-called `''` argument from vacuously granting redelegation to every
 * job, since `[''].includes('')` would otherwise be `true`).
 */
export function canRedelegate(
  effectiveAllowedTools: readonly string[] | null | undefined,
  delegatedSubmitToolName: string,
): boolean {
  if (delegatedSubmitToolName.length === 0) return false;
  if (effectiveAllowedTools == null) return false;
  return effectiveAllowedTools.includes(delegatedSubmitToolName);
}

export type RedelegationDepthDecision =
  | { readonly allowed: true; readonly childDelegationDepth: number }
  | { readonly allowed: false; readonly reason: 'delegation_depth_exceeded' | 'invalid_delegation_depth' };

/**
 * AUTHZ-INV-005: the child's delegation depth is always `parent + 1`,
 * fail-closed at `MAX_DELEGATION_DEPTH`. Invalid inputs (non-integer,
 * negative, NaN, ±Infinity) are rejected as `invalid_delegation_depth`
 * BEFORE the range check — a depth value can never simultaneously be
 * `invalid_delegation_depth` and `delegation_depth_exceeded` (mutually
 * exclusive by construction, see the corresponding test).
 */
export function nextDelegationDepth(parentDelegationDepth: number): RedelegationDepthDecision {
  if (
    typeof parentDelegationDepth !== 'number' ||
    !Number.isFinite(parentDelegationDepth) ||
    !Number.isInteger(parentDelegationDepth) ||
    parentDelegationDepth < 0
  ) {
    return { allowed: false, reason: 'invalid_delegation_depth' };
  }
  if (parentDelegationDepth >= MAX_DELEGATION_DEPTH) {
    return { allowed: false, reason: 'delegation_depth_exceeded' };
  }
  return { allowed: true, childDelegationDepth: parentDelegationDepth + 1 };
}

/**
 * AUTHZ-INV-005: is the requested child Capability entirely contained
 * within the CURRENT job's own effective Capability (not the root OAuth
 * client's raw binding)? Reuses `capabilitySubset()` verbatim as the
 * single source of truth for the tools/slug-prefix containment logic — no
 * reimplementation. A single excess entry on either dimension denies the
 * WHOLE request (no partial grant, no automatic narrowing).
 */
export function validateRedelegatedCapability(
  parentEffectiveCapability: Capability,
  requestedChildCapability: Capability,
): CapabilitySubsetResult {
  return capabilitySubset(requestedChildCapability, parentEffectiveCapability);
}

export interface RedelegationConstraintDecision {
  readonly ok: boolean;
  readonly budgetExceeded: boolean;
}

/**
 * DelegationConstraint monotonicity (budget only — `maxConcurrent` is not
 * evaluated here, it is a live concurrency check the future adapter must
 * perform against current queue state, not a static narrowing check).
 * Deliberately kept structurally separate from `validateRedelegatedCapability`
 * (Capability vs. DelegationConstraint must never merge into one object —
 * see the existing "structurally disjoint types" test). `null` on either
 * side means "no ceiling on that side": a null parent budget imposes no
 * limit on the child; a null requested budget means the child inherits the
 * parent's ceiling rather than requesting a new one, so it never exceeds it.
 */
export function validateRedelegatedConstraint(
  parentEffectiveConstraint: DelegationConstraint,
  requestedChildConstraint: DelegationConstraint,
): RedelegationConstraintDecision {
  const parentBudget = parentEffectiveConstraint.budgetUsdPerDay;
  const requestedBudget = requestedChildConstraint.budgetUsdPerDay;
  const budgetExceeded = parentBudget != null && requestedBudget != null && requestedBudget > parentBudget;
  return { ok: !budgetExceeded, budgetExceeded };
}

export type RedelegationDecision =
  | { readonly allowed: true; readonly childDelegationDepth: number }
  | {
      readonly allowed: false;
      readonly reason:
        | 'redelegation_not_granted'
        | 'delegation_depth_exceeded'
        | 'delegated_capability_exceeds_parent'
        | 'invalid_delegation_depth';
      readonly details?: unknown;
    };

/**
 * Composite decision a future delegated-submit adapter can call directly
 * and use its result as a stable deny reason_code with no further
 * translation. Depends on nothing but its inputs — no queue, no DB, no
 * audit, no OperationContext (§13 of this module's design principles).
 *
 * Stable check order (also the reason-code priority when multiple
 * conditions fail simultaneously):
 *   1. redelegation_not_granted        (canRedelegate)
 *   2/3. invalid_delegation_depth /
 *        delegation_depth_exceeded     (nextDelegationDepth — mutually
 *                                        exclusive by construction, so
 *                                        these two never compete with
 *                                        each other for priority)
 *   4. delegated_capability_exceeds_parent (validateRedelegatedCapability)
 *
 * On allow, returns ONLY `{allowed, childDelegationDepth}` — it does not
 * echo back a (possibly narrowed) Capability, so there is no field here
 * that could silently rewrite what the caller requested. Budget
 * (`validateRedelegatedConstraint`) and OAuth-scope (Phase 9E-2d's
 * exercise-time re-resolution) are deliberately NOT folded into this
 * function — they are separate axes with separate call sites in the
 * future adapter, exactly as Capability and DelegationConstraint are kept
 * structurally separate everywhere else in this module.
 */
export function evaluateRedelegation(input: {
  readonly parentAllowedTools: readonly string[] | null | undefined;
  readonly delegatedSubmitToolName: string;
  readonly parentDelegationDepth: number;
  readonly parentEffectiveCapability: Capability;
  readonly requestedChildCapability: Capability;
}): RedelegationDecision {
  if (!canRedelegate(input.parentAllowedTools, input.delegatedSubmitToolName)) {
    return { allowed: false, reason: 'redelegation_not_granted' };
  }
  const depthDecision = nextDelegationDepth(input.parentDelegationDepth);
  if (!depthDecision.allowed) {
    return { allowed: false, reason: depthDecision.reason };
  }
  const capDecision = validateRedelegatedCapability(input.parentEffectiveCapability, input.requestedChildCapability);
  if (!capDecision.ok) {
    return {
      allowed: false,
      reason: 'delegated_capability_exceeds_parent',
      details: { excessTools: capDecision.excessTools, excessSlugPrefixes: capDecision.excessSlugPrefixes },
    };
  }
  return { allowed: true, childDelegationDepth: depthDecision.childDelegationDepth };
}
