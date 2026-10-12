import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SectionCatalogEntry } from '@mish/contracts/api/section-catalog';
import sectionCatalogJson from '@mish/section-catalog/catalog.json' with { type: 'json' };
import { createLocalResourceSources } from '../../src/workbench/resources.js';
import { registerSectionsRoutes } from '../../src/routes/sections.js';

/**
 * AC-R07 preamble: compiled HTML sections join the Enlarge readiness/error checks. A HyperUI
 * block previews as its vendored markup plus the Tailwind utilities compiled at vendoring time; a
 * Cult section or page previews as the converter's compiled static layout. Both are served by
 * `GET /api/sections/:id/preview` as one self-contained, scriptable-only-inline, no-network
 * document in an opaque-origin sandbox. A section with no compiled bytes stays truthfully
 * unavailable, and stale or altered bytes are refused, never previewed.
 */
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const hyperuiRoot = path.join(repoRoot, 'plugins', '_official', 'shared', 'ui-kits', 'hyperui');
const cultKitDir = path.join(repoRoot, 'data', 'component-kits', 'cult-ui-pro');
const entries = (sectionCatalogJson as { entries: SectionCatalogEntry[] }).entries;
const context = { principalId: 'local-daemon' };

async function sectionsListing(roots: { hyperuiRoot: string | null; cultKitDir: string | null }) {
  const source = createLocalResourceSources({ listPlugins: async () => [], sectionPreviews: roots }).find(s => s.sourceId === 'sections')!;
  return (await source.list(context)).items;
}

function sendApiError(res: express.Response, status: number, code: string, message: string) {
  res.status(status).json({ error: { code, message } });
}
async function serve(roots: { hyperuiRoot: string | null; cultKitDir: string | null }) {
  const app = express();
  registerSectionsRoutes(app, { http: { sendApiError }, paths: { RUNTIME_DATA_DIR: mkdtempSync(path.join(tmpdir(), 'sections-preview-')) } } as never, { previewRoots: roots });
  const server: http.Server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const hyperuiBlock = entries.find(e => e.content.kind === 'vendored-block' && e.id === 'hyperui:application/charts/1')!;
const familySection = entries.find(e => e.content.kind === 'family-section')!;

describe('compiled HTML section previews in the resource listing', () => {
  it('offers every vendored HyperUI block and every converted Cult layout as a compiled-section preview', async () => {
    const items = await sectionsListing({ hyperuiRoot, cultKitDir });
    const hyperui = items.filter(item => item.ref.itemId.startsWith('hyperui:'));
    expect(hyperui.length).toBe(entries.filter(e => e.content.kind === 'vendored-block').length);
    for (const item of hyperui) {
      expect(item.previewCapability).toEqual({ available: true, kind: 'html', adapter: 'compiled-html-section', reason: null, url: `/api/sections/${encodeURIComponent(item.ref.itemId)}/preview` });
    }
    const cult = items.filter(item => item.ref.itemId.startsWith('cult:'));
    const compiled = cult.filter(item => item.previewCapability.available);
    expect(compiled.length).toBeGreaterThan(100);
    for (const item of compiled) expect(item.previewCapability).toMatchObject({ kind: 'html', adapter: 'compiled-html-section', url: `/api/sections/${encodeURIComponent(item.ref.itemId)}/preview` });
    // Truthful remainder: a Cult row with no converted layout and every family section.
    for (const item of cult.filter(item => !item.previewCapability.available)) expect(item.previewCapability).toEqual({ available: false, kind: 'none', reason: 'compiled-section-missing' });
    expect(items.find(item => item.ref.itemId === familySection.id)!.previewCapability).toEqual({ available: false, kind: 'none', reason: 'adapter-missing' });
  });

  it('says why when the licensed kit or the compiled stylesheet is absent, and refuses a stale stylesheet', async () => {
    const withoutRoots = await sectionsListing({ hyperuiRoot: null, cultKitDir: null });
    expect(withoutRoots.find(item => item.ref.itemId === hyperuiBlock.id)!.previewCapability).toEqual({ available: false, kind: 'none', reason: 'compiled-section-missing' });
    expect(withoutRoots.find(item => item.ref.itemId.startsWith('cult:'))!.previewCapability).toEqual({ available: false, kind: 'none', reason: 'licensed-kit-not-configured' });
    const stale = mkdtempSync(path.join(tmpdir(), 'hyperui-stale-'));
    cpSync(hyperuiRoot, stale, { recursive: true });
    const css = path.join(stale, 'css', 'preview.css');
    writeFileSync(css, readFileSync(css, 'utf8').replace(/blocks-sha256=[0-9a-f]{64}/, `blocks-sha256=${'0'.repeat(64)}`));
    const items = await sectionsListing({ hyperuiRoot: stale, cultKitDir: null });
    expect(items.find(item => item.ref.itemId === hyperuiBlock.id)!.previewCapability).toEqual({ available: false, kind: 'none', reason: 'compiled-section-stale' });
  });
});

describe('compiled stylesheet freshness', () => {
  // Sol r07 WARN: the stylesheet check must follow the file, not the first answer it gave.
  it('sees a stylesheet that appears, is replaced with a stale one, or is restored under the same root', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'hyperui-replace-'));
    cpSync(hyperuiRoot, root, { recursive: true });
    const css = path.join(root, 'css', 'preview.css');
    const good = readFileSync(css, 'utf8');
    const state = async () => (await sectionsListing({ hyperuiRoot: root, cultKitDir: null })).find(item => item.ref.itemId === hyperuiBlock.id)!.previewCapability;
    rmSync(css);
    expect(await state()).toMatchObject({ available: false, reason: 'compiled-section-missing' });
    writeFileSync(css, good);
    expect(await state()).toMatchObject({ available: true, adapter: 'compiled-html-section' });
    writeFileSync(css, good.replace(/blocks-sha256=[0-9a-f]{64}/, `blocks-sha256=${'1'.repeat(64)}`));
    expect(await state()).toMatchObject({ available: false, reason: 'compiled-section-stale' });
    const live = await serve({ hyperuiRoot: root, cultKitDir: null });
    try {
      expect((await fetch(`${live.base}/api/sections/${encodeURIComponent(hyperuiBlock.id)}/preview`)).status).toBe(422);
      writeFileSync(css, good);
      expect((await fetch(`${live.base}/api/sections/${encodeURIComponent(hyperuiBlock.id)}/preview`)).status).toBe(200);
    } finally {
      await new Promise<void>((resolve) => live.server.close(() => resolve()));
    }
  });
});

