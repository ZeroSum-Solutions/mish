/**
 * docs-hub family render tests.
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
  findDocsHubTextSlot, getDocsHubAssetRequirements, listDocsHubTextSlots,
  renderDocsHub, validateDocsHubRecipe,
} from './render.ts';
import { DOCS_HUB_BLOCKS, DOCS_HUB_OPTIONAL_SECTIONS, FAMILY_ID, SECTIONS, SECTION_ORDER, type FieldSpec } from './slots.ts';

const HERE = import.meta.dirname;
const KIT = path.join(HERE, '../../../../../../shared/ui-kits/hyperui');
const FIXTURE = JSON.parse(readFileSync(path.join(HERE, 'reference.fixture.json'), 'utf8'));
const clone = () => structuredClone(FIXTURE);
/** The first plain (not list, not nullable) text field of section 1, for the refusal cases. */
const PLAIN = SECTIONS[1]!.text.find((field) => field.list === undefined && !field.atom)!;

function compile(recipeInput: unknown) {
  const recipe = validateDocsHubRecipe(recipeInput);
  assert.deepEqual(getDocsHubAssetRequirements(recipe), [], 'no image, font or video assets');
  const html = renderDocsHub(recipe, {});
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
  const ids = listDocsHubTextSlots(html);
  assert.deepEqual(ids, expectedSlotIds());
  assert.equal(new Set(ids).size, ids.length, 'data-od-id values are unique');
  assert.equal(findDocsHubTextSlot(html, 'brand--name'), FIXTURE.brand.name);
  assert.equal(findDocsHubTextSlot(html, `${SECTIONS[1]!.id}--${PLAIN.name}`), FIXTURE.sections[1].text[PLAIN.name]);
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
  assert.deepEqual(pageKinds[FAMILY_ID], [...DOCS_HUB_BLOCKS], 'pagekinds.json lists the blocks slots.ts names');
  const classesIn = (html: string) => new Set([...html.replaceAll('&amp;', '&').matchAll(/\sclass="([^"]*)"/g)].flatMap((match) => match[1]!.split(/\s+/).filter(Boolean)));
  const known = new Set(DOCS_HUB_BLOCKS.flatMap((block) => [...classesIn(readFileSync(path.join(KIT, 'blocks', `${block}.html`), 'utf8'))]));
  const missing = [...classesIn(compile(clone()).html)].filter((token) => !known.has(token));
  assert.deepEqual(missing, [], 'classes css/<kind>.css would not carry');
});

test('every optional section drops to null and renders nothing; a null elsewhere is refused', () => {
  const optionalIndexes = SECTIONS.map((section, index) => (section.optional ? index : -1)).filter((index) => index >= 0);
  assert.ok(optionalIndexes.length >= 2, 'docs-hub has more than one optional section');
  assert.deepEqual(new Set([...DOCS_HUB_OPTIONAL_SECTIONS]), new Set(optionalIndexes.map((index) => SECTIONS[index]!.type)));
  for (const index of optionalIndexes) {
    const optional = SECTIONS[index]!;
    const dropped = clone();
    dropped.sections[index] = null;
    const { html } = compile(dropped);
    assert.ok(!html.includes(`id="${optional.id}"`), `${optional.id}: no section wrapper`);
    assert.ok(!html.includes(`data-od-id="${optional.id}`), `${optional.id}: no edit targets`);
    assert.deepEqual(listDocsHubTextSlots(html), expectedSlotIds().filter((id) => !id.startsWith(`${optional.id}--`)), optional.id);
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
    assert.deepEqual(listDocsHubTextSlots(html), expectedSlotIds().filter((id) => id !== atom.id), atom.id);
  }
  const all = clone();
  for (const atom of list) setAtom(all, atom, null);
  const ids = listDocsHubTextSlots(compile(all).html);
  assert.equal(ids.length, expectedSlotIds().length - list.length, 'every atom null at once');
  const plain = clone();
  plain.sections[1].text[PLAIN.name] = null;
  assert.match(refusal(plain), new RegExp(`sections\\[1\\]\\.text\\.${PLAIN.name}: expected plain text`));
});

