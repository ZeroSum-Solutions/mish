import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { atomKindsFor, clipToLimits, editableTemplate, fromModelShape, getAtPath, isObject, limitsFor, mergeAtPath, mergeIntoSpine, nullablePathsOf, softLimits, toModelShape, unchangedTextPaths, unitsOf, type Json, type JsonObject, type MergeReport } from '../src/spine.ts';
import { MABEN_DIR, WATSON_DIR, WRENFIELD_DIR, readJson } from './fixtures.ts';

const spine = await readJson(path.join(MABEN_DIR, 'families/maben/recipe.json'));
const schema = await readJson(path.join(MABEN_DIR, 'compiler/scripts/families/maben/recipe.schema.json'));

function keysIn(value: Json, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((item) => keysIn(item, found));
  else if (isObject(value)) for (const [key, child] of Object.entries(value)) { found.add(key); keysIn(child, found); }
  return found;
}

const report = (): MergeReport => ({ applied: 0, missing: [] });

test('editableTemplate keeps text and ids and drops every locked subtree', () => {
  const template = editableTemplate(spine);
  assert.ok(isObject(template));
  assert.deepEqual(Object.keys(template.brand as JsonObject), ['name', 'descriptor']);
  const keys = keysIn(template);
  for (const locked of ['assets', 'destinations', 'type', 'wordmark', 'revision', 'family', 'schemaVersion']) assert.equal(keys.has(locked), false, locked);
  assert.equal(getAtPath(template, ['sections', 2, 'id']), 'maben-hero');
  assert.equal(typeof getAtPath(template, ['sections', 2, 'text', 'statement']), 'string');
  assert.equal((getAtPath(template, ['sections', 3, 'items', 'steps']) as Json[]).length, 3);
});

test('limitsFor maps each text slot to its schema maxLength', () => {
  const template = editableTemplate(spine)!;
  const limits = limitsFor(schema, template);
  assert.equal(getAtPath(limits, ['brand', 'name']), 60);
  assert.equal(getAtPath(limits, ['sections', 2, 'text', 'statement']), 400);
  assert.equal(getAtPath(limits, ['sections', 3, 'items', 'steps', 0, 'text', 'caption']), 240);
  assert.equal(getAtPath(limits, ['sections', 2, 'id']), undefined);
});

test('toModelShape collapses single-key text wrappers and fromModelShape restores them', () => {
  const template = editableTemplate(spine)!;
  const shaped = toModelShape(template);
  assert.deepEqual(Object.keys(getAtPath(shaped, ['sections', 3, 'items', 'steps', 0]) as JsonObject), ['title', 'caption', 'imageAlt']);
  assert.equal(typeof getAtPath(shaped, ['sections', 3, 'text', 'eyebrow']), 'string', 'a section keeps its text key beside id and items');
  assert.deepEqual(fromModelShape(shaped, template), template);
  const limits = limitsFor(schema, template);
  const shapedLimits = toModelShape(limits!, template);
  assert.equal(getAtPath(shapedLimits, ['sections', 3, 'items', 'steps', 0, 'caption']), 240);
  assert.equal(getAtPath(shapedLimits, ['sections', 0, 'text', 'menuLabel']), 24, 'a section keeps its text wrapper in the limits too, even though limits carry no id');
  const kept = fromModelShape({ id: 'x', items: { steps: [{ text: { title: 'kept wrapper' } }] } }, { id: 'x', items: { steps: [{ text: { title: 't' } }] } });
  assert.deepEqual(kept, { id: 'x', items: { steps: [{ text: { title: 'kept wrapper' } }] } });
});

test('softLimits keeps the shape and leaves headroom under every hard limit', () => {
  const template = editableTemplate(spine)!;
  const soft = softLimits(limitsFor(schema, template));
  assert.equal(getAtPath(soft, ['brand', 'descriptor']), 170);
  assert.equal(getAtPath(soft, ['sections', 2, 'text', 'statement']), 340);
  assert.equal(getAtPath(soft, ['sections', 0, 'text', 'menuLabel']), 20);
  assert.equal(softLimits(5), 8);
});

