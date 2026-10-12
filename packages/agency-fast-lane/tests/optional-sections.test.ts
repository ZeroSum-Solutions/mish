/**
 * Optional sections across all sixteen bundled families.
 *
 * For every family: the schema's `x-optional` sections are exactly the family's
 * `OPTIONAL_SECTIONS`; the reference recipe renders with that section dropped (`null` in its slot)
 * and the page loses the section, its assets and its links and nothing else (see
 * `helpers/optional-sections.ts`); and a whole build (`buildSite`, dry run) whose keep/drop judge
 * drops it never shows the section to the model, never sends it to the faithfulness check, and
 * reports it dropped. Offline: the model, the judge and the checker are fakes.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { buildSite, JevCredentialError, type BuildDeps, type BuildEvent } from '../src/build.ts';
import { loadFamilyPackage, type FamilyPackage } from '../src/family.ts';
import type { FaithfulnessChecker, FaithfulnessSlot } from '../src/jev.ts';
import { runFastLane } from '../src/run.ts';
import { optionalSectionsOf, type SectionJudge } from '../src/sections.ts';
import { isObject, type Json, type JsonObject } from '../src/spine.ts';
import { fakeModel, promptBlock } from './fixtures.ts';
import { mentionsSection, renderDropped, sectionIndex } from './helpers/optional-sections.ts';

const EXAMPLES = path.resolve(import.meta.dirname, '../../../plugins/_official/examples');

type Case = {
  family: string;
  id: string;
  type: string;
  /** Nav text slots that only point at the section, as `x-optional.navSlots` names them. */
  navSlots?: string[];
  /** Extra family-specific checks on the dropped page. */
  check?: (dropped: string, full: string) => void;
  /** `x-optional.requires: "quote"`: Jev is asked about the section only when the brief quotes someone. */
  requiresQuote?: boolean;
};

const CASES: Case[] = [
  { family: 'watson', id: 'watson-about', type: 'about' },
  { family: 'fervor', id: 'work', type: 'work', navSlots: ['sections[0].content.workLabel', 'sections[4].content.ctaLabel', 'sections[5].content.ctaLabel', 'sections[6].content.ctaLabel'] },
  { family: 'fervor', id: 'testimonial', type: 'testimonial' },
  { family: 'wrenfield', id: 'trust', type: 'trust' },
  {
    family: 'wrenfield',
    id: 'reviews',
    type: 'reviews',
    navSlots: ['sections[0].content.reviewsLabel'],
    check: (dropped, full) => {
      assert.ok(full.includes('href="#reviews"'), 'wrenfield: the full nav links to the reviews');
      assert.ok(!dropped.includes('href="#reviews"'), 'wrenfield: the nav reviews link is gone');
    },
  },
  { family: 'maben', id: 'maben-latest-projects', type: 'portfolio-carousel' },
  { family: 'halcyon', id: 'events', type: 'events', navSlots: ['sections[0].content.linkEvents'] },
  { family: 'halcyon', id: 'membership', type: 'membership', navSlots: ['sections[0].content.linkJoin', 'sections[9].content.col3Link4'] },
  { family: 'halcyon', id: 'support', type: 'support' },
  {
    family: 'maren',
    id: 'reviews',
    type: 'reviews',
    navSlots: ['sections[0].content.link4Label'],
    check: (dropped, full) => {
      assert.ok(full.includes('href="#reviews"'), 'maren: the full nav links to the reviews');
      assert.ok(!dropped.includes('href="#reviews"'), 'maren: the nav reviews link is gone');
    },
  },
  { family: 'emmpo', id: 'emmpo-community', type: 'community' },
  { family: 'marketing-site', id: 'marketing-site-proof', type: 'testimonials', requiresQuote: true },
  { family: 'app-shell', id: 'app-shell-empty', type: 'empty-state' },
  { family: 'crm-dashboard', id: 'crm-dashboard-activity', type: 'activity-feed' },
  { family: 'listings', id: 'listings-reviews', type: 'reviews' },
  { family: 'publication', id: 'publication-authors', type: 'authors' },
  { family: 'nonprofit', id: 'nonprofit-impact', type: 'impact' },
  { family: 'restaurant', id: 'restaurant-reviews', type: 'reviews' },
  { family: 'nonprofit', id: 'nonprofit-stories', type: 'stories' },
  // Nav is fixed chrome now (G5 round 2): NAV_LABELS/NAV_TARGET_ORDER generate the nav purely
  // from which sections render, so there is no model-writable nav-link slot left to null out.
  { family: 'nonprofit', id: 'nonprofit-events', type: 'events' },
  { family: 'docs-hub', id: 'docs-hub-api', type: 'api-reference' },
  { family: 'docs-hub', id: 'docs-hub-changelog', type: 'changelog' },
  { family: 'docs-hub', id: 'docs-hub-community', type: 'community-support' },
  { family: 'community', id: 'community-voices', type: 'voices', requiresQuote: true },
];

