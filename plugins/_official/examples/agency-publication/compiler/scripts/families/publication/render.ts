/**
 * publication family — trusted renderer.
 *
 * Public surface used by the compiler's `families/registry.ts`:
 *   validatePublicationRecipe(input)          -> typed recipe
 *   getPublicationAssetRequirements(recipe)   -> AssetRequirement[] (always empty: no images)
 *   renderPublication(recipe, resolvedPaths)  -> HTML string
 *
 * Every class string is taken from one of the page kind's own vendored HyperUI blocks
 * (`PUBLICATION_BLOCKS` in slots.ts), so the compiled `css/publication.css` covers it;
 * `render.test.ts` checks that. The newsletter's email field is a static mock (a styled
 * paragraph carrying its placeholder text), not an `<input>`: the page has no script, its CSP
 * forbids form submission, and the placeholder must stay a reconcilable text slot.
 *
 * Every text slot sits in an element carrying `data-od-id`, emitted in `SECTIONS` order.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { AssetRequirement } from '../../assets.ts';
import { presentSections, sectionOfType } from '../../sections.ts';
import { parsePublicationRecipe, type PublicationRecipe, type PublicationSection } from './contract.ts';
import {
  ARCHIVE_SECTION_ID, AUTHORS_SECTION_ID, FOOTER_SECTION_ID, LATEST_SECTION_ID, LEAD_SECTION_ID,
  MASTHEAD_SECTION_ID, MEMBERSHIP_SECTION_ID, NEWSLETTER_SECTION_ID, SERIES_SECTION_ID, TOPICS_SECTION_ID,
} from './slots.ts';

/** Every content section id that could be a nav target, in fixed page order (never masthead or
 * footer) — see restaurant's `NAV_TARGET_ORDER` for the pattern this mirrors (G5). `authors` is
 * optional and dropped from this list when the brief carries no bylines. */
export const NAV_TARGET_ORDER = [LATEST_SECTION_ID, SERIES_SECTION_ID, ARCHIVE_SECTION_ID, AUTHORS_SECTION_ID, MEMBERSHIP_SECTION_ID];
/** Fixed nav labels, keyed by the section id each one names — never model text (G5 round 2). */
export const NAV_LABELS: Record<string, string> = {
  [LATEST_SECTION_ID]: 'Latest', [SERIES_SECTION_ID]: 'Series', [ARCHIVE_SECTION_ID]: 'Archive',
  [AUTHORS_SECTION_ID]: 'Writers', [MEMBERSHIP_SECTION_ID]: 'Membership',
};

const HERE = import.meta.dirname;
const HYPERUI_CSS = path.join(HERE, '../../catalog/hyperui/publication.css');
let hyperuiCss: string | undefined;
/** The compiled Tailwind build for this page kind's blocks, read once and inlined once per page. */
function inlinedStyles(): string {
  hyperuiCss ??= readFileSync(HYPERUI_CSS, 'utf8');
  return hyperuiCss;
}

export function validatePublicationRecipe(input: unknown): PublicationRecipe {
  return parsePublicationRecipe(input);
}

