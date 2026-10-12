/**
 * crm-dashboard family render tests.
 * Run: node --experimental-strip-types --test render.test.ts
 *
 * Drives the family module directly (validate, render, slot lookup), the same surface the
 * compiler's `families/registry.ts` dispatches through. A refusal here is the refusal a
 * crm-dashboard package compiler gives.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { renderAgencySite } from '../../render.ts';
import { FAMILIES } from '../registry.ts';
import {
  findCrmDashboardTextSlot, getCrmDashboardAssetRequirements, listCrmDashboardTextSlots,
  renderCrmDashboard, stripKnownFragment, validateCrmDashboardRecipe,
} from './render.ts';
import {
  ACTIVITY_COUNT, ACTIVITY_ITEM_SLOTS, ACTIVITY_SECTION_ID,
  CHART_SECTION_ID, CHART_VALUE_COUNT,
  CONTACT_SECTION_ID, CONTACT_SLOTS,
  FILTERS_OWNER_COUNT, FILTERS_SECTION_ID, FILTERS_STAGE_COUNT,
  KPI_COUNT, KPI_ITEM_SLOTS, KPI_SECTION_ID,
  PIPELINE_ROW_COUNT, PIPELINE_ROW_SLOTS, PIPELINE_SECTION_ID,
  SECTION_ORDER,
  CRM_DASHBOARD_MOCK_SLOTS, CRM_DASHBOARD_NULLABLE_ATOMS, CRM_DASHBOARD_OPTIONAL_SECTIONS, SAMPLE_DATA_CAPTION,
} from './slots.ts';

const HERE = import.meta.dirname;
const FIXTURE = JSON.parse(readFileSync(path.join(HERE, 'reference.fixture.json'), 'utf8'));
const clone = () => structuredClone(FIXTURE);

function compile(recipeInput: unknown) {
  const recipe = validateCrmDashboardRecipe(recipeInput);
  assert.deepEqual(getCrmDashboardAssetRequirements(recipe), [], 'no image, font or video assets');
  const html = renderCrmDashboard(recipe, {}, { outputScope: 'static-prototype' });
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
  // brand--name and brand--descriptor render first, ahead of the six sections (see render.ts).
  ids.push('brand--name', 'brand--descriptor');
  for (let i = 0; i < KPI_COUNT; i++) for (const slot of KPI_ITEM_SLOTS) ids.push(`${KPI_SECTION_ID}--kpis-${i}--${slot.name}`);
  ids.push(`${PIPELINE_SECTION_ID}--heading`);
  for (let i = 0; i < PIPELINE_ROW_COUNT; i++) for (const slot of PIPELINE_ROW_SLOTS) ids.push(`${PIPELINE_SECTION_ID}--rows-${i}--${slot.name}`);
  for (let i = 0; i < ACTIVITY_COUNT; i++) for (const slot of ACTIVITY_ITEM_SLOTS) ids.push(`${ACTIVITY_SECTION_ID}--activity-${i}--${slot.name}`);
  for (const slot of CONTACT_SLOTS) ids.push(`${CONTACT_SECTION_ID}--${slot.name}`);
  for (let i = 0; i < FILTERS_OWNER_COUNT; i++) ids.push(`${FILTERS_SECTION_ID}--owner-${i}`);
  for (let i = 0; i < FILTERS_STAGE_COUNT; i++) ids.push(`${FILTERS_SECTION_ID}--stage-${i}`);
  ids.push(`${CHART_SECTION_ID}--title`);
  for (let i = 0; i < CHART_VALUE_COUNT; i++) ids.push(`${CHART_SECTION_ID}--values-${i}--label`);
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

test('every text slot in the fixture renders exactly once, and the roster is 62 to 82 slots (60 to 80 across the six sections, plus the two reconcilable brand slots)', () => {
  const { html } = compile(clone());
  const ids = listCrmDashboardTextSlots(html);
  assert.deepEqual(ids, expectedSlotIds(), 'the rendered slot roster matches slots.ts field for field, in document order');
  assert.equal(new Set(ids).size, ids.length, 'data-od-id values are unique');
  assert.ok(ids.length >= 62 && ids.length <= 82, `expected 62 to 82 slots (60-80 section slots + 2 brand slots), found ${ids.length}`);
  assert.equal(ids.length, 82, 'the fully populated reference fixture renders the top of the budget');
  assert.equal(findCrmDashboardTextSlot(html, 'crm-dashboard-pipeline--rows-1--company'), 'Colter Analytics');
  assert.equal(findCrmDashboardTextSlot(html, 'brand--name'), 'Anchor Pipeline');
  assert.equal(findCrmDashboardTextSlot(html, 'brand--descriptor'), 'A sales pipeline dashboard mock for a mid-market services team.');
});

test('a null activity feed and a null chart drop their whole section, not an empty frame', () => {
  const nulled = clone();
  nulled.sections[2].items = null;
  nulled.sections[5].text = null;
  nulled.sections[5].items = null;
  const { html } = compile(nulled);
  assert.ok(!html.includes('viewBox="0 0 320'), 'no chart bar svg (KPI badges and filter chevrons keep their own small svgs)');
  assert.ok(!html.includes('<ol'), 'no activity timeline');
  assert.ok(!html.includes(`id="${ACTIVITY_SECTION_ID}"`), 'no activity section wrapper');
  assert.ok(!html.includes(`id="${CHART_SECTION_ID}"`), 'no chart section wrapper');
  const ids = listCrmDashboardTextSlots(html);
  assert.equal(ids.length, expectedSlotIds().length - ACTIVITY_COUNT * ACTIVITY_ITEM_SLOTS.length - 1 - CHART_VALUE_COUNT, 'activity and chart slots are gone, everything else stays');
});

test('a null activity section (sections[2] itself, not just its items) drops the whole section', () => {
  const nulled = clone();
  nulled.sections[2] = null;
  const { html } = compile(nulled);
  assert.ok(!html.includes(`id="${ACTIVITY_SECTION_ID}"`), 'no activity section wrapper');
  assert.ok(!html.includes(`data-od-id="${ACTIVITY_SECTION_ID}`), 'no activity edit targets');
  const ids = listCrmDashboardTextSlots(html);
  assert.equal(ids.length, expectedSlotIds().length - ACTIVITY_COUNT * ACTIVITY_ITEM_SLOTS.length, 'activity slots are gone, everything else stays');
  const required = clone();
  required.sections[0] = null;
  assert.match(refusal(required), /sections\[0\]: expected a plain object/, 'a null in a non-optional slot is still refused');
});

test('a null secondary KPI drops its whole card', () => {
  const nulled = clone();
  nulled.sections[0].items[2] = null;
  nulled.sections[0].items[3] = null;
  const { html } = compile(nulled);
  assert.ok(!html.includes(`${KPI_SECTION_ID}--kpis-2--label`), 'kpi 2 is gone');
  assert.ok(!html.includes(`${KPI_SECTION_ID}--kpis-3--label`), 'kpi 3 is gone');
  assert.ok(html.includes(`${KPI_SECTION_ID}--kpis-0--label`), 'kpi 0 stays');
  assert.match(html, /<section class="kpis"[^>]*><p [^>]*data-od-mock="caption">Sample data<\/p><div class="grid[^"]*">(?:<article[\s\S]*?<\/article>){2}<\/div><\/section>/, 'exactly two kpi cards render');
});

test('the first two KPIs may not be null', () => {
  const bad = clone();
  bad.sections[0].items[0] = null;
  assert.match(refusal(bad), /sections\[0\]\.items\[0\]: the first 2 KPIs may not be null/);
  const bad2 = clone();
  bad2.sections[0].items[1] = null;
  assert.match(refusal(bad2), /sections\[0\]\.items\[1\]: the first 2 KPIs may not be null/);
});

test('the activity and chart nullable groups may not be partially null', () => {
  const half = clone();
  half.sections[5].text = null;
  assert.match(refusal(half), /sections\[5\]: text and items must both be null, or both present/);
});

test('no <script appears anywhere, and CSP forbids it', () => {
  const { html } = compile(clone());
  assert.ok(!html.includes('<script'), 'no script tag');
  assert.match(html, /script-src 'none'/);
});

const CATALOG_DIR = path.join(HERE, '../../catalog/components');

test('every KPI tile is the catalog glass-surface, CSS-only, and keeps its id and slots', () => {
  const { html } = compile(clone());
  const tiles = [...html.matchAll(/<article class="genui-glass-surface [^"]*" data-genui="glass-surface" style="--genui-glass-surface-tint:#ffffff;[^"]*" id="([^"]+)">/g)];
  assert.deepEqual(tiles.map((match) => match[1]), Array.from({ length: KPI_COUNT }, (_, index) => `${KPI_SECTION_ID}-kpis-${index}`));
  assert.match(html, new RegExp(`<section class="kpis"[^>]*><p [^>]*data-od-mock="caption">Sample data<\\/p><div class="grid[^"]*">(?:<article[\\s\\S]*?<\\/article>){${KPI_COUNT}}<\\/div><\\/section>`), 'the grid holds only the tiles');
  const css = readFileSync(path.join(CATALOG_DIR, 'glass-surface', 'styles.css'), 'utf8');
  const inlined = html.match(/<style data-genui-style="glass-surface">([\s\S]*?)<\/style>/);
  assert.ok(inlined, 'glass-surface CSS is inlined');
  assert.equal(inlined[1], css, 'glass-surface CSS is the synced copy, verbatim');
  assert.equal(html.split('data-genui-style="glass-surface"').length - 1, 1, 'glass-surface CSS is inlined once');
  assert.ok(html.indexOf('data-genui-style="glass-surface"') < html.indexOf('</head>'), 'the catalog CSS sits in <head>');
  assert.ok(!html.includes('data-genui-script'), 'no catalog script under script-src none');
  assert.ok(!html.includes('<script'), 'still no script tag');
  assert.match(html, /script-src 'none'/);
  const declared = JSON.parse(readFileSync(path.join(HERE, 'catalog.json'), 'utf8'));
  assert.deepEqual(declared, { catalogComponents: ['glass-surface'] }, 'the family declares exactly what it renders');
});

/** Section hook classes (`<section class="kpis">` and so on) that tests and edits select by;
 * they carry no styling on purpose. */
