/**
 * Wrenfield nullable license and footer-fact atoms, end to end.
 *
 * The family accepts null for the six footer atoms a client brief may legitimately not state
 * (plus the other fact atoms — nav phone label, hero badges and annotations, trust items and
 * marks, featured caption, footer phone and email — covered by the last test below), the
 * renderer omits the whole fragment rather than emitting an orphan heading or an empty list, and
 * the fast lane carries null from the model's answer into the recipe without a repair.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { loadFamilyPackage } from '../src/family.ts';
import { buildUserPrompt } from '../src/prompt.ts';
import { runFastLane } from '../src/run.ts';
import { atomKindsFor, editableTemplate, getAtPath, isObject, nullablePathsOf, type Json, type JsonObject } from '../src/spine.ts';
import { fakeModel, promptBlock, WRENFIELD_DIR, type Filler } from './fixtures.ts';

const pkg = await loadFamilyPackage(WRENFIELD_DIR, 'wrenfield');
const ENTRY = 'wrenfield-r1.html';
const BRIEF = 'Alder & Finch, a two-person remodeling crew in Bend, Oregon. The crew states no license number, no named service areas beyond its home city and no posted hours.';
const NULLABLE_ATOMS = ['license', 'area1', 'area2', 'area3', 'hours1', 'hours2'] as const;
const nullingFill: Filler = (key, _value, _at, limit) =>
  (NULLABLE_ATOMS as readonly string[]).includes(key) ? null : `New ${key} for Alder`.slice(0, limit);

const footerOf = (recipe: Json): JsonObject => getAtPath(recipe, ['sections', 9, 'content']) as JsonObject;

function withNulls(...keys: readonly string[]): JsonObject {
  const recipe = structuredClone(pkg.fixture);
  const footer = footerOf(recipe);
  for (const key of keys) footer[key] = null;
  return recipe;
}

const render = (recipe: Json) => pkg.render(recipe, ENTRY).html;

test('the reference recipe still compiles unchanged, with every footer fragment present', () => {
  const html = render(pkg.fixture);
  assert.ok(html.includes('class="footer-license"'));
  assert.equal((html.match(/<div class="footer-col">/g) ?? []).length, 2, 'both the service-area and hours columns render');
});

test('every license and footer-fact atom null: the fragments leave no orphan heading or empty list', () => {
  const html = render(withNulls(...NULLABLE_ATOMS));
  assert.equal(html.includes('class="footer-license"'), false);
  assert.equal((html.match(/<div class="footer-col">/g) ?? []).length, 0, 'both columns go with their last item');
  assert.ok(html.includes('class="footer-wordmark"'), 'a required fact slot still renders');
  assert.ok(html.includes('class="footer-contact"'), 'the contact line stays while its phone and email are stated');
});

test('one atom null at a time: only that fragment goes, the rest of the block stands', () => {
  const noLicense = render(withNulls('license'));
  assert.equal(noLicense.includes('class="footer-license"'), false);
  assert.equal((noLicense.match(/<div class="footer-col">/g) ?? []).length, 2);

  const oneArea = render(withNulls('area1', 'area2'));
  assert.equal((oneArea.match(/<div class="footer-col">/g) ?? []).length, 2, 'the service-area column survives with one item left');

  const noHours = render(withNulls('hours1', 'hours2'));
  assert.equal((noHours.match(/<div class="footer-col">/g) ?? []).length, 1, 'only the hours column is gone');
});

test('the contract refuses null in a slot the family does not mark nullable', () => {
  assert.throws(() => render(withNulls('wordmark')), /wordmark: expected bounded plain text/);
  assert.throws(() => render(withNulls('copyright')), /copyright: expected bounded plain text/);
  const missingKey = withNulls();
  delete footerOf(missingKey).license;
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

test('a model that nulls every license and footer-fact atom is merged as-is, never repaired', async () => {
  const model = fakeModel({ fill: nullingFill });
  const report = await runFastLane({ pkg, brief: BRIEF, mode: 'sections', entry: ENTRY, revision: 1, model, modelName: 'fake' });
  assert.equal(report.repairs, 0);
  assert.deepEqual(report.missing, []);
  assert.deepEqual(report.nulled.slice().sort(), NULLABLE_ATOMS.map((key) => `sections[9].content.${key}`).sort());
  const footer = footerOf(report.recipe);
  for (const key of NULLABLE_ATOMS) assert.equal(footer[key], null, key);
  assert.ok(isObject(footer) && typeof footer.copyright === 'string', 'a required slot is still written');
  assert.equal(report.html.includes('class="footer-license"'), false);
});

test('the schema, the slot map and the renderer agree on which atoms are nullable', async () => {
  const slots = await import(path.join(WRENFIELD_DIR, 'compiler/scripts/families/wrenfield/slots.ts')) as { WRENFIELD_NULLABLE_ATOMS: Record<string, string> };
  // Beyond the six footer atoms, every other fact slot is nullable too: the nav phone label, the
  // hero's rating and license badges and photo annotations, the trust items and partner marks,
  // the featured caption, and the footer phone and email.
  const OTHER_FOOTER_ATOMS = ['phone', 'email'] as const;
  // The three testimonial attributions carry the shared x-atom: 'person-name' gate marker (G5
  // round 2) and are nullable for the same reason as every other fact atom here: a review with no
  // named author renders with no name, never one the model invented.
  const ATTRIBUTION_ATOMS = ['attribution1', 'attribution2', 'attribution3'] as const;
  const ALL_NULLABLE_ATOMS = [
    'phoneLabel', 'ratingBadge', 'licenseBadge', 'annotationRoofLabel', 'annotationSidingLabel', 'annotationWindowsLabel',
    'item1', 'item2', 'item3', 'mark1', 'mark2', 'mark3', 'caption', ...ATTRIBUTION_ATOMS, ...OTHER_FOOTER_ATOMS, ...NULLABLE_ATOMS,
  ] as const;
  assert.deepEqual(Object.keys(slots.WRENFIELD_NULLABLE_ATOMS).sort(), [...ALL_NULLABLE_ATOMS].sort());
  const kinds = atomKindsFor(pkg.schema, editableTemplate(pkg.fixture)!);
  const footerKinds = getAtPath(kinds, ['sections', 9, 'content']);
  const NULLABLE_ATOMS_RECORD = Object.fromEntries([...NULLABLE_ATOMS, ...OTHER_FOOTER_ATOMS].map((key) => [key, slots.WRENFIELD_NULLABLE_ATOMS[key]]));
  assert.deepEqual(footerKinds, NULLABLE_ATOMS_RECORD, 'recipe.schema.json x-atom kinds match slots.ts for the footer atoms');
  // Every atom named in slots.ts has a matching nullable leaf somewhere in the schema, and vice versa.
  const keysInSchema = [...nullablePathsOf(kinds)].map((label) => label.split('.').pop()!).sort();
  assert.deepEqual(keysInSchema, [...ALL_NULLABLE_ATOMS].sort(), 'every schema-nullable leaf is named in slots.ts, and vice versa');
});
