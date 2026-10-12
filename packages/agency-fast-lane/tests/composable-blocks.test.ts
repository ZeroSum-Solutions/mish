/**
 * G9 dry run: a composed page never plans with a block that must invent links or show a vendor
 * name (`section-overlay.ts`'s `composeRefusalFor`). The dry run's passing page carried
 * `cult:marketing-footer-apple`: GitHub/X/Discord icon links to `#contact`, 18 model-written link
 * labels ("Stripe" twice, "Reports", "Login") and "App Studio" in place of the brand.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { autoCoverage, loadBlockCatalogFromSource } from '../src/block-plan.ts';
import { composeRefusalFor, listComposableAdapterIds, listSectionAdapterIds, MAX_COMPOSED_LINK_LABELS, resolveSectionAdapter, type SectionAdapter } from '../src/section-overlay.ts';

test('footer-apple and the other vendor-icon blocks are refused for a fixed third-party link name', async () => {
  for (const id of ['cult:marketing-footer-apple', 'cult:marketing-footer-vercel', 'cult:marketing-footer-vite', 'cult:marketing-team-vite']) {
    assert.equal(composeRefusalFor(await resolveSectionAdapter(id)), 'fixed-link-name', id);
  }
});

test('a block with more model-written link labels than a brief can fill is refused', async () => {
  const footer = await resolveSectionAdapter('cult:sass-colorful--site-footer');
  assert.ok((footer.links ?? []).filter((link) => link.label).length > MAX_COMPOSED_LINK_LABELS);
  assert.equal(composeRefusalFor(footer), 'too-many-link-labels');
});

test('an ordinary block is composable', async () => {
  for (const id of ['cult:organic--site-footer', 'cult:marketing-hero-large-image', 'cult:sass-colorful--primary-cta', 'cult:marketing-faq-modern']) {
    assert.equal(composeRefusalFor(await resolveSectionAdapter(id)), undefined, id);
  }
});

test('an icon link whose name comes from a slot is not a fixed link name', () => {
  const adapter: SectionAdapter = {
    id: 'test:x', version: '1', sourceBlockId: 'test:x', sourceSha256: '', roles: [], css: '',
    text: [{ name: 'label', max: 20 }],
    links: [{ name: 'link1', href: '#contact', label: 'label' }],
    render: (fill) => `<a aria-label="${fill.text?.label ?? ''}" href="#contact"><svg></svg></a>`,
  };
  assert.equal(composeRefusalFor(adapter), undefined);
  const fixed: SectionAdapter = { ...adapter, render: () => '<a aria-label="Discord" href="#contact"><svg></svg></a>' };
  assert.equal(composeRefusalFor(fixed), 'fixed-link-name');
});

test('the planner catalog holds only composable blocks, and product adoption is still covered', async () => {
  const composable = new Set(await listComposableAdapterIds());
  const all = await listSectionAdapterIds();
  // The exact refused set on this catalog (after #131 promoted 18 more sections): three vendor-icon
  // footers and the vendor-icon team block, plus link-heavy navigation-style blocks.
  const refused = all.filter((id) => !composable.has(id)).sort();
  assert.deepEqual(refused, [
    'cult:marketing-footer-apple', 'cult:marketing-footer-vercel', 'cult:marketing-footer-vite',
    'cult:marketing-hero-input-focused', 'cult:marketing-hero-input-simple', 'cult:marketing-hero-navigation',
    'cult:marketing-nav-floating', 'cult:marketing-nav-minimal', 'cult:marketing-nav-vercel',
    'cult:marketing-navigation-apple', 'cult:marketing-navigation-vite', 'cult:marketing-team-vite',
    'cult:sass-colorful--navbar', 'cult:sass-colorful--site-footer',
  ]);
  const catalog = await loadBlockCatalogFromSource();
  for (const block of catalog.blocks) assert.ok(composable.has(block.id), block.id);
  assert.equal(catalog.blocks.some((block) => block.id === 'cult:marketing-footer-apple'), false);
  assert.equal(autoCoverage(catalog, 'PA'), true, 'a Product adoption brief still composes (hero, body, cta)');
});

test('an adapter that throws on render is refused, not treated as composable', () => {
  const adapter: SectionAdapter = {
    id: 'test:throws', version: '1', sourceBlockId: 'test:throws', sourceSha256: '', roles: [], css: '',
    text: [{ name: 'label', max: 20 }],
    render: () => { throw new Error('boom'); },
  };
  assert.equal(composeRefusalFor(adapter), 'render-failed');
});
