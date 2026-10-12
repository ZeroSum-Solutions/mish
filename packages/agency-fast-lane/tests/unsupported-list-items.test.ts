/**
 * R1–R3 (Devin, 2026-10-10): typical Home Jev briefs failed strict verify over list items the brief
 * never supported — docs-hub lists, storefront's product details, practice's hours rows for a brief
 * with no hours (a law firm). A list the family marks droppable (`x-drop: 'items'`) now drops an item
 * still flagged once the faithfulness repairs are spent, down to its minimum; an hours list drops
 * all of its rows or none. Procedural lists (docs-hub's quickstart steps) are never cut: a gapped
 * procedure is worse than a refused build (Sol review of #286, BLOCK 1). Locked content is never
 * removed or shifted (WARN 2). Every case asserts the whole build: the strict verdict, what was
 * published and the recipe (WARN 3).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { loadFamilyPackage } from '../src/family.ts';
import type { ProjectPublisher } from '../src/publish.ts';
import { runFastLane, type RunOptions } from '../src/run.ts';
import { isObject, type Json, type JsonObject } from '../src/spine.ts';
import { fakeJevChecker, fakeModel, fillTemplate, type Filler } from './fixtures.ts';

const EXAMPLES = path.join(import.meta.dirname, '../../../plugins/_official/examples');
const briefOf = (family: string) => readFileSync(path.join(EXAMPLES, `agency-${family}`, 'compiler/scripts/families', family, 'reference.fixture.brief.txt'), 'utf8');
const STOREFRONT_BRIEF = readFileSync(path.join(EXAMPLES, 'agency-storefront/fixtures/briefs/rich.txt'), 'utf8');
const keep: Filler = (_key, value) => value;

/** A first answer that writes FABRICATED into `field` of the listed items of the unit whose list matches. */
function inventItems(matches: (items: JsonObject[]) => boolean, field: string, indexes: number[]) {
  return (template: Json, limits: Json | undefined): Json | undefined => {
    if (!isObject(template) || !Array.isArray(template.items) || !matches(template.items as JsonObject[])) return undefined;
    const filled = fillTemplate(template, limits, keep) as JsonObject;
    for (const index of indexes) {
      const item = (filled.items as JsonObject[])[index];
      if (item) item[field] = `FABRICATED ${field} ${index}`;
    }
    return filled;
  };
}
const withCount = (count: number, key: string) => (items: JsonObject[]) => items.length === count && items.every((item) => isObject(item) && key in item);

const itemsOf = (recipe: Json, section: number) => (((recipe as JsonObject).sections as JsonObject[])[section]!.items as JsonObject[]);

type Recorded = { report: Awaited<ReturnType<typeof runFastLane>>; pages: string[] };
async function run(family: string, brief: string, extra: { firstAnswer?: ReturnType<typeof inventItems>; fill?: Filler; lockPaths?: string[]; dropSections?: string[] } = {}): Promise<Recorded> {
  const pkg = await loadFamilyPackage(path.join(EXAMPLES, `agency-${family}`), family);
  const pages: string[] = [];
  const publisher: ProjectPublisher = {
    projectId: 'p1',
    async savePage(_entry, html) { pages.push(html); },
    async saveFile() {},
    async deleteProject() { return 'deleted' as const; },
  };
  const options: RunOptions = {
    pkg, brief, mode: 'sections', entry: 'p.html', revision: 1,
    model: fakeModel({ fill: extra.fill ?? keep, ...(extra.firstAnswer ? { firstAnswer: extra.firstAnswer } : {}) }),
    modelName: 'fake', verify: fakeJevChecker(), strict: true, maxFaithfulnessRounds: 0,
    ...(extra.lockPaths ? { lockPaths: extra.lockPaths } : {}),
    ...(extra.dropSections ? { dropSections: extra.dropSections } : {}),
    ensurePublisher: async () => ({ publisher, created: true }),
  };
  return { report: await runFastLane(options), pages };
}

/** The build passed strict verify and published exactly the page the report returns. */
function assertPublished({ report, pages }: Recorded) {
  assert.equal(report.strict?.passed, true, `strict passed; remaining: ${JSON.stringify(report.verify?.remaining)}`);
  assert.equal(report.verify!.remaining.length, 0);
  assert.ok(pages.length > 0, 'the page was published');
  assert.equal(pages.at(-1), report.html);
}

/** The build was refused and nothing was published. */
function assertRefused({ report, pages }: Recorded) {
  assert.equal(report.strict?.passed, false);
  assert.equal(pages.length, 0, 'nothing was published');
}

