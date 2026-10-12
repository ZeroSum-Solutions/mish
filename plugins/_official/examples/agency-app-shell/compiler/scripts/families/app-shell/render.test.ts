/**
 * app-shell family render tests.
 * Run: node --experimental-strip-types --test render.test.ts
 *
 * Drives the family module directly (validate, render, slot lookup), the same surface the
 * compiler's `families/registry.ts` dispatches through. A refusal here is the refusal an
 * app-shell package compiler gives.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { renderAgencySite } from '../../render.ts';
import { dishonestLinks } from '../../sections.ts';
import { FAMILIES } from '../registry.ts';
import {
  findAppShellTextSlot, getAppShellAssetRequirements, listAppShellTextSlots,
  renderAppShell, stripKnownFragment, validateAppShellRecipe,
} from './render.ts';
import {
  DETAIL_PAIR_COUNT, DETAIL_PAIR_SLOTS, DETAIL_SECTION_ID, DETAIL_TEXT_SLOTS,
  EMPTY_SECTION_ID, EMPTY_SLOTS,
  LIST_ROW_COUNT, LIST_ROW_SLOTS, LIST_SECTION_ID, LIST_TEXT_SLOTS,
  SECTION_ORDER,
  SETTINGS_COUNT, SETTINGS_SECTION_ID, SETTINGS_SLOTS,
  SIDENAV_GROUP_COUNT, SIDENAV_GROUP_HEADING_SLOT, SIDENAV_LINK_COUNT, SIDENAV_LINK_SLOT, SIDENAV_SECTION_ID,
  TOPNAV_LINK_COUNT, TOPNAV_SECTION_ID, TOPNAV_USER_SLOT,
  APP_SHELL_MOCK_SLOTS, APP_SHELL_NULLABLE_ATOMS, APP_SHELL_OPTIONAL_SECTIONS, SAMPLE_DATA_CAPTION,
} from './slots.ts';

const HERE = import.meta.dirname;
const FIXTURE = JSON.parse(readFileSync(path.join(HERE, 'reference.fixture.json'), 'utf8'));
const clone = () => structuredClone(FIXTURE);

function compile(recipeInput: unknown) {
  const recipe = validateAppShellRecipe(recipeInput);
  assert.deepEqual(getAppShellAssetRequirements(recipe), [], 'no image, font or video assets');
  const html = renderAppShell(recipe, {}, { outputScope: 'static-prototype' });
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
  for (let i = 0; i < TOPNAV_LINK_COUNT; i++) ids.push(`${TOPNAV_SECTION_ID}--links-${i}`);
  ids.push(`${TOPNAV_SECTION_ID}--${TOPNAV_USER_SLOT.name}`);
  for (let i = 0; i < SIDENAV_GROUP_COUNT; i++) {
    ids.push(`${SIDENAV_SECTION_ID}--groups-${i}--${SIDENAV_GROUP_HEADING_SLOT.name}`);
    for (let j = 0; j < SIDENAV_LINK_COUNT; j++) ids.push(`${SIDENAV_SECTION_ID}--groups-${i}--${SIDENAV_LINK_SLOT.name}-${j}`);
  }
  for (const slot of EMPTY_SLOTS) ids.push(`${EMPTY_SECTION_ID}--${slot.name}`);
  for (const slot of LIST_TEXT_SLOTS) ids.push(`${LIST_SECTION_ID}--${slot.name}`);
  for (let i = 0; i < LIST_ROW_COUNT; i++) for (const slot of LIST_ROW_SLOTS) ids.push(`${LIST_SECTION_ID}--rows-${i}--${slot.name}`);
  for (const slot of DETAIL_TEXT_SLOTS) ids.push(`${DETAIL_SECTION_ID}--${slot.name}`);
  for (let i = 0; i < DETAIL_PAIR_COUNT; i++) for (const slot of DETAIL_PAIR_SLOTS) ids.push(`${DETAIL_SECTION_ID}--pairs-${i}--${slot.name}`);
  // Document order follows the static tab strip: every tab button (heading) first, in a row,
  // then every panel (body) below it — not interleaved per section.
  for (let i = 0; i < SETTINGS_COUNT; i++) ids.push(`${SETTINGS_SECTION_ID}--sections-${i}--heading`);
  for (let i = 0; i < SETTINGS_COUNT; i++) ids.push(`${SETTINGS_SECTION_ID}--sections-${i}--body`);
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

test('every text slot in the fixture renders exactly once, and the roster is 64 slots', () => {
  const { html } = compile(clone());
  const ids = listAppShellTextSlots(html);
  assert.deepEqual(ids, expectedSlotIds(), 'the rendered slot roster matches slots.ts field for field, in document order');
  assert.equal(new Set(ids).size, ids.length, 'data-od-id values are unique');
  assert.ok(ids.length >= 48 && ids.length <= 64, `expected 48 to 64 slots, found ${ids.length}`);
  assert.equal(ids.length, 64, 'the fully populated reference fixture renders the full roster');
  assert.equal(findAppShellTextSlot(html, `${LIST_SECTION_ID}--rows-1--name`), 'Cedar Ridge Plant');
  assert.equal(findAppShellTextSlot(html, 'brand--name'), 'Fieldbook');
  assert.equal(findAppShellTextSlot(html, 'brand--descriptor'), 'A site-inspection tracker mock for a field services team.');
});

test('nulling side-nav groups 3 and 4 and every settings section drops each cleanly, including the whole settings section', () => {
  const nulled = clone();
  nulled.sections[1].items[2] = null;
  nulled.sections[1].items[3] = null;
  nulled.sections[5].items[0] = null;
  nulled.sections[5].items[1] = null;
  nulled.sections[5].items[2] = null;
  const { html } = compile(nulled);
  assert.ok(!html.includes(`${SIDENAV_SECTION_ID}--groups-2--`), 'side-nav group 2 is gone');
  assert.ok(!html.includes(`${SIDENAV_SECTION_ID}--groups-3--`), 'side-nav group 3 is gone');
  assert.ok(html.includes(`${SIDENAV_SECTION_ID}--groups-0--`), 'side-nav group 0 stays');
  // Every settings section is null: the whole section drops (the KIND fix, not the per-item
  // sentinel path below), the same "drop the whole fragment" rule marketing-site's nullable
  // sections use — not an empty bordered wrapper around an empty tablist.
  assert.ok(!html.includes(`id="${SETTINGS_SECTION_ID}"`), 'the whole settings section is gone');
  assert.ok(!html.includes('role="tablist"'), 'no empty tablist wrapper is left behind');
  assert.ok(!html.includes(`${SETTINGS_SECTION_ID}--sections-0--`), 'settings section 0 is gone');
  assert.ok(!html.includes(`${SETTINGS_SECTION_ID}--sections-1--`), 'settings section 1 is gone');
  assert.ok(!html.includes(`${SETTINGS_SECTION_ID}--sections-2--`), 'settings section 2 is gone');
  const ids = listAppShellTextSlots(html);
  const droppedSidenav = 2 * (1 + SIDENAV_LINK_COUNT);
  const droppedSettings = SETTINGS_COUNT * SETTINGS_SLOTS.length;
  assert.equal(ids.length, expectedSlotIds().length - droppedSidenav - droppedSettings, 'dropped nullable atoms leave everything else in place');
});

test('a partially null settings roster keeps the section and drops only the null items', () => {
  const partial = clone();
  partial.sections[5].items[1] = null;
  const { html } = compile(partial);
  assert.ok(html.includes(`id="${SETTINGS_SECTION_ID}"`), 'the settings section stays: not every item is null');
  assert.ok(html.includes(`${SETTINGS_SECTION_ID}--sections-0--heading`), 'settings section 0 stays');
  assert.ok(!html.includes(`${SETTINGS_SECTION_ID}--sections-1--`), 'settings section 1 (the null one) is gone');
  assert.ok(html.includes(`${SETTINGS_SECTION_ID}--sections-2--heading`), 'settings section 2 stays');
  const ids = listAppShellTextSlots(html);
  assert.equal(ids.length, expectedSlotIds().length - SETTINGS_SLOTS.length, 'only the one null settings section is missing');
});

test('a null empty-state section (sections[2] itself, not an items array) drops the whole section', () => {
  const nulled = clone();
  nulled.sections[2] = null;
  const { html } = compile(nulled);
  assert.ok(!html.includes(`id="${EMPTY_SECTION_ID}"`), 'no empty-state section wrapper');
  assert.ok(!html.includes(`data-od-id="${EMPTY_SECTION_ID}`), 'no empty-state edit targets');
  const ids = listAppShellTextSlots(html);
  assert.equal(ids.length, expectedSlotIds().length - EMPTY_SLOTS.length, 'empty-state slots are gone, everything else stays');
  const required = clone();
  required.sections[0] = null;
  assert.match(refusal(required), /sections\[0\]: expected a plain object/, 'a null in a non-optional slot is still refused');
});

test('the first two side-nav groups may not be null', () => {
  const bad = clone();
  bad.sections[1].items[0] = null;
  assert.match(refusal(bad), /sections\[1\]\.items\[0\]: the first 2 side-nav groups may not be null/);
});

test('no <script appears anywhere, and CSP forbids it', () => {
  const { html } = compile(clone());
  assert.ok(!html.includes('<script'), 'no script tag');
  assert.match(html, /script-src 'none'/);
});

const CATALOG_DIR = path.join(HERE, '../../catalog/components');

test('the empty-state panel is the catalog glass-surface, CSS-only, with its slots intact', () => {
  const { html } = compile(clone());
  const start = html.indexOf(`id="${EMPTY_SECTION_ID}"`);
  const section = html.slice(start, html.indexOf('</section>', start));
  assert.match(section, /<div class="genui-glass-surface mx-auto [^"]*" data-genui="glass-surface" style="--genui-glass-surface-tint:#ffffff;[^"]*">/);
  for (const slot of EMPTY_SLOTS) {
    assert.ok(section.includes(`data-od-id="${EMPTY_SECTION_ID}--${slot.name}"`), `${slot.name} stays inside the panel`);
  }
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

/** Classes emitted on purpose with no rule of their own. None today. */
const UNSTYLED_HOOKS = new Set<string>();
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
  inner.sections[2].text.subhead = 'not a slot';
  assert.match(refusal(inner), /sections\[2\]\.text\.subhead: unknown field/);
});

