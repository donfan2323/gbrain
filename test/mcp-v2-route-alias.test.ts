/**
 * /mcp-v2 route alias — static structural checks (dashboard-h0cfe, ported
 * from historical commit a77fe765 onto the current upstream serve-http.ts).
 *
 * These verify EQUIVALENCE BY CONSTRUCTION rather than by making live HTTP
 * requests: `/mcp` and `/mcp-v2` must be registered as multiple paths on the
 * SAME `app.use`/`app.get`/`app.post` call (Express's own array-of-paths
 * form), sharing one handler function reference — not two independently
 * maintained route definitions that could drift apart. Full request/response
 * behavior (auth, JSON-RPC dispatch) is covered by the existing
 * DATABASE_URL-gated E2E suite (test/e2e/serve-http-oauth.test.ts) — this
 * repo's convention for exercising a live server — which this environment
 * has no Postgres instance to run. These static checks are therefore the
 * available signal for this specific change's correctness: they don't need
 * a running server, so they run in the fast parallel loop, and they fail
 * loudly if a future edit ever splits /mcp and /mcp-v2 into separate
 * handlers (the exact drift this design decision exists to prevent).
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SOURCE = readFileSync(
  join(import.meta.dir, '..', 'src', 'commands', 'serve-http.ts'),
  'utf-8',
);

describe('/mcp-v2 route alias — registered alongside /mcp, not duplicated', () => {
  test('CORS: /mcp and /mcp-v2 share one app.use(cors(...)) call', () => {
    expect(SOURCE).toMatch(/app\.use\(\['\/mcp', '\/mcp-v2'\],\s*cors\(corsOAuthOptions\)\)/);
  });

  test('GET: /mcp and /mcp-v2 share one handler (the 405/SSE-not-supported response)', () => {
    const m = SOURCE.match(/app\.get\(\['\/mcp', '\/mcp-v2'\], \(_req: Request, res: Response\) => \{([\s\S]*?)\}\);/);
    expect(m).not.toBeNull();
    expect(m![1]).toContain('405');
    expect(m![1]).toContain("res.set('Allow', 'POST, DELETE')");
  });

  test('POST: /mcp and /mcp-v2 share one handler, including the SAME auth middleware call', () => {
    expect(SOURCE).toMatch(
      /app\.post\(\['\/mcp', '\/mcp-v2'\], requireBearerAuth\(\{ verifier: oauthProvider, resourceMetadataUrl \}\), async \(req: Request, res: Response\) => \{/,
    );
  });

  test('there is exactly one GET handler and one POST handler touching /mcp anywhere in the file (no second, drifted definition)', () => {
    const getMatches = SOURCE.match(/app\.get\(\[?'\/mcp/g) ?? [];
    const postMatches = SOURCE.match(/app\.post\(\[?'\/mcp/g) ?? [];
    expect(getMatches.length).toBe(1);
    expect(postMatches.length).toBe(1);
  });
});

describe('/.well-known/openid-configuration — OIDC discovery compat route', () => {
  test('registered as its own GET route, reusing createOAuthMetadata(authRouterOptions) — the same pure function the SDK uses internally for oauth-authorization-server', () => {
    expect(SOURCE).toMatch(
      /app\.get\('\/\.well-known\/openid-configuration', \(req, res\) => \{\s*res\.status\(200\)\.json\(createOAuthMetadata\(authRouterOptions\)\);/,
    );
  });

  test('createOAuthMetadata is imported from the SDK (not hand-rolled)', () => {
    expect(SOURCE).toMatch(
      /import \{ mcpAuthRouter, createOAuthMetadata \} from '@modelcontextprotocol\/sdk\/server\/auth\/router\.js';/,
    );
  });

  test('the client_credentials / auth-methods metadata patch covers BOTH discovery paths, so the two documents cannot silently diverge', () => {
    const m = SOURCE.match(
      /if \(\s*\(req\.path === '\/\.well-known\/oauth-authorization-server' \|\| req\.path === '\/\.well-known\/openid-configuration'\)\s*&& req\.method === 'GET'/,
    );
    expect(m).not.toBeNull();
  });

  test('registered BEFORE app.use(authRouter), so it is not shadowed by the SDK router', () => {
    const oidcIdx = SOURCE.indexOf("app.get('/.well-known/openid-configuration'");
    const authRouterIdx = SOURCE.indexOf('app.use(authRouter);');
    expect(oidcIdx).toBeGreaterThan(-1);
    expect(authRouterIdx).toBeGreaterThan(-1);
    expect(oidcIdx).toBeLessThan(authRouterIdx);
  });
});

describe('excluded from this port: temporary diagnostic instrumentation', () => {
  test('ingress-diagnostic.ts / oauth-diagnostic.ts are not reintroduced', () => {
    // Scoped to actual import/require syntax, not any textual mention of
    // the name — src/commands/serve-http.ts's own AUTHZ-INV-013 comment
    // (Phase 3B-4) names "oauth-diagnostic.ts" in prose specifically to
    // document that it does NOT exist in this architecture ("the historical
    // stopgap, oauth-diagnostic.ts, does not exist here"); a bare substring
    // match trips on that documentary sentence itself, not on a real import.
    const importPattern = /(?:from\s+['"][^'"]*|require\(\s*['"][^'"]*)(ingress-diagnostic|oauth-diagnostic)/;
    expect(SOURCE).not.toMatch(importPattern);
  });
});
