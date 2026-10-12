/**
 * listings family render tests.
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
  findListingsTextSlot, getListingsAssetRequirements, listListingsTextSlots,
  renderListings, validateListingsRecipe,
} from './render.ts';
import {
  FAMILY_ID, LEGACY_SAMPLE_NOTE_FIELD, LISTINGS_BLOCKS, LISTINGS_MOCK_SLOTS, LISTINGS_NULLABLE_ATOMS, LISTINGS_OPTIONAL_SECTIONS,
  SAMPLE_DATA_CAPTION, SEARCH_SECTION_ID, SECTIONS, SECTION_ORDER, type FieldSpec,
} from './slots.ts';

const HERE = import.meta.dirname;
const KIT = path.join(HERE, '../../../../../../shared/ui-kits/hyperui');
const FIXTURE = JSON.parse(readFileSync(path.join(HERE, 'reference.fixture.json'), 'utf8'));
const clone = () => structuredClone(FIXTURE);
/** The first plain (not list, not nullable) text field of section 1, for the refusal cases. */
const PLAIN = SECTIONS[1]!.text.find((field) => field.list === undefined && !field.atom)!;

function compile(recipeInput: unknown) {
  const recipe = validateListingsRecipe(recipeInput);
  assert.deepEqual(getListingsAssetRequirements(recipe), [], 'no image, font or video assets');
  const html = renderListings(recipe, {});
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
  const ids = listListingsTextSlots(html);
  assert.deepEqual(ids, expectedSlotIds());
  assert.equal(new Set(ids).size, ids.length, 'data-od-id values are unique');
  assert.equal(findListingsTextSlot(html, 'brand--name'), FIXTURE.brand.name);
  assert.equal(findListingsTextSlot(html, `${SECTIONS[1]!.id}--${PLAIN.name}`), FIXTURE.sections[1].text[PLAIN.name]);
});

