/**
 * practice family render tests.
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
import { isPhoneNumber, recipeSchema } from './contract.ts';
import { dishonestLinks } from '../../sections.ts';
import {
  findPracticeTextSlot, getPracticeAssetRequirements, listPracticeTextSlots,
  renderPractice, validatePracticeRecipe,
} from './render.ts';
import {
  BOOK_SECTION_ID, FAMILY_ID, PRACTICE_BLOCKS, PRACTICE_NULLABLE_ATOMS,
  PRACTICE_OPTIONAL_SECTIONS, SECTIONS, SECTION_ORDER, type FieldSpec,
} from './slots.ts';

const HERE = import.meta.dirname;
const KIT = path.join(HERE, '../../../../../../shared/ui-kits/hyperui');
const FIXTURE = JSON.parse(readFileSync(path.join(HERE, 'reference.fixture.json'), 'utf8'));
const clone = () => structuredClone(FIXTURE);
/** The first plain (not list, not nullable) text field of section 1, for the refusal cases. */
const PLAIN = SECTIONS[1]!.text.find((field) => field.list === undefined && !field.atom)!;

function compile(recipeInput: unknown) {
  const recipe = validatePracticeRecipe(recipeInput);
  assert.deepEqual(getPracticeAssetRequirements(recipe), [], 'no image, font or video assets');
  const html = renderPractice(recipe, {});
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
 * Every slot id `recipe` renders, in document order, from slots.ts's own field roster. A nullable
 * atom (`field.atom`) whose value in `recipe` is `null` renders nothing (see render.ts's `atom`
 * helper) and is skipped — the reference fixture itself carries one such case: insurance's own
 * PPO-plan price, which the brief that produced it never states a fixed figure for ("our front
 * desk verifies benefits before billing"), so the honest recipe leaves it null rather than
 * repeating the vague, dropped-at-render placeholder text a live model once wrote there.
 */
function expectedSlotIds(recipe: { brand: Record<string, unknown>; sections: ({ id: string; text: Record<string, unknown>; items?: Record<string, unknown>[] } | null)[] }): string[] {
  const ids = ['brand--name', 'brand--descriptor'];
  recipe.sections.forEach((recipeSection, index) => {
    if (recipeSection === null) return;
    const section = SECTIONS[index]!;
    for (const field of section.text) if (!field.atom || recipeSection.text[field.name] !== null) ids.push(...fieldIds(section.id, field));
    (recipeSection.items ?? []).forEach((recipeItem, i) => {
      for (const field of section.items!.fields) if (!field.atom || recipeItem[field.name] !== null) ids.push(...fieldIds(`${section.id}--items-${i}`, field));
    });
  });
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

test('the reference fixture has no dishonest links: every href is a real in-page anchor or a real destination', () => {
  // Regression coverage for the header nav's own former `href="#"` placeholders (every link now
  // points at its section's real id) and the footer's former invented nav labels. Full coverage
  // across every optional-section-dropped combination lives in the shared
  // `link-honesty.test.ts`'s own practice case; this one just pins the common, everything-present
  // path directly alongside this family's other render tests.
  const { html } = compile(clone());
  assert.deepEqual(dishonestLinks(html), []);
});

test('every text slot renders exactly once, in the order slots.ts declares', () => {
  const { recipe, html } = compile(clone());
  const ids = listPracticeTextSlots(html);
  assert.deepEqual(ids, expectedSlotIds(recipe));
  assert.equal(new Set(ids).size, ids.length, 'data-od-id values are unique');
  assert.equal(findPracticeTextSlot(html, 'brand--name'), FIXTURE.brand.name);
  assert.equal(findPracticeTextSlot(html, `${SECTIONS[1]!.id}--${PLAIN.name}`), FIXTURE.sections[1].text[PLAIN.name]);
});

test('recipe.schema.json is exactly the schema contract.ts derives from slots.ts', () => {
  const committed = JSON.parse(readFileSync(path.join(HERE, 'recipe.schema.json'), 'utf8'));
  assert.deepEqual(committed, recipeSchema());
});

test('the package default spine is the reference fixture', () => {
  const recipe = JSON.parse(readFileSync(path.join(HERE, `../../../../families/${FAMILY_ID}/recipe.json`), 'utf8'));
  assert.deepEqual(recipe, FIXTURE);
});

test('the header nav labels are FIXED and enumerated, never model text (round-2 Grok audit: a model-written label used to be free to name a target it did not point at)', () => {
  const headerIndex = SECTIONS.findIndex((section) => section.type === 'header');
  // No `links` field on the header's schema at all: contract.ts refuses the moment a caller
  // tries to supply one, the same way it refuses any other field this family's schema does not
  // declare.
  const withLinks = clone();
  (withLinks.sections[headerIndex].text as Record<string, unknown>).links = ['Services', 'Providers', 'FAQ', 'Hours & location'];
  assert.match(refusal(withLinks), /sections\[0\]\.text\.links: unknown field/);
  // The rendered labels are the SAME fixed strings the footer nav already uses for the same
  // sections — the enumerated set this test pins, not whatever a model would have written.
  const { html } = compile(clone());
  const headerHtml = html.slice(html.indexOf('<header'), html.indexOf('</header>'));
  for (const label of ['Services', 'Providers', 'FAQ', 'Hours &amp; location']) {
    assert.ok(headerHtml.includes(`>${label}<`), `the header nav shows the fixed label "${label}"`);
  }
});

test('every class the page uses has a rule in the compiled css/practice.css', () => {
  const pageKinds = JSON.parse(readFileSync(path.join(KIT, 'pagekinds.json'), 'utf8')) as Record<string, string[]>;
  assert.deepEqual(pageKinds[FAMILY_ID], [...PRACTICE_BLOCKS], 'pagekinds.json lists the blocks slots.ts names');
  const classesIn = (html: string) => new Set([...html.replaceAll('&amp;', '&').matchAll(/\sclass="([^"]*)"/g)].flatMap((match) => match[1]!.split(/\s+/).filter(Boolean)));
  // `scripts/build-ui-kit-css.ts` compiles this page kind's Tailwind build by scanning both the
  // vendored blocks AND this family's own render.ts (see its `familyRenderSource`), because the
  // family's own layout/utility classes need rules too, not only the vendored blocks' classes.
  // So the real invariant is "the compiled stylesheet has a rule for it" — checked here by
  // parsing every class selector Tailwind wrote, unescaping its backslash-escaped punctuation
  // (`hover\:bg-blue-700` -> `hover:bg-blue-700`) — not "copied verbatim from a vendored block",
  // which would forbid this family from using its own reviewed spacing/color/focus utilities.
  const css = readFileSync(path.join(HERE, '../../catalog/hyperui/practice.css'), 'utf8');
  const known = new Set([...css.matchAll(/\.((?:\\.|[a-zA-Z0-9_-])+)/g)].map((match) => match[1]!.replace(/\\(.)/g, '$1')));
  const missing = [...classesIn(compile(clone()).html)].filter((token) => !known.has(token));
  assert.deepEqual(missing, [], 'classes css/practice.css does not carry a rule for');
});

test('the page actually inlines its OWN compiled stylesheet, never another page kind\'s (e.g. restaurant\'s)', () => {
  // Regression coverage: packages/genui-catalog/scripts/sync-catalog-assets.ts's generated
  // CATALOG.json once drifted to record restaurant's stylesheet as this family's own page CSS —
  // a stale manifest entry an external audit flagged. That manifest is not what render.ts
  // actually inlines (HYPERUI_CSS reads catalog/hyperui/practice.css directly, see its own doc),
  // but this pins BOTH ends: the manifest names the right file, and the rendered page's own
  // <style> block is byte-for-byte that file's content, containing a class ("lg:w-80", the hero
  // trust panel's width) restaurant's own build never generates.
  const catalog = JSON.parse(readFileSync(path.join(HERE, '../../catalog/CATALOG.json'), 'utf8')) as { files: { path: string; source: string }[] };
  const cssEntry = catalog.files.find((file) => file.path === 'hyperui/practice.css');
  assert.ok(cssEntry, 'CATALOG.json names a hyperui/practice.css entry');
  assert.equal(cssEntry!.source, 'plugins/_official/shared/ui-kits/hyperui/css/practice.css', 'the entry points at practice\'s own build, not another page kind\'s');
  const practiceCss = readFileSync(path.join(HERE, '../../catalog/hyperui/practice.css'), 'utf8');
  const { html } = compile(clone());
  const styleMatch = /<style>([\s\S]*?)<\/style>/.exec(html);
  assert.ok(styleMatch, 'the page has an inline <style> block');
  assert.equal(styleMatch![1], practiceCss, 'the inlined stylesheet is exactly this family\'s own compiled css/practice.css');
  assert.ok(practiceCss.includes('lg\\:w-80'), 'sanity: the compiled sheet carries a practice-specific class restaurant\'s build does not');
});

test('each optional section drops to null and renders nothing, nor its nav link; a null elsewhere is refused', () => {
  const optional = SECTIONS.filter((section) => section.optional);
  assert.deepEqual([...PRACTICE_OPTIONAL_SECTIONS], optional.map((section) => section.type));
  // providers and expect are optional too (Devin, 2026-10-10): a dental brief that names no dentist
  // and describes no visit could only fill them by inventing a name and a step, so strict verify
  // refused every such build.
  assert.deepEqual(optional.map((section) => section.type), ['providers', 'expect', 'reviews', 'insurance', 'faq', 'hours-location']);
  for (const section of optional) {
    const index = SECTIONS.indexOf(section);
    const dropped = clone();
    dropped.sections[index] = null;
    const { html } = compile(dropped);
    assert.ok(!html.includes(`id="${section.id}"`), `${section.id}: no section wrapper`);
    assert.ok(!html.includes(`data-od-id="${section.id}`), `${section.id}: no edit targets`);
    assert.ok(!html.includes(`href="#${section.id}"`), `${section.id}: no header or footer nav link to a dropped section`);
    assert.deepEqual(listPracticeTextSlots(html), expectedSlotIds(dropped).filter((id) => !id.startsWith(`${section.id}--`)));
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
    assert.deepEqual(listPracticeTextSlots(html), expectedSlotIds(recipe).filter((id) => id !== atom.id), atom.id);
  }
  const all = clone();
  for (const atom of list) setAtom(all, atom, null);
  const ids = listPracticeTextSlots(compile(all).html);
  assert.equal(ids.length, expectedSlotIds(all).length, 'every atom null at once');
  const plain = clone();
  plain.sections[1].text[PLAIN.name] = null;
  assert.match(refusal(plain), new RegExp(`sections\\[1\\]\\.text\\.${PLAIN.name}: expected plain text`));
});

test('a null book destination with no phone or email anywhere on the page renders the call as plain, non-button text, never a dead link', () => {
  const recipe = clone();
  const bookIndex = SECTIONS.findIndex((section) => section.type === 'book');
  const hoursIndex = SECTIONS.findIndex((section) => section.type === 'hours-location');
  const footerIndex = SECTIONS.findIndex((section) => section.type === 'footer');
  recipe.sections[bookIndex].text.destination = null;
  recipe.sections[hoursIndex].text.phone = null;
  recipe.sections[footerIndex].text.phone = null;
  recipe.sections[footerIndex].text.email = null;
  const { html } = compile(recipe);
  assert.match(html, /<span class="block text-base font-medium text-blue-50" data-od-id="practice-book--cta">Book a visit<\/span>/, 'plain text, not a button');
  assert.ok(!/<a[^>]*data-od-id="practice-book--cta"/.test(html), 'the book call is never an anchor when nothing real backs it');
  assert.ok(!/data-od-id="practice-book--cta"[^>]*class="[^"]*(bg-gray|rounded)/.test(html), 'the fallback text never carries a button or greyed-out control class');
});

test("a null book destination falls back to a phone or email the page already shows, styled as the primary action", () => {
  const bookIndex = SECTIONS.findIndex((section) => section.type === 'book');
  const hoursIndex = SECTIONS.findIndex((section) => section.type === 'hours-location');

  const viaHours = clone();
  viaHours.sections[bookIndex].text.destination = null;
  assert.equal(viaHours.sections[hoursIndex].text.phone, FIXTURE.sections[hoursIndex].text.phone, 'fixture sanity: hours-location keeps its own phone');
  const htmlViaHours = compile(viaHours).html;
  assert.match(htmlViaHours, /<a href="tel:5035550142"[^>]*data-od-id="practice-book--cta">Book a visit<\/a>/, 'falls back to hours-location.phone');

  const footerIndex = SECTIONS.findIndex((section) => section.type === 'footer');
  const viaFooterEmail = clone();
  viaFooterEmail.sections[bookIndex].text.destination = null;
  viaFooterEmail.sections[hoursIndex].text.phone = null;
  viaFooterEmail.sections[footerIndex].text.phone = null;
  const htmlViaEmail = compile(viaFooterEmail).html;
  assert.match(htmlViaEmail, /<a href="mailto:frontdesk%40willowcreekdental\.example"[^>]*data-od-id="practice-book--cta">Book a visit<\/a>/, 'falls back to footer.email when no phone exists anywhere');
});

test('the book destination is classified into the matching honest scheme', () => {
  const cases: [string, RegExp][] = [
    ['https://booking.example.com/willow-creek', /href="https:\/\/booking\.example\.com\/willow-creek"/],
    ['(503) 555-0142', /href="tel:5035550142"/],
    ['front-desk@willowcreekdental.example', /href="mailto:front-desk%40willowcreekdental\.example"/],
    // round-2 Grok audit: a URL can legitimately carry an `@` (userinfo, path or query) and must
    // still classify as a URL, never a mailto — the scheme is checked BEFORE the `@` test.
    ['https://clinic.example/book?e=ada@clinic.example', /href="https:\/\/clinic\.example\/book\?e=ada@clinic\.example"/],
  ];
  for (const [destination, expected] of cases) {
    const recipe = clone();
    const bookIndex = SECTIONS.findIndex((section) => section.type === 'book');
    recipe.sections[bookIndex].text.destination = destination;
    assert.match(compile(recipe).html, expected, destination);
  }
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

test('a book destination that is not a well-formed URL, email or phone is refused, never coerced into a link', () => {
  const bookIndex = SECTIONS.findIndex((section) => section.type === 'book');
  const cases: [string, string][] = [
    ['acme.com/book', 'scheme-less URL (no http:// or https://)'],
    ['Call us to schedule your visit today', 'prose, not a destination at all'],
    ['ask @ the front desk', 'a stray @ that is not an email address'],
  ];
  for (const [destination, why] of cases) {
    const recipe = clone();
    recipe.sections[bookIndex].text.destination = destination;
    assert.match(refusal(recipe), /expected a URL, email address, or phone number/, why);
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

test('item counts stay within [min, count]: below min or above count is refused, exact count sections have no slack', () => {
  SECTIONS.forEach((section, index) => {
    if (section.items) {
      const { count, min = count } = section.items;
      const short = clone();
      short.sections[index].items.pop();
      if (short.sections[index].items.length < min) {
        assert.match(
          refusal(short),
          min === count
            ? new RegExp(`sections\\[${index}\\]\\.items: expected exactly ${count} items`)
            : new RegExp(`sections\\[${index}\\]\\.items: expected ${min} to ${count} items`),
          `${section.id}: below min is refused`,
        );
      } else {
        assert.doesNotThrow(() => compile(short), `${section.id}: ${short.sections[index].items.length} items (>= min ${min}) is accepted`);
      }
      const over = clone();
      over.sections[index].items.push(structuredClone(over.sections[index].items[0]));
      assert.match(
        refusal(over),
        min === count
          ? new RegExp(`sections\\[${index}\\]\\.items: expected exactly ${count} items`)
          : new RegExp(`sections\\[${index}\\]\\.items: expected ${min} to ${count} items`),
        `${section.id}: above count is refused`,
      );
    }
    for (const field of section.text) {
      if (field.list === undefined) continue;
      const shortList = clone();
      shortList.sections[index].text[field.name].pop();
      assert.match(refusal(shortList), new RegExp(`sections\\[${index}\\]\\.text\\.${field.name}: expected exactly ${field.list} items`));
    }
  });
});

test('a section with fewer than the maximum items renders exactly that many cards, never padded with invented or borrowed content', () => {
  const providersIndex = SECTIONS.findIndex((section) => section.type === 'providers');
  const recipe = clone();
  recipe.sections[providersIndex].items = [recipe.sections[providersIndex].items[0]];
  const { html } = compile(recipe);
  assert.ok(html.includes('data-od-id="practice-providers--items-0--name"'), 'the one real provider renders');
  assert.ok(!html.includes('data-od-id="practice-providers--items-1--name"'), 'no second, padded provider card');
  assert.ok(!html.includes('data-od-id="practice-providers--items-2--name"'), 'no third, padded provider card');
  // The dropped providers' own facts (from the fixture's items 1 and 2) never appear anywhere,
  // borrowed into another section either.
  for (const dropped of [FIXTURE.sections[providersIndex].items[1], FIXTURE.sections[providersIndex].items[2]]) {
    assert.ok(!html.includes(dropped.name), `${dropped.name}: the dropped provider's own name does not leak elsewhere`);
  }
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

test('phone atom accepts US and international formats and refuses non-numbers', () => {
  for (const ok of ['(503) 555-0142', '+44 20 7946 0958', '828-555-0135']) assert.ok(isPhoneNumber(ok), ok);
  for (const bad of ['call us', '12345']) assert.ok(!isPhoneNumber(bad), bad);
});

test("a provider card whose name is actually a service's own title (borrowed padding) is dropped, not rendered as a person", () => {
  const providersIndex = SECTIONS.findIndex((section) => section.type === 'providers');
  const servicesIndex = SECTIONS.findIndex((section) => section.type === 'services');
  const recipe = clone();
  const borrowedTitle = FIXTURE.sections[servicesIndex].items[0].title;
  recipe.sections[providersIndex].items = [
    recipe.sections[providersIndex].items[0],
    { name: borrowedTitle, credential: 'Part of the plan after your exam' },
  ];
  const { html } = compile(recipe);
  assert.ok(html.includes('data-od-id="practice-providers--items-0--name"'), 'the one real provider still renders');
  assert.ok(!html.includes('data-od-id="practice-providers--items-1--name"'), 'the borrowed-title card is dropped');
  // The service's own title still legitimately appears once, as a service — just never a second
  // time, promoted to a provider card.
  const occurrences = html.split(`>${borrowedTitle}<`).length - 1;
  assert.equal(occurrences, 1, `"${borrowedTitle}" should appear exactly once (as the real service), not also as a fabricated provider`);
  // The hero's own trust panel never shows a derived item count at all (a padded total would be
  // exactly as dishonest as an under-counted one) — only genuinely brief-supplied contact facts.
  assert.ok(!/<dt[^>]*>Provider/.test(html), 'the hero trust panel carries no provider (or any other item) count');
});

test("a provider card whose name is actually an expect step's own title (the same padding pattern, a different section) is dropped too", () => {
  // A live sparse-vet rebuild (with the array-minima fill fix) showed the SAME borrowed-title
  // padding bug reaching past a real provider, this time reusing an "expect" step's title
  // instead of a services one — the guard needs to check every other section's item titles, not
  // only services'.
  const providersIndex = SECTIONS.findIndex((section) => section.type === 'providers');
  const expectIndex = SECTIONS.findIndex((section) => section.type === 'expect');
  const recipe = clone();
  const borrowedTitle = FIXTURE.sections[expectIndex].items[0].title;
  recipe.sections[providersIndex].items = [
    recipe.sections[providersIndex].items[0],
    { name: borrowedTitle, credential: 'Handled by our front desk' },
  ];
  const { html } = compile(recipe);
  assert.ok(html.includes('data-od-id="practice-providers--items-0--name"'), 'the one real provider still renders');
  assert.ok(!html.includes('data-od-id="practice-providers--items-1--name"'), "the borrowed expect-step-title card is dropped");
});

test('a real short provider name that merely shares LETTERS with an unrelated title word is never dropped (round-2 Grok audit: substring matching wrongly deleted real people)', () => {
  // The reference fixture's own expect step 2 is titled "Exam and X-rays" — under the old
  // substring-either-direction check, a provider literally named "Ray" was dropped because
  // "exam and x-rays" (lowercased) contains the substring "ray". Whole-word equality must not
  // make that mistake: "ray" is never a WORD of "exam and x rays" (its words are exam/and/x/
  // rays), so a real "Ray" must render.
  const providersIndex = SECTIONS.findIndex((section) => section.type === 'providers');
  const cases = ['Ray', 'Dr. Ray Okonkwo', 'Sam', 'Ann', 'Pat'];
  for (const name of cases) {
    const recipe = clone();
    recipe.sections[providersIndex].items = [{ name, credential: 'General dentistry' }];
    const { html } = compile(recipe);
    assert.ok(html.includes('data-od-id="practice-providers--items-0--name"'), `"${name}" must render, not be dropped as borrowed padding`);
    assert.match(html, new RegExp(`data-od-id="practice-providers--items-0--name">${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}<`), `"${name}" must render its own text`);
  }
});

test('a provider section left with zero real cards after the borrowed/duplicate filter renders nothing at all, and drops its own nav link too', () => {
  const providersIndex = SECTIONS.findIndex((section) => section.type === 'providers');
  const expectIndex = SECTIONS.findIndex((section) => section.type === 'expect');
  const recipe = clone();
  const borrowedTitle = FIXTURE.sections[expectIndex].items[0].title;
  // Every provider card borrows a real title, so nothing survives the filter.
  recipe.sections[providersIndex].items = [
    { name: borrowedTitle, credential: 'a' },
    { name: FIXTURE.sections[expectIndex].items[1].title, credential: 'b' },
    { name: FIXTURE.sections[expectIndex].items[2].title, credential: 'c' },
  ];
  const { html } = compile(recipe);
  assert.ok(!html.includes('id="practice-providers"'), 'the empty providers section itself never renders');
  assert.ok(!/Meet your provider/i.test(html), 'no orphan heading for a section with no cards');
  assert.ok(!html.includes('href="#practice-providers"'), 'no header or footer nav link points at the now-empty section');
});

test('a solo-practitioner brief padded by repeating the SAME real provider under different credential text (the sparse-vet clinic-copy bug) renders that provider once', () => {
  const providersIndex = SECTIONS.findIndex((section) => section.type === 'providers');
  const recipe = clone();
  const realName = recipe.sections[providersIndex].items[0].name;
  recipe.sections[providersIndex].items = [
    { name: realName, credential: 'Veterinarian at the clinic' },
    { name: realName, credential: 'Sees every patient personally' },
    { name: realName.toUpperCase(), credential: 'Available for every visit' },
  ];
  const { html } = compile(recipe);
  assert.ok(html.includes('data-od-id="practice-providers--items-0--name"'), 'the first card for this real name still renders');
  assert.ok(!html.includes('data-od-id="practice-providers--items-1--name"'), 'a second card repeating the same real name is dropped');
  assert.ok(!html.includes('data-od-id="practice-providers--items-2--name"'), 'a third card repeating the same real name (case-insensitively) is dropped too');
  const occurrences = html.split(`>${realName}<`).length - 1;
  assert.equal(occurrences, 1, `"${realName}" should render exactly once as a provider card, not three times`);
});

test('a solo-practitioner brief padded with the SAME real provider under a DIFFERENT credential suffix on the name itself is still recognized as one person (round-3 Grok audit: "Dr. Hannah Okafor" and "Dr. Hannah Okafor, DVM" rendered twice under a plain trim+casefold)', () => {
  const providersIndex = SECTIONS.findIndex((section) => section.type === 'providers');
  const recipe = clone();
  recipe.sections[providersIndex].items = [
    { name: 'Dr. Hannah Okafor', credential: 'Small animal veterinarian' },
    { name: 'Dr. Hannah Okafor, DVM', credential: 'Sees every patient personally' },
    { name: 'HANNAH OKAFOR, DVM.', credential: 'Available for every visit' },
  ];
  const { html } = compile(recipe);
  assert.ok(html.includes('data-od-id="practice-providers--items-0--name"'), 'the first spelling still renders');
  assert.ok(!html.includes('data-od-id="practice-providers--items-1--name"'), 'the same person with a credential suffix appended is recognized as a duplicate');
  assert.ok(!html.includes('data-od-id="practice-providers--items-2--name"'), 'the same person, uppercased, with a trailing period after the credential, is recognized too');
  const occurrences = (html.match(/Hannah Okafor/gi) ?? []).length;
  assert.equal(occurrences, 1, 'Hannah Okafor should appear exactly once as a provider card, not three times under three different spellings');
});

test('an hours row whose label is not a day or schedule at all (clinic-info padding, the sparse-vet bug) is never treated as a real hour', () => {
  const hoursIndex = SECTIONS.findIndex((section) => section.type === 'hours-location');
  const recipe = clone();
  recipe.sections[hoursIndex].text.address = null;
  recipe.sections[hoursIndex].text.phone = null;
  recipe.sections[hoursIndex].items = [
    { label: 'Patients', value: 'Dogs and cats' },
    { label: 'Care', value: 'Dr. Hannah Okafor, DVM' },
  ];
  const { html } = compile(recipe);
  // No address/phone and no row that reads as an actual hour: the section (and its nav link)
  // renders nothing at all, the same as if the brief had stated no hours whatsoever.
  assert.ok(!html.includes(`id="${SECTIONS[hoursIndex]!.id}"`), 'a section with no real hours renders nothing, even with non-empty-looking item text');
  assert.ok(!html.includes('Patients'), 'the off-topic "row" text never leaks onto the page as if it were an hour');
});

test('an hours row whose label merely CONTAINS a day fragment inside an unrelated word, or names a generic state with no day at all, is never treated as a real hour (round-3 Grok audit: "Open" and "Birthday" wrongly passed an un-anchored substring test)', () => {
  const hoursIndex = SECTIONS.findIndex((section) => section.type === 'hours-location');
  const recipe = clone();
  recipe.sections[hoursIndex].text.address = null;
  recipe.sections[hoursIndex].text.phone = null;
  recipe.sections[hoursIndex].items = [
    { label: 'Open', value: '8am-5pm' },
    { label: 'Birthday', value: 'March 3rd' },
  ];
  const { html } = compile(recipe);
  assert.ok(!html.includes(`id="${SECTIONS[hoursIndex]!.id}"`), 'neither row names a real day or day-range, so the section renders nothing');
  assert.ok(!html.includes('8am-5pm'), '"Open" alone is a state, not a day or a day-range, and is not kept just because it contains "open"');
  assert.ok(!html.includes('March 3rd'), '"Birthday" contains the fragment "day" but is not itself a day token');
});

test('an hours row whose value MIXES real schedule info with a hedge aside keeps its real hours, rather than being dropped entirely (round-3 Grok audit: "call for" inside an otherwise real value used to drop the whole row)', () => {
  const hoursIndex = SECTIONS.findIndex((section) => section.type === 'hours-location');
  const recipe = clone();
  recipe.sections[hoursIndex].text.address = null;
  recipe.sections[hoursIndex].text.phone = null;
  recipe.sections[hoursIndex].items = [
    { label: 'Mon-Fri', value: '8am-5pm, call for holiday hours' },
  ];
  const { html } = compile(recipe);
  assert.ok(html.includes(`id="${SECTIONS[hoursIndex]!.id}"`), 'the row has real schedule info (a digit-bearing time range), so it is kept and the section renders');
  assert.ok(html.includes('8am-5pm, call for holiday hours'), 'the whole value renders as written — the real hours are not stripped out along with the hedge aside');
});

test('an hours-and-location section left with only placeholder rows and no address or phone renders nothing, and drops its own nav link too', () => {
  const hoursIndex = SECTIONS.findIndex((section) => section.type === 'hours-location');
  const recipe = clone();
  recipe.sections[hoursIndex].text.address = null;
  recipe.sections[hoursIndex].text.phone = null;
  // A fill under pressure to satisfy a kept-but-evidence-free section writes an "unknown"
  // placeholder rather than a real hour; `min: 0` means it never has to, but the render module
  // defends against it anyway (see UNKNOWN_ROW in render.ts).
  recipe.sections[hoursIndex].items = [
    { label: 'Hours', value: 'Not published online' },
    { label: 'Address', value: 'Unknown' },
    { label: 'Booking', value: 'Call to book a visit' },
  ];
  const { html } = compile(recipe);
  assert.ok(!html.includes(`id="${SECTIONS[hoursIndex]!.id}"`), 'no section wrapper');
  assert.ok(!html.includes('Not published online'), 'no placeholder row text anywhere');
  assert.ok(!html.includes('Call to book a visit'), 'no hedging "call to book" row masquerading as a fact');
  assert.ok(!html.includes(`href="#${SECTIONS[hoursIndex]!.id}"`), 'no header or footer nav link to the now-empty section');
});

test('an hours-and-location section keeps its real rows and drops only the placeholder ones', () => {
  const hoursIndex = SECTIONS.findIndex((section) => section.type === 'hours-location');
  const recipe = clone();
  recipe.sections[hoursIndex].items = [
    { label: 'Mon-Fri', value: '8:00am - 5:00pm' },
    { label: 'Weekend', value: 'Not published online' },
  ];
  const { html } = compile(recipe);
  assert.ok(html.includes(`id="${SECTIONS[hoursIndex]!.id}"`), 'the section still renders: it has a real row and a real phone/address');
  assert.ok(html.includes('data-od-id="practice-hours-location--items-0--value">8:00am - 5:00pm<'), 'the real row renders');
  assert.ok(!html.includes('Not published online'), 'the placeholder row is dropped, not just its label reworded');
});

test('an hours-and-location section with only a phone number (no real hours, no address) renders nothing at all', () => {
  // A phone number is not an hour and not a location; it is already shown in the footer, the
  // hero trust panel and the book CTA. A section titled "Hours & location" that shows only a
  // phone answers a question nobody asked under a heading that promises something it lacks.
  const hoursIndex = SECTIONS.findIndex((section) => section.type === 'hours-location');
  const recipe = clone();
  recipe.sections[hoursIndex].text.address = null;
  recipe.sections[hoursIndex].items = [];
  const { html } = compile(recipe);
  assert.ok(!html.includes(`id="${SECTIONS[hoursIndex]!.id}"`), 'the section renders nothing when its only fact is a phone number');
  assert.ok(!html.includes(`href="#${SECTIONS[hoursIndex]!.id}"`), 'its header and footer nav links are both dropped along with it');
  // The footer's own nav must make the same call the header nav does: a link to a section that
  // renders nothing is a dishonest link (an anchor to an id the page never actually emits).
  assert.deepEqual(dishonestLinks(html), [], 'the footer nav never links to the dropped hours-location section either');
});

test('the hero trust panel is dropped when its only fact is the same phone number the book CTA already calls', () => {
  const hoursIndex = SECTIONS.findIndex((section) => section.type === 'hours-location');
  const footerIndex = SECTIONS.findIndex((section) => section.type === 'footer');
  const bookIndex = SECTIONS.findIndex((section) => section.type === 'book');
  const recipe = clone();
  recipe.sections[hoursIndex].text.address = null;
  recipe.sections[hoursIndex].text.phone = '(206) 555-0119';
  recipe.sections[footerIndex].text.address = null;
  recipe.sections[footerIndex].text.phone = '(206) 555-0119';
  recipe.sections[footerIndex].text.email = null;
  recipe.sections[bookIndex].text.destination = null;
  const { html } = compile(recipe);
  assert.ok(!html.includes('Call to book</dt>'), 'no trust-panel dt/dd pair repeats the same phone the book CTA already calls');
  assert.ok(html.includes(`href="#${BOOK_SECTION_ID}"`), 'the hero CTA itself is unaffected');
});

test('no distinctive fact is restated verbatim across two different sections of the reference fixture', () => {
  // A hygiene canary for the repetition review flagged: section intros and bodies should not
  // restate a fact ("since 2009", a provider's full name and title) that another section already
  // states. Short, generic phrases are exempt (min length 25) and list-item fields are exempt
  // (a provider's own name legitimately appears once in its own card and nowhere else already).
  const MIN_LEN = 25;
  // Contact facts (address/phone/email/destination) are atoms that legitimately appear in more
  // than one section by design (hours-location and the footer both show them; the book CTA falls
  // back to them) — the review's complaint was narrative text restating a fact, not a phone
  // number showing up where a visitor would look for it.
  const CONTACT_FIELDS = new Set(['address', 'phone', 'email', 'destination']);
  const seen = new Map<string, string>();
  const dupes: string[] = [];
  FIXTURE.sections.forEach((section: { id: string; text: Record<string, unknown> } | null) => {
    if (!section) return;
    for (const [field, value] of Object.entries(section.text)) {
      if (typeof value !== 'string' || value.length < MIN_LEN || CONTACT_FIELDS.has(field)) continue;
      // Sentence-level phrases (split on '. '), not the whole field, so two fields sharing one
      // clause but differing elsewhere still catch a truly repeated sentence.
      for (const sentence of value.split(/(?<=[.!?])\s+/)) {
        if (sentence.length < MIN_LEN) continue;
        const key = sentence.trim().toLowerCase();
        const owner = seen.get(key);
        if (owner && owner !== `${section.id}.${field}`) dupes.push(`"${sentence.trim()}" in both ${owner} and ${section.id}.${field}`);
        else seen.set(key, `${section.id}.${field}`);
      }
    }
  });
  assert.deepEqual(dupes, [], 'the reference fixture repeats a fact verbatim across sections');
});

test('a body/intro restated verbatim in a later section (the sparse-vet repetition bug) renders once, not on every section', () => {
  // The exact defect a sparse-vet build showed: starved of any other fact, the model restated its
  // one distinctive fact ("Dr. Hannah Okafor, DVM, sees every patient") in the hero, services,
  // providers, expect and book copy all at once, ~6 times on one page.
  const REPEATED = "Dr. Hannah Okafor, DVM, sees every patient personally from check-in to discharge.";
  const recipe = clone();
  for (const type of ['hero', 'services', 'providers', 'expect', 'book']) {
    const index = SECTIONS.findIndex((section) => section.type === type);
    recipe.sections[index].text.body = REPEATED;
  }
  const { html } = compile(recipe);
  const occurrences = html.split(REPEATED).length - 1;
  assert.equal(occurrences, 1, `"${REPEATED}" should render exactly once, not restated in every section; got ${occurrences}`);
  // The FIRST section to state a fact (hero, which renders before every other section this test
  // touches) keeps its own body slot; a LATER section restating the same fact renders no body
  // slot at all — never a duplicate, never an empty-but-present element.
  assert.ok(html.includes('data-od-id="practice-hero--body"'), 'the first section to state the fact keeps its own body slot');
  for (const type of ['services', 'providers', 'expect', 'book']) {
    const index = SECTIONS.findIndex((section) => section.type === type);
    assert.ok(!html.includes(`data-od-id="${SECTIONS[index]!.id}--body"`), `${type}: a body restating an earlier section's fact renders no body slot`);
  }
});

test('a sparse brief that drops every optional section and every nullable atom invents nothing', () => {
  const recipe = clone();
  const list = atoms();
  const originals = list.map((atom) => {
    const section = FIXTURE.sections[atom.index];
    return String(atom.item === undefined ? section.text[atom.name] : section.items[atom.item][atom.name]);
  });
  const optional = SECTIONS.filter((section) => section.optional);
  const droppedIndexes = optional.map((section) => SECTIONS.indexOf(section));
  const FACT_FIELDS = ['quote', 'name', 'detail', 'price', 'question', 'answer', 'label', 'value'];
  const sectionValues = droppedIndexes.flatMap((index) => (FIXTURE.sections[index].items as Record<string, string>[] | undefined ?? [])
    .flatMap((item) => FACT_FIELDS.filter((name) => name in item && item[name] !== null).map((name) => item[name]!)));
  for (const atom of list) setAtom(recipe, atom, null);
  for (const index of droppedIndexes) recipe.sections[index] = null;

  const { recipe: parsed, html } = compile(recipe);
  assert.deepEqual(droppedIndexes.map((index) => parsed.sections[index]), droppedIndexes.map(() => null));
  assert.deepEqual(Object.keys(PRACTICE_NULLABLE_ATOMS).sort(), [...new Set(list.map((atom) => SECTIONS[atom.index]!.id))].sort());
  const text = html.replace(/<style>[\s\S]*?<\/style>/, '');
  for (const value of [...originals, ...sectionValues]) {
    const shown = value.length <= 4 ? new RegExp(`>${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}<`).test(text) : text.includes(value);
    assert.ok(!shown, `the page still shows "${value}"`);
  }
  const faqId = SECTIONS[SECTIONS.findIndex((section) => section.type === 'faq')]!.id;
  const hoursId = SECTIONS[SECTIONS.findIndex((section) => section.type === 'hours-location')]!.id;
  assert.ok(!text.includes(`href="#${faqId}"`), 'no header or footer nav link to the dropped FAQ');
  assert.ok(!text.includes(`href="#${hoursId}"`), 'no header or footer nav link to the dropped hours & location');
  const omitted = SECTIONS.filter((section) => !text.includes(`id="${section.id}"`)).map((section) => section.type);
  assert.deepEqual(new Set(omitted), PRACTICE_OPTIONAL_SECTIONS);
});