test('docs-hub: invented guides are dropped from the droppable guides list, and the build publishes', async () => {
  const recorded = await run('docs-hub', briefOf('docs-hub'), { firstAnswer: inventItems(withCount(6, 'description'), 'title', [4, 5]) });
  assertPublished(recorded);
  assert.equal(itemsOf(recorded.report.recipe, 3).length, 4);
  assert.ok(!recorded.pages.at(-1)!.includes('FABRICATED'));
});

test('docs-hub: an invented quickstart step is never cut out of the procedure — the build is refused', async () => {
  const recorded = await run('docs-hub', briefOf('docs-hub'), { firstAnswer: inventItems(withCount(5, 'description'), 'title', [1]) });
  assertRefused(recorded);
  assert.equal(itemsOf(recorded.report.recipe, 2).length, 5, 'no step was removed');
  assert.ok(recorded.report.verify!.remaining.includes('sections[2].items[1].title'));
});

test('storefront: an invented product detail row is dropped, and the build publishes', async () => {
  // The rest of the page is brief-true: collection blurbs say only what the brief says.
  const fill: Filler = (key, value) => (key === 'blurb' ? 'Undyed cotton canvas, made in Portland.' : value);
  const recorded = await run('storefront', STOREFRONT_BRIEF, { fill, firstAnswer: inventItems(withCount(3, 'label'), 'value', [2]) });
  assertPublished(recorded);
  assert.equal(itemsOf(recorded.report.recipe, 4).length, 2);
  assert.ok(!recorded.pages.at(-1)!.includes('FABRICATED'));
});

test('practice: a brief with no hours drops every invented hours row, and the build publishes', async () => {
  const brief = briefOf('practice').replace(/Hours: Monday-Thursday 8am-5pm, Friday 8am-2pm, closed Saturday and Sunday\. /, '');
  assert.notEqual(brief, briefOf('practice'));
  // The model titles the section for what it shows (address, phone), not "Hours" the brief never gave.
  // As the section judge would for this brief: no visit steps and no insurance are stated, so those optional sections are dropped.
  const recorded = await run('practice', brief, { fill: (key, value) => (key === 'heading' && value === 'Hours' ? 'Visit us' : value), dropSections: ['practice-expect', 'practice-insurance'] });
  assertPublished(recorded);
  assert.equal(itemsOf(recorded.report.recipe, 9).length, 0);
});

test('a list is never cut below its minimum: the flag stands and nothing is published', async () => {
  const recorded = await run('docs-hub', briefOf('docs-hub'), { firstAnswer: inventItems(withCount(6, 'description'), 'title', [0, 1, 2, 3, 4, 5]) });
  assertRefused(recorded);
  assert.ok(itemsOf(recorded.report.recipe, 3).length >= 1);
});

test('locked content is never removed or shifted: a lock at or after a flagged item keeps the list whole', async () => {
  // Item 4 is invented; item 5 is locked. Removing item 4 would move the locked item to index 4,
  // where its lock no longer applies, so the list is left whole and the flag stands.
  const recorded = await run('docs-hub', briefOf('docs-hub'), { firstAnswer: inventItems(withCount(6, 'description'), 'title', [4]), lockPaths: ['sections[3].items[5].title'] });
  assertRefused(recorded);
  assert.equal(itemsOf(recorded.report.recipe, 3).length, 6);
});

test('a list whose own copy states its size ("Six guides") is never shortened: the flag stands', async () => {
  const sixGuides = (template: Json, limits: Json | undefined): Json | undefined => {
    const filled = inventItems(withCount(6, 'description'), 'title', [5])(template, limits) as JsonObject | undefined;
    if (filled && isObject(filled.text)) (filled.text as JsonObject).heading = 'Six guides';
    return filled;
  };
  const recorded = await run('docs-hub', briefOf('docs-hub'), { firstAnswer: sixGuides });
  assertRefused(recorded);
  assert.equal(itemsOf(recorded.report.recipe, 3).length, 6);
});