test('the search field is a read-only search input whose placeholder is the text slot', () => {
  const recipe = clone();
  const search = recipe.sections.find((section: { id: string }) => section.id === SEARCH_SECTION_ID);
  search.text.queryPlaceholder = 'Town & "postcode"';
  const { html } = compile(recipe);
  const id = `${SEARCH_SECTION_ID}--queryPlaceholder`;
  const input = new RegExp(`<input[^>]*data-od-id="${id}"[^>]*>`).exec(html)?.[0];
  assert.ok(input, 'the slot is an <input>');
  assert.match(input, /\stype="search"/);
  assert.match(input, /\sreadonly[\s>]/);
  assert.match(input, /\splaceholder="Town &amp; &quot;postcode&quot;"/, 'the placeholder is escaped');
  assert.equal(findListingsTextSlot(html, id), 'Town & "postcode"');
  assert.ok(!/<form\b/.test(html) && !/<script\b/.test(html), 'no form and no script');
  assert.ok(!new RegExp(`<p[^>]*data-od-id="${id}"`).test(html), 'no paragraph mock');
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
  assert.deepEqual(pageKinds[FAMILY_ID], [...LISTINGS_BLOCKS], 'pagekinds.json lists the blocks slots.ts names');
  const classesIn = (html: string) => new Set([...html.replaceAll('&amp;', '&').matchAll(/\sclass="([^"]*)"/g)].flatMap((match) => match[1]!.split(/\s+/).filter(Boolean)));
  const known = new Set(LISTINGS_BLOCKS.flatMap((block) => [...classesIn(readFileSync(path.join(KIT, 'blocks', `${block}.html`), 'utf8'))]));
  const missing = [...classesIn(compile(clone()).html)].filter((token) => !known.has(token));
  assert.deepEqual(missing, [], 'classes css/<kind>.css would not carry');
});

test('the optional section drops to null and renders nothing; a null elsewhere is refused', () => {
  const index = SECTIONS.findIndex((section) => section.optional);
  const optional = SECTIONS[index]!;
  assert.deepEqual([...LISTINGS_OPTIONAL_SECTIONS], [optional.type], 'exactly one optional section');
  const dropped = clone();
  dropped.sections[index] = null;
  const { html } = compile(dropped);
  assert.ok(!html.includes(`id="${optional.id}"`), 'no section wrapper');
  assert.ok(!html.includes(`data-od-id="${optional.id}`), 'no edit targets');
  assert.deepEqual(listListingsTextSlots(html), expectedSlotIds().filter((id) => !id.startsWith(`${optional.id}--`)));
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
    assert.deepEqual(listListingsTextSlots(html), expectedSlotIds().filter((id) => id !== atom.id), atom.id);
  }
  const all = clone();
  for (const atom of list) setAtom(all, atom, null);
  const ids = listListingsTextSlots(compile(all).html);
  assert.equal(ids.length, expectedSlotIds().length - list.length, 'every atom null at once');
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
  const nulled: string[] = [];
  const originals: string[] = [];
  for (const atom of atoms()) {
    const section = recipe.sections[atom.index];
    originals.push(atom.item === undefined ? section.text[atom.name] : section.items[atom.item][atom.name]);
    setAtom(recipe, atom, null);
    nulled.push(atom.id);
  }
  // Every nullable atom slots.ts lists is nulled here, and nothing else.
  assert.deepEqual(nulled.sort(), Object.entries(LISTINGS_NULLABLE_ATOMS).flatMap(([id, fields]) => Object.keys(fields).map((name) => `${id}--${name}`)).sort());
  const droppedIds: string[] = [];
  const droppedTypes: string[] = [];
  SECTIONS.forEach((section, index) => {
    if (!section.optional) return;
    const values = JSON.stringify(recipe.sections[index]).match(/"[^"]{12,}"/g) ?? [];
    originals.push(...values.map((value) => JSON.parse(value) as string).filter((value) => value !== section.id && value !== section.type));
    recipe.sections[index] = null;
    droppedIds.push(section.id);
    droppedTypes.push(section.type);
  });
  assert.deepEqual(droppedTypes.sort(), [...LISTINGS_OPTIONAL_SECTIONS].sort(), 'the dropped sections are exactly the optional set');
  const { recipe: parsed, html } = compile(recipe);
  assert.deepEqual(SECTIONS.filter((_, index) => parsed.sections[index] === null).map((section) => section.id), droppedIds, 'omitted section ids');
  for (const value of originals) assert.ok(!html.includes(value), `the original value "${value}" is gone`);
  for (const id of droppedIds) {
    assert.ok(!html.includes(`id="${id}"`), `${id}: no section wrapper`);
    assert.ok(!html.includes(`data-od-id="${id}--`), `${id}: no edit targets`);
  }
  for (const id of nulled) assert.ok(!html.includes(`data-od-id="${id}"`), `${id}: no element`);
  // No empty wrapper or label is left behind: the contact row and the address line are gone.
  assert.ok(!html.includes('mt-8 flex flex-wrap justify-center gap-4 text-sm'), 'no empty contact row');
  assert.ok(!/<p[^>]*>\s*<\/p>/.test(html), 'no empty paragraph');
  assert.ok(!/<div class="[^"]*">\s*<\/div>/.test(html), 'no empty div');
  assert.deepEqual(listListingsTextSlots(html), expectedSlotIds().filter((id) => !nulled.includes(id) && !droppedIds.some((dropped) => id.startsWith(`${dropped}--`))));
});

// ---------------------------------------------------------------------------
// x-mock: the schema marks exactly the sample item groups, and each renders under its caption
// ---------------------------------------------------------------------------

type SchemaNode = Record<string, unknown>;
/** Every recipe path under an `x-mock` mark (inherited downward), walking the schema with a recipe. */
function mockPaths(node: SchemaNode | undefined, value: unknown, inherited: boolean, at: string, out: string[] = []): string[] {
  const mock = inherited || node?.['x-mock'] === true;
  if (typeof value === 'string' || value === null) {
    if (mock) out.push(at);
  } else if (Array.isArray(value)) {
    const prefix = (node?.prefixItems ?? []) as SchemaNode[];
    value.forEach((item, index) => mockPaths(prefix[index] ?? (node?.items as SchemaNode | undefined), item, mock, `${at}[${index}]`, out));
  } else if (value && typeof value === 'object') {
    const properties = (node?.properties ?? {}) as Record<string, SchemaNode>;
    for (const [key, child] of Object.entries(value)) mockPaths(properties[key], child, mock, at ? `${at}.${key}` : key, out);
  }
  return out;
}

