/**
 * `x-mock` illustrative slots: the schema marks on the three application page kinds, the
 * `mockPathsFor` walker that reads them (next to a `$ref`, inside a nullable `oneOf`, inherited by
 * every leaf below), the `derefSchema` fix that lets limits and `x-atom` group kinds reach the
 * slots behind a `$ref` or a `oneOf`, and a run that never sends an illustrative slot to the
 * faithfulness check while it reports how many it skipped.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { defaultPackageDir, loadFamilyPackage, type FamilyPackage } from '../src/family.ts';
import type { FaithfulnessChecker, FaithfulnessSlot } from '../src/jev.ts';
import { collectFaithfulnessSlots, repairLockPaths } from '../src/jev.ts';
import { runFastLane, type RunEvent } from '../src/run.ts';
import { atomKindsFor, editableTemplate, getAtPath, limitsFor, mockPathsFor, nullablePathsOf, type Json, type JsonObject } from '../src/spine.ts';
import { fakeModel, fillTemplate } from './fixtures.ts';
import { assertCaptionBacksEveryMockValue } from './helpers/mock-caption.ts';

const load = (family: string): Promise<FamilyPackage> => loadFamilyPackage(defaultPackageDir(family), family);

const range = (count: number) => Array.from({ length: count }, (_, index) => index);
const rows = (prefix: string, count: number, keys: string[]) => range(count).flatMap((index) => keys.map((key) => `${prefix}[${index}].${key}`));

const EXPECTED: Record<string, { total: number; mock: string[] }> = {
  'crm-dashboard': {
    total: 83,
    mock: [
      ...rows('sections[0].items', 4, ['value', 'delta']),
      ...rows('sections[1].items', 5, ['company', 'owner', 'stage', 'value', 'nextStep']),
      ...rows('sections[2].items', 6, ['when', 'who', 'what']),
      ...['name', 'role', 'company', 'email', 'phone', 'note'].map((key) => `sections[3].text.${key}`),
      ...range(4).map((index) => `sections[4].items.owner[${index}]`),
      ...range(8).map((index) => `sections[5].items.values[${index}].label`),
    ],
  },
  'app-shell': {
    total: 64,
    mock: [
      'sections[0].items.user',
      ...rows('sections[3].items', 5, ['name', 'status', 'owner', 'updated']),
      // The detail view's record name sits under the same "Sample data" caption as its values.
      'sections[4].text.heading',
      ...range(5).map((index) => `sections[4].items[${index}].value`),
    ],
  },
  'marketing-site': {
    total: 62,
    // Pricing only: testimonials stay fact-checked (a nullable section the brief must support).
    mock: rows('sections[3].items', 3, ['name', 'price', 'period', 'features[0]', 'features[1]', 'features[2]', 'cta']),
  },
};

for (const [family, expected] of Object.entries(EXPECTED)) {
  test(`${family}: the schema marks exactly the illustrative slots, on the package recipe`, async () => {
    const pkg = await load(family);
    const template = editableTemplate(pkg.fixture)!;
    const mock = mockPathsFor(pkg.schema, template);
    assert.deepEqual([...mock].sort(), [...expected.mock].sort());
    assert.equal(collectFaithfulnessSlots(pkg.fixture).length, expected.total);
    // Every mock path is a real text slot of the recipe, never a path the gate would not see.
    const slotPaths = new Set(collectFaithfulnessSlots(pkg.fixture).map((slot) => slot.path));
    for (const path of mock) assert.ok(slotPaths.has(path), `${path} is a text slot`);
    assert.equal(collectFaithfulnessSlots(pkg.fixture, new Set(), mock).length, expected.total - expected.mock.length);
  });
}

test('mockPathsFor: the mark is read next to a $ref, inside a nullable oneOf, and inherited', () => {
  const schema: JsonObject = {
    type: 'object',
    properties: {
      a: { $ref: '#/$defs/pair', 'x-mock': true },
      b: { oneOf: [{ type: 'null' }, { type: 'array', items: { $ref: '#/$defs/pair' } }], 'x-mock': true },
      c: { $ref: '#/$defs/markedPair' },
      d: { $ref: '#/$defs/pair' },
    },
    $defs: {
      pair: { type: 'object', properties: { x: { type: 'string' }, y: { type: 'string' } } },
      markedPair: { 'x-mock': true, type: 'object', properties: { x: { type: 'string' } } },
    },
  };
  const template: Json = { a: { x: 'one', y: 'two' }, b: [{ x: 'three', y: null }], c: { x: 'four' }, d: { x: 'five', y: 'six' } };
  assert.deepEqual([...mockPathsFor(schema, template)], ['a.x', 'a.y', 'b[0].x', 'b[0].y', 'c.x']);
});

test('derefSchema fix: limits and group x-atom kinds reach slots behind a $ref or a oneOf', async () => {
  const crm = await load('crm-dashboard');
  const template = editableTemplate(crm.fixture)!;
  const limits = limitsFor(crm.schema, template);
  // kpis[2] is `{ $ref: kpiItemOrNull, x-atom }`, the activity feed and the chart a nullable oneOf.
  assert.deepEqual(getAtPath(limits, ['sections', 0, 'items', 2]), { label: 40, value: 24, delta: 24 });
  assert.deepEqual(getAtPath(limits, ['sections', 2, 'items', 0]), { when: 24, who: 40, what: 140 });
  assert.deepEqual(getAtPath(limits, ['sections', 5, 'text']), { title: 60, unit: 12 });
  assert.deepEqual([...nullablePathsOf(atomKindsFor(crm.schema, template))], [
    'sections[0].items[2]', 'sections[0].items[3]', 'sections[2].items', 'sections[5].text', 'sections[5].items',
  ]);

  const app = await load('app-shell');
  const appTemplate = editableTemplate(app.fixture)!;
  assert.deepEqual([...nullablePathsOf(atomKindsFor(app.schema, appTemplate))], [
    'sections[1].items[2]', 'sections[1].items[3]', 'sections[5].items[0]', 'sections[5].items[1]', 'sections[5].items[2]',
  ]);
  assert.deepEqual(getAtPath(limitsFor(app.schema, appTemplate), ['sections', 5, 'items', 0]), { heading: 40, body: 160 });

  const site = await load('marketing-site');
  const siteTemplate = editableTemplate(site.fixture)!;
  const footerLinks = [0, 1, 2].flatMap((column) => [0, 1, 2].map((link) => `sections[5].items.columns[${column}].links[${link}]`));
  assert.deepEqual([...nullablePathsOf(atomKindsFor(site.schema, siteTemplate))], ['sections[2].items', 'sections[3].items', ...footerLinks]);
  assert.deepEqual(getAtPath(limitsFor(site.schema, siteTemplate), ['sections', 3, 'items', 0, 'price']), 16);
});

/** Records every slot the gate is asked about; flags none. */
function recordingChecker(): FaithfulnessChecker & { seen: FaithfulnessSlot[] } {
  const checker = {
    seen: [] as FaithfulnessSlot[],
    async checkFaithfulness({ slots }: { slots: FaithfulnessSlot[] }) {
      checker.seen.push(...slots);
      return { flagged: [], ms: 1, calls: 1 };
    },
  };
  return checker;
}

