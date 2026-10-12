/**
 * marketing-site family render tests.
 * Run: node --experimental-strip-types --test render.test.ts
 *
 * Drives the family module directly (validate, render, slot lookup), the same surface the
 * compiler's `families/registry.ts` dispatches through. A refusal here is the refusal a
 * marketing-site package compiler gives.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { dishonestLinks } from '../../sections.ts';
import { renderAgencySite } from '../../render.ts';
import { FAMILIES } from '../registry.ts';
import {
  findMarketingSiteTextSlot, getMarketingSiteAssetRequirements, listMarketingSiteTextSlots,
  renderMarketingSite, validateMarketingSiteRecipe,
} from './render.ts';
import {
  CTA_SECTION_ID, CTA_SLOTS,
  FEATURES_SECTION_ID, FEATURES_TEXT_SLOTS, FEATURE_COUNT, FEATURE_ITEM_SLOTS,
  FOOTER_COLUMN_COUNT, FOOTER_COLUMN_HEADING_SLOT, FOOTER_LINK_COUNT, FOOTER_LINK_SLOT,
  FOOTER_SECTION_ID, FOOTER_TEXT_SLOTS,
  HERO_SECTION_ID, HERO_SLOTS,
  PRICING_FEATURE_COUNT, PRICING_FEATURE_SLOT, PRICING_SECTION_ID, PRICING_TEXT_SLOTS,
  PRICING_TIER_COUNT, PRICING_TIER_SLOTS,
  PROOF_SECTION_ID,
  SECTION_ORDER,
  TESTIMONIAL_COUNT, TESTIMONIAL_SLOTS,
  MARKETING_SITE_MOCK_SLOTS, MARKETING_SITE_NULLABLE_ATOMS, MARKETING_SITE_OPTIONAL_SECTIONS, ILLUSTRATIVE_PRICING_CAPTION,
} from './slots.ts';

const HERE = import.meta.dirname;
const FIXTURE = JSON.parse(readFileSync(path.join(HERE, 'reference.fixture.json'), 'utf8'));
const clone = () => structuredClone(FIXTURE);

function compile(recipeInput: unknown) {
  const recipe = validateMarketingSiteRecipe(recipeInput);
  assert.deepEqual(getMarketingSiteAssetRequirements(recipe), [], 'no image, font or video assets');
  const html = renderMarketingSite(recipe, {});
  return { recipe, html };
}
function refusal(recipeInput: unknown): string {
  try { compile(recipeInput); } catch (error) { return error instanceof Error ? error.message : String(error); }
  throw new Error('expected a refusal, the compiler accepted the recipe');
}

/** The full slot roster the reference fixture renders, in document order — independent of
 * render.ts's own id-building code, so a drift between the two fails this test. */
function expectedSlotIds(): string[] {
  const ids: string[] = [];
  ids.push('brand--name', 'brand--descriptor');
  for (const slot of HERO_SLOTS) ids.push(`${HERO_SECTION_ID}--${slot.name}`);
  for (const slot of FEATURES_TEXT_SLOTS) ids.push(`${FEATURES_SECTION_ID}--${slot.name}`);
  for (let i = 0; i < FEATURE_COUNT; i++) for (const slot of FEATURE_ITEM_SLOTS) ids.push(`${FEATURES_SECTION_ID}--items-${i}--${slot.name}`);
  for (let i = 0; i < TESTIMONIAL_COUNT; i++) for (const slot of TESTIMONIAL_SLOTS) ids.push(`${PROOF_SECTION_ID}--items-${i}--${slot.name}`);
  for (const slot of PRICING_TEXT_SLOTS) ids.push(`${PRICING_SECTION_ID}--${slot.name}`);
  for (let i = 0; i < PRICING_TIER_COUNT; i++) {
    // Document order follows the rendered card: name, price, the feature list, then the cta
    // button at the bottom — not PRICING_TIER_SLOTS's declaration order.
    for (const slot of PRICING_TIER_SLOTS) if (slot.name !== 'cta') ids.push(`${PRICING_SECTION_ID}--items-${i}--${slot.name}`);
    for (let j = 0; j < PRICING_FEATURE_COUNT; j++) ids.push(`${PRICING_SECTION_ID}--items-${i}--${PRICING_FEATURE_SLOT.name}-${j}`);
    ids.push(`${PRICING_SECTION_ID}--items-${i}--cta`);
  }
  for (const slot of CTA_SLOTS) ids.push(`${CTA_SECTION_ID}--${slot.name}`);
  for (const slot of FOOTER_TEXT_SLOTS) ids.push(`${FOOTER_SECTION_ID}--${slot.name}`);
  for (let i = 0; i < FOOTER_COLUMN_COUNT; i++) {
    ids.push(`${FOOTER_SECTION_ID}--columns-${i}--${FOOTER_COLUMN_HEADING_SLOT.name}`);
    for (let j = 0; j < FOOTER_LINK_COUNT; j++) ids.push(`${FOOTER_SECTION_ID}--columns-${i}--${FOOTER_LINK_SLOT.name}-${j}`);
  }
  return ids;
}