test('email atoms are format-checked', () => {
  for (const atom of atoms()) {
    const recipe = clone();
    if (atom.name === 'email' || atom.name.toLowerCase().endsWith('email')) {
      setAtom(recipe, atom, 'not an email');
      assert.match(refusal(recipe), /expected an email address/);
    }
  }
});

test('the EMAIL pattern accepts plausible addresses and refuses anything an attribute or scheme context would treat specially', () => {
  const emailAtom = atoms().find((atom) => atom.name === 'supportEmail' || atom.name === 'contactEmail')!;
  const accepted = ['docs@loomwork.example', 'first.last+tag@sub.example.org'];
  const refused = ['a"b@x.example', 'a<b@x.example', 'a b@x.example', 'a@b', 'javascript:alert(1)@x.example'];
  for (const value of accepted) {
    const recipe = clone();
    setAtom(recipe, emailAtom, value);
    assert.doesNotThrow(() => compile(recipe), `${value}: accepted`);
  }
  for (const value of refused) {
    const recipe = clone();
    setAtom(recipe, emailAtom, value);
    // Refused by the contract, so it never reaches render.ts (the renderer's own escaping is a
    // second layer, not the only one): a value with a quote, angle bracket, space or scheme-like
    // shape can never become a `mailto:` href or appear in an attribute at all. `<`/`>` are
    // caught earlier, by the general markup check every text slot gets; everything else here is
    // caught by EMAIL itself. Either refusal is "never reaches the renderer" — both are checked.
    assert.match(refusal(recipe), /expected an email address|markup is not allowed/, `${value}: refused`);
  }
});

/** The fragment for one top-level section (`<header>`, `<footer>` or `<section>`), by its id.
 * Docs-hub's sections never nest the same tag inside one another, so the next matching close tag
 * after the open tag is always this section's own. */
function sectionFragment(html: string, sectionId: string): string {
  const open = new RegExp(`<(header|footer|section) id="${sectionId}"`).exec(html);
  assert.ok(open, `${sectionId}: section wrapper found`);
  const tag = open[1]!;
  const close = `</${tag}>`;
  const end = html.indexOf(close, open.index);
  assert.ok(end !== -1, `${sectionId}: closing </${tag}> found`);
  return html.slice(open.index, end + close.length);
}

