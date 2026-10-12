import type { Server } from 'node:http';
import { describe, expect, it } from 'vitest';
import { parseResourceSearchResponse } from '@open-design/contracts';
import { startServer } from '../../src/server.js';

describe('design-systems inventory on a real daemon', () => {
  it('serves every preview the design-systems items offer through the existing package routes', async () => {
    const started = await startServer({ port: 0, returnServer: true }) as { url: string; server: Server; shutdown?: () => Promise<void> | void };
    try {
      const search = await fetch(`${started.url}/api/workbench/resources/search`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ facets: { sourceIds: ['design-systems'] }, limit: 100 }) });
      expect(search.status).toBe(200);
      const body = parseResourceSearchResponse(await search.json());
      expect(body.sourceStatuses.find(status => status.sourceId === 'design-systems')).toMatchObject({ state: 'searched' });
      const previewable = body.results.filter(item => item.previewCapability.available);
      expect(previewable.map(item => item.category).sort()).toEqual(['color-palette', 'design-system', 'spacing-scale', 'type-scale']);
      for (const item of previewable) {
        // The web preview harness fetches headerless and refuses redirects; do the same.
        const preview = await fetch(`${started.url}${item.previewCapability.url}`, { redirect: 'manual' });
        expect(preview.status, item.ref.itemId).toBe(200);
        expect(preview.headers.get('content-type'), item.ref.itemId).toContain('text/html');
      }
      // The preview pages link `../tokens.css`; in path form that resolves to a served package file.
      const palette = previewable.find(item => item.category === 'color-palette')!;
      const tokens = await fetch(new URL('../tokens.css', `${started.url}${palette.previewCapability.url}`), { redirect: 'manual' });
      expect(tokens.status).toBe(200);
      expect(tokens.headers.get('content-type')).toContain('text/css');
    } finally {
      await Promise.resolve(started.shutdown?.());
      if (started.server.listening) await new Promise<void>(resolve => started.server.close(() => resolve()));
    }
  });
});