test('a valid fixture renders every section in roster order, under the size guard', () => {
  const { html } = compile(clone());
  assert.match(html, /^<!doctype html>/);
  assert.ok(Buffer.byteLength(html, 'utf8') < 200 * 1024, 'under 200 KB');
  const positions = SECTION_ORDER.map((id) => html.indexOf(`id="${id}"`));
  assert.ok(positions.every((at) => at > 0), 'every roster section is present');
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b), 'sections render in roster order');
});

test('every text slot in the fixture renders exactly once, and the roster is 59 slots', () => {
  const { html } = compile(clone());
  const ids = listMarketingSiteTextSlots(html);
  assert.deepEqual(ids, expectedSlotIds(), 'the rendered slot roster matches slots.ts field for field, in document order');
  assert.equal(new Set(ids).size, ids.length, 'data-od-id values are unique');
  assert.ok(ids.length >= 40 && ids.length <= 60, `expected 40 to 60 slots, found ${ids.length}`);
  assert.equal(ids.length, 59, 'the fully populated reference fixture renders the full roster');
  assert.equal(findMarketingSiteTextSlot(html, `${FEATURES_SECTION_ID}--items-1--title`), 'One-click invoicing');
  assert.equal(findMarketingSiteTextSlot(html, 'brand--name'), 'Ledgerline');
  assert.equal(findMarketingSiteTextSlot(html, 'brand--descriptor'), 'Bookkeeping software for small service firms that bill by the hour.');
});

test('a null proof section and a null pricing section drop their whole section, not an empty frame', () => {
  const nulled = clone();
  nulled.sections[2].items = null;
  nulled.sections[3].items = null;
  const { html } = compile(nulled);
  assert.ok(!html.includes(`id="${PROOF_SECTION_ID}"`), 'no proof section wrapper');
  assert.ok(!html.includes(`id="${PRICING_SECTION_ID}"`), 'no pricing section wrapper');
  const ids = listMarketingSiteTextSlots(html);
  const proofSlots = TESTIMONIAL_COUNT * TESTIMONIAL_SLOTS.length;
  const pricingSlots = PRICING_TEXT_SLOTS.length + PRICING_TIER_COUNT * (PRICING_TIER_SLOTS.length + PRICING_FEATURE_COUNT);
  assert.equal(ids.length, expectedSlotIds().length - proofSlots - pricingSlots, 'proof and pricing slots are gone, everything else stays');
});

test('a null proof section (sections[2] itself, not just its items) drops the whole section', () => {
  const nulled = clone();
  nulled.sections[2] = null;
  const { html } = compile(nulled);
  assert.ok(!html.includes(`id="${PROOF_SECTION_ID}"`), 'no proof section wrapper');
  assert.ok(!html.includes(`data-od-id="${PROOF_SECTION_ID}`), 'no proof edit targets');
  const ids = listMarketingSiteTextSlots(html);
  const proofSlots = TESTIMONIAL_COUNT * TESTIMONIAL_SLOTS.length;
  assert.equal(ids.length, expectedSlotIds().length - proofSlots, 'proof slots are gone, everything else stays');
  const required = clone();
  required.sections[0] = null;
  assert.match(refusal(required), /sections\[0\]: expected a plain object/, 'a null in a non-optional slot is still refused');
});

