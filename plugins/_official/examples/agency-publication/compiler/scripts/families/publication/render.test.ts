/**
 * publication family render tests.
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
  findPublicationTextSlot, getPublicationAssetRequirements, listPublicationTextSlots,
  renderPublication, validatePublicationRecipe,
} from './render.ts';
import {
  FAMILY_ID, PUBLICATION_BLOCKS, PUBLICATION_NULLABLE_ATOMS, PUBLICATION_OPTIONAL_SECTIONS, SECTIONS, SECTION_ORDER, type FieldSpec,
} from './slots.ts';

const HERE = import.meta.dirname;
const KIT = path.join(HERE, '../../../../../../shared/ui-kits/hyperui');
const FIXTURE = JSON.parse(readFileSync(path.join(HERE, 'reference.fixture.json'), 'utf8'));
const clone = () => structuredClone(FIXTURE);
/** The first plain (not list, not nullable) text field of section 1, for the refusal cases. */
const PLAIN = SECTIONS[1]!.text.find((field) => field.list === undefined && !field.atom)!;

function compile(recipeInput: unknown) {
  const recipe = validatePublicationRecipe(recipeInput);
  assert.deepEqual(getPublicationAssetRequirements(recipe), [], 'no image, font or video assets');
  const html = renderPublication(recipe, {});
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
/** A nullable atom whose null also drops a paired slot: a period never renders without its price. */
const PAIRED: Record<string, string> = { price: 'period' };
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
  const ids = listPublicationTextSlots(html);
  assert.deepEqual(ids, expectedSlotIds());
  assert.equal(new Set(ids).size, ids.length, 'data-od-id values are unique');
  assert.equal(findPublicationTextSlot(html, 'brand--name'), FIXTURE.brand.name);
  assert.equal(findPublicationTextSlot(html, `${SECTIONS[1]!.id}--${PLAIN.name}`), FIXTURE.sections[1].text[PLAIN.name]);
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
  assert.deepEqual(pageKinds[FAMILY_ID], [...PUBLICATION_BLOCKS], 'pagekinds.json lists the blocks slots.ts names');
  const classesIn = (html: string) => new Set([...html.replaceAll('&amp;', '&').matchAll(/\sclass="([^"]*)"/g)].flatMap((match) => match[1]!.split(/\s+/).filter(Boolean)));
  const known = new Set(PUBLICATION_BLOCKS.flatMap((block) => [...classesIn(readFileSync(path.join(KIT, 'blocks', `${block}.html`), 'utf8'))]));
  const missing = [...classesIn(compile(clone()).html)].filter((token) => !known.has(token));
  assert.deepEqual(missing, [], 'classes css/<kind>.css would not carry');
});

test('the optional section drops to null and renders nothing; a null elsewhere is refused', () => {
  const index = SECTIONS.findIndex((section) => section.optional);
  const optional = SECTIONS[index]!;
  assert.deepEqual([...PUBLICATION_OPTIONAL_SECTIONS], [optional.type], 'exactly one optional section');
  const dropped = clone();
  dropped.sections[index] = null;
  const { html } = compile(dropped);
  assert.ok(!html.includes(`id="${optional.id}"`), 'no section wrapper');
  assert.ok(!html.includes(`data-od-id="${optional.id}`), 'no edit targets');
  assert.deepEqual(listPublicationTextSlots(html), expectedSlotIds().filter((id) => !id.startsWith(`${optional.id}--`)));
  const required = clone();
  required.sections[index === 0 ? 1 : 0] = null;
  assert.match(refusal(required), /sections\[\d+\]: expected a plain object/);
});

