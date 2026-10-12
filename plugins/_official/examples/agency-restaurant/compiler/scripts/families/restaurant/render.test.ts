/**
 * restaurant family render tests.
 * Run: node --experimental-strip-types --test render.test.ts
 *
 * Drives the family module directly (validate, render, slot lookup), the surface the compiler's
 * `families/registry.ts` dispatches through. The expected slot roster, the schema and the
 * nullable atoms are all rebuilt from `SECTIONS` (slots.ts), so a drift between slots.ts,
 * contract.ts, recipe.schema.json and render.ts fails here.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { dishonestLinks } from '../../sections.ts';
import { recipeSchema } from './contract.ts';
import {
  findRestaurantTextSlot, getRestaurantAssetRequirements, listRestaurantTextSlots,
  renderRestaurant, validateRestaurantRecipe,
} from './render.ts';
import { BRAND_SLOTS, FAMILY_ID, RESTAURANT_BLOCKS, RESTAURANT_OPTIONAL_SECTIONS, SECTIONS, SECTION_ORDER, type FieldSpec } from './slots.ts';

const HERE = import.meta.dirname;
const KIT = path.join(HERE, '../../../../../../shared/ui-kits/hyperui');
const FIXTURE = JSON.parse(readFileSync(path.join(HERE, 'reference.fixture.json'), 'utf8'));
const clone = () => structuredClone(FIXTURE);
/** The first plain (not list, not nullable) text field of section 1, for the refusal cases. */
const PLAIN = SECTIONS[1]!.text.find((field) => field.list === undefined && !field.atom)!;

function compile(recipeInput: unknown) {
  const recipe = validateRestaurantRecipe(recipeInput);
  assert.deepEqual(getRestaurantAssetRequirements(recipe), [], 'no image, font or video assets');
  const html = renderRestaurant(recipe, {});
  return { recipe, html };
}
function refusal(recipeInput: unknown): string {
  try { compile(recipeInput); } catch (error) { return error instanceof Error ? error.message : String(error); }
  throw new Error('expected a refusal, the compiler accepted the recipe');
}

function fieldIds(prefix: string, field: FieldSpec): string[] {
  return field.list === undefined ? [`${prefix}--${field.name}`] : Array.from({ length: field.list }, (_, j) => `${prefix}--${field.name}-${j}`);
}
/** Every slot id a fully populated recipe renders, in document order, from slots.ts alone. */
function expectedSlotIds(): string[] {
  const ids = ['brand--name', 'brand--descriptor'];
  for (const section of SECTIONS) {
    for (const field of section.text) ids.push(...fieldIds(section.id, field));
    for (let i = 0; i < (section.items?.count ?? 0); i++) for (const field of section.items!.fields) ids.push(...fieldIds(`${section.id}--items-${i}`, field));
  }
  return ids;
}
/** Every nullable atom: where it sits in a recipe and the one slot id it renders. */
function atoms(): { index: number; item?: number; name: string; id: string }[] {
  const out: { index: number; item?: number; name: string; id: string }[] = [];
  SECTIONS.forEach((section, index) => {
    for (const field of section.text) if (field.atom) out.push({ index, name: field.name, id: `${section.id}--${field.name}` });
    for (let i = 0; i < (section.items?.count ?? 0); i++) {
      for (const field of section.items!.fields) if (field.atom) out.push({ index, item: i, name: field.name, id: `${section.id}--items-${i}--${field.name}` });
    }
  });
  return out;
}
/** The slot ids a null atom takes off the page: its own, plus the day label of an hours row whose value it is. */
function droppedIds(atom: ReturnType<typeof atoms>[number]): string[] {
  const section = SECTIONS[atom.index]!;
  const label = atom.item === undefined ? undefined : section.items!.fields.find((field) => field.hoursValue === atom.name);
  return label ? [atom.id, `${section.id}--items-${atom.item}--${label.name}`] : [atom.id];
}
function setAtom(recipe: { sections: { text: Record<string, unknown>; items?: Record<string, unknown>[] }[] }, atom: ReturnType<typeof atoms>[number], value: unknown): void {
  const section = recipe.sections[atom.index]!;
  if (atom.item === undefined) section.text[atom.name] = value;
  else section.items![atom.item]![atom.name] = value;
}

