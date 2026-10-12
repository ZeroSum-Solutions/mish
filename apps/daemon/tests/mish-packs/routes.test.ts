// Mish packs over HTTP: install, list and remove; the existing catalogue routes before and after a
// pack is installed; GenUI overlay; style-picker assets; the write guards.

import { promises as fsp } from 'node:fs';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseCultCatalogListResponse } from '@mish/contracts';
import type { MishPackInstallResponse, MishPacksListResponse } from '@mish/contracts';

import { resetMishPacksForTests } from '../../src/mish-packs/overlay.js';
import { createMishPackStore } from '../../src/mish-packs/store.js';
import { registerCultCatalogRoutes } from '../../src/routes/cult-catalog.js';
import { registerGenuiCatalogRoutes } from '../../src/routes/genui-catalog.js';
import { MISH_PACK_UPLOAD_HEADER, registerMishPackRoutes } from '../../src/routes/mish-packs.js';
import { cleanupDirs, tempDir, writeFile, writeFixturePack, zipFolder } from './pack-fixture.js';

let server: http.Server;
let base: string;
let dataDir: string;

function sendApiError(res: express.Response, status: number, code: string, message: string) {
  res.status(status).json({ error: { code, message } });
}

beforeEach(async () => {
  dataDir = tempDir('mish-data-');
  const store = createMishPackStore({
    dataDir,
    userRoots: { skills: path.join(dataDir, 'skills'), designSystems: path.join(dataDir, 'design-systems') },
    env: {},
  });
  await store.start();
  const app = express();
  app.use(express.json());
  const http = { sendApiError, requireLocalDaemonRequest: (_req: express.Request, _res: express.Response, next: () => void) => next() };
  registerMishPackRoutes(app, { http, packs: store, uploadDir: path.join(dataDir, 'uploads') } as never);
  registerCultCatalogRoutes(app, { http } as never);
  registerGenuiCatalogRoutes(app);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  resetMishPacksForTests();
  await Promise.all(cleanupDirs.splice(0).map((dir) => fsp.rm(dir, { recursive: true, force: true })));
});

