import http from 'node:http';
import { createHash } from 'node:crypto';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../src/design-systems/approved-font-hashes.js', () => ({
  isApprovedDesignSystemFontHash: (sha256: string) => sha256 === createHash('sha256').update('font-bytes').digest('hex'),
}));
import { registerDesignSystemRoutes } from '../../src/routes/design-systems.js';

let server: http.Server | null = null;

afterEach(async () => {
  if (!server) return;
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = null;
});

function listen(app: express.Express): Promise<string> {
  return new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const address = server?.address() as { port: number };
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function registerRoutes(app: express.Express, staticHtml: string | null, contentType = 'text/html; charset=utf-8', assetPath = 'system/kit.html', licensedFont: boolean | 'stale' = false) {
  registerDesignSystemRoutes(app, {
    db: {} as never,
    paths: {
      CRAFT_DIR: '',
      USER_DESIGN_SYSTEMS_DIR: '',
    } as never,
    projectFiles: {} as never,
    projectStore: {} as never,
    verifyWorkspaceRequestAuthority: async () => {
      throw new Error('unbound fixture must not verify Workspace authority');
    },
    workspaceResources: {
      getWorkspaceResource: () => undefined,
      getWorkspaceResourceByResourceId: () => undefined,
    },
    designSystems: {
      buildUserDesignSystemArchive: async () => null,
      canMutateUserDesignSystem: async () => true,
      createUserDesignSystem: async () => ({}) as never,
      deleteUserDesignSystem: async () => false,
      ensureUserDesignSystemWorkspaceProject: async () => null,
      listAllDesignSystems: async () => [{ id: 'bento', source: 'built-in' }] as never,
      listUserDesignSystemFiles: async () => null,
      listUserDesignSystemRevisions: async () => null,
      prepareDesignTokenContractRebuild: async () => ({ decision: { available: false } }) as never,
      readAvailableDesignSystem: async (id: string) => (id === 'bento' ? '# Bento' : null),
      readAvailableDesignSystemPackageInfo: async () => null,
      readAvailableDesignSystemStaticFile: async (_id: string, filePath: string) => {
        if (licensedFont && filePath === 'fonts/package-fonts.json') return {
          bytes: Buffer.from(JSON.stringify({ fonts: [{ file: assetPath, license: 'OFL-1.1', sha256: createHash('sha256').update(licensedFont === 'stale' ? 'old-font' : staticHtml!).digest('hex') }] })),
          contentType: 'application/json', updatedAt: 'Tue, 30 Jun 2026 00:00:00 GMT',
        };
        return staticHtml && filePath === assetPath
          ? {
              bytes: Buffer.from(staticHtml, 'utf8'),
              contentType,
              updatedAt: 'Tue, 30 Jun 2026 00:00:00 GMT',
            }
          : null;
      },
      readDesignSystemWorkspaceTextFile: async () => null,
      readUserDesignSystemFile: async () => null,
      renderDesignSystemPreview: () => '<!doctype html><title>preview</title>',
      renderDesignSystemShowcase: (id: string, body: string) =>
        `<!doctype html><title>${id} synthetic</title><main>${body}</main>`,
      syncUserDesignSystemAssetsFromWorkspace: async () => ({ ok: false, reason: 'not-found' }),
      unshareTeamDesignSystemIfShared: async () => false,
      updateUserDesignSystem: async () => null,
      updateUserDesignSystemRevisionStatus: async () => null,
    },
    generationJobs: {
      get: () => null,
      rebuildTokenContract: () => ({}) as never,
      revise: () => ({}) as never,
      start: () => ({}) as never,
    },
  });
}

describe('design-system showcase route', () => {
  it('serves packaged kit HTML and rewrites relative package assets', async () => {
    const app = express();
    registerRoutes(
      app,
      [
        '<!doctype html>',
        '<link rel="stylesheet" href="../tokens.css">',
        '<img src="./assets/logo.svg">',
        '<style>@font-face{src:url("../fonts/display.woff2?v=1")}</style>',
      ].join(''),
    );
    const baseUrl = await listen(app);

    const res = await fetch(`${baseUrl}/api/design-systems/bento/showcase`);
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain('/api/design-systems/bento/static?path=tokens.css');
    expect(html).toContain('/api/design-systems/bento/static?path=system%2Fassets%2Flogo.svg');
    expect(html).toContain('/api/design-systems/bento/static?path=fonts%2Fdisplay.woff2&v=1');
    expect(html).not.toContain('bento synthetic');
  });

  it('keeps the generated showcase fallback when no packaged kit exists', async () => {
    const app = express();
    registerRoutes(app, null);
    const baseUrl = await listen(app);

    const res = await fetch(`${baseUrl}/api/design-systems/bento/showcase`);
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain('bento synthetic');
  });
});


describe('portable design-system static assets', () => {
  it('rewrites CSS imports without changing attribute selectors', async () => {
    const app = express();
    registerRoutes(app, '@import "./other.css";[href="page.html"]{background:url("../assets/image.png")}', 'text/css; charset=utf-8', 'fonts/fonts.css');
    const baseUrl = await listen(app);
    const css = await (await fetch(`${baseUrl}/api/design-systems/bento/static?path=fonts%2Ffonts.css`)).text();
    expect(css).toContain('@import "/api/design-systems/bento/static?path=fonts%2Fother.css"');
    expect(css).toContain('[href="page.html"]');
    expect(css).toContain('path=assets%2Fimage.png');
  });
  it('allows opaque-origin fonts after authorization and supports private ETag revalidation', async () => {
    const app = express();
    registerRoutes(app, 'font-bytes', 'font/woff2', 'fonts/inter/Inter.woff2', true);
    const baseUrl = await listen(app);
    const url = `${baseUrl}/api/design-systems/bento/static?path=fonts%2Finter%2FInter.woff2`;
    const response = await fetch(url, { headers: { Origin: 'null' } });
    expect(response.headers.get('access-control-allow-origin')).toBe('null');
    expect(response.headers.get('cache-control')).toBe('private, no-cache');
    expect(await response.text()).toBe('font-bytes');
    // Node fetch adds Cache-Control:no-cache to a conditional request. Use a
    // normal HTTP revalidation request, as a browser font cache does.
    const cachedStatus = await new Promise<number | undefined>((resolve, reject) => {
      http.get(url, { headers: { Origin: 'null', 'If-None-Match': response.headers.get('etag')! } }, (cached) => {
        cached.resume();
        cached.on('end', () => resolve(cached.statusCode));
      }).on('error', reject);
    });
    expect(cachedStatus).toBe(304);
  });
  it.each([false, 'stale', true] as const)('denies opaque-origin uploads with missing, stale or forged licensed provenance (%s)', async (provenance) => {
    const app = express();
    registerRoutes(app, 'private-upload', 'font/woff2', 'fonts/private.woff2', provenance);
    const baseUrl = await listen(app);
    const url = `${baseUrl}/api/design-systems/bento/static?path=fonts%2Fprivate.woff2`;
    const opaque = await fetch(url, { headers: { Origin: 'null' } });
    expect(opaque.status).toBe(403);
    expect(opaque.headers.get('access-control-allow-origin')).toBeNull();
    const local = await fetch(url);
    expect(local.status).toBe(200);
    expect(local.headers.get('vary')).toContain('Origin');
  });
  it.each([false, 'stale'] as const)('requires matching package provenance even for approved font bytes (%s)', async (provenance) => {
    const app = express();
    registerRoutes(app, 'font-bytes', 'font/woff2', 'fonts/inter/Inter.woff2', provenance);
    const baseUrl = await listen(app);
    const res = await fetch(`${baseUrl}/api/design-systems/bento/static?path=fonts%2Finter%2FInter.woff2`, { headers: { Origin: 'null' } });
    expect(res.status).toBe(403);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
  it('never adds font CORS headers to a design-system document', async () => {
    const app = express();
    registerRoutes(app, '<h1>Private guide</h1>');
    const baseUrl = await listen(app);
    const res = await fetch(`${baseUrl}/api/design-systems/bento/static?path=system%2Fkit.html`, { headers: { Origin: 'null' } });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
  it('rewrites local CSS font dependencies and carries navigation Workspace scope', async () => {
    const app = express();
    registerRoutes(app, '@font-face{font-family:"Inter";src:url("inter/Inter.woff2")}', 'text/css; charset=utf-8', 'fonts/fonts.css');
    const baseUrl = await listen(app);
    const res = await fetch(`${baseUrl}/api/design-systems/bento/static?path=fonts%2Ffonts.css&workspaceId=team&workspaceMemberId=member`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('/api/design-systems/bento/static?path=fonts%2Finter%2FInter.woff2&workspaceId=team&workspaceMemberId=member');
  });
  it('rewrites stylesheet references inside a statically served package kit', async () => {
    const app = express();
    registerRoutes(app, '<link rel="stylesheet" href="../fonts/fonts.css">');
    const baseUrl = await listen(app);
    const res = await fetch(`${baseUrl}/api/design-systems/bento/static?path=system%2Fkit.html`);
    expect(await res.text()).toContain('/api/design-systems/bento/static?path=fonts%2Ffonts.css');
  });
});
