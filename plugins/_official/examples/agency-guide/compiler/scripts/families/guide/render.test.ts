/**
 * guide family render tests.
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
import { isPlanUrl, recipeSchema } from './contract.ts';
import { dishonestLinks } from '../../sections.ts';
import {
  findGuideTextSlot, getGuideAssetRequirements, listGuideTextSlots,
  renderGuide, validateGuideRecipe,
} from './render.ts';
import {
  FAMILY_ID, GUIDE_BLOCKS, GUIDE_NULLABLE_ATOMS, GUIDE_OPTIONAL_SECTIONS, PRACTICAL_FACTS_SECTION_ID,
  SECTIONS, SECTION_ORDER, type FieldSpec,
} from './slots.ts';

const HERE = import.meta.dirname;
const KIT = path.join(HERE, '../../../../../../shared/ui-kits/hyperui');
const FIXTURE = JSON.parse(readFileSync(path.join(HERE, 'reference.fixture.json'), 'utf8'));
const clone = () => structuredClone(FIXTURE);
/** The first plain (not nullable) text field of section 1 (masthead), for the refusal cases. */
const PLAIN = SECTIONS[1]!.text.find((field) => !field.atom)!;

function compile(recipeInput: unknown) {
  const recipe = validateGuideRecipe(recipeInput);
  assert.deepEqual(getGuideAssetRequirements(recipe), [], 'no image, font or video assets');
  const html = renderGuide(recipe, {});
  return { recipe, html };
}
function refusal(recipeInput: unknown): string {
  try { compile(recipeInput); } catch (error) { return error instanceof Error ? error.message : String(error); }
  throw new Error('expected a refusal, the compiler accepted the recipe');
}

function fieldIds(prefix: string, field: FieldSpec): string[] {
  return [`${prefix}--${field.name}`];
}
/** Every slot id `recipe` renders, in document order, from slots.ts's own field roster. A nullable
 * atom (`field.atom`) whose value in `recipe` is `null` renders nothing (see render.ts's `atom`
 * helper) and is skipped. */
function expectedSlotIds(recipe: { brand: Record<string, unknown>; sections: ({ id: string; text: Record<string, unknown>; items?: (Record<string, unknown> | null)[] } | null)[] }): string[] {
  const ids = ['brand--name', 'brand--descriptor'];
  recipe.sections.forEach((recipeSection, index) => {
    if (recipeSection === null) return;
    const section = SECTIONS[index]!;
    for (const field of section.text) if (!field.atom || recipeSection.text[field.name] !== null) ids.push(...fieldIds(section.id, field));
    // A `null` ITEM (practical-facts' own `itemAtom`, see slots.ts's doc) has no field ids at
    // all — its whole row is dropped, not just one leaf.
    (recipeSection.items ?? []).forEach((recipeItem, i) => {
      if (recipeItem === null) return;
      for (const field of section.items!.fields) if (!field.atom || recipeItem[field.name] !== null) ids.push(...fieldIds(`${section.id}--items-${i}`, field));
    });
  });
  return ids;
}
test('the family declares no LEAF nullable atoms among its SECTIONS (brand.descriptor, outside SECTIONS, is the family\'s one leaf nullable atom as of round 4); practical-facts\' one nullable ITEM (a fixed-position row, label and value together) is the only other "unknown fact" case besides array min/max and whole-section optionality', () => {
  const atomFields = SECTIONS.flatMap((section) => [...section.text, ...(section.items?.fields ?? [])]).filter((field) => field.atom);
  assert.deepEqual(atomFields, []);
  // `brand.descriptor` (round 4): traceable when present, nullable when the brief supports no
  // one-sentence synthesis — see `BRAND_SLOTS`'s own doc in slots.ts.
  assert.deepEqual(Object.keys(GUIDE_NULLABLE_ATOMS), ['brand']);
  assert.deepEqual(Object.keys(GUIDE_NULLABLE_ATOMS.brand!), ['descriptor']);
  const practicalFacts = SECTIONS.find((section) => section.id === PRACTICAL_FACTS_SECTION_ID)!;
  assert.ok(typeof practicalFacts.items?.itemAtom === 'string' && practicalFacts.items.itemAtom.length > 0, 'a nullable item kind is declared');
});