test('markup in a plain-text slot is refused', () => {
  const tag = clone();
  tag.sections[2].text.body = 'Prefers async <script>alert(1)</script>';
  assert.match(refusal(tag), /sections\[2\]\.text\.body: markup is not allowed/);
  const long = clone();
  long.sections[2].text.heading = 'x'.repeat(61);
  assert.match(refusal(long), /sections\[2\]\.text\.heading: at most 60 characters/);
});

test('the fixed repeat counts are enforced', () => {
  const shortLinks = clone();
  shortLinks.sections[0].items.links.pop();
  assert.match(refusal(shortLinks), /sections\[0\]\.items\.links: expected exactly 4 items/);
  const shortRows = clone();
  shortRows.sections[3].items.pop();
  assert.match(refusal(shortRows), /sections\[3\]\.items: expected exactly 5 items/);
  const shortPairs = clone();
  shortPairs.sections[4].items.pop();
  assert.match(refusal(shortPairs), /sections\[4\]\.items: expected exactly 5 items/);
  const shortGroupLinks = clone();
  shortGroupLinks.sections[1].items[0].links.pop();
  assert.match(refusal(shortGroupLinks), /sections\[1\]\.items\[0\]\.links: expected exactly 3 items/);
});

test('the section roster and its order are enforced', () => {
  const renamed = clone();
  renamed.sections[0].id = 'app-shell-not-topnav';
  assert.match(refusal(renamed), /sections\[0\]\.id: expected "app-shell-topnav"/);
  const swapped = clone();
  [swapped.sections[0], swapped.sections[1]] = [swapped.sections[1], swapped.sections[0]];
  assert.throws(() => compile(swapped), /unknown field|expected "app-shell/, 'a shape or id mismatch is refused either way');
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
  assert.throws(
    () => stripKnownFragment(
      '<li data-app-null="sidenav-9">unexpected inner content</li>',
      /<li data-app-null="sidenav-9"><\/li>/,
      'data-app-null="sidenav-9"',
    ),
    /did not match the known template shape/,
  );
  assert.equal(
    stripKnownFragment('<a></a><li data-app-null="sidenav-2"></li><b></b>', /<li data-app-null="sidenav-2"><\/li>/, 'data-app-null="sidenav-2"'),
    '<a></a><b></b>',
  );
});

// ---------------------------------------------------------------------------
// x-mock: the schema marks match APP_SHELL_MOCK_SLOTS, and the page labels every sample section
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

test('the schema x-mock marks name exactly APP_SHELL_MOCK_SLOTS', () => {
  const sections = ((SCHEMA.properties as SchemaNode).sections as SchemaNode).prefixItems as SchemaNode[];
  const marked: Record<string, string[]> = {};
  for (const section of sections) {
    const id = ((section.properties as SchemaNode).id as SchemaNode).const as string;
    const names = [...markedSlotNames(section, false, new Set())].sort();
    if (names.length > 0) marked[id] = names;
  }
  const expected = Object.fromEntries(Object.entries(APP_SHELL_MOCK_SLOTS).map(([id, names]) => [id, [...names!].sort()]));
  assert.deepEqual(marked, expected);
  // Nothing outside the sections (brand, metadata) is ever sample data.
  assert.deepEqual([...markedSlotNames(((SCHEMA.properties as SchemaNode).brand as SchemaNode), false, new Set())], []);
});

test('every section holding sample data renders under a visible "Sample data" caption', () => {
  const { html } = compile(clone());
  for (const id of [LIST_SECTION_ID, DETAIL_SECTION_ID]) {
    assert.match(html, new RegExp(`id="${id}" data-od-mock="sample-data"><p class="[^"]*" data-od-mock="caption">${SAMPLE_DATA_CAPTION}</p>`), id);
  }
  // The top nav's one sample slot, the signed-in user, carries the caption just before it.
  assert.match(html, new RegExp(`<div data-od-mock="sample-data"><p [^>]*data-od-mock="caption">${SAMPLE_DATA_CAPTION}</p><p [^>]*data-od-id="${TOPNAV_SECTION_ID}--user">[^<]*</p></div>`));
  assert.equal(html.match(/data-od-mock="caption"/g)?.length, Object.keys(APP_SHELL_MOCK_SLOTS).length);
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
  assert.equal(FAMILIES['app-shell']!.outputScope, 'static-prototype', 'registry row materialised from the family registry pageKind');
  const { html, manifest } = renderAgencySite(clone(), 'app-shell-r1.html', { version: 1, assets: [] }) as { html: string; manifest: { metadata: { agencySite: { outputScope: string } } } };
  assert.equal(manifest.metadata.agencySite.outputScope, 'static-prototype');
  assert.equal(html.split('data-od-output-scope="static-prototype"').length - 1, 1);
});

test('C16: the note follows the supplied scope, and a render that ignores it is refused', () => {
  const row = FAMILIES['app-shell']!;
  const approved = { version: 1, assets: [] };
  // The render emits the note from its input: supply `site` and the note and the manifest follow.
  FAMILIES['app-shell'] = { ...row, outputScope: 'site' };
  try {
    const { html, manifest } = renderAgencySite(clone(), 'app-shell-r1.html', approved) as { html: string; manifest: { metadata: { agencySite: { outputScope: string } } } };
    assert.doesNotMatch(html, /data-od-output-scope/);
    assert.equal(manifest.metadata.agencySite.outputScope, 'site');
  } finally {
    FAMILIES['app-shell'] = row;
  }
  // A render whose page disagrees with the supplied scope throws; it is never relabelled.
  FAMILIES['app-shell'] = { ...row, render: (recipe, paths) => row.render(recipe, paths, { outputScope: 'site' }) };
  try {
    assert.throws(() => renderAgencySite(clone(), 'app-shell-r1.html', approved), /output scope static-prototype was supplied, but the rendered page carries 0/);
  } finally {
    FAMILIES['app-shell'] = row;
  }
});

// ---------------------------------------------------------------------------
// Sample-data coverage and unsupported facts
// ---------------------------------------------------------------------------

/** The renderer's own HTML escape, so a value with `&` or a quote is found as rendered. */
const e = (value: string) => value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));