test('no <script appears anywhere, and CSP forbids it', () => {
  const { html } = compile(clone());
  assert.ok(!html.includes('<script'), 'no script tag');
  assert.match(html, /script-src 'none'/);
});

const CATALOG_DIR = path.join(HERE, '../../catalog/components');

test('the hero card is the catalog glass-surface and its eyebrow the catalog shiny-text, CSS-only', () => {
  const { html } = compile(clone());
  const hero = html.slice(html.indexOf(`id="${HERO_SECTION_ID}"`), html.indexOf('</section>', html.indexOf(`id="${HERO_SECTION_ID}"`)));
  assert.match(hero, /<div class="genui-glass-surface [^"]*" data-genui="glass-surface" style="--genui-glass-surface-tint:[^"]*">/);
  assert.match(hero, new RegExp(`<p class="genui-shiny-text text-sm font-semibold" data-genui="shiny-text" style="--genui-shiny-text-base:[^"]*" data-od-id="${HERO_SECTION_ID}--eyebrow">`));
  assert.equal(findMarketingSiteTextSlot(html, `${HERO_SECTION_ID}--eyebrow`), FIXTURE.sections[0].text.eyebrow, 'the eyebrow stays an editable slot');
  for (const id of ['glass-surface', 'shiny-text']) {
    const css = readFileSync(path.join(CATALOG_DIR, id, 'styles.css'), 'utf8');
    const inlined = html.match(new RegExp(`<style data-genui-style="${id}">([\\s\\S]*?)</style>`));
    assert.ok(inlined, `${id} CSS is inlined`);
    assert.equal(inlined[1], css, `${id} CSS is the synced copy, verbatim`);
    assert.equal(html.split(`data-genui-style="${id}"`).length - 1, 1, `${id} CSS is inlined once`);
  }
  assert.ok(!html.includes('data-genui-script'), 'no catalog script under script-src none');
});

test('exactly one <style> element carries the inlined HyperUI CSS once', () => {
  const { html } = compile(clone());
  assert.equal((html.match(/<style>/g) ?? []).length, 1);
  assert.match(html, /<style>\/\*! tailwindcss/);
});

test('no unresolved {{ token is left in the output', () => {
  const { html } = compile(clone());
  assert.ok(!html.includes('{{'), 'no unresolved template token');
});

test('an unknown field is refused and named', () => {
  const top = clone();
  top.theme = 'dark';
  assert.match(refusal(top), /recipe\.theme: unknown field/);
  const inner = clone();
  inner.sections[0].text.subhead = 'not a slot';
  assert.match(refusal(inner), /sections\[0\]\.text\.subhead: unknown field/);
});

test('markup in a plain-text slot is refused', () => {
  const tag = clone();
  tag.sections[0].text.body = 'Prefers async <script>alert(1)</script>';
  assert.match(refusal(tag), /sections\[0\]\.text\.body: markup is not allowed/);
  const long = clone();
  long.sections[0].text.heading = 'x'.repeat(61);
  assert.match(refusal(long), /sections\[0\]\.text\.heading: at most 60 characters/);
});

test('the fixed repeat counts are enforced', () => {
  const shortFeatures = clone();
  shortFeatures.sections[1].items.pop();
  assert.match(refusal(shortFeatures), /sections\[1\]\.items: expected exactly 3 items/);
  const shortProof = clone();
  shortProof.sections[2].items.pop();
  assert.match(refusal(shortProof), /sections\[2\]\.items: expected exactly 3 items, or null/);
  const shortTiers = clone();
  shortTiers.sections[3].items.pop();
  assert.match(refusal(shortTiers), /sections\[3\]\.items: expected exactly 3 items, or null/);
  const shortTierFeatures = clone();
  shortTierFeatures.sections[3].items[0].features.pop();
  assert.match(refusal(shortTierFeatures), /sections\[3\]\.items\[0\]\.features: expected exactly 3 items/);
  const shortColumns = clone();
  shortColumns.sections[5].items.columns.pop();
  assert.match(refusal(shortColumns), /sections\[5\]\.items\.columns: expected exactly 3 items/);
  const shortLinks = clone();
  shortLinks.sections[5].items.columns[0].links.pop();
  assert.match(refusal(shortLinks), /sections\[5\]\.items\.columns\[0\]\.links: expected exactly 3 items/);
});

