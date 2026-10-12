/**
 * Fervor nullable contact and legal atoms, end to end.
 *
 * The family accepts null for the six contact-footer atoms a client brief may legitimately not
 * state (plus the hero photo credit and the contact email label, covered by the last test below), the renderer omits the whole fragment rather than emitting an orphan label or an empty
 * list, and the fast lane carries null from the model's answer into the recipe without a repair.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { loadFamilyPackage } from '../src/family.ts';
import { buildUserPrompt } from '../src/prompt.ts';
import { runFastLane } from '../src/run.ts';
import { atomKindsFor, editableTemplate, getAtPath, isObject, nullablePathsOf, type Json, type JsonObject } from '../src/spine.ts';
import { FERVOR_DIR, fakeModel, promptBlock, type Filler } from './fixtures.ts';

const pkg = await loadFamilyPackage(FERVOR_DIR, 'fervor');
const ENTRY = 'fervor-r1.html';
const BRIEF = 'Corvid Studio, a two-person brand and motion studio in Zurich. The studio states no street address, no social handles and no separate legal pages.';
const NULLABLE_ATOMS = ['addressLine', 'social1Label', 'social2Label', 'social3Label', 'legal1Label', 'legal2Label'] as const;
const nullingFill: Filler = (key, _value, _at, limit) =>
  (NULLABLE_ATOMS as readonly string[]).includes(key) ? null : `New ${key} for Corvid`.slice(0, limit);

const contactOf = (recipe: Json): JsonObject => getAtPath(recipe, ['sections', 8, 'content']) as JsonObject;

function withNulls(...keys: readonly string[]): JsonObject {
  const recipe = structuredClone(pkg.fixture);
  const contact = contactOf(recipe);
  for (const key of keys) contact[key] = null;
  return recipe;
}

const render = (recipe: Json) => pkg.render(recipe, ENTRY).html;

test('the reference recipe still compiles unchanged, with every contact fragment present', () => {
  const html = render(pkg.fixture);
  assert.ok(html.includes('class="site-footer__address"'));
  assert.ok(html.includes('class="site-footer__social"'));
  assert.ok(html.includes('site-footer__legal'));
  assert.ok(html.includes('Instagram'));
  assert.ok(html.includes('Privacy'));
});

test('every contact and legal atom null: the fragments leave no orphan label or empty list', () => {
  const html = render(withNulls(...NULLABLE_ATOMS));
  assert.equal(html.includes('class="site-footer__address"'), false);
  assert.equal(html.includes('class="site-footer__social"'), false, 'the social list goes with its last atom');
  assert.equal(html.includes('site-footer__legal'), false, 'the legal list goes with its last atom');
  for (const label of ['Zürich, Switzerland', 'Instagram', 'LinkedIn', 'Behance', 'Privacy', 'Imprint']) {
    assert.equal(html.includes(label), false, `no invented or orphaned fact: ${label}`);
  }
  assert.ok(html.includes('class="site-footer__email"'), 'an email atom left as text still renders');
  assert.ok(html.includes('site-footer__copyright'), 'a required fact slot still renders');
});

test('one atom null at a time: only that fragment goes, the rest of the block stands', () => {
  const noAddress = render(withNulls('addressLine'));
  assert.equal(noAddress.includes('class="site-footer__address"'), false);
  assert.ok(noAddress.includes('class="site-footer__social"'));
  assert.ok(noAddress.includes('site-footer__legal'));

  const oneSocial = render(withNulls('social1Label', 'social2Label'));
  assert.ok(oneSocial.includes('class="site-footer__social"'), 'the list survives with one item left');
  assert.ok(oneSocial.includes('Behance'));
  assert.equal(oneSocial.includes('Instagram'), false);

  const noLegal = render(withNulls('legal1Label', 'legal2Label'));
  assert.equal(noLegal.includes('site-footer__legal'), false);
  assert.ok(noLegal.includes('class="site-footer__social"'));
});

test('the contract refuses null in a slot the family does not mark nullable', () => {
  assert.throws(() => render(withNulls('headline')), /headline: expected bounded plain text/);
  assert.throws(() => render(withNulls('copyright')), /copyright: expected bounded plain text/);
  const missingKey = withNulls();
  delete contactOf(missingKey).addressLine;
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

test('a model that nulls every contact and legal atom is merged as-is, never repaired', async () => {
  const model = fakeModel({ fill: nullingFill });
  const report = await runFastLane({ pkg, brief: BRIEF, mode: 'sections', entry: ENTRY, revision: 1, model, modelName: 'fake' });
  assert.equal(report.repairs, 0);
  assert.deepEqual(report.missing, []);
  assert.deepEqual(report.nulled.slice().sort(), NULLABLE_ATOMS.map((key) => `sections[8].content.${key}`).sort());
  const contact = contactOf(report.recipe);
  for (const key of NULLABLE_ATOMS) assert.equal(contact[key], null, key);
  assert.ok(isObject(contact) && typeof contact.copyright === 'string', 'a required slot is still written');
  assert.equal(report.html.includes('class="site-footer__address"'), false);
  assert.equal(report.html.includes('class="site-footer__social"'), false);
});

test('the schema, the slot map and the renderer agree on which atoms are nullable', async () => {
  const slots = await import(path.join(FERVOR_DIR, 'compiler/scripts/families/fervor/slots.ts')) as { FERVOR_NULLABLE_ATOMS: Record<string, string> };
  // Beyond the six contact-footer atoms, the hero's photo credit (it names a piece of work), the
  // contact email label (the address itself), and the testimonial's attribution (x-atom:
  // 'person-name', G5 round 2 — a testimonial with no named author renders with no name, never
  // one the model invented) are nullable too.
  const ALL_NULLABLE_ATOMS = ['whisperCredit', 'emailLabel', 'attribution', ...NULLABLE_ATOMS] as const;
  assert.deepEqual(Object.keys(slots.FERVOR_NULLABLE_ATOMS).sort(), [...ALL_NULLABLE_ATOMS].sort());
  const kinds = atomKindsFor(pkg.schema, editableTemplate(pkg.fixture)!);
  const merged = {
    ...(getAtPath(kinds, ['sections', 1, 'content']) as JsonObject),
    ...(getAtPath(kinds, ['sections', 7, 'content']) as JsonObject),
    ...(getAtPath(kinds, ['sections', 8, 'content']) as JsonObject),
  };
  assert.deepEqual(merged, slots.FERVOR_NULLABLE_ATOMS, 'recipe.schema.json x-atom kinds match slots.ts');
  const keysInSchema = [...nullablePathsOf(kinds)].map((label) => label.split('.').pop()!).sort();
  assert.deepEqual(keysInSchema, [...ALL_NULLABLE_ATOMS].sort(), 'every schema-nullable leaf is named in slots.ts, and vice versa');
});