test('a valid fixture renders every section in roster order, under the size guard', () => {
  const { html } = compile(clone());
  assert.match(html, /^<!doctype html>/);
  assert.ok(Buffer.byteLength(html, 'utf8') < 200 * 1024, 'under 200 KB');
  const positions = SECTION_ORDER.map((id) => html.indexOf(`id="${id}"`));
  assert.ok(positions.every((at) => at > 0), 'every roster section is present');
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b), 'sections render in roster order');
});

test('every text slot renders exactly once, in the order slots.ts declares', () => {
  const { html } = compile(clone());
  const ids = listRestaurantTextSlots(html);
  assert.deepEqual(ids, expectedSlotIds());
  assert.equal(new Set(ids).size, ids.length, 'data-od-id values are unique');
  assert.equal(findRestaurantTextSlot(html, 'brand--name'), FIXTURE.brand.name);
  assert.equal(findRestaurantTextSlot(html, `${SECTIONS[1]!.id}--${PLAIN.name}`), FIXTURE.sections[1].text[PLAIN.name]);
});

test('slot containment is bidirectional: every declared slot is emitted, and every emitted id is declared', () => {
  const { html } = compile(clone());
  const emitted = new Set(listRestaurantTextSlots(html));
  const declared = new Set(expectedSlotIds());
  for (const id of emitted) assert.ok(declared.has(id), `${id}: emitted but not declared in slots.ts`);
  for (const id of declared) assert.ok(emitted.has(id), `${id}: declared in slots.ts but never emitted`);
  assert.equal(emitted.size, declared.size, 'no id is emitted more than once either');
});

test('a max-length value renders intact end to end, with no silent truncation', () => {
  // The brand descriptor (200) and the story body (280, this family's single longest text
  // field) both sit outside any list or item repeat, so setting either directly and re-reading
  // it back through the rendered HTML proves slot() never clips a value at its own bound.
  const withDescriptor = clone();
  const descriptorMax = BRAND_SLOTS.find((slot) => slot.name === 'descriptor')!.max;
  const descriptorValue = 'x'.repeat(descriptorMax);
  withDescriptor.brand.descriptor = descriptorValue;
  const { html: htmlA, recipe: validatedA } = compile(withDescriptor);
  assert.equal(validatedA.brand.descriptor, descriptorValue, 'not truncated after validation');
  assert.equal(findRestaurantTextSlot(htmlA, 'brand--descriptor'), descriptorValue, 'not truncated in the rendered HTML');

  const storySection = SECTIONS.find((section) => section.id === 'restaurant-story')!;
  const storyBody = storySection.text.find((field) => field.name === 'body')!;
  const withStory = clone();
  const storyIndex = withStory.sections.findIndex((section: { id: string }) => section.id === 'restaurant-story');
  const storyValue = 'y'.repeat(storyBody.max);
  withStory.sections[storyIndex].text.body = storyValue;
  const { html: htmlB } = compile(withStory);
  assert.equal(findRestaurantTextSlot(htmlB, 'restaurant-story--body'), storyValue, 'the family\'s longest field is not truncated');
});

test('recipe.schema.json is exactly the schema contract.ts derives from slots.ts', () => {
  const committed = JSON.parse(readFileSync(path.join(HERE, 'recipe.schema.json'), 'utf8'));
  assert.deepEqual(committed, recipeSchema());
});

test('the package default spine is the reference fixture', () => {
  const recipe = JSON.parse(readFileSync(path.join(HERE, `../../../../families/${FAMILY_ID}/recipe.json`), 'utf8'));
  assert.deepEqual(recipe, FIXTURE);
});

