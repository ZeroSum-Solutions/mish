// Asset upload, publish and event ingestion for /api/linkpages/:slug/*. Same bare-Express harness as
// linkpage-routes.test.ts: real service and store in a temp folder, no network.

import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { sendApiError } from '../src/http/api-errors.js';
import { recordLinkPageEvent } from '../src/linkpage/events.js';
import { createLinkPageService } from '../src/linkpage/service.js';
import { createLinkPageStore } from '../src/linkpage/store.js';
import { registerLinkPageRoutes } from '../src/routes/linkpage.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]);
const SITE = '<html><head><title>Studio</title></head><body></body></html>';

let server: http.Server;
let baseUrl: string;
let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'od-linkpage-assets-'));
  const app = express();
  app.use(express.json());
  registerLinkPageRoutes(app, {
    http: { sendApiError } as never,
    linkpage: createLinkPageService({
      store: createLinkPageStore(dataDir),
      fetch: (async () => new Response(SITE, { status: 200 })) as typeof fetch,
      resolveLlm: () => undefined,
      now: () => '2026-10-30T12:00:00.000Z',
    }),
  });
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const res = await fetch(`${baseUrl}/api/linkpages/build`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ slug: 'studio', sources: [{ connector: 'website', ref: 'https://studio.example.com' }] }),
  });
  expect(res.status).toBe(200);
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dataDir, { recursive: true, force: true });
});

const putAsset = (name: string, body: Buffer, type = 'image/png', slug = 'studio') =>
  fetch(`${baseUrl}/api/linkpages/${slug}/assets/${name}`, { method: 'PUT', headers: { 'content-type': type }, body: new Uint8Array(body) });