test('a valid fixture renders every section in roster order, under the size guard', () => {
  const { html } = compile(clone());
  assert.match(html, /^<!doctype html>/);
  assert.ok(Buffer.byteLength(html, 'utf8') < 200 * 1024, 'under 200 KB');
  const positions = SECTION_ORDER.map((id) => html.indexOf(`id="${id}"`));
  assert.ok(positions.every((at) => at > 0), 'every roster section is present');
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b), 'sections render in roster order');
});

test('the reference fixture has no dishonest links: every href is a real in-page anchor or a real destination', () => {
  const { html } = compile(clone());
  assert.deepEqual(dishonestLinks(html), []);
});

test('every text slot renders exactly once, in the order slots.ts declares', () => {
  const { recipe, html } = compile(clone());
  const ids = listGuideTextSlots(html);
  assert.deepEqual(ids, expectedSlotIds(recipe));
  assert.equal(new Set(ids).size, ids.length, 'data-od-id values are unique');
  assert.equal(findGuideTextSlot(html, 'brand--name'), FIXTURE.brand.name);
  assert.equal(findGuideTextSlot(html, `${SECTIONS[1]!.id}--${PLAIN.name}`), FIXTURE.sections[1].text[PLAIN.name]);
});

test('recipe.schema.json is exactly the schema contract.ts derives from slots.ts', () => {
  const committed = JSON.parse(readFileSync(path.join(HERE, 'recipe.schema.json'), 'utf8'));
  assert.deepEqual(committed, recipeSchema());
});

test('the package default spine is the reference fixture', () => {
  const recipe = JSON.parse(readFileSync(path.join(HERE, `../../../../families/${FAMILY_ID}/recipe.json`), 'utf8'));
  assert.deepEqual(recipe, FIXTURE);
});

test('the header nav labels are FIXED and enumerated, never model text', () => {
  const headerIndex = SECTIONS.findIndex((section) => section.type === 'header');
  const withLinks = clone();
  (withLinks.sections[headerIndex].text as Record<string, unknown>).links = ['Chapters', 'Practical facts', 'Places to see', 'Gallery', 'Plan a visit'];
  assert.match(refusal(withLinks), /sections\[0\]\.text\.links: unknown field/);
  const { html } = compile(clone());
  const headerHtml = html.slice(html.indexOf('<header'), html.indexOf('</header>'));
  for (const label of ['Chapters', 'Practical facts', 'Places to see', 'Gallery', 'Plan a visit']) {
    assert.ok(headerHtml.includes(`>${label}<`), `the header nav shows the fixed label "${label}"`);
  }
});