const BRIEF = 'Riverbend Dental, a family dental practice in Boise. Same-day crowns, sedation options, open Saturdays.';
/** The same brief with a customer quote in it, so a `requires: "quote"` section still goes to Jev. */
const QUOTED_BRIEF = `${BRIEF} A patient, Dana Ruiz, says "they fixed my crown the same day".`;

const load = (family: string): Promise<FamilyPackage> => loadFamilyPackage(path.join(EXAMPLES, `agency-${family}`), family);

/** The family's own `<FAMILY>_OPTIONAL_SECTIONS`, imported from its owning package's slots.ts. */
async function optionalSetOf(family: string): Promise<Set<string>> {
  const slots = await import(pathToFileURL(path.join(EXAMPLES, `agency-${family}`, 'compiler/scripts/families', family, 'slots.ts')).href) as Record<string, unknown>;
  const entry = Object.entries(slots).find(([name]) => name.endsWith('_OPTIONAL_SECTIONS'));
  assert.ok(entry, `${family}: slots.ts exports an OPTIONAL_SECTIONS set`);
  return new Set(entry[1] as Iterable<string>);
}

/** Every section type the schema marks `x-optional`, wherever the node sits (prefixItems or $defs). */
function schemaOptionalTypes(schema: Json, out = new Set<string>()): Set<string> {
  if (Array.isArray(schema)) schema.forEach((item) => schemaOptionalTypes(item, out));
  else if (isObject(schema)) {
    if (isObject(schema['x-optional'])) {
      const properties = isObject(schema.properties) ? schema.properties : {};
      const type = isObject(properties.type) ? properties.type.const : undefined;
      assert.equal(typeof type, 'string', 'an x-optional node is a section node with a type const');
      out.add(type as string);
    }
    for (const child of Object.values(schema)) schemaOptionalTypes(child, out);
  }
  return out;
}

/** The ids of every optional section a family's reference recipe carries, in page order. */
const optionalIdsOf = (family: string): string[] => CASES.filter((testCase) => testCase.family === family).map((testCase) => testCase.id);

/** A judge that drops `id` (every section it is asked about when `id` is absent) and keeps the
 * rest, and records what it was asked. */
function droppingJudge(asked: string[][], id?: string): SectionJudge {
  return {
    judge: async ({ optional }) => {
      const ids = optional.map((section) => section.id);
      asked.push(ids);
      const dropped = id === undefined ? ids : [id];
      return { dropped, kept: ids.filter((other) => !dropped.includes(other)), warnings: [], ms: 1, calls: 1 };
    },
  };
}

/** A faithfulness checker that flags nothing and records every slot path it was sent. */
function recordingChecker(paths: string[]): FaithfulnessChecker {
  return {
    checkFaithfulness: async ({ slots }: { slots: FaithfulnessSlot[] }) => {
      paths.push(...slots.map((slot) => slot.path));
      return { flagged: [], ms: 1, calls: 1 };
    },
  };
}

const lastKey = (label: string) => label.split('.').pop()!;

