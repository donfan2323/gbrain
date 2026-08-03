/**
 * Phase 9C (Universal Audit Event Integration) — table-driven proof that
 * every secret category named in PHASE9C-AUDIT-EVENT-DOMAIN-MODEL.md §5-1
 * (absolute prohibition list) and §5-2 (error_message-specific patterns)
 * is redacted before it could reach `audit_events.error_message` or a
 * spill file.
 *
 * Design reference (priority order): PHASE9C-AUDIT-EVENT-DOMAIN-MODEL.md
 * §5-1/§5-2, PHASE9C-ACCEPTANCE-CRITERIA.md §3-7.
 *
 * Primary defense is architectural (Writer callers never pass a raw
 * credential-bearing value into `errorMessageRaw` in the first place —
 * see audit-events-redact.ts's own header comment); this file exercises
 * `redactErrorMessage()` as the SECOND line of defense, which is what §5-1/
 * §5-2 actually specify as the mechanically-testable surface.
 *
 * A real bug was found and fixed while writing this file:
 * `generateToken('gbrain_at_'/'gbrain_rt_')` tokens (access/refresh
 * tokens) were NOT redacted at all — `\b` requires a transition between a
 * word char and a non-word char, and the `_` immediately before the hex
 * digits is itself a word character, so `gbrain_at_<hex>` was one
 * unbroken run of word characters with no internal `\b` for the generic
 * `hex32plus` pattern to anchor on. Fixed in audit-events-redact.ts by
 * adding `gbrain_at_`/`gbrain_rt_` to `known_prefix_secret` and a new
 * `legacy_api_key` pattern for the bare `gbrain_<hex>` shape — see that
 * file's PATTERNS comment for the full account. This file pins the fix as
 * a regression test (the `access_token`/`refresh_token`/`legacy_api_key`
 * rows below).
 */
import { describe, test, expect } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { redactErrorMessage, MAX_ERROR_MESSAGE_LENGTH } from '../src/core/audit/audit-events-redact.ts';

const hex64 = () => randomBytes(32).toString('hex');

interface Case {
  category: string;
  /** The raw secret substring that must NOT survive in the output. */
  secret: string;
  raw: string;
}

function buildCases(): Case[] {
  const accessToken = `gbrain_at_${hex64()}`;
  const refreshToken = `gbrain_rt_${hex64()}`;
  const authCode = `gbrain_code_${hex64()}`;
  const clientSecret = `gbrain_cs_${hex64()}`;
  const legacyApiKey = `gbrain_${hex64()}`;
  const bootstrapToken = hex64();
  const magicLinkToken = hex64();
  const webhookSecretHex = hex64();
  const sessionHex = hex64();
  const codeVerifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const codeChallenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
  const skKey = 'sk-abcdefghijklmnopqrstuvwx1234567890ABCD';
  const ghpKey = 'ghp_1234567890abcdefghijklmnopqrstuvwxyz';
  const akiaKey = 'AKIAIOSFODNN7EXAMPLE';
  const pgUrlPassword = 'hunter2pgpass';
  const genericUrlPassword = 's3cr3tpass';

  return [
    { category: 'access_token', secret: accessToken, raw: `token exchange failed for ${accessToken}` },
    { category: 'refresh_token', secret: refreshToken, raw: `refresh_token ${refreshToken} not found` },
    { category: 'authorization_code', secret: authCode, raw: `code ${authCode} expired` },
    { category: 'client_secret', secret: clientSecret, raw: `client secret ${clientSecret} mismatch` },
    { category: 'legacy_api_key (bootstrap-adjacent gbrain_ bare shape)', secret: legacyApiKey, raw: `api key ${legacyApiKey} revoked` },
    { category: 'bootstrap_token', secret: bootstrapToken, raw: `invalid bootstrap token ${bootstrapToken}` },
    { category: 'magic_link_token', secret: magicLinkToken, raw: `magic link nonce ${magicLinkToken} expired` },
    { category: 'webhook_secret', secret: webhookSecretHex, raw: `HMAC mismatch using webhook_secret=${webhookSecretHex}` },
    { category: 'cookie_header', secret: sessionHex, raw: `request failed, headers: Cookie: gbrain_admin=${sessionHex}` },
    { category: 'set_cookie', secret: sessionHex, raw: `Set-Cookie: gbrain_admin=${sessionHex}; HttpOnly; Secure` },
    { category: 'authorization_header', secret: sessionHex, raw: `request failed: Authorization: Bearer ${sessionHex}` },
    { category: 'jwt', secret: jwt, raw: `invalid token ${jwt}` },
    { category: 'sk- prefix', secret: skKey, raw: `openai call failed with key ${skKey}` },
    { category: 'ghp_ prefix', secret: ghpKey, raw: `github auth failed with token ${ghpKey}` },
    { category: 'AKIA prefix', secret: akiaKey, raw: `aws access failed with key ${akiaKey}` },
    {
      category: 'PEM private key header',
      secret: '-----BEGIN RSA PRIVATE KEY-----',
      raw: 'bad key: -----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA1234567890abcdef\n-----END RSA PRIVATE KEY-----',
    },
    { category: '32+ char hex (generic)', secret: hex64(), raw: `session lookup failed for ${hex64()}` },
    {
      category: 'credentialed URL (postgres DB connection string)',
      secret: pgUrlPassword,
      raw: `connection failed: postgres://admin:${pgUrlPassword}@db.example.com:5432/gbrain`,
    },
    {
      category: 'credentialed URL (generic scheme, embedded password)',
      secret: genericUrlPassword,
      raw: `redirect failed: https://user:${genericUrlPassword}@example.com/callback`,
    },
    { category: 'db_conn_password (key=value form)', secret: 'hunter2pgpass', raw: 'FATAL: password=hunter2pgpass user=postgres host=db.internal.example.com' },
  ];
}

