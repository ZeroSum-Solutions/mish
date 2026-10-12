import type { Server } from 'node:http';
import { describe, expect, it } from 'vitest';
import { parseFontCheckResponse, parseResourceSearchResponse } from '@mish/contracts';
import { startServer } from '../../src/server.js';

describe('AC-R11 fonts on a real daemon', () => {
  it('federates metadata and reports removed bundled font bytes as unavailable', async () => {
    const started = await startServer({ port: 0, returnServer: true }) as { url: string; server: Server; shutdown?: () => Promise<void> | void };
    try {
      const search = await fetch(`${started.url}/api/workbench/resources/search`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'Archivo', facets: { sourceIds: ['fonts'] }, limit: 100 }) });
      expect(search.status).toBe(200);
      const body = parseResourceSearchResponse(await search.json());
      expect(body.sourceStatuses.find(status => status.sourceId === 'fonts')).toMatchObject({ state: 'degraded', reason: expect.stringContaining('font-file-unreadable') });
      const archivo = body.results.find(item => item.ref.itemId === 'archivo')!;
      expect(archivo.previewCapability).toMatchObject({ available: false, kind: 'none' });
      expect(archivo.fontProfile!.localFiles.every(file => file.state === 'unavailable')).toBe(true);
      const check = await fetch(`${started.url}/api/workbench/fonts/check`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refKey: archivo.refKey, text: 'Book now', weights: [600] }) });
      expect(parseFontCheckResponse(await check.json())).toMatchObject({ passed: false, family: 'Archivo', glyphs: { local: { state: 'no-local-file' } } });
      const specimen = await fetch(`${started.url}/api/workbench/fonts/specimen?ref=${encodeURIComponent(archivo.refKey)}&text=Book%20now`, { redirect: 'manual' });
      expect(specimen.status).toBe(200);
      expect(specimen.headers.get('content-security-policy')).toMatch(/^default-src 'none'; font-src 'self'; style-src 'sha256-/);
      // AC-R11 preamble: Google Fonts discovery and the kit inventory over every bundled resource root.
      const discovery = await fetch(`${started.url}/api/workbench/resources/search`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'Roboto', facets: { category: 'font' }, limit: 100 }) });
      const found = parseResourceSearchResponse(await discovery.json());
      expect(found.results.find(item => item.ref.itemId === 'roboto')?.fontProfile?.source).toMatchObject({ metadata: 'google/fonts' });
      expect(found.fontKits?.scanned.roots).toEqual(['bundled-plugins', 'design-templates', 'design-systems']);
      expect(found.fontKits?.scanned.kits).toBeGreaterThan(0);
    } finally {
      await Promise.resolve(started.shutdown?.());
      if (started.server.listening) await new Promise<void>(resolve => started.server.close(() => resolve()));
    }
  });
});