/** Answers every slot with the reference text it was shown: every family's own formats (emails,
 * prices, glyph sets) stay valid, and what is under test is only which sections get asked. */
const echo = () => fakeModel({ fill: (_key, value) => value });

for (const testCase of CASES) {
  test(`${testCase.family}: ${testCase.id} is the family's optional section, in the schema and in slots.ts`, async () => {
    const pkg = await load(testCase.family);
    const declared = await optionalSetOf(testCase.family);
    assert.deepEqual([...schemaOptionalTypes(pkg.schema)].sort(), [...declared].sort(), `${testCase.family}: schema x-optional equals OPTIONAL_SECTIONS`);
    assert.ok(declared.has(testCase.type));
    const optional = optionalSectionsOf(pkg.schema, pkg.fixture);
    assert.deepEqual(optional.map((section) => section.id), optionalIdsOf(testCase.family), `${testCase.family}: every optional section, in page order`);
    const own = optional.find((section) => section.id === testCase.id)!;
    assert.deepEqual(own.navSlots, testCase.navSlots ?? []);
    assert.ok(own.label && own.dropWhen && own.keepWhen, `${testCase.family}: x-optional carries the question text`);
  });

  test(`${testCase.family}: dropping ${testCase.id} renders valid HTML without it, its assets or its links`, async () => {
    const pkg = await load(testCase.family);
    const { dropped, full } = renderDropped(pkg, testCase.id);
    testCase.check?.(dropped.html, full.html);

    // A null anywhere else is still refused by the family contract.
    const recipe = structuredClone(pkg.fixture);
    const optionalIndex = sectionIndex(recipe, testCase.id);
    const required = optionalIndex === 0 ? 1 : 0;
    (recipe.sections as Json[])[required] = null;
    assert.throws(() => pkg.render(recipe, `${testCase.family}-r1.html`), `${testCase.family}: a null in a required slot is refused`);
  });

  test(`${testCase.family}: a build whose judge drops ${testCase.id} never fills, verifies or renders it`, async () => {
    const pkg = await load(testCase.family);
    const model = echo();
    const asked: string[][] = [];
    const checked: string[] = [];
    const events: BuildEvent[] = [];
    const deps: BuildDeps = {
      createModelCaller: () => model,
      createJevChecker: () => recordingChecker(checked),
      createJevRouter: () => { throw new Error('no routing in this test'); },
      createSectionJudge: () => droppingJudge(asked, testCase.id),
      resolveJevCredential: async () => 'fake-jev-key',
      resolveModelKey: async () => 'fake-model-key',
      daemonFetch: (async () => { throw new Error('a dry run never reaches the daemon'); }) as typeof fetch,
      acquireRunLock: async () => () => {},
    };
    const result = await buildSite({
      brief: testCase.requiresQuote ? QUOTED_BRIEF : BRIEF,
      family: testCase.family,
      mode: 'sections',
      revision: 1,
      verify: 'advisory',
      prepare: async () => ({ pkg, entry: `${testCase.family}-r1.html`, lockPaths: ['brand.name'] }),
      onEvent: (event) => events.push(event),
    }, deps);

    assert.equal(result.outcome, 'built');
    const report = (result as Extract<typeof result, { outcome: 'built' }>).report;
    const others = optionalIdsOf(testCase.family).filter((other) => other !== testCase.id);
    assert.deepEqual(asked, [optionalIdsOf(testCase.family)], 'one keep/drop request, about every optional section');
    const sections = events.find((event) => event.type === 'sections');
    assert.deepEqual(sections && { dropped: sections.dropped, kept: sections.kept, source: sections.source }, { dropped: [testCase.id], kept: others, source: 'jev' });
    assert.deepEqual(report.droppedSections, [testCase.id]);

    const index = sectionIndex(pkg.fixture, testCase.id);
    assert.equal((report.recipe as JsonObject & { sections: Json[] }).sections[index], null, 'the recipe keeps the slot, as null');
    assert.ok(!report.units.some((unit) => unit.label === testCase.id), 'no unit for the dropped section');
    for (const prompt of model.prompts) assert.ok(!prompt.includes(`"${testCase.id}"`), 'no prompt carries the dropped section');
    for (const slot of testCase.navSlots ?? []) {
      // Only the prompt for the slot's own section: another section may reuse the bare key (fervor's `ctaLabel`).
      const owner = (pkg.fixture.sections as JsonObject[])[Number(/^sections\[(\d+)\]/.exec(slot)![1])]!.id as string;
      const ownPrompts = model.prompts.filter((prompt) => prompt.includes(`Fill the "${owner}" part`));
      assert.ok(ownPrompts.length > 0, `the section holding ${slot} was filled`);
      for (const prompt of ownPrompts) assert.ok(!JSON.stringify(promptBlock(prompt, 'TEMPLATE')).includes(`"${lastKey(slot)}"`), `the nav slot ${slot} is locked`);
      assert.ok(!checked.includes(slot), `the nav slot ${slot} is not verified`);
    }
    assert.ok(checked.length > 0, 'the faithfulness check ran');
    assert.ok(!checked.some((slot) => slot.startsWith(`sections[${index}]`)), 'no faithfulness slot for the dropped section');
    assert.ok(!mentionsSection(report.html, testCase.id), 'the page does not render it');
  });
}