/** Contact-card formats the crm-dashboard contract checks. */
const crmFill = (key: string, _value: string, _at: string, limit?: number) => {
  if (key === 'email') return 'pat@example.com';
  if (key === 'phone') return '555-0100';
  const text = `New ${key}`;
  return typeof limit === 'number' ? text.slice(0, limit) : text;
};

for (const verifyAfterPublish of [false, true]) {
  test(`run (${verifyAfterPublish ? 'verify after publish' : 'verify before publish'}): no illustrative slot reaches the gate; the verify event counts them`, async () => {
    const pkg = await load('crm-dashboard');
    const checker = recordingChecker();
    const events: RunEvent[] = [];
    const report = await runFastLane({
      pkg,
      brief: 'Harbor Freight Co brokers freight across the Gulf Coast.',
      mode: 'sections',
      entry: 'crm-dashboard-r1.html',
      revision: 1,
      model: fakeModel({ fill: crmFill }),
      modelName: 'fake',
      verify: checker,
      verifyAfterPublish,
      onEvent: (event) => events.push(event),
    });
    const mock = new Set(EXPECTED['crm-dashboard']!.mock);
    assert.ok(checker.seen.length > 0);
    for (const slot of checker.seen) assert.ok(!mock.has(slot.path), `${slot.path} is illustrative and must not be checked`);
    const verify = events.find((event) => event.type === 'verify');
    assert.ok(verify && verify.type === 'verify');
    assert.equal(verify.illustrative, 69);
    assert.equal(verify.checked, 14);
    assert.equal(report.verify?.illustrative, 69);
  });
}

