// TEMPORARY DIAGNOSTIC MODULE (Unit E-6, 2026-07-25).
// Observes every HTTP request reaching the gbrain server (all paths, all
// methods, known and unknown routes, before any router/SDK path rewriting)
// to investigate a ChatGPT Connector "could not access server" report that
// occurs even before the OAuth handshake begins. Read-only observation only:
// never alters status codes, response bodies, or request handling. Separate
// log file from the Unit E-1/E-4 OAuth-specific diagnostic
// (oauth-diagnostic.ts) — this module never touches that file.
//
// Redaction rules (must never appear in cleartext in this log):
// Authorization header value, Cookie, Set-Cookie, token, authorization code,
// code_verifier, full code_challenge, client secret, request body, response
// body, full query string, state value, full client_id, PII, any credential.
// Only the specific safe query fields below may carry a raw (non-boolean)
// value, because they are not sensitive: response_type, code_challenge_method.
// Everything else sensitive is reduced to a `_present` boolean, or (for
// redirect_uri) to its origin only (scheme+host+port, never the path/slug).

import { appendFileSync } from 'fs';

export const INGRESS_DIAGNOSTIC_LOG_PATH = '/Users/lab/Library/Logs/gbrain-http-ingress-diagnostic.jsonl';

export interface SafeQueryFields {
  response_type?: string;
  code_challenge_present: boolean;
  code_challenge_method?: string;
  state_present: boolean;
  resource_present: boolean;
  redirect_uri_origin?: string;
  scope_present: boolean;
  client_id_present: boolean;
}

function isPresent(value: unknown): boolean {
  return value !== undefined && value !== null && value !== '';
}

function asStringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Reduce an Express req.query object to only the fields safe to persist in
 * the ingress diagnostic log. Never throws — a malformed redirect_uri (or any
 * other unexpected shape) degrades to `undefined` fields rather than an
 * exception, since this runs on the hot path of every request.
 */
export function extractSafeQueryFields(query: Record<string, unknown>): SafeQueryFields {
  let redirectUriOrigin: string | undefined;
  const redirectUri = asStringOrUndefined(query.redirect_uri);
  if (redirectUri) {
    try {
      redirectUriOrigin = new URL(redirectUri).origin;
    } catch {
      redirectUriOrigin = undefined;
    }
  }

  return {
    response_type: asStringOrUndefined(query.response_type),
    code_challenge_present: isPresent(query.code_challenge),
    code_challenge_method: asStringOrUndefined(query.code_challenge_method),
    state_present: isPresent(query.state),
    resource_present: isPresent(query.resource),
    redirect_uri_origin: redirectUriOrigin,
    scope_present: isPresent(query.scope),
    client_id_present: isPresent(query.client_id),
  };
}

/**
 * Append one structured, pre-redacted event to the HTTP ingress diagnostic
 * log. Never throws — a logging failure must not affect the request it is
 * observing. Mirrors oauth-diagnostic.ts's oauthDiagLog design, but writes to
 * a separate file so this Unit's additions never touch the existing
 * Unit E-1/E-4 OAuth-specific log.
 */
export function ingressDiagLog(event: Record<string, unknown>): void {
  try {
    const line = JSON.stringify({ timestamp: new Date().toISOString(), ...event }) + '\n';
    appendFileSync(INGRESS_DIAGNOSTIC_LOG_PATH, line, { mode: 0o600 });
  } catch (e) {
    try {
      console.error(
        '[ingress-diagnostic] log write failed (sanitized, non-fatal):',
        e instanceof Error ? e.message : 'unknown error',
      );
    } catch {
      // even the warning failed; give up silently rather than risk throwing
      // from inside a logging helper.
    }
  }
}