test('clipToLimits cuts overruns at a word boundary and names the paths', () => {
  const paths: string[] = [];
  const value = { text: { a: 'one two three four five', b: 'short' }, list: [{ t: 'alpha beta gamma' }] };
  const clipped = clipToLimits(value, { text: { a: 14, b: 10 }, list: [{ t: 8 }] }, paths, 'unit');
  assert.deepEqual(clipped, { text: { a: 'one two three', b: 'short' }, list: [{ t: 'alpha' }] });
  assert.deepEqual(paths, ['unit.text.a', 'unit.list[0].t']);
  assert.equal(clipToLimits('nospacesatallhere', 8), 'nospaces');
});

test('clipToLimits prefers a sentence boundary over a bare word boundary, never publishing a broken final sentence', () => {
  // The exact defect a live Cerebras storefront build produced: a 280-char story-about.body limit
  // cut mid-sentence ("...still at kitchen-table scale, tracking each") because the word-boundary
  // clip only looked at the LAST space in the window, not at the sentence that had already ended
  // cleanly a little earlier. The fix must prefer that earlier full stop.
  const overrun = 'Portland-based Tallow Row makes natural-fiber workwear in short runs. The anchor Field Jacket joins trousers, shirts, a tote and waxed cap. Every piece is cut and sewn by the founders, still at kitchen-table scale, tracking each bolt of cloth from source to finished garment.';
  const clipped = clipToLimits(overrun, 180) as string;
  assert.ok(/[.!?]$/.test(clipped), `clipped text must end on a sentence boundary, got: "${clipped}"`);
  assert.equal(clipped, 'Portland-based Tallow Row makes natural-fiber workwear in short runs. The anchor Field Jacket joins trousers, shirts, a tote and waxed cap.');
  assert.ok(clipped.length <= 180);

  // No sentence boundary at all within the window (or too early to be worth keeping): falls back
  // to the existing word-boundary behavior exactly as before.
  const noSentence = 'one two three four five six seven eight nine ten eleven twelve thirteen';
  assert.equal(clipToLimits(noSentence, 20), 'one two three four');

  // A sentence boundary that sits very early in the window (well under 40% of the limit) is not
  // worth throwing almost the whole budget away for — falls back to the word boundary instead.
  const earlyPeriod = 'Ok. ' + 'x'.repeat(96);
  const earlyClipped = clipToLimits(earlyPeriod, 100) as string;
  assert.ok(!earlyClipped.endsWith('Ok.'), 'an early sentence end this close to the start is not preferred');
});

test('mergeIntoSpine takes text only and keeps locked values', () => {
  const candidate = structuredClone(editableTemplate(spine)) as JsonObject;
  const hero = (candidate.sections as JsonObject[])[2]!;
  (hero.text as JsonObject).statement = 'New statement';
  hero.assets = { media: 'evil' };
  candidate.revision = 99;
  const merge = report();
  const merged = mergeIntoSpine(spine, candidate, merge) as JsonObject;
  assert.equal(getAtPath(merged, ['sections', 2, 'text', 'statement']), 'New statement');
  assert.equal(getAtPath(merged, ['sections', 2, 'id']), 'maben-hero');
  assert.equal(getAtPath(merged, ['sections', 2, 'assets', 'media']), getAtPath(spine, ['sections', 2, 'assets', 'media']));
  assert.equal(merged.revision, spine.revision);
  assert.equal(merge.applied, 1);
  assert.deepEqual(merge.missing, []);
  assert.notEqual(merged, spine, 'returns a new object');
});

test('mergeIntoSpine treats a section whose id was altered as dropped: spine id and text stay, the slots are missing', () => {
  const candidate = structuredClone(editableTemplate(spine)) as JsonObject;
  const hero = (candidate.sections as JsonObject[])[2]!;
  hero.id = 'evil';
  (hero.text as JsonObject).statement = 'New statement';
  const merge = report();
  const merged = mergeIntoSpine(spine, candidate, merge) as JsonObject;
  assert.equal(getAtPath(merged, ['sections', 2, 'id']), 'maben-hero');
  assert.equal(getAtPath(merged, ['sections', 2, 'text', 'statement']), getAtPath(spine, ['sections', 2, 'text', 'statement']));
  assert.ok(merge.missing.includes('sections[2].text.statement'));
  assert.equal(merge.applied, 0);
});

