// Atlas request 002: an installed user design-system package must open in the
// native viewer with every kit-relative reference loading. The fixture is a
// real package on disk read through the real static-file reader; the test
// plays the browser, resolving each reference against the document's base URL
// exactly as a browser would, including URLs a kit script builds at runtime.
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readDesignSystemStaticFile } from '../../src/design-systems/index.js';
import { registerDesignSystemRoutes } from '../../src/routes/design-systems.js';
import { withPreviewStorage } from '../../src/plugins/preview-storage.js';

const ID = 'user:kit-fixture';
const ENCODED_ID = encodeURIComponent(ID);
// A second package bound to a Workspace: the path form must not serve it.
const TEAM_ID = 'user:team-kit';
const ENCODED_TEAM_ID = encodeURIComponent(TEAM_ID);

let tmp = '';
let root = '';
let kitDir = '';
let server: http.Server | null = null;
let baseUrl = '';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 4, 5, 6]);
const WOFF2 = Buffer.from('wOF2-fixture-bytes');

// Pages that mention `<base` anywhere. Authored bases are not supported: these
// are served the way main serves them — inline, href/src rewritten against the
// file's own directory, no injected base.
const BASE_PAGES: Record<string, string> = {
  'base-dotdot.html': '<!doctype html><html><head><base href=".."></head><body><img src="x.png"></body></html>',
  'preview/based.html': '<!doctype html><html><head><base href="../assets/"></head><body><img src="x.png"></body></html>',
  'preview/based-upper.html': '<!doctype html><html><head><BASE HREF="../assets/" /></head><body><img src="x.png"></body></html>',
  'preview/base-entity-host.html': '<!doctype html><html><head><base href="&#x68;ttps://example.test/"></head><body><img src="x.png"></body></html>',
  'preview/base-entity-slash.html': '<!doctype html><html><head><base href="&#47;other/"></head><body><img src="x.png"></body></html>',
  'preview/base-protocol-relative.html': '<!doctype html><html><head><base href="//example.test/x/"></head><body><img src="x.png"></body></html>',
  'preview/base-backslash.html': '<!doctype html><html><head><base href="..\\assets\\"></head><body><img src="x.png"></body></html>',
  // A fake href inside another attribute must not be mistaken for the real one.
  'preview/base-data-note.html': `<!doctype html><html><head><base data-note=" href='../assets/'" href="&#x68;ttps://example.test/"></head><body><img src="x.png"></body></html>`,
  'preview/base-two-tags.html': '<!doctype html><html><head><base href="../assets/"><base href="https://example.test/"></head><body><img src="x.png"></body></html>',
  'preview/base-extra-attribute.html': '<!doctype html><html><head><base href="../assets/" target="_blank"></head><body><img src="x.png"></body></html>',
  'preview/base-unquoted.html': '<!doctype html><html><head><base href=../assets/></head><body><img src="x.png"></body></html>',
  'preview/base64-in-script.html': '<!doctype html><html><head><script>var t = "<base64>";</script></head><body><img src="x.png"></body></html>',
  'preview/base-dash-in-text.html': '<!doctype html><html><head></head><body><p>&lt;b</p><!-- <BASE-foo> --><img src="x.png"></body></html>',
  'preview/base-in-script.html': '<!doctype html><html><head><script>var t = "<base href=x>";</script></head><body><img src="x.png"></body></html>',
};

function manifest(id: string): string {
  return JSON.stringify({
    schemaVersion: 'od-design-system-project/v1',
    id,
    name: 'Kit fixture',
    category: 'Atlas reference',
    files: { design: 'DESIGN.md', tokens: 'tokens.css', components: 'components.html' },
    assetsDir: 'assets',
    preview: {
      dir: 'preview',
      pages: [
        { path: 'system/kit.html', role: 'native-kit', title: 'Kit' },
        { path: 'preview/index.html', role: 'source-evidence', title: 'Evidence' },
        ...Object.keys(BASE_PAGES).map((page) => ({ path: page, role: 'source-evidence', title: page })),
      ],
    },
    fonts: [{ family: 'Display', file: 'fonts/display/Display.woff2' }],
  });
}

