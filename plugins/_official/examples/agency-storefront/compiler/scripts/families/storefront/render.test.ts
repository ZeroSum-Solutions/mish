/**
 * storefront family render tests.
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
import { recipeSchema } from './contract.ts';
import {
  findStorefrontTextSlot, getStorefrontAssetRequirements, listStorefrontTextSlots,
  renderStorefront, validateStorefrontRecipe,
} from './render.ts';
import { BRAND_SLOTS, FAMILY_ID, SECTIONS, STOREFRONT_BLOCKS, STOREFRONT_OPTIONAL_SECTIONS, SECTION_ORDER, type FieldSpec } from './slots.ts';

const HERE = import.meta.dirname;
const KIT = path.join(HERE, '../../../../../../shared/ui-kits/hyperui');
const FIXTURE = JSON.parse(readFileSync(path.join(HERE, 'reference.fixture.json'), 'utf8'));
const clone = () => structuredClone(FIXTURE);
/** The first plain (not list, not nullable) text field of section 1 (hero), for refusal cases. */
const PLAIN = SECTIONS[1]!.text.find((field) => field.list === undefined && !field.atom)!;

function compile(recipeInput: unknown) {
  const recipe = validateStorefrontRecipe(recipeInput);
  assert.deepEqual(getStorefrontAssetRequirements(recipe), [], 'no image, font or video assets');
  const html = renderStorefront(recipe, {});
  return { recipe, html };
}
function refusal(recipeInput: unknown): string {
  try { compile(recipeInput); } catch (error) { return error instanceof Error ? error.message : String(error); }
  throw new Error('expected a refusal, the compiler accepted the recipe');
}

function fieldIds(prefix: string, field: FieldSpec): string[] {
  return field.list === undefined ? [`${prefix}--${field.name}`] : Array.from({ length: field.list }, (_, j) => `${prefix}--${field.name}-${j}`);
}
/**
 * buy-preorder's `url`, `phone` and `email` are destination DATA, not their own visible text: at
 * most one of the three ever becomes the single rendered `ctaLabel` link's `href` (see
 * `render.ts`'s `renderBuyPreorder`), so unlike every other atom in this family they never carry
 * their own `data-od-id`, present or null. `expectedSlotIds()` excludes them for that reason;
 * their behavior is covered by the dedicated buy-preorder destination tests below instead of the
 * generic per-atom visibility test.
 */
const DESTINATION_ONLY_FIELDS = new Set(['storefront-buy-preorder--url', 'storefront-buy-preorder--phone', 'storefront-buy-preorder--email']);

/**
 * A third audit pass caught the reference fixture rendering an invented reviewer name and phone
 * number neither of the storefront fixture briefs states — `reference.fixture.json` and
 * `families/storefront/recipe.json` now honestly leave both `reviews` items' `name` unset, per
 * the family's own round-4 rule ("a null name renders no attribution line at all"). Unlike
 * `DESTINATION_ONLY_FIELDS` (which never carries a `data-od-id` under ANY input), a review's
 * `name` DOES get one when it is filled — the reference fixture's own default is just honestly
 * null, so this exclusion belongs to the FIXTURE, not the slot contract; `expectedSlotIds()`
 * excludes it here the same way `DESTINATION_ONLY_FIELDS` is excluded, and the dedicated
 * per-atom nullable tests (`atoms()`/`setAtom`, independent of the fixture's own starting state)
 * still prove the slot renders correctly whenever it IS filled.
 */
const OMITTED_IN_REFERENCE_FIXTURE = new Set([
  'storefront-reviews--items-0--name', 'storefront-reviews--items-1--name',
  // rich.txt gives an email and a street address but no phone number; the footer's own phone
  // atom is honestly null here rather than an invented number, per the same third audit pass.
  'storefront-footer--phone',
]);

