/**
 * Phase 9C (Universal Audit Event Integration) — redaction for
 * `audit_events.error_message` and the URL-summarization helper for
 * `adapter` JSONB.
 *
 * Design reference: PHASE9C-AUDIT-EVENT-DOMAIN-MODEL.md §5.
 *
 * §5-1's absolute prohibition list (access/refresh tokens, authorization
 * codes, code_verifier/code_challenge, client_secret, Cookie/Authorization
 * headers, bootstrap/magic-link tokens, webhook_secret/HMAC signatures) is
 * enforced by callers never passing those values into error_message in the
 * first place (Writer callers construct error_message from already-safe
 * structured error envelopes, not raw exception dumps of credential-bearing
 * code paths) — this module is the second line of defense against secrets
 * that leak into error text incidentally (a thrown DB error embedding a
 * connection string, a stack trace containing a token-shaped substring).
 *
 * Known residual limitation (documented, not hidden): arbitrary freeform
 * prose secrets that don't match any pattern below (e.g. a password typed
 * into a sentence, not a key=value or URL) cannot be caught by regex
 * matching. `scripts/release/lib.sh`'s scan_for_secrets() has the same
 * limitation. redactConnectionInfo() below closes much of this gap for
 * the DB-connection-string / password=/user=/host= shapes specifically,
 * which is broader coverage than a plain token-format allowlist alone.
 */

import { redactConnectionInfo } from './redact-connection-info.ts';

const MAX_ERROR_MESSAGE_LENGTH = 2000;

interface PatternRule {
  kind: string;
  re: RegExp;
}

// Order matters: PEM (multi-line-shaped) and JWT (three dot-separated
// segments) are checked before the generic 32+-hex catch-all so a JWT's
// hex-looking segments don't get partially matched first.
//
// Phase 9C fix (found while writing test/audit-redaction.test.ts):
// generateToken('gbrain_at_'/'gbrain_rt_') tokens (utils.ts) were NOT
// caught by the generic `hex32plus` pattern below — `\b` requires a
// transition between a word char and a non-word char, and `_` (the last
// character of the prefix) is itself a word character, same as the hex
// digits that follow it. `gbrain_at_<hex>` is therefore one unbroken run
// of word characters with no internal `\b` for `hex32plus` to anchor on,
// so the whole token silently passed through unredacted. `gbrain_cs_`/
// `gbrain_code_` were already listed explicitly below and unaffected;
// `gbrain_at_`/`gbrain_rt_` are added here for the same reason. The bare
// `gbrain_<hex>` shape (legacy API key, generateToken('gbrain_')) gets its
// own pattern rather than joining `known_prefix_secret`'s alternation,
// since a shared `gbrain_` prefix would also swallow the public,
// intentionally-visible `gbrain_cl_<hex>` client-id shape — `legacy_api_key`
// requires the whole hex run to reach the trailing `\b` unbroken, which
// `gbrain_cl_`/`gbrain_at_`/etc. structurally cannot do (their 2-4 letter
// segment breaks the hex-digit run after at most 1-2 characters).
const PATTERNS: ReadonlyArray<PatternRule> = [
  { kind: 'bearer_token', re: /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi },
  { kind: 'pem_private_key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { kind: 'jwt', re: /\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { kind: 'known_prefix_secret', re: /\b(?:sk-|ghp_|AKIA|gbrain_cs_|gbrain_code_|gbrain_at_|gbrain_rt_)[A-Za-z0-9_-]+/g },
  { kind: 'legacy_api_key', re: /\bgbrain_[0-9a-fA-F]{16,}\b/g },
  { kind: 'hex32plus', re: /\b[0-9a-fA-F]{32,}\b/g },
];

/**
 * URL-scheme detector reused for the `error_message`-embedded-URL case
 * (PHASE9C-AUDIT-EVENT-DOMAIN-MODEL.md §5-2 "URL redactor適用(汎用化)").
 * Matches `scheme://[userinfo@]rest` and replaces the userinfo segment
 * only, leaving host/path/query in place (error_message keeps more detail
 * than the dedicated `adapter.url_host`/`url_path_prefix` fields below,
 * which intentionally drop the query string entirely).
 */
const URL_WITH_USERINFO_RE = /\b([a-z][a-z0-9+.-]*):\/\/[^\s"'>)]*@[^\s"'>)]*/gi;

function stripUrlUserinfo(text: string): string {
  return text.replace(URL_WITH_USERINFO_RE, (match) => {
    const at = match.lastIndexOf('@');
    const schemeEnd = match.indexOf('://') + 3;
    return match.slice(0, schemeEnd) + '<REDACTED:userinfo>' + match.slice(at);
  });
}

/**
 * Redact `error_message` before it is written to `audit_events` or spill.
 * Pure, idempotent. Returns `undefined` for nullish/empty input so callers
 * can pass it straight through to the INSERT's nullable column.
 */
export function redactErrorMessage(raw: string | null | undefined): string | undefined {
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw !== 'string' || raw.length === 0) return undefined;

  // redactConnectionInfo runs FIRST and consumes whole postgres(ql):// URLs
  // in one shot (its own <REDACTED:pg_url> replacement). stripUrlUserinfo
  // runs second for OTHER schemes (mysql://, redis://, https://, ...) —
  // order matters: running stripUrlUserinfo first would leave a
  // `<REDACTED:userinfo>` marker containing a literal `>`, which
  // redactConnectionInfo's `[^\s"'>)]+` character class then treats as a
  // premature terminator, truncating its own match mid-string.
  let out = redactConnectionInfo(raw);
  out = stripUrlUserinfo(out);
  for (const { kind, re } of PATTERNS) {
    re.lastIndex = 0;
    out = out.replace(re, `<REDACTED:${kind}>`);
  }

  if (out.length > MAX_ERROR_MESSAGE_LENGTH) {
    const truncatedChars = out.length - MAX_ERROR_MESSAGE_LENGTH;
    out = out.slice(0, MAX_ERROR_MESSAGE_LENGTH) + `…[truncated ${truncatedChars} chars]`;
  }
  return out;
}

/**
 * Summarize a URL for the `adapter` JSONB (PHASE9C-AUDIT-EVENT-DOMAIN-
 * MODEL.md §5-2 "URLの扱い"): strip userinfo, drop the query string
 * entirely, keep only host + first path segment. Returns `undefined` on
 * unparseable input rather than throwing (adapter is best-effort context,
 * never load-bearing for authorization or audit integrity).
 */
export function summarizeUrlForAdapter(rawUrl: string): { url_host: string; url_path_prefix: string } | undefined {
  try {
    const parsed = new URL(rawUrl);
    const firstSegment = parsed.pathname.split('/').filter(Boolean)[0] ?? '';
    return {
      url_host: parsed.hostname,
      url_path_prefix: firstSegment ? `/${firstSegment}` : '/',
    };
  } catch {
    return undefined;
  }
}

/** Exported for tests asserting the pattern set hasn't silently drifted. */
export function getErrorMessageRedactionKinds(): ReadonlyArray<string> {
  return PATTERNS.map((p) => p.kind);
}

export { MAX_ERROR_MESSAGE_LENGTH };
