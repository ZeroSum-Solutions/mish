import assert from 'node:assert/strict';
import test from 'node:test';
import { listSectionAdapterIds, resolveSectionAdapter, SectionSelectionRefusedError } from '../src/section-overlay.ts';

test('the public registry exposes exactly the supported HyperUI adapters', async () => {
 const ids = ['hyperui:marketing/ctas/1', 'hyperui:marketing/feature-grids/1', 'hyperui:marketing/sections/1'];
 assert.deepEqual(await listSectionAdapterIds(), ids);
 for (const id of ids) assert.equal((await resolveSectionAdapter(id)).id, id);
});

test('removed Cult adapters and malformed entries remain unavailable', async () => {
 for (const id of ['cult:marketing-cta-cosmic','cult:cta-cosmic','cult:marketing-hero-hex','cult:no-such-block','cult:toString','cult:__proto__','cult-marketing-cta-cosmic','CULT:marketing-cta-cosmic','']) {
  await assert.rejects(() => resolveSectionAdapter(id), SectionSelectionRefusedError, id);
 }
});

import { loadFamilyPackage } from '../src/family.ts';
import { fillSectionAdapter, resolveDesignDirection, wrapFamilyPackageForOverlay } from '../src/section-overlay.ts';
import { TEST_EDITORIAL_DIR, fakeModel } from './fixtures.ts';

test('public overlay adds only its safe section, keeps CSP and stays within the page budget', async () => {
  const pkg = await loadFamilyPackage(TEST_EDITORIAL_DIR, 'ownededitorial');
  const adapter = await resolveSectionAdapter('hyperui:marketing/ctas/1');
  const direction = await resolveDesignDirection('modern-minimal');
  const filled = await fillSectionAdapter({ adapter, brief: 'Fixture Workshop offers design services.', model: fakeModel() });
  assert.equal(filled.calls, 1);
  assert.deepEqual(filled.flagged, []);
  const selection = { entryId: adapter.id, placement: { mode: 'append', afterSectionId: 'ownededitorial-hero' } as const, directionId: direction.id };
  const wrapped = await wrapFamilyPackageForOverlay(pkg, selection, direction, adapter, filled.fill);
  const baseline = pkg.render(pkg.fixture, 'fixture.html');
  const result = wrapped.render(pkg.fixture, 'fixture.html');
  const marker = `data-od-selected-section="${adapter.id}"`;
  assert.equal(result.html.split(marker).length - 1, 1);
  const start = result.html.lastIndexOf('<div id="od-selected-', result.html.indexOf(marker));
  assert.ok(start > result.html.indexOf('id="ownededitorial-hero"'));
  assert.ok(start < result.html.indexOf('</main>'));
  const section = result.html.slice(start, start + result.html.length - baseline.html.length);
  assert.equal(result.html.slice(0, start) + result.html.slice(start + section.length), baseline.html);
  assert.ok(section.startsWith('<div id="od-selected-') && section.endsWith('</div>'));
  for (const pattern of [/<script\b/i, /\son[a-z]+\s*=/i, /https?:\/\//i, /url\(/i, /@import/i, /<img\b/i, /javascript:/i]) {
    assert.ok(!pattern.test(section), `unsafe inserted section: ${pattern}`);
  }
  const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(baseline.html)?.[1];
  assert.ok(csp?.includes("default-src 'none'"));
  assert.ok(result.html.includes(`content="${csp}"`));
  assert.ok(Buffer.byteLength(result.html) < 200 * 1024);
  assert.notEqual(result.manifest.metadata.agencySite.recipeDigest, baseline.manifest.metadata.agencySite.recipeDigest);
  assert.equal(wrapped.render(pkg.fixture, 'fixture.html').manifest.metadata.agencySite.recipeDigest, result.manifest.metadata.agencySite.recipeDigest);
});
