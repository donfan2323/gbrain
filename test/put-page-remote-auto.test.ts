/**
 * RED (test-writer, mode: red) — remote-caller opt-in auto-link/auto-timeline.
 *
 * put_page's auto-link/auto-timeline post-hook is currently fully disabled
 * for any remote/MCP caller (operations.ts ~968: `ctx.remote !== false &&
 * !trustedWorkspace` -> `{skipped: 'remote'}`). This file pins the contract
 * for a new opt-in, feature-flagged, NARROWER path that lets remote callers
 * get a safer auto-link/auto-timeline:
 *
 *   - `isRemoteAutoLinkEnabled` / `isRemoteAutoTimelineEnabled` (new,
 *     link-extraction.ts) — mirror `isGlobalBasenameEnabled`'s exact pattern
 *     (env var first, then engine.getConfig, both default false).
 *   - `getBacklinkCounts()` (both engines) additionally excludes
 *     `link_source = 'remote-auto'` from the ranking-boost count (same
 *     `IS DISTINCT FROM` NULL-safe pattern as the existing 'mentions'
 *     exclusion — see test/backlink-count-mention-filter.test.ts).
 *   - put_page, when the remote caller opts in, creates ONLY bare-slug
 *     mentions of EXISTING pages as `link_source='remote-auto'` edges (no
 *     self-links, no phantom-target links, no frontmatter/incoming edges),
 *     and timeline entries only from the existing strict `TIMELINE_LINE_RE`
 *     syntax.
 *   - Local CLI callers (ctx.remote === false) are completely unaffected by
 *     the new flags, in both directions (on or off).
 *
 * None of this exists yet. Expect real failures — missing exports, or the
 * response/DB state still showing today's `{skipped: 'remote'}` / no-edges
 * behavior — not import/syntax errors from a mistyped path in THIS file.
 *
 * Hermetic via PGLite (no DATABASE_URL). Embed transport is stubbed exactly
 * like test/put-page-provenance.test.ts because put_page embeds content.
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import type { BrainEngine } from '../src/core/engine.ts';
// NOTE: these two functions do not exist yet. This import is expected to
// surface the missing-feature failure the moment the describe block below
// tries to call them (not at module-load time — see the `as any` access
// pattern used inside the tests).
import * as LinkExtraction from '../src/core/link-extraction.ts';

const putPageOp = operations.find((o) => o.name === 'put_page')!;

// GREEN (test-writer, mode: green) boundary/edge-case addendum: the cap test
// below needs the real value of `REMOTE_AUTO_LINK_MAX_CANDIDATES` (defined in
// operations.ts, not exported). Read it straight from the source file rather
// than hardcoding a duplicate literal here, so this test can't silently drift
// from the implementation if the constant is retuned.
const OPERATIONS_SRC = readFileSync(join(import.meta.dir, '..', 'src', 'core', 'operations.ts'), 'utf8');
const REMOTE_AUTO_LINK_MAX_CANDIDATES = (() => {
  const m = OPERATIONS_SRC.match(/REMOTE_AUTO_LINK_MAX_CANDIDATES\s*=\s*(\d+)/);
  if (!m) {
    throw new Error(
      'Could not find `REMOTE_AUTO_LINK_MAX_CANDIDATES = <number>` in operations.ts — ' +
      'update this regex if the constant was renamed or reformatted.',
    );
  }
  return parseInt(m[1]!, 10);
})();

let engine: PGLiteEngine;

beforeAll(async () => {
  // Same hermeticity guard as put-page-provenance.test.ts: pin the gateway
  // to legacy OpenAI/1536 and stub the embed transport so put_page's embed
  // never touches the network.
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
  // Wipe links + pages + config so every test starts from a known state —
  // config must be wiped too since several tests flip remote_auto_link /
  // remote_auto_timeline and we don't want that to bleed into siblings.
  await engine.executeRaw('DELETE FROM links', []);
  await engine.executeRaw('DELETE FROM pages', []);
  await engine.executeRaw('DELETE FROM config', []);
});

function makeCtx(opts: Partial<OperationContext> = {}): OperationContext {
  return {
    engine,
    config: { engine: 'pglite' as const },
    logger: {
      info: () => { /* noop */ },
      warn: () => { /* noop */ },
      error: () => { /* noop */ },
    },
    dryRun: false,
    remote: false,
    sourceId: 'default',
    ...opts,
  };
}

