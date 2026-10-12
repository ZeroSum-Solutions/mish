/**
 * crm-dashboard family — trusted renderer.
 *
 * Public surface used by the compiler's `families/registry.ts`:
 *   validateCrmDashboardRecipe(input)          -> typed recipe
 *   getCrmDashboardAssetRequirements(recipe)   -> AssetRequirement[] (always empty: no images)
 *   renderCrmDashboard(recipe, resolvedPaths, { outputScope })  -> HTML string
 *
 * The page composes six vendored HyperUI `application/*` blocks
 * (`plugins/_official/shared/ui-kits/hyperui/blocks/application/{stats/1,tables/1,timelines/1,
 * details-list/1,filters/1,charts/2}.html`) into one fixed layout, in the same
 * "typed slots over a frame taken from the reference" style `maben/render.ts` uses. Every named
 * text slot reaches the page inside an element carrying `data-od-id="<sectionId>--<slot>"` (or
 * `--<repeat>-<index>--<slot>` inside a repeat); `findCrmDashboardTextSlot` and
 * `listCrmDashboardTextSlots` read those ids back out of saved HTML, unchanged from maben's
 * convention, so the daemon's slot tooling works on this family without modification.
 *
 * The chart (`application/charts/2`) is server-rendered as inline SVG bars computed from the
 * recipe's own numbers; the source block's `<canvas>` and its charting script are not carried.
 * There is no other JavaScript: `filters` is a native `<details>`/`<summary>` disclosure, exactly
 * as `application/filters/1` ships it.
 *
 * `brand.name` and `brand.descriptor` reach `<title>`/`<meta name="description">` as usual, but
 * ALSO each get their own hidden `data-od-id="brand--name"`/`"brand--descriptor"` element (the
 * `sr-only` pattern maben's render.ts uses for its own brand fields) so a canvas edit to either
 * is reconcilable — `<title>`/`<meta>` content is not addressable by `findCrmDashboardTextSlot`.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { AssetRequirement } from '../../assets.ts';
import { catalogAsset, catalogBlock } from '../../catalog-block.ts';
import { presentSections } from '../../sections.ts';
import { outputScopeNote, type FamilyRenderOptions } from '../../output-scope.ts';
import {
  parseCrmDashboardRecipe,
  type CrmActivityItem, type CrmChartValue, type CrmDashboardRecipe, type CrmKpiItem, type CrmPipelineRow,
} from './contract.ts';
import {
  ACTIVITY_SECTION_ID, CHART_SECTION_ID, CONTACT_SECTION_ID, CRM_DASHBOARD_MOCK_SLOTS, FILTERS_SECTION_ID, KPI_SECTION_ID,
  PIPELINE_SECTION_ID, SAMPLE_DATA_CAPTION, type CrmDashboardSectionId,
} from './slots.ts';

const HERE = import.meta.dirname;
// The package-local copy under compiler/scripts/catalog/ (written by
// packages/genui-catalog/scripts/sync-catalog-assets.ts), so the read resolves inside a packed plugin.
const HYPERUI_CSS = path.join(HERE, '../../catalog/hyperui/crm-dashboard.css');
let hyperuiCss: string | undefined;
/** Read once; the compiled Tailwind build for this page kind's six vendored blocks
 * (`plugins/_official/shared/ui-kits/hyperui/css/crm-dashboard.css`, copied into this package), inlined once per page. */
function inlinedStyles(): string {
  hyperuiCss ??= readFileSync(HYPERUI_CSS, 'utf8');
  return hyperuiCss;
}

export function validateCrmDashboardRecipe(input: unknown): CrmDashboardRecipe {
  return parseCrmDashboardRecipe(input);
}