test('mergeIntoSpine reports a dropped anchored section as missing instead of filling it by position', () => {
  const candidate = structuredClone(editableTemplate(spine)) as JsonObject;
  const sections = candidate.sections as JsonObject[];
  const shifted = sections.filter((section) => section.id !== 'maben-hero');
  for (const section of shifted) if (isObject(section.text)) for (const key of Object.keys(section.text)) (section.text as JsonObject)[key] = `${section.id} ${key}`;
  candidate.sections = shifted;
  const merge = report();
  const merged = mergeIntoSpine(spine, candidate, merge);
  assert.equal(getAtPath(merged, ['sections', 2, 'text', 'eyebrow']), getAtPath(spine, ['sections', 2, 'text', 'eyebrow']), 'the hero keeps the spine text');
  assert.ok(merge.missing.includes('sections[2].text.eyebrow'));
  assert.ok(merge.missing.every((at) => at.startsWith('sections[2].')), 'only the dropped section is missing');
  assert.equal(getAtPath(merged, ['sections', 3, 'text', 'eyebrow']), 'maben-how-we-work eyebrow', 'the section that moved into its position still lands on its own slot');
});

test('mergeIntoSpine matches sections by id when the candidate order differs', () => {
  const candidate = structuredClone(editableTemplate(spine)) as JsonObject;
  const sections = (candidate.sections as JsonObject[]).reverse();
  const hero = sections.find((section) => section.id === 'maben-hero')!;
  (hero.text as JsonObject).eyebrow = 'Reordered eyebrow';
  const merged = mergeIntoSpine(spine, candidate, report());
  assert.equal(getAtPath(merged, ['sections', 2, 'text', 'eyebrow']), 'Reordered eyebrow');
  assert.equal(getAtPath(merged, ['sections', 0, 'id']), 'maben-site-rail');
});

test('mergeIntoSpine reports a missing or empty string and keeps the spine text', () => {
  const candidate = structuredClone(editableTemplate(spine)) as JsonObject;
  const heroText = ((candidate.sections as JsonObject[])[2]!.text as JsonObject);
  delete heroText.mediaNote;
  heroText.eyebrow = '   ';
  const merge = report();
  const merged = mergeIntoSpine(spine, candidate, merge);
  assert.deepEqual(merge.missing, ['sections[2].text.eyebrow', 'sections[2].text.mediaNote']);
  assert.equal(getAtPath(merged, ['sections', 2, 'text', 'mediaNote']), getAtPath(spine, ['sections', 2, 'text', 'mediaNote']));
});

test('mergeAtPath touches only the addressed unit', () => {
  const merge = report();
  const merged = mergeAtPath(spine, ['sections', 2], { id: 'maben-hero', text: { statement: 'Only this' } }, merge) as JsonObject;
  assert.equal(getAtPath(merged, ['sections', 2, 'text', 'statement']), 'Only this');
  assert.deepEqual((merged.sections as Json[])[3], (spine.sections as Json[])[3]);
  assert.deepEqual(merged.brand, spine.brand);
  assert.ok(merge.missing.every((at) => at.startsWith('sections[2].')));
  assert.ok(merge.missing.includes('sections[2].text.eyebrow'));
  assert.throws(() => mergeAtPath(spine, ['sections', 99], {}, report()), /no such path/);
});

test('a locked path is hidden from the template and kept from the spine without counting as missing', () => {
  const locked = new Set(['brand.name', 'sections[2].text.eyebrow']);
  const template = editableTemplate(spine, undefined, locked) as JsonObject;
  assert.deepEqual(Object.keys(template.brand as JsonObject), ['descriptor']);
  assert.equal(getAtPath(template, ['sections', 2, 'text', 'eyebrow']), undefined);
  const candidate = structuredClone(template) as JsonObject;
  (candidate.brand as JsonObject).name = 'Should not land';
  const merge: MergeReport = { applied: 0, missing: [], lockedPaths: locked };
  const merged = mergeIntoSpine(spine, candidate, merge);
  assert.equal(getAtPath(merged, ['brand', 'name']), getAtPath(spine, ['brand', 'name']));
  assert.equal(getAtPath(merged, ['sections', 2, 'text', 'eyebrow']), getAtPath(spine, ['sections', 2, 'text', 'eyebrow']));
  assert.deepEqual(merge.missing, []);
});

test('unitsOf yields the brand and one unit per section with limits attached', () => {
  const template = editableTemplate(spine)!;
  const units = unitsOf(template, limitsFor(schema, template));
  assert.deepEqual(units.map((unit) => unit.label), ['brand', 'maben-site-rail', 'maben-overlay-menu', 'maben-hero', 'maben-how-we-work', 'maben-latest-projects', 'maben-editorial-grid', 'maben-site-footer']);
  assert.equal(getAtPath(units[3]!.limits, ['text', 'statement']), 400);
  assert.deepEqual(units[3]!.path, ['sections', 2]);
});