test('every class the page uses has a rule in the compiled css/guide.css', () => {
  const pageKinds = JSON.parse(readFileSync(path.join(KIT, 'pagekinds.json'), 'utf8')) as Record<string, string[]>;
  assert.deepEqual(pageKinds[FAMILY_ID], [...GUIDE_BLOCKS], 'pagekinds.json lists the blocks slots.ts names');
  const classesIn = (html: string) => new Set([...html.replaceAll('&amp;', '&').matchAll(/\sclass="([^"]*)"/g)].flatMap((match) => match[1]!.split(/\s+/).filter(Boolean)));
  const css = readFileSync(path.join(HERE, '../../catalog/hyperui/guide.css'), 'utf8');
  const known = new Set([...css.matchAll(/\.((?:\\.|[a-zA-Z0-9_-])+)/g)].map((match) => match[1]!.replace(/\\(.)/g, '$1')));
  const missing = [...classesIn(compile(clone()).html)].filter((token) => !known.has(token));
  assert.deepEqual(missing, [], 'classes css/guide.css does not carry a rule for');
});

test('the page actually inlines its OWN compiled stylesheet, never another page kind\'s', () => {
  const catalog = JSON.parse(readFileSync(path.join(HERE, '../../catalog/CATALOG.json'), 'utf8')) as { files: { path: string; source: string }[] };
  const cssEntry = catalog.files.find((file) => file.path === 'hyperui/guide.css');
  assert.ok(cssEntry, 'CATALOG.json names a hyperui/guide.css entry');
  assert.equal(cssEntry!.source, 'plugins/_official/shared/ui-kits/hyperui/css/guide.css', 'the entry points at guide\'s own build, not another page kind\'s');
  const guideCss = readFileSync(path.join(HERE, '../../catalog/hyperui/guide.css'), 'utf8');
  const { html } = compile(clone());
  const styleMatch = /<style>([\s\S]*?)<\/style>/.exec(html);
  assert.ok(styleMatch, 'the page has an inline <style> block');
  assert.equal(styleMatch![1], guideCss, 'the inlined stylesheet is exactly this family\'s own compiled css/guide.css');
});

test('each optional section drops to null and renders nothing, nor its nav link; a null elsewhere is refused', () => {
  const optional = SECTIONS.filter((section) => section.optional);
  assert.deepEqual([...GUIDE_OPTIONAL_SECTIONS], optional.map((section) => section.type));
  assert.deepEqual(optional.map((section) => section.type), ['practical-facts', 'places-to-see', 'gallery', 'plan-a-visit']);
  for (const section of optional) {
    const index = SECTIONS.indexOf(section);
    const dropped = clone();
    dropped.sections[index] = null;
    const { html } = compile(dropped);
    assert.ok(!html.includes(`id="${section.id}"`), `${section.id}: no section wrapper`);
    assert.ok(!html.includes(`data-od-id="${section.id}`), `${section.id}: no edit targets`);
    assert.ok(!html.includes(`href="#${section.id}"`), `${section.id}: no header or footer nav link to a dropped section`);
    assert.deepEqual(listGuideTextSlots(html), expectedSlotIds(dropped).filter((id) => !id.startsWith(`${section.id}--`)));
  }
  const required = clone();
  required.sections[0] = null;
  assert.match(refusal(required), /sections\[0\]: expected a plain object/);
});

test('a null anywhere a slot is not nullable is refused, naming the field', () => {
  const plain = clone();
  plain.sections[1].text[PLAIN.name] = null;
  assert.match(refusal(plain), new RegExp(`sections\\[1\\]\\.text\\.${PLAIN.name}: expected plain text`));
  const planIndex = SECTIONS.findIndex((section) => section.type === 'plan-a-visit');
  const nullUrl = clone();
  nullUrl.sections[planIndex].text.url = null;
  assert.match(refusal(nullUrl), /sections\[7\]\.text\.url: expected plain text/, 'url is required whenever the section is present — a brief with no URL drops the whole section instead (see the optional-section test above)');
});

test('the plan-a-visit url renders verbatim as the honest https link, never a guessed or rewritten scheme', () => {
  const recipe = clone();
  const planIndex = SECTIONS.findIndex((section) => section.type === 'plan-a-visit');
  recipe.sections[planIndex].text.url = 'https://visit.example.com/plan';
  const { html } = compile(recipe);
  assert.match(html, /<a href="https:\/\/visit\.example\.com\/plan"[^>]*data-od-id="guide-plan-a-visit--cta">/);
});

test('a plan-a-visit url that is not a well-formed https(s) URL is refused, never coerced into a link', () => {
  const planIndex = SECTIONS.findIndex((section) => section.type === 'plan-a-visit');
  const cases: [string, string][] = [
    ['visit.example.com/plan', 'scheme-less URL (no http:// or https://)'],
    ['Plan your visit today', 'prose, not a destination at all'],
    ['ask @ the info desk', 'a stray @ that is not a URL'],
  ];
  for (const [url, why] of cases) {
    const recipe = clone();
    recipe.sections[planIndex].text.url = url;
    assert.match(refusal(recipe), /expected a URL/, why);
  }
});

test('plan URL validation accepts well-formed http(s) URLs and refuses scheme-less or malformed ones', () => {
  for (const ok of ['https://example.com', 'http://a.example.com/path?x=1', 'https://visit.windwardpoint.example']) assert.ok(isPlanUrl(ok), ok);
  for (const bad of ['example.com', 'not a url', 'ftp://example.com']) assert.ok(!isPlanUrl(bad), bad);
});

test('no <script appears anywhere, and CSP forbids it', () => {
  const { html } = compile(clone());
  assert.ok(!html.includes('<script'), 'no script tag');
  assert.match(html, /script-src 'none'/);
  assert.match(html, /form-action 'none'/);
  assert.match(html, /img-src 'none'/);
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
      // Push copies until the array actually exceeds `count`: the fixture may carry fewer than
      // `count` items (a sparse, honest guide never pads to the maximum), so a single push is not
      // always enough to cross the ceiling.
      while (over.sections[index].items.length <= count) over.sections[index].items.push(structuredClone(over.sections[index].items[0]));
      assert.match(
        refusal(over),
        min === count
          ? new RegExp(`sections\\[${index}\\]\\.items: expected exactly ${count} items`)
          : new RegExp(`sections\\[${index}\\]\\.items: expected ${min} to ${count} items`),
        `${section.id}: above count is refused`,
      );
    }
  });
});

