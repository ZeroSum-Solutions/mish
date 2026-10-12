/**
 * nonprofit family — trusted renderer.
 *
 * Public surface used by the compiler's `families/registry.ts`:
 *   validateNonprofitRecipe(input)          -> typed recipe
 *   getNonprofitAssetRequirements(recipe)   -> AssetRequirement[] (always empty: no images)
 *   renderNonprofit(recipe, resolvedPaths)  -> HTML string
 *
 * Every class string is taken from one of the page kind's own vendored HyperUI blocks
 * (`NONPROFIT_BLOCKS` in slots.ts), so the compiled `css/nonprofit.css` covers it;
 * `render.test.ts` checks that. Impact figures, named stories and dated events are optional
 * sections, and event dates, giving amounts and their periods are nullable atoms: facts a brief
 * does not state are the facts a generated page must never invent. A dropped events section takes
 * its header nav link with it.
 *
 * Every text slot sits in an element carrying `data-od-id`, emitted in `SECTIONS` order.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { AssetRequirement } from '../../assets.ts';
import { presentSections, sectionOfType } from '../../sections.ts';
import { parseNonprofitRecipe, type NonprofitRecipe, type NonprofitSection } from './contract.ts';
import {
  ACCOUNTABILITY_SECTION_ID, EVENTS_SECTION_ID, FOOTER_SECTION_ID, GIVE_SECTION_ID, HEADER_SECTION_ID, HERO_SECTION_ID,
  IMPACT_SECTION_ID, MISSION_SECTION_ID, PROGRAMS_SECTION_ID, STORIES_SECTION_ID, VOLUNTEER_SECTION_ID,
} from './slots.ts';

const HERE = import.meta.dirname;
const HYPERUI_CSS = path.join(HERE, '../../catalog/hyperui/nonprofit.css');
let hyperuiCss: string | undefined;
/** The compiled Tailwind build for this page kind's blocks, read once and inlined once per page. */
function inlinedStyles(): string {
  hyperuiCss ??= readFileSync(HYPERUI_CSS, 'utf8');
  return hyperuiCss;
}

export function validateNonprofitRecipe(input: unknown): NonprofitRecipe {
  return parseNonprofitRecipe(input);
}

