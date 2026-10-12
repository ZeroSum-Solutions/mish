/**
 * Halcyon nullable contact, hours and legal atoms, end to end.
 *
 * The family accepts null for the eight footer row atoms ("Find us" address/phone/email,
 * "Open" hours) and the footer's legal copyright line, all facts a client brief may legitimately
 * not state. The renderer drops the whole row -- and the whole column once every row in it is
 * null -- or the whole legal paragraph, and the fast lane carries null from the model's answer
 * into the recipe without a repair. The collection section's five room object counts are the
 * same kind of atom, exercised separately below since they live in a different section. The
 * family has more fact atoms (hero rail values, dates, times, prices, visit rows); the agreement
 * test covers every one of them against the schema, and the family's own render.test.ts
 * ("omits unsupported facts") covers their rendering.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { loadFamilyPackage } from '../src/family.ts';
import { buildUserPrompt } from '../src/prompt.ts';
import { runFastLane } from '../src/run.ts';
import { atomKindsFor, editableTemplate, getAtPath, isObject, type Json, type JsonObject } from '../src/spine.ts';
import { fakeModel, HALCYON_DIR, promptBlock, type Filler } from './fixtures.ts';

const pkg = await loadFamilyPackage(HALCYON_DIR, 'halcyon');
const ENTRY = 'halcyon-r1.html';
const BRIEF = 'Meridian House, a small contemporary-art space in Halifax. The house states no street address, no phone, no email, no posted hours and no copyright notice; visits are by appointment only.';
const NULLABLE_ATOMS = ['col1Row1', 'col1Row2', 'col1Row3', 'col1Row4', 'col2Row1', 'col2Row2', 'col2Row3', 'col2Row4', 'legal'] as const;
// The collection section's five room object counts: an invented, precise figure outside the
// optional support section, so it survives that section being dropped.
const ROOM_NULLABLE_ATOMS = ['room1Count', 'room2Count', 'room3Count', 'room4Count', 'room5Count'] as const;
const nullingFill: Filler = (key, _value, _at, limit) =>
  (NULLABLE_ATOMS as readonly string[]).includes(key) ? null : `New ${key} for Meridian`.slice(0, limit);

const footerOf = (recipe: Json): JsonObject => getAtPath(recipe, ['sections', 9, 'content']) as JsonObject;
const collectionOf = (recipe: Json): JsonObject => getAtPath(recipe, ['sections', 3, 'content']) as JsonObject;

function withNulls(...keys: readonly string[]): JsonObject {
  const recipe = structuredClone(pkg.fixture);
  const footer = footerOf(recipe);
  for (const key of keys) footer[key] = null;
  return recipe;
}

const render = (recipe: Json) => pkg.render(recipe, ENTRY).html;

test('the reference recipe still compiles unchanged, with both footer columns present', () => {
  const html = render(pkg.fixture);
  assert.equal((html.match(/<div class="footer-col">/g) ?? []).length, 3, 'Find us, Open and Explore all render');
});

test('every contact, hours and legal atom null: both columns and the legal line leave no orphan title or empty element', () => {
  const html = render(withNulls(...NULLABLE_ATOMS));
  assert.equal((html.match(/<div class="footer-col">/g) ?? []).length, 1, 'only Explore remains, its own rows are links, not nullable atoms');
  assert.equal(html.includes('class="footer-title"') && html.match(/class="footer-title"/g)!.length, 1, 'the Find-us and Open column titles go with their last row');
  assert.ok(html.includes('class="footer-wordmark"'), 'a required fact slot still renders');
  assert.equal(html.includes('class="footer-legal"'), false, 'the legal copyright line is dropped');
  assert.ok(html.includes('class="footer-disclaimer"'), 'the disclaimer paragraph is not a nullable atom');
});

test('one column null at a time: only that column goes, the rest of the footer stands', () => {
  const noFindUs = render(withNulls('col1Row1', 'col1Row2', 'col1Row3', 'col1Row4'));
  assert.equal((noFindUs.match(/<div class="footer-col">/g) ?? []).length, 2, 'Open and Explore remain');

  const oneRow = render(withNulls('col1Row1', 'col1Row2'));
  assert.equal((oneRow.match(/<div class="footer-col">/g) ?? []).length, 3, 'the column survives with rows left');

  const noLegal = render(withNulls('legal'));
  assert.equal(noLegal.includes('class="footer-legal"'), false);
  assert.ok(noLegal.includes('class="footer-disclaimer"'), 'the disclaimer stands on its own');
});

test('the contract refuses null in a slot the family does not mark nullable', () => {
  assert.throws(() => render(withNulls('brandWord')), /brandWord: expected bounded plain text/);
  assert.throws(() => render(withNulls('col1Title')), /col1Title: expected bounded plain text/);
  const missingKey = withNulls();
  delete footerOf(missingKey).col1Row1;
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

test('a model that nulls every contact and hours atom is merged as-is, never repaired', async () => {
  const model = fakeModel({ fill: nullingFill });
  const report = await runFastLane({ pkg, brief: BRIEF, mode: 'sections', entry: ENTRY, revision: 1, model, modelName: 'fake' });
  assert.equal(report.repairs, 0);
  assert.deepEqual(report.missing, []);
  // Every nullable hours-row value (the visit rows' values) shows null in TEMPLATE (PR #137), so a
  // model that keeps them null nulls them.
  assert.deepEqual(report.nulled.slice().sort(), [...NULLABLE_ATOMS.map((key) => `sections[9].content.${key}`), ...[1, 2, 3, 4].map((n) => `sections[6].content.block1Value${n}`)].sort());
  // The hero rail's hours rows (railValue1-3, `x-verify: 'hours-null'`) are null before the fill and
  // locked (PR #137 final ruling): the model never sees them, and the recipe carries null.
  const hero = (report.recipe as { sections: Array<{ content: Record<string, unknown> }> }).sections[1]!.content;
  for (const key of ['railValue1', 'railValue2', 'railValue3']) assert.equal(hero[key], null, key);
  const footer = footerOf(report.recipe);
  for (const key of NULLABLE_ATOMS) assert.equal(footer[key], null, key);
  assert.ok(isObject(footer) && typeof footer.disclaimer === 'string', 'a required slot is still written');
  assert.equal((report.html.match(/<div class="footer-col">/g) ?? []).length, 1);
  // The rail pair and the "free after" row are null (several open rows; no verbatim row): the
  // page hides those three rail rows and keeps the fourth.
  assert.equal((report.html.match(/class="rail-row"/g) ?? []).length, 1);
});

test('the schema, the slot map and the renderer agree on which atoms are nullable', async () => {
  const slots = await import(path.join(HALCYON_DIR, 'compiler/scripts/families/halcyon/slots.ts')) as { HALCYON_NULLABLE_ATOMS: Record<string, string> };
  for (const key of [...NULLABLE_ATOMS, ...ROOM_NULLABLE_ATOMS]) assert.ok(Object.hasOwn(slots.HALCYON_NULLABLE_ATOMS, key), `${key} stays nullable`);
  const allKinds = atomKindsFor(pkg.schema, editableTemplate(pkg.fixture)!);
  const sections = pkg.fixture.sections as JsonObject[];
  let seen = 0;
  sections.forEach((section, index) => {
    const content = section.content as JsonObject;
    const expected = Object.fromEntries(Object.keys(content).filter((key) => Object.hasOwn(slots.HALCYON_NULLABLE_ATOMS, key)).map((key) => [key, slots.HALCYON_NULLABLE_ATOMS[key]]));
    seen += Object.keys(expected).length;
    const actual = getAtPath(allKinds, ['sections', index, 'content']);
    if (Object.keys(expected).length === 0) assert.ok(actual === undefined || (isObject(actual) && Object.keys(actual).length === 0), `${section.id}: no x-atom`);
    else assert.deepEqual(actual, expected, `recipe.schema.json x-atom kinds match slots.ts for ${section.id}`);
  });
  assert.equal(seen, Object.keys(slots.HALCYON_NULLABLE_ATOMS).length, 'every slots.ts atom sits in the schema, in one section');
});

test('a room count explicitly null: the count span is gone, the room name stands', () => {
  const recipe = structuredClone(pkg.fixture);
  collectionOf(recipe).room1Count = null;
  const html = render(recipe);
  assert.doesNotMatch(html, /class="room-count"[^<]*<[^>]*>412 objects/);
  assert.match(html, /class="room-name">/, 'the room name still renders');
  assert.match(html, />Ceramics and Vessels</, 'the room name text is unaffected');
  assert.match(html, /class="room-count"[^<]*<[^>]*>268 objects/, 'an untouched room keeps its count');
});
