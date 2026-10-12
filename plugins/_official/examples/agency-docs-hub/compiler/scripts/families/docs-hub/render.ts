/**
 * docs-hub family — trusted renderer.
 *
 * Public surface used by the compiler's `families/registry.ts`:
 *   validateDocsHubRecipe(input)          -> typed recipe
 *   getDocsHubAssetRequirements(recipe)   -> AssetRequirement[] (always empty: no images)
 *   renderDocsHub(recipe, resolvedPaths)  -> HTML string
 *
 * Every class string is taken from one of the page kind's own vendored HyperUI blocks
 * (`DOCS_HUB_BLOCKS` in slots.ts), so the compiled `css/docs-hub.css` covers it; `render.test.ts`
 * checks that. The header's search field is a static mock (a labelled, styled paragraph carrying
 * its placeholder text), not an `<input>`, and the code sample is one fixed `<pre>` literal, never
 * a recipe slot: the page has no script, its CSP forbids form submission, and there is no
 * model-written code anywhere on the page.
 *
 * Every text slot sits in an element carrying `data-od-id`, emitted in `SECTIONS` order.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { AssetRequirement } from '../../assets.ts';
import { presentSections } from '../../sections.ts';
import { EMAIL, parseDocsHubRecipe, type DocsHubRecipe, type DocsHubSection } from './contract.ts';
import {
  API_SECTION_ID, CHANGELOG_SECTION_ID, CODE_SAMPLE_SECTION_ID, COMMUNITY_SECTION_ID, FOOTER_SECTION_ID,
  GUIDES_SECTION_ID, HEADER_SECTION_ID, HERO_SECTION_ID, QUICKSTART_SECTION_ID,
} from './slots.ts';

const HERE = import.meta.dirname;
const HYPERUI_CSS = path.join(HERE, '../../catalog/hyperui/docs-hub.css');
let hyperuiCss: string | undefined;
/** The compiled Tailwind build for this page kind's blocks, read once and inlined once per page. */
function inlinedStyles(): string {
  hyperuiCss ??= readFileSync(HYPERUI_CSS, 'utf8');
  return hyperuiCss;
}

export function validateDocsHubRecipe(input: unknown): DocsHubRecipe {
  return parseDocsHubRecipe(input);
}

