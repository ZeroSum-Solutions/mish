/**
 * Watson nullable contact and award atoms, end to end.
 *
 * The family accepts null for the six footer contact and award atoms a client brief may
 * legitimately not state (plus the location and client-work atoms covered by the last test below),
 * the renderer omits the whole fragment rather than emitting an empty link or an orphan label,
 * and the fast lane carries null from the model's answer into the recipe without a repair.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { loadFamilyPackage } from '../src/family.ts';
import { buildUserPrompt } from '../src/prompt.ts';
import { runFastLane } from '../src/run.ts';
import { atomKindsFor, editableTemplate, getAtPath, isObject, nullablePathsOf, type Json, type JsonObject } from '../src/spine.ts';
import { WATSON_DIR, fakeModel, fillTemplate, promptBlock, type Filler } from './fixtures.ts';

const pkg = await loadFamilyPackage(WATSON_DIR, 'watson');
const ENTRY = 'watson-r1.html';
const BRIEF = 'Corvid Field, a two-person design studio in Portland. Brand systems and editorial sites. Dry, exact tone. The studio states no phone number, no email, no street address and no awards.';
const NULLABLE_ATOMS = ['awardCaption', 'businessEmail', 'jobsEmail', 'addressFirst', 'addressSecond', 'phone'] as const;
// Watson's display face carries eleven letters, so brand.name has its own contract rule that a
// generic fake filler cannot satisfy. These runs lock it, exactly as `--lock brand.name` does.
const LOCK_BRAND = ['brand.name'];
/** A model that answers every nullable atom with null and writes copy everywhere else. */
const nullingFill: Filler = (key, _value, _at, limit) =>
  (NULLABLE_ATOMS as readonly string[]).includes(key) ? null : `New ${key} for Taproot`.slice(0, limit);

const footerOf = (recipe: Json): JsonObject => getAtPath(recipe, ['sections', 4, 'content']) as JsonObject;

/** The reference recipe with the named footer atoms nulled. */
function withNulls(...keys: readonly string[]): JsonObject {
  const recipe = structuredClone(pkg.fixture);
  const footer = footerOf(recipe);
  for (const key of keys) footer[key] = null;
  return recipe;
}

const render = (recipe: Json) => pkg.render(recipe, ENTRY).html;

test('the reference recipe still compiles unchanged, with every contact link present', () => {
  const html = render(pkg.fixture);
  assert.ok(html.includes('href="tel:+13234659225"'));
  assert.ok(html.includes('mailto:newbusiness%40watsondg.com'));
  assert.ok(html.includes('class="watson-contact"'));
  assert.ok(html.includes('class="watson-award-caption"'));
});

test('every contact and award atom null: the fragments leave no link, label or empty container', () => {
  const html = render(withNulls(...NULLABLE_ATOMS));
  assert.equal(html.includes('tel:'), false, 'no telephone link');
  assert.equal(html.includes('mailto:'), false, 'no mail link');
  assert.equal(html.includes('google.com/maps'), false, 'no map link for an address that was never stated');
  assert.equal(html.includes('class="watson-contact"'), false, 'the contact block goes with its last atom');
  assert.equal(html.includes('class="watson-award-caption"'), false);
  for (const label of ['(Contact)', 'New Business:', 'Address:', 'Phone:', 'Get in touch']) {
    assert.equal(html.includes(label), false, `no orphan label: ${label}`);
  }
  assert.equal(html.includes('href=""'), false, 'no empty link target');
  assert.ok(html.includes('LA + London'), 'an atom left as text still renders');
  assert.ok(html.includes('class="watson-award-picture"'), 'the approved award image is an asset, not a text atom');
  assert.ok(html.includes('learn more'), 'the jobs route survives its removed mail anchor');
});

test('one atom null at a time: only that fragment goes, the rest of the block stands', () => {
  const noPhone = render(withNulls('phone'));
  assert.equal(noPhone.includes('tel:'), false);
  assert.equal(noPhone.includes('Phone:'), false);
  assert.ok(noPhone.includes('mailto:newbusiness%40watsondg.com'));
  assert.ok(noPhone.includes('google.com/maps'));
  assert.ok(noPhone.includes('class="watson-contact"'));

  const oneAddressLine = render(withNulls('addressSecond'));
  assert.ok(oneAddressLine.includes('Address:'));
  assert.ok(oneAddressLine.includes(encodeURIComponent('5900 Wilshire Blvd, Ste. 2050')), 'the map query uses only the line that was stated');
  assert.equal(oneAddressLine.includes('Los%20Angeles'), false);

  const noAddress = render(withNulls('addressFirst', 'addressSecond'));
  assert.equal(noAddress.includes('Address:'), false);
  assert.equal(noAddress.includes('google.com/maps'), false);
  assert.ok(noAddress.includes('tel:'));
});