const UNSTYLED_HOOKS = new Set(['activity', 'chart', 'contact', 'filters', 'kpis', 'pipeline']);
/** Class names the page's inlined CSS defines a rule for (every `.name` in a selector, unescaped). */
function styledClasses(html: string): Set<string> {
  const css = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((match) => match[1]).join('\n');
  return new Set([...css.matchAll(/\.((?:\\.|[\w-])+)/g)].map((match) => match[1]!.replace(/\\(.)/g, '$1')));
}
/** Every class token the rendered page emits, entity-decoded. */
function emittedClasses(html: string): Set<string> {
  const tokens = [...html.matchAll(/\sclass="([^"]*)"/g)].flatMap((match) => match[1]!.replaceAll('&amp;', '&').split(/\s+/));
  return new Set(tokens.filter(Boolean));
}

test('exactly one <style> element carries the inlined HyperUI CSS once', () => {
  const { html } = compile(clone());
  assert.equal((html.match(/<style>/g) ?? []).length, 1);
  assert.match(html, /<style>\/\*! tailwindcss/);
});

test('every class the page emits has a rule in its inlined CSS (C17: an unstyled utility let the page overflow at 375 px)', () => {
  const { html } = compile(clone());
  const styled = styledClasses(html);
  const unstyled = [...emittedClasses(html)].filter((name) => !styled.has(name) && !UNSTYLED_HOOKS.has(name)).sort();
  assert.deepEqual(unstyled, [], 'rebuild the kind CSS with scripts/build-ui-kit-css.ts, then run sync-assets');
  for (const hook of UNSTYLED_HOOKS) assert.ok(!styled.has(hook), `${hook} is styled now; drop it from UNSTYLED_HOOKS`);
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
  inner.sections[3].text.title = 'not a slot';
  assert.match(refusal(inner), /sections\[3\]\.text\.title: unknown field/);
});

