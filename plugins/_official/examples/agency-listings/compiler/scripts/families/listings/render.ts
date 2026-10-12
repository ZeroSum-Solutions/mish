/**
 * listings family — trusted renderer.
 *
 * Public surface used by the compiler's `families/registry.ts`:
 *   validateListingsRecipe(input)          -> typed recipe
 *   getListingsAssetRequirements(recipe)   -> AssetRequirement[] (always empty: no images)
 *   renderListings(recipe, resolvedPaths)  -> HTML string
 *
 * Every class string is taken from one of the page kind's own vendored HyperUI blocks
 * (`LISTINGS_BLOCKS` in slots.ts), so the compiled `css/listings.css` covers it;
 * `render.test.ts` checks that. HyperUI has no search field or result card, so the search row
 * reuses `marketing/ctas/2`'s input and button classes and the result card reuses the bordered
 * card of `marketing/feature-grids/*`. The search field is a real `<input type="search" readonly>`
 * with no form around it: the page has no script and its CSP forbids form submission, so it takes
 * no query. Its `queryPlaceholder` text slot is the input's `placeholder` attribute; the input
 * carries the slot's `data-od-id` (see `findListingsTextSlot`).
 *
 * Every text slot sits in an element carrying `data-od-id`, emitted in `SECTIONS` order.
 *
 * Sample data: the results cards, the comparison cells and the featured facts are illustrative
 * (`x-mock` in the schema, `LISTINGS_MOCK_SLOTS`). Each of those sections carries
 * `data-od-mock="sample-data"` and shows the fixed `SAMPLE_DATA_CAPTION` (template copy, not a
 * slot: no `data-od-id`) as a visible caption (`data-od-mock="caption"`) placed before its first
 * sample card, row or value.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { AssetRequirement } from '../../assets.ts';
import { presentSections } from '../../sections.ts';
import { parseListingsRecipe, type ListingsRecipe, type ListingsSection } from './contract.ts';
import {
  CATEGORIES_SECTION_ID, COMPARE_SECTION_ID, FEATURED_SECTION_ID, FILTERS_SECTION_ID, FOOTER_SECTION_ID,
  HEADER_SECTION_ID, INQUIRY_SECTION_ID, RESULTS_SECTION_ID, REVIEWS_SECTION_ID, SAMPLE_DATA_CAPTION, SEARCH_SECTION_ID,
} from './slots.ts';

/** Every content section id that could be a nav target, in fixed page order (never header/footer
 * themselves) — see restaurant's `NAV_TARGET_ORDER` for the pattern this mirrors (G5). `reviews`
 * is optional and dropped from this list when the brief carries none. */
export const NAV_TARGET_ORDER = [CATEGORIES_SECTION_ID, FILTERS_SECTION_ID, RESULTS_SECTION_ID, COMPARE_SECTION_ID, FEATURED_SECTION_ID, REVIEWS_SECTION_ID];

/** Fixed nav labels, keyed by the section id each one names — never model text (G5 round 2). */
export const NAV_LABELS: Record<string, string> = {
  [CATEGORIES_SECTION_ID]: 'Categories', [FILTERS_SECTION_ID]: 'Filters', [RESULTS_SECTION_ID]: 'Listings',
  [COMPARE_SECTION_ID]: 'Compare', [FEATURED_SECTION_ID]: 'Featured', [REVIEWS_SECTION_ID]: 'Reviews',
};

const HERE = import.meta.dirname;
const HYPERUI_CSS = path.join(HERE, '../../catalog/hyperui/listings.css');
let hyperuiCss: string | undefined;
/** The compiled Tailwind build for this page kind's blocks, read once and inlined once per page. */
function inlinedStyles(): string {
  hyperuiCss ??= readFileSync(HYPERUI_CSS, 'utf8');
  return hyperuiCss;
}

export function validateListingsRecipe(input: unknown): ListingsRecipe {
  return parseListingsRecipe(input);
}

