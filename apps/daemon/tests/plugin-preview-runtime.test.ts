import express from 'express';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';
import { registerPluginAssetRoutes } from '../src/routes/plugins/assets.js';

async function withPreview(root: string, entry: string, check: (base: string) => Promise<void>) {
  const app = express();
  registerPluginAssetRoutes(app, {
    db: {} as never,
    getWorkspacePlugin: async () => ({ fsPath: root, sourceKind: 'bundled', manifest: { od: { preview: { entry } } } }),
    pluginAssetCache: { get: async () => { throw new Error('unused'); } },
    AssetCacheError: class extends Error {
      status = 502;
      constructor(...args: unknown[]) { super(String(args[0] ?? 'unused')); }
    },
    assetCacheRewriteUrl: (url) => url,
    isCacheableExternalUrl: () => false,
    assembleExample: (html) => html,
  });
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing port');
    await check(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function runScripts(html: string, window: object) {
  const uncommented = html.replace(/<!--[\s\S]*?-->/g, '');
  for (const script of uncommented.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    runInNewContext(script[1]!, { window });
  }
}

interface PreviewStorage {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  clear(): void;
}

function opaqueWindow(): { localStorage: PreviewStorage; sessionStorage: PreviewStorage } {
  const window = {};
  for (const name of ['localStorage', 'sessionStorage']) {
    Object.defineProperty(window, name, { configurable: true, get() { throw new Error('sandboxed opaque origin'); } });
  }
  return window as { localStorage: PreviewStorage; sessionStorage: PreviewStorage };
}

it('runs storage-dependent preview scripts with isolated memory when storage getters throw', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'od-preview-storage-'));
  const html = '<!-- prolog --><!doctype html><!-- <head> --><html><head><script>window.localStorage.setItem("theme", "dark");window.sessionStorage.setItem("slide", "2");</script></head><body></body></html>';
  await writeFile(path.join(root, 'preview.html'), html);
  try {
    await withPreview(root, 'preview.html', async (base) => {
      // The same document is reachable through the preview and asset routes.
      for (const route of ['preview', 'asset/preview.html']) {
        const response = await fetch(`${base}/api/plugins/example/${route}`);
        const served = await response.text();
        const window = opaqueWindow();
        expect(() => runScripts(served, window)).not.toThrow();
        const local = window.localStorage;
        expect(local.getItem('theme')).toBe('dark');
        expect(local.length).toBe(1);
        expect(local.key(0)).toBe('theme');
        expect(local.key(1)).toBeNull();
        expect(local.getItem('missing')).toBeNull();
        expect(window.sessionStorage.getItem('slide')).toBe('2');
        expect(window.sessionStorage.getItem('theme')).toBeNull();
        local.setItem('count', 3 as unknown as string);
        expect(local.getItem('count')).toBe('3');
        local.removeItem('theme');
        expect(local.getItem('theme')).toBeNull();
        local.clear();
        expect(local.length).toBe(0);
        const nextWindow = opaqueWindow();
        runScripts(served, nextWindow);
        expect(nextWindow.localStorage.getItem('count')).toBeNull();
        const nativeLocal = { setItem() {} }, nativeSession = { setItem() {} };
        const nativeWindow = { localStorage: nativeLocal, sessionStorage: nativeSession };
        runScripts(served, nativeWindow);
        expect(nativeWindow.localStorage).toBe(nativeLocal);
        expect(nativeWindow.sessionStorage).toBe(nativeSession);
        expect(response.headers.get('content-security-policy')).not.toContain('allow-same-origin');
      }
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const family of ['fervor', 'wrenfield']) {
  it(`serves ${family} gallery grain as a local PNG under its unchanged CSP`, async () => {
    const root = path.resolve(import.meta.dirname, `../../../plugins/_official/examples/agency-${family}`);
    await withPreview(root, 'preview/gallery.html', async (base) => {
      const response = await fetch(`${base}/api/plugins/example/preview`);
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(response.headers.get('content-security-policy')).toBe("default-src 'none'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'none'; frame-ancestors 'self'");
      expect(html).toContain("img-src 'self';");
      expect(html).not.toContain('data:image/');
      expect(html).toContain('url("grain.png")');
      const png = await fetch(`${base}/api/plugins/example/asset/preview/grain.png`);
      expect(png.status).toBe(200);
      expect(png.headers.get('content-type')).toBe('image/png');
      expect(Buffer.from(await png.arrayBuffer())).toEqual(await readFile(path.join(root, 'preview/grain.png')));
    });
  });
}

it('serves the maben gallery with in-page section links that stay in the document', async () => {
  const root = path.resolve(import.meta.dirname, '../../../plugins/_official/examples/agency-maben');
  await withPreview(root, 'preview/gallery.html', async (base) => {
    const response = await fetch(`${base}/api/plugins/example/preview`);
    expect(response.status).toBe(200);
    const html = await response.text();
    // A <base> would resolve "#maben-how-we-work" against the asset directory and navigate away.
    expect(html).not.toMatch(/<base\b/i);
    const fragments = [...html.matchAll(/\shref="(#[^"]+)"/g)].map((match) => match[1]!);
    expect(fragments).toContain('#maben-how-we-work');
    for (const fragment of fragments) expect(html).toContain(`id="${fragment.slice(1)}"`);
    // Every image still reaches the plugin asset route without a base.
    const sources = [...html.matchAll(/<img\b[^>]*\ssrc="([^"]+)"/g)].map((match) => match[1]!);
    expect(sources.length).toBeGreaterThan(0);
    for (const src of sources) expect(src.startsWith('/api/plugins/example/asset/preview/assets/')).toBe(true);
  });
});