/** Every slot id a fully populated recipe renders, in document order, from slots.ts alone —
 * except the fields `DESTINATION_ONLY_FIELDS` and `OMITTED_IN_REFERENCE_FIXTURE` name, which the
 * reference fixture itself never fills (see each set's own docblock for why). */
function expectedSlotIds(): string[] {
  const ids = ['brand--name', 'brand--descriptor'];
  for (const section of SECTIONS) {
    for (const field of section.text) ids.push(...fieldIds(section.id, field).filter((id) => !DESTINATION_ONLY_FIELDS.has(id) && !OMITTED_IN_REFERENCE_FIXTURE.has(id)));
    for (let i = 0; i < (section.items?.count ?? 0); i++) {
      for (const field of section.items!.fields) ids.push(...fieldIds(`${section.id}--items-${i}`, field).filter((id) => !OMITTED_IN_REFERENCE_FIXTURE.has(id)));
    }
  }
  return ids;
}
/** Every nullable atom: where it sits in a recipe and the one slot id it renders. `ctaLabel` in
 * buy-preorder always renders (as a link or as plain text), so it is not treated as an atom here
 * even though its destination fields (url/phone/email) are nullable. */
function atoms(): { index: number; item?: number; name: string; id: string; kind: string | undefined }[] {
  const out: { index: number; item?: number; name: string; id: string; kind: string | undefined }[] = [];
  SECTIONS.forEach((section, index) => {
    for (const field of section.text) {
      if (field.atom && !DESTINATION_ONLY_FIELDS.has(`${section.id}--${field.name}`)) out.push({ index, name: field.name, id: `${section.id}--${field.name}`, kind: field.atom });
    }
    for (let i = 0; i < (section.items?.count ?? 0); i++) {
      for (const field of section.items!.fields) if (field.atom) out.push({ index, item: i, name: field.name, id: `${section.id}--items-${i}--${field.name}`, kind: field.atom });
    }
  });
  return out;
}
/** A synthetic value that passes the given atom kind's own format check, for the "fill it first"
 * half of the nullable-atom test below — never a real fact, purely to prove the slot appears. */
function syntheticValueFor(kind: string | undefined): string {
  if (kind === 'email') return 'test@example.com';
  if (kind === 'phone') return '206-555-0148';
  if (kind === 'url') return 'https://example.com/test';
  return 'Test value';
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
  const ids = listStorefrontTextSlots(html);
  assert.deepEqual(ids, expectedSlotIds());
  assert.equal(new Set(ids).size, ids.length, 'data-od-id values are unique');
  assert.equal(findStorefrontTextSlot(html, 'brand--name'), FIXTURE.brand.name);
  assert.equal(findStorefrontTextSlot(html, `${SECTIONS[1]!.id}--${PLAIN.name}`), FIXTURE.sections[1].text[PLAIN.name]);
});

