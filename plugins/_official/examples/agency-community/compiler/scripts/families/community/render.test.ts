/**
 * community family render tests.
 * Run: node --experimental-strip-types --test render.test.ts
 *
 * Drives the family module directly (validate, render, slot lookup), the surface the compiler's
 * `families/registry.ts` dispatches through. The expected slot roster, the schema and the
 * nullable atoms are all rebuilt from `SECTIONS` (slots.ts), so a drift between slots.ts,
 * contract.ts, recipe.schema.json and render.ts fails here.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { dishonestLinks } from '../../sections.ts';
import { isPhoneNumber, recipeSchema } from './contract.ts';
import {
  COMMUNITY_STYLES, COMMUNITY_BROWSER_SOURCE, findCommunityTextSlot, getCommunityAssetRequirements, listCommunityTextSlots,
  renderCommunity, validateCommunityRecipe,
} from './render.ts';
import { COMMUNITY_BLOCKS, COMMUNITY_OPTIONAL_SECTIONS, FAMILY_ID, SECTIONS, SECTION_ORDER, type FieldSpec } from './slots.ts';

const HERE = import.meta.dirname;
const KIT = path.join(HERE, '../../../../../../shared/ui-kits/hyperui');
const FIXTURE = JSON.parse(readFileSync(path.join(HERE, 'reference.fixture.json'), 'utf8'));
const clone = () => structuredClone(FIXTURE);
/** The first plain (not list, not nullable) text field of section 1 (the hero), for the refusal cases. */
const PLAIN = SECTIONS[1]!.text.find((field) => field.list === undefined && !field.atom)!;

function compile(recipeInput: unknown) {
  const recipe = validateCommunityRecipe(recipeInput);
  assert.deepEqual(getCommunityAssetRequirements(recipe), [], 'no image, font or video assets');
  const html = renderCommunity(recipe, {});
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
  const ids = listCommunityTextSlots(html);
  assert.deepEqual(ids, expectedSlotIds());
  assert.equal(new Set(ids).size, ids.length, 'data-od-id values are unique');
  assert.equal(findCommunityTextSlot(html, 'brand--name'), FIXTURE.brand.name);
  assert.equal(findCommunityTextSlot(html, `${SECTIONS[1]!.id}--${PLAIN.name}`), FIXTURE.sections[1].text[PLAIN.name]);
});

test('recipe.schema.json is exactly the schema contract.ts derives from slots.ts', () => {
  const committed = JSON.parse(readFileSync(path.join(HERE, 'recipe.schema.json'), 'utf8'));
  assert.deepEqual(committed, recipeSchema());
});

test('the package default spine is the reference fixture', () => {
  const recipe = JSON.parse(readFileSync(path.join(HERE, `../../../../families/${FAMILY_ID}/recipe.json`), 'utf8'));
  assert.deepEqual(recipe, FIXTURE);
});