async function installJson(source: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}/api/mish-packs/install`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ source }) });
}

describe('/api/mish-packs', () => {
  it('lists nothing, installs a folder, lists it, then removes it', async () => {
    expect(((await (await fetch(`${base}/api/mish-packs`)).json()) as MishPacksListResponse).packs).toEqual([]);
    const source = tempDir('mish-src-');
    writeFixturePack(source);
    const installed = await installJson(source);
    expect(installed.status).toBe(200);
    expect(((await installed.json()) as MishPackInstallResponse).pack.id).toBe('team-kit');
    const listed = (await (await fetch(`${base}/api/mish-packs`)).json()) as MishPacksListResponse;
    expect(listed.packs.map((pack) => pack.id)).toEqual(['team-kit']);
    expect(JSON.stringify(listed)).not.toContain(source);
    const removed = await fetch(`${base}/api/mish-packs/team-kit`, { method: 'DELETE' });
    expect(removed.status).toBe(200);
    expect(((await (await fetch(`${base}/api/mish-packs`)).json()) as MishPacksListResponse).packs).toEqual([]);
    expect((await fetch(`${base}/api/mish-packs/team-kit`, { method: 'DELETE' })).status).toBe(404);
  });

  it('answers errors with a code and a status', async () => {
    const missing = await installJson(path.join(dataDir, 'nope'));
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe('SOURCE_NOT_FOUND');
    const bad = await fetch(`${base}/api/mish-packs/install`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(bad.status).toBe(400);
    const noManifest = tempDir('mish-src-');
    writeFile(noManifest, 'a.txt', 'x');
    const refused = await installJson(noManifest);
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe('INVALID_MANIFEST');
  });

  it('refuses a write from another site, and an upload without the custom header', async () => {
    const source = tempDir('mish-src-');
    writeFixturePack(source);
    expect((await installJson(source, { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await fetch(`${base}/api/mish-packs/team-kit`, { method: 'DELETE', headers: { 'sec-fetch-site': 'same-site' } })).status).toBe(403);
    const form = new FormData();
    form.set('file', new Blob([Buffer.from('x')]), 'pack.zip');
    expect((await fetch(`${base}/api/mish-packs/install`, { method: 'POST', body: form })).status).toBe(403);
  });

  it('installs an uploaded .zip and cleans the upload folder', async () => {
    const source = tempDir('mish-src-');
    writeFixturePack(source);
    const zipFile = path.join(tempDir('mish-zip-'), 'packet.zip');
    await zipFolder(source, zipFile);
    const form = new FormData();
    form.set('file', new Blob([await fsp.readFile(zipFile)]), 'packet.zip');
    const response = await fetch(`${base}/api/mish-packs/install`, { method: 'POST', headers: { [MISH_PACK_UPLOAD_HEADER]: '1' }, body: form });
    expect(response.status).toBe(200);
    expect(((await response.json()) as MishPackInstallResponse).pack.id).toBe('team-kit');
    const leftovers = await fsp.readdir(path.join(dataDir, 'uploads')).catch(() => []);
    expect(leftovers).toEqual([]);
  });

  it('rejects an upload that is not a zip', async () => {
    const form = new FormData();
    form.set('file', new Blob([Buffer.from('not a zip')]), 'packet.zip');
    const response = await fetch(`${base}/api/mish-packs/install`, { method: 'POST', headers: { [MISH_PACK_UPLOAD_HEADER]: '1' }, body: form });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('INVALID_ARCHIVE');
  });
});

describe('existing routes read the pack', () => {
  it('the Cult catalogue is empty, then shows the pack row, then is empty again', async () => {
    const list = async () => parseCultCatalogListResponse(await (await fetch(`${base}/api/cult/catalog`)).json());
    expect((await list()).catalog.items).toEqual([]);
    const source = tempDir('mish-src-');
    writeFixturePack(source);
    expect((await installJson(source)).status).toBe(200);
    const body = await list();
    expect(body.catalog.items.map((item) => item.id)).toEqual(['cult:hero-series-pack']);
    const one = await fetch(`${base}/api/cult/catalog/${encodeURIComponent('cult:hero-series-pack')}`);
    expect(one.status).toBe(200);
    await fetch(`${base}/api/mish-packs/team-kit`, { method: 'DELETE' });
    expect((await list()).catalog.items).toEqual([]);
  });

  it('GenUI lists the pack components and serves their demo; the bundled list stays', async () => {
    const before = ((await (await fetch(`${base}/api/genui/catalog`)).json()) as { catalog: { components: Array<{ id: string }> } }).catalog.components;
    const source = tempDir('mish-src-');
    writeFixturePack(source, { provides: { catalogs: { genui: 'genui' } } });
    writeFile(source, 'genui/overlay.json', JSON.stringify({ entries: [{ id: 'pack-card', name: 'Pack card', status: 'ported' }, { id: before[0]!.id, name: 'Clash' }] }));
    writeFile(source, 'genui/demos/pack-card.html', '<!doctype html><title>demo</title>');
    expect((await installJson(source)).status).toBe(200);
    const after = ((await (await fetch(`${base}/api/genui/catalog`)).json()) as { catalog: { components: Array<{ id: string; name: string }> } }).catalog.components;
    expect(after.map((entry) => entry.id)).toEqual([...before.map((entry) => entry.id), 'pack-card']);
    expect(after.find((entry) => entry.id === before[0]!.id)?.name).not.toBe('Clash');
    const demo = await fetch(`${base}/api/genui/catalog/pack-card/preview`);
    expect(demo.status).toBe(200);
    expect(await demo.text()).toContain('<title>demo</title>');
    expect((await fetch(`${base}/api/genui/catalog/..%2Fpack-card/preview`)).status).toBe(404);
  });
});

describe('style-picker assets', () => {
  it('serves preview images a pack provides, through the CDN prefix too, and nothing else', async () => {
    expect(((await (await fetch(`${base}/api/mish-packs/runtime`)).json()) as { styleCatalogPath: string | null }).styleCatalogPath).toBeNull();
    const source = tempDir('mish-src-');
    writeFixturePack(source, { provides: { assets: { styleCatalog: 'styles' } } });
    writeFile(source, 'styles/editorial.webp', Buffer.from('RIFFxxxxWEBP'));
    writeFile(source, 'styles/notes.txt', 'private');
    expect((await installJson(source)).status).toBe(200);
    expect(((await (await fetch(`${base}/api/mish-packs/runtime`)).json()) as { styleCatalogPath: string | null }).styleCatalogPath).toBe('/api/mish-packs/assets');
    const image = await fetch(`${base}/api/mish-packs/assets/style-catalog/v1/editorial.webp`);
    expect(image.status).toBe(200);
    expect(image.headers.get('content-type')).toBe('image/webp');
    const transformed = await fetch(`${base}/api/mish-packs/assets/cdn-cgi/image/width=640,quality=75,format=auto/style-catalog/v1/editorial.webp`);
    expect(transformed.status).toBe(200);
    expect((await fetch(`${base}/api/mish-packs/assets/style-catalog/v1/notes.txt`)).status).toBe(404);
    expect((await fetch(`${base}/api/mish-packs/assets/style-catalog/v1/..%2Fmish-pack.json`)).status).toBe(404);
    expect((await fetch(`${base}/api/mish-packs/assets/other/editorial.webp`)).status).toBe(404);
  });
});