test('atomKindsFor names exactly the watson slots the schema marks nullable, with their kind', async () => {
  const watson = await readJson(path.join(WATSON_DIR, 'families/watson/recipe.json'));
  const watsonSchema = await readJson(path.join(WATSON_DIR, 'compiler/scripts/families/watson/recipe.schema.json'));
  const template = editableTemplate(watson)!;
  const kinds = atomKindsFor(watsonSchema, template);
  assert.deepEqual(getAtPath(kinds, ['sections', 4, 'content']), {
    awardCaption: 'plain', locations: 'address', campaigns: 'plain', businessEmail: 'email', jobsEmail: 'email',
    addressFirst: 'address', addressSecond: 'address', phone: 'phone',
  });
  assert.deepEqual(nullablePathsOf(kinds), new Set([
    'sections[1].content.location', 'sections[2].content.city',
    'sections[4].content.awardCaption', 'sections[4].content.locations', 'sections[4].content.campaigns',
    'sections[4].content.businessEmail', 'sections[4].content.jobsEmail',
    'sections[4].content.addressFirst', 'sections[4].content.addressSecond', 'sections[4].content.phone',
  ]));
  assert.equal(getAtPath(kinds, ['sections', 4, 'content', 'network']), undefined, 'a copy slot is not nullable');
  assert.equal(getAtPath(kinds, ['brand', 'name']), undefined);
  assert.equal(getAtPath(limitsFor(watsonSchema, template), ['sections', 4, 'content', 'phone']), 60, 'a nullable slot keeps its length limit');
});

test('atomKindsFor finds nothing in a family whose schema marks no slot nullable', () => {
  // maben itself now marks a few footer atoms nullable (`x-atom`), so the schema is stripped of
  // them here: what is under test is that no `x-atom` means no nullable slot.
  const withoutAtoms = JSON.parse(JSON.stringify(schema), (key, value: unknown) => (key === 'x-atom' ? undefined : value)) as JsonObject;
  assert.equal(atomKindsFor(withoutAtoms, editableTemplate(spine)!), undefined);
  assert.deepEqual(nullablePathsOf(undefined), new Set());
});

test('mergeIntoSpine takes null on a nullable path, reports it, and refuses it anywhere else', () => {
  const nullable = new Set(['sections[2].text.statement']);
  const candidate = structuredClone(editableTemplate(spine)) as JsonObject;
  const hero = (candidate.sections as JsonObject[])[2]!;
  (hero.text as JsonObject).statement = null;
  (hero.text as JsonObject).eyebrow = null;
  const merge: MergeReport = { applied: 0, missing: [], nullablePaths: nullable, nulled: [] };
  const merged = mergeIntoSpine(spine, candidate, merge);
  assert.equal(getAtPath(merged, ['sections', 2, 'text', 'statement']), null);
  assert.deepEqual(merge.nulled, ['sections[2].text.statement']);
  assert.equal(getAtPath(merged, ['sections', 2, 'text', 'eyebrow']), getAtPath(spine, ['sections', 2, 'text', 'eyebrow']), 'a required slot keeps the spine text');
  assert.ok(merge.missing.includes('sections[2].text.eyebrow'), 'null in a required slot is an error the caller repairs');
});

test('a slot the spine already holds null in stays visible to the model, with its limit and kind', async () => {
  const watsonSchema = await readJson(path.join(WATSON_DIR, 'compiler/scripts/families/watson/recipe.schema.json'));
  const template = editableTemplate(await nulledWatson('phone'))!;
  assert.equal(getAtPath(template, ['sections', 4, 'content', 'phone']), null, 'the slot is in the template, not dropped');
  assert.equal(getAtPath(limitsFor(watsonSchema, template), ['sections', 4, 'content', 'phone']), 60);
  assert.equal(getAtPath(atomKindsFor(watsonSchema, template), ['sections', 4, 'content', 'phone']), 'phone');
  assert.equal(getAtPath(toModelShape(template), ['sections', 4, 'content', 'phone']), null, 'reshaping keeps it');
  assert.equal(getAtPath(fromModelShape(toModelShape(template), template), ['sections', 4, 'content', 'phone']), null);
  const units = unitsOf(template, limitsFor(watsonSchema, template));
  assert.equal(units.at(-1)!.label, 'watson-footer');
  assert.equal(getAtPath(units.at(-1)!.limits, ['content', 'phone']), 60, 'the unit carries the limit for its nulled slot');
});