const postJson = (url: string, body: unknown) =>
  fetch(`${baseUrl}${url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('asset upload', () => {
  it('stores a picture, serves it back and exports it', async () => {
    const res = await putAsset('avatar.png', PNG);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ slug: 'studio', name: 'avatar.png', path: 'assets/avatar.png', contentType: 'image/png', bytes: PNG.length });
    const got = await fetch(`${baseUrl}/api/linkpages/studio/assets/avatar.png`);
    expect(got.headers.get('content-type')).toMatch(/image\/png/);
    expect(got.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await got.arrayBuffer())).toEqual(PNG);
    const exported = (await (await fetch(`${baseUrl}/api/linkpages/studio/export`)).json()) as any;
    expect(exported.files.map((f: any) => f.path)).toContain('assets/avatar.png');
  });

  it('refuses svg, a type that lies, a wrong extension, a bad name and an empty body', async () => {
    expect((await putAsset('x.svg', Buffer.from('<svg onload=alert(1)/>'), 'image/svg+xml')).status).toBe(400);
    expect((await putAsset('x.png', Buffer.from('<html>'), 'image/png')).status).toBe(415);
    expect((await putAsset('x.png', JPEG, 'image/png')).status).toBe(415);
    expect((await putAsset('x.jpg', PNG, 'image/png')).status).toBe(400);
    expect((await putAsset('x.png', PNG, 'text/html')).status).toBe(415);
    expect((await putAsset('x.png', Buffer.alloc(0))).status).toBe(400);
    expect((await putAsset('.hidden.png', PNG)).status).toBe(400);
    expect((await putAsset('..%2Fx.png', PNG)).status).toBe(400);
    expect((await putAsset('x.png', PNG, 'image/png', 'Bad_Slug')).status).toBe(400);
  });

  it('refuses a picture over 2 MB with 413', async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]);
    expect((await putAsset('big.png', big)).status).toBe(413);
  });

  it('answers 404 for a picture that is not there', async () => {
    expect((await fetch(`${baseUrl}/api/linkpages/studio/assets/none.png`)).status).toBe(404);
  });
});

describe('publish', () => {
  it('lists the files ready to deploy under the origin and says nothing was published', async () => {
    await putAsset('avatar.png', PNG);
    const res = await postJson('/api/linkpages/studio/publish', { origin: 'https://links.example.com/ignored', trackBase: 'https://t.example.com/go' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      slug: 'studio',
      published: false,
      url: 'https://links.example.com/studio',
      files: ['index.html', 'llms.txt', 'links.json', 'spec.json', 'assets/avatar.png'],
      publishedAt: '2026-10-30T12:00:00.000Z',
    });
  });

  it('works with no body, and refuses a bad origin or a missing page', async () => {
    const plain = await fetch(`${baseUrl}/api/linkpages/studio/publish`, { method: 'POST' });
    expect(plain.status).toBe(200);
    expect(((await plain.json()) as any).url).toBeUndefined();
    expect((await postJson('/api/linkpages/studio/publish', { origin: 'javascript:alert(1)' })).status).toBe(400);
    expect((await postJson('/api/linkpages/nope/publish', {})).status).toBe(404);
  });
});

describe('events', () => {
  const log = async () => (await readFile(path.join(dataDir, 'linkpages', 'studio', 'events.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));

  it('appends a view, a click and a signup to the local log, taking the slug from the address', async () => {
    expect(await (await postJson('/api/linkpages/studio/events', { kind: 'view', slug: 'other' })).json()).toEqual({ ok: true, stored: true });
    await postJson('/api/linkpages/studio/events', { kind: 'click', block: 'link-1', index: 2 });
    await postJson('/api/linkpages/studio/events', { kind: 'signup', email: ' Sam@Example.com ', website: '', page: '/studio' });
    const events = await log();
    expect(events).toEqual([
      { kind: 'view', slug: 'studio', at: '2026-10-30T12:00:00.000Z' },
      { kind: 'click', slug: 'studio', block: 'link-1', index: 2, at: '2026-10-30T12:00:00.000Z' },
      { kind: 'signup', slug: 'studio', email: 'sam@example.com', at: '2026-10-30T12:00:00.000Z' },
    ]);
  });

  it('answers success but stores nothing when the honeypot is filled', async () => {
    const res = await postJson('/api/linkpages/studio/events', { kind: 'signup', email: 'bot@example.com', website: 'http://spam.example' });
    expect(await res.json()).toEqual({ ok: true, stored: false });
    await expect(readFile(path.join(dataDir, 'linkpages', 'studio', 'events.jsonl'), 'utf8')).rejects.toThrow();
  });

  it('refuses a bad email, a bad click, an unknown kind and a missing page', async () => {
    expect((await postJson('/api/linkpages/studio/events', { kind: 'signup', email: 'nope' })).status).toBe(400);
    expect((await postJson('/api/linkpages/studio/events', { kind: 'click', block: '../x', index: 0 })).status).toBe(400);
    expect((await postJson('/api/linkpages/studio/events', { kind: 'purge' })).status).toBe(400);
    expect((await postJson('/api/linkpages/studio/events', [1])).status).toBe(400);
    expect((await postJson('/api/linkpages/nope/events', { kind: 'view' })).status).toBe(404);
  });
});

describe('recordLinkPageEvent', () => {
  it('stops appending when the log is full', async () => {
    const store = { appendEvent: async () => false };
    expect(await recordLinkPageEvent(store, 'studio', { kind: 'view' })).toEqual({ ok: true, response: { ok: true, stored: false } });
  });
});

describe('connected accounts resolved by Mish', () => {
  let n = 0;
  const build = async (resolve: (c: string) => string | undefined, connectedAccounts?: Record<string, string>) => {
    const proxied: string[] = [];
    const slug = `ig-${n++}`;
    const service = createLinkPageService({
      store: createLinkPageStore(dataDir),
      fetch: (async () => new Response('missing', { status: 404 })) as typeof fetch,
      resolveLlm: () => undefined,
      login: {
        getDefinition: async (id) => ({ id } as never),
        proxyRequest: async (_d, account) => {
          proxied.push(account);
          return { status: 200, data: { username: 'studio', name: 'Studio Real', biography: 'Pots' } };
        },
      },
      resolveConnectedAccount: resolve as never,
    });
    // With no login the fake network has nothing to read, so the build is refused; that is the point.
    await service.build({ slug, sources: [{ connector: 'instagram', ref: '@studio' }], ...(connectedAccounts ? { connectedAccounts } : {}) }).catch(() => undefined);
    return { proxied, record: await service.get(slug).catch(() => null) };
  };

  it('uses the account connected in Mish when the request names none', async () => {
    const { proxied, record } = await build(() => 'ca_auto');
    expect(proxied[0]).toBe('ca_auto');
    expect(record?.connectedAccounts).toEqual({ instagram: 'ca_auto' });
  });

  it('does not use it when the request opts out with {} or names its own, and ignores an id that is not an id', async () => {
    expect((await build(() => 'ca_auto', {})).proxied).toEqual([]);
    expect((await build(() => 'ca_auto', { instagram: 'ca_own' })).proxied[0]).toBe('ca_own');
    expect((await build(() => 'bad id!')).proxied).toEqual([]);
  });
});
