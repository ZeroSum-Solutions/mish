/**
 * app-shell family — trusted renderer.
 *
 * Public surface used by the compiler's `families/registry.ts`:
 *   validateAppShellRecipe(input)          -> typed recipe
 *   getAppShellAssetRequirements(recipe)   -> AssetRequirement[] (always empty: no images)
 *   renderAppShell(recipe, resolvedPaths, { outputScope })  -> HTML string
 *
 * The page composes six vendored HyperUI application blocks
 * (`plugins/_official/shared/ui-kits/hyperui/blocks/application/{side-menu/1,vertical-menu/1,
 * empty-states/1,tables/2,details-list/2,tabs/1}.html`) into one fixed layout, in the same
 * "typed slots over a frame taken from the reference" style `crm-dashboard/render.ts` uses.
 * Every named text slot reaches the page inside an element carrying
 * `data-od-id="<sectionId>--<slot>"` (or `--<repeat>-<index>--<slot>` inside a repeat);
 * `findAppShellTextSlot` and `listAppShellTextSlots` read those ids back out of saved HTML,
 * unchanged from crm-dashboard's convention.
 *
 * `application/vertical-menu/1` ships as a vertical list; the top nav reuses its link classes
 * inside a horizontal `flex` row instead, since no new Tailwind utility is introduced beyond
 * what the six scanned blocks already carry (`flex`/`gap-*`/`items-center` all appear in
 * `application/side-menu/1.html` and `application/tabs/1.html`, two of this page kind's other
 * five vendored blocks).
 *
 * `brand.name` and `brand.descriptor` reach `<title>`/`<meta name="description">` as usual, but
 * ALSO each get their own hidden `data-od-id="brand--name"`/`"brand--descriptor"` element (the
 * crm-dashboard pattern) so a canvas edit to either is reconcilable.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { AssetRequirement } from '../../assets.ts';
import { catalogAsset, catalogBlock } from '../../catalog-block.ts';
import { presentSections } from '../../sections.ts';
import { outputScopeNote, type FamilyRenderOptions } from '../../output-scope.ts';
import {
  parseAppShellRecipe,
  type AppShellDetailPair, type AppShellListRow, type AppShellNavGroup, type AppShellRecipe, type AppShellSettingsSection,
} from './contract.ts';
import {
  APP_SHELL_MOCK_SLOTS, DETAIL_SECTION_ID, EMPTY_SECTION_ID, LIST_SECTION_ID, SAMPLE_DATA_CAPTION, SETTINGS_SECTION_ID,
  SIDENAV_SECTION_ID, TOPNAV_SECTION_ID, type AppShellSectionId,
} from './slots.ts';

const HERE = import.meta.dirname;
// The package-local copy under compiler/scripts/catalog/ (written by
// packages/genui-catalog/scripts/sync-catalog-assets.ts), so the read resolves inside a packed plugin.
const HYPERUI_CSS = path.join(HERE, '../../catalog/hyperui/app-shell.css');
let hyperuiCss: string | undefined;
/** Read once; the compiled Tailwind build for this page kind's six vendored blocks
 * (`plugins/_official/shared/ui-kits/hyperui/css/app-shell.css`, copied into this package), inlined once per page. */
function inlinedStyles(): string {
  hyperuiCss ??= readFileSync(HYPERUI_CSS, 'utf8');
  return hyperuiCss;
}

export function validateAppShellRecipe(input: unknown): AppShellRecipe {
  return parseAppShellRecipe(input);
}

/** No image, font or video assets: the six vendored blocks carry no `<img>` once vendored. */
export function getAppShellAssetRequirements(_recipe: AppShellRecipe): AssetRequirement[] {
  return [];
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
}
const e = escapeHtml;

/** One text slot: an element that carries its own data-od-id. */
function slot(tag: string, className: string, id: string, value: string): string {
  const classes = className ? ` class="${className}"` : '';
  return `<${tag}${classes} data-od-id="${id}">${e(value)}</${tag}>`;
}