async function seedPage(slug: string, type: string, title: string): Promise<void> {
  await engine.putPage(slug, {
    type, title, compiled_truth: 'seed body', timeline: '', frontmatter: {},
  });
}

/** All link rows, resolved to slugs, for direct DB assertions. */
async function getLinkRows(): Promise<Array<{ from_slug: string; to_slug: string; link_type: string; link_source: string | null }>> {
  return await engine.executeRaw(
    `SELECT f.slug AS from_slug, t.slug AS to_slug, l.link_type, l.link_source
     FROM links l
     JOIN pages f ON f.id = l.from_page_id
     JOIN pages t ON t.id = l.to_page_id`,
    [],
  );
}

/** Count of links whose from_page_id = to_page_id — must always be 0. */
async function selfLinkCount(): Promise<number> {
  const rows = await engine.executeRaw<{ cnt: number }>(
    `SELECT COUNT(*)::int AS cnt FROM links WHERE from_page_id = to_page_id`,
    [],
  );
  return rows[0]!.cnt;
}

/** Count of link rows whose to_page_id resolves to the given slug. */
async function linksInvolvingSlug(slug: string): Promise<number> {
  const rows = await engine.executeRaw<{ cnt: number }>(
    `SELECT COUNT(*)::int AS cnt FROM links l
     JOIN pages f ON f.id = l.from_page_id
     JOIN pages t ON t.id = l.to_page_id
     WHERE f.slug = $1 OR t.slug = $1`,
    [slug],
  );
  return rows[0]!.cnt;
}

// ─────────────────────────────────────────────────────────────────
// isRemoteAutoLinkEnabled / isRemoteAutoTimelineEnabled — unit tests
// against a fake engine, mirroring isAutoLinkEnabled's precedent in
// test/link-extraction.test.ts and isGlobalBasenameEnabled's env-first
// pattern in src/core/link-extraction.ts.
// ─────────────────────────────────────────────────────────────────

function makeFakeEngine(configMap: Map<string, string | null>): BrainEngine {
  return {
    getConfig: async (key: string) => configMap.get(key) ?? null,
  } as unknown as BrainEngine;
}

describe('isRemoteAutoLinkEnabled (new — link-extraction.ts)', () => {
  const ORIG = process.env.GBRAIN_REMOTE_AUTO_LINK;
  afterAll(() => {
    if (ORIG === undefined) delete process.env.GBRAIN_REMOTE_AUTO_LINK;
    else process.env.GBRAIN_REMOTE_AUTO_LINK = ORIG;
  });

  test('null config, no env -> false (default OFF, opt-in feature)', async () => {
    delete process.env.GBRAIN_REMOTE_AUTO_LINK;
    const fake = makeFakeEngine(new Map());
    expect(await (LinkExtraction as any).isRemoteAutoLinkEnabled(fake)).toBe(false);
  });

  test("config 'true' -> true", async () => {
    delete process.env.GBRAIN_REMOTE_AUTO_LINK;
    const fake = makeFakeEngine(new Map([['remote_auto_link', 'true']]));
    expect(await (LinkExtraction as any).isRemoteAutoLinkEnabled(fake)).toBe(true);
  });

  test("config '1' -> true", async () => {
    delete process.env.GBRAIN_REMOTE_AUTO_LINK;
    const fake = makeFakeEngine(new Map([['remote_auto_link', '1']]));
    expect(await (LinkExtraction as any).isRemoteAutoLinkEnabled(fake)).toBe(true);
  });

  test("config 'FALSE' (case-insensitive) -> false", async () => {
    delete process.env.GBRAIN_REMOTE_AUTO_LINK;
    const fake = makeFakeEngine(new Map([['remote_auto_link', 'FALSE']]));
    expect(await (LinkExtraction as any).isRemoteAutoLinkEnabled(fake)).toBe(false);
  });

  test('garbage config -> false (fail-safe default OFF, opposite of auto_link)', async () => {
    delete process.env.GBRAIN_REMOTE_AUTO_LINK;
    const fake = makeFakeEngine(new Map([['remote_auto_link', 'garbage']]));
    expect(await (LinkExtraction as any).isRemoteAutoLinkEnabled(fake)).toBe(false);
  });

  test('env GBRAIN_REMOTE_AUTO_LINK=1 overrides config=false -> true', async () => {
    process.env.GBRAIN_REMOTE_AUTO_LINK = '1';
    const fake = makeFakeEngine(new Map([['remote_auto_link', 'false']]));
    expect(await (LinkExtraction as any).isRemoteAutoLinkEnabled(fake)).toBe(true);
    delete process.env.GBRAIN_REMOTE_AUTO_LINK;
  });

  test('env GBRAIN_REMOTE_AUTO_LINK=0 overrides config=true -> false', async () => {
    process.env.GBRAIN_REMOTE_AUTO_LINK = '0';
    const fake = makeFakeEngine(new Map([['remote_auto_link', 'true']]));
    expect(await (LinkExtraction as any).isRemoteAutoLinkEnabled(fake)).toBe(false);
    delete process.env.GBRAIN_REMOTE_AUTO_LINK;
  });
});