test('the schema x-mock paths are exactly the results, comparison and featured items', () => {
  const schema = JSON.parse(readFileSync(path.join(HERE, 'recipe.schema.json'), 'utf8')) as SchemaNode;
  const expected: string[] = [];
  const index = (id: string) => SECTIONS.findIndex((section) => section.id === id);
  for (const [i, j] of [0, 1, 2, 3].map((n) => [index('listings-results'), n])) for (const key of ['location', 'title', 'price', 'summary']) expected.push(`sections[${i}].items[${j}].${key}`);
  for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) expected.push(`sections[${index('listings-compare')}].items[${j}].cells[${k}]`);
  for (let j = 0; j < 3; j++) for (const key of ['label', 'value']) expected.push(`sections[${index('listings-featured')}].items[${j}].${key}`);
  assert.deepEqual(mockPaths(schema, FIXTURE, false, '').sort(), expected.sort());
  assert.deepEqual(LISTINGS_MOCK_SLOTS, {
    'listings-results': ['location', 'title', 'price', 'summary'],
    'listings-compare': ['cells'],
    'listings-featured': ['label', 'value'],
  });
});

test('each sample-data section shows the fixed caption before every sample card, row and value', () => {
  const { html } = compile(clone());
  const mockIds = Object.keys(LISTINGS_MOCK_SLOTS);
  assert.equal(html.match(/data-od-mock="caption"/g)?.length, mockIds.length, 'one caption per sample section');
  for (const id of mockIds) {
    const index = SECTIONS.findIndex((section) => section.id === id);
    const start = html.indexOf(`<section id="${id}" data-od-mock="sample-data">`);
    assert.ok(start > 0, `${id}: the section is marked sample-data`);
    const end = html.indexOf('</section>', start);
    const body = html.slice(start, end);
    const caption = /<p class="([^"]*)" data-od-mock="caption">([^<]+)<\/p>/.exec(body);
    assert.ok(caption, `${id}: the caption is a <p> with no edit target`);
    assert.equal(caption[2], SAMPLE_DATA_CAPTION, `${id}: the caption is the fixed template sentence`);
    // Visible: no sr-only class, no aria-hidden, no hidden attribute, on the caption or the section.
    assert.ok(!/\bsr-only\b|\bhidden\b|\binvisible\b/.test(caption[1]), `${id}: the caption class is visible`);
    assert.ok(!/<p [^>]*(aria-hidden|\shidden)[^>]*data-od-mock="caption"/.test(body), `${id}: the caption is not hidden`);
    // Covers every sample value: each mock slot sits inside this section, after the caption.
    const captionAt = body.indexOf(caption[0]);
    const mockSlots = listListingsTextSlots(body).filter((slot) => /--items-\d+--/.test(slot));
    assert.equal(mockSlots.length, SECTIONS[index]!.items!.count * SECTIONS[index]!.items!.fields.reduce((sum, field) => sum + (field.list ?? 1), 0), `${id}: every sample value`);
    for (const slot of mockSlots) assert.ok(body.indexOf(`data-od-id="${slot}"`) > captionAt, `${id}: ${slot} follows the caption`);
    // And the first sample card, row or fact container follows the caption too.
    const firstContainer = Math.min(...['<article', '<tr class="*:text-gray-900', '<dl'].map((tag) => body.indexOf(tag)).filter((at) => at >= 0));
    assert.ok(firstContainer > captionAt, `${id}: the caption precedes the first sample container`);
  }
  // A section without sample data carries no caption and no sample mark.
  for (const section of SECTIONS.filter((spec) => !spec.items?.mock)) {
    assert.ok(!html.includes(`<section id="${section.id}" data-od-mock`), `${section.id}: not sample data`);
  }
});

// ---------------------------------------------------------------------------
// B3: the fast lane skips every x-mock value only because the fixed caption stands before it
// ---------------------------------------------------------------------------

test('the caption is not model-writable: no schema field, no slot, and model text never changes it', () => {
  const schemaText = readFileSync(path.join(HERE, 'recipe.schema.json'), 'utf8');
  assert.ok(!schemaText.includes(`"${LEGACY_SAMPLE_NOTE_FIELD}"`), 'the schema offers no caption field');
  assert.ok(!schemaText.includes(SAMPLE_DATA_CAPTION), 'the caption text is not recipe data');
  assert.ok(SECTIONS.every((section) => section.text.every((field) => field.name !== LEGACY_SAMPLE_NOTE_FIELD)), 'no caption slot');
  // A model that writes "Explore homes" into the old caption key and into every sample section's
  // heading still gets the fixed caption, verbatim, on every sample-data section.
  const recipe = clone();
  for (const id of Object.keys(LISTINGS_MOCK_SLOTS)) {
    const section = recipe.sections[SECTIONS.findIndex((spec) => spec.id === id)];
    section.text[LEGACY_SAMPLE_NOTE_FIELD] = 'Explore homes';
    section.text.heading = 'Explore homes';
  }
  const { html } = compile(recipe);
  const captions = [...html.matchAll(/<p\b[^>]*\sdata-od-mock="caption"[^>]*>([^<]*)<\/p>/g)].map((match) => match[1]);
  assert.deepEqual(captions, Object.keys(LISTINGS_MOCK_SLOTS).map(() => SAMPLE_DATA_CAPTION));
  assert.ok(!html.includes(`--${LEGACY_SAMPLE_NOTE_FIELD}"`), 'no caption edit target');
  assertCaptionBacksEveryMockValue(recipe, mockPaths(JSON.parse(schemaText) as SchemaNode, recipe, false, ''), (input) => compile(input).html, SAMPLE_DATA_CAPTION);
});