/** The watson reference recipe with the named footer atoms nulled, as an earlier run left it. */
async function nulledWatson(...keys: string[]): Promise<JsonObject> {
  const recipe = structuredClone(await readJson(path.join(WATSON_DIR, 'families/watson/recipe.json')));
  const content = (recipe.sections as JsonObject[])[4]!.content as JsonObject;
  for (const key of keys) content[key] = null;
  return recipe;
}
/** The footer unit of a template, the shape run.ts merges one unit at a time. */
const footerUnit = (template: Json): JsonObject => structuredClone(getAtPath(template, ['sections', 4])) as JsonObject;
const contentOf = (unit: JsonObject): JsonObject => unit.content as JsonObject;

test('re-targeting a nulled recipe: a string candidate fills the slot back in and counts as applied', async () => {
  const spineWithNull = await nulledWatson('phone');
  const candidate = footerUnit(editableTemplate(spineWithNull)!);
  contentOf(candidate).phone = '+1 555 0100';
  const merge: MergeReport = { applied: 0, missing: [], nullablePaths: new Set(['sections[4].content.phone']), nulled: [] };
  const merged = mergeAtPath(spineWithNull, ['sections', 4], candidate, merge);
  assert.equal(getAtPath(merged, ['sections', 4, 'content', 'phone']), '+1 555 0100');
  assert.equal(merge.applied, 1, 'the new value is counted, never dropped silently');
  assert.deepEqual(merge.nulled, []);
  assert.deepEqual(merge.missing, []);
});

test('re-targeting a nulled recipe: null keeps null without counting as a change, and a locked path is untouched', async () => {
  const spineWithNull = await nulledWatson('phone', 'businessEmail');
  const locked = new Set(['sections[4].content.businessEmail']);
  const template = editableTemplate(spineWithNull, undefined, locked)!;
  assert.equal(getAtPath(template, ['sections', 4, 'content', 'businessEmail']), undefined, 'a locked nulled slot is not shown to the model');
  const candidate = footerUnit(template);
  contentOf(candidate).businessEmail = 'sneaky@example.com';
  const merge: MergeReport = { applied: 0, missing: [], lockedPaths: locked, nullablePaths: new Set(['sections[4].content.phone', 'sections[4].content.businessEmail']), nulled: [] };
  const merged = mergeAtPath(spineWithNull, ['sections', 4], candidate, merge);
  assert.equal(getAtPath(merged, ['sections', 4, 'content', 'phone']), null);
  assert.deepEqual(merge.nulled, ['sections[4].content.phone']);
  assert.equal(merge.applied, 0, 'null over null is not a change');
  assert.equal(getAtPath(merged, ['sections', 4, 'content', 'businessEmail']), null, 'the locked path keeps the spine value');
  assert.deepEqual(merge.missing, []);
});

test('re-targeting a nulled recipe: a candidate that is neither a string nor null is reported as missing', async () => {
  const spineWithNull = await nulledWatson('phone');
  const candidate = footerUnit(editableTemplate(spineWithNull)!);
  contentOf(candidate).phone = 42;
  const merge: MergeReport = { applied: 0, missing: [], nullablePaths: new Set(['sections[4].content.phone']), nulled: [] };
  const merged = mergeAtPath(spineWithNull, ['sections', 4], candidate, merge);
  assert.equal(getAtPath(merged, ['sections', 4, 'content', 'phone']), null, 'the spine value stands');
  assert.deepEqual(merge.missing, ['sections[4].content.phone']);
  assert.equal(merge.applied, 0);
});

test('softLimits and clipToLimits leave a nulled slot alone', () => {
  const paths: string[] = [];
  const clipped = clipToLimits({ text: { a: null, b: 'one two three four' } }, { text: { a: 12, b: 12 } }, paths, 'unit');
  assert.deepEqual(clipped, { text: { a: null, b: 'one two thre' } });
  assert.deepEqual(paths, ['unit.text.b'], 'a null has no length to cut, so it is never reported as clipped');
  assert.equal(getAtPath(softLimits({ text: { a: 60 } }), ['text', 'a']), 51, 'limits stay numeric for a nullable slot');
});