describe('isRemoteAutoTimelineEnabled (new — link-extraction.ts)', () => {
  afterAll(() => {
    delete process.env.GBRAIN_REMOTE_AUTO_TIMELINE;
  });

  test('null config, no env -> false (default OFF)', async () => {
    delete process.env.GBRAIN_REMOTE_AUTO_TIMELINE;
    const fake = makeFakeEngine(new Map());
    expect(await (LinkExtraction as any).isRemoteAutoTimelineEnabled(fake)).toBe(false);
  });

  test("config 'yes' -> true", async () => {
    delete process.env.GBRAIN_REMOTE_AUTO_TIMELINE;
    const fake = makeFakeEngine(new Map([['remote_auto_timeline', 'yes']]));
    expect(await (LinkExtraction as any).isRemoteAutoTimelineEnabled(fake)).toBe(true);
  });

  test('env GBRAIN_REMOTE_AUTO_TIMELINE=on overrides config=false -> true', async () => {
    process.env.GBRAIN_REMOTE_AUTO_TIMELINE = 'on';
    const fake = makeFakeEngine(new Map([['remote_auto_timeline', 'false']]));
    expect(await (LinkExtraction as any).isRemoteAutoTimelineEnabled(fake)).toBe(true);
    delete process.env.GBRAIN_REMOTE_AUTO_TIMELINE;
  });
});

// ─────────────────────────────────────────────────────────────────
// getBacklinkCounts — remote-auto exclusion (PGLite-hermetic, mirrors
// test/backlink-count-mention-filter.test.ts's raw-SQL style exactly).
// ─────────────────────────────────────────────────────────────────