test('a non-null email atom renders as a mailto: link whose href is exactly the filled address; null renders no link at all', () => {
  // Literal, not read back from rendered HTML: the fixture's own two (deliberately distinct)
  // addresses, so this proves the render matches the known input, not just its own consistency.
  const SUPPORT = { atomId: 'docs-hub-community--supportEmail', sectionId: 'docs-hub-community', name: 'supportEmail', email: 'docs-support@loomwork.example' };
  const CONTACT = { atomId: 'docs-hub-footer--contactEmail', sectionId: 'docs-hub-footer', name: 'contactEmail', email: 'docs@loomwork.example' };
  const emailAtoms = atoms().filter((atom) => atom.name === 'supportEmail' || atom.name === 'contactEmail');
  assert.deepEqual(emailAtoms.map((atom) => atom.id).sort(), [SUPPORT.atomId, CONTACT.atomId].sort(), 'exactly these two email atoms exist');
  const supportAtom = emailAtoms.find((atom) => atom.id === SUPPORT.atomId)!;
  const contactAtom = emailAtoms.find((atom) => atom.id === CONTACT.atomId)!;
  const linkFor = (email: string, atomId: string) => new RegExp(`<a href="mailto:${email.replace(/[.]/g, '\\.')}" class="[^"]*" data-od-id="${atomId}">${email.replace(/[.]/g, '\\.')}</a>`);

  for (const target of [SUPPORT, CONTACT]) {
    assert.equal((FIXTURE.sections as { id: string; text: Record<string, unknown> }[]).find((s) => s.id === target.sectionId)!.text[target.name], target.email, `${target.atomId}: fixture carries the expected literal address`);
  }

  // Positive: the filled reference fixture renders both as real <a href="mailto:..."> links,
  // each href derived only from its own atom's value.
  const { html: full } = compile(clone());
  assert.match(full, linkFor(SUPPORT.email, SUPPORT.atomId), 'renders <a href="mailto:docs-support@loomwork.example">');
  assert.match(full, linkFor(CONTACT.email, CONTACT.atomId), 'renders <a href="mailto:docs@loomwork.example">');

  // Negative, proving actual scoping: null ONLY the community section's supportEmail while the
  // footer's contactEmail stays filled. The community section loses its element and its mailto:
  // entirely; the footer's own link is untouched — same value, same href, still present.
  const supportDropped = clone();
  setAtom(supportDropped, supportAtom, null);
  const { html: withoutSupport } = compile(supportDropped);
  assert.ok(!withoutSupport.includes(`data-od-id="${SUPPORT.atomId}"`), 'no supportEmail element when null');
  assert.ok(!sectionFragment(withoutSupport, SUPPORT.sectionId).includes('mailto:'), 'the community section carries no mailto: at all once supportEmail is null');
  assert.match(sectionFragment(withoutSupport, CONTACT.sectionId), linkFor(CONTACT.email, CONTACT.atomId), "the footer's contactEmail link is untouched");

  // And vice versa: null ONLY the footer's contactEmail while the community section's
  // supportEmail stays filled.
  const contactDropped = clone();
  setAtom(contactDropped, contactAtom, null);
  const { html: withoutContact } = compile(contactDropped);
  assert.ok(!withoutContact.includes(`data-od-id="${CONTACT.atomId}"`), 'no contactEmail element when null');
  assert.ok(!sectionFragment(withoutContact, CONTACT.sectionId).includes('mailto:'), 'the footer section carries no mailto: at all once contactEmail is null');
  assert.match(sectionFragment(withoutContact, SUPPORT.sectionId), linkFor(SUPPORT.email, SUPPORT.atomId), "the community section's supportEmail link is untouched");

  // Drop every email atom at once: then no mailto: text exists anywhere on the page.
  const allDropped = clone();
  for (const atom of emailAtoms) setAtom(allDropped, atom, null);
  assert.ok(!compile(allDropped).html.includes('mailto:'), 'no mailto: text anywhere once every email atom is null');
});

test('a slot filled to exactly its max length renders intact, not truncated', () => {
  const recipe = clone();
  recipe.sections[1].text[PLAIN.name] = 'x'.repeat(PLAIN.max);
  const { html } = compile(recipe);
  assert.equal(findDocsHubTextSlot(html, `${SECTIONS[1]!.id}--${PLAIN.name}`), 'x'.repeat(PLAIN.max));
});

test('no <script appears anywhere, and CSP forbids it', () => {
  const { html } = compile(clone());
  assert.ok(!html.includes('<script'), 'no script tag');
  assert.match(html, /script-src 'none'/);
  assert.match(html, /form-action 'none'/);
});

test('the code sample is one fixed static literal, never a reconcilable recipe slot', () => {
  const { html } = compile(clone());
  assert.match(html, /<pre[^>]*>npm install\nnpm run build<\/pre>/);
  const codeSampleIndex = SECTIONS.findIndex((section) => section.type === 'code-sample');
  const codeSampleId = SECTIONS[codeSampleIndex]!.id;
  assert.ok(!listDocsHubTextSlots(html).some((id) => id === `${codeSampleId}--code`), 'no "code" slot exists');
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
      // A list with a minimum (`items.min`, 2026-10-10) takes min..count items; below or above refuses.
      const min = section.items.min ?? section.items.count;
      const expected = min === section.items.count ? `expected exactly ${section.items.count} items` : `expected ${min} to ${section.items.count} items`;
      const short = clone();
      short.sections[index].items.length = min - 1;
      assert.match(refusal(short), new RegExp(`sections\\[${index}\\]\\.items: ${expected}`));
      const long = clone();
      long.sections[index].items.push(structuredClone(long.sections[index].items[0]));
      assert.match(refusal(long), new RegExp(`sections\\[${index}\\]\\.items: ${expected}`));
      if (min < section.items.count) {
        const fewer = clone();
        fewer.sections[index].items.length = min;
        assert.doesNotThrow(() => compile(fewer), `${section.id}: ${min} items render`);
      }
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