test('marketing-site: a brief that quotes no one drops the testimonials without asking Jev', async () => {
  const pkg = await load('marketing-site');
  const model = echo();
  const asked: string[][] = [];
  const checked: string[] = [];
  const events: BuildEvent[] = [];
  const deps: BuildDeps = {
    createModelCaller: () => model,
    createJevChecker: () => recordingChecker(checked),
    createJevRouter: () => { throw new Error('no routing in this test'); },
    createSectionJudge: () => droppingJudge(asked),
    resolveJevCredential: async () => 'fake-jev-key',
    resolveModelKey: async () => 'fake-model-key',
    daemonFetch: (async () => { throw new Error('a dry run never reaches the daemon'); }) as typeof fetch,
    acquireRunLock: async () => () => {},
  };
  const brief = `${BRIEF} Feature testimonials from happy patients and a review from a local school.`;
  const result = await buildSite({
    brief, family: 'marketing-site', mode: 'sections', revision: 1, verify: 'advisory',
    prepare: async () => ({ pkg, entry: 'marketing-site-r1.html', lockPaths: ['brand.name'] }),
    onEvent: (event) => events.push(event),
  }, deps);
  assert.equal(result.outcome, 'built');
  assert.deepEqual(asked, [], 'asking for testimonials is not supplying them: Jev is not asked');
  const sections = events.find((event) => event.type === 'sections');
  assert.deepEqual(sections && { dropped: sections.dropped, kept: sections.kept, source: sections.source }, { dropped: ['marketing-site-proof'], kept: [], source: 'brief' });
  assert.ok(!checked.some((slot) => slot.startsWith('sections[2]')), 'no testimonial slot reaches the faithfulness gate');
  for (const prompt of model.prompts) assert.ok(!prompt.includes('"marketing-site-proof"'), 'no prompt asks for a testimonial');
});