test('every class the page uses comes from one of the page kind\'s vendored HyperUI blocks', () => {
  // pagekinds.json — not slots.ts's own RESTAURANT_BLOCKS constant — is the source of truth for
  // which blocks this family actually declares as shipped; slots.ts is cross-checked against it,
  // not the other way round, so a drift between the two fails on the declaration itself.
  const pageKinds = JSON.parse(readFileSync(path.join(KIT, 'pagekinds.json'), 'utf8')) as Record<string, string[]>;
  const declaredBlocks = pageKinds[FAMILY_ID];
  assert.ok(Array.isArray(declaredBlocks) && declaredBlocks.length > 0, `pagekinds.json: no "${FAMILY_ID}" entry`);
  assert.deepEqual([...RESTAURANT_BLOCKS], declaredBlocks, 'slots.ts RESTAURANT_BLOCKS matches the pagekinds.json declaration');

  const classesIn = (html: string) => new Set([...html.replaceAll('&amp;', '&').matchAll(/\sclass="([^"]*)"/g)].flatMap((match) => match[1]!.split(/\s+/).filter(Boolean)));
  const known = new Set<string>();
  for (const block of declaredBlocks!) {
    const blockPath = path.join(KIT, 'blocks', `${block}.html`);
    let source: string;
    try {
      source = readFileSync(blockPath, 'utf8');
    } catch (error) {
      // Fail loudly and by name, not with node:fs's own ENOENT stack: a block pagekinds.json
      // declares but the vendored tree does not carry is this family's own missing-file bug.
      assert.fail(`pagekinds.json declares block "${block}" but ${blockPath} does not exist (${error instanceof Error ? error.message : String(error)})`);
    }
    for (const token of classesIn(source)) known.add(token);
  }
  const missing = [...classesIn(compile(clone()).html)].filter((token) => !known.has(token));
  assert.deepEqual(missing, [], 'classes css/<kind>.css would not carry');
});

test('the optional section drops to null and renders nothing; a null elsewhere is refused', () => {
  const index = SECTIONS.findIndex((section) => section.optional);
  const optional = SECTIONS[index]!;
  assert.deepEqual([...RESTAURANT_OPTIONAL_SECTIONS], [optional.type], 'exactly one optional section');
  const dropped = clone();
  dropped.sections[index] = null;
  const { html } = compile(dropped);
  assert.ok(!html.includes(`id="${optional.id}"`), 'no section wrapper');
  assert.ok(!html.includes(`data-od-id="${optional.id}`), 'no edit targets');
  assert.deepEqual(listRestaurantTextSlots(html), expectedSlotIds().filter((id) => !id.startsWith(`${optional.id}--`)));
  const required = clone();
  required.sections[index === 0 ? 1 : 0] = null;
  assert.match(refusal(required), /sections\[\d+\]: expected a plain object/);
});

test('each nullable atom drops only its own element (an hours value, its whole row); a null in a plain slot is refused', () => {
  const list = atoms();
  assert.ok(list.length > 0, 'the family has nullable atoms');
  for (const atom of list) {
    const recipe = clone();
    setAtom(recipe, atom, null);
    const { html } = compile(recipe);
    assert.deepEqual(listRestaurantTextSlots(html), expectedSlotIds().filter((id) => !droppedIds(atom).includes(id)), atom.id);
  }
  const all = clone();
  for (const atom of list) setAtom(all, atom, null);
  const ids = listRestaurantTextSlots(compile(all).html);
  // Every atom null at once also empties the hours-and-location section, which then leaves the page whole (its heading too).
  const gone = new Set([...list.flatMap(droppedIds), 'restaurant-hours-location--heading']);
  assert.deepEqual(ids, expectedSlotIds().filter((id) => !gone.has(id)), 'every atom null at once');
  assert.ok(!compile(all).html.includes('href="#restaurant-hours-location"'), 'no nav link to the emptied section');
  const plain = clone();
  plain.sections[1].text[PLAIN.name] = null;
  assert.match(refusal(plain), new RegExp(`sections\\[1\\]\\.text\\.${PLAIN.name}: expected plain text`));
});

test('email and phone atoms are format-checked', () => {
  for (const atom of atoms()) {
    const recipe = clone();
    if (atom.name === 'email' || atom.name.toLowerCase().endsWith('email')) {
      setAtom(recipe, atom, 'not an email');
      assert.match(refusal(recipe), /expected an email address/);
    }
    if (atom.name === 'phone') {
      setAtom(recipe, atom, 'call us');
      assert.match(refusal(recipe), /expected a phone number/);
    }
  }
});

test('phone allows at most one separator character between digit runs, and accepts common punctuated formats', () => {
  const phoneAtoms = atoms().filter((atom) => atom.name === 'phone');
  assert.ok(phoneAtoms.length > 0, 'the family has phone atoms');
  // Every invalid case here has >= 7 digits, so it fails on the separator-run SHAPE specifically
  // (a run of two or more separator characters with no digit between them), not on digit count.
  const invalid = [
    '1--2', '123--4567', '123  4567', '1- - -2', '1- - - -2345678', '1-(-(-(-2345678',
    // Every "(" here legally follows a digit run one at a time — only the whole-string
    // "at most one '(' " rule refuses this, not the alternation check.
    '1 (2 (3 (4 (5 (6 (7',
    '12 . . 34567', '1----2', '1 . . . 2', '206----5550148', '206 . . . 5550148', 'call us',
    // "+" is only ever stripped as the very first character; one anywhere else is neither a
    // digit nor a recognized separator token, so it refuses the whole value outright.
    '1+2065550148',
  ];
  const valid = [
    '206-555-0148', '+1 (206) 555-0148', '(828) 555-0135', '020 7946 0958', '+44 20 7946 0958',
    '555.010.9999', '2065550148', '0123456789',
  ];
  for (const atom of phoneAtoms) {
    for (const bad of invalid) {
      const recipe = clone();
      setAtom(recipe, atom, bad);
      assert.match(refusal(recipe), /expected a phone number/, `${atom.id}: "${bad}" should be refused`);
    }
    for (const good of valid) {
      const recipe = clone();
      setAtom(recipe, atom, good);
      assert.doesNotThrow(() => compile(recipe), `${atom.id}: "${good}" should be accepted`);
    }
  }
});

test('a filled phone renders as a tel: link and a filled email as a mailto: link, matching the literal fixture values; a null atom renders nothing', () => {
  // Looked up by id, not by a hardcoded sections[] index: SECTIONS reordering must not silently
  // point this pinned assertion at the wrong section.
  const sectionById = (id: string) => FIXTURE.sections.find((section: { id: string }) => section.id === id);
  const hoursLocation = sectionById('restaurant-hours-location');
  const footer = sectionById('restaurant-footer');
  assert.ok(hoursLocation, 'restaurant-hours-location section exists in the fixture');
  assert.ok(footer, 'restaurant-footer section exists in the fixture');

  // Literal expected strings for THIS fixture (reference.fixture.json), not derived by re-running
  // telAtom/mailAtom's own transform — a wrong stripped-character set or a wrong percent-encoding
  // in render.ts would still fail this test, unlike asserting against `value.replace(...)` again.
  assert.equal(hoursLocation.text.phone, '206-555-0148', 'hours-location phone, pinned');
  assert.equal(footer.text.phone, '206-555-0148', 'footer phone, pinned');
  assert.equal(footer.text.email, 'hello@velatrattoria.example', 'footer email, pinned');
  const { html } = compile(clone());

  const telFragment = (id: string) => new RegExp(`<a href="tel:([^"]*)"[^>]*data-od-id="${id}"[^>]*>([^<]*)</a>`).exec(html);
  const hoursLink = telFragment('restaurant-hours-location--phone');
  assert.ok(hoursLink, 'hours-location phone is an <a href="tel:...">');
  assert.equal(hoursLink![2], '206-555-0148', 'the link text is the filled atom, verbatim');
  assert.equal(hoursLink![1], '2065550148', 'the tel: target is the literal expected digit string');

  const footerLink = telFragment('restaurant-footer--phone');
  assert.ok(footerLink, 'footer phone is an <a href="tel:...">');
  assert.equal(footerLink![2], '206-555-0148');
  assert.equal(footerLink![1], '2065550148');

  const mailMatch = new RegExp(`<a href="mailto:([^"]*)"[^>]*data-od-id="restaurant-footer--email"[^>]*>([^<]*)</a>`).exec(html);
  assert.ok(mailMatch, 'footer email is an <a href="mailto:...">');
  assert.equal(mailMatch![2], 'hello@velatrattoria.example');
  assert.equal(mailMatch![1], 'hello%40velatrattoria.example', 'the mailto: target is the literal expected percent-encoding');

  // address stays plain text: no <a> wrapping it.
  assert.ok(!new RegExp(`<a[^>]*data-od-id="restaurant-footer--address"`).test(html), 'address is not a link');
  assert.equal(findRestaurantTextSlot(html, 'restaurant-footer--address'), '412 Fremont Ave N, Seattle, WA 98103');

  // Null atoms: nulling only the footer's phone/email removes exactly the footer's own tel:/
  // mailto:, leaves the hours-location phone link untouched, and leaves no dangling data-od-id.
  const dropped = clone();
  const footerIndex = dropped.sections.findIndex((s: { id: string }) => s.id === 'restaurant-footer');
  dropped.sections[footerIndex].text.phone = null;
  dropped.sections[footerIndex].text.email = null;
  const { html: droppedHtml } = compile(dropped);
  const footerFragment = /<footer\b[\s\S]*<\/footer>/.exec(droppedHtml)![0];
  assert.ok(!footerFragment.includes('tel:'), 'no stray tel: inside the footer once its phone is null');
  assert.ok(!footerFragment.includes('mailto:'), 'no stray mailto: inside the footer once its email is null');
  assert.ok(!footerFragment.includes('data-od-id="restaurant-footer--phone"'), 'no footer phone data-od-id');
  assert.ok(!footerFragment.includes('data-od-id="restaurant-footer--email"'), 'no footer email data-od-id');
  assert.ok(telFragment('restaurant-hours-location--phone'), 'the unrelated hours-location phone link is untouched');
  assert.ok(!new RegExp(`data-od-id="restaurant-footer--phone"`).test(droppedHtml));
  assert.ok(!new RegExp(`data-od-id="restaurant-footer--email"`).test(droppedHtml));
});

test('no <script appears anywhere, and CSP forbids it', () => {
  const { html } = compile(clone());
  assert.ok(!html.includes('<script'), 'no script tag');
  assert.match(html, /script-src 'none'/);
  assert.match(html, /form-action 'none'/);
});

test('exactly one <style> element carries the inlined HyperUI CSS once', () => {
  const { html } = compile(clone());
  assert.equal((html.match(/<style>/g) ?? []).length, 1);
  assert.match(html, /<style>\/\*! tailwindcss/);
  assert.ok(!html.includes('{{'), 'no unresolved template token');
});

test('an unknown field, markup and an over-long slot are refused and named', () => {
  const top = clone();
  top.theme = 'dark';
  assert.match(refusal(top), /recipe\.theme: unknown field/);
  const inner = clone();
  inner.sections[1].text.subhead = 'not a slot';
  assert.match(refusal(inner), /sections\[1\]\.text\.subhead: unknown field/);
  const tag = clone();
  tag.sections[1].text[PLAIN.name] = 'Hello <script>alert(1)</script>';
  assert.match(refusal(tag), new RegExp(`sections\\[1\\]\\.text\\.${PLAIN.name}: markup is not allowed`));
  const long = clone();
  long.sections[1].text[PLAIN.name] = 'x'.repeat(PLAIN.max + 1);
  assert.match(refusal(long), new RegExp(`sections\\[1\\]\\.text\\.${PLAIN.name}: at most ${PLAIN.max} characters`));
});

test('the fixed repeat counts are enforced, for items and for list fields', () => {
  SECTIONS.forEach((section, index) => {
    if (section.items) {
      const short = clone();
      short.sections[index].items.pop();
      assert.match(refusal(short), new RegExp(`sections\\[${index}\\]\\.items: expected exactly ${section.items.count} items`));
      const listField = section.items.fields.find((field) => field.list !== undefined);
      if (listField) {
        const shortList = clone();
        shortList.sections[index].items[0][listField.name].pop();
        assert.match(refusal(shortList), new RegExp(`sections\\[${index}\\]\\.items\\[0\\]\\.${listField.name}: expected exactly ${listField.list} items`));
      }
    }
    for (const field of section.text) {
      if (field.list === undefined) continue;
      const shortList = clone();
      shortList.sections[index].text[field.name].pop();
      assert.match(refusal(shortList), new RegExp(`sections\\[${index}\\]\\.text\\.${field.name}: expected exactly ${field.list} items`));
    }
  });
});

test('the section roster and its order are enforced', () => {
  const renamed = clone();
  renamed.sections[0].id = `${FAMILY_ID}-not-a-section`;
  assert.match(refusal(renamed), new RegExp(`sections\\[0\\]\\.id: expected "${SECTIONS[0]!.id}"`));
  const swapped = clone();
  [swapped.sections[0], swapped.sections[1]] = [swapped.sections[1], swapped.sections[0]];
  assert.throws(() => compile(swapped), /unknown field|expected "/);
  const dropped = clone();
  dropped.sections.pop();
  assert.match(refusal(dropped), new RegExp(`recipe\\.sections: expected exactly ${SECTIONS.length} sections`));
});

test('a bad revision or schema version is refused', () => {
  const revision = clone();
  revision.revision = 0;
  assert.match(refusal(revision), /recipe\.revision: expected a positive integer/);
  const version = clone();
  version.schemaVersion = 3;
  assert.match(refusal(version), /recipe\.schemaVersion: expected 2/);
});

test('the reference fixture carries no dishonest link: no "#" placeholder, no scheme-only href, no anchor to an id the page does not render (G5)', () => {
  const { html } = compile(clone());
  assert.deepEqual(dishonestLinks(html), []);
  assert.ok(!html.includes('href="#"'), 'never a "#" placeholder link');
});

test('reviews carry the shared gate markers: name is x-atom person-name, quote is x-verify quote (G5)', () => {
  const schema = recipeSchema() as { properties: { sections: { prefixItems: Array<{ properties: { id: { const: string }; items: { items: { properties: Record<string, Record<string, unknown>> } } } }> } } };
  const reviewsSection = schema.properties.sections.prefixItems.find((section) => section.properties.id.const === 'restaurant-reviews')!;
  const reviewFields = reviewsSection.properties.items.items.properties;
  assert.equal(reviewFields.name!['x-atom'], 'person-name');
  assert.equal(reviewFields.quote!['x-verify'], 'quote');
});

test('an hours-and-location section with no address, phone or hours rows is not on the page, nor in the nav', () => {
  // Devin, 2026-10-10: a Build with Jev brief with no hours or address left a bare "Hours and
  // location" heading with nothing under it, and a nav link that scrolled to it.
  const recipe = clone();
  const index = SECTIONS.findIndex((section) => section.id === 'restaurant-hours-location');
  const section = recipe.sections[index]!;
  section.text.address = null;
  section.text.phone = null;
  for (const item of section.items!) item.value = null;
  const { html } = compile(recipe);
  assert.ok(!html.includes('id="restaurant-hours-location"'), 'no empty section');
  assert.ok(!html.includes('href="#restaurant-hours-location"'), 'no nav link to it');
  assert.deepEqual(dishonestLinks(html), []);
  // One fact left keeps the section and its link.
  section.text.phone = '206-555-0148';
  const kept = compile(recipe).html;
  assert.ok(kept.includes('id="restaurant-hours-location"') && kept.includes('href="#restaurant-hours-location"'));
});
