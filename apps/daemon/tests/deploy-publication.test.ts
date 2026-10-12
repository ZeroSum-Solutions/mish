import express from 'express';
import type { DeployPreflightResponse, DeployProjectFileResponse } from '@mish/contracts';
import type { Server } from 'node:http';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as deploy from '../src/deploy.js';
import { registerDeployRoutes, type RegisterDeployRoutesDeps } from '../src/routes/deploy.js';
import { resetVercelSiteProviderFixtures, withVercelSiteProvider } from './helpers/vercel-site-provider.js';

const roots: string[] = [];
const servers: Server[] = [];
beforeEach(resetVercelSiteProviderFixtures);
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/**
 * Fixed Vercel site/alias identity for this fixture's provider fake. #264's
 * "pick your URL" binding (bindVercelSite / bindVercelStableAlias) now reads
 * back the created project and its stable alias instead of trusting the
 * deployment response alone, so the fake must answer those endpoints too —
 * modelled on tests/routes-deploy-vercel-site.test.ts and
 * tests/vercel-site.test.ts. withVercelSiteProvider (shared with
 * deploy-routes.test.ts and deploy-vercel-upload.test.ts) covers the project
 * create/lookup and domain/alias-read endpoints; this file's own mock below
 * still owns the deployment-creation, protection-check and host-probe
 * endpoints the allowlist assertions depend on.
 */
const VERCEL_SITE_PROJECT_ID = 'prj-publication-test';
const VERCEL_SITE_DEPLOYMENT_ID = 'dep-publication-test';
const VERCEL_SITE_HOST = 'publication-test-site.vercel.app';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'deploy-publication-'));
  roots.push(root);
  const dir = path.join(root, 'p1');
  await mkdir(path.join(dir, 'pages'), { recursive: true });
  const app = express();
  app.use(express.json());
  registerDeployRoutes(app, {
    db: {}, paths: { PROJECTS_DIR: root }, ids: { randomUUID: () => 'd1' },
    http: { sendApiError: (res: express.Response, status: number, code: string, message: string) => res.status(status).json({ code, message }) },
    projectStore: { getProject: () => ({ id: 'p1', name: 'Publication' }) },
    authorizeProjectRequest: async () => ({ mode: 'local' }),
    deploy: {
      ...deploy,
      getDeployment: () => null,
      // The pick-URL route reads sibling Vercel bindings; this harness has none.
      listDeployments: () => [],
      readDeployConfig: async () => ({ token: 'test-only', accountId: 'test-account', projectName: 'test-site' }),
      cloudflarePagesProjectNameForDeploy: () => 'test-site',
      upsertDeployment: (_db: unknown, value: unknown) => value,
      publicDeployment: (value: unknown) => value,
    },
  } as unknown as RegisterDeployRoutesDeps);
  const server = await new Promise<Server>((resolve) => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing server port');
  const url = `http://127.0.0.1:${address.port}/api/projects/p1/deploy`;
  const request = (body: unknown, suffix = '') => fetch(url + suffix, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { dir, root, request };
}

function providerMock() {
  const realFetch = globalThis.fetch;
  const vercelBodies: Buffer[] = [];
  const cloudflareBodies: string[] = [];
  let uploadedPaths: string[] = [];
  const providerCalls: string[] = [];
  const inner = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith('http://127.0.0.1:')) return realFetch(input, init);
    providerCalls.push(url);
    const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
    if (url.startsWith('https://api.vercel.com/v2/files')) {
      vercelBodies.push(Buffer.from(init?.body as Uint8Array));
      return json({});
    }
    // POST creates the deployment (and records the uploaded file set); the
    // GET that follows is deployToVercel's readiness poll and carries no
    // body, so it must not be run through the same JSON.parse.
    if (url.includes('api.vercel.com/v13/deployments')) {
      if (init?.body) {
        uploadedPaths = (JSON.parse(String(init.body)).files as { file: string }[]).map((file) => file.file);
      }
      return json({ id: VERCEL_SITE_DEPLOYMENT_ID, readyState: 'READY' });
    }
    // Once the site is bound, deployToVercel re-reads the project's
    // Deployment Protection settings by its raw provider id (never the
    // `od-*` name withVercelSiteProvider's create/lookup branches answer).
    if (url.startsWith(`https://api.vercel.com/v9/projects/${VERCEL_SITE_PROJECT_ID}`)) {
      return json({ id: VERCEL_SITE_PROJECT_ID, ssoProtection: null, passwordProtection: null });
    }
    if (url.endsWith('/upload-token')) return json({ success: true, result: { jwt: 'test-only' } });
    if (url.endsWith('/pages/assets/check-missing')) return json({ success: true, result: JSON.parse(String(init?.body)).hashes });
    if (url.endsWith('/pages/assets/upload')) {
      cloudflareBodies.push(...(JSON.parse(String(init?.body)) as { value: string }[]).map((file) => Buffer.from(file.value, 'base64').toString()));
      return json({ success: true, result: null });
    }
    if (url.endsWith('/pages/assets/upsert-hashes')) return json({ success: true, result: null });
    if (url.endsWith('/pages/projects/test-site/deployments')) {
      uploadedPaths = Object.keys(JSON.parse(String((init?.body as FormData).get('manifest')))).map((name) => name.slice(1));
      return json({ success: true, result: { id: 'cf-test' } });
    }
    if (url.endsWith('/pages/projects/test-site')) return json({ success: true, result: { name: 'test-site' } });
    if (url.startsWith('https://test-site.pages.dev')) return new Response('<h1>Publication</h1>');
    // The stable alias the Vercel binding assigns; probed anonymously once
    // the deployment is bound (readiness check, then the protection-off
    // page confirmation).
    if (url.startsWith(`https://${VERCEL_SITE_HOST}`)) {
      return new Response('<h1>Publication</h1>', { headers: { 'content-type': 'text/html' } });
    }
    throw new Error(`Unexpected provider request: ${url}`);
  });
  vi.stubGlobal('fetch', withVercelSiteProvider(inner, {
    projectId: VERCEL_SITE_PROJECT_ID,
    deploymentId: VERCEL_SITE_DEPLOYMENT_ID,
    host: VERCEL_SITE_HOST,
  }));
  return { paths: () => uploadedPaths.sort(), bodies: () => [...vercelBodies.map((value) => value.toString()), ...cloudflareBodies], providerCalls };
}

