import { describe, expect, it } from 'vitest';
import type { ResourceSourceAdapter } from '../../src/workbench/resources.js';
import { createDesignSystemsResourceSource } from '../../src/workbench/resources-design-systems.js';
import { candidate } from './context-ranking-fixture.js';
import { designSystemFixtureRoot, searchEveryPage } from './resources-inventory-fixture.js';

describe('AC-R04.1 no numerical asset quota', () => {
  it('cursor pagination reaches every item of a cohort larger than one page', async () => {
    const items = Array.from({ length: 250 }, (_, index) => candidate(`fixture-${String(index).padStart(3, '0')}`));
    const source: ResourceSourceAdapter = { sourceId: 'sections', async list() { return { items, status: { sourceId: 'sections', state: 'searched', reason: null, itemCount: items.length, listingDigest: null } }; } };
    const { results, pages } = await searchEveryPage([source]);
    expect(pages).toBe(3); // 100 is the schema maximum page size
    expect(results).toHaveLength(250);
    expect(new Set(results.map(item => item.ref.itemId))).toEqual(new Set(items.map(item => item.ref.itemId)));
  });

  it('pages every item of 120 real design-system packages through the adapter', async () => {
    const tokens = JSON.stringify({ format: 'od-design-tokens/v1', tokens: [{ name: '--bg', type: 'color', value: '#fff' }, { name: '--space-1', type: 'dimension', value: '4px' }] });
    const ids = Array.from({ length: 120 }, (_, index) => `system-${String(index).padStart(3, '0')}`);
    const root = designSystemFixtureRoot(Object.fromEntries(ids.map(id => [id, {
      'manifest.json': JSON.stringify({ schemaVersion: 'od-design-system-project/v1', id, name: id, category: 'Testing', source: { type: 'bundled' }, files: { design: 'DESIGN.md', tokens: 'tokens.css', designTokens: 'design-tokens.json' } }),
      'DESIGN.md': `# ${id}\n`, 'tokens.css': ':root{}', 'design-tokens.json': tokens,
    }])));
    const source = createDesignSystemsResourceSource({ root });
    const { results, pages } = await searchEveryPage([source]);
    expect(results).toHaveLength(360); // system, palette and spacing scale per package
    expect(pages).toBe(4);
    expect(new Set(results.map(item => item.ref.itemId))).toEqual(new Set(ids.flatMap(id => [id, `${id}/color-palette`, `${id}/spacing-scale`])));
  });
});