/**
 * Remove a known fragment from an already-composed string, verifying the placeholder is
 * actually gone rather than trusting a no-op replace. Mirrors `stripKnownFragment` in
 * `agency-crm-dashboard/compiler/scripts/families/crm-dashboard/render.ts`.
 */
export function stripKnownFragment(template: string, pattern: RegExp, placeholder: string): string {
  const stripped = template.replace(pattern, '');
  if (stripped.includes(placeholder)) throw new Error(`Nullable-atom fragment did not match the known template shape for ${placeholder}`);
  return stripped;
}

const CHEVRON = '<svg aria-hidden="true" class="size-5" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clip-rule="evenodd"/></svg>';
const EMPTY_ICON = '<svg aria-hidden="true" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="mx-auto size-20 text-gray-400"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z"/></svg>';

/**
 * A top-nav item names another screen of the illustrative app this shell mocks up — never a real
 * page or in-page section of THIS one-page reference build (G5: `<span>`, not `<a href="#">`;
 * see `sidenavGroup`'s own doc for the same choice on the side-nav's links).
 */
function topnavLink(index: number, text: string): string {
  const activeClass = 'block rounded-lg bg-gray-100 px-4 py-2 text-sm font-medium text-gray-900';
  // No hover classes: this is an inert <span> (see the doc comment above), and nothing may look
  // clickable without being clickable (G5).
  const inactiveClass = 'block rounded-lg px-4 py-2 text-sm font-medium text-gray-700';
  return `<li><span class="${index === 0 ? activeClass : inactiveClass}" `
    + `data-od-id="${TOPNAV_SECTION_ID}--links-${index}">${e(text)}</span></li>`;
}

/**
 * Mark a rendered section as sample data and put the visible caption first inside it: the
 * section holds slots `recipe.schema.json` marks `x-mock`, which the faithfulness gate skips
 * only because the page labels them. A nulled section renders nothing and gets nothing.
 */
function withSampleCaption(html: string, sectionId: string): string {
  if (!html) return html;
  const open = `id="${sectionId}">`;
  const at = html.indexOf(open);
  if (at < 0) throw new Error(`sample-data caption: no opening tag for ${sectionId}`);
  return html.slice(0, at) + `id="${sectionId}" data-od-mock="sample-data">`
    + `<p class="text-xs font-medium text-gray-500" data-od-mock="caption">${e(SAMPLE_DATA_CAPTION)}</p>`
    + html.slice(at + open.length);
}

function renderTopnav(s: AppShellRecipe['sections'][0]): string {
  return `<nav id="${s.id}" class="border-b border-gray-100 bg-white">`
    + `<div class="flex items-center justify-between gap-4 p-4">`
    + `<ul class="flex flex-wrap items-center gap-1">${s.items.links.map((link, index) => topnavLink(index, link)).join('')}</ul>`
    // The caption comes first, as in every other sample-data region: a reader meets it before the value.
    + `<div data-od-mock="sample-data"><p class="text-xs font-medium text-gray-500" data-od-mock="caption">${e(SAMPLE_DATA_CAPTION)}</p>`
    + `<p class="text-xs text-gray-900" data-od-id="${s.id}--user">${e(s.items.user)}</p></div>`
    + `</div></nav>`;
}

/** A placeholder fragment for a null side-nav group, stripped by `stripKnownFragment` right
 * after the list is assembled. The attribute IS the sentinel `stripKnownFragment` looks for. */
function sidenavPlaceholder(index: number): string {
  return `<li data-app-null="sidenav-${index}"></li>`;
}
function sidenavPlaceholderPattern(index: number): RegExp {
  return new RegExp(`<li data-app-null="sidenav-${index}"></li>`);
}