test('each nullable atom drops only its own element; a null in a plain slot is refused', () => {
  const list = atoms();
  assert.ok(list.length > 0, 'the family has nullable atoms');
  for (const atom of list) {
    const recipe = clone();
    setAtom(recipe, atom, null);
    const { html } = compile(recipe);
    const gone = droppedBy(atom);
    assert.deepEqual(listPublicationTextSlots(html), expectedSlotIds().filter((id) => !gone.includes(id)), atom.id);
  }
  const all = clone();
  for (const atom of list) setAtom(all, atom, null);
  const ids = listPublicationTextSlots(compile(all).html);
  assert.equal(ids.length, expectedSlotIds().length - list.length, 'every atom null at once');
  const periodOnly = clone();
  periodOnly.sections[SECTIONS.findIndex((section) => section.type === 'membership')].items[1].period = null;
  assert.match(compile(periodOnly).html, /data-od-id="publication-membership--items-1--price">5<\/strong><\/p>/, 'a price without a period renders alone');
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
  // Paired slots (a period) and the facts inside a dropped section must vanish too.
  const optional = SECTIONS.filter((section) => section.optional);
  const droppedIndexes = optional.map((section) => SECTIONS.indexOf(section));
  const FACT_FIELDS = ['bio', 'name', 'beat'];
  const sectionValues = droppedIndexes.flatMap((index) => (FIXTURE.sections[index].items as Record<string, string>[])
    .flatMap((item) => FACT_FIELDS.filter((name) => name in item).map((name) => item[name]!)));
  const periods = FIXTURE.sections[SECTIONS.findIndex((section) => section.type === 'membership')].items.map((item: Record<string, string>) => item.period);
  for (const atom of list) setAtom(recipe, atom, null);
  for (const index of droppedIndexes) recipe.sections[index] = null;

  const { recipe: parsed, html } = compile(recipe);
  assert.deepEqual(droppedIndexes.map((index) => parsed.sections[index]), droppedIndexes.map(() => null));
  // Every nullable atom this family declares was nulled here.
  assert.deepEqual(Object.keys(PUBLICATION_NULLABLE_ATOMS).sort(), [...new Set(list.map((atom) => SECTIONS[atom.index]!.id))].sort());
  const text = html.replace(/<style>[\s\S]*?<\/style>/, '');
  for (const value of [...originals, ...periods, ...sectionValues]) {
    // Short values ("5", "Free") and periods ("a month" is also inside a feature) must not appear
    // as a rendered element's whole text.
    const shown = value.length <= 4 || periods.includes(value) ? new RegExp(`>${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}<`).test(text) : text.includes(value);
    assert.ok(!shown, `the page still shows "${value}"`);
  }
  // No empty or orphan wrappers: no price line, no period alone, no byline, no dates, no contact line.
  assert.ok(!text.includes('<p class="mt-2 sm:mt-4">'), 'no price line');
  assert.ok(!text.includes('--period"'), 'no period without its price');
  assert.ok(!text.includes('<time'), 'no archive date element');
  assert.ok(!text.includes('mt-4 text-xs text-gray-500'), 'no byline or story date line');
  // Timeline dots (`size-3` spans) are decorative and empty by design.
  assert.ok(!/<(p|li|time|strong|span)\b(?![^>]*size-3)[^>]*>\s*<\/\1>/.test(text), 'no empty text element');
  // The omitted section ids are exactly the family's optional sections.
  const omitted = SECTIONS.filter((section) => !text.includes(`id="${section.id}"`)).map((section) => section.type);
  assert.deepEqual(new Set(omitted), PUBLICATION_OPTIONAL_SECTIONS);
  // The membership tiers keep their name, features and button.
  for (let i = 0; i < 2; i++) for (const field of ['name', 'features-0', 'cta']) assert.ok(text.includes(`data-od-id="publication-membership--items-${i}--${field}"`), `tier ${i} keeps ${field}`);
});

test('the reference fixture carries no dishonest link (G5)', () => {
  const { html } = compile(clone());
  assert.deepEqual(dishonestLinks(html), []);
  assert.ok(!html.includes('href="#"'), 'never a "#" placeholder link');
});

test('topic chips and the lead read cta are plain text, never a pill, link or hover, since neither has a real destination (G5 round 2 + round 3)', () => {
  const { html } = compile(clone());
  // G5 round 3: the earlier version of this test anchored its hover check at
  // `data-od-id="..."[^"]*"[^>]*hover:`, which only looks for `hover:` AFTER the data-od-id
  // attribute — but `slot()` always writes `class="..."` BEFORE `data-od-id="..."`, so a hover
  // class sitting in that (earlier) `class` attribute could never make this regex match, and the
  // assertion passed regardless of whether the element actually had one. Capturing the WHOLE
  // opening tag first (matching however `slot()` orders its attributes) and checking that whole
  // string is what actually proves the element carries no hover/pill class.
  const topicTags = [...html.matchAll(/<(\w+)\b[^>]*\sdata-od-id="publication-topics--topics-\d+"[^>]*>/g)];
  assert.ok(topicTags.length > 0, 'sanity: topic ids still render');
  for (const match of topicTags) {
    assert.equal(match[1], 'span', 'a topic chip is a <span>, never an <a>');
    assert.doesNotMatch(match[0], /hover:/, `no hover class on this topic chip: ${match[0]}`);
    assert.doesNotMatch(match[0], /rounded-full|(?:^|\s)(?:bg-|px-\d|py-\d)/, `no pill/chip shape class on this topic chip: ${match[0]}`);
  }
  const readCta = /<(\w+)\b[^>]*\sdata-od-id="publication-lead--readCta"[^>]*>/.exec(html)!;
  assert.equal(readCta[1], 'span', '"Read the story" is a <span>, never an <a>');
  assert.doesNotMatch(readCta[0], /hover:/, 'no hover class on the read cta');
});

test('authors carry the shared gate marker: name is x-atom person-name (G5)', () => {
  const schema = recipeSchema() as { properties: { sections: { prefixItems: Array<{ properties: { id: { const: string }; items: { items: { properties: Record<string, Record<string, unknown>> } } } }> } } };
  const authorsSection = schema.properties.sections.prefixItems.find((section) => section.properties.id.const === 'publication-authors')!;
  const authorFields = authorsSection.properties.items.items.properties;
  assert.equal(authorFields.name!['x-atom'], 'person-name');
});

test('the lead byline carries the shared gate marker: x-atom person-name (G5)', () => {
  const schema = recipeSchema() as { properties: { sections: { prefixItems: Array<{ properties: { id: { const: string }; text: { properties: Record<string, Record<string, unknown>> } } }> } } };
  const leadSection = schema.properties.sections.prefixItems.find((section) => section.properties.id.const === 'publication-lead')!;
  assert.equal(leadSection.properties.text.properties.byline!['x-atom'], 'person-name');
});