/** The captioned region holding a section's sample data: the section itself, or (top nav) the
 * small wrapper around the signed-in user. Returns the region's HTML, caption first. */
function sampleRegion(html: string, sectionId: string): string {
  if (sectionId === TOPNAV_SECTION_ID) {
    const start = html.indexOf('<div data-od-mock="sample-data">');
    assert.ok(start >= 0, 'the top nav has a sample-data wrapper');
    return html.slice(start, html.indexOf('</div>', start) + '</div>'.length);
  }
  const start = html.indexOf(`id="${sectionId}" data-od-mock="sample-data">`);
  assert.ok(start >= 0, `${sectionId} is marked sample data`);
  return html.slice(start, html.indexOf('</section>', start));
}

test('the sample-data caption renders first in every mock region and covers every mock value', () => {
  const { html } = compile(clone());
  const ids = listAppShellTextSlots(html);
  let covered = 0;
  for (const [sectionId, names] of Object.entries(APP_SHELL_MOCK_SLOTS)) {
    const region = sampleRegion(html, sectionId);
    const caption = region.indexOf(`data-od-mock="caption">${SAMPLE_DATA_CAPTION}</p>`);
    assert.ok(caption >= 0, `${sectionId}: the caption is inside the region`);
    // Every slot of this section whose own name is a mock slot name sits inside the region, after
    // the caption, so the caption is what a reader meets first.
    const mockIds = ids.filter((id) => id.startsWith(`${sectionId}--`) && names!.includes(id.split('--').pop()!.replace(/-\d+$/, '')));
    assert.ok(mockIds.length > 0, `${sectionId}: has mock slots`);
    for (const id of mockIds) {
      const at = region.indexOf(`data-od-id="${id}"`);
      assert.ok(at >= 0, `${id} is inside the captioned region`);
      assert.ok(at > caption, `${id} follows the caption`);
      // The slot text as rendered (already HTML-escaped).
      const value = findAppShellTextSlot(html, id)!;
      assert.ok(value.length > 0 && region.includes(`>${value}<`), `${id}'s value renders inside the region`);
      covered += 1;
    }
  }
  // user (1) + list rows (5 x 4) + detail heading (1) + detail values (5).
  assert.equal(covered, 1 + LIST_ROW_COUNT * LIST_ROW_SLOTS.length + 1 + DETAIL_PAIR_COUNT, 'every mock value is covered');
});

