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
