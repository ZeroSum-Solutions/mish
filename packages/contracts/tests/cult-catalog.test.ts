import { describe, expect, it } from 'vitest';

import {
  CULT_CATALOG_KIND_FILTERS,
  isCultCatalogAssetKind,
  isCultCatalogSectionKind,
  isCultCatalogState,
  parseCultCatalogItemResponse,
  parseCultCatalogListResponse,
  type CultCatalogItem,
  type CultCatalogListResponse,
} from '../src/api/cult-catalog.js';

function item(overrides: Partial<CultCatalogItem> = {}): CultCatalogItem {
  return {
    id: 'cult:pricing-series-v',
    slug: 'pricing-series-v',
    displayTitle: 'Pricing (series V)',
    summary: 'Series V pricing section with a toggle.',
    assetKind: 'section',
    sourceCategory: 'marketing-pricing',
    tags: ['pricing', 'toggle'],
    sectionKind: 'pricing',
    spineAffinities: ['TL'],
    state: 'needs-adaptation',
    dependencies: { motion: true, canvas: false, webgl: false, server: false, packages: 1 },
    bytes: 1234,
    preview: { kind: 'none' },
    provenance: { snapshotId: 'cult-ui-pro@abc' },
    ...overrides,
  };
}

function list(items: unknown[] = [item()]): CultCatalogListResponse {
  return {
    catalog: {
      schema: 'cult-catalog/1',
      snapshot: { id: 'cult-ui-pro@abc', expectedItems: 2, fetchedItems: 1, pendingItems: 1 },
      items: items as CultCatalogItem[],
    },
  };
}

describe('parseCultCatalogListResponse', () => {
  it('accepts a valid response and returns it unchanged', () => {
    const body = list([item(), item({ id: 'cult:x', assetKind: 'primitive', state: 'pending', bytes: null, portQueue: 'genui-port' })]);
    expect(parseCultCatalogListResponse(body)).toBe(body);
  });

  it('names the first failing path', () => {
    expect(() => parseCultCatalogListResponse(null)).toThrow('must be an object');
    expect(() => parseCultCatalogListResponse({ catalog: { ...list().catalog, schema: 'x' } })).toThrow('catalog.schema');
    expect(() => parseCultCatalogListResponse({ catalog: { ...list().catalog, items: 'no' } })).toThrow('catalog.items must be an array');
    expect(() => parseCultCatalogListResponse(list([item({ state: 'adapter-needed' as never })]))).toThrow('catalog.items[0].state is invalid');
    expect(() => parseCultCatalogListResponse(list([item({ assetKind: 'block' as never })]))).toThrow('catalog.items[0].assetKind is invalid');
    expect(() => parseCultCatalogListResponse(list([item(), { ...item(), tags: [1] }]))).toThrow('catalog.items[1].tags');
    // `image` is a valid kind since the thumbnails change, so an image preview without a source
    // fails first at `.source`, and an unknown kind still fails at `.kind`.
    expect(() => parseCultCatalogListResponse(list([{ ...item(), preview: { kind: 'video' } as never }]))).toThrow('catalog.items[0].preview.kind');
    expect(() => parseCultCatalogListResponse(list([{ ...item(), preview: { kind: 'image', url: 'x' } as never }]))).toThrow('catalog.items[0].preview.source is invalid');
    expect(() => parseCultCatalogListResponse(list([{ ...item(), dependencies: { motion: 'yes' } }]))).toThrow('dependencies.motion');
    expect(() => parseCultCatalogListResponse(list([item({ portQueue: 'rewrite' as never })]))).toThrow('portQueue is invalid');
    expect(() => parseCultCatalogListResponse(list([item({ sectionKind: 'widget-wall' as never })]))).toThrow('catalog.items[0].sectionKind is invalid');
  });

  it('accepts content revisions and rejects unsafe revision payloads', () => {
    const body = list([item({ preview: { kind: 'image', source: 'adapter', revision: 'a'.repeat(64) } })]);
    expect(parseCultCatalogListResponse(body)).toBe(body);
    for (const revision of ['../private', 'a'.repeat(63), 5]) {
      expect(() => parseCultCatalogListResponse(list([item({ preview: { kind: 'image', source: 'adapter', revision } as never })]))).toThrow('revision');
    }
  });

  it('accepts related examples and sections and validates each related item', () => {
    const relatedItems = [
      { id: 'cult:pricing-example', title: 'Pricing Example', relationship: 'example' as const },
      { id: 'cult:pricing-section', title: 'Pricing Section', relationship: 'section' as const },
    ];
    const body = list([item({ relatedItems })]);
    expect(parseCultCatalogListResponse(body)).toBe(body);
    expect(parseCultCatalogItemResponse({ item: item({ relatedItems }) }).item.relatedItems).toEqual(relatedItems);
    for (const malformed of [null, 'x', [{ id: 'cult:x', title: 'X', relationship: 'duplicate' }], [{ id: '../private', title: 'X', relationship: 'example' }], [{ id: 'cult:x', title: 42, relationship: 'example' }]]) {
      expect(() => parseCultCatalogListResponse(list([{ ...item(), relatedItems: malformed }]))).toThrow('relatedItems');
    }
  });

  it('accepts every state, including not-converted next to needs-adaptation', () => {
    const body = list([item({ state: 'not-converted' }), item({ id: 'cult:y', state: 'needs-adaptation', stateReason: 'converter refused: oversized' })]);
    expect(parseCultCatalogListResponse(body).catalog.items.map((entry) => entry.state)).toEqual(['not-converted', 'needs-adaptation']);
  });
});

describe('parseCultCatalogItemResponse', () => {
  it('accepts one item and rejects a missing one', () => {
    const body = { item: item() };
    expect(parseCultCatalogItemResponse(body)).toBe(body);
    expect(() => parseCultCatalogItemResponse({})).toThrow('item must be an object');
  });
});

describe('guards', () => {
  it('know the closed asset kinds and states', () => {
    expect(isCultCatalogAssetKind('page')).toBe(true);
    expect(isCultCatalogAssetKind('block')).toBe(false);
    expect(isCultCatalogState('app-only')).toBe(true);
    expect(isCultCatalogState('pending-fetch')).toBe(false);
    expect(isCultCatalogState('not-converted')).toBe(true);
    expect(isCultCatalogState('unconverted')).toBe(false);
    expect(isCultCatalogSectionKind('page-composition')).toBe(true);
    expect(isCultCatalogSectionKind('widget-wall')).toBe(false);
  });

  it('map the kind filters to asset kinds', () => {
    expect(CULT_CATALOG_KIND_FILTERS.blocks).toEqual(['section', 'page']);
    expect(CULT_CATALOG_KIND_FILTERS.components).toEqual(['primitive', 'app']);
    expect(CULT_CATALOG_KIND_FILTERS.widget).toBeUndefined();
  });
});
