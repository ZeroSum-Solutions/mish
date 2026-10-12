/**
 * The adapter registry in `src/section-overlay.ts` resolves the checked Cult adapters from
 * `@mish/cult-ui-catalog`'s generated registry next to the three HyperUI ids, and a Cult
 * adapter renders through the same overlay path: fill, splice, digest, family CSP.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { loadFamilyPackage } from '../src/family.ts';
import {
  fillSectionAdapter,
  listSectionAdapterIds,
  resolveDesignDirection,
  resolveSectionAdapter,
  SectionSelectionRefusedError,
  wrapFamilyPackageForOverlay,
} from '../src/section-overlay.ts';
import { fakeModel, WATSON_DIR } from './fixtures.ts';

const CULT_ID = 'cult:marketing-cta-cosmic';
const HYPERUI_IDS = ['hyperui:marketing/ctas/1', 'hyperui:marketing/feature-grids/1', 'hyperui:marketing/sections/1'];
const BRIEF = 'Watson, a design and technology studio in Los Angeles. Brand, product and motion work for ambitious teams.';
const PAGE_LIMIT = 200 * 1024;

test('registry: the three HyperUI ids resolve as before, Cult ids resolve from the generated registry', async () => {
  const ids = await listSectionAdapterIds();
  assert.deepEqual(ids.slice(0, 3), HYPERUI_IDS);
  const cult = ids.filter((id) => id.startsWith('cult:'));
  assert.ok(cult.length >= 3, `expected at least three Cult adapters, got ${cult.length}`);
  assert.ok(cult.includes(CULT_ID));
  for (const id of HYPERUI_IDS) assert.equal((await resolveSectionAdapter(id)).id, id);
  const adapter = await resolveSectionAdapter(CULT_ID);
  assert.equal(adapter.id, CULT_ID);
  assert.equal(adapter.sourceBlockId, CULT_ID);
  assert.equal(await resolveSectionAdapter(CULT_ID), adapter, 'the same adapter object on every resolution');
});

test('registry: unknown, malformed and not-yet-converted ids are refused', async () => {
  for (const id of ['cult:marketing-hero-hex', 'cult:no-such-block', 'cult:toString', 'cult:__proto__', 'cult-marketing-cta-cosmic', 'CULT:marketing-cta-cosmic', '']) {
    await assert.rejects(() => resolveSectionAdapter(id), SectionSelectionRefusedError, id);
  }
});

test('overlay: the artifact digest is the same whichever id names the entry', async () => {
  const pkg = await loadFamilyPackage(WATSON_DIR, 'watson');
  const adapter = await resolveSectionAdapter(CULT_ID);
  const direction = await resolveDesignDirection('modern-minimal');
  const filled = await fillSectionAdapter({ adapter, brief: BRIEF, model: fakeModel() });
  const placement = { mode: 'append', afterSectionId: 'watson-hero' } as const;
  const digestFor = async (entryId: string) => {
    const wrapped = await wrapFamilyPackageForOverlay(pkg, { entryId, placement, directionId: direction.id }, direction, adapter, filled.fill);
    return wrapped.render(pkg.fixture, 'watson-r1.html').manifest.metadata.agencySite.recipeDigest;
  };
  assert.equal(await digestFor('cult:cta-cosmic'), await digestFor(CULT_ID));
});

test('resolveSectionAdapter takes a Cult entry by its public id or its internal id', async () => {
  const byPublic = await resolveSectionAdapter('cult:cta-cosmic');
  const byInternal = await resolveSectionAdapter(CULT_ID);
  assert.equal(byPublic, byInternal);
  assert.equal(byPublic.id, CULT_ID);
  // A refusal names the public id, never the internal one.
  await assert.rejects(() => resolveSectionAdapter('cult:marketing-hero-hex'), (error: Error) => !error.message.includes('marketing-hero-hex') && error.message.includes('cult:hero-hex'));
});

test('overlay: a Cult adapter fills, splices with data-od-selected-section="cult:…", and keeps the page CSP-clean and small', async () => {
  const pkg = await loadFamilyPackage(WATSON_DIR, 'watson');
  const adapter = await resolveSectionAdapter(CULT_ID);
  const direction = await resolveDesignDirection('modern-minimal');
  const filled = await fillSectionAdapter({ adapter, brief: BRIEF, model: fakeModel() });
  assert.equal(filled.calls, 1);
  assert.deepEqual(filled.flagged, []);
  for (const slot of adapter.text) {
    const value = filled.fill.text?.[slot.name];
    if (value !== null) assert.equal(typeof value, 'string', slot.name);
  }

  const selection = { entryId: CULT_ID, placement: { mode: 'append', afterSectionId: 'watson-hero' } as const, directionId: direction.id };
  const wrapped = await wrapFamilyPackageForOverlay(pkg, selection, direction, adapter, filled.fill);
  const baseline = pkg.render(pkg.fixture, 'watson-r1.html');
  const result = wrapped.render(pkg.fixture, 'watson-r1.html');
  const html = result.html;

  // The page names the entry, its section id and its CSS scope by public id (`cult:cta-cosmic`).
  const marker = 'data-od-selected-section="cult:cta-cosmic"';
  assert.equal(html.split(marker).length - 1, 1, 'exactly one selected Cult section');
  const start = html.lastIndexOf('<div id="od-selected-', html.indexOf(marker));
  assert.ok(start > html.indexOf('id="watson-hero"'), 'inserted after the anchor');
  assert.ok(start < html.indexOf('</main>'), 'inserted inside <main>');
  assert.ok(html.includes('class="cult-cta-cosmic"'), 'the adapter markup carries its CSS scope');
  assert.ok(html.includes('<div id="od-selected-cult-cta-cosmic"'), 'the section id is built from the public id');
  assert.ok(!html.includes('marketing-cta-cosmic'), 'no internal name anywhere on the page');

  // The family CSP (default-src 'none'; style-src 'unsafe-inline'; img-src 'self') is unchanged,
  // and the inserted section needs nothing beyond inline style: no script, handler, remote URL,
  // CSS url()/@import, or image.
  const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(baseline.html)?.[1];
  assert.ok(csp?.includes("default-src 'none'"));
  assert.ok(html.includes(`content="${csp}"`), 'the page keeps the family CSP');
  const section = html.slice(start, start + html.length - baseline.html.length);
  assert.equal(html.slice(0, start) + html.slice(start + section.length), baseline.html, 'the splice adds the section and changes nothing else');
  assert.ok(section.startsWith('<div id="od-selected-') && section.endsWith('</div>'));
  for (const [pattern, what] of [
    [/<script\b/i, 'a <script>'], [/\son[a-z]+\s*=/i, 'an inline handler'], [/https?:\/\//i, 'a remote URL'],
    [/url\(/i, 'a CSS url()'], [/@import/i, 'an @import'], [/<img\b/i, 'an image'], [/javascript:/i, 'a javascript: URL'],
  ] as const) assert.ok(!pattern.test(section), `the inserted section contains ${what}`);

  const bytes = Buffer.byteLength(html, 'utf8');
  assert.ok(bytes < PAGE_LIMIT, `page is ${bytes} B, over ${PAGE_LIMIT} B`);
  const overlay = (result.manifest.metadata.agencySite as unknown as { sectionOverlay: { entryId: string; sourceBlockId: string; adapterVersion: string } }).sectionOverlay;
  // The published manifest names the entry and its source block by public id.
  assert.deepEqual([overlay.entryId, overlay.sourceBlockId, overlay.adapterVersion], ['cult:cta-cosmic', 'cult:cta-cosmic', adapter.version]);
  assert.notEqual(result.manifest.metadata.agencySite.recipeDigest, baseline.manifest.metadata.agencySite.recipeDigest);
});
