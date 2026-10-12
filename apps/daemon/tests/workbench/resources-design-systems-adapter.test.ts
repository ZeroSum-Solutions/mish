import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseResourceSearchRequest } from '@mish/contracts';
import { inspectResource, searchResources, ResourceError } from '../../src/workbench/resources.js';
import { createDesignSystemsResourceSource } from '../../src/workbench/resources-design-systems.js';
import { REPO_DESIGN_SYSTEMS_ROOT, authority, designSystemFixtureRoot } from './resources-inventory-fixture.js';

const manifest = (id: string, extra: Record<string, unknown> = {}) => JSON.stringify({
  schemaVersion: 'od-design-system-project/v1', id, name: 'Fixture System', category: 'Testing',
  source: { type: 'github', url: 'https://github.com/example/fixture' },
  files: { design: 'DESIGN.md', tokens: 'tokens.css', designTokens: 'design-tokens.json' }, ...extra,
});
const tokens = (list: Array<[string, string, string]>) => JSON.stringify({ format: 'od-design-tokens/v1', tokens: list.map(([name, type, value]) => ({ name, type, value })) });

describe('design-systems resource adapter', () => {
  it('federates the bundled neutral-product package and its real token cohorts', async () => {
    const snapshot = await createDesignSystemsResourceSource({ root: REPO_DESIGN_SYSTEMS_ROOT }).list(authority);
    expect(snapshot.status).toMatchObject({ sourceId: 'design-systems', state: 'searched', reason: null, itemCount: snapshot.items.length });
    const neutral = snapshot.items.filter(item => item.ref.itemId.split('/')[0] === 'neutral-product');
    // No font item: the package declares no webfonts (it uses system stacks on purpose).
    expect(neutral.map(item => [item.ref.itemId, item.category])).toEqual([
      ['neutral-product', 'design-system'],
      ['neutral-product/color-palette', 'color-palette'],
      ['neutral-product/type-scale', 'type-scale'],
      ['neutral-product/spacing-scale', 'spacing-scale'],
      ['neutral-product/motion', 'motion'],
    ]);
    for (const item of neutral) {
      expect(item.ref).toMatchObject({ sourceType: 'library', sourceId: 'design-systems' });
      expect(item.ref.revisionOrDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
      // No acceptance evidence exists, so nothing is minted usable or adoptable.
      expect(item.readiness).toBe('unverified');
      expect(item.acceptanceEvidence).toBeUndefined();
      expect(item.adoptionCapability.available).toBe(false);
      // Bundled provenance from the package's own manifest.
      expect(item.rightsStatus).toBe('permitted');
      expect(item.sourceAttribution.title).toContain('Mishh Mashh original agency archetype');
    }
    const byCategory = Object.fromEntries(neutral.map(item => [item.category, item]));
    expect(byCategory['design-system']!.title).toBe('Neutral Product');
    expect(byCategory['design-system']!.previewCapability).toEqual({ available: true, kind: 'html', url: '/api/design-systems/neutral-product/preview', reason: null });
    // Token cohorts open the package's own declared preview pages.
    expect(byCategory['color-palette']!.previewCapability).toEqual({ available: true, kind: 'html', url: '/api/design-systems/neutral-product/static/preview/colors.html', reason: null });
    expect(byCategory['type-scale']!.previewCapability.url).toBe('/api/design-systems/neutral-product/static/preview/typography.html');
    expect(byCategory['spacing-scale']!.previewCapability.url).toBe('/api/design-systems/neutral-product/static/preview/spacing.html');
    // Motion has no declared preview page; its reduced-motion handling is declared in tokens.css.
    expect(byCategory.motion!.previewCapability).toEqual({ available: false, kind: 'none', reason: 'no-declared-preview-page' });
    expect(byCategory.motion!.motionMetadata).toMatchObject({ state: 'reduced-compatible', basis: 'declared', sourceRevisionOrDigest: byCategory.motion!.ref.revisionOrDigest });
  });

  it('round-trips search and inspect, and fences a changed package as stale', async () => {
    const root = designSystemFixtureRoot({ fixture: {
      'manifest.json': manifest('fixture'), 'DESIGN.md': '# Fixture System\n', 'tokens.css': ':root { --bg: #fff; }\n',
      'design-tokens.json': tokens([['--bg', 'color', '#fff']]),
    } });
    const sources = [createDesignSystemsResourceSource({ root })];
    const search = await searchResources(parseResourceSearchRequest({ facets: { category: 'color-palette' } }), authority, sources);
    expect(search.results.map(item => item.ref.itemId)).toEqual(['fixture/color-palette']);
    const detail = await inspectResource(search.results[0]!.refKey, authority, sources);
    expect(detail.resource).toEqual(search.results[0]);
    writeFileSync(path.join(root, 'fixture', 'tokens.css'), ':root { --bg: #000; }\n');
    await expect(inspectResource(search.results[0]!.refKey, authority, sources)).rejects.toMatchObject({ status: 409, code: 'resource-ref-stale' } satisfies Partial<ResourceError>);
  });

  it('emits font items only for declared fonts and omits categories the tokens do not declare', async () => {
    const root = designSystemFixtureRoot({ typed: {
      'manifest.json': manifest('typed', { fonts: [{ family: 'Fixture Sans', file: 'fonts/fixture-sans.woff2', weight: '400' }, { family: 'Fixture Sans', file: 'fonts/fixture-sans-bold.woff2', weight: '700' }] }),
      'DESIGN.md': '# Typed\n', 'tokens.css': ':root { --accent: #123456; }\n',
      'design-tokens.json': tokens([['--accent', 'color', '#123456']]),
      'fonts/fixture-sans.woff2': 'wOF2', 'fonts/fixture-sans-bold.woff2': 'wOF2',
    } });
    const { items } = await createDesignSystemsResourceSource({ root }).list(authority);
    expect(items.map(item => item.category)).toEqual(['design-system', 'color-palette', 'font']);
    const font = items.find(item => item.category === 'font')!;
    expect(font.ref.itemId).toMatch(/^typed\/font\/fixture-sans-[a-f0-9]{8}$/);
    expect(font.previewCapability).toEqual({ available: true, kind: 'reference', url: '/api/design-systems/typed/static/fonts/fixture-sans.woff2', reason: null });
    // Non-bundled provenance carries no rights claim.
    expect(items.every(item => item.rightsStatus === 'unknown')).toBe(true);
    // No declared preview page for the palette: truthful unavailable, not a guessed URL.
    expect(items.find(item => item.category === 'color-palette')!.previewCapability).toEqual({ available: false, kind: 'none', reason: 'no-declared-preview-page' });
  });

  it('degrades truthfully on malformed packages and never follows files out of a package', async () => {
    const root = designSystemFixtureRoot({
      good: { 'manifest.json': manifest('good', { preview: { dir: 'preview', pages: [{ path: 'preview/colors.html', role: 'colors' }] } }), 'DESIGN.md': '# Good\n', 'tokens.css': ':root{}', 'design-tokens.json': tokens([['--bg', 'color', '#fff']]) },
      broken: { 'manifest.json': '{not json', 'DESIGN.md': '# Broken\n' },
      renamed: { 'manifest.json': manifest('other-id'), 'DESIGN.md': '# Renamed\n', 'tokens.css': ':root{}' },
      'legacy-only': { 'DESIGN.md': '# Legacy DESIGN.md-only folder\n' },
      _schema: { 'AGENTS.md': 'not a package' },
      outside: { 'secret.html': '<p>outside</p>' },
    });
    mkdirSync(path.join(root, 'good', 'preview'));
    symlinkSync(path.join(root, 'outside', 'secret.html'), path.join(root, 'good', 'preview', 'colors.html'));
    const snapshot = await createDesignSystemsResourceSource({ root }).list(authority);
    expect(snapshot.status).toMatchObject({ state: 'degraded', reason: 'invalid-design-system-package:3; preview-page-unreadable:1' });
    expect(snapshot.items.map(item => item.ref.itemId)).toEqual(['good', 'good/color-palette']);
    // The page is declared but its symlink leaves the package: never served, named as unreadable.
    expect(snapshot.items[1]!.previewCapability).toEqual({ available: false, kind: 'none', reason: 'preview-page-unreadable' });
    expect(JSON.stringify(snapshot)).not.toContain(root);
  });

  it('reports a missing resource root as degraded without leaking the path', async () => {
    const snapshot = await createDesignSystemsResourceSource({ root: path.join(REPO_DESIGN_SYSTEMS_ROOT, 'does-not-exist') }).list(authority);
    expect(snapshot).toEqual({ items: [], status: { sourceId: 'design-systems', state: 'degraded', reason: 'resource-root-unreadable', itemCount: null, listingDigest: null } });
  });
});