test('the section roster and its order are enforced', () => {
  const renamed = clone();
  renamed.sections[0].id = 'marketing-site-not-hero';
  assert.match(refusal(renamed), /sections\[0\]\.id: expected "marketing-site-hero"/);
  const swapped = clone();
  [swapped.sections[0], swapped.sections[1]] = [swapped.sections[1], swapped.sections[0]];
  assert.throws(() => compile(swapped), /unknown field|expected "marketing-site/, 'a shape or id mismatch is refused either way');
  const dropped = clone();
  dropped.sections.pop();
  assert.match(refusal(dropped), /recipe\.sections: expected exactly 6 sections/);
});

test('a bad revision or schema version is refused', () => {
  const revision = clone();
  revision.revision = 0;
  assert.match(refusal(revision), /recipe\.revision: expected a positive integer/);
  const version = clone();
  version.schemaVersion = 3;
  assert.match(refusal(version), /recipe\.schemaVersion: expected 2/);
});

// ---------------------------------------------------------------------------
// x-mock: the schema marks match MARKETING_SITE_MOCK_SLOTS, and the page labels every sample section
// ---------------------------------------------------------------------------

type SchemaNode = Record<string, unknown>;
const SCHEMA = JSON.parse(readFileSync(path.join(HERE, 'recipe.schema.json'), 'utf8')) as SchemaNode;

/** Resolve a local `$ref` (sibling keywords kept) and a nullable `oneOf` (its one real branch). */
function resolveNode(node: SchemaNode): SchemaNode {
  let current = node;
  if (typeof current.$ref === 'string') {
    const target = current.$ref.slice(2).split('/').reduce<unknown>((acc, key) => (acc as SchemaNode)[key], SCHEMA) as SchemaNode;
    const { $ref: _ref, ...siblings } = current;
    current = { ...resolveNode(target), ...siblings };
  }
  if (Array.isArray(current.oneOf)) {
    const real = (current.oneOf as SchemaNode[]).map(resolveNode).filter((branch) => branch.type !== 'null');
    const { oneOf: _oneOf, ...wrapper } = current;
    if (real.length === 1) current = { ...real[0], ...wrapper };
  }
  return current;
}

/** Slot names under an `x-mock` mark (inherited downward); an array of strings keeps its own name. */
function markedSlotNames(node: SchemaNode, inherited: boolean, out: Set<string>, name?: string): Set<string> {
  const resolved = resolveNode(node);
  const mock = inherited || resolved['x-mock'] === true;
  const types = ([] as unknown[]).concat(resolved.type);
  if (types.includes('string')) {
    if (mock && name) out.add(name);
    return out;
  }
  for (const [key, child] of Object.entries((resolved.properties ?? {}) as Record<string, SchemaNode>)) markedSlotNames(child, mock, out, key);
  if (resolved.items && typeof resolved.items === 'object') markedSlotNames(resolved.items as SchemaNode, mock, out, name);
  for (const child of (resolved.prefixItems ?? []) as SchemaNode[]) markedSlotNames(child, mock, out, name);
  return out;
}

test('the schema x-mock marks name exactly MARKETING_SITE_MOCK_SLOTS', () => {
  const sections = ((SCHEMA.properties as SchemaNode).sections as SchemaNode).prefixItems as SchemaNode[];
  const marked: Record<string, string[]> = {};
  for (const section of sections) {
    const id = ((section.properties as SchemaNode).id as SchemaNode).const as string;
    const names = [...markedSlotNames(section, false, new Set())].sort();
    if (names.length > 0) marked[id] = names;
  }
  const expected = Object.fromEntries(Object.entries(MARKETING_SITE_MOCK_SLOTS).map(([id, names]) => [id, [...names!].sort()]));
  assert.deepEqual(marked, expected);
  // Nothing outside the sections (brand, metadata) is ever sample data.
  assert.deepEqual([...markedSlotNames(((SCHEMA.properties as SchemaNode).brand as SchemaNode), false, new Set())], []);
});

test('the pricing tiers render under a visible "Illustrative pricing" caption; testimonials carry none', () => {
  const { html } = compile(clone());
  assert.match(html, new RegExp(`id="${PRICING_SECTION_ID}" data-od-mock="illustrative-pricing">`));
  assert.match(html, new RegExp(`data-od-mock="caption">${ILLUSTRATIVE_PRICING_CAPTION}</p>`));
  assert.equal(html.match(/data-od-mock="caption"/g)?.length, 1);
  const recipe = clone();
  recipe.sections[3].items = null;
  assert.equal(compile(recipe).html.includes('data-od-mock'), false, 'no pricing, no caption');
});

test('C16: a site family carries no static-prototype note', () => {
  const { html } = compile(clone());
  assert.doesNotMatch(html, /data-od-output-scope/);
  assert.doesNotMatch(html, /Static prototype/);
});

test('C16: renderFamily supplies the registry scope, and the manifest records that supplied value', () => {
  assert.equal(FAMILIES['marketing-site']!.outputScope, 'site', 'registry row materialised from the family registry pageKind');
  const { html, manifest } = renderAgencySite(clone(), 'marketing-site-r1.html', { version: 1, assets: [] }) as { html: string; manifest: { metadata: { agencySite: { outputScope: string } } } };
  assert.equal(manifest.metadata.agencySite.outputScope, 'site');
  assert.equal(html.split('data-od-output-scope="static-prototype"').length - 1, 0);
});

test('C16: a site family supplied a static-prototype scope is refused, not relabelled', () => {
  const row = FAMILIES['marketing-site']!;
  FAMILIES['marketing-site'] = { ...row, outputScope: 'static-prototype' };
  try {
    assert.throws(() => renderAgencySite(clone(), 'marketing-site-r1.html', { version: 1, assets: [] }), /output scope static-prototype was supplied, but the rendered page carries 0/);
  } finally {
    FAMILIES['marketing-site'] = row;
  }
});

// ---------------------------------------------------------------------------
// Sample-data coverage and unsupported facts
// ---------------------------------------------------------------------------

/** The renderer's own HTML escape, so a value with `&` or a quote is found as rendered. */
const e = (value: string) => value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));

