/**
 * Unit TD-1 (Tool Selection Guidance & Safety Metadata).
 *
 * Pins the properties the description rewrite must hold for the 22 target
 * tools: unchanged name/scope/localOnly/mutating, non-empty and not
 * excessively long descriptions, explicit scope disclosure for
 * privileged-scope tools, and no references to operation names that don't
 * actually exist (the sources_remove description previously pointed at a
 * nonexistent `sources_archive` op — see git history for TD-1).
 */

import { describe, test, expect } from 'bun:test';
import { operationsByName } from '../src/core/operations.ts';

// scope/localOnly/mutating captured from authoritative-inventory.json
// (ground truth extracted by executing the real `operations` array — see
// TD-1 review bundle target-selection.md). Any drift here means TD-1
// accidentally touched something beyond description text.
const TARGETS: Record<string, { scope: string; localOnly: boolean; mutating: boolean }> = {
  search: { scope: 'read', localOnly: false, mutating: false },
  query: { scope: 'read', localOnly: false, mutating: false },
  whoami: { scope: 'read', localOnly: false, mutating: false },
  advisor: { scope: 'read', localOnly: false, mutating: false },
  think: { scope: 'write', localOnly: false, mutating: true },
  get_health: { scope: 'admin', localOnly: false, mutating: false },
  get_stats: { scope: 'admin', localOnly: false, mutating: false },
  get_brain_identity: { scope: 'read', localOnly: false, mutating: false },
  list_pages: { scope: 'read', localOnly: false, mutating: false },
  sources_list: { scope: 'read', localOnly: false, mutating: false },
  sources_status: { scope: 'read', localOnly: false, mutating: false },
  delete_page: { scope: 'write', localOnly: false, mutating: true },
  sources_remove: { scope: 'sources_admin', localOnly: false, mutating: true },
  schema_apply_mutations: { scope: 'admin', localOnly: false, mutating: true },
  submit_agent: { scope: 'agent', localOnly: false, mutating: true },
  run_onboard: { scope: 'admin', localOnly: false, mutating: true },
  retry_job: { scope: 'admin', localOnly: false, mutating: true },
  replay_job: { scope: 'admin', localOnly: false, mutating: false },
  cancel_job: { scope: 'admin', localOnly: false, mutating: true },
  put_page: { scope: 'write', localOnly: false, mutating: true },
  revert_version: { scope: 'write', localOnly: false, mutating: true },
  run_doctor: { scope: 'admin', localOnly: false, mutating: false },
};

// Privileged scopes where a read-only Connector session could plausibly try
// (and fail) to call the tool — these descriptions must say so explicitly.
const PRIVILEGED_SCOPES = new Set(['admin', 'write', 'sources_admin', 'agent']);

describe('TD-1 — target tool identity unchanged', () => {
  for (const [name, expected] of Object.entries(TARGETS)) {
    test(`${name} still registered with unchanged scope/localOnly/mutating`, () => {
      const op = operationsByName[name];
      expect(op).toBeDefined();
      expect(op.scope).toBe(expected.scope as any);
      expect(Boolean(op.localOnly)).toBe(expected.localOnly);
      expect(Boolean(op.mutating)).toBe(expected.mutating);
    });
  }
});

describe('TD-1 — description quality bar', () => {
  for (const name of Object.keys(TARGETS)) {
    test(`${name} description is non-empty and not excessively long`, () => {
      const desc = operationsByName[name].description;
      expect(desc.length).toBeGreaterThan(20);
      expect(desc.length).toBeLessThan(700);
    });
  }

  for (const [name, expected] of Object.entries(TARGETS)) {
    if (!PRIVILEGED_SCOPES.has(expected.scope)) continue;
    test(`${name} (scope=${expected.scope}) description states its own scope requirement`, () => {
      const desc = operationsByName[name].description.toLowerCase();
      expect(desc).toContain(`${expected.scope} scope`);
    });
  }
});

describe('TD-1 — no fabricated alternative-tool references', () => {
  // sources_remove used to point callers at a nonexistent `sources_archive`
  // op (grep-confirmed absent from operations.ts). TD-1 removed the claim
  // rather than inventing a replacement tool.
  test('sources_remove no longer references the nonexistent sources_archive op', () => {
    expect(operationsByName['sources_remove'].description).not.toContain('sources_archive');
    expect(operationsByName['sources_archive']).toBeUndefined();
  });

  // Any operation name mentioned as a companion/alternative in a target
  // description must resolve to a real, currently-registered operation.
  const ALTERNATIVE_MENTIONS: Record<string, string[]> = {
    get_stats: ['get_brain_identity'],
    get_health: ['get_brain_identity'],
    get_brain_identity: ['get_health', 'get_stats'],
    think: ['search', 'query'],
    run_doctor: ['advisor'],
    advisor: ['get_health', 'run_doctor'],
    delete_page: ['restore_page'],
  };
  for (const [name, alts] of Object.entries(ALTERNATIVE_MENTIONS)) {
    for (const alt of alts) {
      test(`${name} description's reference to ${alt} resolves to a real operation`, () => {
        expect(operationsByName[name].description).toContain(alt);
        expect(operationsByName[alt]).toBeDefined();
      });
    }
  }
});

describe('TD-1 — REQUIRED-fix regressions (external adversarial review)', () => {
  // REQUIRED 1: think's handler forces save/take to false for every remote
  // (MCP) caller — `const safeSave = remote ? false : Boolean(p.save);` /
  // `const safeTake = remote ? false : Boolean(p.take);` with the comment
  // "remote callers cannot persist via MCP". The description must not claim
  // the op persists results.
  test('think description does not claim it persists results', () => {
    const desc = operationsByName['think'].description;
    expect(desc).not.toContain('persists results');
    expect(desc.toLowerCase()).not.toContain('persist');
  });

  test('think description still states its write-scope requirement', () => {
    expect(operationsByName['think'].description.toLowerCase()).toContain('write scope');
  });

  // REQUIRED 2: advisor's handler throws OperationError('permission_denied', ...)
  // when mcp.publish_advisor is disabled for a remote caller — it does not
  // return an empty/unavailable value. The description must match the throw.
  test('advisor description does not claim it returns empty/unavailable when disabled', () => {
    const desc = operationsByName['advisor'].description.toLowerCase();
    expect(desc).not.toContain('returns empty');
    expect(desc).not.toContain('unavailable');
  });

  test('advisor description states the actual permission_denied throw behavior', () => {
    expect(operationsByName['advisor'].description).toContain('permission_denied');
  });
});