/** No image, font or video assets. */
export function getDocsHubAssetRequirements(_recipe: DocsHubRecipe): AssetRequirement[] {
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
/** A nullable atom: nothing at all when the brief states no such fact. */
function atom(tag: string, className: string, id: string, value: string | null): string {
  return value === null ? '' : slot(tag, className, id, value);
}
// The mail link is DERIVED from the filled, contract-validated email text at render time, never
// read from anywhere else — the model never writes an href directly. Re-checked here against the
// same `EMAIL` pattern contract.ts already validated it against (imported, not a second regex),
// so the two can never silently diverge. No atom, or text that somehow fails it: no link.
function mailtoHref(value: string | null): string | null {
  if (value === null) return null;
  return EMAIL.test(value) ? `mailto:${value}` : null;
}
/** A nullable email atom: an `<a href="mailto:...">` whose href is exactly the filled address,
 * when non-null; nothing at all when null. Every other atom stays plain text. */
function emailAtom(className: string, id: string, value: string | null): string {
  if (value === null) return '';
  const href = mailtoHref(value);
  // contract.ts already refused any non-null value that fails EMAIL before this ever runs, and
  // mailtoHref re-checks the identical pattern (imported, not a second regex) — so href === null
  // here can only mean the two have diverged. That is a bug, not a legitimate "render as text"
  // case: fail loudly rather than silently downgrade a validated email atom to plain text.
  if (href === null) throw new Error(`${id}: contract.ts validated this as an EMAIL atom but mailtoHref rejected it — EMAIL and mailtoHref have diverged`);
  return `<a href="${e(href)}" class="${e(className)}" data-od-id="${id}">${e(value)}</a>`;
}
const str = (record: Record<string, unknown>, name: string) => record[name] as string;
const strs = (record: Record<string, unknown>, name: string) => record[name] as string[];
const nullable = (record: Record<string, unknown>, name: string) => record[name] as string | null;
const items = (s: DocsHubSection) => s.items ?? [];

const WRAP = 'mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8';
const H2 = 'text-2xl font-semibold text-gray-900 md:text-3xl';

/** The one fixed placeholder code sample. Static, non-reconcilable, never a recipe slot. */
const CODE_SAMPLE = 'npm install\nnpm run build';

/** Every content section id that could be a nav target, in fixed page order (never header or
 * footer) — see restaurant's `NAV_TARGET_ORDER` for the pattern this mirrors (G5). `changelog`
 * and `community` are optional and dropped from this list when the brief carries neither. */
export const NAV_TARGET_ORDER = [QUICKSTART_SECTION_ID, GUIDES_SECTION_ID, API_SECTION_ID, CODE_SAMPLE_SECTION_ID, CHANGELOG_SECTION_ID, COMMUNITY_SECTION_ID];

/** Fixed nav labels, keyed by the section id each one names — never model text (G5 round 2). */
export const NAV_LABELS: Record<string, string> = {
  [QUICKSTART_SECTION_ID]: 'Quickstart', [GUIDES_SECTION_ID]: 'Guides', [API_SECTION_ID]: 'API reference',
  [CODE_SAMPLE_SECTION_ID]: 'Code sample', [CHANGELOG_SECTION_ID]: 'Changelog', [COMMUNITY_SECTION_ID]: 'Community',
};

function renderHeader(s: DocsHubSection, recipe: DocsHubRecipe): string {
  const renderedIds = new Set(presentSections(recipe.sections).map((section) => section.id));
  const targets = NAV_TARGET_ORDER.filter((id) => renderedIds.has(id)).slice(0, 3);
  const links = targets.map((target, index) => {
    const classes = index === 0
      ? 'border-b-2 border-blue-600 px-4 py-2 text-sm font-medium text-blue-600 transition-colors hover:text-blue-700'
      : 'border-b-2 border-transparent px-4 py-2 text-sm font-medium text-gray-600 transition-colors hover:text-gray-700';
    return `<li><a href="#${target}" class="${classes}">${e(NAV_LABELS[target]!)}</a></li>`;
  }).join('');
  return `<header id="${s.id}" class="border-b-2 border-gray-100 bg-white"><div class="${WRAP}"><div class="sm:flex sm:items-center sm:justify-between">`
    + slot('p', 'text-2xl font-bold text-gray-900', 'brand--name', recipe.brand.name)
    + slot('p', 'sr-only', 'brand--descriptor', recipe.brand.descriptor)
    + `<nav><ul class="mt-4 flex flex-wrap gap-2 sm:mt-0">${links}</ul></nav>`
    + `</div><div class="mt-4 sm:flex sm:items-center sm:gap-4">`
    + `<label for="${s.id}-search-mock" class="sr-only" data-od-id="${s.id}--searchLabel">${e(str(s.text, 'searchLabel'))}</label>`
    + `<p id="${s.id}-search-mock" class="w-full rounded-lg border border-gray-300 p-2 text-sm text-gray-700" data-od-id="${s.id}--searchPlaceholder">${e(str(s.text, 'searchPlaceholder'))}</p>`
    + `<a href="#${QUICKSTART_SECTION_ID}" class="mt-4 inline-block rounded-sm bg-emerald-600 px-6 py-2 text-sm font-medium text-white transition hover:bg-emerald-700 sm:mt-0" data-od-id="${s.id}--cta">${e(str(s.text, 'cta'))}</a>`
    + `</div></div></header>`;
}

function renderHero(s: DocsHubSection): string {
  return `<section id="${s.id}" class="overflow-hidden bg-gray-50 sm:grid"><div class="p-8 md:p-12 lg:px-16 lg:py-24"><div class="mx-auto max-w-xl text-center ltr:sm:text-left rtl:sm:text-right">`
    + slot('h1', 'text-2xl font-bold text-gray-900 md:text-3xl', `${s.id}--heading`, str(s.text, 'heading'))
    + slot('p', 'hidden text-gray-500 md:mt-4 md:block', `${s.id}--body`, str(s.text, 'body'))
    + `<div class="mt-4 md:mt-8"><a href="#${QUICKSTART_SECTION_ID}" class="inline-block rounded-sm bg-emerald-600 px-12 py-3 text-sm font-medium text-white transition hover:bg-emerald-700 focus:ring-2 focus:ring-yellow-400 focus:outline-hidden" data-od-id="${s.id}--cta">${e(str(s.text, 'cta'))}</a></div>`
    + `</div></div></section>`;
}

function renderQuickstart(s: DocsHubSection): string {
  const steps = items(s).map((item, index) => `<div class="grid grid-cols-1 gap-1 p-3 sm:grid-cols-3 sm:gap-4">`
    + slot('dt', 'font-medium text-gray-900', `${s.id}--items-${index}--title`, str(item, 'title'))
    + slot('dd', 'text-gray-700 sm:col-span-2', `${s.id}--items-${index}--description`, str(item, 'description'))
    + `</div>`).join('');
  return `<section id="${s.id}"><div class="${WRAP}">`
    + slot('h2', H2, `${s.id}--heading`, str(s.text, 'heading'))
    + `<div class="mt-8 flow-root"><dl class="-my-3 divide-y divide-gray-200 rounded border border-gray-200 text-sm">${steps}</dl></div>`
    + `</div></section>`;
}

function renderGuides(s: DocsHubSection): string {
  const cards = items(s).map((item, index) => `<div class="rounded-lg border border-gray-200 p-6">`
    + slot('h3', 'mt-4 text-lg font-semibold text-gray-900', `${s.id}--items-${index}--title`, str(item, 'title'))
    + slot('p', 'mt-2 text-pretty text-gray-700', `${s.id}--items-${index}--description`, str(item, 'description'))
    + `</div>`).join('');
  return `<section id="${s.id}"><div class="${WRAP}"><div class="mx-auto max-w-lg text-center">`
    + slot('h2', 'text-3xl/tight font-bold text-gray-900 sm:text-4xl', `${s.id}--heading`, str(s.text, 'heading'))
    + slot('p', 'mt-4 text-lg text-pretty text-gray-700', `${s.id}--body`, str(s.text, 'body'))
    + `</div><div class="mt-8 grid grid-cols-1 gap-8 md:grid-cols-3">${cards}</div></div></section>`;
}

function renderApi(s: DocsHubSection): string {
  const rows = items(s).map((item, index) => `<div class="grid grid-cols-1 gap-1 py-3 sm:grid-cols-3 sm:gap-4">`
    + slot('dt', 'font-medium text-gray-900', `${s.id}--items-${index}--name`, str(item, 'name'))
    + slot('dd', 'text-gray-700 sm:col-span-2', `${s.id}--items-${index}--description`, str(item, 'description'))
    + `</div>`).join('');
  return `<section id="${s.id}"><div class="${WRAP}">`
    + slot('h2', H2, `${s.id}--heading`, str(s.text, 'heading'))
    + `<div class="mt-8 flow-root"><dl class="-my-3 divide-y divide-gray-200 text-sm">${rows}</dl></div>`
    + `</div></section>`;
}

function renderCodeSample(s: DocsHubSection): string {
  return `<section id="${s.id}"><div class="${WRAP}">`
    + slot('h2', H2, `${s.id}--heading`, str(s.text, 'heading'))
    + `<div class="mt-8 overflow-x-auto rounded border border-gray-300 shadow-sm"><pre class="p-6 text-sm text-gray-700">${e(CODE_SAMPLE)}</pre></div>`
    + slot('p', 'mt-2 text-pretty text-gray-700', `${s.id}--caption`, str(s.text, 'caption'))
    + `</div></section>`;
}

function renderChangelog(s: DocsHubSection): string {
  const entries = items(s).map((item, index) => `<li class="relative -mt-1.5"><span class="block size-3 rounded-full bg-blue-600"></span><div class="mt-4">`
    + atom('span', 'rounded-full bg-gray-100 px-3 py-2 text-sm font-medium text-gray-700', `${s.id}--items-${index}--version`, nullable(item, 'version'))
    + atom('time', 'text-xs/none font-medium text-gray-700', `${s.id}--items-${index}--date`, nullable(item, 'date'))
    + slot('h3', 'text-lg font-bold text-gray-900', `${s.id}--items-${index}--title`, str(item, 'title'))
    + slot('p', 'mt-0.5 text-sm text-gray-700', `${s.id}--items-${index}--summary`, str(item, 'summary'))
    + `</div></li>`).join('');
  return `<section id="${s.id}"><div class="${WRAP}">`
    + slot('h2', H2, `${s.id}--heading`, str(s.text, 'heading'))
    + `<ol class="relative mt-8 flex flex-wrap gap-8 before:absolute before:-mt-px before:h-0.5 before:w-full before:rounded-full before:bg-gray-200">${entries}</ol>`
    + `</div></section>`;
}

function renderCommunity(s: DocsHubSection): string {
  return `<section id="${s.id}"><div class="${WRAP}"><div class="bg-gray-100 p-8 md:p-12 lg:px-16 lg:py-24"><div class="mx-auto max-w-xl text-center">`
    + slot('h2', 'text-2xl font-bold text-gray-900 md:text-3xl', `${s.id}--heading`, str(s.text, 'heading'))
    + slot('p', 'hidden text-gray-700 sm:mt-4 sm:block', `${s.id}--body`, str(s.text, 'body'))
    + `<div class="mt-4 flex flex-wrap gap-4 md:mt-8">`
    + emailAtom('text-sm text-gray-700', `${s.id}--supportEmail`, nullable(s.text, 'supportEmail'))
    + atom('p', 'text-sm text-gray-700', `${s.id}--communityLink`, nullable(s.text, 'communityLink'))
    + atom('p', 'text-sm text-gray-700', `${s.id}--statusLink`, nullable(s.text, 'statusLink'))
    + `</div></div></div></div></section>`;
}

function renderFooter(s: DocsHubSection): string {
  return `<footer id="${s.id}" class="bg-white"><div class="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">`
    + slot('p', 'max-w-md text-gray-500', `${s.id}--tagline`, str(s.text, 'tagline'))
    + `<div class="mt-8 border-t border-gray-100 pt-8"><ul class="flex flex-wrap justify-start gap-4 text-xs">`
    // A "Privacy"/"Terms"-style footer link never had a real page behind it in this one-page
    // reference build: plain text, never an `<a>` with no href and no real destination — nothing
    // may look clickable without being clickable (G5).
    + `<li>${atom('span', 'text-gray-500', `${s.id}--link1`, nullable(s.text, 'link1'))}</li>`
    + `<li>${atom('span', 'text-gray-500', `${s.id}--link2`, nullable(s.text, 'link2'))}</li>`
    + `<li>${atom('span', 'text-gray-500', `${s.id}--link3`, nullable(s.text, 'link3'))}</li>`
    + `</ul>`
    + emailAtom('mt-8 text-xs text-gray-500', `${s.id}--contactEmail`, nullable(s.text, 'contactEmail'))
    + `</div></div></footer>`;
}

const RENDERERS: Record<string, (s: DocsHubSection, recipe: DocsHubRecipe) => string> = {
  [HEADER_SECTION_ID]: renderHeader,
  [HERO_SECTION_ID]: renderHero,
  [QUICKSTART_SECTION_ID]: renderQuickstart,
  [GUIDES_SECTION_ID]: renderGuides,
  [API_SECTION_ID]: renderApi,
  [CODE_SAMPLE_SECTION_ID]: renderCodeSample,
  [CHANGELOG_SECTION_ID]: renderChangelog,
  [COMMUNITY_SECTION_ID]: renderCommunity,
  [FOOTER_SECTION_ID]: renderFooter,
};

export function renderDocsHub(recipe: DocsHubRecipe, _resolvedAssetPaths: Record<string, string>): string {
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
export function findDocsHubTextSlot(html: string, odId: string): string | undefined {
  if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(odId)) throw new Error('data-od-id: expected letters, digits and hyphens only');
  const pattern = new RegExp(`<([a-z0-9]+)\\b[^>]*\\sdata-od-id="${odId}"[^>]*>([\\s\\S]*?)</\\1>`, 'i');
  const match = pattern.exec(html);
  return match ? match[2]!.replace(/<[^>]*>/g, '').trim() : undefined;
}

/** Every data-od-id present in saved HTML, in document order. */
export function listDocsHubTextSlots(html: string): string[] {
  return [...html.matchAll(/data-od-id="([^"]+)"/g)].map((match) => match[1]!);
}

export { SECTION_ORDER, DOCS_HUB_NULLABLE_ATOMS, DOCS_HUB_OPTIONAL_SECTIONS } from './slots.ts';