test('verify off, and a repair, never ask the judge; hints still apply', async () => {
  const pkg = await load('wrenfield');
  const asked: string[][] = [];
  const base = {
    brief: BRIEF,
    family: 'wrenfield',
    mode: 'sections' as const,
    revision: 1,
    prepare: async () => ({ pkg, entry: 'wrenfield-r1.html' }),
  };
  const deps: BuildDeps = {
    createModelCaller: () => echo(),
    createJevChecker: () => recordingChecker([]),
    createJevRouter: () => { throw new Error('no routing'); },
    createSectionJudge: () => droppingJudge(asked),
    resolveJevCredential: async () => 'k',
    resolveModelKey: async () => 'k',
    daemonFetch: (async () => { throw new Error('dry run'); }) as typeof fetch,
    acquireRunLock: async () => () => {},
  };
  const off = await buildSite({ ...base, verify: 'off' }, deps);
  assert.equal(off.outcome, 'built');
  assert.equal((off as Extract<typeof off, { outcome: 'built' }>).report.droppedSections, undefined, 'verify off keeps every section');

  const repair = await buildSite({ ...base, verify: 'advisory', judgeSections: false }, deps);
  assert.equal((repair as Extract<typeof repair, { outcome: 'built' }>).report.droppedSections, undefined);
  assert.deepEqual(asked, [], 'the judge was never asked');

  const hinted = await buildSite({ ...base, verify: 'off', sections: { reviews: 'drop' } }, deps);
  assert.deepEqual((hinted as Extract<typeof hinted, { outcome: 'built' }>).report.droppedSections, ['reviews'], 'a drop hint applies without Jev');
  assert.deepEqual(asked, []);

  // A repair re-fills a published recipe that already dropped the section: it stays dropped.
  const published = (hinted as Extract<typeof hinted, { outcome: 'built' }>).report.recipe as JsonObject;
  const again = await buildSite({ ...base, verify: 'advisory', judgeSections: false, prepare: async () => ({ pkg, entry: 'wrenfield-r1.html', spine: structuredClone(published) }) }, deps);
  assert.deepEqual((again as Extract<typeof again, { outcome: 'built' }>).report.droppedSections, ['reviews'], 'the null survives a repair without re-judging');
  assert.deepEqual(asked, []);
});

test('verify off needs no Jev: a missing credential keeps every section; any other mode aborts first', async () => {
  const pkg = await load('wrenfield');
  const asked: string[][] = [];
  const events: BuildEvent[] = [];
  let credentialReads = 0;
  const deps: BuildDeps = {
    createModelCaller: () => echo(),
    createJevChecker: () => { throw new Error('verify off never builds a checker'); },
    createJevRouter: () => { throw new Error('no routing'); },
    createSectionJudge: () => droppingJudge(asked),
    resolveJevCredential: async () => { credentialReads += 1; throw new Error('zsvault returned no value for typesafe_api_key'); },
    resolveModelKey: async () => 'k',
    daemonFetch: (async () => { throw new Error('dry run'); }) as typeof fetch,
    acquireRunLock: async () => () => {},
  };
  const base = {
    brief: BRIEF,
    family: 'wrenfield',
    mode: 'sections' as const,
    revision: 1,
    prepare: async () => ({ pkg, entry: 'wrenfield-r1.html' }),
    onEvent: (event: BuildEvent) => events.push(event),
  };

  const off = await buildSite({ ...base, verify: 'off' }, deps);
  assert.equal(off.outcome, 'built');
  assert.equal((off as Extract<typeof off, { outcome: 'built' }>).report.droppedSections, undefined, 'every section kept');
  const decided = events.find((event) => event.type === 'sections');
  assert.deepEqual(decided && { kept: decided.kept, dropped: decided.dropped }, { kept: ['trust', 'reviews'], dropped: [] });
  assert.deepEqual(asked, [], 'the judge was never asked');
  assert.equal(credentialReads, 0, 'the credential was never read');

  await assert.rejects(buildSite({ ...base, verify: 'strict' }, deps), JevCredentialError, 'strict needs Jev for the gate');
  assert.deepEqual(asked, []);
});

test('single mode: the whole-page prompt shows only the sections the page renders', async () => {
  const pkg = await load('watson');
  const model = echo();
  const report = await runFastLane({
    pkg,
    brief: BRIEF,
    mode: 'single',
    entry: 'watson-r1.html',
    revision: 1,
    model,
    modelName: 'fake',
    lockPaths: ['brand.name'],
    dropSections: ['watson-about'],
  });
  assert.equal(model.prompts.length, 1);
  const template = promptBlock(model.prompts[0]!, 'TEMPLATE') as JsonObject;
  const ids = (template.sections as JsonObject[]).map((section) => section.id);
  assert.deepEqual(ids, ['watson-navigation', 'watson-hero', 'watson-statement', 'watson-footer']);
  assert.match(model.prompts[0]!, /It has 4 sections/);
  assert.deepEqual(report.missing, [], 'nothing reported missing for the dropped slot');
  assert.deepEqual(report.droppedSections, ['watson-about']);
});

