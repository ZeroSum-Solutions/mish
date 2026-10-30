// Route coverage for /api/linkpages*. Bare-Express harness like motionsites-routes.test.ts: the real
// service and store (in a temp folder) with a fake network, no model and a fake Composio login, so
// no request leaves the machine and no personal data is involved.

import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { LinkPageSpec } from '@mish/contracts';
import type { PageSpec } from '@mish/linkpage';
import { sendApiError } from '../src/http/api-errors.js';
import type { LinkPageLoginProvider } from '../src/linkpage/login.js';
import { createLinkPageService } from '../src/linkpage/service.js';
import { createLinkPageStore } from '../src/linkpage/store.js';
import { registerLinkPageRoutes } from '../src/routes/linkpage.js';

// The contract's spec and the engine's spec must stay assignable both ways.
const _contractToEngine = (spec: LinkPageSpec): PageSpec => spec;
const _engineToContract = (spec: PageSpec): LinkPageSpec => spec;
void _contractToEngine;
void _engineToContract;

const SITE = `<html><head><title>Studio</title><meta property="og:site_name" content="Studio Name"/>
<meta name="description" content="Hand made."/><link rel="stylesheet" href="/s.css"/></head>
<body><a href="https://www.instagram.com/studio">ig</a></body></html>`;
const CSS = 'body{background:#fcfbf9;color:#000;font-family:"Cormorant Garamond",Georgia,serif}a{color:#bf9b5d}';

const fakeFetch = (async (input: Parameters<typeof fetch>[0]) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const bodies: Record<string, string> = {
    'https://studio.example.com/': SITE,
    'https://studio.example.com': SITE,
    'https://studio.example.com/s.css': CSS,
  };
  const body = bodies[url];
  return body === undefined ? new Response('missing', { status: 404 }) : new Response(body, { status: 200 });
}) as typeof fetch;

let server: http.Server;
let baseUrl: string;
let dataDir: string;
let proxied: Array<{ account: string; endpoint: string }>;

function loginProvider(): LinkPageLoginProvider {
  return {
    getDefinition: async (id) => ({ id } as never),
    proxyRequest: async (_definition, account, request) => {
      proxied.push({ account, endpoint: request.endpoint });
      const data = request.endpoint.includes('/me/media')
        ? { data: [{ caption: 'Fresh glaze', permalink: 'https://www.instagram.com/p/abc/', timestamp: '2026-10-01T00:00:00Z' }] }
        : { username: 'studio', name: 'Studio Real', biography: 'Pots and bowls', followers_count: 12 };
      return { status: 200, data };
    },
  };
}

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'od-linkpage-routes-'));
  proxied = [];
  const app = express();
  app.use(express.json());
  registerLinkPageRoutes(app, {
    http: { sendApiError } as never,
    linkpage: createLinkPageService({
      store: createLinkPageStore(dataDir),
      fetch: fakeFetch,
      resolveLlm: () => undefined,
      login: loginProvider(),
    }),
  });
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dataDir, { recursive: true, force: true });
});

