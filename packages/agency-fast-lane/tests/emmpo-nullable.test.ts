/**
 * Emmpo nullable copyright-line atoms, end to end.
 *
 * The family has no contact, hours or license slot at all (it is a single-page course-catalog
 * site with no address, phone or footer contact block); the closest genuinely optional fact is
 * the footer's copyright line, split into a brand cell, a year cell and a rights-reserved line.
 * The year and the rights-reserved line accept null for a fact a client brief does not state
 * (the family's other fact atoms -- the discover figure and the courses duration -- are listed
 * per section in EMMPO_NULLABLE_BY_SECTION);
 * the brand cell stays required (it is brand copy, not a fact). Both atoms appear twice: once
 * in the `footer` section, and once more in the `courses` section's own embedded copy of the
 * same footer markup -- the renderer drops each fragment independently.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { loadFamilyPackage } from '../src/family.ts';
import { buildUserPrompt } from '../src/prompt.ts';
import { runFastLane } from '../src/run.ts';
import { atomKindsFor, editableTemplate, getAtPath, isObject, type Json, type JsonObject } from '../src/spine.ts';
import { EMMPO_DIR, fakeModel, promptBlock, type Filler } from './fixtures.ts';

const pkg = await loadFamilyPackage(EMMPO_DIR, 'emmpo');
const renderModule = await import(path.join(EMMPO_DIR, 'compiler/scripts/families/emmpo/render.ts')) as {
  stripKnownFragment: (template: string, pattern: RegExp, placeholder: string) => string;
};
const ENTRY = 'emmpo-r1.html';
const BRIEF = 'Foundry Learning, a small cohort-based upskilling course provider. The site states no copyright year and no rights-reserved notice in its footer.';
const NULLABLE_ATOMS = ['footer-copyrights-elem-2', 'footer-copyrights-bottom'] as const;
const nullingFill: Filler = (key, _value, _at, limit) =>
  (NULLABLE_ATOMS as readonly string[]).includes(key) ? null : `New ${key} for Foundry`.slice(0, limit);

const footerOf = (recipe: Json): JsonObject => getAtPath(recipe, ['sections', 9, 'content']) as JsonObject;
const coursesOf = (recipe: Json): JsonObject => getAtPath(recipe, ['sections', 10, 'content']) as JsonObject;

function withNulls(section: JsonObject, ...keys: readonly string[]): void {
  for (const key of keys) section[key] = null;
}

const render = (recipe: Json) => pkg.render(recipe, ENTRY).html;

test('the reference recipe still compiles unchanged, with both copyright fragments present', () => {
  const html = render(pkg.fixture);
  assert.equal((html.match(/<div class="footer__copyrights-bottom/g) ?? []).length, 2, 'footer and the courses view each carry their own copy');
  assert.equal((html.match(/<div class="col-1 footer__copyrights-wrapper/g) ?? []).length, 2);
});

test('both copyright atoms null in the footer section: its own fragments are gone, the courses copy is untouched', () => {
  const recipe = structuredClone(pkg.fixture) as JsonObject;
  withNulls(footerOf(recipe), ...NULLABLE_ATOMS);
  const html = render(recipe);
  assert.equal((html.match(/<div class="footer__copyrights-bottom/g) ?? []).length, 1, 'only the courses copy remains');
  assert.equal((html.match(/<div class="col-1 footer__copyrights-wrapper/g) ?? []).length, 1);
  assert.ok(html.includes('class="footer__copyrights-elem'), 'the required brand cell still renders');
});

test('both copyright atoms null in both places: no orphan fragment anywhere', () => {
  const recipe = structuredClone(pkg.fixture) as JsonObject;
  withNulls(footerOf(recipe), ...NULLABLE_ATOMS);
  withNulls(coursesOf(recipe), ...NULLABLE_ATOMS);
  const html = render(recipe);
  assert.equal(html.includes('<div class="footer__copyrights-bottom'), false);
  assert.equal(html.includes('<div class="col-1 footer__copyrights-wrapper'), false);
  assert.equal((html.match(/class="footer__copyrights-elem(?: animated)?"/g) ?? []).length, 2, 'the required brand cell still renders in both places');
});

test('the contract refuses null in a slot the family does not mark nullable', () => {
  const recipe1 = structuredClone(pkg.fixture) as JsonObject;
  withNulls(footerOf(recipe1), 'footer-copyrights-elem');
  assert.throws(() => render(recipe1), /footer-copyrights-elem: expected bounded plain text/);
  const missingKey = structuredClone(pkg.fixture) as JsonObject;
  delete footerOf(missingKey)['footer-copyrights-bottom'];
  assert.throws(() => render(missingKey), /unsupported or missing fields/, 'a nullable atom still has to be present');
});

test('the fill prompt names every nullable atom with its kind and stays parseable', () => {
  const template = editableTemplate(pkg.fixture)!;
  const kinds = atomKindsFor(pkg.schema, template)!;
  const prompt = buildUserPrompt({ brief: BRIEF, template, limits: { a: 1 }, nullable: kinds, scope: 'Fill the whole page template' });
  assert.ok(prompt.includes('\nNULLABLE\n'));
  assert.ok(prompt.includes('Return null for a fact the brief does not state'));
  assert.deepEqual(promptBlock(prompt, 'LIMITS'), { a: 1 });
});

test('a model that nulls every copyright atom in both places is merged as-is, never repaired', async () => {
  const model = fakeModel({ fill: nullingFill });
  const report = await runFastLane({ pkg, brief: BRIEF, mode: 'sections', entry: ENTRY, revision: 1, model, modelName: 'fake' });
  assert.equal(report.repairs, 0);
  assert.deepEqual(report.missing, []);
  const expected = [9, 10].flatMap((index) => NULLABLE_ATOMS.map((key) => `sections[${index}].content.${key}`));
  assert.deepEqual(report.nulled.slice().sort(), expected.sort());
  for (const getter of [footerOf, coursesOf]) {
    const section = getter(report.recipe);
    for (const key of NULLABLE_ATOMS) assert.equal(section[key], null, key);
    assert.ok(isObject(section) && typeof section['footer-copyrights-elem'] === 'string', 'the required brand cell is still written');
  }
  assert.equal(report.html.includes('<div class="footer__copyrights-bottom'), false);
});

test('the fragment strip fails loudly, not silently, if the template shape ever stops matching', () => {
  const { stripKnownFragment } = renderModule;
  const okTemplate = 'before <span>{{text:footer-copyrights-bottom}}</span> after';
  assert.equal(stripKnownFragment(okTemplate, /<span>\{\{text:footer-copyrights-bottom\}\}<\/span>/, '{{text:footer-copyrights-bottom}}'), 'before  after');
  const rewordedTemplate = 'before <p>{{text:footer-copyrights-bottom}}</p> after';
  assert.throws(
    () => stripKnownFragment(rewordedTemplate, /<span>\{\{text:footer-copyrights-bottom\}\}<\/span>/, '{{text:footer-copyrights-bottom}}'),
    /did not match the known template shape/,
    'a template edit the pattern no longer anchors to must not silently render an empty element',
  );
});

test('the schema, the slot map and the renderer agree on which atoms are nullable', async () => {
  const slots = await import(path.join(EMMPO_DIR, 'compiler/scripts/families/emmpo/slots.ts')) as {
    EMMPO_NULLABLE_ATOMS: Record<string, string>;
    EMMPO_NULLABLE_BY_SECTION: Record<string, readonly string[]>;
  };
  assert.deepEqual([...slots.EMMPO_NULLABLE_BY_SECTION.footer!].sort(), [...NULLABLE_ATOMS].sort());
  const kinds = atomKindsFor(pkg.schema, editableTemplate(pkg.fixture)!);
  (pkg.fixture.sections as Array<JsonObject | null>).forEach((section, index) => {
    if (section === null) return;
    const keys = slots.EMMPO_NULLABLE_BY_SECTION[section.type as string] ?? [];
    const expected = keys.length === 0 ? undefined : Object.fromEntries(keys.map((key) => [key, slots.EMMPO_NULLABLE_ATOMS[key]]));
    assert.deepEqual(getAtPath(kinds, ['sections', index, 'content']), expected, `recipe.schema.json x-atom kinds match slots.ts at sections[${index}]`);
  });
});
