import { describe, expect, it } from 'vitest';
import { parseCatalogueAdoptionRequest, parseCatalogueAdoptionResponse } from '../src/index.js';

describe('catalogue adoption request (draft sibling contract)', () => {
  it('accepts a reference and a normalized target, and rejects escapes and unknown fields', () => {
    expect(parseCatalogueAdoptionRequest({ projectId: 'p1', refKey: 'WzEsImxpYnJhcnkiXQ', entryPath: 'src/App.tsx', acceptReplacement: 'a'.repeat(64) }))
      .toMatchObject({ projectId: 'p1', entryPath: 'src/App.tsx' });
    expect(() => parseCatalogueAdoptionRequest({ projectId: 'p1', refKey: 'abc', entryPath: '../escape' })).toThrow();
    expect(() => parseCatalogueAdoptionRequest({ projectId: 'p1', refKey: 'abc', entryPath: 'src/App.tsx', targetDir: '/abs' })).toThrow();
    expect(() => parseCatalogueAdoptionRequest({ projectId: 'p1', refKey: 'a.b', entryPath: 'src/App.tsx' })).toThrow();
    expect(() => parseCatalogueAdoptionRequest({ projectId: 'p1', refKey: 'abc', entryPath: 'src/App.tsx', admission: {} })).toThrow();
  });
  it('validates the plan half of a response with the prepared-plan schema', () => {
    const catalogue = { refKey: 'abc', identity: { sourceId: 'shadcn', itemId: 'button', title: 'Button', packageName: 'shadcn/ui', sourceUrl: 'https://ui.shadcn.com/r/button.json', licence: 'MIT' },
      files: [{ path: 'src/components/ui/button.tsx', role: 'source' }], notices: ['src/components/ui/NOTICE.shadcn-button.md'], dependencies: { satisfied: [] } };
    expect(() => parseCatalogueAdoptionResponse({ plan: { schema: 'workbench-prepared-plan/1' }, catalogue })).toThrow();
    expect(() => parseCatalogueAdoptionResponse({ catalogue })).toThrow();
  });
});
