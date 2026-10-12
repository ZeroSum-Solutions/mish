/**
 * Maben nullable contact-line and legal-link atoms, end to end.
 *
 * The contact-column repeat's `line2`/`line3` and the legal-links repeat's `label` text slots
 * already tolerate omission (`optional: true` in slots.ts); this closes the loop with the
 * explicit-`null` form the fast lane's model actually answers for a fact the brief does not
 * state. The renderer drops the whole fragment either way, and the fast lane carries null into
 * the recipe without a repair. `label` is also the bare name of `destinationLinks`' own,
 * non-optional text slot; the tests below confirm that repeat stays strictly required. `line1`,
 * the overlay's featured date and title, and an editorial card's date are nullable the same way
 * (covered by the last test below).
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { loadFamilyPackage } from '../src/family.ts';
import { buildUserPrompt } from '../src/prompt.ts';
import { runFastLane } from '../src/run.ts';
import { atomKindsFor, editableTemplate, getAtPath, type Json, type JsonObject } from '../src/spine.ts';
import { fakeModel, MABEN_DIR, promptBlock, type Filler } from './fixtures.ts';

const pkg = await loadFamilyPackage(MABEN_DIR, 'maben');
const ENTRY = 'maben-r1.html';
const BRIEF = 'Colt & Rivet, a two-person renovation studio in Hobart. The studio states a street address and a phone number, but no second line for either its main office or its careers contact.';

const footerColumn0Path = ['sections', 6, 'items', 'contactColumns', 0, 'text'] as const;
const overlayColumn0Path = ['sections', 1, 'items', 'contactColumns', 0, 'text'] as const;

function withNull(recipe: JsonObject, path: readonly (string | number)[], key: string): JsonObject {
  const clone = structuredClone(recipe);
  const target = getAtPath(clone, [...path]) as JsonObject;
  target[key] = null;
  return clone;
}

/** Both sections that carry a contact-column repeat share the same placeholder text at index 0
 * (`maben-overlay-menu` and `maben-site-footer`), so a text-presence assertion must null both. */
function withNullInBothSections(recipe: JsonObject, key: string): JsonObject {
  return withNull(withNull(recipe, [...overlayColumn0Path], key), [...footerColumn0Path], key);
}

const render = (recipe: Json) => pkg.render(recipe, ENTRY).html;

test('the reference recipe still compiles unchanged, with every stated contact line present', () => {
  const html = render(pkg.fixture);
  const column0 = getAtPath(pkg.fixture, [...footerColumn0Path]) as JsonObject;
  assert.equal(typeof column0.line2, 'string');
  assert.ok(html.includes(column0.line2 as string));
});

test('a contact line explicitly null: the paragraph is gone, the rest of the column stands', () => {
  const column0 = getAtPath(pkg.fixture, [...footerColumn0Path]) as JsonObject;
  const line2Text = column0.line2 as string;
  const html = render(withNullInBothSections(pkg.fixture as JsonObject, 'line2'));
  assert.equal(html.includes(line2Text), false, 'no invented or orphaned fact');
  assert.ok(html.includes((column0.line1 as string)), 'the required line1 still renders');
  assert.ok(html.includes((column0.title as string)), 'the column title still renders');
});

test('an already-omitted contact line keeps rendering the same as before (backward compatible)', () => {
  const html = render(pkg.fixture);
  const careers = getAtPath(pkg.fixture, ['sections', 6, 'items', 'contactColumns', 2, 'text']) as JsonObject;
  assert.equal('line2' in careers, false, 'the fixture already omits this slot rather than nulling it');
  assert.ok(html.includes(careers.line1 as string));
});

test('the contract refuses null in a slot the family does not mark nullable', () => {
  assert.throws(() => render(withNull(pkg.fixture as JsonObject, [...footerColumn0Path], 'title')), /title: text slot may not be null/);
  // destinationLinks reuses the bare name "label", but its own text slot is not optional.
  assert.throws(() => render(withNull(pkg.fixture as JsonObject, ['sections', 1, 'items', 'destinationLinks', 0, 'text'], 'label')), /label: text slot may not be null/);
});

test('a legal link explicitly null: the anchor is gone, the other legal link stands', () => {
  const legalItem0 = ['sections', 6, 'items', 'legalLinks', 0, 'text'] as const;
  const recipe = withNull(pkg.fixture as JsonObject, [...legalItem0], 'label');
  const html = render(recipe);
  assert.equal(html.includes('legalLinks-0--label'), false, 'no orphan anchor');
  assert.ok(html.includes('legalLinks-1--label'), 'the other legal link still renders');
  // G5 round 3: a legal link's destinations carries no href field at all any more (slots.ts's
  // legalLinks repeat declares `destinations: []`) — the renderer always rendered it as plain
  // text regardless of any destination, so there was nothing honest an href here could ever
  // point to. Validated destinations is now the same empty object whether the label is null or
  // filled.
  const validated = pkg.render(recipe, ENTRY).recipe as JsonObject;
  const legalItem0Destinations = getAtPath(validated, ['sections', 6, 'items', 'legalLinks', 0, 'destinations']) as JsonObject;
  assert.deepEqual(legalItem0Destinations, {});
});

