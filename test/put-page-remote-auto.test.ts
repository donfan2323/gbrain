/**
 * put_page — client-agnostic opt-in remote auto-link/auto-timeline
 * (v0.43-port, dashboard-h0cfe; ported from historical commit 73a1c6e9 onto
 * the current upstream ops/pages.ts + link-extraction.ts + pglite-engine.ts
 * + postgres-engine.ts).
 *
 * Threat model this exists to close, unchanged from the original: an
 * untrusted remote (MCP) caller could plant a bare-slug mention in a page
 * body to create an inbound link to an arbitrary existing page, inflating
 * that page's search rank via the backlink boost. `remote_auto_link` /
 * `remote_auto_timeline` (both default OFF) let a caller opt into a
 * NARROWED version of local auto-link — remote-created links are tagged
 * link_source='remote-auto', excluded from getBacklinkCounts' ranking
 * boost, never include frontmatter-authored incoming edges, and never
 * touch edges the local path created.
 *
 * All cases run against in-memory PGLite (hermetic, no DATABASE_URL) — the
 * same pattern test/put-page-provenance.test.ts uses. Postgres-side DB
 * parity is verified statically below (both engines' getBacklinkCounts
 * queries carry the identical 'remote-auto' exclusion clause) rather than
 * by running the Postgres suite — this environment has no live Postgres
 * instance.
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { isRemoteAutoLinkEnabled, isRemoteAutoTimelineEnabled } from '../src/core/link-extraction.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';

const putPageOp = operations.find((o) => o.name === 'put_page')!;

let engine: PGLiteEngine;

beforeAll(async () => {
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    env: { ...process.env, OPENAI_API_KEY: process.env.OPENAI_API_KEY || 'sk-test-stub' },
  });
  __setEmbedTransportForTests(async ({ values }: any) => ({
    embeddings: values.map(() => new Array(1536).fill(0)),
    usage: { tokens: 0 },
  }) as any);

  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
  __setEmbedTransportForTests(null);
  resetGateway();
});

beforeEach(async () => {
  // remote_auto_link/remote_auto_timeline flip per-test — wipe config too
  // so nothing bleeds across tests.
  await engine.executeRaw('DELETE FROM links', []);
  await engine.executeRaw('DELETE FROM pages', []);
  await engine.executeRaw('DELETE FROM config', []);
});

function makeCtx(opts: Partial<OperationContext> = {}): OperationContext {
  return {
    engine,
    config: { engine: 'pglite' as const },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
    remote: false,
    sourceId: 'default',
    ...opts,
  };
}

async function seedPage(slug: string, type: string, title: string): Promise<void> {
  await engine.putPage(slug, { type, title, compiled_truth: 'seed body', timeline: '', frontmatter: {} });
}

async function getLinkRows(): Promise<Array<{ from_slug: string; to_slug: string; link_type: string; link_source: string | null }>> {
  return await engine.executeRaw(
    `SELECT f.slug AS from_slug, t.slug AS to_slug, l.link_type, l.link_source
     FROM links l JOIN pages f ON f.id = l.from_page_id JOIN pages t ON t.id = l.to_page_id`,
    [],
  ) as Array<{ from_slug: string; to_slug: string; link_type: string; link_source: string | null }>;
}

async function getTimelineCount(slug: string): Promise<number> {
  const rows = await engine.executeRaw(
    `SELECT COUNT(*)::int AS cnt FROM timeline_entries t JOIN pages p ON p.id = t.page_id WHERE p.slug = $1`,
    [slug],
  ) as Array<{ cnt: number }>;
  return rows[0]?.cnt ?? 0;
}

// ── PAGE-1: ordinary write still works, unaffected by the new flags ──────
describe('PAGE-1: ordinary page creation/update', () => {
  test('remote write succeeds and returns skipped:"remote" for both when flags are OFF (default)', async () => {
    const ctx = makeCtx({ remote: true });
    const result: any = await putPageOp.handler(ctx, {
      slug: 'notes/page1-baseline',
      content: '---\ntype: note\ntitle: Baseline\n---\n\nplain body, no mentions',
    });
    // #4525 (upstream): the skip envelope now carries a `hint` explaining
    // why and what to do about it, instead of a bare {skipped: 'remote'}.
    const remoteSkipHint = 'auto_link/auto_timeline run for trusted local writers only '
      + '(or remote callers with GBRAIN_REMOTE_AUTO_LINK/TIMELINE enabled); '
      + 'body wikilinks were saved as text but NOT reconciled into the graph. '
      + 'Use local `gbrain capture`/`gbrain call put_page` for link extraction.';
    expect(result.auto_links).toEqual({ skipped: 'remote', hint: remoteSkipHint });
    expect(result.auto_timeline).toEqual({ skipped: 'remote', hint: remoteSkipHint });
    const rows = await getLinkRows();
    expect(rows.length).toBe(0);
  });

  test('local write (remote: false) is completely unaffected by remote_auto_* flags being on', async () => {
    await engine.setConfig('remote_auto_link', 'true');
    await engine.setConfig('remote_auto_timeline', 'true');
    await seedPage('people/local-target', 'person', 'Local Target');
    const ctx = makeCtx({ remote: false });
    const result: any = await putPageOp.handler(ctx, {
      slug: 'notes/page1-local',
      content: '---\ntype: note\ntitle: Local\n---\n\nsee people/local-target for context',
    });
    // Local path uses the ORIGINAL isAutoLinkEnabled gate (default ON,
    // unrelated to and unaffected by the remote_auto_* flags being set).
    // The tell: the created edge is tagged 'markdown' (full local behavior),
    // never 'remote-auto' — proving the remote opt-in path never engaged.
    expect(result.auto_links).toMatchObject({ errors: 0 });
    const rows = (await getLinkRows()).filter(r => r.from_slug === 'notes/page1-local');
    expect(rows.some(r => r.to_slug === 'people/local-target' && r.link_source === 'markdown')).toBe(true);
    expect(rows.some(r => r.link_source === 'remote-auto')).toBe(false);
  });
});

// ── LINK-1/2/3 + security: remote_auto_link enabled ───────────────────────
describe('LINK-1/2/3: remote_auto_link enabled', () => {
  test('LINK-1: bare mention of an existing page creates a link_source="remote-auto" edge', async () => {
    await engine.setConfig('remote_auto_link', 'true');
    await seedPage('people/alice-chen', 'person', 'Alice Chen');
    const ctx = makeCtx({ remote: true });
    await putPageOp.handler(ctx, {
      slug: 'notes/link1-existing',
      content: '---\ntype: note\ntitle: Existing Mention\n---\n\nsee people/alice-chen for context',
    });
    const rows = await getLinkRows();
    expect(rows.some(r =>
      r.from_slug === 'notes/link1-existing' && r.to_slug === 'people/alice-chen' && r.link_source === 'remote-auto',
    )).toBe(true);
  });

  test('LINK-2: re-writing the same page with the same mention creates exactly one edge (no duplicate)', async () => {
    await engine.setConfig('remote_auto_link', 'true');
    await seedPage('people/bob-lee', 'person', 'Bob Lee');
    const ctx = makeCtx({ remote: true });
    const content = '---\ntype: note\ntitle: Dup Check\n---\n\nsee people/bob-lee twice, people/bob-lee again';
    await putPageOp.handler(ctx, { slug: 'notes/link2-dup', content });
    await putPageOp.handler(ctx, { slug: 'notes/link2-dup', content });
    const rows = (await getLinkRows()).filter(r => r.from_slug === 'notes/link2-dup' && r.to_slug === 'people/bob-lee');
    expect(rows.length).toBe(1);
  });

  test('LINK-3a: mention of a non-existent slug creates no link row for that target', async () => {
    await engine.setConfig('remote_auto_link', 'true');
    await seedPage('people/link3-real', 'person', 'Real Target');
    const ctx = makeCtx({ remote: true });
    await putPageOp.handler(ctx, {
      slug: 'notes/link3-phantom',
      content: '---\ntype: note\ntitle: Phantom\n---\n\nsee people/link3-real and people/link3-does-not-exist',
    });
    const rows = await getLinkRows();
    expect(rows.some(r => r.to_slug === 'people/link3-real' && r.link_source === 'remote-auto')).toBe(true);
    expect(rows.some(r => r.to_slug === 'people/link3-does-not-exist' || r.from_slug === 'people/link3-does-not-exist')).toBe(false);
  });

  test('LINK-3b (security): a page mentioning its OWN slug creates no self-link', async () => {
    await engine.setConfig('remote_auto_link', 'true');
    const ctx = makeCtx({ remote: true });
    await putPageOp.handler(ctx, {
      slug: 'notes/link3-self',
      content: '---\ntype: note\ntitle: Self Mention\n---\n\nsee notes/link3-self for the full history',
    });
    const selfLinks = await engine.executeRaw(
      `SELECT COUNT(*)::int AS cnt FROM links WHERE from_page_id = to_page_id`, [],
    ) as Array<{ cnt: number }>;
    expect(selfLinks[0]!.cnt).toBe(0);
  });

  test('LINK-3c (security): frontmatter incoming-direction fields create ZERO edges via the remote path', async () => {
    await engine.setConfig('remote_auto_link', 'true');
    await seedPage('people/link3-victim', 'person', 'Victim');
    const ctx = makeCtx({ remote: true });
    await putPageOp.handler(ctx, {
      slug: 'notes/link3-attacker',
      content:
        '---\ntype: note\ntitle: Attacker\nkey_people:\n  - slug: people/link3-victim\n    direction: incoming\n---\n\nbody',
    });
    const rows = await getLinkRows();
    expect(rows.some(r => r.to_slug === 'people/link3-victim')).toBe(false);
  });

  test('security: remote-auto candidate count is capped, with the drop count surfaced via truncated', async () => {
    await engine.setConfig('remote_auto_link', 'true');
    const N = 55; // > REMOTE_AUTO_LINK_MAX_CANDIDATES (50)
    for (let i = 0; i < N; i++) await seedPage(`people/link-cap-${i}`, 'person', `P${i}`);
    const mentions = Array.from({ length: N }, (_, i) => `people/link-cap-${i}`).join(', see also ');
    const ctx = makeCtx({ remote: true });
    const result: any = await putPageOp.handler(ctx, {
      slug: 'notes/link-cap-source',
      content: `---\ntype: note\ntitle: Cap Test\n---\n\nsee ${mentions}`,
    });
    expect(result.auto_links.truncated).toBe(N - 50);
    const rows = (await getLinkRows()).filter(r => r.from_slug === 'notes/link-cap-source');
    expect(rows.length).toBe(50);
  });

  test('security: remote-auto edges are excluded from getBacklinkCounts but still returned by getLinks/getBacklinks', async () => {
    await engine.setConfig('remote_auto_link', 'true');
    await seedPage('people/backlink-target', 'person', 'Target');
    const ctx = makeCtx({ remote: true });
    await putPageOp.handler(ctx, {
      slug: 'notes/backlink-source',
      content: '---\ntype: note\ntitle: Source\n---\n\nsee people/backlink-target',
    });
    const counts = await engine.getBacklinkCounts(['people/backlink-target']);
    expect(counts.get('people/backlink-target')).toBe(0);
    const backlinks = await engine.getBacklinks('people/backlink-target', {});
    expect(backlinks.some(l => l.link_source === 'remote-auto')).toBe(true);
  });

  test('regression: a pre-existing LOCAL markdown edge survives a later remote-auto edit to the same slug', async () => {
    await seedPage('people/coexist-target', 'person', 'Target');
    // First, a local write creates a markdown edge.
    const localCtx = makeCtx({ remote: false });
    await engine.setConfig('auto_link', 'true');
    await putPageOp.handler(localCtx, {
      slug: 'notes/coexist',
      content: '---\ntype: note\ntitle: Coexist\n---\n\nsee people/coexist-target',
    });
    const afterLocal = (await getLinkRows()).filter(r => r.from_slug === 'notes/coexist');
    expect(afterLocal.some(r => r.link_source === 'markdown')).toBe(true);

    // Now flip to remote + remote_auto_link and re-write the SAME slug via
    // the remote path — the local markdown edge must survive untouched.
    await engine.setConfig('remote_auto_link', 'true');
    const remoteCtx = makeCtx({ remote: true });
    await putPageOp.handler(remoteCtx, {
      slug: 'notes/coexist',
      content: '---\ntype: note\ntitle: Coexist\n---\n\nsee people/coexist-target (remote edit)',
    });
    const afterRemote = (await getLinkRows()).filter(r => r.from_slug === 'notes/coexist');
    expect(afterRemote.some(r => r.link_source === 'markdown' && r.to_slug === 'people/coexist-target')).toBe(true);
  });
});

// ── TIMELINE-1/2 ────────────────────────────────────────────────────────
describe('TIMELINE-1/2: remote_auto_timeline enabled', () => {
  test('TIMELINE-1: a strict date-line body creates a timeline entry', async () => {
    await engine.setConfig('remote_auto_timeline', 'true');
    const ctx = makeCtx({ remote: true });
    const result: any = await putPageOp.handler(ctx, {
      slug: 'notes/timeline1',
      content: '---\ntype: note\ntitle: Timeline Test\n---\n\n**2026-08-15** | Something happened',
    });
    expect(result.auto_timeline).toEqual({ created: 1 });
    expect(await getTimelineCount('notes/timeline1')).toBe(1);
  });

  test('TIMELINE-2: idempotency — re-writing the identical body twice does not duplicate the entry', async () => {
    await engine.setConfig('remote_auto_timeline', 'true');
    const ctx = makeCtx({ remote: true });
    const content = '---\ntype: note\ntitle: Idempotent\n---\n\n**2026-08-16** | Repeated event';
    await putPageOp.handler(ctx, { slug: 'notes/timeline2', content });
    await putPageOp.handler(ctx, { slug: 'notes/timeline2', content });
    expect(await getTimelineCount('notes/timeline2')).toBe(1);
  });

  test('a body with no structured date line creates zero timeline entries', async () => {
    await engine.setConfig('remote_auto_timeline', 'true');
    const ctx = makeCtx({ remote: true });
    const result: any = await putPageOp.handler(ctx, {
      slug: 'notes/timeline-none',
      content: '---\ntype: note\ntitle: No Dates\n---\n\njust prose, no date lines',
    });
    expect(result.auto_timeline).toEqual({ created: 0 });
  });
});

// ── ERROR: partial-failure consistency ────────────────────────────────────
describe('ERROR: config-read failure degrades gracefully', () => {
  test('a throwing ctx.engine.getConfig does not crash put_page; the write still succeeds and auto_links becomes {error}', async () => {
    // Scoped to the auto-links feature's OWN config read (`remote_auto_link`)
    // — a blanket getConfig throw would also break write-through's unrelated
    // `sync.repo_path`/`sync.write_through` reads, which upstream's #3935
    // fail-loud-on-write-through-failure change (reconciled in Phase 3B-30)
    // now correctly treats as fatal to the whole call, not just to auto_links.
    const throwingEngine = new Proxy(engine, {
      get(target, prop, receiver) {
        if (prop === 'getConfig') {
          return async (key: string) => {
            if (key === 'remote_auto_link' || key === 'remote_auto_timeline') {
              throw new Error('config read failed (simulated)');
            }
            return (target as BrainEngine).getConfig(key);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as unknown as BrainEngine;
    const ctx = makeCtx({ remote: true, engine: throwingEngine });
    const result: any = await putPageOp.handler(ctx, {
      slug: 'notes/error-config-read',
      content: '---\ntype: note\ntitle: Error Path\n---\n\nbody',
    });
    expect(result.auto_links).toMatchObject({ error: expect.any(String) });
    // The page write itself must have succeeded despite the auto-link error.
    const written = await engine.getPage('notes/error-config-read', {});
    expect(written).not.toBeNull();
  });
});

// ── trustedWorkspace unaffected ────────────────────────────────────────────
describe('regression: trustedWorkspace (subagent) path unaffected by remote_auto_* flags', () => {
  test('viaSubagent + allowedSlugPrefixes still gets full LOCAL-style auto_link even with remote_auto_link/timeline both true', async () => {
    await engine.setConfig('remote_auto_link', 'true');
    await engine.setConfig('remote_auto_timeline', 'true');
    await engine.setConfig('auto_link', 'true');
    await seedPage('people/trusted-target', 'person', 'Target');
    const ctx = makeCtx({
      remote: true,
      viaSubagent: true,
      allowedSlugPrefixes: ['wiki/agents/7/*'],
      subagentId: 7,
    });
    await putPageOp.handler(ctx, {
      slug: 'wiki/agents/7/trusted-note',
      content: '---\ntype: note\ntitle: Trusted\n---\n\nsee people/trusted-target',
    });
    const rows = (await getLinkRows()).filter(r => r.from_slug === 'wiki/agents/7/trusted-note');
    // Local-style write: tagged 'markdown', NOT 'remote-auto'.
    expect(rows.some(r => r.to_slug === 'people/trusted-target' && r.link_source === 'markdown')).toBe(true);
  });
});

// ── isRemoteAutoLinkEnabled / isRemoteAutoTimelineEnabled — unit tests ────
describe('isRemoteAutoLinkEnabled / isRemoteAutoTimelineEnabled (link-extraction.ts)', () => {
  function makeFakeEngine(configMap: Map<string, string | null>): BrainEngine {
    return { getConfig: async (key: string) => configMap.get(key) ?? null } as unknown as BrainEngine;
  }

  test('null config, no env -> false (default OFF, opt-in feature)', async () => {
    expect(await isRemoteAutoLinkEnabled(makeFakeEngine(new Map()))).toBe(false);
    expect(await isRemoteAutoTimelineEnabled(makeFakeEngine(new Map()))).toBe(false);
  });

  test("config 'true' -> true", async () => {
    expect(await isRemoteAutoLinkEnabled(makeFakeEngine(new Map([['remote_auto_link', 'true']])))).toBe(true);
  });

  test('garbage config -> false (fail-safe default OFF)', async () => {
    expect(await isRemoteAutoLinkEnabled(makeFakeEngine(new Map([['remote_auto_link', 'banana']])))).toBe(false);
  });

  test('env override wins over config', async () => {
    process.env.GBRAIN_REMOTE_AUTO_LINK = '1';
    try {
      expect(await isRemoteAutoLinkEnabled(makeFakeEngine(new Map([['remote_auto_link', 'false']])))).toBe(true);
    } finally {
      delete process.env.GBRAIN_REMOTE_AUTO_LINK;
    }
  });
});

// ── DB parity (static — no live Postgres in this environment) ────────────
describe('DB parity: pglite-engine.ts and postgres-engine.ts stay in lockstep', () => {
  test("both engines' getBacklinkCounts exclude link_source='remote-auto' with the identical NULL-safe clause", () => {
    const pglite = readFileSync(join(import.meta.dir, '..', 'src', 'core', 'pglite-engine.ts'), 'utf-8');
    const postgres = readFileSync(join(import.meta.dir, '..', 'src', 'core', 'postgres-engine.ts'), 'utf-8');
    const clause = "l.link_source IS DISTINCT FROM 'remote-auto'";
    expect(pglite).toContain(clause);
    expect(postgres).toContain(clause);
  });
});