test('the contract refuses null in a slot the family does not mark nullable', () => {
  assert.throws(() => render(withNulls('recentLabel')), /recentLabel: expected bounded plain text/);
  assert.throws(() => render(withNulls('contactLabel')), /contactLabel: expected bounded plain text/);
  const missingKey = withNulls();
  delete footerOf(missingKey).phone;
  assert.throws(() => render(missingKey), /missing or unknown field/, 'a nullable atom still has to be present');
});

test('the fill prompt names every nullable atom with its kind and stays parseable', () => {
  const template = editableTemplate(pkg.fixture)!;
  const kinds = atomKindsFor(pkg.schema, template)!;
  const prompt = buildUserPrompt({ brief: BRIEF, template, limits: { a: 1 }, nullable: kinds, scope: 'Fill the whole page template' });
  assert.ok(prompt.includes('\nNULLABLE\n'));
  assert.ok(prompt.includes('Return null for a fact the brief does not state'));
  assert.deepEqual(promptBlock(prompt, 'LIMITS'), { a: 1 }, 'the NULLABLE block does not disturb the LIMITS block');
  assert.deepEqual(promptBlock(prompt, 'TEMPLATE'), template);
  assert.deepEqual(getAtPath(promptBlock(prompt, 'LIMITS'), ['x']), undefined);
  const withoutNullable = buildUserPrompt({ brief: BRIEF, template, limits: { a: 1 }, scope: 'Fill' });
  assert.equal(withoutNullable.includes('NULLABLE'), false, 'a family with no nullable slot gets no block and no rule');
});

test('a model that nulls every contact and award atom is merged as-is, never repaired', async () => {
  const model = fakeModel({ fill: nullingFill });
  const report = await runFastLane({ pkg, brief: BRIEF, mode: 'sections', entry: ENTRY, revision: 1, model, modelName: 'fake', lockPaths: LOCK_BRAND });
  assert.equal(report.repairs, 0);
  assert.deepEqual(report.missing, []);
  assert.deepEqual(report.nulled.slice().sort(), NULLABLE_ATOMS.map((key) => `sections[4].content.${key}`).sort());
  const footer = footerOf(report.recipe);
  for (const key of NULLABLE_ATOMS) assert.equal(footer[key], null, key);
  assert.ok(isObject(footer) && typeof footer.locations === 'string', 'a required slot is still written');
  assert.equal(report.html.includes('tel:'), false);
  assert.equal(report.html.includes('mailto:'), false);
  assert.equal(report.html.includes('watsondg.com'), false, 'no contact detail from the spine client survives');
  assert.ok(model.prompts.some((prompt) => prompt.includes('"phone": "phone"')), 'the footer prompt carries the atom kinds');
});

test('null in a slot the family does not mark nullable goes through the existing repair path', async () => {
  const model = fakeModel({
    fill: nullingFill,
    firstAnswer: (template, limits) => {
      const filled = fillTemplate(template, limits, nullingFill) as JsonObject;
      const sections = filled.sections as JsonObject[] | undefined;
      const statement = sections?.find((section) => section.id === 'watson-statement') ?? (filled.id === 'watson-statement' ? filled : undefined);
      if (!statement) return undefined;
      (statement.content as JsonObject).opening = null;
      return filled;
    },
  });
  const report = await runFastLane({ pkg, brief: BRIEF, mode: 'sections', entry: ENTRY, revision: 1, model, modelName: 'fake', lockPaths: LOCK_BRAND });
  assert.equal(report.repairs, 1);
  assert.deepEqual(report.missing, []);
  assert.equal(typeof getAtPath(report.recipe, ['sections', 2, 'content', 'opening']), 'string');
  assert.ok(model.prompts.some((prompt) => prompt.includes('missing or empty values: sections[2].content.opening')));
  assert.equal(report.nulled.includes('sections[2].content.opening'), false, 'a refused null is never reported as a nulled slot');
});