const post = (url: string, body: unknown, method = 'POST') =>
  fetch(`${baseUrl}${url}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const BUILD = { slug: 'studio', sources: [{ connector: 'website', ref: 'https://studio.example.com' }] };

async function build(extra: Record<string, unknown> = {}) {
  const res = await post('/api/linkpages/build', { ...BUILD, ...extra });
  return { res, body: (await res.json()) as any };
}

describe('POST /api/linkpages/build', () => {
  it('builds from the fake site, saves the page and says no model was used', async () => {
    const { res, body } = await build({ options: { links: [{ label: 'Shop', url: 'https://example.com/shop', featured: true }] } });
    expect(res.status).toBe(200);
    expect(body.saved).toBe(true);
    expect(body.spec.slug).toBe('studio');
    expect(body.spec.profile.name).toBe('Studio Name');
    expect(body.spec.blocks.some((b: any) => b.type === 'link' && b.label === 'Shop')).toBe(true);
    expect(body.warnings.join(' ')).toMatch(/no model is available/);
    const stored = JSON.parse(await readFile(path.join(dataDir, 'linkpages', 'studio', 'page.json'), 'utf8'));
    expect(stored.spec.slug).toBe('studio');
  });

  it('does not save when asked not to', async () => {
    const { body } = await build({ save: false });
    expect(body.saved).toBe(false);
    expect(((await (await fetch(`${baseUrl}/api/linkpages`)).json()) as any).pages).toEqual([]);
  });

  it.each([
    ['a bad slug', { slug: '../x' }],
    ['no sources', { sources: [] }],
    ['a non-http website', { sources: [{ connector: 'website', ref: 'file:///etc/passwd' }] }],
    ['css in a colour', { options: { theme: { palette: { bg: 'red;}</style>' } } } }],
  ])('refuses %s with 400', async (_name, patch) => {
    const { res, body } = await build(patch);
    expect(res.status).toBe(400);
    expect(body.error.code).toBe('BAD_REQUEST');
  });

  it('answers 502 when nothing can be read', async () => {
    const { res, body } = await build({ sources: [{ connector: 'website', ref: 'https://gone.example.com' }] });
    expect(res.status).toBe(502);
    expect(body.error.code).toBe('UPSTREAM_UNAVAILABLE');
  });

  it('reads a platform through the creator login and remembers only the account id', async () => {
    const { res, body } = await build({
      sources: [{ connector: 'instagram', ref: '@studio' }],
      connectedAccounts: { instagram: 'ca_test123' },
    });
    expect(res.status).toBe(200);
    expect(proxied.map((p) => p.account)).toEqual(['ca_test123', 'ca_test123']);
    expect(proxied[0]!.endpoint).toMatch(/^https:\/\/graph\.instagram\.com\//);
    expect(body.needs).toEqual([]);
    expect(body.spec.profile.name).toBe('Studio Real');
    const got = (await (await fetch(`${baseUrl}/api/linkpages/studio`)).json()) as any;
    expect(got.page.connectedAccounts).toEqual({ instagram: 'ca_test123' });
  });

  it('reads as a visitor and asks for a login when no account is connected', async () => {
    const { body } = await build({ sources: [{ connector: 'website', ref: 'https://studio.example.com' }, { connector: 'instagram', ref: '@studio' }] });
    expect(proxied).toEqual([]);
    // The fake network has no Instagram page, so the platform is skipped and reported.
    expect(body.warnings.join(' ')).toMatch(/instagram/);
  });
});

describe('saved pages', () => {
  it('lists, gets, replaces and deletes a page', async () => {
    await build();
    const list = (await (await fetch(`${baseUrl}/api/linkpages`)).json()) as any;
    expect(list.pages.map((p: any) => p.slug)).toEqual(['studio']);

    const got = (await (await fetch(`${baseUrl}/api/linkpages/studio`)).json()) as any;
    const spec = { ...got.page.spec, profile: { ...got.page.spec.profile, name: 'Renamed' } };
    const put = await post('/api/linkpages/studio', { spec }, 'PUT');
    expect(put.status).toBe(200);
    expect(((await put.json()) as any).page.spec.profile.name).toBe('Renamed');

    const del = await fetch(`${baseUrl}/api/linkpages/studio`, { method: 'DELETE' });
    expect(await del.json()).toEqual({ slug: 'studio', deleted: true });
    expect((await fetch(`${baseUrl}/api/linkpages/studio`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/api/linkpages/studio`, { method: 'DELETE' })).status).toBe(404);
  });

  it('refuses a spec whose slug differs from the address, and a theme that could escape the stylesheet', async () => {
    await build();
    const got = (await (await fetch(`${baseUrl}/api/linkpages/studio`)).json()) as any;
    const other = await post('/api/linkpages/other', { spec: got.page.spec }, 'PUT');
    expect(other.status).toBe(400);
    const evil = { ...got.page.spec, theme: { ...got.page.spec.theme, palette: { ...got.page.spec.theme.palette, bg: '#fff;}</style><script>x</script>' } } };
    expect((await post('/api/linkpages/studio', { spec: evil }, 'PUT')).status).toBe(400);
  });

  it('refuses slugs that are not slugs, including encoded path escapes', async () => {
    for (const slug of ['Bad', '%2e%2e', '..%2f..%2fetc', 'a%2fb']) {
      const res = await fetch(`${baseUrl}/api/linkpages/${slug}`);
      expect([400, 404]).toContain(res.status);
      expect((await fetch(`${baseUrl}/api/linkpages/${slug}`, { method: 'DELETE' })).status).not.toBe(200);
    }
  });
});

describe('render and export', () => {
  it('renders the page as HTML in a sandbox with machine files linked', async () => {
    await build();
    const res = await fetch(`${baseUrl}/api/linkpages/studio/render?origin=https://links.example.com`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    expect(res.headers.get('content-security-policy')).toMatch(/^sandbox /);
    const html = await res.text();
    expect(html).toContain('Studio Name');
    expect(html).toContain('llms.txt');
    expect(html).toContain('https://links.example.com/studio');
  });

  it('refuses a render origin that is not an http(s) address', async () => {
    await build();
    expect((await fetch(`${baseUrl}/api/linkpages/studio/render?origin=javascript:alert(1)`)).status).toBe(400);
    expect((await fetch(`${baseUrl}/api/linkpages/studio/export?origin=ftp://x`)).status).toBe(400);
  });

  it('does not render a stored page whose theme was edited by hand into something unsafe', async () => {
    await build();
    const file = path.join(dataDir, 'linkpages', 'studio', 'page.json');
    const record = JSON.parse(await readFile(file, 'utf8'));
    record.spec.theme.palette.bg = '#fff;}</style><script>alert(1)</script>';
    await writeFile(file, JSON.stringify(record));
    expect((await fetch(`${baseUrl}/api/linkpages/studio/render`)).status).toBe(400);
  });

  it('exports index.html, llms.txt, links.json, spec.json and the page assets', async () => {
    await build();
    await mkdir(path.join(dataDir, 'linkpages', 'studio', 'assets'), { recursive: true });
    await writeFile(path.join(dataDir, 'linkpages', 'studio', 'assets', 'avatar.png'), Buffer.from([1, 2, 3]));
    const body = (await (await fetch(`${baseUrl}/api/linkpages/studio/export`)).json()) as any;
    expect(body.slug).toBe('studio');
    expect(body.files.map((f: any) => f.path)).toEqual(['index.html', 'llms.txt', 'links.json', 'spec.json', 'assets/avatar.png']);
    const byPath = Object.fromEntries(body.files.map((f: any) => [f.path, f]));
    expect(byPath['index.html'].content).toMatch(/^<!doctype html>/i);
    expect(JSON.parse(byPath['links.json'].content).name).toBe('Studio Name');
    expect(byPath['llms.txt'].content).toContain('Studio Name');
    expect(byPath['assets/avatar.png']).toMatchObject({ encoding: 'base64', contentType: 'image/png', content: 'AQID' });
  });

  it('answers 404 for a page that does not exist', async () => {
    expect((await fetch(`${baseUrl}/api/linkpages/nope/render`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/api/linkpages/nope/export`)).status).toBe(404);
  });
});