/** No image, font or video assets. */
export function getPublicationAssetRequirements(_recipe: PublicationRecipe): AssetRequirement[] {
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
const items = (s: PublicationSection) => s.items ?? [];

const WRAP = 'mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8';
const H2 = 'text-2xl font-semibold text-gray-900 sm:text-3xl';
const BUTTON = 'rounded-full bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700';
const BOOK_ICON = '<svg aria-hidden="true" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="size-6"><path stroke-linecap="round" stroke-linejoin="round" d="M12 6.04A8.97 8.97 0 0 0 6 3.75c-1.05 0-2.06.18-3 .51v14.25A8.99 8.99 0 0 1 6 18c2.3 0 4.4.87 6 2.29m0-14.25a8.97 8.97 0 0 1 6-2.29c1.05 0 2.06.18 3 .51v14.25A8.99 8.99 0 0 0 18 18a8.97 8.97 0 0 0-6 2.29m0-14.25v14.25"/></svg>';
const CHECK_MARK = '<svg aria-hidden="true" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="size-5 text-indigo-700"><path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5"/></svg>';

function renderMasthead(s: PublicationSection, recipe: PublicationRecipe): string {
  const renderedIds = new Set(presentSections(recipe.sections).map((section) => section.id));
  const targets = NAV_TARGET_ORDER.filter((id) => renderedIds.has(id)).slice(0, 4);
  const links = targets.map((target, index) => {
    const classes = index === 0
      ? 'border-b-2 border-blue-600 px-4 py-2 text-sm font-medium text-blue-600 transition-colors hover:text-blue-700'
      : 'border-b-2 border-transparent px-4 py-2 text-sm font-medium text-gray-600 transition-colors hover:text-gray-700';
    return `<li><a href="#${target}" class="${classes}">${e(NAV_LABELS[target]!)}</a></li>`;
  }).join('');
  return `<header id="${s.id}" class="border-b-2 border-gray-100 bg-white"><div class="${WRAP}"><div class="sm:flex sm:items-center sm:justify-between">`
    + slot('p', 'text-2xl font-bold text-gray-900', 'brand--name', recipe.brand.name)
    + slot('p', 'sr-only', 'brand--descriptor', recipe.brand.descriptor)
    + `<div class="mt-4 flex flex-wrap items-center gap-2 sm:mt-0"><nav><ul class="flex flex-wrap gap-2">${links}</ul></nav>`
    + `<a href="#${NEWSLETTER_SECTION_ID}" class="${BUTTON}" data-od-id="${s.id}--cta">${e(str(s.text, 'cta'))}</a>`
    + `</div></div></div></header>`;
}

function renderLead(s: PublicationSection): string {
  return `<section id="${s.id}"><div class="${WRAP}"><article class="max-w-prose md:max-w-none">`
    + slot('p', 'text-sm font-medium text-blue-600', `${s.id}--kicker`, str(s.text, 'kicker'))
    + slot('h1', `mt-2 ${H2}`, `${s.id}--headline`, str(s.text, 'headline'))
    + slot('p', 'mt-4 text-pretty text-gray-700', `${s.id}--dek`, str(s.text, 'dek'))
    + atom('p', 'mt-4 text-xs text-gray-500', `${s.id}--byline`, nullable(s.text, 'byline'))
    // No real per-article page exists on this one-page reference build, so "Read the story" is
    // plain text with no button chrome or hover (G5 round 2) — the reader is already reading the
    // whole story right here.
    + `<div class="mt-6 flex">${slot('span', 'text-sm font-medium text-gray-700', `${s.id}--readCta`, str(s.text, 'readCta'))}</div>`
    + `</article></div></section>`;
}

function renderTopics(s: PublicationSection): string {
  // There is no per-topic archive page on this one-page reference build (G5 round 2 — a real id
  // to link to is not the same as an honest link: every chip pointing at the same latest-stories
  // section implied a "browse this topic" destination none of them actually has). Plain text, no
  // pill shape, no link, no hover — a round-3 Grok audit found the round-2 fix still carried
  // rounded-full/bg-gray-100/px-4/py-2, so it still looked like a chip even with no href.
  const topics = strs(s.text, 'topics').map((topic, index) =>
    `<li>${slot('span', 'text-sm text-gray-700', `${s.id}--topics-${index}`, topic)}</li>`).join('');
  return `<section id="${s.id}"><div class="${WRAP}">`
    + slot('h2', H2, `${s.id}--heading`, str(s.text, 'heading'))
    + `<ul class="mt-4 flex flex-wrap gap-2">${topics}</ul></div></section>`;
}

function renderLatest(s: PublicationSection): string {
  const cards = items(s).map((item, index) => `<article class="rounded-lg border border-gray-200 p-6">`
    + slot('p', 'text-xs font-medium text-blue-600', `${s.id}--items-${index}--topic`, str(item, 'topic'))
    + slot('h3', 'mt-2 text-lg font-semibold text-gray-900', `${s.id}--items-${index}--title`, str(item, 'title'))
    + slot('p', 'mt-2 text-pretty text-gray-700', `${s.id}--items-${index}--dek`, str(item, 'dek'))
    + atom('p', 'mt-4 text-xs text-gray-500', `${s.id}--items-${index}--date`, nullable(item, 'date'))
    + `</article>`).join('');
  return `<section id="${s.id}"><div class="${WRAP}">`
    + slot('h2', H2, `${s.id}--heading`, str(s.text, 'heading'))
    + `<div class="mt-8 grid grid-cols-1 gap-8 md:grid-cols-2">${cards}</div></div></section>`;
}

function renderSeries(s: PublicationSection): string {
  const cards = items(s).map((item, index) => `<div class="text-center"><div class="inline-flex rounded-lg bg-gray-100 p-3 text-gray-700">${BOOK_ICON}</div>`
    + slot('h3', 'mt-4 text-lg font-semibold text-gray-900', `${s.id}--items-${index}--title`, str(item, 'title'))
    + slot('p', 'mt-2 text-pretty text-gray-700', `${s.id}--items-${index}--blurb`, str(item, 'blurb'))
    + `</div>`).join('');
  return `<section id="${s.id}"><div class="${WRAP}">`
    + slot('h2', H2, `${s.id}--heading`, str(s.text, 'heading'))
    + `<div class="mt-8 grid grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-4">${cards}</div></div></section>`;
}

function renderArchive(s: PublicationSection): string {
  const entries = items(s).map((item, index) => `<li class="relative -ms-1.5 flex items-start gap-4"><span class="size-3 shrink-0 rounded-full bg-blue-600"></span><div class="-mt-2">`
    + atom('time', 'text-xs/none font-medium text-gray-700', `${s.id}--items-${index}--date`, nullable(item, 'date'))
    + slot('h3', 'text-lg font-bold text-gray-900', `${s.id}--items-${index}--title`, str(item, 'title'))
    + slot('p', 'mt-0.5 text-sm text-gray-700', `${s.id}--items-${index}--summary`, str(item, 'summary'))
    + `</div></li>`).join('');
  return `<section id="${s.id}"><div class="${WRAP}">`
    + slot('h2', H2, `${s.id}--heading`, str(s.text, 'heading'))
    + `<ol class="relative mt-8 space-y-8 before:absolute before:-ms-px before:h-full before:w-0.5 before:rounded-full before:bg-gray-200">${entries}</ol>`
    + `</div></section>`;
}

function renderAuthors(s: PublicationSection): string {
  // `name` is a nullable `x-atom: 'person-name'` (G5): a byline the brief attributes to no one
  // still renders the bio and beat, just without the writer's name.
  const cards = items(s).map((item, index) => `<li class="flex flex-col rounded-lg border border-gray-200 p-6">`
    + slot('p', 'flex-1 text-sm text-gray-700', `${s.id}--items-${index}--bio`, str(item, 'bio'))
    + `<div class="mt-6 flex items-center gap-3"><div>`
    + atom('p', 'text-sm font-medium text-gray-900', `${s.id}--items-${index}--name`, nullable(item, 'name'))
    + slot('p', 'text-xs text-gray-500', `${s.id}--items-${index}--beat`, str(item, 'beat'))
    + `</div></div></li>`).join('');
  return `<section id="${s.id}"><div class="${WRAP}">`
    + slot('h2', H2, `${s.id}--heading`, str(s.text, 'heading'))
    + `<ul class="mx-auto mt-8 grid max-w-6xl grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">${cards}</ul></div></section>`;
}

/**
 * The subscribe CTA needs a real destination (G5 round 2: `href="#${s.id}"` was a dead button on
 * the section it already sits in). The footer's own `contactEmail` is the one real address this
 * family ever states, so a filled one becomes the subscribe `mailto:`; with none, the label
 * renders as plain text, never a styled button with nowhere honest to go.
 */
function newsletterCta(s: PublicationSection, recipe: PublicationRecipe): string {
  const footer = sectionOfType(recipe, 'footer');
  const contactEmail = footer ? nullable(footer.text, 'contactEmail') : null;
  if (contactEmail === null) return slot('span', 'mt-4 inline-block text-sm font-medium text-gray-700', `${s.id}--cta`, str(s.text, 'cta'));
  return `<a href="mailto:${e(contactEmail)}" class="group mt-4 flex w-full items-center justify-center gap-2 rounded-md bg-blue-600 px-5 py-3 text-sm font-medium text-white transition hover:bg-blue-700 sm:mt-0 sm:w-auto" data-od-id="${s.id}--cta">${e(str(s.text, 'cta'))}</a>`;
}

function renderNewsletter(s: PublicationSection, recipe: PublicationRecipe): string {
  return `<section id="${s.id}" class="bg-gray-50"><div class="p-8 md:p-12 lg:px-16 lg:py-24"><div class="mx-auto max-w-lg text-center">`
    + slot('h2', 'text-2xl font-bold text-gray-900 md:text-3xl', `${s.id}--heading`, str(s.text, 'heading'))
    + slot('p', 'text-gray-500 sm:mt-4', `${s.id}--body`, str(s.text, 'body'))
    + `</div><div class="mx-auto mt-8 max-w-xl"><div class="sm:flex sm:gap-4"><div class="sm:flex-1">`
    + slot('p', 'w-full rounded-md border border-gray-200 bg-white p-3 text-gray-700 shadow-xs', `${s.id}--emailPlaceholder`, str(s.text, 'emailPlaceholder'))
    + `</div>${newsletterCta(s, recipe)}</div>`
    + atom('p', 'mt-4 text-center text-xs text-gray-500', `${s.id}--cadence`, nullable(s.text, 'cadence'))
    + `</div></div></section>`;
}

/** The price and its period; nothing when the brief states no price (a period never stands alone). */
function priceLine(id: string, index: number, price: string | null, period: string | null): string {
  if (price === null) return '';
  return `<p class="mt-2 sm:mt-4">`
    + slot('strong', 'text-3xl font-bold text-gray-900 sm:text-4xl', `${id}--items-${index}--price`, price)
    + (period === null ? '' : ' ' + slot('span', 'text-sm font-medium text-gray-700', `${id}--items-${index}--period`, period))
    + `</p>`;
}

function renderMembership(s: PublicationSection, recipe: PublicationRecipe): string {
  const footer = sectionOfType(recipe, 'footer');
  const contactEmail = footer ? nullable(footer.text, 'contactEmail') : null;
  const tiers = items(s).map((item, index) => {
    const featured = index === items(s).length - 1;
    const features = strs(item, 'features').map((feature, index2) => `<li class="flex items-center gap-1">${CHECK_MARK}`
      + slot('span', 'text-gray-700', `${s.id}--items-${index}--features-${index2}`, feature) + `</li>`).join('');
    // A tier's own join button needs a real destination (G5 round 2: `href="#${s.id}"` was a dead
    // button on the section it already sits in); the footer's own contact email, when supplied,
    // else plain text.
    const cta = contactEmail === null
      ? slot('span', 'mt-8 block text-center text-sm font-medium text-gray-700', `${s.id}--items-${index}--cta`, str(item, 'cta'))
      : `<a href="mailto:${e(contactEmail)}" class="${featured
        ? 'mt-8 block rounded-full border border-indigo-600 bg-indigo-600 px-12 py-3 text-center text-sm font-medium text-white hover:bg-indigo-700 hover:ring-1 hover:ring-indigo-700'
        : 'mt-8 block rounded-full border border-indigo-600 bg-white px-12 py-3 text-center text-sm font-medium text-indigo-600 hover:ring-1 hover:ring-indigo-600'}" data-od-id="${s.id}--items-${index}--cta">${e(str(item, 'cta'))}</a>`;
    return `<div class="${featured ? 'rounded-2xl border border-indigo-600 p-6 shadow-xs ring-1 ring-indigo-600 sm:px-8 lg:p-12' : 'rounded-2xl border border-gray-200 p-6 shadow-xs sm:px-8 lg:p-12'}"><div class="text-center">`
      + slot('h3', 'text-lg font-medium text-gray-900', `${s.id}--items-${index}--name`, str(item, 'name'))
      + priceLine(s.id, index, nullable(item, 'price'), nullable(item, 'period'))
      + `</div><ul class="mt-6 space-y-2">${features}</ul>`
      + `${cta}</div>`;
  }).join('');
  return `<section id="${s.id}"><div class="mx-auto max-w-3xl px-4 py-8 sm:px-6 sm:py-12 lg:px-8">`
    + slot('h2', `text-center ${H2}`, `${s.id}--heading`, str(s.text, 'heading'))
    + `<div class="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 sm:items-center md:gap-8">${tiers}</div></div></section>`;
}

function renderFooter(s: PublicationSection): string {
  // Legal-style footer labels never had a real page behind them (G5): plain text, never an <a>.
  const links = strs(s.text, 'links').map((link, index) => `<li>${slot('span', 'text-gray-500', `${s.id}--links-${index}`, link)}</li>`).join('');
  return `<footer id="${s.id}" class="bg-white"><div class="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">`
    + slot('p', 'max-w-prose text-gray-500', `${s.id}--tagline`, str(s.text, 'tagline'))
    + `<div class="mt-8 border-t border-gray-100 pt-8"><div class="sm:flex sm:justify-between">`
    + `<ul class="flex flex-wrap justify-start gap-4 text-xs">${links}</ul>`
    + atom('p', 'mt-8 text-xs text-gray-500 sm:mt-0', `${s.id}--contactEmail`, nullable(s.text, 'contactEmail'))
    + `</div></div></div></footer>`;
}

const RENDERERS: Record<string, (s: PublicationSection, recipe: PublicationRecipe) => string> = {
  [MASTHEAD_SECTION_ID]: renderMasthead,
  [LEAD_SECTION_ID]: renderLead,
  [TOPICS_SECTION_ID]: renderTopics,
  [LATEST_SECTION_ID]: renderLatest,
  [SERIES_SECTION_ID]: renderSeries,
  [ARCHIVE_SECTION_ID]: renderArchive,
  [AUTHORS_SECTION_ID]: renderAuthors,
  [NEWSLETTER_SECTION_ID]: renderNewsletter,
  [MEMBERSHIP_SECTION_ID]: renderMembership,
  [FOOTER_SECTION_ID]: renderFooter,
};

export function renderPublication(recipe: PublicationRecipe, _resolvedAssetPaths: Record<string, string>): string {
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
export function findPublicationTextSlot(html: string, odId: string): string | undefined {
  if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(odId)) throw new Error('data-od-id: expected letters, digits and hyphens only');
  const pattern = new RegExp(`<([a-z0-9]+)\\b[^>]*\\sdata-od-id="${odId}"[^>]*>([\\s\\S]*?)</\\1>`, 'i');
  const match = pattern.exec(html);
  return match ? match[2]!.replace(/<[^>]*>/g, '').trim() : undefined;
}

/** Every data-od-id present in saved HTML, in document order. */
export function listPublicationTextSlots(html: string): string[] {
  return [...html.matchAll(/data-od-id="([^"]+)"/g)].map((match) => match[1]!);
}

export { SECTION_ORDER, PUBLICATION_NULLABLE_ATOMS, PUBLICATION_OPTIONAL_SECTIONS } from './slots.ts';
