import type { Server } from 'node:http';
import { describe, expect, it } from 'vitest';
import { parseFontCheckResponse, parseResourceSearchResponse } from '@mish/contracts';
import { startServer } from '../../src/server.js';

describe('AC-R11 fonts on a real daemon', () => {
  it('federates the fonts source and serves its admitted bytes, check and specimen from the bundled resource root', async () => {
    const started = await startServer({ port: 0, returnServer: true }) as { url: string; server: Server; shutdown?: () => Promise<void> | void };
    try {
      const search = await fetch(`${started.url}/api/workbench/resources/search`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'Archivo', facets: { sourceIds: ['fonts'] }, limit: 100 }) });
      expect(search.status).toBe(200);
      const body = parseResourceSearchResponse(await search.json());
      expect(body.sourceStatuses.find(status => status.sourceId === 'fonts')).toMatchObject({ state: 'searched', reason: null });
      const archivo = body.results.find(item => item.ref.itemId === 'archivo')!;
      expect(archivo.previewCapability).toMatchObject({ available: true, kind: 'reference', reason: null });
      const bytes = await fetch(`${started.url}${archivo.previewCapability.url}`, { redirect: 'manual' });
      expect(bytes.status).toBe(200);
      expect(bytes.headers.get('content-type')).toBe('font/woff2');
      const check = await fetch(`${started.url}/api/workbench/fonts/check`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refKey: archivo.refKey, text: 'Book now', weights: [600] }) });
      expect(parseFontCheckResponse(await check.json())).toMatchObject({ passed: true, family: 'Archivo' });
      const specimen = await fetch(`${started.url}/api/workbench/fonts/specimen?ref=${encodeURIComponent(archivo.refKey)}&text=Book%20now`, { redirect: 'manual' });
      expect(specimen.status).toBe(200);
      expect(specimen.headers.get('content-security-policy')).toMatch(/^default-src 'none'; font-src 'self'; style-src 'sha256-/);
      // AC-R11 preamble: Google Fonts discovery and the kit inventory over every bundled resource root.
      const discovery = await fetch(`${started.url}/api/workbench/resources/search`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'Roboto', facets: { category: 'font' }, limit: 100 }) });
      const found = parseResourceSearchResponse(await discovery.json());
      expect(found.results.find(item => item.ref.itemId === 'roboto')?.fontProfile?.source).toMatchObject({ metadata: 'google/fonts' });
      expect(found.fontKits?.scanned.roots).toEqual(['bundled-plugins', 'design-templates', 'design-systems']);
      expect(found.fontKits?.counts.mapped).toBeGreaterThan(0);
    } finally {
      await Promise.resolve(started.shutdown?.());
      if (started.server.listening) await new Promise<void>(resolve => started.server.close(() => resolve()));
    }
  });
});