test('a legacy recipe carrying sampleNote still compiles; the key is dropped, and only on sample-data sections', () => {
  const legacy = clone();
  for (const id of Object.keys(LISTINGS_MOCK_SLOTS)) legacy.sections[SECTIONS.findIndex((spec) => spec.id === id)].text[LEGACY_SAMPLE_NOTE_FIELD] = 'Sample listings, as written before';
  const { recipe, html } = compile(legacy);
  for (const section of recipe.sections) assert.ok(section === null || !(LEGACY_SAMPLE_NOTE_FIELD in section.text), `${section?.id}: the legacy key is dropped`);
  assert.ok(!html.includes('as written before'), 'the legacy caption text never renders');
  assert.equal(html, compile(clone()).html, 'the page is exactly the page without the key');
  const elsewhere = clone();
  elsewhere.sections[1].text[LEGACY_SAMPLE_NOTE_FIELD] = 'Not a sample section';
  assert.match(refusal(elsewhere), new RegExp(`sections\\[1\\]\\.text\\.${LEGACY_SAMPLE_NOTE_FIELD}: unknown field`));
});

/** A recipe path label (`sections[3].items[0].price`) as segments. */
const pathSegments = (label: string): (string | number)[] => (label.match(/[^.[\]]+/g) ?? []).map((part) => (/^\d+$/.test(part) ? Number(part) : part));
/** The first letter or digit of a value, changed; the length and the format (email, phone) hold. */
function perturb(value: string): string {
  const at = value.search(/[A-Za-z0-9]/);
  assert.ok(at >= 0, `"${value}" has a letter or digit to change`);
  const char = value[at]!;
  const next = /[0-9]/.test(char) ? String((Number(char) + 1) % 10) : /[a-z]/.test(char) ? (char === 'a' ? 'b' : 'a') : (char === 'A' ? 'B' : 'A');
  return value.slice(0, at) + next + value.slice(at + 1);
}
/** A copy of the recipe with the one string at `label` perturbed. */
function withPerturbed(recipe: unknown, label: string): unknown {
  const copy = structuredClone(recipe) as Record<string | number, unknown>;
  const segments = pathSegments(label);
  let parent = copy;
  for (const segment of segments.slice(0, -1)) parent = parent[segment] as Record<string | number, unknown>;
  const last = segments.at(-1)!;
  assert.equal(typeof parent[last], 'string', `${label} is a string in the recipe`);
  parent[last] = perturb(parent[last] as string);
  return copy;
}
/** Where `after` differs from `before` (same length): the first and the last changed index. */
function changedSpan(before: string, after: string): [number, number] {
  let first = 0;
  while (first < before.length && before[first] === after[first]) first += 1;
  let tail = 0;
  while (tail < before.length - first && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail += 1;
  return [first, after.length - 1 - tail];
}
/** The index of the tag closing the element that opens at `start`. */
function closingTagAt(html: string, tag: string, start: number): number {
  const pattern = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'g');
  pattern.lastIndex = start;
  let depth = 0;
  for (let match = pattern.exec(html); match; match = pattern.exec(html)) {
    depth += match[1] ? -1 : 1;
    if (depth === 0) return match.index;
  }
  return html.length;
}
/** The innermost element carrying a sample-data region mark (any `data-od-mock` but the caption) around `at`. */
function sampleRegionAt(html: string, at: number): { start: number; end: number } | undefined {
  let found: { start: number; end: number } | undefined;
  for (const match of html.matchAll(/<([a-z][a-z0-9]*)\b[^>]*\sdata-od-mock="(?!caption")[^"]*"[^>]*>/g)) {
    const start = match.index!;
    const end = closingTagAt(html, match[1]!, start);
    if (start < at && at < end && (!found || start > found.start)) found = { start, end };
  }
  return found;
}
const CAPTION_ELEMENT = /<p\b[^>]*\sdata-od-mock="caption"[^>]*>([^<]*)<\/p>/g;
const escapeText = (value: string) => value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
/**
 * The proof behind the fast lane's x-mock exclusion. Every caption on the page is the fixed
 * template sentence with no edit target; and for each x-mock path, changing that one value
 * changes the page only inside one sample-data region, after that region's fixed caption, and
 * inside an element that follows the caption (the value's `data-od-id` element).
 */