test('every rendered class is covered by the authored portable stylesheet, and vendor provenance stays intact', () => {
  const pageKinds = JSON.parse(readFileSync(path.join(KIT, 'pagekinds.json'), 'utf8'));
  assert.deepEqual(pageKinds[FAMILY_ID], [...COMMUNITY_BLOCKS]);
  const classes = new Set([...compile(clone()).html.matchAll(/\sclass="([^"]*)"/g)].flatMap((m) => m[1]!.split(/\s+/).filter(Boolean)));
  for (const token of classes) assert.ok(COMMUNITY_STYLES.includes(`.${token}`), `${token}: portable rule missing`);
  assert.match(COMMUNITY_STYLES, /community-benefits-grid\{display:grid;grid-template-columns:repeat\(2/);
  assert.match(COMMUNITY_STYLES, /prefers-reduced-motion:reduce/);
});

test('the optional voices section drops to null and renders nothing; a null elsewhere is refused', () => {
  const index = SECTIONS.findIndex((section) => section.optional);
  const optional = SECTIONS[index]!;
  assert.deepEqual([...COMMUNITY_OPTIONAL_SECTIONS], [optional.type], 'exactly one optional section');
  const dropped = clone();
  dropped.sections[index] = null;
  const { html } = compile(dropped);
  assert.ok(!html.includes(`id="${optional.id}"`), 'no section wrapper');
  assert.ok(!html.includes(`data-od-id="${optional.id}`), 'no edit targets');
  assert.deepEqual(listCommunityTextSlots(html), expectedSlotIds().filter((id) => !id.startsWith(`${optional.id}--`)));
  const required = clone();
  required.sections[index === 0 ? 1 : 0] = null;
  assert.match(refusal(required), /sections\[\d+\]: expected a plain object/);
});

test('the voices x-optional node requires a quote, so the fast lane drops it without asking Jev on a quote-less brief', () => {
  const schema = recipeSchema() as { properties: { sections: { prefixItems: Record<string, unknown>[] } } };
  const index = SECTIONS.findIndex((section) => section.optional);
  const node = schema.properties.sections.prefixItems[index] as { 'x-optional': { requires?: string } };
  assert.equal(node['x-optional'].requires, 'quote');
});

test('each nullable atom drops only its own element; a null in a plain slot is refused', () => {
  const list = atoms();
  assert.ok(list.length > 0, 'the family has nullable atoms');
  for (const atom of list) {
    const recipe = clone();
    setAtom(recipe, atom, null);
    const { html } = compile(recipe);
    assert.deepEqual(listCommunityTextSlots(html), expectedSlotIds().filter((id) => id !== atom.id), atom.id);
  }
  const all = clone();
  for (const atom of list) setAtom(all, atom, null);
  const ids = listCommunityTextSlots(compile(all).html);
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

test('isPhoneNumber: at most one separator token between digit runs, and common punctuated formats', () => {
  // Every accepted value alternates a digit run and at most one separator token — never two
  // separator characters back to back, whatever mix they are.
  for (const ok of ['206-555-0148', '+1 (206) 555-0148', '(828) 555-0135', '020 7946 0958', '+44 20 7946 0958', '555.010.9999']) {
    assert.ok(isPhoneNumber(ok), ok);
  }
  // Every refused value carries 7 or more real digits, so a digit-count floor alone would let each
  // one through — it is the alternation/paren grammar doing the refusing:
  //  - "1- 2- 3- 4567", "1. 2. 3. 4567", "1 -2 -3 -4567": a single-character separator token
  //    directly follows another single-character separator token (space then "-", or "-" then
  //    space) — refused by the "two tokens in a row" rule, not merged into one multi-char run.
  //  - "1- -2 34567": isolates that same rule from the paren-count rule below.
  //  - "123--4567", "123  4567": a doubled identical separator character.
  //  - "1 (2 (3 (4 (5 (6 (7": six "("s — every individual " (" is itself an allowed token, so only
  //    the whole-string "at most one (" rule refuses this, not the alternation check.
  //  - "1+2065550148": a "+" anywhere but the very first character matches no separator token.
  for (const bad of [
    '1- 2- 3- 4567', '1. 2. 3. 4567', '1 -2 -3 -4567', '1- -2 34567',
    '123--4567', '123  4567', '1 (2 (3 (4 (5 (6 (7', '1+2065550148',
  ]) {
    assert.ok(!isPhoneNumber(bad), bad);
  }
});

test('the phone atom accepts a real number and refuses punctuation used as filler', () => {
  const phoneAtom = atoms().find((atom) => atom.name === 'phone');
  assert.ok(phoneAtom, 'the family has a phone atom');
  for (const value of ['206-555-0148', '+1 (206) 555-0148', '(828) 555-0135', '020 7946 0958', '+44 20 7946 0958', '555.010.9999', '0117 555 0148']) {
    const recipe = clone();
    setAtom(recipe, phoneAtom, value);
    const { html } = compile(recipe);
    assert.equal(findCommunityTextSlot(html, phoneAtom.id), value, value);
  }
  for (const value of [
    '1- 2- 3- 4567', '1. 2. 3. 4567', '1 -2 -3 -4567', '1- -2 34567',
    '123--4567', '123  4567', '1 (2 (3 (4 (5 (6 (7', '1+2065550148', '123456',
  ]) {
    const recipe = clone();
    setAtom(recipe, phoneAtom, value);
    assert.match(refusal(recipe), /expected a phone number/, value);
  }
});

test('a filled phone/email atom renders as a real tel:/mailto: link; the href carries no other text', () => {
  const { html } = compile(clone());
  const phoneAtom = atoms().find((atom) => atom.name === 'phone')!;
  const emailAtom = atoms().find((atom) => atom.name === 'email')!;
  const phoneValue = FIXTURE.sections[8].text.phone as string;
  const emailValue = FIXTURE.sections[8].text.email as string;
  assert.equal(phoneValue, '0117 555 0148', 'the fixture phone the literal href below is pinned to');
  assert.equal(emailValue, 'join@kilnrow.example', 'the fixture email the literal href below is pinned to');
  assert.ok(html.includes(`<a href="tel:01175550148" `), 'the fixture tel: href is exactly its digits, no leading +');
  assert.ok(html.includes(`data-od-id="${phoneAtom.id}">0117 555 0148</a>`));
  assert.ok(html.includes(`<a href="mailto:join@kilnrow.example" `));
  assert.ok(html.includes(`data-od-id="${emailAtom.id}">join@kilnrow.example</a>`));
});

test('the tel: href keeps only digits and a leading "+", never interior punctuation or a stray plus', () => {
  const phoneAtom = atoms().find((atom) => atom.name === 'phone')!;
  const cases: [string, string][] = [
    ['206-555-0148', 'tel:2065550148'],
    ['+1 (206) 555-0148', 'tel:+12065550148'],
    ['(828) 555-0135', 'tel:8285550135'],
    ['555.010.9999', 'tel:5550109999'],
  ];
  for (const [value, expectedHref] of cases) {
    const recipe = clone();
    setAtom(recipe, phoneAtom, value);
    const { html } = compile(recipe);
    assert.ok(html.includes(`<a href="${expectedHref}" `), `${value} -> href="${expectedHref}"`);
    assert.equal(findCommunityTextSlot(html, phoneAtom.id), value, `${value}: the visible text is unchanged`);
  }
});

test('CSP permits only the exact progressive enhancement bytes and forbids network and form submission', () => {
  const { html } = compile(clone());
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1);
  assert.equal(scripts[0]![1], COMMUNITY_BROWSER_SOURCE);
  const hash = createHash('sha256').update(scripts[0]![1]!).digest('base64');
  assert.ok(html.includes(`script-src 'sha256-${hash}';`));
  assert.match(html, /connect-src 'none'/);
  assert.match(html, /form-action 'none'/);
  assert.doesNotMatch(html, /onsubmit=|onclick=|script-src 'unsafe-inline'/);
});

test('membership actions select a tier, email is preferred, and no-contact output has no pretend application', () => {
  const { html } = compile(clone());
  assert.match(html, /data-community-tier="Studio Day"/);
  assert.match(html, /href="mailto:join@kilnrow.example"[^>]*data-community-start/);
  assert.match(html, /Nothing has been sent/);
  assert.match(html, /data-community-application data-email="join@kilnrow.example"/);
  const missing = clone(); missing.sections[8].text.phone = null; missing.sections[8].text.email = null;
  const out = compile(missing).html;
  assert.doesNotMatch(out, /<form/);
  assert.doesNotMatch(out, /<a[^>]*data-community-start/);
  assert.match(out, /Contact details have not been supplied/);
  const phoneOnly = clone(); phoneOnly.sections[8].text.email = null;
  assert.match(compile(phoneOnly).html, /href="tel:01175550148"[^>]*data-community-start/);
  assert.doesNotMatch(compile(phoneOnly).html, /<form/);
});

test('every mailto recipient encodes reserved characters while retaining the exact supplied email text', () => {
  const email = "makers#studio?enquiry%&team+join@example.com";
  const recipe = clone(); recipe.sections[8].text.email = email;
  const { html } = compile(recipe);
  const hrefs = [...html.matchAll(/href="(mailto:[^"]*)"/g)].map(match => match[1]!);
  assert(hrefs.length >= 3);
  for (const href of hrefs) assert.equal(href, 'mailto:makers%23studio%3Fenquiry%25%26team%2Bjoin@example.com');
  assert(html.includes('makers#studio?enquiry%&amp;team+join@example.com</a>'));
  assert(html.includes('data-mailto="mailto:makers%23studio%3Fenquiry%25%26team%2Bjoin@example.com"'));
  assert.match(COMMUNITY_BROWSER_SOURCE, /href\.length > 2048/);
  assert.match(html, /data-community-copy-text readonly/);
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

test('a value at exactly the max length is accepted and renders intact, not truncated', () => {
  const atMax = clone();
  const value = 'x'.repeat(PLAIN.max);
  atMax.sections[1].text[PLAIN.name] = value;
  const { html } = compile(atMax);
  assert.equal(findCommunityTextSlot(html, `${SECTIONS[1]!.id}--${PLAIN.name}`), value);
});

test('every data-od-id the page emits is a declared slot: no untracked edit target', () => {
  const { html } = compile(clone());
  const declared = new Set(expectedSlotIds());
  const emitted = listCommunityTextSlots(html);
  const stray = emitted.filter((id) => !declared.has(id));
  assert.deepEqual(stray, [], 'every emitted data-od-id is one slots.ts declares');
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

test('the reference fixture carries no dishonest link (G5)', () => {
  const { html } = compile(clone());
  assert.deepEqual(dishonestLinks(html), []);
  assert.ok(!html.includes('href="#"'), 'never a "#" placeholder link');
});

test('footer label spans carry no hover chrome — nothing may look clickable without being clickable (G5 round 2)', () => {
  const { html } = compile(clone());
  for (const match of html.matchAll(/<span[^>]*data-od-id="community-footer--link\d+"[^>]*>/g)) {
    assert.doesNotMatch(match[0], /hover:/, `${match[0]} has no hover class`);
  }
});

test('voices carry the shared gate markers: name is x-atom person-name, quote is x-verify quote (G5)', () => {
  const schema = recipeSchema() as { properties: { sections: { prefixItems: Array<{ properties: { id: { const: string }; items: { items: { properties: Record<string, Record<string, unknown>> } } } }> } } };
  const voicesSection = schema.properties.sections.prefixItems.find((section) => section.properties.id.const === 'community-voices')!;
  const voiceFields = voicesSection.properties.items.items.properties;
  assert.equal(voiceFields.name!['x-atom'], 'person-name');
  assert.equal(voiceFields.quote!['x-verify'], 'quote');
});