test('watson: brand colors and fonts are locked, content stays editable', async () => {
  const watson = await readJson(path.join(WATSON_DIR, 'families/watson/recipe.json'));
  const template = editableTemplate(watson);
  assert.ok(isObject(template));
  assert.deepEqual(Object.keys(template.brand as JsonObject), ['name']);
  assert.equal(typeof getAtPath(template, ['sections', 2, 'content', 'city']), 'string');
  assert.equal(keysIn(template).has('assets'), false);
});

test('brand.wordmark (an image reference) is locked and untouched on merge, even by key name alone', () => {
  assert.ok(isObject(getAtPath(spine, ['brand', 'wordmark'])), 'fixture sanity: maben brand carries an image wordmark');
  const template = editableTemplate(spine) as JsonObject;
  assert.equal(getAtPath(template, ['brand', 'wordmark']), undefined);
  const candidate = structuredClone(template) as JsonObject;
  (candidate.brand as JsonObject).wordmark = { width: 1, height: 1 };
  const merged = mergeIntoSpine(spine, candidate, report());
  assert.deepEqual(getAtPath(merged, ['brand', 'wordmark']), getAtPath(spine, ['brand', 'wordmark']));
});

test('a section content.wordmark string is editable and merges back, unlike brand.wordmark', async () => {
  const wrenfield = await readJson(path.join(WRENFIELD_DIR, 'families/wrenfield/recipe.json'));
  const wrenfieldSections = wrenfield.sections as JsonObject[];
  const footer = wrenfieldSections.findIndex((section) => isObject(section.content) && typeof (section.content as JsonObject).wordmark === 'string');
  assert.ok(footer >= 0, 'fixture sanity: the wrenfield footer carries a text wordmark, not an asset');
  const template = editableTemplate(wrenfield) as JsonObject;
  assert.equal(getAtPath(template, ['sections', footer, 'content', 'wordmark']), 'Wrenfield Remodeling');
  const candidate = structuredClone(template) as JsonObject;
  ((candidate.sections as JsonObject[])[footer]!.content as JsonObject).wordmark = 'New Wordmark Co';
  const merged = mergeIntoSpine(wrenfield, candidate, report());
  assert.equal(getAtPath(merged, ['sections', footer, 'content', 'wordmark']), 'New Wordmark Co');
});

test('type and assets stay locked no matter how deep they sit inside a section', () => {
  const linkPath: (string | number)[] = ['sections', 1, 'items', 'destinationLinks', 0];
  const link = getAtPath(spine, linkPath) as JsonObject;
  assert.equal(link.type, undefined, 'fixture sanity: this node has no type of its own to confuse with the section type');
  assert.deepEqual(link.destinations, { href: 'about' });
  const template = editableTemplate(spine) as JsonObject;
  assert.equal(getAtPath(template, [...linkPath, 'destinations']), undefined);
  assert.equal(getAtPath(template, [...linkPath, 'assets']), undefined);
  assert.equal(getAtPath(template, ['sections', 2, 'type']), undefined, 'a section-level type tag stays locked too');
  const candidate = structuredClone(template) as JsonObject;
  const editableLink = getAtPath(candidate, linkPath) as JsonObject;
  editableLink.destinations = { href: 'evil' };
  editableLink.assets = { evil: 'asset' };
  (candidate.sections as JsonObject[])[2]!.type = 'evil-type';
  const merged = mergeIntoSpine(spine, candidate, report());
  assert.deepEqual(getAtPath(merged, [...linkPath, 'destinations']), { href: 'about' });
  assert.equal(getAtPath(merged, ['sections', 2, 'type']), 'statement-hero');
});

test('unchangedTextPaths returns nothing when there is no previous recipe', () => {
  assert.deepEqual(unchangedTextPaths(undefined, spine), new Set());
});

test('unchangedTextPaths finds every editable text path when nothing changed, excluding locked keys and the id anchor', () => {
  const unchanged = unchangedTextPaths(spine, spine);
  assert.ok(unchanged.has('brand.name'));
  assert.ok(unchanged.has('sections[2].text.statement'));
  // Locked-by-key and the section anchor never enter the result: they are never sent to the model
  // or to Jev either way (editableTemplate/collectFaithfulnessSlots already exclude them), so
  // naming them here would tell the caller nothing it does not already know.
  for (const locked of [...unchanged].filter((path) => path.endsWith('.wordmark') || path.endsWith('.destinations') || path.endsWith('.assets'))) {
    assert.fail(`unexpected locked path in unchangedTextPaths result: ${locked}`);
  }
  assert.equal(unchanged.has('sections[2].id'), false, 'the anchor never enters the result, matching collectFaithfulnessSlots');
  assert.equal(unchanged.has('revision'), false, 'a locked root key never enters the result');
});