describe('getBacklinkCounts — remote-auto exclusion (new)', () => {
  test('0 other + 10 remote-auto-source links -> backlink count = 0', async () => {
    const target = 'people/ra-target-1';
    await seedPage(target, 'person', 'Target');
    const links = [];
    for (let i = 0; i < 10; i++) {
      const src = `writing/ra-post-${i}`;
      await seedPage(src, 'note', `Source ${i}`);
      links.push({
        from_slug: src, to_slug: target, link_type: 'mentions', link_source: 'remote-auto', context: '',
      });
    }
    await engine.addLinksBatch(links);
    const counts = await engine.getBacklinkCounts([target]);
    expect(counts.get(target)).toBe(0);
  });

  test('mixed link_source (markdown, frontmatter, manual, NULL, remote-auto) — only remote-auto (and mentions) filtered', async () => {
    const target = 'companies/ra-acme';
    await seedPage(target, 'company', 'Acme');
    await seedPage('w/ra-md', 'note', 'md');
    await seedPage('w/ra-fm', 'note', 'fm');
    await seedPage('w/ra-manual', 'note', 'manual');
    await seedPage('w/ra-auto', 'note', 'auto'); // link_source='remote-auto'
    const ids = await engine.executeRaw<{ slug: string; id: number }>(
      `SELECT slug, id FROM pages WHERE slug IN ($1, $2, $3, $4, $5)`,
      ['w/ra-md', 'w/ra-fm', 'w/ra-manual', 'w/ra-auto', target],
    );
    const m = new Map(ids.map(r => [r.slug, r.id]));
    await engine.executeRaw(
      `INSERT INTO links (from_page_id, to_page_id, link_type, link_source)
       VALUES ($1, $5, 'mentions', 'markdown'),
              ($2, $5, 'mentions', 'frontmatter'),
              ($3, $5, 'mentions', 'manual'),
              ($4, $5, 'mentions', 'remote-auto')`,
      [m.get('w/ra-md'), m.get('w/ra-fm'), m.get('w/ra-manual'), m.get('w/ra-auto'), m.get(target)],
    );
    const counts = await engine.getBacklinkCounts([target]);
    // markdown + frontmatter + manual = 3; remote-auto filtered out.
    expect(counts.get(target)).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────
// put_page — remote/MCP caller (ctx.remote !== false)
// ─────────────────────────────────────────────────────────────────

describe('put_page — remote caller, flags OFF (baseline pin — should already pass)', () => {
  test('default (no config set): auto_links/auto_timeline both {skipped: "remote"}, no edges created', async () => {
    await seedPage('people/baseline-target', 'person', 'Target');
    const ctx = makeCtx({ remote: true });
    const result: any = await putPageOp.handler(ctx, {
      slug: 'notes/baseline-source',
      content: '---\ntype: note\ntitle: Baseline\n---\n\nsee people/baseline-target for context',
    });
    expect(result.auto_links).toEqual({ skipped: 'remote' });
    expect(result.auto_timeline).toEqual({ skipped: 'remote' });
    expect(await linksInvolvingSlug('people/baseline-target')).toBe(0);
  });
});

describe('put_page — remote caller, remote_auto_link enabled (new)', () => {
  test('bare mention of an EXISTING page slug creates a link_source="remote-auto" edge', async () => {
    await engine.setConfig('remote_auto_link', 'true');
    await seedPage('people/alice-chen', 'person', 'Alice Chen');
    const ctx = makeCtx({ remote: true });
    await putPageOp.handler(ctx, {
      slug: 'notes/ral-existing-mention',
      content: '---\ntype: note\ntitle: Existing Mention\n---\n\nsee people/alice-chen for context',
    });
    const rows = await getLinkRows();
    const created = rows.find(r =>
      r.from_slug === 'notes/ral-existing-mention' &&
      r.to_slug === 'people/alice-chen' &&
      r.link_source === 'remote-auto',
    );
    expect(created).toBeTruthy();
  });

  test('mention of a NON-EXISTENT slug creates no link row for that target (real mention still creates one)', async () => {
    await engine.setConfig('remote_auto_link', 'true');
    await seedPage('people/ral-real-target', 'person', 'Real Target');
    const ctx = makeCtx({ remote: true });
    await putPageOp.handler(ctx, {
      slug: 'notes/ral-phantom-mention',
      content:
        '---\ntype: note\ntitle: Phantom Mention\n---\n\n' +
        'see people/ral-real-target for context, and also people/ral-does-not-exist for more',
    });
    const rows = await getLinkRows();
    // Proof the feature actually ran: the real target got a remote-auto edge.
    expect(rows.some(r =>
      r.from_slug === 'notes/ral-phantom-mention' &&
      r.to_slug === 'people/ral-real-target' &&
      r.link_source === 'remote-auto',
    )).toBe(true);
    // The phantom target must never appear as a link endpoint (page doesn't exist).
    expect(rows.some(r => r.to_slug === 'people/ral-does-not-exist' || r.from_slug === 'people/ral-does-not-exist')).toBe(false);
  });

  test('a page mentioning its OWN slug creates no self-link (from_page_id = to_page_id never appears)', async () => {
    await engine.setConfig('remote_auto_link', 'true');
    await seedPage('people/ral-other-target', 'person', 'Other Target');
    const ctx = makeCtx({ remote: true });
    await putPageOp.handler(ctx, {
      slug: 'notes/ral-self-ref',
      content:
        '---\ntype: note\ntitle: Self Ref\n---\n\n' +
        'this page is notes/ral-self-ref and it also references people/ral-other-target',
    });
    const rows = await getLinkRows();
    // Proof the feature actually ran: the other (non-self) mention created an edge.
    expect(rows.some(r =>
      r.from_slug === 'notes/ral-self-ref' &&
      r.to_slug === 'people/ral-other-target' &&
      r.link_source === 'remote-auto',
    )).toBe(true);
    expect(await selfLinkCount()).toBe(0);
  });

  test('remote-auto link is excluded from getBacklinkCounts but IS returned by getBacklinks', async () => {
    await engine.setConfig('remote_auto_link', 'true');
    await seedPage('people/ral-count-target', 'person', 'Count Target');
    const ctx = makeCtx({ remote: true });
    await putPageOp.handler(ctx, {
      slug: 'notes/ral-count-source',
      content: '---\ntype: note\ntitle: Count Source\n---\n\nsee people/ral-count-target for details',
    });
    const counts = await engine.getBacklinkCounts(['people/ral-count-target']);
    expect(counts.get('people/ral-count-target')).toBe(0);
    const backlinks = await engine.getBacklinks('people/ral-count-target');
    expect(backlinks.some(l => l.from_slug === 'notes/ral-count-source' && l.link_source === 'remote-auto')).toBe(true);
  });

  test('frontmatter incoming-direction fields (key_people) create ZERO edges via the remote path', async () => {
    await engine.setConfig('remote_auto_link', 'true');
    // key_people (FRONTMATTER_LINK_MAP, pageType='company', direction='incoming')
    // resolves the frontmatter value to an existing person page and would
    // normally emit person -> company works_at. That must NOT happen here.
    await seedPage('people/ral-carol', 'person', 'Carol');
    // Sibling bare-mention target proves the remote-auto path DID run.
    await seedPage('people/ral-bob', 'person', 'Bob');
    const ctx = makeCtx({ remote: true });
    await putPageOp.handler(ctx, {
      slug: 'companies/ral-newco',
      content:
        '---\ntype: company\ntitle: NewCo\nkey_people: ["Carol"]\n---\n\n' +
        'see people/ral-bob for background',
    });
    const rows = await getLinkRows();
    // Proof the remote-auto path ran at all (sibling bare mention created an edge).
    expect(rows.some(r =>
      r.from_slug === 'companies/ral-newco' &&
      r.to_slug === 'people/ral-bob' &&
      r.link_source === 'remote-auto',
    )).toBe(true);
    // Frontmatter incoming edge must be entirely absent — no link row
    // involves people/ral-carol at all.
    expect(await linksInvolvingSlug('people/ral-carol')).toBe(0);
  });
});

describe('put_page — remote caller, remote_auto_timeline enabled (new)', () => {
  test('a strict TIMELINE_LINE_RE date line creates a timeline entry', async () => {
    await engine.setConfig('remote_auto_timeline', 'true');
    const ctx = makeCtx({ remote: true });
    await putPageOp.handler(ctx, {
      slug: 'notes/rat-dated',
      content:
        '---\ntype: note\ntitle: Dated\n---\n\n' +
        '**2026-01-15** - something happened',
    });
    const entries = await engine.getTimeline('notes/rat-dated');
    expect(entries.length).toBe(1);
    expect(entries[0]!.summary).toBe('something happened');
  });

  test('a body with NO structured date line creates zero timeline entries', async () => {
    await engine.setConfig('remote_auto_timeline', 'true');
    const ctx = makeCtx({ remote: true });
    await putPageOp.handler(ctx, {
      slug: 'notes/rat-undated',
      content:
        '---\ntype: note\ntitle: Undated\n---\n\n' +
        'just some prose with no date markers at all',
    });
    const entries = await engine.getTimeline('notes/rat-undated');
    expect(entries.length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────
// Local CLI caller (ctx.remote === false) — regression pin: completely
// unaffected by the new remote_auto_link / remote_auto_timeline flags,
// in either direction.
// ─────────────────────────────────────────────────────────────────

describe('put_page — local caller unaffected by new flags (regression pin — should already pass)', () => {
  test('local write still gets full auto_link (markdown + frontmatter incoming) + auto_timeline regardless of remote_auto_* config', async () => {
    // Flip BOTH new flags ON — local behavior must not change one bit.
    await engine.setConfig('remote_auto_link', 'true');
    await engine.setConfig('remote_auto_timeline', 'true');

    await seedPage('people/local-target', 'person', 'Local Target');
    await seedPage('people/carol-local', 'person', 'Carol Local');

    const ctx = makeCtx({ remote: false });
    await putPageOp.handler(ctx, {
      slug: 'companies/local-co',
      content:
        '---\ntype: company\ntitle: Local Co\nkey_people: ["Carol Local"]\n---\n\n' +
        'see people/local-target for context\n\n' +
        '## Timeline\n\n' +
        '**2026-01-20** - Something happened locally',
    });

    const rows = await getLinkRows();
    // Outgoing markdown edge (existing local default-on behavior).
    expect(rows.some(r =>
      r.from_slug === 'companies/local-co' &&
      r.to_slug === 'people/local-target' &&
      r.link_source === 'markdown',
    )).toBe(true);
    // Incoming frontmatter edge (existing local default-on behavior) — the
    // new remote-only exclusion must NOT apply to local callers.
    expect(rows.some(r =>
      r.from_slug === 'people/carol-local' &&
      r.to_slug === 'companies/local-co' &&
      r.link_type === 'works_at' &&
      r.link_source === 'frontmatter',
    )).toBe(true);
    // Timeline entry (existing local default-on behavior).
    const entries = await engine.getTimeline('companies/local-co');
    expect(entries.some(e => e.summary === 'Something happened locally')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────
// GREEN (test-writer, mode: green) — boundary-value / edge-case / cross-mode
// regression coverage added AFTER the RED file above went green against a
// completed implementation. Every case here was verified against the actual
// operations.ts source (~line 1181 runAutoLink, ~line 970 trustedWorkspace
// branch) before being written; none of it duplicates the RED cases above.
// ─────────────────────────────────────────────────────────────────

describe('put_page — remote caller, remote_auto_link candidate cap (new — boundary)', () => {
  test(`mentioning more than REMOTE_AUTO_LINK_MAX_CANDIDATES (${REMOTE_AUTO_LINK_MAX_CANDIDATES}) existing slugs caps edge creation and reports the exact drop count via 'truncated'`, async () => {
    await engine.setConfig('remote_auto_link', 'true');
    const overflow = 20;
    const total = REMOTE_AUTO_LINK_MAX_CANDIDATES + overflow;
    const slugs: string[] = [];
    for (let i = 0; i < total; i++) {
      const s = `people/cap-${String(i).padStart(4, '0')}`;
      slugs.push(s);
      await seedPage(s, 'person', `Cap Target ${i}`);
    }
    const body = slugs.map(s => `see ${s} for context.`).join(' ');
    const ctx = makeCtx({ remote: true });
    const result: any = await putPageOp.handler(ctx, {
      slug: 'notes/cap-source',
      content: `---\ntype: note\ntitle: Cap Source\n---\n\n${body}`,
    });

    expect(result.auto_links.truncated).toBe(overflow);
    expect(result.auto_links.created).toBe(REMOTE_AUTO_LINK_MAX_CANDIDATES);

    const rows = await getLinkRows();
    const created = rows.filter(r => r.from_slug === 'notes/cap-source' && r.link_source === 'remote-auto');
    expect(created.length).toBe(REMOTE_AUTO_LINK_MAX_CANDIDATES);
  });
});

describe('put_page — remote caller, duplicate mention idempotency (new — boundary)', () => {
  test('the SAME existing target slug mentioned twice in one body creates exactly ONE remote-auto link row', async () => {
    await engine.setConfig('remote_auto_link', 'true');
    await seedPage('people/dup-target', 'person', 'Dup Target');
    const ctx = makeCtx({ remote: true });
    const result: any = await putPageOp.handler(ctx, {
      slug: 'notes/dup-mention-source',
      content:
        '---\ntype: note\ntitle: Dup Mention Source\n---\n\n' +
        'First, see people/dup-target for an introduction. ' +
        'Later on, refer back to people/dup-target for more context.',
    });
    expect(result.auto_links.created).toBe(1);
    expect(result.auto_links.errors).toBe(0);

    const rows = await getLinkRows();
    const matching = rows.filter(r =>
      r.from_slug === 'notes/dup-mention-source' &&
      r.to_slug === 'people/dup-target' &&
      r.link_source === 'remote-auto',
    );
    expect(matching.length).toBe(1);
  });
});

describe('put_page — cross-mode reconciliation non-interference (new — regression)', () => {
  test('direction A: a pre-existing LOCAL markdown edge survives a later remote-auto edit to the same slug', async () => {
    await seedPage('people/xmode-target1', 'person', 'XMode Target 1');
    await seedPage('people/xmode-target2', 'person', 'XMode Target 2');

    // 1) Local write creates a 'markdown' outgoing edge to target1.
    const localCtx = makeCtx({ remote: false });
    await putPageOp.handler(localCtx, {
      slug: 'notes/xmode-a',
      content: '---\ntype: note\ntitle: XMode A\n---\n\nsee people/xmode-target1 for context',
    });
    let rows = await getLinkRows();
    expect(rows.some(r =>
      r.from_slug === 'notes/xmode-a' && r.to_slug === 'people/xmode-target1' && r.link_source === 'markdown',
    )).toBe(true);

    // 2) Remote-auto edit to the SAME slug; body no longer mentions target1
    // at all, only mentions target2.
    await engine.setConfig('remote_auto_link', 'true');
    const remoteCtx = makeCtx({ remote: true });
    await putPageOp.handler(remoteCtx, {
      slug: 'notes/xmode-a',
      content: '---\ntype: note\ntitle: XMode A\n---\n\nsee people/xmode-target2 for context',
    });

    rows = await getLinkRows();
    // The original local markdown edge must still exist — remote-auto's
    // reconciliation is scoped to link_source='remote-auto' only, so it must
    // never treat this pre-existing markdown edge as stale.
    expect(rows.some(r =>
      r.from_slug === 'notes/xmode-a' && r.to_slug === 'people/xmode-target1' && r.link_source === 'markdown',
    )).toBe(true);
    // A new remote-auto edge to target2 was created (proves the remote-auto
    // path actually ran on this call).
    expect(rows.some(r =>
      r.from_slug === 'notes/xmode-a' && r.to_slug === 'people/xmode-target2' && r.link_source === 'remote-auto',
    )).toBe(true);
  });

  test('direction B: a pre-existing remote-auto edge survives a later LOCAL edit to the same slug', async () => {
    await seedPage('people/xmodeb-target1', 'person', 'XModeB Target 1');
    await seedPage('people/xmodeb-target2', 'person', 'XModeB Target 2');

    // 1) Remote-auto write creates a 'remote-auto' outgoing edge to target1.
    await engine.setConfig('remote_auto_link', 'true');
    const remoteCtx = makeCtx({ remote: true });
    await putPageOp.handler(remoteCtx, {
      slug: 'notes/xmodeb-a',
      content: '---\ntype: note\ntitle: XModeB A\n---\n\nsee people/xmodeb-target1 for context',
    });
    let rows = await getLinkRows();
    expect(rows.some(r =>
      r.from_slug === 'notes/xmodeb-a' && r.to_slug === 'people/xmodeb-target1' && r.link_source === 'remote-auto',
    )).toBe(true);

    // 2) Local edit to the SAME slug; body no longer mentions target1 at
    // all, only mentions target2.
    const localCtx = makeCtx({ remote: false });
    await putPageOp.handler(localCtx, {
      slug: 'notes/xmodeb-a',
      content: '---\ntype: note\ntitle: XModeB A\n---\n\nsee people/xmodeb-target2 for context',
    });

    rows = await getLinkRows();
    // The pre-existing remote-auto edge must survive — local reconciliation's
    // reconcilableOut filter (markdown/null/wikilink-resolved/own-frontmatter)
    // never includes link_source='remote-auto'.
    expect(rows.some(r =>
      r.from_slug === 'notes/xmodeb-a' && r.to_slug === 'people/xmodeb-target1' && r.link_source === 'remote-auto',
    )).toBe(true);
    // A new local markdown edge to target2 was created (proves the local
    // call actually ran).
    expect(rows.some(r =>
      r.from_slug === 'notes/xmodeb-a' && r.to_slug === 'people/xmodeb-target2' && r.link_source === 'markdown',
    )).toBe(true);
  });
});

describe('put_page — repeated remote-auto edits reconcile against their OWN prior state (new — regression)', () => {
  test('a second remote-auto edit removes the stale target-A edge and adds a new target-B edge', async () => {
    await engine.setConfig('remote_auto_link', 'true');
    await seedPage('people/selfrecon-a', 'person', 'Self Recon A');
    await seedPage('people/selfrecon-b', 'person', 'Self Recon B');

    const ctx = makeCtx({ remote: true });
    const first: any = await putPageOp.handler(ctx, {
      slug: 'notes/selfrecon-source',
      content: '---\ntype: note\ntitle: Self Recon Source\n---\n\nsee people/selfrecon-a for context',
    });
    expect(first.auto_links.created).toBe(1);
    let rows = await getLinkRows();
    expect(rows.some(r =>
      r.from_slug === 'notes/selfrecon-source' && r.to_slug === 'people/selfrecon-a' && r.link_source === 'remote-auto',
    )).toBe(true);

    const second: any = await putPageOp.handler(ctx, {
      slug: 'notes/selfrecon-source',
      content: '---\ntype: note\ntitle: Self Recon Source\n---\n\nsee people/selfrecon-b for context',
    });

    rows = await getLinkRows();
    // Stale A edge removed — proves reconcilableOut scoped-to-own-tag
    // stale-removal actually fires, not just additive linking.
    expect(rows.some(r =>
      r.from_slug === 'notes/selfrecon-source' && r.to_slug === 'people/selfrecon-a',
    )).toBe(false);
    // New B edge created.
    expect(rows.some(r =>
      r.from_slug === 'notes/selfrecon-source' && r.to_slug === 'people/selfrecon-b' && r.link_source === 'remote-auto',
    )).toBe(true);
    expect(second.auto_links.created).toBe(1);
    expect(second.auto_links.removed).toBe(1);
  });
});

describe('put_page — remote caller, config-read error degrades gracefully (new — error path)', () => {
  test('ctx.engine.getConfig throwing does not crash put_page; the page write still succeeds and auto_links becomes {error}', async () => {
    // A Proxy over the REAL engine that forwards every call to it unchanged
    // EXCEPT getConfig, which throws. This exercises the actual
    // isRemoteAutoLinkEnabled/isRemoteAutoTimelineEnabled call sites inside
    // the real put_page handler (not a reimplementation of the try/catch),
    // while leaving the shared `engine` instance used by every other test
    // in this file completely untouched (the proxy is local to this test's
    // ctx only).
    const throwingConfigEngine: BrainEngine = new Proxy(engine, {
      get(target: any, prop: string | symbol, receiver: unknown) {
        if (prop === 'getConfig') {
          return async () => { throw new Error('config store unavailable (test-injected)'); };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as unknown as BrainEngine;

    const ctx = makeCtx({ remote: true, engine: throwingConfigEngine });
    const result: any = await putPageOp.handler(ctx, {
      slug: 'notes/cfgerr-source',
      content: '---\ntype: note\ntitle: Config Error Source\n---\n\nsome ordinary body text, no entity refs',
    });

    expect(result.slug).toBe('notes/cfgerr-source');
    expect(result.status).toBe('created_or_updated');
    expect(typeof result.auto_links.error).toBe('string');
    expect(typeof result.auto_timeline.error).toBe('string');

    // The page write itself (against the REAL engine) must have succeeded
    // despite the config-read failure — verified via the real engine, not
    // the throwing proxy.
    const page = await engine.getPage('notes/cfgerr-source');
    expect(page).toBeTruthy();
  });
});

describe('put_page — trustedWorkspace (subagent) path unaffected by remote_auto_* flags (new — regression)', () => {
  test('viaSubagent + allowedSlugPrefixes still gets full LOCAL-style auto_link (including frontmatter incoming edges) even with remote_auto_link/remote_auto_timeline both true', async () => {
    // Flip BOTH new flags ON — the trustedWorkspace branch must be
    // completely unaffected, exactly like the local-caller regression pin
    // above, because `if (ctx.remote !== false && !trustedWorkspace)` must
    // evaluate to false here (ctx.remote IS true, so only `!trustedWorkspace`
    // being false can route us to the else-branch — this is the real
    // discriminator this test pins, unlike the local-caller pin which takes
    // the else-branch via ctx.remote===false alone).
    await engine.setConfig('remote_auto_link', 'true');
    await engine.setConfig('remote_auto_timeline', 'true');

    await seedPage('people/tw-target', 'person', 'TW Target');
    await seedPage('people/tw-carol', 'person', 'TW Carol');

    const ctx = makeCtx({
      remote: true,
      viaSubagent: true,
      subagentId: 1,
      allowedSlugPrefixes: ['companies/*'],
    });
    await putPageOp.handler(ctx, {
      slug: 'companies/tw-newco',
      content:
        '---\ntype: company\ntitle: TW NewCo\nkey_people: ["TW Carol"]\n---\n\n' +
        'see people/tw-target for context\n\n' +
        '## Timeline\n\n' +
        '**2026-01-25** - Something happened via subagent',
    });

    const rows = await getLinkRows();
    // Outgoing markdown edge — local-style tagging (link_source='markdown',
    // NOT 'remote-auto').
    expect(rows.some(r =>
      r.from_slug === 'companies/tw-newco' &&
      r.to_slug === 'people/tw-target' &&
      r.link_source === 'markdown',
    )).toBe(true);
    // Incoming frontmatter edge — the remote-auto path drops ALL incoming
    // candidates unconditionally, so this edge existing at all proves
    // trustedWorkspace truly took the else-branch.
    expect(rows.some(r =>
      r.from_slug === 'people/tw-carol' &&
      r.to_slug === 'companies/tw-newco' &&
      r.link_type === 'works_at' &&
      r.link_source === 'frontmatter',
    )).toBe(true);
    // No remote-auto-tagged edges exist anywhere on this slug.
    expect(rows.some(r =>
      r.link_source === 'remote-auto' &&
      (r.from_slug === 'companies/tw-newco' || r.to_slug === 'companies/tw-newco'),
    )).toBe(false);
    // Timeline entry created too (local-style default-on behavior).
    const entries = await engine.getTimeline('companies/tw-newco');
    expect(entries.some(e => e.summary === 'Something happened via subagent')).toBe(true);
  });
});