const FILES: Record<string, string | Buffer> = {
  'manifest.json': manifest('kit-fixture'),
  'metadata.json': '{"title":"bookkeeping-secret"}',
  'revisions/r1.json': '{"bookkeeping":"revision-secret"}',
  'DESIGN.md': '# Kit fixture\n',
  'MOTION.json': '{"motion":"none"}',
  'tokens.css': ':root{--bg:#fff}body{background:url("assets/texture.svg")}',
  'components.html': [
    '<!doctype html><html><head>',
    '<link rel="stylesheet" href="tokens.css">',
    '<link rel="stylesheet" href="fonts/fonts.css">',
    '</head><body><a href="system/kit.html">kit</a><a href="#cp-pill">pill</a>',
    '<img src="assets/shots/wide.jpg"></body></html>',
  ].join(''),
  'system/kit.html': [
    '<!doctype html><html><head>',
    '<link rel="stylesheet" href="../tokens.css">',
    '<link rel="stylesheet" href="../fonts/fonts.css">',
    '<style>.hero{background-image:url(../assets/x.png)}</style>',
    '</head><body>',
    '<a href="#fx-intro">intro</a>',
    '<a href="../components.html">components</a>',
    '<img src="../assets/x.png" alt="">',
    '<iframe src="../preview/index.html"></iframe>',
    '<script src="../assets/kit.js"></script>',
    // The workbench builds frame URLs at runtime; a string rewriter never sees them.
    '<script>var page = "../components.html"; frame.src = page + "?only=pill";</script>',
    // Script and inline-SVG text that only looks like CSS url() references.
    '<script>img.src = URL.createObjectURL(f);</script>',
    `<div style="-webkit-mask-image:url('data:image/svg+xml,%3Cmask id=%22h%22/%3E%3Crect mask=%22url(%23h)%22/%3E')"></div>`,
    '</body></html>',
  ].join(''),
  'preview/index.html': [
    '<!doctype html><html><head><link rel="stylesheet" href="../tokens.css"></head><body>',
    '<img src="../assets/x.png"><a href="../system/kit.html">kit</a>',
    '<a href="../MOTION.json">motion</a><a href="../DESIGN.md">design</a>',
    '</body></html>',
  ].join(''),
  ...BASE_PAGES,
  'fonts/fonts.css': '@font-face{font-family:"Display";src:url("display/Display.woff2") format("woff2")}',
  'fonts/display/Display.woff2': WOFF2,
  'assets/x.png': PNG,
  'assets/caf\u00e9.png': PNG,
  'assets/shots/wide.jpg': JPG,
  'assets/texture.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
  'assets/kit.js': 'window.kitLoaded = true;',
  // Executable types the manifest does not declare must stay unserved.
  'notes/extra.html': '<script>undeclared-html</script>',
  'scripts/tool.js': 'undeclared-js',
  'source/logo.svg': '<svg xmlns="http://www.w3.org/2000/svg"><script>undeclared-svg</script></svg>',
  '.secret': 'dotfile',
};

const MIME_BY_EXT: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.md': 'text/',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

async function writePackage(dir: string, files: Record<string, string | Buffer>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
}

beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'od-ds-kit-relative-'));
  root = path.join(tmp, 'design-systems');
  kitDir = path.join(root, 'kit-fixture');
  await writePackage(kitDir, FILES);
  await writePackage(path.join(root, 'team-kit'), {
    'manifest.json': manifest('team-kit'),
    'DESIGN.md': '# Team kit\n',
    'tokens.css': ':root{}',
    'system/kit.html': '<!doctype html><html><head><link rel="stylesheet" href="../tokens.css"></head><body>team</body></html>',
  });
  await writeFile(path.join(root, 'outside.txt'), 'outside the package');
  await writeFile(path.join(tmp, 'secret.txt'), 'far outside');
  await symlink(path.join(tmp, 'secret.txt'), path.join(kitDir, 'assets', 'linked.txt'));
  await symlink(tmp, path.join(kitDir, 'assets', 'linkdir'));
  // Hard links carry bookkeeping inodes under allowed passive names.
  await link(path.join(kitDir, 'metadata.json'), path.join(kitDir, 'assets', 'meta-alias.json'));
  await link(path.join(kitDir, 'revisions', 'r1.json'), path.join(kitDir, 'assets', 'rev-alias.json'));

  const app = express();
  registerKitRoutes(app);
  baseUrl = await new Promise<string>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${(server!.address() as { port: number }).port}`);
    });
  });
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

// The Workspace binding the real read gate consults: `user:team-kit` is a
// Personal resource of member `member` in Workspace `team`.
const TEAM_BINDING = {
  resourceId: TEAM_ID,
  workspaceId: 'team',
  visibility: 'personal',
  createdByWorkspaceMemberId: 'member',
};

function registerKitRoutes(app: express.Express): void {
  registerDesignSystemRoutes(app, {
    db: {} as never,
    paths: { CRAFT_DIR: '', USER_DESIGN_SYSTEMS_DIR: '' } as never,
    projectFiles: {} as never,
    projectStore: {} as never,
    // The membership directory lists only the binding's own member: the
    // claimed pair is a selector, so `intruder` is refused before any read.
    verifyWorkspaceRequestAuthority: async (req: any) => (
      req.get('x-od-workspace-id') === TEAM_BINDING.workspaceId
        && req.get('x-od-workspace-member-id') === TEAM_BINDING.createdByWorkspaceMemberId
        ? {
            ok: true,
            context: {
              workspaceId: TEAM_BINDING.workspaceId,
              workspaceMemberId: TEAM_BINDING.createdByWorkspaceMemberId,
            },
          }
        : { ok: false, status: 403, code: 'WORKSPACE_ACCESS_DENIED', message: 'not a member' }
    ) as never,
    workspaceResources: {
      getWorkspaceResource: (_db: unknown, _kind: string, workspaceId: string, resourceId: string) =>
        workspaceId === TEAM_BINDING.workspaceId && resourceId === TEAM_ID ? TEAM_BINDING : undefined,
      getWorkspaceResourceByResourceId: (_db: unknown, _kind: string, resourceId: string) =>
        resourceId === TEAM_ID ? TEAM_BINDING : undefined,
    },
    designSystems: {
      buildUserDesignSystemArchive: async () => null,
      canMutateUserDesignSystem: async () => true,
      createUserDesignSystem: async () => ({}) as never,
      deleteUserDesignSystem: async () => false,
      ensureUserDesignSystemWorkspaceProject: async () => null,
      listAllDesignSystems: async () => [] as never,
      listUserDesignSystemFiles: async () => null,
      listUserDesignSystemRevisions: async () => null,
      prepareDesignTokenContractRebuild: async () => ({ decision: { available: false } }) as never,
      readAvailableDesignSystem: async (id: string) => (id === ID || id === TEAM_ID ? '# Kit fixture' : null),
      readAvailableDesignSystemPackageInfo: async () => null,
      // The production user-kit read path: the real reader over a user root.
      readAvailableDesignSystemStaticFile: async (id: string, filePath: string) =>
        readDesignSystemStaticFile(root, id, filePath, { idPrefix: 'user:' }),
      readDesignSystemWorkspaceTextFile: async () => null,
      readUserDesignSystemFile: async () => null,
      renderDesignSystemPreview: () => '<!doctype html><title>preview</title>',
      renderDesignSystemShowcase: (id: string) => `<!doctype html><title>${id} synthetic</title>`,
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
  } as never);
}

type Ref = { raw: string; kind: 'attr' | 'css' | 'script' };

function collectRefs(text: string, isCss: boolean): Ref[] {
  const refs: Ref[] = [];
  if (!isCss) {
    for (const m of text.matchAll(/\b(?:src|href)=(["'])([^"']+)\1/gi)) {
      if (/^<base\b/i.test(text.slice(text.lastIndexOf('<', m.index!), m.index!))) continue;
      refs.push({ raw: m[2]!, kind: 'attr' });
    }
    // Runtime-built URLs in the fixture's inline script.
    for (const m of text.matchAll(/var page = "([^"]+)"; frame\.src = page \+ "([^"]+)"/g)) {
      refs.push({ raw: `${m[1]}${m[2]}`, kind: 'script' });
    }
  }
  // A browser fetches url() only from CSS; the lookbehind skips script such as
  // `URL.createObjectURL(f)`.
  for (const m of text.matchAll(/(?<![\w$.-])url\(\s*(["']?)([^"')]+)\1\s*\)/gi)) refs.push({ raw: m[2]!, kind: 'css' });
  for (const m of text.matchAll(/@import\s+(["'])([^"']+)\1/gi)) refs.push({ raw: m[2]!, kind: 'css' });
  return refs.filter((ref) => !/^(?:#|%23)/i.test(ref.raw) && !/^(?:data|https?|mailto):/i.test(ref.raw));
}

function documentBase(html: string, documentUrl: string): string {
  const base = /<base\b[^>]*\bhref=(["'])([^"']+)\1/i.exec(html);
  return base ? new URL(base[2]!, documentUrl).href : documentUrl;
}

function packagePathFor(url: string): string | null {
  const parsed = new URL(url);
  const query = parsed.searchParams.get('path');
  if (query) return query;
  const marker = `/api/design-systems/${ENCODED_ID}/static/`;
  if (parsed.pathname.startsWith(marker)) {
    return parsed.pathname.slice(marker.length).split('/').map(decodeURIComponent).join('/');
  }
  return null;
}

/**
 * Crawl a document the way a browser would. `documentUrl` is the URL the
 * document is loaded from; for a srcdoc frame it is the embedding page's URL.
 */
async function crawl(startHtml: string, documentUrl: string): Promise<{ failures: string[]; loaded: Set<string> }> {
  const failures: string[] = [];
  const loaded = new Set<string>();
  const queue: Array<{ text: string; url: string; isCss: boolean; from: string }> = [
    { text: startHtml, url: documentUrl, isCss: false, from: 'showcase' },
  ];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const doc = queue.shift()!;
    const base = doc.isCss ? doc.url : documentBase(doc.text, doc.url);
    for (const ref of collectRefs(doc.text, doc.isCss)) {
      const target = new URL(ref.raw, base);
      target.hash = '';
      if (target.origin !== new URL(baseUrl).origin) {
        failures.push(`${doc.from}: ${ref.raw} resolved off-origin to ${target.href}`);
        continue;
      }
      if (seen.has(target.href)) continue;
      seen.add(target.href);
      const res = await fetch(target.href);
      const pkgPath = packagePathFor(res.url);
      if (res.status !== 200 || !pkgPath) {
        failures.push(`${doc.from}: ${ref.raw} (${ref.kind}) -> ${target.pathname}${target.search} = ${res.status}`);
        await res.arrayBuffer();
        continue;
      }
      if (res.headers.get('x-content-type-options') !== 'nosniff') failures.push(`${pkgPath} lacks nosniff`);
      const ext = path.extname(pkgPath).toLowerCase();
      const contentType = res.headers.get('content-type') ?? '';
      if (MIME_BY_EXT[ext] && !contentType.startsWith(MIME_BY_EXT[ext]!)) {
        failures.push(`${doc.from}: ${pkgPath} served as ${contentType}`);
      }
      const bytes = Buffer.from(await res.arrayBuffer());
      loaded.add(pkgPath);
      if (ext === '.html' || ext === '.css') {
        queue.push({ text: bytes.toString('utf8'), url: res.url, isCss: ext === '.css', from: pkgPath });
      } else {
        const expected = await readFile(path.join(kitDir, pkgPath));
        if (!bytes.equals(expected)) failures.push(`${doc.from}: ${pkgPath} bytes differ from the package file`);
      }
    }
  }
  return { failures, loaded };
}

const EVERY_REFERENCED_FILE = [
  'tokens.css',
  'fonts/fonts.css',
  'fonts/display/Display.woff2',
  'assets/x.png',
  'assets/texture.svg',
  'assets/kit.js',
  'assets/shots/wide.jpg',
  'components.html',
  'preview/index.html',
  'system/kit.html',
  'MOTION.json',
  'DESIGN.md',
];

const KIT_PATH_URL = `/api/design-systems/${ENCODED_ID}/static/system/kit.html`;

describe('installed user design-system kit: kit-relative references', () => {
  it('redirects /showcase to the kit at its own package URL and loads every reference', async () => {
    const manual = await fetch(`${baseUrl}/api/design-systems/${ENCODED_ID}/showcase`, { redirect: 'manual' });
    expect(manual.status).toBe(302);
    expect(manual.headers.get('location')).toBe(KIT_PATH_URL);
    expect(manual.headers.get('x-content-type-options')).toBe('nosniff');

    const res = await fetch(`${baseUrl}/api/design-systems/${ENCODED_ID}/showcase`);
    expect(res.status).toBe(200);
    expect(new URL(res.url).pathname).toBe(KIT_PATH_URL);
    const html = await res.text();
    expect(html).not.toContain('synthetic');
    // Document URL and base are the same URL, so `#fx-intro` stays in this document.
    expect(new URL(documentBase(html, res.url)).pathname).toBe(KIT_PATH_URL);
    const { failures, loaded } = await crawl(html, res.url);
    expect(failures).toEqual([]);
    expect([...loaded].sort()).toEqual([...EVERY_REFERENCED_FILE].sort());
  });

  it('loads every reference of /showcase rendered as srcdoc inside the web app', async () => {
    const html = await (await fetch(`${baseUrl}/api/design-systems/${ENCODED_ID}/showcase`)).text();
    // A srcdoc document resolves relative URLs against the embedding page.
    const { failures, loaded } = await crawl(html, `${baseUrl}/projects/p1/design-systems`);
    expect(failures).toEqual([]);
    expect([...loaded].sort()).toEqual([...EVERY_REFERENCED_FILE].sort());
  });

  it('redirects a query-form kit document to the path form', async () => {
    const url = `${baseUrl}/api/design-systems/${ENCODED_ID}/static?path=${encodeURIComponent('system/kit.html')}`;
    const manual = await fetch(url, { redirect: 'manual' });
    expect(manual.status).toBe(302);
    expect(manual.headers.get('location')).toBe(KIT_PATH_URL);
    const res = await fetch(url);
    const { failures } = await crawl(await res.text(), res.url);
    expect(failures).toEqual([]);
  });

  it('leaves script and inline SVG fragment references untouched', async () => {
    const html = await (await fetch(`${baseUrl}/api/design-systems/${ENCODED_ID}/showcase`)).text();
    expect(html).toContain('img.src = URL.createObjectURL(f);');
    expect(html).toContain('mask=%22url(%23h)%22');
  });

  // Main's rewriter output for the three representative pages: every quoted
  // href/src, the base tag's own included, resolved against the file's
  // directory (main even emits `path=..` for a top-level `..`, which the
  // server then refuses).
  const S = `/api/design-systems/${ENCODED_ID}/static?path=`;
  const MAIN_REWRITE: Record<string, string> = {
    'base-dotdot.html': `<!doctype html><html><head><base href="${S}.."></head><body><img src="${S}x.png"></body></html>`,
    'preview/based.html': `<!doctype html><html><head><base href="${S}assets%2F"></head><body><img src="${S}preview%2Fx.png"></body></html>`,
    'preview/based-upper.html': `<!doctype html><html><head><BASE HREF="${S}assets%2F" /></head><body><img src="${S}preview%2Fx.png"></body></html>`,
  };

  it.each(Object.keys(MAIN_REWRITE))('serves %s as main does: inline, dir-relative rewrites, no injected base', async (page) => {
    const res = await fetch(`${baseUrl}${S}${encodeURIComponent(page)}`, { redirect: 'manual' });
    expect(res.status).toBe(200);
    // The served page also carries the sandbox storage fallback (B-092), installed before any
    // preview script; everything else matches main's rewriter byte for byte.
    expect(await res.text()).toBe(withPreviewStorage(MAIN_REWRITE[page]!));
  });

  it.each(Object.keys(BASE_PAGES))('never injects a base or redirects for %s', async (page) => {
    const query = await fetch(`${baseUrl}${S}${encodeURIComponent(page)}`, { redirect: 'manual' });
    expect(query.status).toBe(200);
    const queryHtml = await query.text();
    expect(queryHtml).not.toContain('data-od-design-system-package-base');
    // Main's quoted-attribute rewrite against the file's own directory.
    const dir = page.includes('/') ? `${encodeURIComponent(page.slice(0, page.lastIndexOf('/') + 1))}` : '';
    expect(queryHtml).toContain(`src="${S}${dir}x.png"`);
    const pathForm = await fetch(`${baseUrl}/api/design-systems/${ENCODED_ID}/static/${page}`);
    expect(pathForm.status).toBe(200);
    expect(await pathForm.text()).not.toContain('data-od-design-system-package-base');
  });

  it('serves exact entry names only: Unicode normalisation variants do not alias', async () => {
    const nfc = await fetch(`${baseUrl}/api/design-systems/${ENCODED_ID}/static/assets/${encodeURIComponent('caf\u00e9.png')}`);
    expect(nfc.status).toBe(200);
    await nfc.arrayBuffer();
    for (const url of [
      `${baseUrl}/api/design-systems/${ENCODED_ID}/static/assets/${encodeURIComponent('cafe\u0301.png')}`,
      `${baseUrl}/api/design-systems/${ENCODED_ID}/static?path=${encodeURIComponent('assets/cafe\u0301.png')}`,
      `${baseUrl}/api/design-systems/${ENCODED_ID}/static/ASSETS/x.png`,
      `${baseUrl}/api/design-systems/${ENCODED_ID}/static?path=${encodeURIComponent('assets/X.PNG')}`,
    ]) {
      const res = await fetch(url);
      expect(res.status, url).toBe(404);
      await res.arrayBuffer();
    }
  });

  it('serves package files by path with the right MIME type and nosniff', async () => {
    for (const [rel, mime] of [
      ['system/kit.html', 'text/html'],
      ['assets/kit.js', 'text/javascript'],
      ['fonts/display/Display.woff2', 'font/woff2'],
      ['assets/shots/wide.jpg', 'image/jpeg'],
      ['MOTION.json', 'application/json'],
    ] as const) {
      const res = await fetch(`${baseUrl}/api/design-systems/${ENCODED_ID}/static/${rel}`);
      expect(res.status, rel).toBe(200);
      expect(res.headers.get('content-type'), rel).toContain(mime);
      expect(res.headers.get('x-content-type-options'), rel).toBe('nosniff');
      await res.arrayBuffer();
    }
  });

  it.each(['notes/extra.html', 'scripts/tool.js', 'source/logo.svg'])(
    'does not serve undeclared executable content %s in either form',
    async (rel) => {
      for (const url of [
        `${baseUrl}/api/design-systems/${ENCODED_ID}/static/${rel}`,
        `${baseUrl}/api/design-systems/${ENCODED_ID}/static?path=${encodeURIComponent(rel)}`,
      ]) {
        const res = await fetch(url);
        expect(res.status, url).toBe(404);
        expect(await res.text()).not.toContain('undeclared');
      }
    },
  );

  describe('Workspace-scoped kits keep the query form only', () => {
    it('answers 404 from the path form for a Workspace-bound kit', async () => {
      const res = await fetch(`${baseUrl}/api/design-systems/${ENCODED_TEAM_ID}/static/system/kit.html`);
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain('team');
    });

    it('answers 404 from the path form when the request claims any Workspace scope', async () => {
      const query = await fetch(
        `${baseUrl}/api/design-systems/${ENCODED_ID}/static/system/kit.html?workspaceId=team&workspaceMemberId=member`,
      );
      expect(query.status).toBe(404);
      const header = await fetch(`${baseUrl}/api/design-systems/${ENCODED_ID}/static/system/kit.html`, {
        headers: { 'x-od-workspace-id': 'team', 'x-od-workspace-member-id': 'member' },
      });
      expect(header.status).toBe(404);
      const partial = await fetch(`${baseUrl}/api/design-systems/${ENCODED_ID}/static/tokens.css?workspaceId=team`);
      expect(partial.status).toBe(404);
      const emptyQuery = await fetch(`${baseUrl}/api/design-systems/${ENCODED_ID}/static/tokens.css?workspaceMemberId=`);
      expect(emptyQuery.status).toBe(404);
    });

    it.each([
      ['empty id header', { 'x-od-workspace-id': '' }],
      ['whitespace id header', { 'x-od-workspace-id': '   ' }],
      ['empty member header', { 'x-od-workspace-member-id': '' }],
      ['whitespace member header', { 'x-od-workspace-member-id': ' \t ' }],
    ])('answers 404 from the path form for a present %s', async (_label, headers) => {
      // node:http sends the header verbatim, empty and whitespace values included.
      const status = await new Promise<number | undefined>((resolve, reject) => {
        http.get(`${baseUrl}/api/design-systems/${ENCODED_ID}/static/tokens.css`, { headers }, (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        }).on('error', reject);
      });
      expect(status).toBe(404);
    });

    it('keeps the query-form gate: no context is refused, scoped showcase is served inline', async () => {
      const unscoped = await fetch(`${baseUrl}/api/design-systems/${ENCODED_TEAM_ID}/showcase`);
      expect(unscoped.status).toBe(400);
      expect(await unscoped.json()).toMatchObject({ error: 'WORKSPACE_CONTEXT_REQUIRED' });

      const scoped = await fetch(
        `${baseUrl}/api/design-systems/${ENCODED_TEAM_ID}/showcase?workspaceId=team&workspaceMemberId=member`,
        { redirect: 'manual' },
      );
      expect(scoped.status).toBe(200);
      const html = await scoped.text();
      expect(html).not.toContain('<base');
      expect(html).toContain('path=tokens.css&workspaceId=team&workspaceMemberId=member');

      const otherMember = await fetch(
        `${baseUrl}/api/design-systems/${ENCODED_TEAM_ID}/static?path=tokens.css&workspaceId=team&workspaceMemberId=intruder`,
      );
      expect(otherMember.status).toBe(403);
    });
  });

  it.each([
    ['query ..', `static?path=${encodeURIComponent('../outside.txt')}`],
    ['query encoded ..', 'static?path=%2e%2e%2foutside.txt'],
    ['query backslash ..', `static?path=${encodeURIComponent('..\\outside.txt')}`],
    ['query nested ..', `static?path=${encodeURIComponent('assets/../../outside.txt')}`],
    ['query absolute', `static?path=${encodeURIComponent(path.join(root || '/', 'outside.txt'))}`],
    ['query dotfile', `static?path=${encodeURIComponent('.secret')}`],
    ['query symlink out', `static?path=${encodeURIComponent('assets/linked.txt')}`],
    ['query symlinked dir', `static?path=${encodeURIComponent('assets/linkdir/secret.txt')}`],
    ['query metadata.json', 'static?path=metadata.json'],
    ['query METADATA.JSON', 'static?path=METADATA.JSON'],
    ['query revisions', `static?path=${encodeURIComponent('revisions/r1.json')}`],
    ['query Revisions', `static?path=${encodeURIComponent('Revisions/r1.json')}`],
    ['path encoded ..', 'static/%2e%2e/outside.txt'],
    ['path encoded slash ..', 'static/..%2Foutside.txt'],
    ['path backslash ..', 'static/..%5Coutside.txt'],
    ['path dotfile', 'static/.secret'],
    ['path symlink out', 'static/assets/linked.txt'],
    ['path symlinked dir', 'static/assets/linkdir/secret.txt'],
    ['path METADATA.JSON', 'static/METADATA.JSON'],
    ['path metadata.json.', 'static/metadata.json.'],
    ['path Revisions', 'static/Revisions/r1.json'],
    ['path hard-linked metadata', 'static/assets/meta-alias.json'],
    ['query hard-linked metadata', `static?path=${encodeURIComponent('assets/meta-alias.json')}`],
    ['path hard-linked revision', 'static/assets/rev-alias.json'],
    ['query hard-linked revision', `static?path=${encodeURIComponent('assets/rev-alias.json')}`],
    ['path long-s revisions', `static/${encodeURIComponent('revi\u017fions')}/r1.json`],
    ['query long-s revisions', `static?path=${encodeURIComponent('revi\u017fions/r1.json')}`],
    ['path trailing-dot revisions', 'static/revisions./r1.json'],
    ['query trailing-dot metadata', `static?path=${encodeURIComponent('metadata.json.')}`],
  ])('refuses %s', async (_label, suffix) => {
    const res = await fetch(`${baseUrl}/api/design-systems/${ENCODED_ID}/${suffix}`);
    const body = await res.text();
    expect(res.status).toBe(404);
    // Assert on file contents, not the echoed request path.
    for (const secret of ['outside the package', 'far outside', 'dotfile', 'bookkeeping']) {
      expect(body).not.toContain(secret);
    }
  });
});