test('re-target: a run over a recipe whose atoms are already null fills every one of them back in', async () => {
  const refilled: Record<string, string> = {
    awardCaption: 'FIVE YEARS OF QUIET WORK', businessEmail: 'studio@taproot.example', jobsEmail: 'jobs@taproot.example',
    addressFirst: '12 Alder Street', addressSecond: 'Portland, OR 97214', phone: '+1 503 555 0100',
  };
  const refillFill: Filler = (key, _value, _at, limit) => refilled[key] ?? `New ${key} for Taproot`.slice(0, limit);
  /** `fillTemplate` leaves a null leaf null, so a re-target answer sets those slots explicitly. */
  const answerWith = (template: Json, limits: Json | undefined): Json | undefined => {
    const filled = fillTemplate(template, limits, refillFill) as JsonObject;
    const sections = filled.sections as JsonObject[] | undefined;
    const footer = sections?.find((section) => section.id === 'watson-footer') ?? (filled.id === 'watson-footer' ? filled : undefined);
    if (!footer) return undefined;
    for (const [key, value] of Object.entries(refilled)) (footer.content as JsonObject)[key] = value;
    return filled;
  };
  const run = (model: ReturnType<typeof fakeModel>, spine?: JsonObject) => runFastLane({
    pkg, brief: BRIEF, mode: 'sections', entry: ENTRY, revision: 1, modelName: 'fake', lockPaths: LOCK_BRAND, spine, model,
  });

  const control = await run(fakeModel({ fill: refillFill, firstAnswer: answerWith }));
  const model = fakeModel({ fill: refillFill, firstAnswer: answerWith });
  const report = await run(model, withNulls(...NULLABLE_ATOMS));

  assert.equal(report.repairs, 0);
  assert.deepEqual(report.missing, []);
  assert.deepEqual(report.nulled, [], 'the model supplied a value for every slot, so nothing stays null');
  const footer = footerOf(report.recipe);
  for (const [key, value] of Object.entries(refilled)) assert.equal(footer[key], value, key);
  assert.equal(report.applied, control.applied, 'a slot that started null is counted exactly like one that started as text, never dropped silently');
  assert.ok(report.html.includes('href="tel:+15035550100"'));
  assert.ok(report.html.includes('mailto:studio%40taproot.example'));
  assert.ok(report.html.includes('class="watson-contact"'));
  assert.ok(report.html.includes('class="watson-award-caption"'));
  assert.ok(report.html.includes(encodeURIComponent('12 Alder Street, Portland, OR 97214')), 'the maps link comes back with both address lines');
  const footerPrompt = model.prompts.find((prompt) => prompt.includes('watson-footer'))!;
  assert.ok(footerPrompt.includes('"phone": null'), 'the nulled slot is in the TEMPLATE the model sees');
  assert.ok(footerPrompt.includes('"phone": "phone"'), 'with its atom kind');
  assert.ok(footerPrompt.includes('"phone": 51'), 'and its soft limit');
});

test('the schema, the slot map and the renderer agree on which atoms are nullable', async () => {
  const slots = await import(path.join(WATSON_DIR, 'compiler/scripts/families/watson/slots.ts')) as { WATSON_NULLABLE_ATOMS: Record<string, string> };
  // Beyond the six footer contact and award atoms, the hero `location`, the statement `city`, and
  // the footer `locations` and `campaigns` are nullable too (where the studio is, and named
  // client work: facts a client brief may legitimately not state).
  const ALL_NULLABLE_ATOMS = ['location', 'city', 'locations', 'campaigns', ...NULLABLE_ATOMS] as const;
  assert.deepEqual(Object.keys(slots.WATSON_NULLABLE_ATOMS).sort(), [...ALL_NULLABLE_ATOMS].sort());
  const kinds = atomKindsFor(pkg.schema, editableTemplate(pkg.fixture)!);
  const at = (index: number) => getAtPath(kinds, ['sections', index, 'content']) as Record<string, string>;
  const merged = { ...at(1), ...at(2), ...at(4) };
  assert.deepEqual(merged, slots.WATSON_NULLABLE_ATOMS, 'recipe.schema.json x-atom kinds match slots.ts');
  const keysInSchema = [...nullablePathsOf(kinds)].map((label) => label.split('.').pop()!).sort();
  assert.deepEqual(keysInSchema, [...ALL_NULLABLE_ATOMS].sort(), 'every schema-nullable leaf is named in slots.ts, and vice versa');
});