test('markup in a plain-text slot is refused', () => {
  const tag = clone();
  tag.sections[3].text.note = 'Prefers async <script>alert(1)</script>';
  assert.match(refusal(tag), /sections\[3\]\.text\.note: markup is not allowed/);
  const long = clone();
  long.sections[1].text.heading = 'x'.repeat(61);
  assert.match(refusal(long), /sections\[1\]\.text\.heading: at most 60 characters/);
});

test('the fixed repeat counts are enforced', () => {
  const shortRows = clone();
  shortRows.sections[1].items.pop();
  assert.match(refusal(shortRows), /sections\[1\]\.items: expected exactly 5 items/);
  const shortActivity = clone();
  shortActivity.sections[2].items.pop();
  assert.match(refusal(shortActivity), /sections\[2\]\.items: expected exactly 6 items, or null/);
  const shortValues = clone();
  shortValues.sections[5].items.values.pop();
  assert.match(refusal(shortValues), /sections\[5\]\.items\.values: expected exactly 8 items/);
  const shortOwners = clone();
  shortOwners.sections[4].items.owner.pop();
  assert.match(refusal(shortOwners), /sections\[4\]\.items\.owner: expected exactly 4 options/);
});

test('contact email and phone are format-checked', () => {
  const badEmail = clone();
  badEmail.sections[3].text.email = 'not-an-email';
  assert.match(refusal(badEmail), /sections\[3\]\.text\.email: invalid email/);
  const badPhone = clone();
  badPhone.sections[3].text.phone = 'call me';
  assert.match(refusal(badPhone), /sections\[3\]\.text\.phone: invalid telephone/);
});