test('an hours list keeps every row when only some shown rows are flagged: a brief-stated row is never dropped', async () => {
  // The brief's three rows, copied verbatim; Jev doubts only the middle one.
  const rows: Array<[string, string]> = [['Monday-Thursday', '8am-5pm'], ['Friday', '8am-2pm'], ['Saturday and Sunday', 'closed']];
  const verbatimHours = (template: Json, limits: Json | undefined): Json | undefined => {
    if (!isObject(template) || !Array.isArray(template.items) || !withCount(3, 'value')(template.items as JsonObject[]) || !(template.items as JsonObject[]).every((item) => 'label' in item)) return undefined;
    const filled = fillTemplate(template, limits, keep) as JsonObject;
    (filled.items as JsonObject[]).forEach((item, index) => { item.label = rows[index]![0]; item.value = rows[index]![1]; });
    return filled;
  };
  const pkg = await loadFamilyPackage(path.join(EXAMPLES, 'agency-practice'), 'practice');
  const pages: string[] = [];
  const report = await runFastLane({
    pkg, brief: briefOf('practice'), mode: 'sections', entry: 'p.html', revision: 1, model: fakeModel({ fill: keep, firstAnswer: verbatimHours }), modelName: 'fake',
    verify: { async checkFaithfulness({ slots }: { slots: Array<{ path: string; text: string }> }) { return { flagged: slots.filter((slot) => slot.path === 'sections[9].items[1].label').map((slot) => ({ path: slot.path, probability: 0.95 })), ms: 1, calls: 1 }; } },
    strict: true, maxFaithfulnessRounds: 0,
    ensurePublisher: async () => ({ publisher: { projectId: 'p1', async savePage(_e: string, html: string) { pages.push(html); }, async saveFile() {}, async deleteProject() { return 'deleted' as const; } }, created: true }),
  });
  assert.equal(itemsOf(report.recipe, 9).length, 3, 'no hours row was dropped');
  assert.ok(report.verify!.remaining.includes('sections[9].items[1].label'));
  assert.equal(report.strict?.passed, false);
  assert.equal(pages.length, 0);
});

test('a heading that states a different size than its shortened list is flagged, however the list got shorter', async () => {
  // First answer: five guides under "Six guides" (no removal involved). The heading is flagged; with
  // no repair round it stays flagged and the build is refused.
  const fiveUnderSix = (template: Json, limits: Json | undefined): Json | undefined => {
    if (!isObject(template) || !Array.isArray(template.items) || !withCount(6, 'description')(template.items as JsonObject[])) return undefined;
    const filled = fillTemplate(template, limits, keep) as JsonObject;
    (filled.items as JsonObject[]).splice(5, 1);
    if (isObject(filled.text)) (filled.text as JsonObject).heading = 'Six guides for Loomwork';
    return filled;
  };
  // The brief itself says "Six guides for Loomwork", so the heading is faithful to the brief; only its
  // disagreement with the five cards on the page can flag it.
  const recorded = await run('docs-hub', `${briefOf('docs-hub')}\nGuides: Six guides for Loomwork.`, { firstAnswer: fiveUnderSix });
  assertRefused(recorded);
  assert.ok(recorded.report.verify!.remaining.includes('sections[3].text.heading'));
});

for (const heading of ['One place to start', 'Loomwork 2.0 guides']) {
  test(`a heading with a number that is not a list size ("${heading}") is never flagged as a count claim`, async () => {
    // Sol review of #286, round 4: "one" in a phrase and a version number read as list sizes, so a
    // brief-true heading over five guides was flagged and the build refused.
    const fiveUnder = (template: Json, limits: Json | undefined): Json | undefined => {
      if (!isObject(template) || !Array.isArray(template.items) || !withCount(6, 'description')(template.items as JsonObject[])) return undefined;
      const filled = fillTemplate(template, limits, keep) as JsonObject;
      (filled.items as JsonObject[]).splice(5, 1);
      if (isObject(filled.text)) (filled.text as JsonObject).heading = heading;
      return filled;
    };
    const recorded = await run('docs-hub', `${briefOf('docs-hub')}\nGuides heading: ${heading}.`, { firstAnswer: fiveUnder });
    assertPublished(recorded);
    assert.equal(itemsOf(recorded.report.recipe, 3).length, 5);
  });
}

for (const heading of ['Six how-to guides', 'Six step-by-step guides', 'Guides (6)']) {
  test(`a hyphenated or bracketed size ("${heading}") over a shortened list is still flagged`, async () => {
    // Sol review of #286, round 5: the plural-noun matcher missed these ordinary count headings.
    const fiveUnder = (template: Json, limits: Json | undefined): Json | undefined => {
      if (!isObject(template) || !Array.isArray(template.items) || !withCount(6, 'description')(template.items as JsonObject[])) return undefined;
      const filled = fillTemplate(template, limits, keep) as JsonObject;
      (filled.items as JsonObject[]).splice(5, 1);
      if (isObject(filled.text)) (filled.text as JsonObject).heading = heading;
      return filled;
    };
    const recorded = await run('docs-hub', `${briefOf('docs-hub')}\nGuides heading: ${heading}.`, { firstAnswer: fiveUnder });
    assertRefused(recorded);
    assert.ok(recorded.report.verify!.remaining.includes('sections[3].text.heading'));
  });
}