describe('redactErrorMessage: every §5-1/§5-2 secret category is removed from the output', () => {
  for (const { category, secret, raw } of buildCases()) {
    test(`${category}: the raw secret value does not survive`, () => {
      const out = redactErrorMessage(raw);
      expect(out).toBeDefined();
      expect(out).not.toContain(secret);
      expect(out).toContain('<REDACTED:');
    });
  }
});

describe('redactErrorMessage: regression pin for the gbrain_at_/gbrain_rt_ boundary bug', () => {
  test('access token (gbrain_at_<hex>) is fully redacted, not partially — no hex fragment survives', () => {
    const token = `gbrain_at_${hex64()}`;
    const out = redactErrorMessage(`failed: ${token}`)!;
    expect(out).not.toContain(token);
    // Belt-and-suspenders against a partial-match regression: no 16+ char
    // hex run survives anywhere in the output.
    expect(out).not.toMatch(/[0-9a-fA-F]{16,}/);
  });

  test('refresh token (gbrain_rt_<hex>) is fully redacted, not partially', () => {
    const token = `gbrain_rt_${hex64()}`;
    const out = redactErrorMessage(`failed: ${token}`)!;
    expect(out).not.toContain(token);
    expect(out).not.toMatch(/[0-9a-fA-F]{16,}/);
  });

  test('the bare legacy API key shape (gbrain_<hex>, no secondary segment) is redacted', () => {
    const key = `gbrain_${hex64()}`;
    const out = redactErrorMessage(`api key ${key} revoked`)!;
    expect(out).not.toContain(key);
    expect(out).toContain('<REDACTED:legacy_api_key>');
  });

  test('client_id (gbrain_cl_<hex>) is deliberately NOT redacted — a public, non-secret identifier', () => {
    const clientId = `gbrain_cl_${hex64()}`;
    const out = redactErrorMessage(`client ${clientId} not found`)!;
    // The whole point of this test: client_id is meant to stay visible in
    // operator-facing error text (it's how you find the client to fix),
    // and a blanket `gbrain_` prefix pattern would have wrongly swallowed
    // it along with the genuinely secret gbrain_at_/gbrain_rt_/gbrain_
    // (bare) shapes — this is why legacy_api_key requires the WHOLE
    // hex run to reach an unbroken `\b`, not just a shared prefix.
    expect(out).toContain(clientId);
  });
});

describe('redactErrorMessage: size cap truncation', () => {
  test('output over MAX_ERROR_MESSAGE_LENGTH is truncated with a byte-count marker', () => {
    const huge = 'x'.repeat(MAX_ERROR_MESSAGE_LENGTH + 500);
    const out = redactErrorMessage(huge)!;
    expect(out.length).toBeLessThan(huge.length);
    expect(out).toContain('…[truncated 500 chars]');
  });

  test('output exactly at the cap is not truncated', () => {
    const exact = 'y'.repeat(MAX_ERROR_MESSAGE_LENGTH);
    const out = redactErrorMessage(exact)!;
    expect(out).toBe(exact);
    expect(out).not.toContain('truncated');
  });
});

describe('redactErrorMessage: null/undefined/empty handling', () => {
  test('null input returns undefined', () => {
    expect(redactErrorMessage(null)).toBeUndefined();
  });
  test('undefined input returns undefined', () => {
    expect(redactErrorMessage(undefined)).toBeUndefined();
  });
  test('empty string returns undefined (nullable column, not an empty string row)', () => {
    expect(redactErrorMessage('')).toBeUndefined();
  });
  test('idempotent: redacting an already-redacted string is a no-op', () => {
    const once = redactErrorMessage(`token ${hex64()} failed`)!;
    const twice = redactErrorMessage(once)!;
    expect(twice).toBe(once);
  });
});

describe('§5-2 documented residual limitation: arbitrary freeform prose passwords are explicitly out of scope', () => {
  test('a password embedded in natural-language prose (not key=value or URL form) is NOT caught — this is the known, accepted gap, not a bug', () => {
    const raw = 'the operator said the password is hunter2pgpass when asked';
    const out = redactErrorMessage(raw)!;
    // This assertion documents the limitation rather than "proving safety":
    // freeform prose has no syntactic marker for a pattern-matcher to
    // anchor on, exactly as PHASE9C-AUDIT-EVENT-DOMAIN-MODEL.md §5-2 states.
    expect(out).toContain('hunter2pgpass');
  });
});

describe('--log-full-params does not bypass redaction for error_message on OAuth/admin/webhook/delegation events', () => {
  // --log-full-params (serve-http.ts) only affects `params_summary` (the
  // request payload echo) — never `error_message`, which always routes
  // through redactErrorMessage() regardless of that flag. There is no
  // separate code path in audit-events-writer.ts that skips redaction;
  // buildEnvelope() unconditionally calls redactErrorMessage(input.errorMessageRaw)
  // for every call class. This is a structural guarantee, verified here by
  // reading the Writer's own source rather than spinning up a full HTTP
  // server per flag setting.
  test('audit-events-writer.ts calls redactErrorMessage() unconditionally, with no --log-full-params branch around it', async () => {
    const { readFileSync } = await import('node:fs');
    const path = new URL('../src/core/audit/audit-events-writer.ts', import.meta.url).pathname;
    const source = readFileSync(path, 'utf8');
    expect(source).toContain('redactErrorMessage(input.errorMessageRaw)');
    // No conditional gate around the redaction call itself.
    expect(source).not.toMatch(/logFullParams[\s\S]{0,80}redactErrorMessage/);
  });
});
