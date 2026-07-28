import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { existsSync, readFileSync, writeFileSync, unlinkSync, statSync } from 'fs';
import {
  INGRESS_DIAGNOSTIC_LOG_PATH,
  extractSafeQueryFields,
  ingressDiagLog,
} from '../src/core/ingress-diagnostic.ts';

// ---------------------------------------------------------------------------
// Preserve any pre-existing production diagnostic log across this suite.
// The log path is a fixed, non-injectable constant (Unit E-6 spec), so we
// snapshot its content/existence before the suite runs and restore it
// afterwards rather than letting test writes leak into real observation data.
// ---------------------------------------------------------------------------
let preexistingContent: string | null = null;

beforeAll(() => {
  preexistingContent = existsSync(INGRESS_DIAGNOSTIC_LOG_PATH)
    ? readFileSync(INGRESS_DIAGNOSTIC_LOG_PATH, 'utf-8')
    : null;
});

afterAll(() => {
  if (preexistingContent === null) {
    if (existsSync(INGRESS_DIAGNOSTIC_LOG_PATH)) unlinkSync(INGRESS_DIAGNOSTIC_LOG_PATH);
  } else {
    writeFileSync(INGRESS_DIAGNOSTIC_LOG_PATH, preexistingContent, { mode: 0o600 });
  }
});

describe('extractSafeQueryFields', () => {
  test('never leaks raw state/code_challenge/client_id/resource values', () => {
    const query = {
      state: 'super-secret-state-xyz',
      code_challenge: 'super-secret-challenge-abc',
      client_id: 'super-secret-client-id-123',
      resource: 'super-secret-resource-value',
    };
    const result = extractSafeQueryFields(query);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('super-secret-state-xyz');
    expect(serialized).not.toContain('super-secret-challenge-abc');
    expect(serialized).not.toContain('super-secret-client-id-123');
    expect(serialized).not.toContain('super-secret-resource-value');
    expect(result.state_present).toBe(true);
    expect(result.code_challenge_present).toBe(true);
    expect(result.client_id_present).toBe(true);
    expect(result.resource_present).toBe(true);
  });

  test('redirect_uri_origin is scheme+host only, no path', () => {
    const result = extractSafeQueryFields({
      redirect_uri: 'https://chatgpt.com/connector/oauth/G8ogYqWkCS8U',
    });
    expect(result.redirect_uri_origin).toBe('https://chatgpt.com');
  });

  test('redirect_uri absent -> undefined origin, no throw', () => {
    expect(() => extractSafeQueryFields({})).not.toThrow();
    const result = extractSafeQueryFields({});
    expect(result.redirect_uri_origin).toBeUndefined();
  });

  test('redirect_uri malformed -> undefined origin, no throw', () => {
    expect(() => extractSafeQueryFields({ redirect_uri: 'not a url' })).not.toThrow();
    const result = extractSafeQueryFields({ redirect_uri: 'not a url' });
    expect(result.redirect_uri_origin).toBeUndefined();
  });

  test('response_type passes through when a string (non-sensitive)', () => {
    const result = extractSafeQueryFields({ response_type: 'code' });
    expect(result.response_type).toBe('code');
  });

  test('code_challenge_method passes through when a string (non-sensitive)', () => {
    const result = extractSafeQueryFields({ code_challenge_method: 'S256' });
    expect(result.code_challenge_method).toBe('S256');
  });

  test('empty query -> all *_present fields false, no throw', () => {
    expect(() => extractSafeQueryFields({})).not.toThrow();
    const result = extractSafeQueryFields({});
    expect(result.state_present).toBe(false);
    expect(result.code_challenge_present).toBe(false);
    expect(result.resource_present).toBe(false);
    expect(result.client_id_present).toBe(false);
    expect(result.scope_present).toBe(false);
  });
});

describe('ingressDiagLog', () => {
  test('appends one JSON Lines entry with timestamp + given fields', () => {
    const before = existsSync(INGRESS_DIAGNOSTIC_LOG_PATH)
      ? readFileSync(INGRESS_DIAGNOSTIC_LOG_PATH, 'utf-8')
      : '';
    ingressDiagLog({ method: 'GET', path: '/authorize', marker: 'unit-e6-test' });
    const after = readFileSync(INGRESS_DIAGNOSTIC_LOG_PATH, 'utf-8');
    expect(after.length).toBeGreaterThan(before.length);
    const newLines = after.slice(before.length).trim().split('\n');
    expect(newLines.length).toBe(1);
    const parsed = JSON.parse(newLines[0]!);
    expect(parsed.method).toBe('GET');
    expect(parsed.path).toBe('/authorize');
    expect(parsed.marker).toBe('unit-e6-test');
    expect(typeof parsed.timestamp).toBe('string');
    expect(new Date(parsed.timestamp).toISOString()).toBe(parsed.timestamp);
  });

  test('log file permission is 0o600 (owner read/write only)', () => {
    ingressDiagLog({ marker: 'unit-e6-test-perm' });
    const mode = statSync(INGRESS_DIAGNOSTIC_LOG_PATH).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