test('unchangedTextPaths excludes exactly the paths whose value differs, keeping every other editable slot', () => {
  const next = structuredClone(spine);
  (next.brand as JsonObject).name = 'New Name Co';
  ((next.sections as JsonObject[])[2]!.text as JsonObject).statement = 'A brand new statement.';
  const unchanged = unchangedTextPaths(spine, next);
  assert.equal(unchanged.has('brand.name'), false, 'a changed leaf is excluded');
  assert.equal(unchanged.has('sections[2].text.statement'), false, 'a changed leaf is excluded');
  // Everything else in the same units stayed put and is still reported unchanged.
  assert.ok(unchanged.has('brand.descriptor'));
  assert.ok(unchanged.has('sections[0].text.menuLabel') || unchanged.has('sections[3].items.steps[0].text.caption'), 'an untouched slot elsewhere is still reported unchanged');
});

test('unchangedTextPaths matches sections by id, so a section that only moved is still correctly read as unchanged', () => {
  const previous: Json = { sections: [{ id: 'a', content: { heading: 'Alpha' } }, { id: 'b', content: { heading: 'Beta' } }] };
  const next: Json = { sections: [{ id: 'b', content: { heading: 'Beta' } }] }; // "a" removed, "b" shifted to index 0
  const unchanged = unchangedTextPaths(previous, next);
  assert.ok(unchanged.has('sections[0].content.heading'), 'section "b" is found by id at its new index and its own text really is unchanged');
});

test('unchangedTextPaths never locks a slot against an unrelated section that coincidentally shares its text', () => {
  // "a" and "b" hold the SAME text at the same field — the exact coincidence that would fool a
  // purely positional comparison once "a" is removed and "b" shifts into index 0. Matching by id
  // instead of position means "b" (now at index 0) is compared against the previous recipe's OWN
  // "b" (which never existed — this `previous` only has "a"), not against whatever sits at index 0.
  const previous: Json = { sections: [{ id: 'a', content: { heading: 'Same Text' } }] };
  const next: Json = { sections: [{ id: 'b', content: { heading: 'Same Text' } }] }; // "a" removed, "b" is a NEW section, not a shift
  const unchanged = unchangedTextPaths(previous, next);
  assert.equal(unchanged.has('sections[0].content.heading'), false, '"b" has no id match in `previous`, so its text is never compared against "a"\'s by accident of position');
});

test('unchangedTextPaths treats an array item with no id anchor positionally, same as mergeIntoSpine falls back for anchor-less items', () => {
  const previous: Json = { items: { steps: [{ text: { caption: 'First' } }, { text: { caption: 'Second' } }] } };
  const next: Json = { items: { steps: [{ text: { caption: 'First' } }, { text: { caption: 'Second' } }] } };
  const unchanged = unchangedTextPaths(previous, next);
  assert.ok(unchanged.has('items.steps[0].text.caption'));
  assert.ok(unchanged.has('items.steps[1].text.caption'));
});

test('unchangedTextPaths never locks a nullable slot that is still null on both sides, so a later brief can still fill it', () => {
  // A nullable slot an earlier run left empty (e.g. no phone number in the original brief) must
  // stay offered to the model on every future re-target, exactly as editableTemplate's own doc
  // comment promises for a null leaf. null === null is not "unchanged text" the way two equal
  // strings are: there is no text there yet for the model to keep, only an open slot it may fill.
  const previous: Json = { sections: [{ id: 'a', content: { phone: null, heading: 'Same' } }] };
  const next: Json = { sections: [{ id: 'a', content: { phone: null, heading: 'Same' } }] };
  const unchanged = unchangedTextPaths(previous, next);
  assert.equal(unchanged.has('sections[0].content.phone'), false, 'a still-null slot must never be locked, so the model keeps seeing it');
  assert.ok(unchanged.has('sections[0].content.heading'), 'an actually-unchanged string slot in the same unit is still reported unchanged');
});
