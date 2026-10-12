/**
 * The page byte budget on the REAL path: the marketing-site compiler copy, its own effect
 * declaration and catalog assets, and a synthetic oversized section spliced in through the same
 * `compose` hook the selected-section overlay uses. The compiler budgets effects on the composed
 * page (`byte-budget` skips); the fast lane refuses any final page at or over `PAGE_BYTE_LIMIT`
 * with no effect left (`PageTooLargeError`, code `page-too-large`) and publishes nothing.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { PAGE_BYTE_LIMIT, PageTooLargeError, renderWithEffects, type EffectPlan } from '../src/effects.ts';
import { loadFamilyPackage, type FamilyPackage, type RenderOptions } from '../src/family.ts';
import type { ProjectPublisher } from '../src/publish.ts';
import { runFastLane } from '../src/run.ts';
import { fakeModel, type Filler } from './fixtures.ts';

const EXAMPLES = path.resolve(import.meta.dirname, '../../../plugins/_official/examples');
const pkg = await loadFamilyPackage(path.join(EXAMPLES, 'agency-marketing-site'), 'marketing-site');
const ENTRY = 'marketing-site-r1.html';
const bytes = (html: string) => Buffer.byteLength(html, 'utf8');

/** A synthetic section of exactly `size` UTF-8 bytes, spliced before `</body>`. */
const OPEN = '<section id="synthetic-oversized"><p>';
const CLOSE = '</p></section>';
const section = (size: number) => `${OPEN}${'x'.repeat(size - OPEN.length - CLOSE.length)}${CLOSE}`;
const composeWith = (size: number) => (html: string) => {
  const at = html.lastIndexOf('</body>');
  return `${html.slice(0, at)}${section(size)}${html.slice(at)}`;
};

/** The package's real render, with the synthetic section composed in by the compiler. */
const composedRender = (size: number) => (input: Parameters<FamilyPackage['render']>[0], entry: string, options?: RenderOptions) =>
  pkg.render(input, entry, { ...options, compose: composeWith(size) });

const HERO: EffectPlan['effects'][number] = { placement: 'hero-title', componentId: 'split-text', source: 'hint' };
const CTA: EffectPlan['effects'][number] = { placement: 'cta', componentId: 'glare-hover', source: 'hint' };
const base = bytes(pkg.render(pkg.fixture, ENTRY).html);
const costOf = (effects: EffectPlan['effects']) => pkg.render(pkg.fixture, ENTRY, { effects: { effects } }).effects!.bytesAdded;

test('real compiler: over budget with the composed section, the lowest-priority effect is dropped as byte-budget', () => {
  const heroOnly = costOf([HERO]);
  const both = costOf([HERO, CTA]);
  assert.ok(both > heroOnly && heroOnly > 0);
  // Room for the hero title's effect on the composed page, not for the hero title plus the cta.
  const room = Math.floor((heroOnly + both) / 2);
  const size = PAGE_BYTE_LIMIT - room - base;
  const out = renderWithEffects(composedRender(size), pkg.fixture, ENTRY, { effects: [CTA, HERO] });
  assert.ok(out.html.includes('id="synthetic-oversized"'), 'the section composed');
  assert.ok(bytes(out.html) < PAGE_BYTE_LIMIT);
  assert.deepEqual(out.effects?.applied.map((item) => item.placement), ['hero-title']);
  assert.deepEqual(out.effects?.skipped, [{ placement: 'cta', componentId: 'glare-hover', reason: 'byte-budget' }]);
  assert.equal(out.effects?.bytesAdded, heroOnly);
});

test('real compiler: a composed page at the limit fails with page-too-large, with a plan and without one', () => {
  const atLimit = PAGE_BYTE_LIMIT - base;
  const refused = (error: unknown) => error instanceof PageTooLargeError && error.code === 'page-too-large' && error.bytes === PAGE_BYTE_LIMIT;
  assert.throws(() => renderWithEffects(composedRender(atLimit), pkg.fixture, ENTRY, { effects: [HERO, CTA] }), refused, 'every effect dropped: the base alone does not fit');
  assert.throws(() => renderWithEffects(composedRender(atLimit), pkg.fixture, ENTRY, undefined), refused, 'the no-plan path');
  assert.throws(() => renderWithEffects(composedRender(atLimit + 1), pkg.fixture, ENTRY, { effects: [] }), (error) => error instanceof PageTooLargeError && error.bytes === PAGE_BYTE_LIMIT + 1, 'an empty plan is the no-plan path');
  const below = renderWithEffects(composedRender(atLimit - 1), pkg.fixture, ENTRY, undefined);
  assert.equal(bytes(below.html), PAGE_BYTE_LIMIT - 1, 'one byte under the limit publishes');
});