test('a chart value must be a finite non-negative number', () => {
  const negative = clone();
  negative.sections[5].items.values[0].value = -1;
  assert.match(refusal(negative), /sections\[5\]\.items\.values\[0\]\.value: expected a finite number/);
  const nan = clone();
  nan.sections[5].items.values[0].value = Number.NaN;
  assert.match(refusal(nan), /sections\[5\]\.items\.values\[0\]\.value: expected a finite number/);
});

test('the section roster and its order are enforced', () => {
  // Sections have different shapes (unlike maben's generic SectionSpec), so swapping two
  // sections is refused for a shape mismatch before the id is even checked; a same-shape id
  // swap isolates the id/roster-order check on its own.
  const renamed = clone();
  renamed.sections[0].id = 'crm-dashboard-not-kpis';
  assert.match(refusal(renamed), /sections\[0\]\.id: expected "crm-dashboard-kpis"/);
  const swapped = clone();
  [swapped.sections[0], swapped.sections[1]] = [swapped.sections[1], swapped.sections[0]];
  assert.throws(() => compile(swapped), /unknown field|expected "crm-dashboard/, 'a shape or id mismatch is refused either way');
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

test('stripKnownFragment fails loudly when the known shape is gone', () => {
  // The placeholder text is present, but the fragment's shape has drifted (unexpected inner
  // content), so the exact pattern does not match, the replace is a no-op, and the placeholder
  // is still there afterward — the guard this function exists to raise.
  assert.throws(
    () => stripKnownFragment(
      '<article data-crm-null="kpis-9">unexpected inner content</article>',
      /<article data-crm-null="kpis-9"><\/article>/,
      'data-crm-null="kpis-9"',
    ),
    /did not match the known template shape/,
  );
  assert.equal(
    stripKnownFragment('<a></a><article data-crm-null="kpis-2"></article><b></b>', /<article data-crm-null="kpis-2"><\/article>/, 'data-crm-null="kpis-2"'),
    '<a></a><b></b>',
  );
});

// ---------------------------------------------------------------------------
// x-mock: the schema marks match CRM_DASHBOARD_MOCK_SLOTS, and the page labels every sample section
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

test('the schema x-mock marks name exactly CRM_DASHBOARD_MOCK_SLOTS', () => {
  const sections = ((SCHEMA.properties as SchemaNode).sections as SchemaNode).prefixItems as SchemaNode[];
  const marked: Record<string, string[]> = {};
  for (const section of sections) {
    const id = ((section.properties as SchemaNode).id as SchemaNode).const as string;
    const names = [...markedSlotNames(section, false, new Set())].sort();
    if (names.length > 0) marked[id] = names;
  }
  const expected = Object.fromEntries(Object.entries(CRM_DASHBOARD_MOCK_SLOTS).map(([id, names]) => [id, [...names!].sort()]));
  assert.deepEqual(marked, expected);
  // Nothing outside the sections (brand, metadata) is ever sample data.
  assert.deepEqual([...markedSlotNames(((SCHEMA.properties as SchemaNode).brand as SchemaNode), false, new Set())], []);
});

test('every section holding sample data renders under a visible "Sample data" caption', () => {
  const { html } = compile(clone());
  for (const id of Object.keys(CRM_DASHBOARD_MOCK_SLOTS)) {
    assert.match(html, new RegExp(`id="${id}" data-od-mock="sample-data"><p class="[^"]*" data-od-mock="caption">${SAMPLE_DATA_CAPTION}</p>`), id);
  }
  assert.equal(html.match(/data-od-mock="caption"/g)?.length, Object.keys(CRM_DASHBOARD_MOCK_SLOTS).length);
  // The caption is chrome, never a reconcilable text slot.
  assert.equal(listCrmDashboardTextSlots(html).length, expectedSlotIds().length);
  // A nulled sample section renders nothing, caption included.
  const recipe = clone();
  recipe.sections[2].items = null;
  recipe.sections[5].text = null;
  recipe.sections[5].items = null;
  assert.equal(compile(recipe).html.match(/data-od-mock="caption"/g)?.length, Object.keys(CRM_DASHBOARD_MOCK_SLOTS).length - 2);
});

test('C16: the page says it is a static prototype, in a visible note at the end of the body', () => {
  const { html } = compile(clone());
  const notes = [...html.matchAll(/<p role="note"[^>]*data-od-output-scope="static-prototype"[^>]*>([^<]*)<\/p>/g)];
  assert.equal(notes.length, 1, 'exactly one static-prototype note');
  assert.equal(notes[0]![1], 'Static prototype: navigation and controls are not wired.');
  assert.match(html, /<footer class="[^"]*"><p role="note"[^>]*>[^<]*<\/p><\/footer><\/body><\/html>\n$/, 'the note closes the page, inside a footer');
  assert.doesNotMatch(html.slice(html.indexOf('<footer')), /class="[^"]*sr-only/, 'the note is visible, not screen-reader only');
  assert.match(html, /script-src 'none'/, 'the CSP still refuses every script');
});

test('C16: renderFamily supplies the registry scope, and the manifest records that supplied value', () => {
  assert.equal(FAMILIES['crm-dashboard']!.outputScope, 'static-prototype', 'registry row materialised from the family registry pageKind');
  const { html, manifest } = renderAgencySite(clone(), 'crm-dashboard-r1.html', { version: 1, assets: [] }) as { html: string; manifest: { metadata: { agencySite: { outputScope: string } } } };
  assert.equal(manifest.metadata.agencySite.outputScope, 'static-prototype');
  assert.equal(html.split('data-od-output-scope="static-prototype"').length - 1, 1);
});

test('C16: the note follows the supplied scope, and a render that ignores it is refused', () => {
  const row = FAMILIES['crm-dashboard']!;
  const approved = { version: 1, assets: [] };
  // The render emits the note from its input: supply `site` and the note and the manifest follow.
  FAMILIES['crm-dashboard'] = { ...row, outputScope: 'site' };
  try {
    const { html, manifest } = renderAgencySite(clone(), 'crm-dashboard-r1.html', approved) as { html: string; manifest: { metadata: { agencySite: { outputScope: string } } } };
    assert.doesNotMatch(html, /data-od-output-scope/);
    assert.equal(manifest.metadata.agencySite.outputScope, 'site');
  } finally {
    FAMILIES['crm-dashboard'] = row;
  }
  // A render whose page disagrees with the supplied scope throws; it is never relabelled.
  FAMILIES['crm-dashboard'] = { ...row, render: (recipe, paths) => row.render(recipe, paths, { outputScope: 'site' }) };
  try {
    assert.throws(() => renderAgencySite(clone(), 'crm-dashboard-r1.html', approved), /output scope static-prototype was supplied, but the rendered page carries 0/);
  } finally {
    FAMILIES['crm-dashboard'] = row;
  }
});

// ---------------------------------------------------------------------------
// Sample-data coverage and unsupported facts
// ---------------------------------------------------------------------------

/** The renderer's own HTML escape, so a value with `&` or a quote is found as rendered. */
const e = (value: string) => value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));

