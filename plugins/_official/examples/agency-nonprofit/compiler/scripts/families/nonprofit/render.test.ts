/**
 * nonprofit family render tests.
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
import { isPhoneNumber, recipeSchema } from './contract.ts';
import {
  findNonprofitTextSlot, getNonprofitAssetRequirements, listNonprofitTextSlots,
  renderNonprofit, validateNonprofitRecipe,
} from './render.ts';
import {
  EVENTS_SECTION_ID, FAMILY_ID, HEADER_SECTION_ID, NONPROFIT_BLOCKS, NONPROFIT_NULLABLE_ATOMS, NONPROFIT_OPTIONAL_SECTIONS,
  SECTIONS, SECTION_ORDER, type FieldSpec,
} from './slots.ts';

const HERE = import.meta.dirname;
const KIT = path.join(HERE, '../../../../../../shared/ui-kits/hyperui');
const FIXTURE = JSON.parse(readFileSync(path.join(HERE, 'reference.fixture.json'), 'utf8'));
const clone = () => structuredClone(FIXTURE);
/** The first plain (not list, not nullable) text field of section 1, for the refusal cases. */
const PLAIN = SECTIONS[1]!.text.find((field) => field.list === undefined && !field.atom)!;

function compile(recipeInput: unknown) {
  const recipe = validateNonprofitRecipe(recipeInput);
  assert.deepEqual(getNonprofitAssetRequirements(recipe), [], 'no image, font or video assets');
  const html = renderNonprofit(recipe, {});
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
/** A nullable atom whose null also drops a paired slot: a period never renders without its amount. */
const PAIRED: Record<string, string> = { amount: 'period' };
/** The slot ids a null in `atom` removes from the page. */
function droppedBy(atom: ReturnType<typeof atoms>[number]): string[] {
  const paired = PAIRED[atom.name];
  return paired ? [atom.id, atom.id.replace(new RegExp(`--${atom.name}$`), `--${paired}`)] : [atom.id];
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
  const ids = listNonprofitTextSlots(html);
  assert.deepEqual(ids, expectedSlotIds());
  assert.equal(new Set(ids).size, ids.length, 'data-od-id values are unique');
  assert.equal(findNonprofitTextSlot(html, 'brand--name'), FIXTURE.brand.name);
  assert.equal(findNonprofitTextSlot(html, `${SECTIONS[1]!.id}--${PLAIN.name}`), FIXTURE.sections[1].text[PLAIN.name]);
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
  const pageKinds = JSON.parse(readFileSync(path.join(KIT, 'pagekinds.json'), 'utf8')) as Record<string, string[]>;
  assert.deepEqual(pageKinds[FAMILY_ID], [...NONPROFIT_BLOCKS], 'pagekinds.json lists the blocks slots.ts names');
  const classesIn = (html: string) => new Set([...html.replaceAll('&amp;', '&').matchAll(/\sclass="([^"]*)"/g)].flatMap((match) => match[1]!.split(/\s+/).filter(Boolean)));
  const known = new Set(NONPROFIT_BLOCKS.flatMap((block) => [...classesIn(readFileSync(path.join(KIT, 'blocks', `${block}.html`), 'utf8'))]));
  const missing = [...classesIn(compile(clone()).html)].filter((token) => !known.has(token));
  assert.deepEqual(missing, [], 'classes css/<kind>.css would not carry');
});

test('each optional section drops to null and renders nothing, nor its nav link; a null elsewhere is refused', () => {
  const optional = SECTIONS.filter((section) => section.optional);
  assert.deepEqual([...NONPROFIT_OPTIONAL_SECTIONS], optional.map((section) => section.type));
  assert.deepEqual(optional.map((section) => section.type), ['impact', 'stories', 'events']);
  for (const section of optional) {
    const index = SECTIONS.indexOf(section);
    const dropped = clone();
    dropped.sections[index] = null;
    const { html } = compile(dropped);
    assert.ok(!html.includes(`id="${section.id}"`), `${section.id}: no section wrapper`);
    assert.ok(!html.includes(`data-od-id="${section.id}`), `${section.id}: no edit targets`);
    assert.ok(!html.includes(`href="#${section.id}"`), `${section.id}: no nav link to the dropped section`);
    assert.deepEqual(listNonprofitTextSlots(html), expectedSlotIds().filter((id) => !id.startsWith(`${section.id}--`)));
    assert.deepEqual(section.optional!.navSlots ?? [], [], `${section.id}: nav is fixed chrome now, never a model-writable slot to cut`);
  }
  const required = clone();
  required.sections[0] = null;
  assert.match(refusal(required), /sections\[0\]: expected a plain object/);
});

test('each nullable atom drops only its own element; a null in a plain slot is refused', () => {
  const list = atoms();
  assert.ok(list.length > 0, 'the family has nullable atoms');
  for (const atom of list) {
    const recipe = clone();
    setAtom(recipe, atom, null);
    const { html } = compile(recipe);
    const gone = droppedBy(atom);
    assert.deepEqual(listNonprofitTextSlots(html), expectedSlotIds().filter((id) => !gone.includes(id)), atom.id);
  }
  const all = clone();
  for (const atom of list) setAtom(all, atom, null);
  const ids = listNonprofitTextSlots(compile(all).html);
  assert.equal(ids.length, expectedSlotIds().length - list.length, 'every atom null at once');
  const periodOnly = clone();
  periodOnly.sections[SECTIONS.findIndex((section) => section.type === 'give')].items[0].period = null;
  assert.match(compile(periodOnly).html, /data-od-id="nonprofit-give--items-0--amount">25<\/strong><\/p>/, 'an amount without a period renders alone');
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

test('phone atom accepts US and international formats and refuses non-numbers', () => {
  for (const ok of ['(828) 555-0135', '+44 20 7946 0958', '828-555-0135']) assert.ok(isPhoneNumber(ok), ok);
  for (const bad of ['call us', '12345']) assert.ok(!isPhoneNumber(bad), bad);
  const phone = atoms().find((atom) => atom.name === 'phone');
  if (phone) {
    const recipe = clone();
    setAtom(recipe, phone, '(828) 555-0135');
    assert.doesNotThrow(() => compile(recipe));
  }
});

test('omits unsupported facts', () => {
  const recipe = clone();
  const list = atoms();
  const originals = list.map((atom) => {
    const section = FIXTURE.sections[atom.index];
    return String(atom.item === undefined ? section.text[atom.name] : section.items[atom.item][atom.name]);
  });
  // Paired slots (a period) and every value inside a dropped section are facts that must vanish too.
  const optional = SECTIONS.filter((section) => section.optional);
  const droppedIndexes = optional.map((section) => SECTIONS.indexOf(section));
  // The facts inside a dropped section (labels such as "Volunteers" are copy the page may reuse elsewhere).
  const FACT_FIELDS = ['value', 'quote', 'name', 'role', 'date', 'title', 'body'];
  const sectionValues = droppedIndexes.flatMap((index) => (FIXTURE.sections[index].items as Record<string, string>[])
    .flatMap((item) => FACT_FIELDS.filter((name) => name in item).map((name) => item[name]!)));
  const periods = FIXTURE.sections[SECTIONS.findIndex((section) => section.type === 'give')].items.map((item: Record<string, string>) => item.period);
  for (const atom of list) setAtom(recipe, atom, null);
  for (const index of droppedIndexes) recipe.sections[index] = null;

  const { recipe: parsed, html } = compile(recipe);
  assert.deepEqual(droppedIndexes.map((index) => parsed.sections[index]), droppedIndexes.map(() => null));
  // Every nullable atom this family declares was nulled here.
  assert.deepEqual(Object.keys(NONPROFIT_NULLABLE_ATOMS).sort(), [...new Set(list.map((atom) => SECTIONS[atom.index]!.id))].sort());
  const text = html.replace(/<style>[\s\S]*?<\/style>/, '');
  for (const value of [...originals, ...periods, ...sectionValues]) {
    // Short values ("25", "10") must not appear as a rendered element's whole text.
    const shown = value.length <= 4 ? new RegExp(`>${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}<`).test(text) : text.includes(value);
    assert.ok(!shown, `the page still shows "${value}"`);
  }
  // No empty or orphan wrappers: no amount line, no contact block, no accountability list, no nav link.
  assert.ok(!text.includes('<p class="mt-2 sm:mt-4">'), 'no amount line');
  assert.ok(!text.includes('--period"'), 'no period without its amount');
  assert.ok(!text.includes('<div class="mt-8 space-y-4 sm:mt-0">'), 'no empty footer contact block');
  assert.ok(!text.includes('divide-y divide-gray-200'), 'no empty accountability list');
  // Timeline dots (`size-3` spans) are decorative and empty by design.
  assert.ok(!/<(p|li|time|strong|span|dd|dt)\b(?![^>]*size-3)[^>]*>\s*<\/\1>/.test(text), 'no empty text element');
  assert.ok(!text.includes(`href="#${EVENTS_SECTION_ID}"`), 'no nav link to the dropped events');
  // The omitted section ids are exactly the family's optional sections.
  const omitted = SECTIONS.filter((section) => !text.includes(`id="${section.id}"`)).map((section) => section.type);
  assert.deepEqual(new Set(omitted), NONPROFIT_OPTIONAL_SECTIONS);
  // The give options keep their name, impact line and button.
  for (let i = 0; i < 2; i++) for (const field of ['name', 'impact', 'cta']) assert.ok(text.includes(`data-od-id="nonprofit-give--items-${i}--${field}"`), `give ${i} keeps ${field}`);
});

test('the reference fixture carries no dishonest link (G5)', () => {
  const { html } = compile(clone());
  assert.deepEqual(dishonestLinks(html), []);
  assert.ok(!html.includes('href="#"'), 'never a "#" placeholder link');
});

test('stories carry the shared gate markers: name is x-atom person-name, quote is x-verify quote (G5)', () => {
  const schema = recipeSchema() as { properties: { sections: { prefixItems: Array<{ properties: { id: { const: string }; items: { items: { properties: Record<string, Record<string, unknown>> } } } }> } } };
  const storiesSection = schema.properties.sections.prefixItems.find((section) => section.properties.id.const === 'nonprofit-stories')!;
  const storyFields = storiesSection.properties.items.items.properties;
  assert.equal(storyFields.name!['x-atom'], 'person-name');
  assert.equal(storyFields.quote!['x-verify'], 'quote');
});
