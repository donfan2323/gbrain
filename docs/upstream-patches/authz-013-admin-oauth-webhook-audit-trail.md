# Upstream candidate: admin/OAuth/webhook/ingest audit trail

Status: NEEDS SMALL REFACTOR (commit split required before extraction — see
below). No PR opened.
Local id: portion of `mcp-v2-authz-013` (manifest:
`scripts/release/official-first-patchset.json`)

## Problem statement

Official's `/admin/*` HTTP surface (login, magic-link issuance, API key
create/revoke, client revoke/rescope/TTL-update, sign-out-everywhere, client
registration, magic-link redemption), GitHub webhook handling, OAuth
credential/token flows, and ingest paths currently produce **zero**
structured audit-log entries upstream. There is no record of who performed
a sensitive admin action, when, or with what parameters.

## Security impact

No audit trail for admin authority actions (revoking a client, minting an
API key, signing out every session) or for webhook/OAuth-credential
handling means a compromise or misuse of admin access leaves no forensic
record. This is a detection/response gap, not an active vulnerability.

## Minimal reproduction

Perform any `/admin/*` action (e.g. `admin_revoke_client`) against pure
official. No audit log entry is produced anywhere. Expected: a structured,
queryable audit record with actor, action, target, and timestamp.

## Patch scope (as currently committed)

Currently bundled into a single commit (`c8898d0e3`) together with the
`/mcp-v2` route alias, inside one file: `src/commands/serve-http.ts`
(703 changed lines across the full commit, audit-logging and route-alias
code interleaved).

Audit-log action names, all confirmed generic to official's own `/admin/*`
surface (zero `/mcp-v2` dependency): `admin_login`,
`admin_issue_magic_link`, `admin_create_api_key`, `admin_revoke_client`,
`admin_rescope_client`, `admin_update_client_ttl`,
`admin_sign_out_everywhere`, `admin_register_client`,
`admin_magic_link_redeem`, `admin_revoke_api_key`. Plus 34 additional call
sites across four producer functions (`logGithubWebhookAudit`,
`logOAuthCredentialAudit`, `logSdkOAuthFallbackAudit`, `logIngestAudit`),
also all tied to official's own generic webhook/OAuth/ingest endpoints.

## Required refactor before extraction

This commit must be **split** before it can be proposed upstream
independently: the audit-logging producer functions and their call sites
must be separated from the `/mcp-v2` route-mounting lines in the same file.
This is a mechanical extraction (no logic changes needed), not a redesign.

## Analytical separability (evidence, gathered this phase)

The two concerns are bundled in one commit purely by historical convenience
(both were authored in the same local development pass), not because of any
code dependency:

- Zero audit-log calls found inside the `/mcp`+`/mcp-v2` route handler
  bodies specifically (confirmed via an `awk` range-scan over the handler
  bodies: 0 matches for any of the 5 audit-producer function names).
- Only 6 non-comment `mcp-v2` string references in the entire file, and all
  6 are route-mounting lines, not audit-related.
- All 10 `admin_*` audit actions plus the 34 webhook/OAuth-credential/SDK-
  fallback/ingest call sites are attached to official's own pre-existing,
  generic HTTP surface.

**Conclusion: do not carry `/mcp-v2` merely to make this patch easier to
extract. The audit trail is upstream-useful on its own and should be
proposed independently of any `/mcp-v2` compatibility discussion.**

## Tests

Existing coverage (currently exercises the bundled commit as a whole; would
need to be split alongside the code):
`test/admin-authority-audit-coverage.test.ts`,
`test/webhook-audit-coverage.test.ts`,
`test/oauth-credential-audit-coverage.test.ts`,
`test/oauth-sdk-fallback-audit-coverage.test.ts`,
`test/ingest-audit-coverage.test.ts`.

## Expected behavior after patch

Every `/admin/*` action and every webhook/OAuth-credential/SDK-fallback/
ingest event produces a structured audit-log entry with actor, action,
target, and timestamp — independent of whether `/mcp-v2` exists at all.

## Upstream benefit

General-purpose operational/security audit trail for official's own admin
and integration surfaces — useful to any deployment, not fork-specific.

## Local dependency

None functionally. The only "dependency" is the current git history: this
concern is interleaved with `/mcp-v2` in one commit and needs a mechanical
split, not a design change, before separate submission.

## Notes

- No secrets, credentials, or production topology in this package.
- No GitHub PR or issue has been opened — forbidden by this maintenance
  program's repository policy (Phase 3B-39).