describe('provider publication allowlist', () => {
  const availabilityCases = [
    { name: 'dead anchors', html: '<a href="old.html">Old</a><area href="resume.pdf">', assets: {}, paths: [], warnings: [{ code: 'broken-reference', path: 'old.html' }, { code: 'broken-reference', path: 'resume.pdf' }] },
    { name: 'broken CSS', html: '<link rel="stylesheet" href="theme.css">', assets: { 'theme.css': 'body{background:url(logo.png);', 'logo.png': 'public-logo' }, paths: ['theme.css', 'logo.png'], warnings: [{ code: 'reference-scan-fallback', path: 'theme.css' }] },
    { name: 'broken JS', html: '<script src="app.js"></script>', assets: { 'app.js': 'import "./leaf.js"; fetch("data.json"); const broken = ;', 'leaf.js': 'export const value = 1;' }, paths: ['app.js', 'leaf.js'], warnings: [{ code: 'reference-scan-fallback', path: 'app.js' }] },
    { name: 'broken inline CSS', html: '<style>body{background:url(logo.png);</style><p style="background:url(logo.png">x</p>', assets: { 'logo.png': 'public-logo' }, paths: ['logo.png'], warnings: [{ code: 'reference-scan-fallback', path: 'index.html' }] },
    { name: 'broken inline module', html: '<script type="module">import "./leaf.js"; const broken = ;</script>', assets: { 'leaf.js': 'export const value = 1;' }, paths: ['leaf.js'], warnings: [{ code: 'reference-scan-fallback', path: 'index.html' }] },
    { name: 'malformed reference', html: '<img src="bad%.png"><img src="logo.png">', assets: { 'logo.png': 'public-logo' }, paths: ['logo.png'], warnings: [{ code: 'invalid-reference', url: 'bad%.png' }] },
    { name: 'malformed base', html: '<base href="bad%/"><img src="logo.png">', assets: { 'logo.png': 'public-logo' }, paths: ['logo.png'], warnings: [{ code: 'invalid-reference', url: 'bad%/' }] },
  ];
  for (const providerId of [deploy.VERCEL_PROVIDER_ID, deploy.CLOUDFLARE_PAGES_PROVIDER_ID]) {
    it.each(availabilityCases)('deploys $name with warnings on ' + providerId, async ({ html, assets, paths, warnings }) => {
      const { dir, request } = await fixture();
      await writeFile(path.join(dir, 'index.html'), html + '<img data-src="keys.env"><meta property="og:image" content="secret.csv">');
      for (const [name, content] of Object.entries(assets)) await writeFile(path.join(dir, name), content);
      for (const name of ['keys.env', 'secret.csv', 'data.json']) await writeFile(path.join(dir, name), `private-fixture-${name}`);
      const provider = providerMock();
      const preflightResponse = await request({ fileName: 'index.html', providerId }, '/preflight');
      expect(preflightResponse.status, await preflightResponse.clone().text()).toBe(200);
      const preflight = await preflightResponse.json() as DeployPreflightResponse;
      expect(preflight.warnings).toEqual(expect.arrayContaining(warnings.map((warning) => expect.objectContaining(warning))));
      const response = await request({ fileName: 'index.html', providerId, target: 'preview' });
      expect(response.status, await response.clone().text()).toBe(200);
      const result = await response.json() as DeployProjectFileResponse;
      expect(result.warnings).toEqual(expect.arrayContaining(warnings.map((warning) => expect.objectContaining(warning))));
      expect(provider.paths()).toEqual(['index.html', ...paths].sort());
      expect(provider.paths()).toEqual(preflight.files.map((file: { path: string }) => file.path).sort());
      for (const content of Object.values(assets)) expect(provider.bodies()).toContain(content);
      expect(provider.bodies().some((body) => body.includes('private-fixture-'))).toBe(false);
    });
  }

  it.each([deploy.VERCEL_PROVIDER_ID, deploy.CLOUDFLARE_PAGES_PROVIDER_ID])('excludes private siblings from %s upload requests and matches preflight', async (providerId) => {
    const { dir, request } = await fixture();
    await writeFile(path.join(dir, 'index.html'), '<h1>Publication</h1><img src="logo.png">');
    await writeFile(path.join(dir, 'logo.png'), 'public-logo-bytes');
    for (const name of ['secret.csv', 'notes.md', 'keys.env']) await writeFile(path.join(dir, name), `private-fixture-${name}`);
    const provider = providerMock();
    const planned = await request({ fileName: 'index.html', providerId }, '/preflight');
    expect(planned.status).toBe(200);
    const preflight = await planned.json() as { totalFiles: number; files: { path: string }[] };
    const response = await request({ fileName: 'index.html', providerId, target: 'preview' });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(provider.paths()).toEqual(['index.html', 'logo.png']);
    expect(provider.paths()).toEqual(preflight.files.map((file) => file.path).sort());
    expect(preflight.totalFiles).toBe(2);
    expect(provider.bodies()).toContain('public-logo-bytes');
    expect(provider.bodies().some((body) => body.includes('private-fixture-'))).toBe(false);
  });

  it.each([deploy.VERCEL_PROVIDER_ID, deploy.CLOUDFLARE_PAGES_PROVIDER_ID])('uploads transitive HTML, CSS, srcset, scripts, fonts and media on %s', async (providerId) => {
    const { dir, request } = await fixture();
    await writeFile(path.join(dir, 'index.html'), '<h1>Publication</h1><a href="pages/about.html">About</a>');
    await writeFile(path.join(dir, 'pages/about.html'), '<link rel="stylesheet" href="theme.css"><script src="app.js"></script><img srcset="small.png 1x, large.png 2x"><video poster="poster.png" src="clip.mp4"></video>');
    await writeFile(path.join(dir, 'pages/theme.css'), '@import "more.css"; body{background:url(bg.png)}');
    await writeFile(path.join(dir, 'pages/more.css'), '@font-face{src:url(font.woff2)}');
    await writeFile(path.join(dir, 'notes.md'), 'private-fixture-notes');
    const names = ['app.js', 'small.png', 'large.png', 'poster.png', 'clip.mp4', 'bg.png', 'font.woff2'];
    for (const name of names) await writeFile(path.join(dir, 'pages', name), `public-${name}`);
    const provider = providerMock();
    const response = await request({ fileName: 'index.html', providerId, target: 'preview' });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(provider.paths()).toEqual(['index.html', 'pages/about.html', 'pages/theme.css', 'pages/more.css', ...names.map((name) => `pages/${name}`)].sort());
    for (const name of names) expect(provider.bodies()).toContain(`public-${name}`);
    expect(provider.bodies().some((body) => body.includes('private-fixture-'))).toBe(false);
  });

  it.each(['../outside.png', 'pages/../logo.png', '%2e%2e/outside.png', 'pages/%2e%2e/logo.png', 'pages\\..\\logo.png'])('refuses traversal %s before any provider request', async (ref) => {
    const { dir, request } = await fixture();
    await writeFile(path.join(dir, 'index.html'), `<img src="${ref}">`);
    await writeFile(path.join(dir, 'logo.png'), 'in-project-bytes');
    const provider = providerMock();
    for (const providerId of [deploy.VERCEL_PROVIDER_ID, deploy.CLOUDFLARE_PAGES_PROVIDER_ID]) {
      expect((await request({ fileName: 'index.html', providerId })).status).toBe(400);
    }
    expect(provider.providerCalls).toEqual([]);
  });

  it('refuses a referenced symlink outside the project before upload', async () => {
    const { dir, root, request } = await fixture();
    await writeFile(path.join(root, 'outside.png'), 'outside-fixture');
    await symlink(path.join(root, 'outside.png'), path.join(dir, 'alias.png'));
    await writeFile(path.join(dir, 'index.html'), '<img src="alias.png">');
    const provider = providerMock();
    expect((await request({ fileName: 'index.html' })).status).toBe(400);
    expect(provider.providerCalls).toEqual([]);
  });

  it('collects only live references, decodes HTML entities, and ignores data srcset URLs', async () => {
    const { dir, root } = await fixture();
    await writeFile(path.join(dir, 'index.html'), '<!-- <img src="notes.md"> --><script>const text = \'<img src="keys.env">\';</script><link href="theme.css" rel="stylesheet"><img alt="a > b" src="logo&#46;png"><img srcset="data:image/png;base64,AAAA 1x, logo.png 2x">');
    await writeFile(path.join(dir, 'theme.css'), '/* url(secret.csv) */body{content:"url(notes.md)";background:url(logo.png)}');
    for (const name of ['secret.csv', 'notes.md', 'keys.env', 'logo.png']) await writeFile(path.join(dir, name), `fixture-${name}`);
    expect((await deploy.buildDeployFileSet(root, 'p1', 'index.html')).map((file) => file.file).sort()).toEqual(['index.html', 'logo.png', 'theme.css']);
  });

  it('does not treat generated supportingFiles as permission to publish private files', async () => {
    const { dir, root } = await fixture();
    await writeFile(path.join(dir, 'index.html'), '<h1>Publication</h1>');
    await writeFile(path.join(dir, 'notes.md'), 'private-fixture-notes');
    await writeFile(path.join(dir, 'index.html.artifact.json'), JSON.stringify({ version: 1, kind: 'html', renderer: 'html', exports: ['html'], entry: 'index.html', supportingFiles: ['notes.md'] }));
    expect((await deploy.buildDeployFileSet(root, 'p1', 'index.html')).map((file) => file.file)).toEqual(['index.html']);
  });

  it('terminates cyclic page and stylesheet references', async () => {
    const { dir, root } = await fixture();
    await writeFile(path.join(dir, 'index.html'), '<a href="pages/about.html">About</a><link rel="stylesheet" href="theme.css">');
    await writeFile(path.join(dir, 'pages/about.html'), '<a href="/index.html">Home</a>');
    await writeFile(path.join(dir, 'theme.css'), '@import "theme.css";');
    expect((await deploy.buildDeployFileSet(root, 'p1', 'index.html')).map((file) => file.file).sort()).toEqual(['index.html', 'pages/about.html', 'theme.css']);
  });

  it('refuses CSS-escaped parent segments', async () => {
    const { dir, root } = await fixture();
    await writeFile(path.join(dir, 'index.html'), '<style>body{background:url(pages/\\2e\\2e/logo.png)}</style>');
    await writeFile(path.join(dir, 'logo.png'), 'public-fixture');
    await expect(deploy.buildDeployFileSet(root, 'p1', 'index.html')).rejects.toThrow();
  });

  it('honors external and local HTML base URLs without publishing unrelated root files', async () => {
    const { dir, root } = await fixture();
    await writeFile(path.join(dir, 'secret.csv'), 'private-fixture');
    await writeFile(path.join(dir, 'index.html'), '<base href="https://cdn.example/"><img src="secret.csv">');
    expect((await deploy.buildDeployFileSet(root, 'p1', 'index.html')).map((file) => file.file)).toEqual(['index.html']);
    await mkdir(path.join(dir, 'public'));
    await writeFile(path.join(dir, 'public/secret.csv'), 'public-fixture');
    await writeFile(path.join(dir, 'pages/entry.html'), '<base href="/public/"><img src="secret.csv">');
    const files = await deploy.buildDeployFileSet(root, 'p1', 'pages/entry.html');
    expect(files.map((file) => file.file)).toEqual(['index.html', 'public/secret.csv']);
    expect(files[0]?.data.toString()).toContain('<base href="/public/">');
  });

  it('does not collect CSS function names that merely end with url', async () => {
    const { dir, root } = await fixture();
    await writeFile(path.join(dir, 'notes.md'), 'private-fixture');
    await writeFile(path.join(dir, 'index.html'), '<div src="notes.md" poster="notes.md" srcset="notes.md"></div><style>.url(notes.md){color:red}body{background:myurl(notes.md);--ignored:"url(notes.md)"}</style>');
    expect((await deploy.buildDeployFileSet(root, 'p1', 'index.html')).map((file) => file.file)).toEqual(['index.html']);
  });

  it('keeps URL-encoded filenames safe when relocating entry attributes', async () => {
    const { dir, root } = await fixture();
    await writeFile(path.join(dir, 'pages/entry.html'), '<img src="photo%22%20data-review=%22unexpected.png"><img src=photo%20one.png>');
    await writeFile(path.join(dir, 'pages', 'photo" data-review="unexpected.png'), 'public-photo');
    await writeFile(path.join(dir, 'pages', 'photo one.png'), 'public-photo-two');
    const files = await deploy.buildDeployFileSet(root, 'p1', 'pages/entry.html');
    const html = files[0]?.data.toString();
    expect(html).toContain('src="pages/photo%22%20data-review%3D%22unexpected.png"');
    expect(html).toContain('src=pages/photo%20one.png');
    expect(html).not.toContain(' data-review="unexpected.png"');
  });

  it.each(['/', './'])('supports the directory base %s', async (base) => {
    const { dir, root } = await fixture();
    await writeFile(path.join(dir, 'index.html'), `<base href="${base}"><img src="logo.png">`);
    await writeFile(path.join(dir, 'logo.png'), 'public-logo');
    const files = await deploy.buildDeployFileSet(root, 'p1', 'index.html');
    expect(files.map((file) => file.file)).toEqual(['index.html', 'logo.png']);
    expect(files[0]?.data.toString()).toContain('<base href="/">');
  });

  it('follows script module dependencies and SVG resources transitively', async () => {
    const { dir, root } = await fixture();
    await writeFile(path.join(dir, 'index.html'), '<script type="module" src="app.js"></script><object data="pages/art.svg"></object>');
    await writeFile(path.join(dir, 'app.js'), 'import "./feature.js"; const image = new URL("logo.png", import.meta.url);');
    await writeFile(path.join(dir, 'feature.js'), 'export { value } from "./leaf.js";');
    await writeFile(path.join(dir, 'leaf.js'), 'export const value = 1;');
    await writeFile(path.join(dir, 'logo.png'), 'public-logo');
    await writeFile(path.join(dir, 'pages/art.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><image href="art.png"/></svg>');
    await writeFile(path.join(dir, 'pages/art.png'), 'public-art');
    expect((await deploy.buildDeployFileSet(root, 'p1', 'index.html')).map((file) => file.file).sort()).toEqual(['index.html', 'app.js', 'feature.js', 'leaf.js', 'logo.png', 'pages/art.svg', 'pages/art.png'].sort());
  });

  it('rewrites object data on a relocated entry', async () => {
    const { dir, root } = await fixture();
    await writeFile(path.join(dir, 'pages/entry.html'), '<object data="art.svg"></object>');
    await writeFile(path.join(dir, 'pages/art.svg'), '<svg/>');
    const files = await deploy.buildDeployFileSet(root, 'p1', 'pages/entry.html');
    expect(files[0]?.data.toString()).toContain('data="pages/art.svg"');
  });

  it('relocates inline module imports and safely encodes quoted CSS filenames', async () => {
    const { dir, root } = await fixture();
    await writeFile(path.join(dir, 'pages/entry.html'), '<script type="module">import "./app.js";</script><style>body{background:url(\'photo%27one.png\')}</style>');
    await writeFile(path.join(dir, 'pages/app.js'), 'export const value = 1;');
    await writeFile(path.join(dir, 'pages', "photo'one.png"), 'public-photo');
    const files = await deploy.buildDeployFileSet(root, 'p1', 'pages/entry.html');
    expect(files.map((file) => file.file).sort()).toEqual(['index.html', 'pages/app.js', "pages/photo'one.png"].sort());
    expect(files[0]?.data.toString()).toContain('import "/pages/app.js";');
    expect(files[0]?.data.toString()).toContain("url('pages/photo%27one.png')");
  });

  it('does not let an optional navigation miss mask a required asset miss', async () => {
    const { dir, root } = await fixture();
    await writeFile(path.join(dir, 'index.html'), '<a href="logo">Nav</a><img src="logo">');
    await expect(deploy.buildDeployFileSet(root, 'p1', 'index.html')).rejects.toMatchObject({ details: { missing: ['logo'] } });
  });

  it('warns on anchor directories and non-directory parents without collecting siblings', async () => {
    const { dir, root } = await fixture();
    await writeFile(path.join(dir, 'index.html'), '<a href="pages/">Pages</a><a href="parent/old.html">Old</a>');
    await writeFile(path.join(dir, 'parent'), 'private-fixture-parent');
    const publication = await deploy.prepareDeployPublication(root, 'p1', 'index.html');
    expect(publication.files.map((file) => file.file)).toEqual(['index.html']);
    expect(publication.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'broken-reference', path: 'pages' }), expect.objectContaining({ code: 'broken-reference', path: 'parent/old.html' })]));
  });

  it('keeps comments, arbitrary strings and runtime-only references private during parser fallback', async () => {
    const { dir, root } = await fixture();
    await writeFile(path.join(dir, 'index.html'), '<script src="app.js"></script><link rel="stylesheet" href="theme.css">');
    await writeFile(path.join(dir, 'app.js'), `// import "./keys.env";
      const text = 'import "./keys.env";';
      const template = \`import "./keys.env";\`;
      fetch('data.json');
      import('./leaf.js');
      export { value } from './leaf.js';
      const art = new URL('logo.png', import.meta.url);
      const broken = ;`);
    await writeFile(path.join(dir, 'theme.css'), '/* url(keys.env) */body{content:"url(keys.env)";background:url(logo.png);');
    await writeFile(path.join(dir, 'leaf.js'), 'export const value = 1;');
    for (const name of ['keys.env', 'data.json', 'logo.png']) await writeFile(path.join(dir, name), `fixture-${name}`);
    expect((await deploy.buildDeployFileSet(root, 'p1', 'index.html')).map((file) => file.file).sort()).toEqual(['index.html', 'app.js', 'theme.css', 'leaf.js', 'logo.png'].sort());
  });

  it('excludes computed import prefixes and CSS capability conditions during fallback', async () => {
    const { dir, root } = await fixture();
    await writeFile(path.join(dir, 'index.html'), '<script src="app.js"></script><link rel="stylesheet" href="theme.css">');
    await writeFile(path.join(dir, 'app.js'), 'import("./secret.csv" + ".json"); const broken = ;');
    await writeFile(path.join(dir, 'theme.css'), '@supports (background: url(secret.csv)) { body { color:red;');
    await writeFile(path.join(dir, 'secret.csv'), 'private-fixture-secret');
    expect((await deploy.buildDeployFileSet(root, 'p1', 'index.html')).map((file) => file.file).sort()).toEqual(['index.html', 'app.js', 'theme.css'].sort());
  });

  it('finds literal imports after division without collecting regex literal text', async () => {
    const { dir, root } = await fixture();
    await writeFile(path.join(dir, 'index.html'), '<script src="app.js"></script>');
    await writeFile(path.join(dir, 'app.js'), 'const n = 10 / 2; import "./leaf.js"; const pattern = /import(".\\/secret.csv")/; const broken = ;');
    await writeFile(path.join(dir, 'leaf.js'), 'export const value = 1;');
    await writeFile(path.join(dir, 'secret.csv'), 'private-fixture-secret');
    expect((await deploy.buildDeployFileSet(root, 'p1', 'index.html')).map((file) => file.file).sort()).toEqual(['index.html', 'app.js', 'leaf.js'].sort());
  });

  it.each([
    ['app.js', 'const text = " import(\'./secret.csv\');\nconst broken = ;', '<script src="app.js"></script>'],
    ['app.js', 'const p = import.meta\nfrom\n"./secret.csv"\nconst broken = ;', '<script src="app.js"></script>'],
    ['app.js', 'const element = <div>import("./secret.csv")</div>; const broken = ;', '<script src="app.js"></script>'],
    ['app.js', 'if (x) {} else {} <div>import("./secret.csv")</div>; const broken = ;', '<script src="app.js"></script>'],
    ['app.js', 'switch (x) {case 0: {} <div>import("./secret.csv")</div>;} const broken = ;', '<script src="app.js"></script>'],
    ['theme.css', 'body{content:"url(secret.csv);', '<link rel="stylesheet" href="theme.css">'],
  ])('does not turn unterminated strings or import.meta into references in %s', async (name, source, html) => {
    const { dir, root } = await fixture();
    await writeFile(path.join(dir, 'index.html'), html);
    await writeFile(path.join(dir, name), source);
    await writeFile(path.join(dir, 'secret.csv'), 'private-fixture-secret');
    expect((await deploy.buildDeployFileSet(root, 'p1', 'index.html')).map((file) => file.file).sort()).toEqual(['index.html', name].sort());
  });

  it.each(['/x/', '{}', 'n++'])('keeps real imports after division of %s', async (expression) => {
    const { dir, root } = await fixture();
    await writeFile(path.join(dir, 'index.html'), '<script src="app.js"></script>');
    await writeFile(path.join(dir, 'app.js'), `let n = 1; const v = ${expression} / 2; import "./leaf.js"; const end = /y/; const broken = ;`);
    await writeFile(path.join(dir, 'leaf.js'), 'export const value = 1;');
    expect((await deploy.buildDeployFileSet(root, 'p1', 'index.html')).map((file) => file.file).sort()).toEqual(['index.html', 'app.js', 'leaf.js'].sort());
  });

  it.each(['if (f() < limit) work()', 'const c = (value) < limit'])('keeps imports after an ordinary comparison: %s', async (source) => {
    const { dir, root } = await fixture();
    await writeFile(path.join(dir, 'index.html'), '<script src="app.js"></script>');
    await writeFile(path.join(dir, 'app.js'), `${source}; import "./leaf.js"; const broken = ;`);
    await writeFile(path.join(dir, 'leaf.js'), 'export const value = 1;');
    expect((await deploy.buildDeployFileSet(root, 'p1', 'index.html')).map((file) => file.file).sort()).toEqual(['index.html', 'app.js', 'leaf.js'].sort());
  });

  it.each(['', 'body{'])('excludes import conditions from CSS publication, including fallback %s', async (suffix) => {
    const { dir, root } = await fixture();
    await writeFile(path.join(dir, 'index.html'), '<link rel="stylesheet" href="theme.css">');
    await writeFile(path.join(dir, 'theme.css'), '@import "more.css" supports(background: url(secret.csv));' + suffix);
    await writeFile(path.join(dir, 'more.css'), 'body{color:red}');
    await writeFile(path.join(dir, 'secret.csv'), 'private-fixture-secret');
    expect((await deploy.buildDeployFileSet(root, 'p1', 'index.html')).map((file) => file.file).sort()).toEqual(['index.html', 'theme.css', 'more.css'].sort());
  });

  it('publishes unparsable inline code in a moved entry unchanged and warns that it was not relocated', async () => {
    const { dir, root } = await fixture();
    await mkdir(path.join(dir, 'pages'), { recursive: true });
    await writeFile(path.join(dir, 'pages', 'entry.html'), '<style>a::before{content:"url(logo.png)"} body{background:url(logo.png);</style>');
    await writeFile(path.join(dir, 'pages', 'logo.png'), 'public-logo');
    const publication = await deploy.prepareDeployPublication(root, 'p1', 'pages/entry.html');
    const html = Buffer.from(publication.files.find((file) => file.file === 'index.html')!.data).toString();
    expect(html).toContain('content:"url(logo.png)"');
    expect(publication.files.map((file) => file.file).sort()).toEqual(['index.html', 'pages/logo.png'].sort());
    expect(publication.warnings).toContainEqual(expect.objectContaining({ code: 'inline-reference-not-relocated', path: 'pages/entry.html' }));
  });

  it('skips an unclosed CSS URL while finding the next declaration', async () => {
    const { dir, root } = await fixture();
    await writeFile(path.join(dir, 'index.html'), '<link rel="stylesheet" href="theme.css">');
    await writeFile(path.join(dir, 'theme.css'), 'body{background:url(logo.png;} a{background:url(b.png)} body{');
    await writeFile(path.join(dir, 'b.png'), 'public-b');
    const publication = await deploy.prepareDeployPublication(root, 'p1', 'index.html');
    expect(publication.files.map((file) => file.file).sort()).toEqual(['index.html', 'theme.css', 'b.png'].sort());
    expect(publication.warnings).toContainEqual(expect.objectContaining({ code: 'reference-scan-fallback', path: 'theme.css' }));
  });

  it.each([
    ['app.js', 'import "./%2e%2e/secret.csv"; const broken = ;', '<script src="app.js"></script>'],
    ['theme.css', 'body{background:url(\\2e\\2e/secret.csv);', '<link rel="stylesheet" href="theme.css">'],
  ])('keeps traversal blocked during %s parser fallback', async (name, source, html) => {
    const { dir, root, request } = await fixture();
    await writeFile(path.join(root, 'secret.csv'), 'outside-private-fixture');
    await writeFile(path.join(dir, 'index.html'), html);
    await writeFile(path.join(dir, name), source);
    const provider = providerMock();
    expect((await request({ fileName: 'index.html' })).status).toBe(400);
    expect(provider.providerCalls).toEqual([]);
  });

  it('relocates a nested entry after skipping a malformed base and preserves valid dependencies', async () => {
    const { dir, root } = await fixture();
    await writeFile(path.join(dir, 'pages/entry.html'), '<base href="bad%/"><base href="unpublished/"><img src="logo.png"><a href="old.html">Old</a>');
    await writeFile(path.join(dir, 'pages/logo.png'), 'public-logo');
    const publication = await deploy.prepareDeployPublication(root, 'p1', 'pages/entry.html');
    expect(publication.files.map((file) => file.file)).toEqual(['index.html', 'pages/logo.png']);
    expect(publication.files[0]?.data.toString()).toContain('src="pages/logo.png"');
    expect(publication.files[0]?.data.toString()).not.toContain('<base');
    expect(publication.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'invalid-reference', url: 'bad%/' }), expect.objectContaining({ code: 'broken-reference', path: 'pages/old.html' })]));
    expect(() => deploy.resolveReferencedPath('bad%.png', '.')).toThrow(expect.objectContaining({ code: 'INVALID_PUBLICATION_PATH' }));
  });

  it('follows CSS image-set strings and escaped URL functions', async () => {
    const { dir, root } = await fixture();
    await writeFile(path.join(dir, 'pages/entry.html'), '<style>body{background:image-set("hero.png" 1x, url(large.png) 2x);--art:u\\72l(art.png)}</style>');
    for (const name of ['hero.png', 'large.png', 'art.png']) await writeFile(path.join(dir, 'pages', name), `public-${name}`);
    const files = await deploy.buildDeployFileSet(root, 'p1', 'pages/entry.html');
    expect(files.map((file) => file.file).sort()).toEqual(['index.html', 'pages/hero.png', 'pages/large.png', 'pages/art.png'].sort());
    const html = files[0]?.data.toString();
    expect(html).toContain('pages/hero.png');
    expect(html).toContain('pages/art.png');
  });

  it('does not turn JavaScript escapes into closing script tags during relocation', async () => {
    const { dir, root } = await fixture();
    await writeFile(path.join(dir, 'pages/entry.html'), '<script type="module">import "./app.js?value=\\u003c/script\\u003e";</script>');
    await writeFile(path.join(dir, 'pages/app.js'), 'export const value = 1;');
    const files = await deploy.buildDeployFileSet(root, 'p1', 'pages/entry.html');
    const html = files[0]?.data.toString() ?? '';
    expect(html.match(/<\/script>/g)).toHaveLength(1);
    expect(html).toContain('value=%3C/script%3E');
  });

  it.each(['?v=1', '#section'])('preserves resource resolution with a query/fragment base %s', async (base) => {
    const { dir, root } = await fixture();
    await writeFile(path.join(dir, 'pages/entry.html'), `<base href="${base}"><img src="logo.png"><a href="/">Home</a>`);
    await writeFile(path.join(dir, 'pages/logo.png'), 'public-logo');
    const files = await deploy.buildDeployFileSet(root, 'p1', 'pages/entry.html');
    expect(files.map((file) => file.file)).toEqual(['index.html', 'pages/logo.png']);
    expect(files[0]?.data.toString()).toContain('src="pages/logo.png"');
  });

  it('follows and relocates srcdoc dependencies while excluding the unused iframe src', async () => {
    const { dir, root } = await fixture();
    await writeFile(path.join(dir, 'pages/entry.html'), '<iframe src="notes.md" srcdoc="&lt;img src=&quot;logo.png&quot;&gt;"></iframe>');
    await writeFile(path.join(dir, 'pages/logo.png'), 'public-logo');
    await writeFile(path.join(dir, 'pages/notes.md'), 'private-fixture');
    const files = await deploy.buildDeployFileSet(root, 'p1', 'pages/entry.html');
    expect(files.map((file) => file.file)).toEqual(['index.html', 'pages/logo.png']);
    expect(files[0]?.data.toString()).toContain('src=&quot;pages/logo.png&quot;');
  });

  it('excludes inactive resource attributes on inputs, data scripts and links', async () => {
    const { dir, root } = await fixture();
    await writeFile(path.join(dir, 'index.html'), '<input type="text" src="keys.env"><script type="application/json" src="keys.env"></script><link rel="not-a-resource" href="keys.env"><source src="keys.env" srcset="keys.env"><track src="keys.env"><link rel="stylesheet" href="theme.css" imagesrcset="keys.env"><input type="image" src="logo.png">');
    await writeFile(path.join(dir, 'theme.css'), 'body{color:red}');
    await writeFile(path.join(dir, 'keys.env'), 'private-fixture');
    await writeFile(path.join(dir, 'logo.png'), 'public-logo');
    expect((await deploy.buildDeployFileSet(root, 'p1', 'index.html')).map((file) => file.file)).toEqual(['index.html', 'theme.css', 'logo.png']);
  });

  it('handles entity-decoded module types and whitespace-terminated CSS identifier escapes', async () => {
    const { dir, root } = await fixture();
    await writeFile(path.join(dir, 'pages/entry.html'), '<script type="mo&#100;ule">import "./app.js";</script><style>@\\69 mport "theme.css";body{background:u\\72 l("logo.png")}</style>');
    await writeFile(path.join(dir, 'pages/app.js'), 'export const value = 1;');
    await writeFile(path.join(dir, 'pages/theme.css'), 'body{color:red}');
    await writeFile(path.join(dir, 'pages/logo.png'), 'public-logo');
    const files = await deploy.buildDeployFileSet(root, 'p1', 'pages/entry.html');
    expect(files.map((file) => file.file).sort()).toEqual(['index.html', 'pages/app.js', 'pages/theme.css', 'pages/logo.png'].sort());
    expect(files[0]?.data.toString()).toContain('import "/pages/app.js";');
    expect(files[0]?.data.toString()).toContain('pages/logo.png');
  });
});