test('x-atom group fix: the model may null a whole nullable group, and the contract accepts it', async () => {
  const pkg = await load('crm-dashboard');
  const model = fakeModel({
    fill: crmFill,
    firstAnswer: (template, limits) => {
      const filled = fillTemplate(template, limits, crmFill);
      if (!(typeof filled === 'object' && filled !== null && !Array.isArray(filled))) return filled;
      const answer = filled as JsonObject;
      if (answer.id === 'crm-dashboard-activity') answer.items = null;
      return answer;
    },
  });
  const report = await runFastLane({ pkg, brief: 'Harbor Freight Co brokers freight.', mode: 'sections', entry: 'crm-dashboard-r1.html', revision: 1, model, modelName: 'fake' });
  assert.deepEqual(report.nulled, ['sections[2].items']);
  assert.equal(getAtPath(report.recipe, ['sections', 2, 'items']), null);
  assert.ok(model.prompts.some((prompt) => prompt.includes('NULLABLE') && prompt.includes('"activity-feed"')), 'the prompt names the group as nullable');
});

// Review fix (M6): the repair locks every illustrative slot explicitly, even one a flag names,
// so a repair never re-generates x-mock sample data.
for (const family of Object.keys(EXPECTED)) {
  test(`${family}: repairLockPaths keeps every x-mock slot locked, even a flagged one`, async () => {
    const pkg = await load(family);
    const mock = [...mockPathsFor(pkg.schema, editableTemplate(pkg.fixture)!)];
    const slots = collectFaithfulnessSlots(pkg.fixture).map((slot) => slot.path);
    const fact = slots.find((path) => !mock.includes(path))!;
    const flaggedMock = mock[0]!;
    const locked = new Set(repairLockPaths(pkg.fixture, [fact, flaggedMock], pkg.schema));
    for (const path of mock) assert.ok(locked.has(path), `${path} stays locked`);
    assert.equal(locked.has(fact), false, 'the flagged fact slot is re-generated');
    for (const path of slots) if (path !== fact) assert.ok(locked.has(path), `${path} stays locked`);
  });
}

// Review fix (M6, pass 2): a repair locks every unflagged editable leaf, including a nulled
// non-mock group (marketing testimonials) and an empty string. A repair of an unrelated flag must
// not show that null group to the model, where it could come back as brand-new testimonials.
test('marketing-site: repairLockPaths locks nulled testimonials and empty strings', async () => {
  const pkg = await load('marketing-site');
  const recipe = structuredClone(pkg.fixture) as JsonObject;
  const sections = recipe.sections as JsonObject[];
  assert.equal(sections[2]!.id, 'marketing-site-proof');
  sections[2]!.items = null;
  const heroText = sections[0]!.text as JsonObject;
  const [emptyKey, flaggedKey] = Object.keys(heroText).filter((key) => typeof heroText[key] === 'string');
  heroText[emptyKey!] = '';
  const flagged = `sections[0].text.${flaggedKey}`;
  const locked = new Set(repairLockPaths(recipe, [flagged], pkg.schema));
  assert.ok(locked.has('sections[2].items'), 'the nulled testimonials group stays locked');
  assert.ok(locked.has(`sections[0].text.${emptyKey}`), 'an empty string stays locked');
  assert.equal(locked.has(flagged), false, 'the flagged fact slot is re-generated');
  assert.equal([...locked].some((path) => path.endsWith('.id')), false, 'section anchors stay visible to the fill');

  // The repair run itself (a valid recipe, so no empty string): the model never sees the null
  // group, and a model that would invent testimonials anyway cannot write them.
  heroText[emptyKey!] = (pkg.fixture as any).sections[0].text[emptyKey!];
  const runLocked = repairLockPaths(recipe, [flagged], pkg.schema);
  assert.ok(runLocked.includes('sections[2].items'));
  const templates: Json[] = [];
  const model = fakeModel({
    firstAnswer: (template, limits) => {
      templates.push(template);
      const filled = fillTemplate(template, limits);
      if (isRecord(filled) && filled.id === 'marketing-site-proof') {
        filled.items = [{ quote: 'Invented praise.', name: 'Nobody', role: 'Invented' }];
      }
      return filled;
    },
  });
  const report = await runFastLane({
    pkg, brief: 'Ledgerly does bookkeeping.', mode: 'sections', entry: 'marketing-site-r2.html', revision: 2,
    model, modelName: 'fake', spine: recipe, lockPaths: runLocked,
  });
  assert.equal(getAtPath(report.recipe, ['sections', 2, 'items']), null, 'testimonials stay null');
  const proofTemplate = templates.find((template) => isRecord(template) && template.id === 'marketing-site-proof');
  if (proofTemplate !== undefined) assert.equal('items' in (proofTemplate as JsonObject), false, 'the null group is not shown');
  assert.ok(templates.length > 0, 'the repair still filled the flagged unit');
});

// Review fix (M6, pass 3): the lock LIST is necessary, not sufficient. This runs the repair with
// a model that rewrites every string it is shown and asserts the repaired RECIPE: every x-mock
// slot (the flagged one included) still holds the package's sample text, and the flagged fact slot
// is the one that changed.
const labelSegments = (label: string): Array<string | number> =>
  (label.match(/[^.[\]]+/g) ?? []).map((part) => (/^\d+$/.test(part) ? Number(part) : part));

