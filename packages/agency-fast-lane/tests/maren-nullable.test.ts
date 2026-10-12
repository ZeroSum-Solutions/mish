/**
 * Maren nullable contact atoms, end to end.
 *
 * The family accepts null for the three footer "Studio" contact atoms (address, email, phone)
 * a client brief may legitimately not state (among its other fact atoms: prices, figures, specs,
 * notes, visit facts -- see MAREN_NULLABLE_BY_SECTION), the renderer omits the whole fragment -- and the
 * whole Studio column once every atom in it is null -- and the fast lane carries null from the
 * model's answer into the recipe without a repair.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { loadFamilyPackage } from '../src/family.ts';
import { buildUserPrompt } from '../src/prompt.ts';
import { runFastLane } from '../src/run.ts';
import { atomKindsFor, editableTemplate, getAtPath, isObject, type Json, type JsonObject } from '../src/spine.ts';
import { fakeModel, MAREN_DIR, promptBlock, type Filler } from './fixtures.ts';

const pkg = await loadFamilyPackage(MAREN_DIR, 'maren');
const ENTRY = 'maren-r1.html';
const BRIEF = 'Kessler Silverworks, a one-person jewelry studio in Halifax. The studio states no street address, no phone and no public email; it takes commissions through a booking site only.';
const NULLABLE_ATOMS = ['address', 'email', 'phone'] as const;
const nullingFill: Filler = (key, _value, _at, limit) =>
  (NULLABLE_ATOMS as readonly string[]).includes(key) ? null : `New ${key} for Kessler`.slice(0, limit);

const footerOf = (recipe: Json): JsonObject => getAtPath(recipe, ['sections', 9, 'content']) as JsonObject;

function withNulls(...keys: readonly string[]): JsonObject {
  const recipe = structuredClone(pkg.fixture);
  const footer = footerOf(recipe);
  for (const key of keys) footer[key] = null;
  return recipe;
}

const render = (recipe: Json) => pkg.render(recipe, ENTRY).html;

test('the reference recipe still compiles unchanged, with the Studio column present', () => {
  const html = render(pkg.fixture);
  assert.equal((html.match(/<div class="footer-block">/g) ?? []).length, 4, 'brand, explore, studio and run blocks all render');
});

test('every contact atom null: the Studio column leaves no orphan heading or empty list', () => {
  const html = render(withNulls(...NULLABLE_ATOMS));
  assert.equal((html.match(/<div class="footer-block">/g) ?? []).length, 3, 'the Studio column is gone; the other three remain');
  assert.ok(html.includes('class="footer-brand"'), 'a required fact slot still renders');
  assert.ok(html.includes('class="footer-fine"'), 'the legal fine print is not a nullable atom');
});

test('one atom null at a time: only that fragment goes, the rest of the column stands', () => {
  const noPhone = render(withNulls('phone'));
  assert.equal((noPhone.match(/<div class="footer-block">/g) ?? []).length, 4, 'the Studio column survives with two atoms left');

  const addressAndEmail = render(withNulls('address', 'email'));
  assert.equal((addressAndEmail.match(/<div class="footer-block">/g) ?? []).length, 4, 'the Studio column survives with phone left');
});

test('the contract refuses null in a slot the family does not mark nullable', () => {
  assert.throws(() => render(withNulls('brand')), /brand: expected bounded plain text/);
  assert.throws(() => render(withNulls('studioHeading')), /studioHeading: expected bounded plain text/);
  const missingKey = withNulls();
  delete footerOf(missingKey).address;
  assert.throws(() => render(missingKey), /missing or unknown field/, 'a nullable atom still has to be present');
});

test('the fill prompt names every nullable atom with its kind and stays parseable', () => {
  const template = editableTemplate(pkg.fixture)!;
  const kinds = atomKindsFor(pkg.schema, template)!;
  const prompt = buildUserPrompt({ brief: BRIEF, template, limits: { a: 1 }, nullable: kinds, scope: 'Fill the whole page template' });
  assert.ok(prompt.includes('\nNULLABLE\n'));
  assert.ok(prompt.includes('Return null for a fact the brief does not state'));
  assert.deepEqual(promptBlock(prompt, 'LIMITS'), { a: 1 });
});

test('a model that nulls every contact atom is merged as-is, never repaired', async () => {
  const model = fakeModel({ fill: nullingFill });
  const report = await runFastLane({ pkg, brief: BRIEF, mode: 'sections', entry: ENTRY, revision: 1, model, modelName: 'fake' });
  assert.equal(report.repairs, 0);
  assert.deepEqual(report.missing, []);
  assert.deepEqual(report.nulled.slice().sort(), NULLABLE_ATOMS.map((key) => `sections[9].content.${key}`).sort());
  const footer = footerOf(report.recipe);
  for (const key of NULLABLE_ATOMS) assert.equal(footer[key], null, key);
  assert.ok(isObject(footer) && typeof footer.fine1 === 'string', 'a required slot is still written');
  assert.equal((report.html.match(/<div class="footer-block">/g) ?? []).length, 3);
});

test('the schema, the slot map and the renderer agree on which atoms are nullable', async () => {
  const slots = await import(path.join(MAREN_DIR, 'compiler/scripts/families/maren/slots.ts')) as {
    MAREN_NULLABLE_ATOMS: Record<string, string>;
    MAREN_NULLABLE_BY_SECTION: Record<string, readonly string[]>;
  };
  assert.deepEqual([...slots.MAREN_NULLABLE_BY_SECTION.footer!].sort(), [...NULLABLE_ATOMS].sort());
  const template = editableTemplate(pkg.fixture)!;
  const kinds = atomKindsFor(pkg.schema, template);
  (pkg.fixture.sections as JsonObject[]).forEach((section, index) => {
    const keys = slots.MAREN_NULLABLE_BY_SECTION[section.type as string] ?? [];
    const expected = keys.length === 0 ? undefined : Object.fromEntries(keys.map((key) => [key, slots.MAREN_NULLABLE_ATOMS[key]]));
    assert.deepEqual(getAtPath(kinds, ['sections', index, 'content']), expected, `recipe.schema.json x-atom kinds match slots.ts at sections[${index}]`);
  });
});
