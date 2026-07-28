// TEMPORARY DIAGNOSTIC MODULE (Unit E-1, 2026-07-24; extended Unit E-4).
// Added solely to investigate a ChatGPT Connector "connection failed" report
// against the OAuth 2.1 handshake (/authorize, /token) and, as of Unit E-4,
// discovery endpoint access (/.well-known/*). Read-only observation only:
// never alters status codes, redirect targets, response bodies, DB writes,
// or token/code generation. Intended to be removed once root cause is
// confirmed (see gbrain Unit E-1/E-4 tasks).
//
// Redaction rules (must never appear in cleartext in the diagnostic log):
// authorization code, access token, refresh token, code_verifier, full
// code_challenge, cookies, Authorization header, Bearer token, client secret,
// DB connection info, session identifiers, PII. client_id is masked to
// first8...last8; redirect_uri may be logged in full (not a secret).
// Response BODIES are never logged for discovery endpoints (Unit E-4) — only
// request/response metadata (method, path, query, status, user-agent, IP).

import { appendFileSync } from 'fs';

export const OAUTH_DIAGNOSTIC_LOG_PATH = '/Users/lab/Library/Logs/gbrain-oauth-diagnostic.jsonl';

export function maskClientId(id?: string | null): string | undefined {
  if (!id) return undefined;
  if (id.length <= 16) return id;
  return `${id.slice(0, 8)}...${id.slice(-8)}`;
}

/**
 * Light masking for a remote address (Unit E-4). Keeps the value useful for
 * distinguishing "same host" vs "different host" traffic without recording a
 * fully identifying address. IPv4: zero the last octet. IPv6: keep only the
 * first two groups. Anything else (e.g. a hostname) is returned unmasked
 * since it is not a raw address.
 */
export function maskRemoteAddress(addr?: string | null): string | undefined {
  if (!addr) return undefined;
  const ipv4 = addr.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}$/);
  if (ipv4) return `${ipv4[1]}.0`;
  if (addr.includes(':')) {
    const groups = addr.split(':');
    return `${groups.slice(0, 2).join(':')}::`;
  }
  return addr;
}

/**
 * Append one structured, pre-redacted event to the diagnostic log. Never
 * throws — a logging failure must not affect the OAuth request it is
 * observing. On write failure, emits a sanitized one-line warning to the
 * normal gbrain stdout/stderr stream instead (no secrets, just the failure
 * itself).
 */
export function oauthDiagLog(event: Record<string, unknown>): void {
  try {
    const line = JSON.stringify({ timestamp: new Date().toISOString(), ...event }) + '\n';
    appendFileSync(OAUTH_DIAGNOSTIC_LOG_PATH, line, { mode: 0o600 });
  } catch (e) {
    try {
      console.error(
        '[oauth-diagnostic] log write failed (sanitized, non-fatal):',
        e instanceof Error ? e.message : 'unknown error',
      );
    } catch {
      // even the warning failed; give up silently rather than risk throwing
      // from inside a logging helper.
    }
  }
}