/** Every string in a JSON value (recipe text slots and their siblings). */
function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((item) => strings(item, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((item) => strings(item, out));
  return out;
}

test('the sample-data caption renders first in every mock section and covers every mock value', () => {
  const { html } = compile(clone());
  const ids = listCrmDashboardTextSlots(html);
  let covered = 0;
  for (const [sectionId, names] of Object.entries(CRM_DASHBOARD_MOCK_SLOTS)) {
    const start = html.indexOf(`id="${sectionId}" data-od-mock="sample-data">`);
    assert.ok(start >= 0, `${sectionId} is marked sample data`);
    const region = html.slice(start, html.indexOf('</section>', start));
    const caption = region.indexOf(`data-od-mock="caption">${SAMPLE_DATA_CAPTION}</p>`);
    assert.ok(caption >= 0, `${sectionId}: the caption is inside the section`);
    // A slot is sample data when its own name (the last id segment, repeat index removed) is one
    // of the section's mock names: `--kpis-0--value` -> value, `--owner-2` -> owner.
    const mockIds = ids.filter((id) => id.startsWith(`${sectionId}--`) && names.includes(id.split('--').pop()!.replace(/-\d+$/, '')));
    assert.ok(mockIds.length > 0, `${sectionId}: has mock slots`);
    for (const id of mockIds) {
      const at = region.indexOf(`data-od-id="${id}"`);
      assert.ok(at > caption, `${id} is inside the captioned section, after the caption`);
      // The slot text as rendered (already HTML-escaped).
      const value = findCrmDashboardTextSlot(html, id)!;
      assert.ok(value.length > 0 && region.includes(`>${value}<`), `${id}'s value renders inside the section`);
      covered += 1;
    }
  }
  const expected = KPI_COUNT * 2 + PIPELINE_ROW_COUNT * PIPELINE_ROW_SLOTS.length + ACTIVITY_COUNT * ACTIVITY_ITEM_SLOTS.length
    + CONTACT_SLOTS.length + FILTERS_OWNER_COUNT + CHART_VALUE_COUNT;
  assert.equal(covered, expected, 'every mock value is covered');
  // The chart's numeric bar values are sample data too: they only render as bars inside the
  // captioned chart section, never as text anywhere else.
  const chart = html.slice(html.indexOf(`id="${CHART_SECTION_ID}"`));
  assert.ok(chart.includes('<rect '), 'the bars sit inside the captioned chart section');
});

test('omits unsupported facts', () => {
  const recipe = clone();
  const original = clone();
  // Every nullable atom (CRM_DASHBOARD_NULLABLE_ATOMS): the secondary KPIs, the chart. The
  // activity feed atom sits inside the optional activity section, dropped whole below.
  recipe.sections[0].items[2] = null;
  recipe.sections[0].items[3] = null;
  recipe.sections[5].text = null;
  recipe.sections[5].items = null;
  const optionalIndexes = SECTION_ORDER.map((_, index) => index)
    .filter((index) => CRM_DASHBOARD_OPTIONAL_SECTIONS.has(original.sections[index].type));
  for (const index of optionalIndexes) recipe.sections[index] = null;
  assert.deepEqual(new Set(optionalIndexes.map((index) => original.sections[index].type)), CRM_DASHBOARD_OPTIONAL_SECTIONS, 'the test drops exactly the optional section set');
  assert.deepEqual(Object.values(CRM_DASHBOARD_NULLABLE_ATOMS).sort(), ['activity-feed', 'chart', 'kpi-item'], 'the test nulls every nullable atom kind');

  const { html } = compile(recipe);
  // A dropped value that some kept slot also carries (a person in both the feed and the pipeline,
  // a chart label that is also a stage filter) is checked by its edit target instead.
  const kept = new Set(strings(recipe.sections));
  const dropped = [
    ...strings(original.sections[0].items.slice(2)),
    ...strings(original.sections[5].text), ...strings(original.sections[5].items),
    ...optionalIndexes.flatMap((index) => strings(original.sections[index].items)),
  ];
  for (const value of dropped.filter((value) => !kept.has(value))) assert.ok(!html.includes(e(value)), `${value} is gone`);
  for (const id of [`${KPI_SECTION_ID}--kpis-2--`, `${KPI_SECTION_ID}--kpis-3--`, `${CHART_SECTION_ID}--`, `${ACTIVITY_SECTION_ID}--`]) {
    assert.ok(!html.includes(`data-od-id="${id}`), `no ${id} edit target`);
  }

  // No empty wrapper or orphan caption is left behind.
  assert.ok(!html.includes('data-crm-null'), 'no placeholder sentinel survives');
  assert.match(html, /<section class="kpis"[^>]*><p [^>]*data-od-mock="caption">Sample data<\/p><div class="grid[^"]*">(?:<article[\s\S]*?<\/article>){2}<\/div><\/section>/, 'exactly the two required KPI cards render');
  assert.ok(!html.includes('<ol') && !html.includes('viewBox="0 0 320'), 'no empty timeline or chart frame');
  assert.equal(html.match(/data-od-mock="caption"/g)?.length, Object.keys(CRM_DASHBOARD_MOCK_SLOTS).length - 2, 'no caption for a dropped section');

  // Omitted section ids: the dropped optional section, plus the chart (both of its atoms null).
  const droppedIds = optionalIndexes.map((index) => original.sections[index].id as string);
  assert.deepEqual(droppedIds, [ACTIVITY_SECTION_ID]);
  assert.deepEqual(SECTION_ORDER.filter((id) => !html.includes(`id="${id}"`)), SECTION_ORDER.filter((id) => droppedIds.includes(id) || id === CHART_SECTION_ID));
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
  assert.ok(!schemaText.includes(SAMPLE_DATA_CAPTION), 'the caption text is not recipe data');
  assert.doesNotMatch(schemaText, /"[A-Za-z-]*(caption|sampleNote)[A-Za-z-]*"\s*:/i, 'no caption-like recipe field');
});

test('every x-mock value, holding its reference sample value, renders in a sample-data region after the fixed caption', () => {
  // The reference fixture is what the fast lane keeps for a sample slot the model leaves empty,
  // so this is also the page such a run publishes: the KPI tiles, pipeline, activity, contact card, filters and chart.
  const paths = xMockPaths(SCHEMA, FIXTURE, false, '');
  assert.equal(paths.length, 69, 'every x-mock path of the reference recipe');
  assertCaptionBacksEveryMockValue(FIXTURE, paths, (recipe) => compile(recipe).html, SAMPLE_DATA_CAPTION);
});