function sidenavGroup(sectionId: string, index: number, group: AppShellNavGroup | null): string {
  if (group === null) return sidenavPlaceholder(index);
  // Each link names another screen of the illustrative app, not a real page or in-page section
  // this one-page reference build renders (G5): `<span>`, never `<a href="#">`.
  // No hover classes on the link itself: it is an inert <span> (see the doc comment above), and
  // nothing may look clickable without being clickable (G5). The <summary> above it keeps its
  // hover class because it IS clickable — it expands/collapses the group.
  const links = group.links.map((link, index2) =>
    `<li><span class="block rounded-lg px-4 py-2 text-sm font-medium text-gray-700" `
    + `data-od-id="${sectionId}--groups-${index}--link-${index2}">${e(link)}</span></li>`).join('');
  return `<li><details class="group" open><summary class="flex items-center justify-between rounded-lg px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 hover:text-gray-900">`
    + `<span data-od-id="${sectionId}--groups-${index}--heading">${e(group.heading)}</span>${CHEVRON}</summary>`
    + `<ul class="mt-2 space-y-1 px-4">${links}</ul></details></li>`;
}

function renderSidenav(s: AppShellRecipe['sections'][1]): string {
  let html = `<nav id="${s.id}" class="border-e border-gray-100 bg-white p-4">`
    + `<ul class="space-y-1">${s.items.map((group, index) => sidenavGroup(s.id, index, group)).join('')}</ul></nav>`;
  s.items.forEach((group, index) => {
    if (group === null) html = stripKnownFragment(html, sidenavPlaceholderPattern(index), `data-app-null="sidenav-${index}"`);
  });
  return html;
}

/**
 * The primary panel (the empty-state card) is the catalog's `glass-surface`, declared in
 * ./catalog.json. The page CSP is `script-src 'none'`, so it is a CSS-only block: the host class
 * and `--genui-glass-surface-*` properties are the whole effect. Its CSS is inlined once, in
 * <head> (see `catalogStyles`), so the block itself emits only the host element.
 */
function renderEmpty(s: NonNullable<AppShellRecipe['sections'][2]>): string {
  return `<section id="${s.id}"><div class="p-8">`
    + catalogBlock('glass-surface', EMPTY_ICON
    + slot('h2', 'mt-6 text-2xl font-bold text-gray-900', `${s.id}--heading`, s.text.heading)
    + slot('p', 'mt-4 text-pretty text-gray-700', `${s.id}--body`, s.text.body)
    + `<button type="button" class="mt-6 block w-full rounded-lg bg-indigo-600 px-6 py-3 text-sm font-medium text-white hover:bg-indigo-700" `
    + `data-od-id="${s.id}--cta">${e(s.text.cta)}</button>`, {
      className: 'mx-auto max-w-md border border-gray-200 p-8 text-center shadow-sm',
      vars: { tint: '#ffffff', opacity: 0.7, blur: '10px' },
      emitted: new Set(CATALOG_COMPONENTS),
    })
    + `</div></section>`;
}

function listRowHtml(sectionId: string, index: number, row: AppShellListRow): string {
  const cell = (name: keyof AppShellListRow, className: string) =>
    `<td class="px-3 py-2 whitespace-nowrap ${className}" data-od-id="${sectionId}--rows-${index}--${name}">${e(row[name])}</td>`;
  return `<tr class="*:text-gray-900 *:first:font-medium">`
    + cell('name', '') + cell('status', '') + cell('owner', '') + cell('updated', '')
    + `</tr>`;
}

function renderList(s: AppShellRecipe['sections'][3]): string {
  return `<section id="${s.id}"><div class="p-6">`
    + slot('h2', 'text-sm font-medium text-gray-900', `${s.id}--heading`, s.text.heading)
    + `<div class="mt-4 overflow-x-auto rounded border border-gray-300 shadow-sm"><table class="min-w-full divide-y-2 divide-gray-200">`
    + `<thead class="ltr:text-left rtl:text-right"><tr class="*:font-medium *:text-gray-900">`
    + `<th class="px-3 py-2 whitespace-nowrap">Name</th><th class="px-3 py-2 whitespace-nowrap">Status</th>`
    + `<th class="px-3 py-2 whitespace-nowrap">Owner</th><th class="px-3 py-2 whitespace-nowrap">Updated</th></tr></thead>`
    + `<tbody class="divide-y divide-gray-200">${s.items.map((row, index) => listRowHtml(s.id, index, row)).join('')}</tbody>`
    + `</table></div></div></section>`;
}