test('omits unsupported facts', () => {
  const recipe = clone();
  const original = clone();
  // Every nullable atom (APP_SHELL_NULLABLE_ATOMS): side-nav groups 3 and 4, every settings section.
  recipe.sections[1].items[2] = null;
  recipe.sections[1].items[3] = null;
  recipe.sections[5].items = [null, null, null];
  // Every optional section (APP_SHELL_OPTIONAL_SECTIONS), by index.
  const optionalIndexes = SECTION_ORDER.map((_, index) => index)
    .filter((index) => APP_SHELL_OPTIONAL_SECTIONS.has(original.sections[index].type));
  for (const index of optionalIndexes) recipe.sections[index] = null;
  const droppedTypes = optionalIndexes.map((index) => original.sections[index].type as string);
  assert.deepEqual(new Set(droppedTypes), APP_SHELL_OPTIONAL_SECTIONS, 'the test drops exactly the optional section set');
  assert.deepEqual(Object.values(APP_SHELL_NULLABLE_ATOMS).sort(), ['nav-group', 'settings-section'], 'the test nulls every nullable atom kind');

  const { html } = compile(recipe);
  const sidenav = html.slice(html.indexOf(`id="${SIDENAV_SECTION_ID}"`), html.indexOf('</nav>', html.indexOf(`id="${SIDENAV_SECTION_ID}"`)));
  // Side-nav group headings may repeat a top-nav link, so they are checked inside the side nav.
  for (const group of original.sections[1].items.slice(2)) {
    for (const value of [group.heading, ...group.links]) assert.ok(!sidenav.includes(`>${e(value)}<`), `side nav: ${value} is gone`);
  }
  for (const section of original.sections[5].items) {
    for (const value of [section.heading, section.body]) assert.ok(!html.includes(e(value)), `settings: ${value} is gone`);
  }
  for (const index of optionalIndexes) {
    for (const value of Object.values(original.sections[index].text) as string[]) assert.ok(!html.includes(e(value)), `${value} is gone`);
  }

  // No empty wrapper or orphan label is left behind.
  assert.ok(!html.includes('data-app-null'), 'no placeholder sentinel survives');
  assert.equal((sidenav.match(/<details /g) ?? []).length, 2, 'exactly the two required side-nav groups render');
  assert.ok(!/<li>\s*<\/li>|<ul[^>]*><\/ul>/.test(html), 'no empty list item or list');
  assert.ok(!html.includes('role="tablist"') && !html.includes('role="tabpanel"'), 'no empty settings tab strip');
  assert.ok(!html.includes(`data-od-id="${SETTINGS_SECTION_ID}--`) && !html.includes(`data-od-id="${EMPTY_SECTION_ID}--`), 'no dropped edit target');

  // Omitted section ids: the dropped optional sections, plus settings (all of its items null).
  const droppedIds = optionalIndexes.map((index) => original.sections[index].id as string);
  const omitted = SECTION_ORDER.filter((id) => !html.includes(`id="${id}"`));
  assert.deepEqual(omitted, SECTION_ORDER.filter((id) => droppedIds.includes(id) || id === SETTINGS_SECTION_ID));
  assert.deepEqual(droppedIds, [EMPTY_SECTION_ID]);
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
  // so this is also the page such a run publishes: the top nav user, the list rows and the detail view.
  const paths = xMockPaths(SCHEMA, FIXTURE, false, '');
  assert.equal(paths.length, 27, 'every x-mock path of the reference recipe');
  assertCaptionBacksEveryMockValue(FIXTURE, paths, (recipe) => compile(recipe).html, SAMPLE_DATA_CAPTION);
});

test('the reference fixture carries no dishonest link (G5)', () => {
  const { html } = compile(clone());
  assert.deepEqual(dishonestLinks(html), []);
  assert.ok(!html.includes('href="#"'), 'never a "#" placeholder link');
});