/** Every string in a JSON value. */
function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((item) => strings(item, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((item) => strings(item, out));
  return out;
}

/** The page body, without the inlined CSS in <head>. */
const bodyOf = (html: string) => html.slice(html.indexOf('<body'));

test('the illustrative-pricing caption renders before every pricing tier and covers every mock value', () => {
  const { html } = compile(clone());
  const start = html.indexOf(`id="${PRICING_SECTION_ID}" data-od-mock="illustrative-pricing">`);
  assert.ok(start >= 0, 'the pricing section is marked illustrative');
  const region = html.slice(start, html.indexOf('</section>', start));
  const caption = region.indexOf(`data-od-mock="caption">${ILLUSTRATIVE_PRICING_CAPTION}</p>`);
  assert.ok(caption >= 0, 'the caption is inside the pricing section');
  // Every tier value the schema marks x-mock (MARKETING_SITE_MOCK_SLOTS), period included (it has
  // no edit target of its own), renders inside the section after the caption.
  assert.deepEqual([...MARKETING_SITE_MOCK_SLOTS[PRICING_SECTION_ID]!].sort(), ['cta', 'features', 'name', 'period', 'price']);
  let covered = 0;
  for (const tier of FIXTURE.sections[3].items as Record<string, string | string[]>[]) {
    for (const name of MARKETING_SITE_MOCK_SLOTS[PRICING_SECTION_ID]!) {
      for (const value of ([] as string[]).concat(tier[name]!)) {
        const at = region.indexOf(`>${e(value)}<`, caption);
        assert.ok(at > caption, `${name} "${value}" renders after the caption`);
        covered += 1;
      }
    }
  }
  assert.equal(covered, PRICING_TIER_COUNT * (4 + PRICING_FEATURE_COUNT), 'every mock value is covered');
});

test('omits unsupported facts', () => {
  const recipe = clone();
  const original = clone();
  // Every nullable atom (MARKETING_SITE_NULLABLE_ATOMS): the pricing tiers and every footer link.
  // The proof atom sits inside the optional proof section, dropped whole below.
  recipe.sections[3].items = null;
  for (const column of recipe.sections[5].items.columns) column.links = column.links.map(() => null);
  const optionalIndexes = SECTION_ORDER.map((_, index) => index)
    .filter((index) => MARKETING_SITE_OPTIONAL_SECTIONS.has(original.sections[index].type));
  for (const index of optionalIndexes) recipe.sections[index] = null;
  assert.deepEqual(new Set(optionalIndexes.map((index) => original.sections[index].type)), MARKETING_SITE_OPTIONAL_SECTIONS, 'the test drops exactly the optional section set');
  assert.deepEqual(Object.values(MARKETING_SITE_NULLABLE_ATOMS).sort(), ['page-or-service-named-in-brief', 'pricing', 'testimonials'], 'the test nulls every nullable atom kind');

  const { html } = compile(recipe);
  const body = bodyOf(html);
  const kept = new Set([...strings(recipe.brand), ...strings(recipe.sections.filter((s: { id: string } | null) => s && s.id !== PRICING_SECTION_ID && s.id !== FOOTER_SECTION_ID)), recipe.sections[5].text.tagline]);
  const dropped = [
    ...strings(original.sections[3]),
    ...strings(original.sections[5].items),
    ...optionalIndexes.flatMap((index) => strings(original.sections[index].items)),
  ].filter((value) => !/^marketing-site-|^(pricing|testimonials)$/.test(value));
  for (const value of dropped.filter((value) => !kept.has(value))) assert.ok(!body.includes(`>${e(value)}<`), `${value} is gone`);
  // The pricing heading goes with its tiers: a heading over nothing would be an orphan label.
  assert.ok(!body.includes(e(original.sections[3].text.heading)), 'no orphan pricing heading');
  assert.ok(!body.includes(`data-od-id="${FOOTER_SECTION_ID}--columns-`), 'no footer column heading over no links');
  assert.ok(body.includes(`data-od-id="${FOOTER_SECTION_ID}--tagline"`), 'the footer tagline stays');
  assert.ok(!body.includes('data-od-mock'), 'no orphan caption');
  assert.ok(!/<ul[^>]*><\/ul>|<figure/.test(body), 'no empty tier list or testimonial frame');
  assert.ok(!body.includes(`data-od-id="${PRICING_SECTION_ID}--`) && !body.includes(`data-od-id="${PROOF_SECTION_ID}--`), 'no dropped edit target');

  // Omitted section ids: the dropped optional section, plus pricing (its atom null).
  const droppedIds = optionalIndexes.map((index) => original.sections[index].id as string);
  assert.deepEqual(droppedIds, [PROOF_SECTION_ID]);
  assert.deepEqual(SECTION_ORDER.filter((id) => !html.includes(`id="${id}"`)), SECTION_ORDER.filter((id) => droppedIds.includes(id) || id === PRICING_SECTION_ID));
});

test('a null footer link is omitted; a column with no link left drops its heading too', () => {
  const recipe = clone();
  recipe.sections[5].items.columns[0].links[1] = null;
  recipe.sections[5].items.columns[2].links = [null, null, null];
  const { html } = compile(recipe);
  const ids = listMarketingSiteTextSlots(html);
  assert.ok(!ids.includes(`${FOOTER_SECTION_ID}--columns-0--link-1`), 'the null link has no edit target');
  assert.ok(ids.includes(`${FOOTER_SECTION_ID}--columns-0--link-0`) && ids.includes(`${FOOTER_SECTION_ID}--columns-0--link-2`), 'its neighbours stay');
  assert.ok(ids.includes(`${FOOTER_SECTION_ID}--columns-0--heading`), 'a column with a link left keeps its heading');
  assert.ok(!ids.some((id) => id.startsWith(`${FOOTER_SECTION_ID}--columns-2--`)), 'the emptied column is gone, heading and all');
  assert.ok(!html.includes(`>${e(FIXTURE.sections[5].items.columns[2].heading)}<`), 'no orphan column heading');
  assert.equal(ids.length, expectedSlotIds().length - 1 - (1 + FOOTER_LINK_COUNT));
  const empty = clone();
  empty.sections[5].items.columns[1].links[0] = '';
  assert.match(refusal(empty), /sections\[5\]\.items\.columns\[1\]\.links\[0\]: expected non-empty plain text/, 'an empty string is still refused: null is the only way to state nothing');
});

test('the testimonials section declares the quote precondition the fast lane drops it on', () => {
  const proof = ((SCHEMA.properties as SchemaNode).sections as SchemaNode).prefixItems as SchemaNode[];
  const optional = proof[2]!['x-optional'] as SchemaNode;
  assert.equal(optional.requires, 'quote');
  const footerColumn = (SCHEMA.$defs as SchemaNode).footerColumn as SchemaNode;
  const link = ((footerColumn.properties as SchemaNode).links as SchemaNode).items as SchemaNode;
  assert.deepEqual(link.type, ['string', 'null']);
  assert.equal(link['x-atom'], MARKETING_SITE_NULLABLE_ATOMS.footerLink, 'the schema kind matches slots.ts');
});

// ---------------------------------------------------------------------------
// B3: the fast lane skips every x-mock value only because the fixed caption stands before it
// ---------------------------------------------------------------------------

/** Every string path of a recipe under an `x-mock` mark (inherited downward), as the fast lane's
 * `mockPathsFor` reads them: a mark next to a `$ref` or on a nullable `oneOf` counts. */
function xMockPaths(node: SchemaNode | undefined, value: unknown, inherited: boolean, at: string, out: string[] = []): string[] {
  const resolved = node && typeof node === 'object' ? resolveNode(node) : undefined;
  const mock = inherited || resolved?.['x-mock'] === true;
  if (typeof value === 'string') {
    if (mock) out.push(at);
  } else if (Array.isArray(value)) {
    const prefix = (resolved?.prefixItems ?? []) as SchemaNode[];
    value.forEach((item, index) => xMockPaths(prefix[index] ?? (resolved?.items as SchemaNode | undefined), item, mock, `${at}[${index}]`, out));
  } else if (value && typeof value === 'object') {
    const properties = (resolved?.properties ?? {}) as Record<string, SchemaNode>;
    for (const [key, child] of Object.entries(value)) xMockPaths(properties[key], child, mock, at ? `${at}.${key}` : key, out);
  }
  return out;
}

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

test('the caption is template copy: the schema has no caption field and does not carry its text', () => {
  const schemaText = readFileSync(path.join(HERE, 'recipe.schema.json'), 'utf8');
  assert.ok(!schemaText.includes(ILLUSTRATIVE_PRICING_CAPTION), 'the caption text is not recipe data');
  assert.doesNotMatch(schemaText, /"[A-Za-z-]*(caption|sampleNote)[A-Za-z-]*"\s*:/i, 'no caption-like recipe field');
});

test('every x-mock value, holding its reference sample value, renders in a sample-data region after the fixed caption', () => {
  // The reference fixture is what the fast lane keeps for a sample slot the model leaves empty,
  // so this is also the page such a run publishes: the pricing section.
  const paths = xMockPaths(SCHEMA, FIXTURE, false, '');
  assert.equal(paths.length, 21, 'every x-mock path of the reference recipe');
  assertCaptionBacksEveryMockValue(FIXTURE, paths, (recipe) => compile(recipe).html, ILLUSTRATIVE_PRICING_CAPTION);
});

test('the reference fixture carries no dishonest link (G5)', () => {
  const { html } = compile(clone());
  assert.deepEqual(dishonestLinks(html), []);
  assert.ok(!html.includes('href="#"'), 'never a "#" placeholder link');
});

test('testimonials carry the shared gate markers: name is x-atom person-name, quote is x-verify quote (G5)', () => {
  const schema = JSON.parse(readFileSync(path.join(HERE, 'recipe.schema.json'), 'utf8')) as { $defs: { testimonialItem: { properties: Record<string, Record<string, unknown>> } } };
  const fields = schema.$defs.testimonialItem.properties;
  assert.equal(fields.name!['x-atom'], 'person-name');
  assert.equal(fields.quote!['x-verify'], 'quote');
});
