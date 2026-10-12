/**
 * restaurant family — trusted renderer.
 *
 * Public surface used by the compiler's `families/registry.ts`:
 *   validateRestaurantRecipe(input)          -> typed recipe
 *   getRestaurantAssetRequirements(recipe)   -> AssetRequirement[] (always empty: no images)
 *   renderRestaurant(recipe, resolvedPaths)  -> HTML string
 *
 * Every class string is taken from one of the page kind's own vendored HyperUI blocks
 * (`RESTAURANT_BLOCKS` in slots.ts), so the compiled `css/restaurant.css` covers it;
 * `render.test.ts` checks that. The gallery section is caption-only: this page kind carries no
 * `<img>`, so a brief's photography is represented as placeholder captions until real images are
 * added downstream.
 *
 * Every text slot sits in an element carrying `data-od-id`, emitted in `SECTIONS` order. The
 * nullable `phone` and `email` atoms render as `tel:`/`mailto:` links (`telAtom`/`mailAtom`)
 * built only from the filled atom's own text — never a separate value — and nothing at all when
 * the atom is null; `address` stays plain text, like every other page-kind family's address atom.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { AssetRequirement } from '../../assets.ts';
import { presentSections, sectionOfType } from '../../sections.ts';
import { parseRestaurantRecipe, type RestaurantRecipe, type RestaurantSection } from './contract.ts';
import {
  FOOTER_SECTION_ID, GALLERY_SECTION_ID, HEADER_SECTION_ID, HERO_SECTION_ID, HOURS_LOCATION_SECTION_ID,
  MENU_SECTION_ID, RESERVATIONS_SECTION_ID, REVIEWS_SECTION_ID, STORY_SECTION_ID,
} from './slots.ts';

/**
 * Every content section id that could ever be a nav target, in the fixed page order — never
 * header/hero/footer themselves. The header's four `links` labels are model-authored text (a
 * fixed count, not one per section), so a link-honesty sweep (G5) points each one, by position,
 * at the section that many places along this same fixed spine actually renders, instead of the
 * `href="#"` placeholder every link used to carry regardless of what it said. `reviews` is
 * optional (`RESTAURANT_OPTIONAL_SECTIONS`) — dropped from this list by `renderHeader` itself
 * when the brief carries no reviews, via `presentSections`' own recipe.
 */
export const NAV_TARGET_ORDER = [MENU_SECTION_ID, HOURS_LOCATION_SECTION_ID, RESERVATIONS_SECTION_ID, STORY_SECTION_ID, GALLERY_SECTION_ID, REVIEWS_SECTION_ID];

const HERE = import.meta.dirname;
const HYPERUI_CSS = path.join(HERE, '../../catalog/hyperui/restaurant.css');
let hyperuiCss: string | undefined;
/** The compiled Tailwind build for this page kind's blocks, read once and inlined once per page. */
function inlinedStyles(): string {
  hyperuiCss ??= readFileSync(HYPERUI_CSS, 'utf8');
  return hyperuiCss;
}

export function validateRestaurantRecipe(input: unknown): RestaurantRecipe {
  return parseRestaurantRecipe(input);
}