for (const family of Object.keys(EXPECTED)) {
  test(`${family}: a repair run keeps every x-mock sample value in its output`, async () => {
    const pkg = await load(family);
    const recipe = structuredClone(pkg.fixture) as JsonObject;
    const mock = [...mockPathsFor(pkg.schema, editableTemplate(recipe)!)];
    const fact = collectFaithfulnessSlots(recipe).map((slot) => slot.path).find((path) => !mock.includes(path))!;
    const flaggedMock = mock[0]!;
    const report = await runFastLane({
      pkg, brief: 'Ledgerly does bookkeeping.', mode: 'sections', entry: `${family}-r2.html`, revision: 2,
      model: fakeModel(), modelName: 'fake', spine: recipe,
      lockPaths: repairLockPaths(recipe, [fact, flaggedMock], pkg.schema),
    });
    for (const path of mock) {
      assert.deepEqual(getAtPath(report.recipe, labelSegments(path)), getAtPath(pkg.fixture, labelSegments(path)), `${path} keeps its sample value`);
    }
    const repaired = getAtPath(report.recipe, labelSegments(fact));
    assert.notDeepEqual(repaired, getAtPath(pkg.fixture, labelSegments(fact)), `${fact} was re-generated`);
    assert.match(String(repaired), /^New /, `${fact} holds the model's new text`);
  });
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Review fix (B3): the gate skips an x-mock slot only because the page labels it. For every
// family with x-mock slots, each such path of the package recipe must render inside a sample-data
// region, after that region's caption, and every caption must be the family's fixed template
// constant (slots.ts), never recipe text a model could rewrite ("Explore homes").
const CAPTION_EXPORTS: Record<string, string> = {
  'crm-dashboard': 'SAMPLE_DATA_CAPTION',
  'app-shell': 'SAMPLE_DATA_CAPTION',
  'marketing-site': 'ILLUSTRATIVE_PRICING_CAPTION',
  listings: 'SAMPLE_DATA_CAPTION',
};

async function fixedCaption(pkg: FamilyPackage): Promise<string> {
  const slots = await import(pathToFileURL(path.join(pkg.packageDir, 'compiler', 'scripts', 'families', pkg.family, 'slots.ts')).href) as Record<string, unknown>;
  const caption = slots[CAPTION_EXPORTS[pkg.family]!];
  assert.equal(typeof caption, 'string', `${pkg.family}: slots.ts exports its fixed caption`);
  return caption as string;
}

for (const family of Object.keys(CAPTION_EXPORTS)) {
  test(`${family}: every x-mock path renders under the family's fixed caption, which no recipe field carries`, async () => {
    const pkg = await load(family);
    const caption = await fixedCaption(pkg);
    const mock = [...mockPathsFor(pkg.schema, editableTemplate(pkg.fixture)!)];
    assert.ok(mock.length > 0, `${family} has x-mock slots`);
    if (EXPECTED[family]) assert.deepEqual([...mock].sort(), [...EXPECTED[family]!.mock].sort());
    assert.ok(!JSON.stringify(pkg.schema).includes(caption), 'the caption is not in the schema');
    assert.ok(!JSON.stringify(pkg.fixture).includes(caption), 'the caption is not recipe data');
    assertCaptionBacksEveryMockValue(pkg.fixture, mock, (recipe) => pkg.render(recipe as Json, `${family}-r1.html`).html, caption);
  });
}

test('the caption check refuses a model-written caption and a caption placed after the values', async () => {
  const pkg = await load('listings');
  const caption = await fixedCaption(pkg);
  const mock = [...mockPathsFor(pkg.schema, editableTemplate(pkg.fixture)!)];
  const render = (recipe: unknown) => pkg.render(recipe as Json, 'listings-r1.html').html;
  const rewritten = (recipe: unknown) => render(recipe).replaceAll(`data-od-mock="caption">${caption}<`, 'data-od-mock="caption">Explore homes<');
  assert.throws(() => assertCaptionBacksEveryMockValue(pkg.fixture, mock, rewritten, caption), /every caption is the fixed template sentence/);
  // The caption moved to the end of each sample section: present, but after every value.
  const late = (recipe: unknown) => render(recipe).replace(/(<p\b[^>]*data-od-mock="caption"[^>]*>[^<]*<\/p>)([\s\S]*?)(<\/section>)/g, '$2$1$3');
  assert.throws(() => assertCaptionBacksEveryMockValue(pkg.fixture, mock, late, caption), /precedes the value/);
});