function detailPairHtml(sectionId: string, index: number, pair: AppShellDetailPair): string {
  return `<div class="grid grid-cols-1 gap-1 p-3 sm:grid-cols-3 sm:gap-4">`
    + `<dt class="font-medium text-gray-900" data-od-id="${sectionId}--pairs-${index}--label">${e(pair.label)}</dt>`
    + `<dd class="text-gray-700 sm:col-span-2" data-od-id="${sectionId}--pairs-${index}--value">${e(pair.value)}</dd>`
    + `</div>`;
}

function renderDetail(s: AppShellRecipe['sections'][4]): string {
  return `<section id="${s.id}"><div class="p-6">`
    + slot('h2', 'text-sm font-medium text-gray-900', `${s.id}--heading`, s.text.heading)
    + `<div class="mt-4 flow-root"><dl class="-my-3 divide-y divide-gray-200 text-sm">`
    + s.items.map((pair, index) => detailPairHtml(s.id, index, pair)).join('')
    + `</dl></div></div></section>`;
}

/** A placeholder fragment for a null settings section (both its tab button and its panel),
 * stripped by `stripKnownFragment` right after each list is assembled. */
function settingsTabPlaceholder(index: number): string {
  return `<button data-app-null="settings-${index}"></button>`;
}
function settingsTabPlaceholderPattern(index: number): RegExp {
  return new RegExp(`<button data-app-null="settings-${index}"></button>`);
}
function settingsPanelPlaceholder(index: number): string {
  return `<div data-app-null="settings-panel-${index}"></div>`;
}
function settingsPanelPlaceholderPattern(index: number): RegExp {
  return new RegExp(`<div data-app-null="settings-panel-${index}"></div>`);
}

function settingsTab(sectionId: string, index: number, section: AppShellSettingsSection | null): string {
  if (section === null) return settingsTabPlaceholder(index);
  const selectedClass = 'border-b-2 border-blue-600 px-4 py-2 text-sm font-medium text-blue-600';
  const otherClass = 'border-b-2 border-transparent px-4 py-2 text-sm font-medium text-gray-600';
  return `<button role="tab" aria-selected="${index === 0}" class="${index === 0 ? selectedClass : otherClass}" `
    + `data-od-id="${sectionId}--sections-${index}--heading">${e(section.heading)}</button>`;
}

function settingsPanel(sectionId: string, index: number, section: AppShellSettingsSection | null): string {
  if (section === null) return settingsPanelPlaceholder(index);
  return `<div role="tabpanel" class="mt-4">`
    + slot('p', 'text-gray-700', `${sectionId}--sections-${index}--body`, section.body)
    + `</div>`;
}

/** Rendered in its open state, as a static tab strip: every tab button and every panel are
 * always in the document, with no script to switch between them — only the first tab carries
 * the "selected" style, matching `application/tabs/1.html`. When every settings section is
 * null, the whole section is dropped, not an empty bordered wrapper around an empty tablist —
 * the same "drop the whole fragment" rule marketing-site's `proof` and `pricing` sections use. */
function renderSettings(s: AppShellRecipe['sections'][5]): string {
  if (s.items.every((section) => section === null)) return '';
  let html = `<section id="${s.id}"><div class="p-6">`
    + `<div class="-mb-px border-b border-gray-200"><div role="tablist" class="flex gap-1">`
    + s.items.map((section, index) => settingsTab(s.id, index, section)).join('')
    + `</div></div>`
    + s.items.map((section, index) => settingsPanel(s.id, index, section)).join('')
    + `</div></section>`;
  s.items.forEach((section, index) => {
    if (section === null) {
      html = stripKnownFragment(html, settingsTabPlaceholderPattern(index), `data-app-null="settings-${index}"`);
      html = stripKnownFragment(html, settingsPanelPlaceholderPattern(index), `data-app-null="settings-panel-${index}"`);
    }
  });
  return html;
}