test('an intermediate render (final: false) over the limit never throws; the same page as final does', () => {
  const over = PAGE_BYTE_LIMIT - base + 1_000;
  const intermediate = renderWithEffects(composedRender(over), pkg.fixture, ENTRY, { effects: [HERO] }, { final: false });
  assert.ok(bytes(intermediate.html) >= PAGE_BYTE_LIMIT, 'the oversized intermediate is returned as rendered');
  assert.equal(intermediate.effects, undefined, 'a plan the compiler refused on an oversized base renders without it');
  assert.ok(bytes(renderWithEffects(composedRender(over), pkg.fixture, ENTRY, undefined, { final: false }).html) >= PAGE_BYTE_LIMIT);
  assert.throws(() => renderWithEffects(composedRender(over), pkg.fixture, ENTRY, { effects: [HERO] }, { final: true }), PageTooLargeError);
  assert.throws(() => renderWithEffects(composedRender(over), pkg.fixture, ENTRY, undefined), PageTooLargeError, 'final is the default');
});

test('runFastLane: an oversized fill render paints instead of failing the unit, and the final page is refused before registration', async () => {
  const pages: string[] = [];
  const publisher: ProjectPublisher = {
    projectId: 'p1',
    async savePage(_entry, html) { pages.push(html); },
    async saveFile() {},
    async deleteProject() { return 'deleted' as const; },
  };
  // Every filled render is over the limit; the spine (the fixture) is not.
  const filledOver: FamilyPackage = {
    ...pkg,
    render: (input, entry, options) => (input === pkg.fixture || JSON.stringify(input).includes('"Ashgrove') === false
      ? pkg.render(input, entry, options)
      : pkg.render(input, entry, { ...options, compose: composeWith(PAGE_BYTE_LIMIT) })),
  };
  await assert.rejects(
    runFastLane({
      pkg: filledOver,
      brief: 'Ashgrove Language Academy teaches adult Spanish and French in Boston.',
      mode: 'single',
      entry: ENTRY,
      revision: 1,
      model: fakeModel({ fill }),
      modelName: 'fake',
      lockPaths: ['brand.name'],
      publisher,
      effects: { effects: [HERO] },
    }),
    (error) => error instanceof PageTooLargeError && error.bytes >= PAGE_BYTE_LIMIT,
  );
  // The oversized fill render was NOT refused as an invalid model answer (no repair loop): it was
  // painted, and the budget refused the final page instead.
  assert.ok(pages.some((html) => bytes(html) >= PAGE_BYTE_LIMIT), 'the oversized intermediate painted');
});

const fill: Filler = (key, _value, _at, limit) => (key === 'links' ? null : `Ashgrove ${key}`.slice(0, limit ?? Infinity));

test('runFastLane: an oversized composed final page fails the build and publishes nothing', async () => {
  const pages: string[] = [];
  const publisher: ProjectPublisher = {
    projectId: 'p1',
    async savePage(_entry, html) { pages.push(html); },
    async saveFile() {},
    async deleteProject() { return 'deleted' as const; },
  };
  // Only the overlay's render passes `compose`: the synthetic section rides on the real selected
  // section, so the spine and fill renders stay small and the FINAL composed render is the one over.
  const oversized: FamilyPackage = {
    ...pkg,
    render: (input, entry, options) => (options?.compose
      ? pkg.render(input, entry, { ...options, compose: (html) => composeWith(PAGE_BYTE_LIMIT)(options.compose!(html)) })
      : pkg.render(input, entry, options)),
  };
  await assert.rejects(
    runFastLane({
      pkg: oversized,
      brief: 'Ashgrove Language Academy teaches adult Spanish and French in Boston.',
      mode: 'single',
      entry: ENTRY,
      revision: 1,
      model: fakeModel({ fill }),
      modelName: 'fake',
      lockPaths: ['brand.name'],
      strict: true,
      verify: { checkFaithfulness: async () => ({ flagged: [], ms: 1, calls: 1 }) },
      ensurePublisher: async () => ({ publisher, created: true }),
      sectionSelection: { entryId: 'hyperui:marketing/ctas/1', placement: { mode: 'append', afterSectionId: 'marketing-site-hero' }, directionId: 'modern-minimal' },
      effects: { effects: [HERO] },
    }),
    (error) => error instanceof PageTooLargeError && error.code === 'page-too-large' && error.bytes >= PAGE_BYTE_LIMIT,
  );
  assert.deepEqual(pages, [], 'nothing published');
});