test('slot containment is bidirectional: every declared slot is emitted, and every emitted id is declared', () => {
  const { html } = compile(clone());
  const emitted = new Set(listStorefrontTextSlots(html));
  const declared = new Set(expectedSlotIds());
  for (const id of emitted) assert.ok(declared.has(id), `${id}: emitted but not declared in slots.ts`);
  for (const id of declared) assert.ok(emitted.has(id), `${id}: declared in slots.ts but never emitted`);
  assert.equal(emitted.size, declared.size, 'no id is emitted more than once either');
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
  const declaredBlocks = pageKinds[FAMILY_ID];
  assert.ok(Array.isArray(declaredBlocks) && declaredBlocks.length > 0, `pagekinds.json: no "${FAMILY_ID}" entry`);
  assert.deepEqual([...STOREFRONT_BLOCKS], declaredBlocks, 'slots.ts STOREFRONT_BLOCKS matches the pagekinds.json declaration');

  const classesIn = (html: string) => new Set([...html.replaceAll('&amp;', '&').matchAll(/\sclass="([^"]*)"/g)].flatMap((match) => match[1]!.split(/\s+/).filter(Boolean)));
  const known = new Set<string>();
  for (const block of declaredBlocks!) {
    const blockPath = path.join(KIT, 'blocks', `${block}.html`);
    let source: string;
    try {
      source = readFileSync(blockPath, 'utf8');
    } catch (error) {
      assert.fail(`pagekinds.json declares block "${block}" but ${blockPath} does not exist (${error instanceof Error ? error.message : String(error)})`);
    }
    for (const token of classesIn(source)) known.add(token);
  }
  // This family's render.ts introduces a few utility classes (the emerald accent, the plain-text
  // fallback CTA) that no single vendored block's own literal markup carries; build-ui-kit-css.ts
  // scans this package's render.ts source too (see its own comment), so the compiled
  // css/storefront.css still covers every one of them. Assert that directly, the same guarantee
  // the block-only check gives restaurant/maren, rather than requiring literal reuse.
  const compiledCss = readFileSync(path.join(HERE, '../../catalog/hyperui/storefront.css'), 'utf8');
  // Tailwind escapes every CSS-special character in a class selector (":" for a variant, "/" for
  // an opacity modifier, "[" and "]" for an arbitrary variant) with a backslash.
  const cssEscaped = (token: string) => token.replace(/[:/[\].]/g, (char) => `\\${char}`);
  const missing = [...classesIn(compile(clone()).html)].filter((token) => !known.has(token) && !compiledCss.includes(cssEscaped(token)));
  assert.deepEqual(missing, [], 'classes css/storefront.css would not carry');
});

test('an optional section drops to null and renders nothing, with its nav link gone too; a null in a required section is refused', () => {
  for (const section of SECTIONS) {
    if (!section.optional) continue;
    const index = SECTIONS.indexOf(section);
    const dropped = clone();
    dropped.sections[index] = null;
    const { html } = compile(dropped);
    assert.ok(!html.includes(`id="${section.id}"`), `${section.id}: no section wrapper`);
    assert.ok(!html.includes(`data-od-id="${section.id}`), `${section.id}: no edit targets`);
    assert.ok(!html.includes(`href="#${section.id}"`), `${section.id}: its nav link is gone too`);
    assert.deepEqual(listStorefrontTextSlots(html), expectedSlotIds().filter((id) => !id.startsWith(`${section.id}--`)));
  }
  const requiredIndex = SECTIONS.findIndex((section) => !section.optional);
  const required = clone();
  required.sections[requiredIndex] = null;
  assert.match(refusal(required), /sections\[\d+\]: expected a plain object/);
});

test('every optional section survives on its own when only one other is dropped', () => {
  const optionalIndices = SECTIONS.map((section, index) => (section.optional ? index : -1)).filter((index) => index >= 0);
  for (const droppedIndex of optionalIndices) {
    const recipe = clone();
    recipe.sections[droppedIndex] = null;
    const { html } = compile(recipe);
    for (const index of optionalIndices) {
      if (index === droppedIndex) continue;
      const section = SECTIONS[index]!;
      assert.ok(html.includes(`id="${section.id}"`), `${section.id} still renders while only ${SECTIONS[droppedIndex]!.id} is dropped`);
    }
  }
});

test('the header nav is capped at four links total (one fixed + at most three of the surviving optional sections, in spine order)', () => {
  const { html } = compile(clone());
  const headerFragment = /<header\b[\s\S]*?<\/header>/.exec(html)![0];
  const navFragment = /<nav\b[\s\S]*?<\/nav>/.exec(headerFragment)![0];
  const links = [...navFragment.matchAll(/<a\b[^>]*>/g)];
  // The reference fixture has all five optional sections present, plus the fixed "Shop" link:
  // capped at four nav links, not counting the separate Buy CTA button (also inside <header>, but
  // outside <nav>).
  assert.equal(links.length, 4, `expected exactly 4 nav <a> tags, got ${links.length}`);
  const optionalTypes = ['collection-grid', 'product-details', 'shipping-returns', 'reviews', 'story-about'];
  const firstThreeIds = optionalTypes.slice(0, 3).map((type) => SECTIONS.find((s) => s.type === type)!.id);
  for (const id of firstThreeIds) assert.ok(headerFragment.includes(`href="#${id}"`), `${id} is one of the first three surviving optional sections and must be linked`);
  const laterIds = optionalTypes.slice(3).map((type) => SECTIONS.find((s) => s.type === type)!.id);
  for (const id of laterIds) assert.ok(!headerFragment.includes(`href="#${id}"`), `${id} is past the four-link cap and must not be linked`);
});

test('the featured-product nav link\'s label is fixed chrome, never model text (G5 round 2)', () => {
  const { html } = compile(clone());
  const featuredId = FIXTURE.sections.find((s: { type?: string }) => s?.type === 'featured-product').id;
  assert.match(html, new RegExp(`<a class="[^"]*" href="#${featuredId}">Shop</a>`),
    'the featured-product nav link reads "Shop" and opens the featured-product section — a round-2 Grok audit found this label used to be model-writable text (header.text.links) while the anchor stayed pinned to the same section regardless of what the label said');
  const header = SECTIONS.find((s) => s.type === 'header')!;
  assert.ok(!header.text.some((field) => field.name === 'links'), 'header.text no longer has a model-writable links field at all');
});

test('an old saved recipe that still carries the removed header.text.links compiles, and the field never renders (G5 round 3)', () => {
  const legacy = clone();
  const headerIndex = FIXTURE.sections.findIndex((s: { type?: string }) => s?.type === 'header');
  legacy.sections[headerIndex] = { ...legacy.sections[headerIndex], text: { ...legacy.sections[headerIndex].text, links: ['Shop'] } };
  const { html } = compile(legacy);
  const featuredId = FIXTURE.sections.find((s: { type?: string }) => s?.type === 'featured-product').id;
  assert.match(html, new RegExp(`<a class="[^"]*" href="#${featuredId}">Shop</a>`), 'the fixed "Shop" label still renders normally');
  const headerId = FIXTURE.sections[headerIndex].id;
  assert.equal(html.includes(`${headerId}--links-0`), false, 'the legacy links field leaves no data-od-id or reconcilable trace');
});

test('each nullable atom drops only its own element; a null in a plain slot is refused', () => {
  const list = atoms();
  assert.ok(list.length > 0, 'the family has nullable atoms');
  for (const atom of list) {
    // Independent of whether the reference fixture itself happens to carry this particular atom
    // filled or null (e.g. the reviews' names are null in the fixture, honestly matching its own
    // brief-less omitted-attribution default): first force a synthetic non-null value so the "one
    // slot appears, then disappears" comparison never depends on the fixture's own starting
    // state for this one atom.
    const filled = clone();
    setAtom(filled, atom, syntheticValueFor(atom.kind));
    const { html: filledHtml } = compile(filled);
    const filledIds = listStorefrontTextSlots(filledHtml);
    assert.ok(filledIds.includes(atom.id), `${atom.id}: expected to appear once filled`);

    const dropped = clone();
    setAtom(dropped, atom, null);
    const { html: droppedHtml } = compile(dropped);
    assert.deepEqual(listStorefrontTextSlots(droppedHtml), filledIds.filter((id) => id !== atom.id), atom.id);
  }
  const plain = clone();
  plain.sections[1].text[PLAIN.name] = null;
  assert.match(refusal(plain), new RegExp(`sections\\[1\\]\\.text\\.${PLAIN.name}: expected plain text`));
});

test('email, phone and url atoms are format-checked', () => {
  for (const atom of atoms()) {
    const recipe = clone();
    if (atom.name === 'email') {
      setAtom(recipe, atom, 'not an email');
      assert.match(refusal(recipe), /expected an email address/);
    }
    if (atom.name === 'phone') {
      setAtom(recipe, atom, 'call us');
      assert.match(refusal(recipe), /expected a phone number/);
    }
  }
});

test('buy-preorder\'s url atom (destination-only, no data-od-id of its own) is still format-checked', () => {
  const buyIndex = SECTIONS.findIndex((s) => s.type === 'buy-preorder');
  const bad = clone();
  bad.sections[buyIndex].text.url = 'not-a-url';
  assert.match(refusal(bad), /expected an http:\/\/ or https:\/\/ url/);
  const ftp = clone();
  ftp.sections[buyIndex].text.url = 'ftp://example.com/drop';
  assert.match(refusal(ftp), /expected an http:\/\/ or https:\/\/ url/);
  const good = clone();
  good.sections[buyIndex].text.url = 'https://shop.example.com/drop';
  assert.doesNotThrow(() => compile(good));
});

test('buy-preorder: a supplied url renders a real external link, not a "#" placeholder', () => {
  const { html } = compile(clone());
  assert.match(html, /<a href="https:\/\/shop\.tallowrow\.example\/autumn" rel="noopener noreferrer" target="_blank"[^>]*data-od-id="storefront-buy-preorder--ctaLabel"[^>]*>Shop the autumn run<\/a>/);
});

test('buy-preorder: no url falls back to phone, then to email, then to plain text (never a dead link)', () => {
  const phoneOnly = clone();
  const buyIndex = SECTIONS.findIndex((s) => s.type === 'buy-preorder');
  phoneOnly.sections[buyIndex].text.url = null;
  phoneOnly.sections[buyIndex].text.phone = '206-555-0148';
  phoneOnly.sections[buyIndex].text.email = null;
  const { html: phoneHtml } = compile(phoneOnly);
  assert.match(phoneHtml, /<a href="tel:2065550148"[^>]*data-od-id="storefront-buy-preorder--ctaLabel"/);

  const emailOnly = clone();
  emailOnly.sections[buyIndex].text.url = null;
  emailOnly.sections[buyIndex].text.phone = null;
  emailOnly.sections[buyIndex].text.email = 'shop@tallowrow.example';
  const { html: emailHtml } = compile(emailOnly);
  assert.match(emailHtml, /<a href="mailto:shop%40tallowrow\.example"[^>]*data-od-id="storefront-buy-preorder--ctaLabel"/);

  const none = clone();
  none.sections[buyIndex].text.url = null;
  none.sections[buyIndex].text.phone = null;
  none.sections[buyIndex].text.email = null;
  const { html: noneHtml } = compile(none);
  assert.match(noneHtml, /<span[^>]*data-od-id="storefront-buy-preorder--ctaLabel"[^>]*>Shop the autumn run<\/span>/, 'plain text, not a link, when no destination is supplied');
  const buyFragment = /<section id="storefront-buy-preorder"[\s\S]*?<\/section>/.exec(noneHtml)![0];
  assert.ok(!buyFragment.includes('<a '), 'no anchor tag at all inside buy-preorder when no destination is supplied');
  assert.ok(!buyFragment.includes('href="#"'), 'never a "#" placeholder link');
  // The section itself still renders: heading and body stand even with no destination.
  assert.ok(noneHtml.includes('id="storefront-buy-preorder"'));
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

test('a bare URL spelled out in a free-form text field is refused: it belongs only in the buy-preorder url atom', () => {
  const withUrl = clone();
  withUrl.sections[1].text.body = 'Preorder now at preorder.halberdaudio.example/one for the full run.';
  assert.match(refusal(withUrl), /sections\[1\]\.text\.body: a URL belongs only in the buy-preorder url slot/);
  const withScheme = clone();
  withScheme.sections[1].text.body = 'Preorder now at https://preorder.halberdaudio.example/one for the full run.';
  assert.match(refusal(withScheme), /sections\[1\]\.text\.body: a URL belongs only in the buy-preorder url slot/);
  // The buy-preorder section's own `url` atom is unaffected: it is the one field allowed to hold
  // a real URL, and email/phone atoms (which legitimately contain domain-shaped text) are
  // unaffected too — both already covered by "email, phone and url atoms are format-checked".
  const buyIndex = SECTIONS.findIndex((s) => s.type === 'buy-preorder');
  const validUrl = clone();
  validUrl.sections[buyIndex].text.url = 'https://shop.example.com/drop';
  assert.doesNotThrow(() => compile(validUrl));
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

test('STOREFRONT_OPTIONAL_SECTIONS names exactly the five optional section types', () => {
  assert.deepEqual([...STOREFRONT_OPTIONAL_SECTIONS].sort(), ['collection-grid', 'product-details', 'reviews', 'shipping-returns', 'story-about'].sort());
});

test('collection-grid never pads: it is present only with all four items filled, or entirely dropped', () => {
  const withGrid = clone();
  const gridIndex = SECTIONS.findIndex((s) => s.type === 'collection-grid');
  assert.equal(withGrid.sections[gridIndex].items.length, 4, 'the reference fixture carries exactly four grid items when present');
  for (const item of withGrid.sections[gridIndex].items) {
    assert.ok(typeof item.name === 'string' && item.name.length > 0, 'every present item has a real name, never an empty placeholder');
  }
});

/**
 * No two of this family's free-text fields covering overlapping ground (the hero pitch, the
 * featured product's own description, the story/about narrative, the footer tagline) may repeat
 * the same run of 6+ words verbatim — the cross-section fact-duplication defect class (a brand
 * line or founding fact copy-pasted across sections) flagged in review of a sibling family.
 */
test('no long verbatim phrase repeats across hero, featured-product, story-about and footer', () => {
  const recipe = clone();
  const sectionText = (type: string, field: string): string | undefined => {
    const section = recipe.sections.find((s: { type: string }) => s.type === type);
    return section?.text[field] as string | undefined;
  };
  const fields: Array<[string, string | undefined]> = [
    ['hero.body', sectionText('hero', 'body')],
    ['featured-product.description', sectionText('featured-product', 'description')],
    ['story-about.body', sectionText('story-about', 'body')],
    ['footer.tagline', sectionText('footer', 'tagline')],
  ];
  const ngrams = (text: string, n = 6): Set<string> => {
    const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean);
    const out = new Set<string>();
    for (let i = 0; i + n <= words.length; i++) out.add(words.slice(i, i + n).join(' '));
    return out;
  };
  for (let i = 0; i < fields.length; i++) {
    for (let j = i + 1; j < fields.length; j++) {
      const [nameA, textA] = fields[i]!;
      const [nameB, textB] = fields[j]!;
      if (!textA || !textB) continue;
      const shared = [...ngrams(textA)].filter((gram) => ngrams(textB).has(gram));
      assert.deepEqual(shared, [], `${nameA} and ${nameB} repeat a 6+ word phrase verbatim: ${shared.join(' | ')}`);
    }
  }
});

test('reviews: no title slot exists at all (cannot invent a heading with no slot for one); a null name renders no attribution line at all', () => {
  assert.ok(!SECTIONS.find((s) => s.type === 'reviews')!.items!.fields.some((field) => field.name === 'title'), 'title was removed from the reviews item schema');
  const recipe = clone();
  const reviewsIndex = SECTIONS.findIndex((s) => s.type === 'reviews');
  recipe.sections[reviewsIndex].items[0].name = null;
  const { html } = compile(recipe);
  assert.ok(!html.includes('Verified buyer'), 'no fallback attribution claim of any kind is rendered for a null reviewer name');
  assert.ok(!html.includes(`data-od-id="storefront-reviews--items-0--name"`), 'a null name renders no attribution element at all, so no data-od-id for it either');
  const reviewsFragment = /<section id="storefront-reviews"[\s\S]*?<\/section>/.exec(html)![0];
  assert.ok(!reviewsFragment.includes('title'), 'no title markup of any kind remains inside the reviews section');
});