describe('GET /api/sections/:id/preview', () => {
  let live: Awaited<ReturnType<typeof serve>>;
  beforeAll(async () => { live = await serve({ hyperuiRoot, cultKitDir }); });
  afterAll(async () => { await new Promise<void>((resolve) => live.server.close(() => resolve())); });

  it('serves a HyperUI block with its compiled utilities in a no-network opaque sandbox', async () => {
    const response = await fetch(`${live.base}/api/sections/${encodeURIComponent(hyperuiBlock.id)}/preview`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^text\/html/);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    const policy = response.headers.get('content-security-policy')!;
    expect(policy).toMatch(/\bsandbox allow-scripts\b/);
    expect(policy).toMatch(/default-src 'none'/);
    expect(policy).toMatch(/connect-src 'none'/);
    expect(policy).not.toMatch(/https?:|\*/);
    const html = await response.text();
    expect(html).toContain(readFileSync(path.join(hyperuiRoot, 'blocks/application/charts/1.html'), 'utf8').trim().slice(0, 60));
    expect(html).toMatch(/<style[^>]*>[^<]*\.rounded-lg\{/);
    expect(html).not.toMatch(/<script\b[^>]*\bsrc=/i);
  });

  it('serves a converted Cult section to this machine only', async () => {
    const cult = (await sectionsListing({ hyperuiRoot, cultKitDir })).find(item => item.ref.itemId.startsWith('cult:') && item.previewCapability.available)!;
    const response = await fetch(`${live.base}${cult.previewCapability.url}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-security-policy')).toMatch(/sandbox allow-scripts/);
    expect(await response.text()).toContain('data-od-section="od-live-preview"');
    const remote = await fetch(`${live.base}${cult.previewCapability.url}`, { headers: { Origin: 'https://evil.example' } });
    expect(remote.status).toBe(403);
  });

  it('answers 404 for a section with no compiled bytes and refuses altered block bytes', async () => {
    expect((await fetch(`${live.base}/api/sections/${encodeURIComponent(familySection.id)}/preview`)).status).toBe(404);
    expect((await fetch(`${live.base}/api/sections/not-a-section/preview`)).status).toBe(404);
    const altered = mkdtempSync(path.join(tmpdir(), 'hyperui-altered-'));
    cpSync(hyperuiRoot, altered, { recursive: true });
    writeFileSync(path.join(altered, 'blocks/application/charts/1.html'), '<div onclick="steal()">tampered</div>');
    const other = await serve({ hyperuiRoot: altered, cultKitDir: null });
    try {
      const response = await fetch(`${other.base}/api/sections/${encodeURIComponent(hyperuiBlock.id)}/preview`);
      expect(response.status).toBe(422);
      expect(await response.text()).not.toContain('tampered');
    } finally {
      await new Promise<void>((resolve) => other.server.close(() => resolve()));
    }
  });
});