function assertCaptionBacksEveryMockValue(recipe: unknown, paths: string[], render: (recipe: unknown) => string, caption: string): void {
  const html = render(recipe);
  const captions = [...html.matchAll(CAPTION_ELEMENT)];
  assert.ok(captions.length > 0, 'the page shows a caption');
  for (const match of captions) {
    assert.equal(match[1], escapeText(caption), 'every caption is the fixed template sentence');
    assert.ok(!match[0].includes('data-od-id'), 'a caption is never an edit target');
  }
  for (const label of paths) {
    const changed = render(withPerturbed(recipe, label));
    assert.notEqual(changed, html, `${label}: the value renders`);
    const [first, last] = changedSpan(html, changed);
    const region = sampleRegionAt(changed, first);
    assert.ok(region, `${label}: the value sits inside a data-od-mock sample-data region`);
    assert.ok(last < region.end, `${label}: every rendering of the value stays inside that one region`);
    const before = changed.slice(region.start, first);
    const captionMatches = [...before.matchAll(CAPTION_ELEMENT)];
    assert.ok(captionMatches.some((match) => match[1] === escapeText(caption)), `${label}: the region's fixed caption precedes the value`);
    const captionEnd = region.start + before.lastIndexOf(captionMatches.at(-1)![0]) + captionMatches.at(-1)![0].length;
    const idAt = changed.lastIndexOf('data-od-id="', first);
    const owner = changed.lastIndexOf('<', idAt);
    assert.ok(owner >= captionEnd, `${label}: its data-od-id element (${/data-od-id="([^"]+)"/.exec(changed.slice(idAt))?.[1]}) follows the caption`);
  }
}

test('every x-mock value renders inside a sample-data section, after that section\'s fixed caption', () => {
  const schema = JSON.parse(readFileSync(path.join(HERE, 'recipe.schema.json'), 'utf8')) as SchemaNode;
  const paths = mockPaths(schema, FIXTURE, false, '');
  assert.equal(paths.length, 16 + 9 + 6, 'results, comparison and featured: every x-mock path');
  assertCaptionBacksEveryMockValue(FIXTURE, paths, (recipe) => compile(recipe).html, SAMPLE_DATA_CAPTION);
});

test('the reference fixture carries no dishonest link (G5)', () => {
  const { html } = compile(clone());
  assert.deepEqual(dishonestLinks(html), []);
  assert.ok(!html.includes('href="#"'), 'never a "#" placeholder link');
});

test('sort chips carry no hover or pill chrome — they are inert labels, not working sort controls (G5 round 2 + round 3)', () => {
  const { html } = compile(clone());
  const matches = [...html.matchAll(/<span[^>]*data-od-id="listings-results--sorts-\d+"[^>]*>/g)];
  assert.ok(matches.length > 0, 'sanity: sort chips still render');
  for (const match of matches) {
    assert.doesNotMatch(match[0], /hover:/, `${match[0]} has no hover class`);
    // G5 round 3: a round-2 fix already dropped the hover class but kept rounded-full/bg-gray/
    // px-4/py-2, so the chip still looked clickable by shape alone.
    assert.doesNotMatch(match[0], /rounded-full|(?:^|\s)(?:bg-|px-\d|py-\d)/, `${match[0]} has no pill/chip shape class`);
  }
});

test('reviews carry the shared gate markers: name is x-atom person-name, quote is x-verify quote (G5)', () => {
  const schema = recipeSchema() as { properties: { sections: { prefixItems: Array<{ properties: { id: { const: string }; items: { items: { properties: Record<string, Record<string, unknown>> } } } }> } } };
  const reviewsSection = schema.properties.sections.prefixItems.find((section) => section.properties.id.const === 'listings-reviews')!;
  const reviewFields = reviewsSection.properties.items.items.properties;
  assert.equal(reviewFields.name!['x-atom'], 'person-name');
  assert.equal(reviewFields.quote!['x-verify'], 'quote');
});