/** No image, font or video assets. */
export function getNonprofitAssetRequirements(_recipe: NonprofitRecipe): AssetRequirement[] {
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
const str = (record: Record<string, unknown>, name: string) => record[name] as string;
const strs = (record: Record<string, unknown>, name: string) => record[name] as string[];
const nullable = (record: Record<string, unknown>, name: string) => record[name] as string | null;
const items = (s: NonprofitSection) => s.items ?? [];

const WRAP = 'mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8';
const H2 = 'text-2xl font-semibold text-gray-900 sm:text-3xl';
const DONATE = 'rounded-full border border-indigo-600 bg-indigo-600 px-12 py-3 text-center text-sm font-medium text-white hover:bg-indigo-700 hover:ring-1 hover:ring-indigo-700';
const OUTLINE = 'rounded-full border border-indigo-600 bg-white px-12 py-3 text-center text-sm font-medium text-indigo-600 hover:ring-1 hover:ring-indigo-600';
const HEART_ICON = '<svg aria-hidden="true" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="size-6"><path stroke-linecap="round" stroke-linejoin="round" d="M21 8.25c0-2.49-2.1-4.5-4.69-4.5-1.93 0-3.6 1.12-4.31 2.73-.72-1.61-2.38-2.73-4.31-2.73C5.1 3.75 3 5.76 3 8.25c0 7.22 9 12 9 12s9-4.78 9-12Z"/></svg>';
const QUOTE_MARK = '<svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor" class="mx-auto size-8 text-indigo-600"><path d="M7.17 6.17A5.5 5.5 0 0 0 3 11.5V18a1 1 0 0 0 1 1h6.5a1 1 0 0 0 1-1v-6a1 1 0 0 0-1-1H6.06a3.5 3.5 0 0 1 2.35-2.79 1 1 0 1 0-.62-1.9Zm10 0A5.5 5.5 0 0 0 13 11.5V18a1 1 0 0 0 1 1h6.5a1 1 0 0 0 1-1v-6a1 1 0 0 0-1-1h-4.44a3.5 3.5 0 0 1 2.35-2.79 1 1 0 1 0-.62-1.9Z"/></svg>';

/**
 * The header's nav targets, in fixed page order (never header/hero/footer/give/volunteer
 * themselves). `events` and `stories` are optional and dropped from this list when the brief
 * carries neither (G5 round 2: a Grok audit found the old index-zipped `links` list could say
 * "About us" and open the beneficiary-stories section instead — nav is now generated entirely
 * from the rendered sections themselves, with a fixed label per section, never model text).
 */
export const NAV_TARGET_ORDER = [MISSION_SECTION_ID, PROGRAMS_SECTION_ID, EVENTS_SECTION_ID, STORIES_SECTION_ID];
/** Fixed nav labels, keyed by the section id each one names — never model text. */
export const NAV_LABELS: Record<string, string> = {
  [MISSION_SECTION_ID]: 'Our mission', [PROGRAMS_SECTION_ID]: 'Programs', [EVENTS_SECTION_ID]: 'Events', [STORIES_SECTION_ID]: 'Stories',
};

function renderHeader(s: NonprofitSection, recipe: NonprofitRecipe): string {
  const renderedIds = new Set(presentSections(recipe.sections).map((section) => section.id));
  const targets = NAV_TARGET_ORDER.filter((id) => renderedIds.has(id));
  const links = targets.map((target) =>
    `<li><a href="#${target}" class="border-b-2 border-transparent px-4 py-2 text-sm font-medium text-gray-600 transition-colors hover:text-gray-700">${e(NAV_LABELS[target]!)}</a></li>`).join('');
  return `<header id="${s.id}" class="border-b-2 border-gray-100 bg-white"><div class="${WRAP}"><div class="sm:flex sm:items-center sm:justify-between">`
    + slot('p', 'text-2xl font-bold text-gray-900', 'brand--name', recipe.brand.name)
    + slot('p', 'sr-only', 'brand--descriptor', recipe.brand.descriptor)
    + `<div class="mt-4 flex flex-wrap items-center gap-4 sm:mt-0"><nav><ul class="flex flex-wrap gap-2">${links}</ul></nav>`
    + `<a href="#${GIVE_SECTION_ID}" class="${DONATE}" data-od-id="${s.id}--donateCta">${e(str(s.text, 'donateCta'))}</a>`
    + `</div></div></div></header>`;
}

function renderHero(s: NonprofitSection): string {
  return `<section id="${s.id}"><div class="${WRAP}"><div class="max-w-prose md:max-w-none">`
    + slot('p', 'text-sm font-medium text-indigo-600', `${s.id}--eyebrow`, str(s.text, 'eyebrow'))
    + slot('h1', `mt-2 ${H2}`, `${s.id}--heading`, str(s.text, 'heading'))
    + slot('p', 'mt-4 text-pretty text-gray-700', `${s.id}--body`, str(s.text, 'body'))
    + `<div class="mt-6 flex flex-wrap gap-4">`
    + `<a href="#${GIVE_SECTION_ID}" class="${DONATE}" data-od-id="${s.id}--donateCta">${e(str(s.text, 'donateCta'))}</a>`
    + `<a href="#${VOLUNTEER_SECTION_ID}" class="${OUTLINE}" data-od-id="${s.id}--volunteerCta">${e(str(s.text, 'volunteerCta'))}</a>`
    + `</div></div></div></section>`;
}

function renderMission(s: NonprofitSection): string {
  return `<section id="${s.id}" class="bg-gray-50"><div class="${WRAP}"><div class="max-w-prose">`
    + slot('h2', H2, `${s.id}--heading`, str(s.text, 'heading'))
    + slot('p', 'mt-4 text-pretty text-gray-700', `${s.id}--body`, str(s.text, 'body'))
    + `</div></div></section>`;
}

function renderPrograms(s: NonprofitSection): string {
  const cards = items(s).map((item, index) => `<div class="rounded-lg border border-gray-200 p-6"><div class="inline-flex rounded-lg bg-gray-100 p-3 text-gray-700">${HEART_ICON}</div>`
    + slot('h3', 'mt-4 text-lg font-semibold text-gray-900', `${s.id}--items-${index}--title`, str(item, 'title'))
    + slot('p', 'mt-2 text-pretty text-gray-700', `${s.id}--items-${index}--body`, str(item, 'body'))
    + `</div>`).join('');
  return `<section id="${s.id}"><div class="${WRAP}"><div class="mx-auto max-w-lg text-center">`
    + slot('h2', 'text-3xl/tight font-bold text-gray-900 sm:text-4xl', `${s.id}--heading`, str(s.text, 'heading'))
    + slot('p', 'mt-4 text-lg text-pretty text-gray-700', `${s.id}--body`, str(s.text, 'body'))
    + `</div><div class="mt-8 grid grid-cols-1 gap-8 md:grid-cols-3">${cards}</div></div></section>`;
}

function renderImpact(s: NonprofitSection): string {
  const stats = items(s).map((item, index) => `<div class="flex flex-col rounded-lg bg-blue-50 px-4 py-8 text-center">`
    + slot('dt', 'order-last text-lg font-medium text-gray-500', `${s.id}--items-${index}--label`, str(item, 'label'))
    + slot('dd', 'text-4xl font-extrabold text-blue-600 md:text-5xl', `${s.id}--items-${index}--value`, str(item, 'value'))
    + `</div>`).join('');
  return `<section id="${s.id}"><div class="mx-auto max-w-7xl px-4 py-8 sm:px-6 sm:py-12 lg:px-8"><div class="mx-auto max-w-3xl text-center">`
    + slot('h2', 'text-3xl font-bold text-gray-900 sm:text-4xl', `${s.id}--heading`, str(s.text, 'heading'))
    + slot('p', 'mt-4 text-gray-500 sm:text-xl', `${s.id}--body`, str(s.text, 'body'))
    + `</div><dl class="mt-6 grid grid-cols-1 gap-4 sm:mt-8 sm:grid-cols-2 lg:grid-cols-4">${stats}</dl></div></section>`;
}

function renderStories(s: NonprofitSection): string {
  // `name` is a nullable `x-atom: 'person-name'` (G5): a story attributed to no one still shows
  // the quote and role, just without a name in the caption.
  const stories = items(s).map((item, index) => `<figure class="mx-auto max-w-2xl text-center">${QUOTE_MARK}`
    + `<blockquote class="mt-4">${slot('p', 'text-xl font-medium text-pretty text-gray-900 sm:text-2xl', `${s.id}--items-${index}--quote`, str(item, 'quote'))}</blockquote>`
    + `<figcaption class="mt-6 flex items-center justify-center gap-3"><div class="text-left">`
    + atom('p', 'text-sm font-medium text-gray-900', `${s.id}--items-${index}--name`, nullable(item, 'name'))
    + slot('p', 'text-sm text-gray-500', `${s.id}--items-${index}--role`, str(item, 'role'))
    + `</div></figcaption></figure>`).join('');
  return `<section id="${s.id}"><div class="${WRAP}">`
    + slot('h2', `text-center ${H2}`, `${s.id}--heading`, str(s.text, 'heading'))
    + `<div class="mt-8 space-y-8">${stories}</div></div></section>`;
}

function renderAccountability(s: NonprofitSection): string {
  // Each fact is a nullable atom: a row the brief states nothing for is not rendered at all.
  const facts = items(s).map((item, index) => atom('li', 'p-3 text-gray-700', `${s.id}--items-${index}--fact`, nullable(item, 'fact'))).join('');
  return `<section id="${s.id}"><div class="${WRAP}"><div class="max-w-prose">`
    + slot('h2', H2, `${s.id}--heading`, str(s.text, 'heading'))
    + slot('p', 'mt-4 text-pretty text-gray-700', `${s.id}--body`, str(s.text, 'body'))
    + (facts ? `<ul class="mt-8 divide-y divide-gray-200 rounded border border-gray-200 text-sm">${facts}</ul>` : '')
    + `</div></div></section>`;
}

function renderEvents(s: NonprofitSection): string {
  const entries = items(s).map((item, index) => `<li class="relative -ms-1.5 flex items-start gap-4"><span class="size-3 shrink-0 rounded-full bg-blue-600"></span><div class="-mt-2">`
    + atom('time', 'text-xs/none font-medium text-gray-700', `${s.id}--items-${index}--date`, nullable(item, 'date'))
    + slot('h3', 'text-lg font-bold text-gray-900', `${s.id}--items-${index}--title`, str(item, 'title'))
    + slot('p', 'mt-0.5 text-sm text-gray-700', `${s.id}--items-${index}--body`, str(item, 'body'))
    + `</div></li>`).join('');
  return `<section id="${s.id}"><div class="${WRAP}">`
    + slot('h2', H2, `${s.id}--heading`, str(s.text, 'heading'))
    + `<ol class="relative mt-8 space-y-8 before:absolute before:-ms-px before:h-full before:w-0.5 before:rounded-full before:bg-gray-200">${entries}</ol>`
    + `</div></section>`;
}

/** The amount and its period; nothing when the brief states no amount (a period never stands alone). */
function amountLine(id: string, index: number, amount: string | null, period: string | null): string {
  if (amount === null) return '';
  return `<p class="mt-2 sm:mt-4">`
    + slot('strong', 'text-3xl font-bold text-gray-900 sm:text-4xl', `${id}--items-${index}--amount`, amount)
    + (period === null ? '' : ' ' + slot('span', 'text-sm font-medium text-gray-700', `${id}--items-${index}--period`, period))
    + `</p>`;
}

/**
 * The organization's own real contact (phone, else email, else nothing), read from the footer —
 * the only place this family states one. Reused for the donate-tier and volunteer buttons (G5
 * round 2: `href="#${s.id}"` on each was a dead button on the section it already sits in); a
 * real phone or email number is still that section's own honest destination even though it is
 * declared elsewhere on the page.
 */
function orgDestination(recipe: NonprofitRecipe): string | null {
  const footer = sectionOfType(recipe, 'footer');
  if (!footer) return null;
  const phone = nullable(footer.text, 'phone');
  if (phone !== null) return `tel:${phone.replace(/[ ()-]/g, '')}`;
  const email = nullable(footer.text, 'email');
  return email !== null ? `mailto:${email}` : null;
}

function renderGive(s: NonprofitSection, recipe: NonprofitRecipe): string {
  const destination = orgDestination(recipe);
  const tiers = items(s).map((item, index) => {
    const featured = index === items(s).length - 1;
    const cta = destination === null
      ? slot('span', 'mt-8 block text-center text-sm font-medium text-gray-700', `${s.id}--items-${index}--cta`, str(item, 'cta'))
      : `<a href="${e(destination)}" class="mt-8 block ${featured ? DONATE : OUTLINE}" data-od-id="${s.id}--items-${index}--cta">${e(str(item, 'cta'))}</a>`;
    return `<div class="${featured ? 'rounded-2xl border border-indigo-600 p-6 shadow-xs ring-1 ring-indigo-600 sm:px-8 lg:p-12' : 'rounded-2xl border border-gray-200 p-6 shadow-xs sm:px-8 lg:p-12'}"><div class="text-center">`
      + slot('h3', 'text-lg font-medium text-gray-900', `${s.id}--items-${index}--name`, str(item, 'name'))
      + amountLine(s.id, index, nullable(item, 'amount'), nullable(item, 'period'))
      + `</div>`
      + slot('p', 'mt-6 text-center text-gray-700', `${s.id}--items-${index}--impact`, str(item, 'impact'))
      + `${cta}</div>`;
  }).join('');
  return `<section id="${s.id}"><div class="mx-auto max-w-3xl px-4 py-8 sm:px-6 sm:py-12 lg:px-8"><div class="text-center">`
    + slot('h2', H2, `${s.id}--heading`, str(s.text, 'heading'))
    + slot('p', 'mt-4 text-pretty text-gray-700', `${s.id}--body`, str(s.text, 'body'))
    + `</div><div class="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 sm:items-center md:gap-8">${tiers}</div></div></section>`;
}

function renderVolunteer(s: NonprofitSection, recipe: NonprofitRecipe): string {
  const destination = orgDestination(recipe);
  const cta = destination === null
    ? slot('span', 'inline-block text-sm font-medium text-gray-700', `${s.id}--cta`, str(s.text, 'cta'))
    : `<a href="${e(destination)}" class="inline-block rounded-sm bg-indigo-600 px-12 py-3 text-sm font-medium text-white transition hover:bg-indigo-700" data-od-id="${s.id}--cta">${e(str(s.text, 'cta'))}</a>`;
  return `<section id="${s.id}" class="bg-gray-50"><div class="p-8 md:p-12 lg:px-16 lg:py-24"><div class="mx-auto max-w-lg text-center">`
    + slot('h2', 'text-2xl font-bold text-gray-900 md:text-3xl', `${s.id}--heading`, str(s.text, 'heading'))
    + slot('p', 'text-gray-500 sm:mt-4', `${s.id}--body`, str(s.text, 'body'))
    + `<div class="mt-4 md:mt-8">${cta}</div>`
    + `</div></div></section>`;
}

function renderFooter(s: NonprofitSection): string {
  // Legal-style footer labels never had a real page behind them (G5): plain text, never an <a>.
  const links = strs(s.text, 'links').map((link, index) => `<li>${slot('span', 'text-gray-500', `${s.id}--links-${index}`, link)}</li>`).join('');
  const contact = atom('p', 'text-xs text-gray-500', `${s.id}--address`, nullable(s.text, 'address'))
    + atom('p', 'text-xs text-gray-500', `${s.id}--phone`, nullable(s.text, 'phone'))
    + atom('p', 'text-xs text-gray-500', `${s.id}--email`, nullable(s.text, 'email'));
  return `<footer id="${s.id}" class="bg-white"><div class="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">`
    + slot('p', 'max-w-prose text-gray-500', `${s.id}--tagline`, str(s.text, 'tagline'))
    + `<div class="mt-8 border-t border-gray-100 pt-8"><div class="sm:flex sm:justify-between">`
    + `<ul class="flex flex-wrap justify-start gap-4 text-xs">${links}</ul>`
    + (contact ? `<div class="mt-8 space-y-4 sm:mt-0">${contact}</div>` : '')
    + `</div></div></div></footer>`;
}

const RENDERERS: Record<string, (s: NonprofitSection, recipe: NonprofitRecipe) => string> = {
  [HEADER_SECTION_ID]: renderHeader,
  [HERO_SECTION_ID]: renderHero,
  [MISSION_SECTION_ID]: renderMission,
  [PROGRAMS_SECTION_ID]: renderPrograms,
  [IMPACT_SECTION_ID]: renderImpact,
  [STORIES_SECTION_ID]: renderStories,
  [ACCOUNTABILITY_SECTION_ID]: renderAccountability,
  [EVENTS_SECTION_ID]: renderEvents,
  [GIVE_SECTION_ID]: renderGive,
  [VOLUNTEER_SECTION_ID]: renderVolunteer,
  [FOOTER_SECTION_ID]: renderFooter,
};

export function renderNonprofit(recipe: NonprofitRecipe, _resolvedAssetPaths: Record<string, string>): string {
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
export function findNonprofitTextSlot(html: string, odId: string): string | undefined {
  if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(odId)) throw new Error('data-od-id: expected letters, digits and hyphens only');
  const pattern = new RegExp(`<([a-z0-9]+)\\b[^>]*\\sdata-od-id="${odId}"[^>]*>([\\s\\S]*?)</\\1>`, 'i');
  const match = pattern.exec(html);
  return match ? match[2]!.replace(/<[^>]*>/g, '').trim() : undefined;
}

/** Every data-od-id present in saved HTML, in document order. */
export function listNonprofitTextSlots(html: string): string[] {
  return [...html.matchAll(/data-od-id="([^"]+)"/g)].map((match) => match[1]!);
}

export { SECTION_ORDER, NONPROFIT_NULLABLE_ATOMS, NONPROFIT_OPTIONAL_SECTIONS } from './slots.ts';
