import express from 'express';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { registerPluginAssetRoutes } from '../src/routes/plugins/assets.js';

function directives(response: Response): Map<string, string> {
  const policy = response.headers.get('content-security-policy');
  expect(policy).toBeTruthy();
  return new Map(policy!.split(';').map((part) => {
    const [name, ...sources] = part.trim().split(/\s+/);
    return [name ?? '', sources.join(' ')];
  }));
}

it('serves plugin previews and assets with local fonts and data images but no remote script or connect', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'od-plugin-csp-'));
  const app = express();
  await writeFile(path.join(root, 'preview.html'), '<img src="data:image/png;base64,iVBORw0KGgo=" />');
  await writeFile(path.join(root, 'font.woff2'), 'font bytes');
  registerPluginAssetRoutes(app, {
    db: {} as never,
    getWorkspacePlugin: async () => ({
      fsPath: root,
      manifest: { od: { preview: { entry: 'preview.html' } } },
    }),
    pluginAssetCache: { get: async () => { throw new Error('unused'); } },
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

  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing server port');
    const base = `http://127.0.0.1:${address.port}/api/plugins/example`;
    for (const url of [`${base}/preview`, `${base}/asset/font.woff2`]) {
      const response = await fetch(url);
      expect(response.status).toBe(200);
      const csp = directives(response);
      expect(csp.get('font-src')).toBe("'self' data:");
      expect(csp.get('img-src')?.split(' ')).toContain('data:');
      expect(csp.get('script-src')).toBe("'self' 'unsafe-inline'");
      expect(csp.get('connect-src')).toBe("'none'");
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

it('echoes Access-Control-Allow-Origin: null only for a bundled official plugin font, not a non-font asset or a user plugin font', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'od-plugin-font-cors-'));
  await writeFile(path.join(root, 'font.woff2'), 'font bytes');
  await writeFile(path.join(root, 'styles.css'), 'body { color: red; }');
  const app = express();
  registerPluginAssetRoutes(app, {
    db: {} as never,
    getWorkspacePlugin: async (_db, id) => ({
      fsPath: root,
      sourceKind: id === 'official' ? 'bundled' : 'user',
      manifest: { od: { preview: { entry: 'preview.html' } } },
    }),
    pluginAssetCache: { get: async () => { throw new Error('unused'); } },
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

  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing server port');
    const base = `http://127.0.0.1:${address.port}/api/plugins/official`;

    // A sandboxed plugin preview iframe (no `allow-same-origin`) fetches the
    // font with an opaque `Origin: null`; the response must echo it back so
    // the browser's CORS check (separate from CSP's font-src) lets the bytes
    // through.
    const fontResponse = await fetch(`${base}/asset/font.woff2`, { headers: { Origin: 'null' } });
    expect(fontResponse.status).toBe(200);
    expect(fontResponse.headers.get('content-type')).toBe('font/woff2');
    expect(fontResponse.headers.get('access-control-allow-origin')).toBe('null');
    expect(fontResponse.headers.get('vary')).toBe('Origin');

    // A non-font asset requested the same way must not get the header: the
    // allowance is scoped to font MIME types/extensions only.
    const cssResponse = await fetch(`${base}/asset/styles.css`, { headers: { Origin: 'null' } });
    expect(cssResponse.status).toBe(200);
    expect(cssResponse.headers.get('content-type')).toBe('text/css; charset=utf-8');
    expect(cssResponse.headers.get('access-control-allow-origin')).toBeNull();

    // A font request from a real (non-opaque) origin gets no CORS header
    // either: same-origin callers need none, and the allowance only answers
    // the opaque-origin sandboxed-preview case.
    const fontSameOrigin = await fetch(`${base}/asset/font.woff2`, { headers: { Origin: 'http://127.0.0.1:18902' } });
    expect(fontSameOrigin.status).toBe(200);
    expect(fontSameOrigin.headers.get('access-control-allow-origin')).toBeNull();

    // A user/workspace plugin may bundle a licensed font: no echo, so the
    // browser keeps the bytes from an opaque-origin document.
    const userFont = await fetch(`http://127.0.0.1:${address.port}/api/plugins/someone/asset/font.woff2`, { headers: { Origin: 'null' } });
    // The route itself refuses an opaque-origin read of any plugin it resolves
    // that is not bundled, so a team plugin shadowing a bundled id (which the
    // id-only /api guard admits) still never serves its bytes to Origin: null.
    expect(userFont.status).toBe(403);
    expect(userFont.headers.get('access-control-allow-origin')).toBeNull();
    const userFontSameOrigin = await fetch(`http://127.0.0.1:${address.port}/api/plugins/someone/asset/font.woff2`);
    expect(userFontSameOrigin.status).toBe(200);
    expect(userFontSameOrigin.headers.get('content-type')).toBe('font/woff2');

    // Prototype property names are not extensions in the lookup table.
    await writeFile(path.join(root, 'x.constructor'), 'x');
    const proto = await fetch(`${base}/asset/x.constructor`, { headers: { Origin: 'null' } });
    expect(proto.headers.get('content-type')).toBe('application/octet-stream');
    expect(proto.headers.get('access-control-allow-origin')).toBeNull();
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