/** No image, font or video assets. */
export function getListingsAssetRequirements(_recipe: ListingsRecipe): AssetRequirement[] {
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
/** The one text slot held in an attribute: a read-only search input whose placeholder is the slot. */
function searchField(className: string, id: string, placeholder: string): string {
  return `<input type="search" readonly class="${className}" placeholder="${e(placeholder)}" aria-label="${e(placeholder)}" data-od-id="${id}">`;
}
/** A nullable atom: nothing at all when the brief states no such fact. */
function atom(tag: string, className: string, id: string, value: string | null): string {
  return value === null ? '' : slot(tag, className, id, value);
}
/** The visible sample-data caption: the fixed template sentence, before every sample value. */
function sampleCaption(className: string): string {
  return `<p class="${className}" data-od-mock="caption">${e(SAMPLE_DATA_CAPTION)}</p>`;
}
/** The opening of a section whose items are sample data. */
function sampleSection(s: ListingsSection, extra = ''): string {
  return `<section id="${s.id}"${extra} data-od-mock="sample-data">`;
}
const str = (record: Record<string, unknown>, name: string) => record[name] as string;
const strs = (record: Record<string, unknown>, name: string) => record[name] as string[];
const nullable = (record: Record<string, unknown>, name: string) => record[name] as string | null;
const items = (s: ListingsSection) => s.items ?? [];

const WRAP = 'mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8';
const H2 = 'text-2xl font-semibold text-gray-900 sm:text-3xl';
const GRID_ICON = '<svg aria-hidden="true" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="size-6"><path stroke-linecap="round" stroke-linejoin="round" d="M3.75 6A2.25 2.25 0 0 1 6 3.75h2.25A2.25 2.25 0 0 1 10.5 6v2.25a2.25 2.25 0 0 1-2.25 2.25H6a2.25 2.25 0 0 1-2.25-2.25V6Zm0 9.75A2.25 2.25 0 0 1 6 13.5h2.25a2.25 2.25 0 0 1 2.25 2.25V18a2.25 2.25 0 0 1-2.25 2.25H6A2.25 2.25 0 0 1 3.75 18v-2.25ZM13.5 6a2.25 2.25 0 0 1 2.25-2.25H18A2.25 2.25 0 0 1 20.25 6v2.25A2.25 2.25 0 0 1 18 10.5h-2.25a2.25 2.25 0 0 1-2.25-2.25V6Zm0 9.75a2.25 2.25 0 0 1 2.25-2.25H18a2.25 2.25 0 0 1 2.25 2.25V18A2.25 2.25 0 0 1 18 20.25h-2.25A2.25 2.25 0 0 1 13.5 18v-2.25Z"/></svg>';
const CHEVRON = '<span class="transition-transform group-open:-rotate-180"><svg aria-hidden="true" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="size-4"><path stroke-linecap="round" stroke-linejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5"/></svg></span>';

function renderHeader(s: ListingsSection, recipe: ListingsRecipe): string {
  const renderedIds = new Set(presentSections(recipe.sections).map((section) => section.id));
  const targets = NAV_TARGET_ORDER.filter((id) => renderedIds.has(id)).slice(0, 4);
  const links = targets.map((target, index) => {
    const classes = index === 0
      ? 'border-b-2 border-blue-600 px-4 py-2 text-sm font-medium text-blue-600 transition-colors hover:text-blue-700'
      : 'border-b-2 border-transparent px-4 py-2 text-sm font-medium text-gray-600 transition-colors hover:text-gray-700';
    return `<li><a href="#${target}" class="${classes}">${e(NAV_LABELS[target]!)}</a></li>`;
  }).join('');
  return `<header id="${s.id}" class="border-b border-gray-200 bg-white"><div class="${WRAP}"><div class="flex flex-wrap items-center justify-between gap-4">`
    + slot('p', 'text-lg font-semibold text-gray-900', 'brand--name', recipe.brand.name)
    + slot('p', 'sr-only', 'brand--descriptor', recipe.brand.descriptor)
    + `<nav><ul class="flex flex-wrap gap-2">${links}</ul></nav>`
    + `<a href="#${INQUIRY_SECTION_ID}" class="rounded-full bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700" data-od-id="${s.id}--cta">${e(str(s.text, 'cta'))}</a>`
    + `</div></div></header>`;
}

function renderSearch(s: ListingsSection): string {
  return `<section id="${s.id}"><div class="${WRAP}"><div class="max-w-prose">`
    + slot('p', 'text-sm font-medium text-blue-600', `${s.id}--eyebrow`, str(s.text, 'eyebrow'))
    + slot('h1', `mt-2 ${H2}`, `${s.id}--heading`, str(s.text, 'heading'))
    + slot('p', 'mt-4 text-pretty text-gray-700', `${s.id}--body`, str(s.text, 'body'))
    + `</div><div class="mx-auto mt-8 max-w-xl sm:flex sm:gap-4" role="search"><div class="sm:flex-1">`
    + searchField('w-full rounded-md border border-gray-200 bg-white p-3 text-gray-500 shadow-xs', `${s.id}--queryPlaceholder`, str(s.text, 'queryPlaceholder'))
    + `</div><a href="#${RESULTS_SECTION_ID}" class="group mt-4 flex w-full items-center justify-center gap-2 rounded-md bg-blue-600 px-5 py-3 text-sm font-medium text-white transition hover:bg-blue-700 sm:mt-0 sm:w-auto" data-od-id="${s.id}--searchCta">${e(str(s.text, 'searchCta'))}</a>`
    + `</div></div></section>`;
}

function renderCategories(s: ListingsSection): string {
  const cards = items(s).map((item, index) => `<div class="text-center"><div class="inline-flex rounded-lg bg-gray-100 p-3 text-gray-700">${GRID_ICON}</div>`
    + slot('h3', 'mt-4 text-lg font-semibold text-gray-900', `${s.id}--items-${index}--title`, str(item, 'title'))
    + slot('p', 'mt-2 text-pretty text-gray-700', `${s.id}--items-${index}--blurb`, str(item, 'blurb'))
    + `</div>`).join('');
  return `<section id="${s.id}"><div class="${WRAP}">`
    + slot('h2', H2, `${s.id}--heading`, str(s.text, 'heading'))
    + `<div class="mt-8 grid grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-4">${cards}</div></div></section>`;
}

function renderFilters(s: ListingsSection): string {
  const groups = items(s).map((item, index) => {
    const options = strs(item, 'options').map((option, index2) => `<label for="${s.id}-${index}-${index2}" class="inline-flex items-center gap-3">`
      + `<input type="checkbox" class="size-5 rounded border-gray-300 shadow-sm" id="${s.id}-${index}-${index2}">`
      + slot('span', 'text-sm font-medium text-gray-700', `${s.id}--items-${index}--options-${index2}`, option)
      + `</label>`).join('');
    return `<details class="group relative"><summary class="flex items-center gap-2 border-b border-gray-300 pb-1 text-gray-700 transition-colors hover:border-gray-400 hover:text-gray-900 [&amp;::-webkit-details-marker]:hidden">`
      + slot('span', 'text-sm font-medium', `${s.id}--items-${index}--label`, str(item, 'label'))
      + `${CHEVRON}</summary>`
      + `<div class="z-auto w-64 divide-y divide-gray-300 rounded border border-gray-300 bg-white shadow-sm group-open:absolute group-open:start-0 group-open:top-8">`
      + `<fieldset class="p-3"><div class="flex flex-col items-start gap-3">${options}</div></fieldset></div></details>`;
  }).join('');
  return `<section id="${s.id}"><div class="${WRAP}">`
    + slot('h2', H2, `${s.id}--heading`, str(s.text, 'heading'))
    + `<div class="mt-8 flex flex-wrap gap-4 sm:gap-6">${groups}</div></div></section>`;
}

function renderResults(s: ListingsSection): string {
  // Sort chips are inert labels, not working sort controls, on this one-page reference build: no
  // pill shape, no button chrome, no hover, so nothing looks clickable without being clickable
  // (G5 round 2). A round-3 Grok audit found the round-2 fix still carried rounded-full/bg-gray/
  // px-4/py-2, so it still looked like a chip even with no click handler.
  const sorts = strs(s.text, 'sorts').map((sort, index) => slot('span', index === 0
    ? 'text-sm font-semibold text-gray-900'
    : 'text-sm text-gray-700', `${s.id}--sorts-${index}`, sort)).join('');
  const cards = items(s).map((item, index) => `<article class="rounded-lg border border-gray-200 p-6">`
    + slot('p', 'text-xs text-gray-500', `${s.id}--items-${index}--location`, str(item, 'location'))
    + slot('h3', 'mt-1 text-lg font-semibold text-gray-900', `${s.id}--items-${index}--title`, str(item, 'title'))
    + slot('p', 'mt-3 text-sm font-medium text-gray-900', `${s.id}--items-${index}--price`, str(item, 'price'))
    + slot('p', 'mt-1 text-gray-700', `${s.id}--items-${index}--summary`, str(item, 'summary'))
    + `</article>`).join('');
  return `${sampleSection(s)}<div class="${WRAP}"><div class="flex flex-wrap items-center justify-between gap-4">`
    + slot('h2', H2, `${s.id}--heading`, str(s.text, 'heading'))
    + `<div class="flex flex-wrap gap-2">${sorts}</div></div>`
    + sampleCaption('mt-4 text-sm font-medium text-gray-500')
    + `<div class="mt-8 grid grid-cols-1 gap-8 md:grid-cols-2">${cards}</div></div></section>`;
}

function renderCompare(s: ListingsSection): string {
  const head = strs(s.text, 'columns').map((column, index) => slot('th', 'px-3 py-2 whitespace-nowrap', `${s.id}--columns-${index}`, column)).join('');
  const rows = items(s).map((item, index) => `<tr class="*:text-gray-900 *:first:font-medium">`
    + strs(item, 'cells').map((cell, index2) => slot('td', 'px-3 py-2 whitespace-nowrap', `${s.id}--items-${index}--cells-${index2}`, cell)).join('')
    + `</tr>`).join('');
  return `${sampleSection(s)}<div class="${WRAP}">`
    + slot('h2', H2, `${s.id}--heading`, str(s.text, 'heading'))
    + sampleCaption('mt-4 text-sm font-medium text-gray-500')
    + `<div class="mt-8 overflow-x-auto"><table class="min-w-full divide-y-2 divide-gray-200">`
    + `<thead class="ltr:text-left rtl:text-right"><tr class="*:font-medium *:text-gray-900">${head}</tr></thead>`
    + `<tbody class="divide-y divide-gray-200 *:even:bg-gray-50">${rows}</tbody></table></div></div></section>`;
}

function renderFeatured(s: ListingsSection): string {
  const facts = items(s).map((item, index) => `<div class="grid grid-cols-1 gap-1 py-3 sm:grid-cols-3 sm:gap-4">`
    + slot('dt', 'font-medium text-gray-900', `${s.id}--items-${index}--label`, str(item, 'label'))
    + slot('dd', 'text-gray-700 sm:col-span-2', `${s.id}--items-${index}--value`, str(item, 'value'))
    + `</div>`).join('');
  return `${sampleSection(s)}<div class="${WRAP}"><div class="grid grid-cols-1 gap-8 md:grid-cols-2"><div class="col-span-1">`
    + slot('h2', 'text-3xl/tight font-bold text-gray-900 sm:text-4xl', `${s.id}--heading`, str(s.text, 'heading'))
    + slot('p', 'mt-4 text-lg text-pretty text-gray-700', `${s.id}--body`, str(s.text, 'body'))
    + `</div><div class="col-span-1">`
    + sampleCaption('text-sm font-medium text-gray-500')
    + `<div class="mt-8 flow-root"><dl class="-my-3 divide-y divide-gray-200 text-sm">${facts}</dl></div></div></div></div></section>`;
}

function renderReviews(s: ListingsSection): string {
  const reviews = items(s).map((item, index) => `<li class="rounded-lg border border-gray-200 p-6">`
    + slot('p', 'text-sm font-medium text-gray-900', `${s.id}--items-${index}--title`, str(item, 'title'))
    + slot('p', 'mt-1 text-sm text-gray-600', `${s.id}--items-${index}--quote`, str(item, 'quote'))
    + atom('p', 'mt-3 text-xs text-gray-500', `${s.id}--items-${index}--name`, nullable(item, 'name'))
    + `</li>`).join('');
  return `<section id="${s.id}"><div class="${WRAP}"><div class="mx-auto max-w-2xl">`
    + slot('h2', H2, `${s.id}--heading`, str(s.text, 'heading'))
    + `<ul class="mt-8 space-y-4">${reviews}</ul></div></div></section>`;
}

function renderInquiry(s: ListingsSection): string {
  const phone = nullable(s.text, 'phone');
  const email = nullable(s.text, 'email');
  const contact = phone === null && email === null ? ''
    : `<div class="mt-8 flex flex-wrap justify-center gap-4 text-sm">`
      + atom('p', 'text-gray-700', `${s.id}--phone`, phone)
      + atom('p', 'text-gray-700', `${s.id}--email`, email)
      + `</div>`;
  // The inquiry CTA needs a real destination (G5 round 2: `href="#${s.id}"` was a dead button on
  // the section it already sits in). This same section's own phone or email atom is the real
  // destination when the brief supplies one; with neither, the label renders as plain text.
  const destination = phone !== null ? `tel:${phone.replace(/[ ()-]/g, '')}` : email !== null ? `mailto:${email}` : null;
  const cta = destination === null
    ? slot('span', 'inline-block text-sm font-medium text-gray-700', `${s.id}--cta`, str(s.text, 'cta'))
    : `<a href="${e(destination)}" class="inline-block rounded-sm bg-blue-600 px-12 py-3 text-sm font-medium text-white transition hover:bg-blue-700" data-od-id="${s.id}--cta">${e(str(s.text, 'cta'))}</a>`;
  return `<section id="${s.id}" class="overflow-hidden bg-gray-50 sm:grid"><div class="p-8 md:p-12 lg:px-16 lg:py-24"><div class="mx-auto max-w-xl text-center">`
    + slot('h2', 'text-2xl font-bold text-gray-900 md:text-3xl', `${s.id}--heading`, str(s.text, 'heading'))
    + slot('p', 'text-gray-500 md:mt-4', `${s.id}--body`, str(s.text, 'body'))
    + `<div class="mt-4 md:mt-8">${cta}</div>`
    + contact
    + `</div></div></section>`;
}

function renderFooter(s: ListingsSection): string {
  // Legal-style footer labels never had a real page behind them (G5): plain text, never an <a>.
  const links = strs(s.text, 'links').map((link, index) => `<li>${slot('span', 'text-gray-500', `${s.id}--links-${index}`, link)}</li>`).join('');
  return `<footer id="${s.id}" class="bg-white"><div class="mx-auto max-w-7xl px-4 pt-16 pb-8 sm:px-6 lg:px-8 lg:pt-24"><div class="text-center">`
    + slot('p', 'mx-auto mt-4 max-w-sm text-gray-500', `${s.id}--tagline`, str(s.text, 'tagline'))
    + `</div><div class="mt-16 border-t border-gray-100 pt-8 sm:flex sm:items-center sm:justify-between lg:mt-24">`
    + `<ul class="flex flex-wrap justify-center gap-4 text-xs lg:justify-end">${links}</ul>`
    + atom('p', 'mt-8 text-center text-xs text-gray-500 sm:mt-0', `${s.id}--address`, nullable(s.text, 'address'))
    + `</div></div></footer>`;
}

const RENDERERS: Record<string, (s: ListingsSection, recipe: ListingsRecipe) => string> = {
  [HEADER_SECTION_ID]: renderHeader,
  [SEARCH_SECTION_ID]: renderSearch,
  [CATEGORIES_SECTION_ID]: renderCategories,
  [FILTERS_SECTION_ID]: renderFilters,
  [RESULTS_SECTION_ID]: renderResults,
  [COMPARE_SECTION_ID]: renderCompare,
  [FEATURED_SECTION_ID]: renderFeatured,
  [REVIEWS_SECTION_ID]: renderReviews,
  [INQUIRY_SECTION_ID]: renderInquiry,
  [FOOTER_SECTION_ID]: renderFooter,
};

export function renderListings(recipe: ListingsRecipe, _resolvedAssetPaths: Record<string, string>): string {
  // A dropped optional section (a null slot) renders nothing at all.
  const body = presentSections(recipe.sections).map((section) => RENDERERS[section.id]!(section, recipe)).join('');
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'none'; style-src 'unsafe-inline'; script-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'">`
    + `<meta name="description" content="${e(recipe.brand.descriptor)}">`
    + `<title>${e(recipe.brand.name)}</title><style>${inlinedStyles()}</style></head>`
    + `<body class="bg-white">${body}</body></html>\n`;
}

/** Read one text slot back out of saved HTML by its data-od-id. */
export function findListingsTextSlot(html: string, odId: string): string | undefined {
  if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(odId)) throw new Error('data-od-id: expected letters, digits and hyphens only');
  // The search field is a void <input>: its text slot is the placeholder attribute.
  const input = new RegExp(`<input\\b[^>]*\\splaceholder="([^"]*)"[^>]*\\sdata-od-id="${odId}"[^>]*>`, 'i').exec(html);
  if (input) return input[1]!.replace(/&(amp|lt|gt|quot|#39);/g, (_, name: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" }[name]!));
  const pattern = new RegExp(`<([a-z0-9]+)\\b[^>]*\\sdata-od-id="${odId}"[^>]*>([\\s\\S]*?)</\\1>`, 'i');
  const match = pattern.exec(html);
  return match ? match[2]!.replace(/<[^>]*>/g, '').trim() : undefined;
}

/** Every data-od-id present in saved HTML, in document order. */
export function listListingsTextSlots(html: string): string[] {
  return [...html.matchAll(/data-od-id="([^"]+)"/g)].map((match) => match[1]!);
}

export { SECTION_ORDER, LISTINGS_MOCK_SLOTS, LISTINGS_NULLABLE_ATOMS, LISTINGS_OPTIONAL_SECTIONS } from './slots.ts';