test('a section with fewer than the maximum items renders exactly that many cards, never padded with invented or borrowed content', () => {
  const chapterIndex = SECTIONS.findIndex((section) => section.type === 'chapter-list');
  const recipe = clone();
  recipe.sections[chapterIndex].items = recipe.sections[chapterIndex].items.slice(0, 2);
  const { html } = compile(recipe);
  assert.ok(html.includes('data-od-id="guide-chapter-list--items-0--title"'), 'the first real chapter renders');
  assert.ok(html.includes('data-od-id="guide-chapter-list--items-1--title"'), 'the second real chapter renders');
  assert.ok(!html.includes('data-od-id="guide-chapter-list--items-2--title"'), 'no third, padded chapter card');
  for (const dropped of [FIXTURE.sections[chapterIndex].items[2], FIXTURE.sections[chapterIndex].items[3]]) {
    assert.ok(!html.includes(dropped.title), `${dropped.title}: the dropped chapter's own title does not leak elsewhere`);
  }
});

test('a sparse brief with only ONE further chapter (chapter-list at its contract minimum), no practical facts, no places, no gallery and no plan-a-visit still renders correctly, never padded to look like more', () => {
  const recipe = clone();
  const chapterIndex = SECTIONS.findIndex((section) => section.type === 'chapter-list');
  recipe.sections[chapterIndex].items = recipe.sections[chapterIndex].items.slice(0, 1);
  for (const type of ['practical-facts', 'places-to-see', 'gallery', 'plan-a-visit']) {
    const index = SECTIONS.findIndex((section) => section.type === type);
    recipe.sections[index] = null;
  }
  const { html } = compile(recipe);
  assert.ok(html.includes('data-od-id="guide-chapter-list--items-0--title"'), 'the one real further chapter renders');
  assert.ok(!html.includes('data-od-id="guide-chapter-list--items-1--title"'), 'no fabricated second chapter');
  for (const type of ['practical-facts', 'places-to-see', 'gallery', 'plan-a-visit']) {
    const index = SECTIONS.findIndex((section) => section.type === type);
    assert.ok(!html.includes(`id="${SECTIONS[index]!.id}"`), `${type}: dropped entirely`);
  }
  assert.deepEqual(dishonestLinks(html), []);
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

test('no distinctive fact is restated verbatim across two different sections of the reference fixture', () => {
  const MIN_LEN = 25;
  const CONTACT_FIELDS = new Set(['url']);
  const seen = new Map<string, string>();
  const dupes: string[] = [];
  FIXTURE.sections.forEach((section: { id: string; text: Record<string, unknown> } | null) => {
    if (!section) return;
    for (const [field, value] of Object.entries(section.text)) {
      if (typeof value !== 'string' || value.length < MIN_LEN || CONTACT_FIELDS.has(field)) continue;
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

test('a sparse brief that drops every optional section invents nothing', () => {
  const recipe = clone();
  const optional = SECTIONS.filter((section) => section.optional);
  const droppedIndexes = optional.map((section) => SECTIONS.indexOf(section));
  // Only `practical-facts`' own label/value rows are facts EXCLUSIVE to an optional section in
  // this fixture: `places-to-see` and `gallery` deliberately reuse the same named places the
  // required, undroppable `chapter-list` already names (the brief's own design — see slots.ts's
  // own doc on the gallery section), so their values legitimately still appear on a page that
  // kept its chapters. Checking those would flag honest reuse as if it were a leak.
  const practicalFactsIndex = SECTIONS.findIndex((section) => section.type === 'practical-facts');
  const originals = (FIXTURE.sections[practicalFactsIndex].items as Record<string, string>[])
    .flatMap((item) => [item.label!, item.value!]);
  for (const index of droppedIndexes) recipe.sections[index] = null;
  // chapter-list's own contract floor is min: 1; this test keeps 2 items to exercise a still-
  // populated section alongside the sections being dropped, not because the floor requires it.
  const chapterIndex = SECTIONS.findIndex((section) => section.type === 'chapter-list');
  recipe.sections[chapterIndex].items = recipe.sections[chapterIndex].items.slice(0, 2);

  const { recipe: parsed, html } = compile(recipe);
  assert.deepEqual(droppedIndexes.map((index) => parsed.sections[index]), droppedIndexes.map(() => null));
  const text = html.replace(/<style>[\s\S]*?<\/style>/, '');
  for (const value of originals) assert.ok(!text.includes(value), `the page still shows "${value}"`);
  const omitted = SECTIONS.filter((section) => !text.includes(`id="${section.id}"`)).map((section) => section.type);
  assert.deepEqual(new Set(omitted), GUIDE_OPTIONAL_SECTIONS);
});

test('practical-facts: a brief supporting only SOME categories renders only those rows, at their fixed positions — the round-4 fix', () => {
  const recipe = clone();
  const practicalFactsIndex = SECTIONS.findIndex((section) => section.type === 'practical-facts');
  const items = recipe.sections[practicalFactsIndex].items;
  // The brief supports "getting there" (index 0) and "language" (index 3) only — currency and
  // best time to visit (indexes 1 and 2) are unstated and must be OMITTED, never guessed.
  items[1] = null;
  items[2] = null;
  const { html } = compile(recipe);
  assert.ok(html.includes('data-od-id="guide-practical-facts--items-0--label"'), 'row 0 (getting there) present');
  assert.ok(html.includes('data-od-id="guide-practical-facts--items-3--label"'), 'row 3 (language) present');
  assert.ok(!html.includes('data-od-id="guide-practical-facts--items-1--label"'), 'row 1 (best time) omitted, never guessed');
  assert.ok(!html.includes('data-od-id="guide-practical-facts--items-2--label"'), 'row 2 (currency) omitted, never guessed');
  assert.ok(html.includes('id="guide-practical-facts"'), 'the section itself still renders: at least one row survives');
  assert.deepEqual(dishonestLinks(html), []);
});

test('practical-facts: a brief with no real practical fact at all (every row null) drops the whole section, not four empty rows', () => {
  const recipe = clone();
  const practicalFactsIndex = SECTIONS.findIndex((section) => section.type === 'practical-facts');
  const items = recipe.sections[practicalFactsIndex].items;
  for (let i = 0; i < items.length; i += 1) items[i] = null;
  const { html } = compile(recipe);
  assert.ok(!html.includes('id="guide-practical-facts"'), 'the whole section is dropped');
  assert.ok(!html.includes('Practical facts'), 'its nav link is dropped too');
});

test('practical-facts: a present row whose label does not match its fixed category at that index is refused, never silently accepted', () => {
  const recipe = clone();
  const practicalFactsIndex = SECTIONS.findIndex((section) => section.type === 'practical-facts');
  recipe.sections[practicalFactsIndex].items[0].label = 'Around the crossing';
  assert.match(refusal(recipe), /sections\[\d+\]\.items\[0\]\.label: expected "Getting there"/);
});

test('brand.descriptor: a brief that supports no one-sentence synthesis renders with it dropped entirely, not guessed or left over-general', () => {
  const recipe = clone();
  recipe.brand.descriptor = null;
  const { recipe: parsed, html } = compile(recipe);
  assert.equal(parsed.brand.descriptor, null);
  assert.ok(!html.includes('data-od-id="brand--descriptor"'), 'the sr-only descriptor slot is omitted entirely, not rendered empty');
  assert.ok(!html.includes('<meta name="description"'), 'the <meta name="description"> tag is omitted too, never emitted with empty content');
  // Nothing else about the page is disturbed: `brand.name` still renders, and the page still
  // validates and stays under budget.
  assert.ok(html.includes(`data-od-id="brand--name">${parsed.brand.name}<`));
  assert.deepEqual(dishonestLinks(html), []);
});

test('brand.descriptor: null is refused when the field carries markup, a control character, or is over its own limit — the SAME plainText() checks any present atom value gets', () => {
  const tooLong = clone();
  tooLong.brand.descriptor = 'x'.repeat(201);
  assert.match(refusal(tooLong), /recipe\.brand\.descriptor: at most 200 characters/);
  const markup = clone();
  markup.brand.descriptor = 'A <b>bold</b> claim about the town.';
  assert.match(refusal(markup), /recipe\.brand\.descriptor: markup is not allowed/);
});
