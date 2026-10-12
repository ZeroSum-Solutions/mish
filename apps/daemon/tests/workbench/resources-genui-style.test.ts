import { expect, it } from 'vitest';
import { parseResourceSearchRequest, type ResourceSearchRequest } from '@mish/contracts';
import { searchResources, createLocalResourceSources } from '../../src/workbench/resources.js';
import { CONTINUOUS_MOTION_STYLE_TAG } from '../../src/workbench/context-ranking.js';

const authority = { principalId: 'local-daemon', projectId: 'p' };
const request = (query: string): ResourceSearchRequest =>
  parseResourceSearchRequest({ query, facets: { sourceIds: ['genui'] }, limit: 100 });

// BLOCK finding: live catalog data never carried the classification context-ranking.ts's
// suppression gate reads — genui's atc-shader (packages/genui-catalog/catalog.json) is
// catalogued as category 'background' but runs a continuous requestAnimationFrame loop
// (verified from components/atc-shader/index.ts's start/stop-on-visibility `tick` loop).
// The genui adapter (resources.ts) now derives styleTags 'continuous-motion' from an
// explicit `motion: 'continuous'` catalog field instead of never populating it, so the
// context-ranking suppression rule has a real candidate to act on through the actual
// package data (no fixture `candidate()` stand-in).
it('derives continuous-motion styleTags for the real genui catalog, so an ordinary broad query does not surface atc-shader but a query naming it does', async () => {
  const sources = createLocalResourceSources({ listPlugins: async () => [] });
  const broad = await searchResources(request(''), authority, sources);
  expect(broad.results.length).toBeGreaterThan(0);
  expect(broad.results.some(item => item.ref.itemId === 'atc-shader')).toBe(false);
  const named = await searchResources(request('atc shader'), authority, sources);
  const shader = named.results.find(item => item.ref.itemId === 'atc-shader');
  expect(shader).toBeDefined();
  expect(shader!.styleTags).toContain(CONTINUOUS_MOTION_STYLE_TAG);
});