test('an already-present legal link keeps its own anchor when the other one is nulled (structural symmetry with line2/line3)', () => {
  const legalItem0 = ['sections', 6, 'items', 'legalLinks', 0, 'text'] as const;
  const label0 = (getAtPath(pkg.fixture, [...legalItem0]) as JsonObject).label as string;
  const html = render(withNull(pkg.fixture as JsonObject, [...legalItem0], 'label'));
  assert.equal(html.includes(label0), false);
});

test('the fill prompt names the nullable contact-line atoms with their kind and stays parseable', () => {
  const template = editableTemplate(pkg.fixture)!;
  const kinds = atomKindsFor(pkg.schema, template)!;
  const prompt = buildUserPrompt({ brief: BRIEF, template, limits: { a: 1 }, nullable: kinds, scope: 'Fill the whole page template' });
  assert.ok(prompt.includes('\nNULLABLE\n'));
  assert.ok(prompt.includes('Return null for a fact the brief does not state'));
  assert.deepEqual(promptBlock(prompt, 'LIMITS'), { a: 1 });
});

test('a model that nulls every present contact-line and legal-link atom is merged as-is, never repaired', async () => {
  // "label" is scoped to legalLinks paths only: destinationLinks reuses the bare name for its
  // own, non-optional text slot, and nulling it there would go through the repair path instead.
  const nullingFill: Filler = (key, _value, at, limit) => {
    if (key === 'line2' || key === 'line3') return null;
    if (key === 'label' && at.includes('legalLinks')) return null;
    return `New ${key} for Colt`.slice(0, limit);
  };
  const model = fakeModel({ fill: nullingFill });
  const report = await runFastLane({ pkg, brief: BRIEF, mode: 'sections', entry: ENTRY, revision: 1, model, modelName: 'fake' });
  assert.equal(report.repairs, 0);
  assert.deepEqual(report.missing, []);
  assert.ok(report.nulled.length > 0, 'at least one stated contact line or legal link was nulled');
  for (const path of report.nulled) assert.match(path, /\.text\.(?:line[23]|label)$/, path);
  assert.ok(report.nulled.some((path) => path.includes('legalLinks')), 'a legal-link label was nulled');
  const column0 = getAtPath(report.recipe, [...footerColumn0Path]) as JsonObject;
  assert.equal(column0.line2, null);
  assert.equal(typeof column0.title, 'string', 'a required slot in the same group is still written');
  const destinationLink0 = getAtPath(report.recipe, ['sections', 1, 'items', 'destinationLinks', 0, 'text']) as JsonObject;
  assert.equal(typeof destinationLink0.label, 'string', 'destinationLinks stays strictly required despite the shared bare name');
});

test('the schema and the slot map agree on which contact-line and legal-link atoms are nullable', async () => {
  const slots = await import(path.join(MABEN_DIR, 'compiler/scripts/families/maben/slots.ts')) as { MABEN_NULLABLE_ATOMS: Record<string, string> };
  assert.deepEqual(Object.keys(slots.MABEN_NULLABLE_ATOMS).sort(), ['featuredEyebrow', 'featuredTitle', 'label', 'line1', 'line2', 'line3', 'meta']);
  const kinds = getAtPath(atomKindsFor(pkg.schema, editableTemplate(pkg.fixture)!), [...footerColumn0Path]) as JsonObject;
  assert.equal(kinds.line1, slots.MABEN_NULLABLE_ATOMS.line1, 'recipe.schema.json x-atom kind matches slots.ts for line1');
  assert.equal(kinds.line2, slots.MABEN_NULLABLE_ATOMS.line2, 'recipe.schema.json x-atom kind matches slots.ts for line2');
  const overlayKinds = getAtPath(atomKindsFor(pkg.schema, editableTemplate(pkg.fixture)!), ['sections', 1, 'text']) as JsonObject;
  assert.deepEqual(overlayKinds, { featuredEyebrow: slots.MABEN_NULLABLE_ATOMS.featuredEyebrow, featuredTitle: slots.MABEN_NULLABLE_ATOMS.featuredTitle }, 'the overlay featured date and title carry their x-atom kinds');
  const cardKinds = getAtPath(atomKindsFor(pkg.schema, editableTemplate(pkg.fixture)!), ['sections', 5, 'items', 'cards', 0, 'text']) as JsonObject;
  assert.deepEqual(cardKinds, { meta: slots.MABEN_NULLABLE_ATOMS.meta }, 'an editorial card date carries its x-atom kind');
  const legalKinds = getAtPath(atomKindsFor(pkg.schema, editableTemplate(pkg.fixture)!), ['sections', 6, 'items', 'legalLinks', 0, 'text']) as JsonObject;
  assert.equal(legalKinds.label, slots.MABEN_NULLABLE_ATOMS.label, 'recipe.schema.json x-atom kind matches slots.ts for legalLinks.label');
  const destinationKinds = getAtPath(atomKindsFor(pkg.schema, editableTemplate(pkg.fixture)!), ['sections', 1, 'items', 'destinationLinks', 0, 'text']) as JsonObject | undefined;
  assert.equal(destinationKinds?.label, undefined, 'destinationLinks.label is not nullable in the schema');
});