test('emmpo: a reordered recipe keeps the dropped section\'s identity through the build, a repair and a keep hint', async () => {
  const pkg = await load('emmpo');
  // Emmpo lets its middle sections reorder: move the optional community section from 7 to 2.
  const reordered = structuredClone(pkg.fixture);
  const sections = reordered.sections as Json[];
  const [community] = sections.splice(sectionIndex(reordered, 'emmpo-community'), 1);
  sections.splice(2, 0, community!);
  assert.equal(sectionIndex(reordered, 'emmpo-community'), 2);
  assert.doesNotThrow(() => pkg.render(reordered, 'emmpo-r1.html'), 'the reordered recipe is valid');

  const asked: string[][] = [];
  const events: BuildEvent[] = [];
  const deps: BuildDeps = {
    createModelCaller: () => echo(),
    createJevChecker: () => recordingChecker([]),
    createJevRouter: () => { throw new Error('no routing'); },
    createSectionJudge: () => droppingJudge(asked),
    resolveJevCredential: async () => 'k',
    resolveModelKey: async () => 'k',
    daemonFetch: (async () => { throw new Error('dry run'); }) as typeof fetch,
    acquireRunLock: async () => () => {},
  };
  const base = { brief: BRIEF, family: 'emmpo', mode: 'sections' as const, revision: 1, onEvent: (event: BuildEvent) => events.push(event) };
  const built = await buildSite({ ...base, verify: 'advisory', prepare: async () => ({ pkg, entry: 'emmpo-r1.html', lockPaths: ['brand.name'], spine: structuredClone(reordered) }) }, deps);
  assert.equal(built.outcome, 'built');
  const report = (built as Extract<typeof built, { outcome: 'built' }>).report;
  assert.deepEqual(asked, [['emmpo-community']]);
  assert.deepEqual(report.droppedSections, ['emmpo-community']);
  const published = report.recipe as JsonObject;
  assert.equal((published.sections as Json[])[2], null, 'the null sits where the recipe had the section');
  assert.equal(((published.sections as JsonObject[])[7]!).id, 'emmpo-talents', 'the other sections are untouched');

  // The null is identified by the type the page no longer has, not by the fixture's position 2.
  const optional = optionalSectionsOf(pkg.schema, published, pkg.fixture);
  assert.deepEqual(optional.map(({ index, id, type, dropped }) => ({ index, id, type, dropped })), [{ index: 2, id: 'emmpo-community', type: 'community', dropped: true }]);

  // A repair re-fills without re-judging and reports the same id.
  const repaired = await buildSite({ ...base, verify: 'advisory', judgeSections: false, prepare: async () => ({ pkg, entry: 'emmpo-r1.html', lockPaths: ['brand.name'], spine: structuredClone(published) }) }, deps);
  assert.deepEqual((repaired as Extract<typeof repaired, { outcome: 'built' }>).report.droppedSections, ['emmpo-community']);
  assert.equal((((repaired as Extract<typeof repaired, { outcome: 'built' }>).report.recipe as JsonObject).sections as Json[])[2], null);
  assert.equal(asked.length, 1, 'the repair never asked the judge');

  // A keep hint restores the community section at the null's own position.
  const restored = await buildSite({ ...base, verify: 'off', sections: { 'emmpo-community': 'keep' }, prepare: async () => ({ pkg, entry: 'emmpo-r1.html', lockPaths: ['brand.name'], spine: structuredClone(published) }) }, deps);
  const restoredRecipe = (restored as Extract<typeof restored, { outcome: 'built' }>).report.recipe as JsonObject;
  assert.equal(((restoredRecipe.sections as JsonObject[])[2]!).type, 'community');
  assert.equal((restored as Extract<typeof restored, { outcome: 'built' }>).report.droppedSections, undefined);
});