/** No image, font or video assets: the six vendored blocks carry no `<img>` once vendored. */
export function getCrmDashboardAssetRequirements(_recipe: CrmDashboardRecipe): AssetRequirement[] {
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
 * `agency-emmpo/compiler/scripts/families/emmpo/render.ts`: there it strips a nullable-atom
 * fragment out of a loaded template before token substitution; here the "template" is the
 * already-assembled KPI strip, and the fragment is one placeholder card standing in for a null
 * secondary KPI (see CRM_DASHBOARD_NULLABLE_ATOMS.kpiSecondary in slots.ts).
 */
export function stripKnownFragment(template: string, pattern: RegExp, placeholder: string): string {
  const stripped = template.replace(pattern, '');
  if (stripped.includes(placeholder)) throw new Error(`Nullable-atom fragment did not match the known template shape for ${placeholder}`);
  return stripped;
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

const UP_ARROW = '<svg aria-hidden="true" class="size-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6"/></svg>';
const DOWN_ARROW = '<svg aria-hidden="true" class="size-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 17h8m0 0V9m0 8l-8-8-4 4-6-6"/></svg>';
const CHEVRON = '<svg aria-hidden="true" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="size-4"><path stroke-linecap="round" stroke-linejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5"/></svg>';

/** A placeholder fragment for a null KPI, stripped by `stripKnownFragment` right after the strip
 * is assembled. The attribute IS the sentinel `stripKnownFragment` looks for. */
function kpiPlaceholder(index: number): string {
  return `<article data-crm-null="kpis-${index}"></article>`;
}
function kpiPlaceholderPattern(index: number): RegExp {
  return new RegExp(`<article data-crm-null="kpis-${index}"></article>`);
}

/** The catalog components this page uses (./catalog.json), all CSS-only. */
const CATALOG_COMPONENTS = ['glass-surface'] as const;

/** Each catalog component's synced CSS, once, as its own <style> element for <head>. */
function catalogStyles(): string {
  return CATALOG_COMPONENTS.map((id) => `<style data-genui-style="${id}">${catalogAsset(id, 'styles.css')}</style>`).join('');
}

/**
 * Each KPI tile is the catalog's `glass-surface`. The page CSP is `script-src 'none'`, so it is a
 * CSS-only block; its CSS is inlined once in <head> (`catalogStyles`), so every tile emits only
 * its host element and the KPI grid holds nothing but <article> tiles.
 */
function kpiCard(sectionId: string, index: number, item: CrmKpiItem | null): string {
  if (item === null) return kpiPlaceholder(index);
  const up = !item.delta.trim().startsWith('-');
  const badge = up
    ? `<div class="inline-flex gap-2 self-end rounded-sm bg-green-100 p-1 text-green-600">${UP_ARROW}<span class="sr-only">Increase: </span></div>`
    : `<div class="inline-flex gap-2 self-end rounded-sm bg-red-100 p-1 text-red-600">${DOWN_ARROW}<span class="sr-only">Decrease: </span></div>`;
  return catalogBlock('glass-surface', badge
    + `<div>${slot('strong', 'block text-sm font-medium text-gray-500', `${sectionId}--kpis-${index}--label`, item.label)}`
    + `<p>${slot('span', 'text-2xl font-medium text-gray-900', `${sectionId}--kpis-${index}--value`, item.value)} `
    + `${slot('span', 'text-xs text-gray-500', `${sectionId}--kpis-${index}--delta`, item.delta)}</p></div>`, {
    tag: 'article',
    className: 'flex flex-col gap-4 rounded-lg border border-gray-100 p-6',
    attrs: { id: `${sectionId}-kpis-${index}` },
    vars: { tint: '#ffffff', opacity: 0.85, blur: '8px' },
    emitted: new Set(CATALOG_COMPONENTS),
  });
}

function renderKpis(s: CrmDashboardRecipe['sections'][0]): string {
  let html = `<section class="kpis" id="${s.id}">`
    + `<div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">`
    + s.items.map((item, index) => kpiCard(s.id, index, item)).join('')
    + `</div></section>`;
  s.items.forEach((item, index) => {
    if (item === null) html = stripKnownFragment(html, kpiPlaceholderPattern(index), `data-crm-null="kpis-${index}"`);
  });
  return html;
}

function pipelineRowHtml(sectionId: string, index: number, row: CrmPipelineRow): string {
  const cell = (name: keyof CrmPipelineRow, className: string) =>
    `<td class="px-3 py-2 whitespace-nowrap ${className}" data-od-id="${sectionId}--rows-${index}--${name}">${e(row[name])}</td>`;
  return `<tr class="*:text-gray-900 *:first:font-medium">`
    + cell('company', '') + cell('owner', '') + cell('stage', '') + cell('value', '') + cell('nextStep', '')
    + `</tr>`;
}

function renderPipeline(s: CrmDashboardRecipe['sections'][1]): string {
  return `<section class="pipeline" id="${s.id}">`
    + slot('h2', 'text-sm font-medium text-gray-900', `${s.id}--heading`, s.text.heading)
    + `<div class="mt-4 overflow-x-auto"><table class="min-w-full divide-y-2 divide-gray-200">`
    + `<thead class="ltr:text-left rtl:text-right"><tr class="*:font-medium *:text-gray-900">`
    + `<th class="px-3 py-2 whitespace-nowrap">Company</th><th class="px-3 py-2 whitespace-nowrap">Owner</th>`
    + `<th class="px-3 py-2 whitespace-nowrap">Stage</th><th class="px-3 py-2 whitespace-nowrap">Value</th>`
    + `<th class="px-3 py-2 whitespace-nowrap">Next step</th></tr></thead>`
    + `<tbody class="divide-y divide-gray-200">${s.items.map((row, index) => pipelineRowHtml(s.id, index, row)).join('')}</tbody>`
    + `</table></div></section>`;
}

function activityItemHtml(sectionId: string, index: number, item: CrmActivityItem): string {
  return `<li class="relative -ms-1.5 flex items-start gap-4">`
    + `<span class="size-3 shrink-0 rounded-full bg-blue-600"></span>`
    + `<div class="-mt-2">${slot('time', 'text-xs font-medium text-gray-700', `${sectionId}--activity-${index}--when`, item.when)}`
    + slot('h3', 'text-sm font-bold text-gray-900', `${sectionId}--activity-${index}--who`, item.who)
    + slot('p', 'mt-0.5 text-sm text-gray-700', `${sectionId}--activity-${index}--what`, item.what)
    + `</div></li>`;
}

/** The whole feed is a nullable atom (CRM_DASHBOARD_NULLABLE_ATOMS.activity): when the brief
 * states no activity, nothing is emitted for this section at all, not an empty timeline. The
 * section can separately be dropped outright (CRM_DASHBOARD_OPTIONAL_SECTIONS): renderActivity
 * is then never called at all (see `presentSections` below), so this only handles `items: null`. */
function renderActivity(s: NonNullable<CrmDashboardRecipe['sections'][2]>): string {
  if (s.items === null) return '';
  return `<section class="activity" id="${s.id}">`
    + `<ol class="relative space-y-8 before:absolute before:-ms-px before:h-full before:w-0.5 before:rounded-full before:bg-gray-200">`
    + s.items.map((item, index) => activityItemHtml(s.id, index, item)).join('')
    + `</ol></section>`;
}

function renderContact(s: CrmDashboardRecipe['sections'][3]): string {
  const row = (label: string, name: keyof typeof s.text) =>
    `<div class="grid grid-cols-1 gap-1 py-3 sm:grid-cols-3 sm:gap-4"><dt class="font-medium text-gray-900">${e(label)}</dt>`
    + `<dd class="text-gray-700 sm:col-span-2" data-od-id="${s.id}--${String(name)}">${e(s.text[name])}</dd></div>`;
  return `<section class="contact" id="${s.id}"><div class="flow-root"><dl class="-my-3 divide-y divide-gray-200 text-sm">`
    + row('Name', 'name') + row('Role', 'role') + row('Company', 'company') + row('Email', 'email') + row('Phone', 'phone') + row('Note', 'note')
    + `</dl></div></section>`;
}

function filterGroup(sectionId: string, name: 'owner' | 'stage', heading: string, options: string[]): string {
  const checkboxes = options.map((option, index) =>
    `<label for="${sectionId}-${name}-${index}" class="inline-flex items-center gap-3">`
    + `<input type="checkbox" class="size-5 rounded border-gray-300 shadow-sm" id="${sectionId}-${name}-${index}">`
    + slot('span', 'text-sm font-medium text-gray-700', `${sectionId}--${name}-${index}`, option)
    + `</label>`).join('');
  return `<details class="group relative">`
    + `<summary class="flex items-center gap-2 border-b border-gray-300 pb-1 text-gray-700 [&::-webkit-details-marker]:hidden">`
    + `<span class="text-sm font-medium">${e(heading)}</span>${CHEVRON}</summary>`
    + `<div class="z-auto w-64 divide-y divide-gray-300 rounded border border-gray-300 bg-white shadow-sm group-open:absolute group-open:start-0 group-open:top-8">`
    + `<fieldset class="p-3"><legend class="sr-only">${e(heading)}</legend>`
    + `<div class="flex flex-col items-start gap-3">${checkboxes}</div></fieldset></div></details>`;
}

function renderFilters(s: CrmDashboardRecipe['sections'][4]): string {
  return `<section class="filters" id="${s.id}"><div class="flex flex-wrap gap-4 sm:gap-6">`
    + filterGroup(s.id, 'owner', 'Owner', s.items.owner)
    + filterGroup(s.id, 'stage', 'Stage', s.items.stage)
    + `</div></section>`;
}

/** The whole chart is a nullable atom (CRM_DASHBOARD_NULLABLE_ATOMS.chart): dropped entirely,
 * not an empty frame, when the brief carries no chartable numbers. */
function renderChart(s: CrmDashboardRecipe['sections'][5]): string {
  if (s.text === null || s.items === null) return '';
  const values: CrmChartValue[] = s.items.values;
  const max = Math.max(...values.map((v) => v.value), 1);
  const width = 320;
  const height = 140;
  const gap = 6;
  const barWidth = (width - gap * (values.length - 1)) / values.length;
  const bars = values.map((v, index) => {
    const barHeight = Math.max(Math.round((v.value / max) * height), v.value > 0 ? 2 : 0);
    const x = index * (barWidth + gap);
    const y = height - barHeight;
    return `<rect x="${x.toFixed(2)}" y="${y}" width="${barWidth.toFixed(2)}" height="${barHeight}" rx="2"></rect>`;
  }).join('');
  const labels = values.map((v, index) =>
    `<span class="w-8 truncate text-center">${slot('span', 'text-xs text-gray-500', `${s.id}--values-${index}--label`, v.label)}</span>`).join('');
  return `<section class="chart" id="${s.id}"><div class="rounded-lg border border-gray-200 bg-white p-6">`
    + slot('h2', 'text-sm font-medium text-gray-900', `${s.id}--title`, s.text.title)
    + `<div class="mt-4 h-64 text-blue-600"><svg viewBox="0 0 ${width} ${height}" role="img" fill="currentColor" `
    + `aria-label="${e(s.text.title)}, bar chart in ${e(s.text.unit)}">${bars}</svg></div>`
    + `<div class="mt-2 flex flex-wrap gap-2">${labels}</div>`
    + `</div></section>`;
}

const RENDERERS: Record<string, (s: CrmDashboardRecipe['sections'][number]) => string> = {
  [KPI_SECTION_ID]: (s) => renderKpis(s as CrmDashboardRecipe['sections'][0]),
  [PIPELINE_SECTION_ID]: (s) => renderPipeline(s as CrmDashboardRecipe['sections'][1]),
  [ACTIVITY_SECTION_ID]: (s) => renderActivity(s as NonNullable<CrmDashboardRecipe['sections'][2]>),
  [CONTACT_SECTION_ID]: (s) => renderContact(s as CrmDashboardRecipe['sections'][3]),
  [FILTERS_SECTION_ID]: (s) => renderFilters(s as CrmDashboardRecipe['sections'][4]),
  [CHART_SECTION_ID]: (s) => renderChart(s as CrmDashboardRecipe['sections'][5]),
};

export function renderCrmDashboard(recipe: CrmDashboardRecipe, _resolvedAssetPaths: Record<string, string>, options: FamilyRenderOptions): string {
  // A dropped optional section (null, e.g. a null sections[2]) renders nothing at all.
  const body = presentSections(recipe.sections).map((section) => {
    const html = RENDERERS[section.id]!(section);
    return CRM_DASHBOARD_MOCK_SLOTS[section.id as CrmDashboardSectionId] ? withSampleCaption(html, section.id) : html;
  }).join('');
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'none'; style-src 'unsafe-inline'; script-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'">`
    + `<meta name="description" content="${e(recipe.brand.descriptor)}">`
    + `<title>${e(recipe.brand.name)}</title><style>${inlinedStyles()}</style>${catalogStyles()}</head>`
    + `<body class="bg-gray-50 p-6"><main class="mx-auto flex max-w-6xl flex-col gap-6">`
    + `<p class="sr-only" data-od-id="brand--name">${e(recipe.brand.name)}</p>`
    + `<p class="sr-only" data-od-id="brand--descriptor">${e(recipe.brand.descriptor)}</p>`
    + `${body}</main>`
    // A dashboard under `script-src 'none'`: its filters, tabs and table controls are not wired,
    // and the page says so. The scope is supplied by `renderFamily` from the family registry's
    // pageKind (see `output-scope.ts`).
    + outputScopeNote(options, 'py-3')
    + `</body></html>\n`;
}

/** Read one text slot back out of saved HTML by its data-od-id. */
export function findCrmDashboardTextSlot(html: string, odId: string): string | undefined {
  if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(odId)) throw new Error('data-od-id: expected letters, digits and hyphens only');
  const pattern = new RegExp(`<([a-z0-9]+)\\b[^>]*\\sdata-od-id="${odId}"[^>]*>([\\s\\S]*?)</\\1>`, 'i');
  const match = pattern.exec(html);
  return match ? match[2]!.replace(/<[^>]*>/g, '').trim() : undefined;
}

/** Every data-od-id present in saved HTML, in document order. */
export function listCrmDashboardTextSlots(html: string): string[] {
  return [...html.matchAll(/data-od-id="([^"]+)"/g)].map((match) => match[1]!);
}

export { SECTION_ORDER, CRM_DASHBOARD_MOCK_SLOTS, CRM_DASHBOARD_NULLABLE_ATOMS, CRM_DASHBOARD_OPTIONAL_SECTIONS } from './slots.ts';