/** No image, font or video assets: the gallery is a caption-only placeholder. */
export function getRestaurantAssetRequirements(_recipe: RestaurantRecipe): AssetRequirement[] {
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
/**
 * A nullable phone atom: nothing when null, else the displayed number wrapped in a `tel:` link so
 * a visitor can call the restaurant. Matches the `tel:` construction every other family with a
 * phone atom uses (see e.g. `agency-watson/compiler/scripts/families/watson/render.ts`): the
 * `href` strips spaces, parens and hyphens from the same text the visitor reads, it is never a
 * separate unvalidated value.
 */
function telAtom(className: string, id: string, value: string | null): string {
  if (value === null) return '';
  const href = telHref(value);
  const classes = className ? ` class="${className}"` : '';
  return `<a href="${e(href)}"${classes} data-od-id="${id}">${e(value)}</a>`;
}
/** `tel:` href for a filled phone atom's own text — no separate unvalidated value. */
function telHref(value: string): string {
  return `tel:${value.replace(/[ ()-]/g, '')}`;
}
/**
 * A nullable email atom: nothing when null, else the displayed address wrapped in a `mailto:`
 * link. Matches the `mailto:` construction every other family with an email atom uses: the `href`
 * is the same filled atom text, percent-encoded, never a separate unvalidated value.
 */
function mailAtom(className: string, id: string, value: string | null): string {
  if (value === null) return '';
  const href = `mailto:${encodeURIComponent(value)}`;
  const classes = className ? ` class="${className}"` : '';
  return `<a href="${e(href)}"${classes} data-od-id="${id}">${e(value)}</a>`;
}
const str = (record: Record<string, unknown>, name: string) => record[name] as string;
const strs = (record: Record<string, unknown>, name: string) => record[name] as string[];
const nullable = (record: Record<string, unknown>, name: string) => record[name] as string | null;
const items = (s: RestaurantSection) => s.items ?? [];

const WRAP = 'mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8';
const H2 = 'text-2xl font-semibold text-gray-900 sm:text-3xl';
const BTN_PILL = 'rounded-full bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700';
const FORK_ICON = '<svg aria-hidden="true" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="size-6"><path stroke-linecap="round" stroke-linejoin="round" d="M8.25 3v18M15.75 3v6.75a2.25 2.25 0 0 1-2.25 2.25h-1.5a2.25 2.25 0 0 1-2.25-2.25V3M15.75 3v18"/></svg>';

/** Fixed nav labels, keyed by the section id each one names — never model text (G5 round 2: a
 * Grok audit found the old index-zipped `links` list could say "Reservations" and open the hours
 * section). Every label here is chosen to be exactly what the section it opens actually is. */
export const NAV_LABELS: Record<string, string> = {
  [MENU_SECTION_ID]: 'Menu', [HOURS_LOCATION_SECTION_ID]: 'Hours & location', [RESERVATIONS_SECTION_ID]: 'Reservations',
  [STORY_SECTION_ID]: 'Our story', [GALLERY_SECTION_ID]: 'Gallery', [REVIEWS_SECTION_ID]: 'Reviews',
};

/** True when the hours-and-location section has nothing to show: no address, no phone, no row. */
function hoursLocationIsEmpty(s: RestaurantSection): boolean {
  return nullable(s.text, 'address') === null && nullable(s.text, 'phone') === null && items(s).every((item) => nullable(item, 'value') === null);
}

/** The sections on the page: present ones, less an hours-and-location section with nothing in it
 * (Devin, 2026-10-10: a brief with no hours or address left a bare heading and a nav link to it). */
function shownSections(recipe: RestaurantRecipe): RestaurantSection[] {
  return presentSections(recipe.sections).filter((section) => section.id !== HOURS_LOCATION_SECTION_ID || !hoursLocationIsEmpty(section));
}

function renderHeader(s: RestaurantSection, recipe: RestaurantRecipe): string {
  const renderedIds = new Set(shownSections(recipe).map((section) => section.id));
  const targets = NAV_TARGET_ORDER.filter((id) => renderedIds.has(id)).slice(0, 4);
  const links = targets.map((target, index) => {
    const classes = index === 0
      ? 'border-b-2 border-blue-600 px-4 py-2 text-sm font-medium text-blue-600 transition-colors hover:text-blue-700'
      : 'border-b-2 border-transparent px-4 py-2 text-sm font-medium text-gray-600 transition-colors hover:text-gray-700';
    return `<li><a href="#${target}" class="${classes}">${e(NAV_LABELS[target]!)}</a></li>`;
  }).join('');
  // The header's own CTA always books a table; point it at the always-rendered reservations
  // section (never optional, unlike reviews), the same real anchor `renderHero`'s own
  // `reservationCta` uses.
  return `<header id="${s.id}" class="border-b-2 border-gray-200 bg-white"><div class="${WRAP}"><div class="flex flex-wrap items-center justify-between gap-4">`
    + slot('p', 'text-lg font-semibold text-gray-900', 'brand--name', recipe.brand.name)
    + slot('p', 'sr-only', 'brand--descriptor', recipe.brand.descriptor)
    + `<nav><ul class="flex flex-wrap gap-2">${links}</ul></nav>`
    + `<a href="#${RESERVATIONS_SECTION_ID}" class="${BTN_PILL}" data-od-id="${s.id}--cta">${e(str(s.text, 'cta'))}</a>`
    + `</div></div></header>`;
}

function renderHero(s: RestaurantSection): string {
  return `<section id="${s.id}"><div class="${WRAP}"><div class="max-w-prose">`
    + slot('p', 'text-sm font-medium text-blue-600', `${s.id}--eyebrow`, str(s.text, 'eyebrow'))
    + slot('h1', `mt-2 ${H2}`, `${s.id}--heading`, str(s.text, 'heading'))
    + slot('p', 'mt-4 text-pretty text-gray-700', `${s.id}--body`, str(s.text, 'body'))
    + `<div class="mt-8"><a href="#${RESERVATIONS_SECTION_ID}" class="group flex w-full items-center justify-center gap-2 rounded-md bg-blue-600 px-5 py-3 text-sm font-medium text-white transition hover:bg-blue-700 sm:w-auto" data-od-id="${s.id}--reservationCta">${e(str(s.text, 'reservationCta'))}</a></div>`
    + `</div></div></section>`;
}

function renderMenu(s: RestaurantSection): string {
  // Emitted in slots.ts declaration order (name, description, price) so document order equals it.
  const dishes = items(s).map((item, index) => {
    const name = slot('h3', 'text-lg font-medium text-gray-900', `${s.id}--items-${index}--name`, str(item, 'name'));
    const description = slot('p', 'mt-1 text-sm text-gray-700', `${s.id}--items-${index}--description`, str(item, 'description'));
    const price = atom('p', 'mt-2 text-sm font-medium text-gray-700', `${s.id}--items-${index}--price`, nullable(item, 'price'));
    return `<div class="rounded-2xl border border-gray-200 p-6 shadow-xs sm:px-8">${name}${description}${price}</div>`;
  }).join('');
  return `<section id="${s.id}"><div class="${WRAP}">`
    + slot('h2', H2, `${s.id}--heading`, str(s.text, 'heading'))
    + slot('p', 'mt-4 text-pretty text-gray-700', `${s.id}--intro`, str(s.text, 'intro'))
    + `<div class="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 md:gap-8">${dishes}</div></div></section>`;
}

function renderHoursLocation(s: RestaurantSection): string {
  // Field order matches slots.ts (heading, address, phone, then the hours rows).
  const address = nullable(s.text, 'address');
  const phone = nullable(s.text, 'phone');
  const facts = address === null && phone === null ? ''
    : `<div class="mt-4 space-y-4 text-sm">`
      + atom('p', 'text-gray-700', `${s.id}--address`, address)
      + telAtom('text-gray-700', `${s.id}--phone`, phone)
      + `</div>`;
  // A row whose value is null is not on the page (the brief states fewer rows, or none).
  const rows = items(s).map((item, index) => {
    const value = nullable(item, 'value');
    return value === null ? '' : `<div class="grid grid-cols-1 gap-1 py-3 sm:grid-cols-3 sm:gap-4">`
      + slot('dt', 'font-medium text-gray-900', `${s.id}--items-${index}--label`, str(item, 'label'))
      + slot('dd', 'text-gray-700 sm:col-span-2', `${s.id}--items-${index}--value`, value)
      + `</div>`;
  }).join('');
  return `<section id="${s.id}"><div class="${WRAP}">`
    + slot('h2', H2, `${s.id}--heading`, str(s.text, 'heading'))
    + facts
    + (rows === '' ? '' : `<div class="mt-8 flow-root"><dl class="-my-3 divide-y divide-gray-200 text-sm">${rows}</dl></div>`)
    + `</div></section>`;
}

/**
 * The reservations CTA needs a real destination (G5 round 2: `href="#restaurant-reservations"`
 * inside the reservations section itself is a dead button, not an action — clicking it just
 * scrolls to the top of the block already on screen). `hours-location`'s phone is the same real
 * business number this page states anywhere it renders, so a filled one becomes a `tel:` link;
 * with none, the label renders as plain text, never a styled button with nowhere honest to go.
 */
function renderReservations(s: RestaurantSection, recipe: RestaurantRecipe): string {
  const hoursLocation = sectionOfType(recipe, 'hours-location');
  const phone = hoursLocation ? nullable(hoursLocation.text, 'phone') : null;
  const cta = phone === null
    ? slot('span', 'inline-block rounded-sm px-12 py-3 text-sm font-medium text-gray-700', `${s.id}--cta`, str(s.text, 'cta'))
    : `<a href="${e(telHref(phone))}" class="inline-block rounded-sm bg-blue-600 px-12 py-3 text-sm font-medium text-white transition hover:bg-blue-700" data-od-id="${s.id}--cta">${e(str(s.text, 'cta'))}</a>`;
  return `<section id="${s.id}" class="overflow-hidden bg-gray-50 sm:grid"><div class="p-8 md:p-12 lg:px-16 lg:py-24"><div class="mx-auto max-w-xl text-center">`
    + slot('h2', 'text-2xl font-bold text-gray-900 md:text-3xl', `${s.id}--heading`, str(s.text, 'heading'))
    + slot('p', 'text-gray-500 md:mt-4', `${s.id}--body`, str(s.text, 'body'))
    + `<div class="mt-4 md:mt-8">${cta}</div>`
    + `</div></div></section>`;
}

function renderStory(s: RestaurantSection): string {
  return `<section id="${s.id}"><div class="${WRAP}"><div class="max-w-prose">`
    + slot('h2', H2, `${s.id}--heading`, str(s.text, 'heading'))
    + slot('p', 'mt-4 text-pretty text-gray-700', `${s.id}--body`, str(s.text, 'body'))
    + `</div></div></section>`;
}

function renderGallery(s: RestaurantSection): string {
  const cards = items(s).map((item, index) => `<div class="text-center"><div class="inline-flex rounded-lg bg-gray-100 p-3 text-gray-700">${FORK_ICON}</div>`
    + slot('h3', 'mt-4 text-lg font-semibold text-gray-900', `${s.id}--items-${index}--caption`, str(item, 'caption'))
    + slot('p', 'mt-2 text-pretty text-gray-700', `${s.id}--items-${index}--blurb`, str(item, 'blurb'))
    + `</div>`).join('');
  return `<section id="${s.id}"><div class="${WRAP}">`
    + slot('h2', H2, `${s.id}--heading`, str(s.text, 'heading'))
    + `<div class="mt-8 grid grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-4">${cards}</div></div></section>`;
}

function renderReviews(s: RestaurantSection): string {
  // `name` is a nullable `x-atom: 'person-name'` (G5): a diner review the brief attributes to no
  // one still renders (the quote itself is never nullable), just without the attribution line.
  const reviews = items(s).map((item, index) => `<li class="rounded-lg border border-gray-200 p-6">`
    + slot('p', 'text-sm font-medium text-gray-900', `${s.id}--items-${index}--title`, str(item, 'title'))
    + slot('p', 'mt-1 text-sm text-gray-600', `${s.id}--items-${index}--quote`, str(item, 'quote'))
    + atom('p', 'mt-3 text-xs text-gray-500', `${s.id}--items-${index}--name`, nullable(item, 'name'))
    + `</li>`).join('');
  return `<section id="${s.id}"><div class="${WRAP}"><div class="mx-auto max-w-2xl">`
    + slot('h2', H2, `${s.id}--heading`, str(s.text, 'heading'))
    + `<ul class="mt-8 space-y-4">${reviews}</ul></div></div></section>`;
}

function renderFooter(s: RestaurantSection): string {
  // Legal-style footer labels ("Privacy", "Terms") never had a real page behind them: no
  // section this compiler renders is a privacy or terms page, so a real anchor would be exactly
  // as invented as the old "#" was. Rendered as plain text, never an `<a>` (see the lesson in
  // FAMILY-BRIEF.md: "no invented pages").
  const links = strs(s.text, 'links').map((link, index) => `<li>${slot('span', 'text-gray-500', `${s.id}--links-${index}`, link)}</li>`).join('');
  const phone = nullable(s.text, 'phone');
  const email = nullable(s.text, 'email');
  const address = nullable(s.text, 'address');
  const contact = phone === null && email === null && address === null ? ''
    : `<div class="mt-8 flex flex-wrap justify-center gap-4 text-center text-xs text-gray-500">`
      + telAtom('', `${s.id}--phone`, phone)
      + mailAtom('', `${s.id}--email`, email)
      + atom('p', '', `${s.id}--address`, address)
      + `</div>`;
  return `<footer id="${s.id}" class="bg-white"><div class="mx-auto max-w-7xl px-4 pt-16 pb-8 sm:px-6 lg:px-8 lg:pt-24"><div class="text-center">`
    + slot('p', 'mx-auto mt-4 max-w-sm text-gray-500', `${s.id}--tagline`, str(s.text, 'tagline'))
    + `</div><div class="mt-16 border-t border-gray-100 pt-8 sm:flex sm:items-center sm:justify-between lg:mt-24">`
    + `<ul class="flex flex-wrap justify-center gap-4 text-xs lg:justify-end">${links}</ul>`
    + `</div>`
    + contact
    + `</div></footer>`;
}

const RENDERERS: Record<string, (s: RestaurantSection, recipe: RestaurantRecipe) => string> = {
  [HEADER_SECTION_ID]: renderHeader,
  [HERO_SECTION_ID]: renderHero,
  [MENU_SECTION_ID]: renderMenu,
  [HOURS_LOCATION_SECTION_ID]: renderHoursLocation,
  [RESERVATIONS_SECTION_ID]: renderReservations,
  [STORY_SECTION_ID]: renderStory,
  [GALLERY_SECTION_ID]: renderGallery,
  [REVIEWS_SECTION_ID]: renderReviews,
  [FOOTER_SECTION_ID]: renderFooter,
};

export function renderRestaurant(recipe: RestaurantRecipe, _resolvedAssetPaths: Record<string, string>): string {
  // A dropped optional section (a null slot) renders nothing at all.
  const body = shownSections(recipe).map((section) => RENDERERS[section.id]!(section, recipe)).join('');
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'none'; style-src 'unsafe-inline'; script-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'">`
    + `<meta name="description" content="${e(recipe.brand.descriptor)}">`
    + `<title>${e(recipe.brand.name)}</title><style>${inlinedStyles()}</style></head>`
    + `<body class="bg-white">${body}</body></html>\n`;
}

/** Read one text slot back out of saved HTML by its data-od-id. */
export function findRestaurantTextSlot(html: string, odId: string): string | undefined {
  if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(odId)) throw new Error('data-od-id: expected letters, digits and hyphens only');
  const pattern = new RegExp(`<([a-z0-9]+)\\b[^>]*\\sdata-od-id="${odId}"[^>]*>([\\s\\S]*?)</\\1>`, 'i');
  const match = pattern.exec(html);
  return match ? match[2]!.replace(/<[^>]*>/g, '').trim() : undefined;
}

/** Every data-od-id present in saved HTML, in document order. */
export function listRestaurantTextSlots(html: string): string[] {
  return [...html.matchAll(/data-od-id="([^"]+)"/g)].map((match) => match[1]!);
}

export { SECTION_ORDER, RESTAURANT_NULLABLE_ATOMS, RESTAURANT_OPTIONAL_SECTIONS } from './slots.ts';
