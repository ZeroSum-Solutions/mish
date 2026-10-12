import express from 'express';
import type { Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { registerPluginAssetRoutes } from '../src/routes/plugins/assets.js';

const folders = [
  'acreage-farming', 'aerocore', 'ai-designer-portfolio', 'cinematic-landing-page',
  'codenest-coding-platform', 'dreamcore-landing', 'evergreen-finance', 'innovation',
];
const root = path.resolve(import.meta.dirname, '../../../plugins/_official/examples');
let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  registerPluginAssetRoutes(app, {
    db: {} as never,
    getWorkspacePlugin: async (_db, id) => {
      const folder = folders.find((candidate) => id === `example-${candidate}`);
      if (!folder) return null;
      const fsPath = path.join(root, folder);
      return { fsPath, manifest: JSON.parse(await readFile(path.join(fsPath, 'open-design.json'), 'utf8')) };
    },
    pluginAssetCache: { get: async () => { throw new Error('Owned previews must not fetch remote assets'); } },
    AssetCacheError: class extends Error {
      status = 502;
      constructor(...args: unknown[]) {
        super(String(args[0] ?? 'asset cache error'));
      }
    },
    assetCacheRewriteUrl: (url) => url,
    isCacheableExternalUrl: () => false,
    assembleExample: (template) => template,
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing preview test port');
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
});

it.each(folders)('serves %s as HTML with working package-local fonts', async (folder) => {
  const prefix = `/api/plugins/example-${folder}`;
  const response = await fetch(`${base}${prefix}/preview`);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/html');
  expect(response.headers.get('content-security-policy')).toContain("connect-src 'none'");
  const html = await response.text();
  const stylesheetPath = `${prefix}/asset/fonts.css`;
  expect(html).toContain(stylesheetPath);
  const stylesheetResponse = await fetch(`${base}${stylesheetPath}`);
  expect(stylesheetResponse.status).toBe(200);
  expect(stylesheetResponse.headers.get('content-type')).toContain('text/css');
  const stylesheet = await stylesheetResponse.text();
  for (const name of ['archivo', 'bodoni', 'plex']) {
    const assetPath = `${prefix}/asset/assets/${name}.woff2`;
    expect(stylesheet).toContain(`url('./assets/${name}.woff2')`);
    expect(new URL(`./assets/${name}.woff2`, `${base}${stylesheetPath}`).pathname).toBe(assetPath);
    const fontResponse = await fetch(`${base}${assetPath}`);
    expect(fontResponse.status).toBe(200);
    const supplied = Buffer.from(await fontResponse.arrayBuffer());
    expect(supplied).toEqual(await readFile(path.join(root, folder, 'assets', `${name}.woff2`)));
  }
});