/** The catalog components this page uses (./catalog.json), all CSS-only. */
const CATALOG_COMPONENTS = ['glass-surface'] as const;

/** Each catalog component's synced CSS, once, as its own <style> element for <head>. */
function catalogStyles(): string {
  return CATALOG_COMPONENTS.map((id) => `<style data-genui-style="${id}">${catalogAsset(id, 'styles.css')}</style>`).join('');
}

const RENDERERS: Record<string, (s: AppShellRecipe['sections'][number]) => string> = {
  [TOPNAV_SECTION_ID]: (s) => renderTopnav(s as AppShellRecipe['sections'][0]),
  [SIDENAV_SECTION_ID]: (s) => renderSidenav(s as AppShellRecipe['sections'][1]),
  [EMPTY_SECTION_ID]: (s) => renderEmpty(s as NonNullable<AppShellRecipe['sections'][2]>),
  [LIST_SECTION_ID]: (s) => renderList(s as AppShellRecipe['sections'][3]),
  [DETAIL_SECTION_ID]: (s) => renderDetail(s as AppShellRecipe['sections'][4]),
  [SETTINGS_SECTION_ID]: (s) => renderSettings(s as AppShellRecipe['sections'][5]),
};

export function renderAppShell(recipe: AppShellRecipe, _resolvedAssetPaths: Record<string, string>, options: FamilyRenderOptions): string {
  // A dropped optional section (null, e.g. a null sections[2]) renders nothing at all.
  const body = presentSections(recipe.sections).map((section) => {
    const html = RENDERERS[section.id]!(section);
    // The top nav labels its one sample slot (the signed-in user) inline; see `renderTopnav`.
    const captioned = section.id !== TOPNAV_SECTION_ID && APP_SHELL_MOCK_SLOTS[section.id as AppShellSectionId];
    return captioned ? withSampleCaption(html, section.id) : html;
  }).join('');
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'none'; style-src 'unsafe-inline'; script-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'">`
    + `<meta name="description" content="${e(recipe.brand.descriptor)}">`
    + `<title>${e(recipe.brand.name)}</title><style>${inlinedStyles()}</style>${catalogStyles()}</head>`
    + `<body class="bg-gray-50">`
    + `<p class="sr-only" data-od-id="brand--name">${e(recipe.brand.name)}</p>`
    + `<p class="sr-only" data-od-id="brand--descriptor">${e(recipe.brand.descriptor)}</p>`
    + `${body}`
    // An app shell under `script-src 'none'`: its navigation, tabs and buttons are not wired, and
    // the page says so. The scope is supplied by `renderFamily` from the family registry's
    // pageKind (see `output-scope.ts`).
    + outputScopeNote(options, 'border-t border-gray-100 bg-white p-4')
    + `</body></html>\n`;
}

/** Read one text slot back out of saved HTML by its data-od-id. */
export function findAppShellTextSlot(html: string, odId: string): string | undefined {
  if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(odId)) throw new Error('data-od-id: expected letters, digits and hyphens only');
  const pattern = new RegExp(`<([a-z0-9]+)\\b[^>]*\\sdata-od-id="${odId}"[^>]*>([\\s\\S]*?)</\\1>`, 'i');
  const match = pattern.exec(html);
  return match ? match[2]!.replace(/<[^>]*>/g, '').trim() : undefined;
}

/** Every data-od-id present in saved HTML, in document order. */
export function listAppShellTextSlots(html: string): string[] {
  return [...html.matchAll(/data-od-id="([^"]+)"/g)].map((match) => match[1]!);
}

export { APP_SHELL_MOCK_SLOTS, APP_SHELL_NULLABLE_ATOMS, APP_SHELL_OPTIONAL_SECTIONS, SECTION_ORDER } from './slots.ts';
