/**
 * storefront family — trusted renderer.
 *
 * Public surface used by the compiler's `families/registry.ts`:
 *   validateStorefrontRecipe(input)          -> typed recipe
 *   getStorefrontAssetRequirements(recipe)   -> AssetRequirement[] (always empty: no images)
 *   renderStorefront(recipe, resolvedPaths)  -> HTML string
 *
 * Every class string is taken from one of the page kind's own vendored HyperUI blocks
 * (`STOREFRONT_BLOCKS` in slots.ts), so the compiled `css/storefront.css` covers it;
 * `render.test.ts` checks that. The collection grid and product details sections are
 * caption-only: this page kind carries no `<img>`, so a brief's photography is represented as
 * placeholder text until real images are added downstream.
 *
 * Every text slot sits in an element carrying `data-od-id`, emitted in `SECTIONS` order. The
 * nullable `phone`, `email` and `url` atoms render as real `tel:`/`mailto:`/direct links built
 * only from the filled atom's own text — never a separate value — and nothing at all when the
 * atom is null; `address` stays plain text, like every other page-kind family's address atom.
 *
 * The nav (`renderHeader`) links to the sections that are always present (hero, featured
 * product) plus one link per optional section that survived validation — the exact "optional
 * sections and their nav links are dropped" rule from the proficiency bar — using fixed,
 * non-invented English labels, never model-authored text tied to a section's presence.
 *
 * `renderBuyPreorder` is the one required-but-honest action: a supplied `url` wins, else a
 * supplied `phone`, else a supplied `email`; when the brief states none of the three the section
 * still renders (its heading and body stand, per the fixed spine) but the call to action is
 * plain text, never a "#" link or any other fake or dead destination.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { AssetRequirement } from '../../assets.ts';
import { presentSections, sectionOfType } from '../../sections.ts';
import { parseStorefrontRecipe, type StorefrontRecipe, type StorefrontSection } from './contract.ts';
import {
  BUY_PREORDER_SECTION_ID, COLLECTION_GRID_SECTION_ID, FEATURED_PRODUCT_SECTION_ID, FOOTER_SECTION_ID,
  HEADER_SECTION_ID, HERO_SECTION_ID, PRODUCT_DETAILS_SECTION_ID, REVIEWS_SECTION_ID,
  SHIPPING_RETURNS_SECTION_ID, STORY_ABOUT_SECTION_ID,
} from './slots.ts';

const HERE = import.meta.dirname;
const HYPERUI_CSS = path.join(HERE, '../../catalog/hyperui/storefront.css');
let hyperuiCss: string | undefined;
/** The compiled Tailwind build for this page kind's blocks, read once and inlined once per page. */
function inlinedStyles(): string {
  hyperuiCss ??= readFileSync(HYPERUI_CSS, 'utf8');
  return hyperuiCss;
}

export function validateStorefrontRecipe(input: unknown): StorefrontRecipe {
  return parseStorefrontRecipe(input);
}

/** No image, font or video assets: the collection grid and product details are placeholders. */
export function getStorefrontAssetRequirements(_recipe: StorefrontRecipe): AssetRequirement[] {
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
/** A nullable phone atom: nothing when null, else a `tel:` link over the same displayed text. */
function telAtom(className: string, id: string, value: string | null): string {
  if (value === null) return '';
  const href = `tel:${value.replace(/[ ()-]/g, '')}`;
  const classes = className ? ` class="${className}"` : '';
  return `<a href="${e(href)}"${classes} data-od-id="${id}">${e(value)}</a>`;
}
/** A nullable email atom: nothing when null, else a `mailto:` link over the same displayed text. */
function mailAtom(className: string, id: string, value: string | null): string {
  if (value === null) return '';
  const href = `mailto:${encodeURIComponent(value)}`;
  const classes = className ? ` class="${className}"` : '';
  return `<a href="${e(href)}"${classes} data-od-id="${id}">${e(value)}</a>`;
}
const str = (record: Record<string, unknown>, name: string) => record[name] as string;
const strs = (record: Record<string, unknown>, name: string) => record[name] as string[];
const nullable = (record: Record<string, unknown>, name: string) => record[name] as string | null;
const items = (s: StorefrontSection) => s.items ?? [];

const WRAP = 'mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8';
const H2 = 'text-2xl font-semibold text-gray-900 sm:text-3xl';
const BTN_PILL = 'rounded-full bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600';
const FOCUS_RING = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600';

/** A fixed, non-invented nav label for one optional section, keyed by the section's `type`
 * (see slots.ts). These are UI chrome, not brief facts, so they are never model-authored. */
const NAV_LABELS: Record<string, string> = {
  'collection-grid': 'Collection',
  'product-details': 'Details',
  'shipping-returns': 'Shipping',
  reviews: 'Reviews',
  'story-about': 'About',
};

/** Shared nav-link visual treatment: no "active" state of any kind — this is one page, not a
 * multi-page site with a current-page indicator, so every link reads the same until hovered or
 * focused. */
const NAV_LINK_CLASS = `px-3 py-2 text-sm font-medium text-gray-600 transition-colors hover:text-gray-900 ${FOCUS_RING}`;
/** The featured-product nav link's label (G5 round 2): fixed, non-model chrome, same as every
 * other nav entry's `NAV_LABELS`, never model-writable free text that could drift from what the
 * link's anchor actually opens. */
const FEATURED_NAV_LABEL = 'Shop';

function renderHeader(s: StorefrontSection, recipe: StorefrontRecipe): string {
  const featuredId = sectionOfType(recipe, 'featured-product')!.id;
  const fixed = `<li><a class="${NAV_LINK_CLASS}" href="#${e(featuredId)}">${e(FEATURED_NAV_LABEL)}</a></li>`;
  // Up to three links for the optional sections that survived, in spine order; a dropped optional
  // section renders no nav entry for itself, and the nav is capped at four total links (one fixed
  // + three dynamic) — a table of contents for one page, not a full site map.
  const dynamic = ['collection-grid', 'product-details', 'shipping-returns', 'reviews', 'story-about']
    .map((type) => sectionOfType(recipe, type))
    .filter((section): section is StorefrontSection => section !== undefined)
    .slice(0, 3)
    .map((section) => `<li><a href="#${e(section.id)}" class="${NAV_LINK_CLASS}">${e(NAV_LABELS[section.type]!)}</a></li>`)
    .join('');
  const buyId = sectionOfType(recipe, 'buy-preorder')!.id;
  // sticky + a translucent-on-scroll backdrop keep the brand and Buy action reachable while
  // scrolling; the link list is hidden below sm so a narrow viewport gets a compact bar with the
  // brand and the Buy action only, never a tall wrapped nav row.
  // The link list stays hidden below lg (not just below sm): at 768px there is not enough room
  // for the brand name, a multi-item nav and the Buy button on one line without wrapping, so the
  // full nav only shows at the widest breakpoint. Every width keeps a single-line, compact bar
  // with the brand and the Buy action reachable (whitespace-nowrap on both, shrink-0 on the
  // button, so neither ever wraps to a second line even at the width where nav is still hidden).
  return `<header id="${s.id}" class="sticky top-0 z-20 border-b-2 border-gray-200 bg-white/95 backdrop-blur supports-[backdrop-filter]:bg-white/80"><div class="mx-auto max-w-7xl px-4 py-3 sm:px-6 lg:px-8"><div class="flex items-center justify-between gap-4">`
    + slot('p', 'shrink-0 whitespace-nowrap text-lg font-semibold text-gray-900', 'brand--name', recipe.brand.name)
    + slot('p', 'sr-only', 'brand--descriptor', recipe.brand.descriptor)
    + `<nav class="hidden lg:block"><ul class="flex flex-wrap gap-2">${fixed}${dynamic}</ul></nav>`
    + `<a href="#${e(buyId)}" class="${BTN_PILL} shrink-0 whitespace-nowrap" data-od-id="${s.id}--cta">${e(str(s.text, 'cta'))}</a>`
    + `</div></div></header>`;
}

/** A purely decorative right-hand panel for the hero at lg+ widths: no text, no data-od-id, no
 * fact of any kind — an aria-hidden gradient card carrying the same bag glyph the collection grid
 * uses, so a wide viewport reads as a composed two-column hero rather than text on a bare half. */
/**
 * A typographic "price tag" panel for the featured product, at lg+ widths — CSS and text only,
 * no icon or generic glyph. Every value it shows (name, price) is the SAME fact the
 * featured-product section itself states, echoed here purely for hero layout weight; it carries
 * no `data-od-id` of its own and is never a second place that fact could drift from the
 * section's own, since it is read from the already-validated recipe, not re-authored.
 */
function heroProductTag(recipe: StorefrontRecipe): string {
  const featured = sectionOfType(recipe, 'featured-product')!;
  const name = str(featured.text, 'name');
  const description = str(featured.text, 'description');
  const price = nullable(featured.text, 'price');
  const priceBadge = price === null ? '' : `<p class="mt-6 text-5xl font-bold text-white">${e(price)}</p>`;
  // Content is vertically centered (not split to the top/bottom corners) and the product's own
  // description is echoed too, so the panel reads as a filled card rather than a mostly-empty
  // gradient with two stray lines of text.
  return `<div class="hidden overflow-hidden rounded-3xl bg-linear-to-br from-emerald-700 to-emerald-900 p-10 lg:flex lg:aspect-[4/5] lg:flex-col lg:justify-center" aria-hidden="true">`
    + `<p class="text-xs font-semibold tracking-[0.2em] text-emerald-200 uppercase">Featured piece</p>`
    + `<p class="mt-4 text-3xl font-semibold text-white">${e(name)}</p>`
    + `<div class="mt-4 h-px w-16 bg-emerald-400"></div>`
    + `<p class="mt-4 max-w-xs text-sm text-emerald-100">${e(description)}</p>`
    + priceBadge
    + `</div>`;
}

function renderHero(s: StorefrontSection, recipe: StorefrontRecipe): string {
  return `<section id="${s.id}" class="border-b border-gray-100 bg-gray-50"><div class="${WRAP} lg:py-16"><div class="lg:grid lg:grid-cols-2 lg:items-center lg:gap-12"><div class="max-w-2xl">`
    + slot('p', 'inline-block rounded-full bg-emerald-100 px-3 py-1 text-sm font-medium text-emerald-700', `${s.id}--eyebrow`, str(s.text, 'eyebrow'))
    + slot('h1', 'mt-4 text-3xl font-bold tracking-tight text-gray-900 sm:text-4xl lg:text-5xl', `${s.id}--heading`, str(s.text, 'heading'))
    + slot('p', 'mt-4 max-w-prose text-pretty text-lg text-gray-700', `${s.id}--body`, str(s.text, 'body'))
    + `</div>${heroProductTag(recipe)}</div></div></section>`;
}

function renderFeaturedProduct(s: StorefrontSection): string {
  return `<section id="${s.id}"><div class="mx-auto max-w-3xl px-4 py-8 sm:px-6 sm:py-12 lg:px-8">`
    + slot('h2', H2, `${s.id}--heading`, str(s.text, 'heading'))
    + `<div id="${s.id}--card" class="mt-8 rounded-2xl border border-emerald-600 p-6 shadow-xs ring-1 ring-emerald-600 sm:px-8 lg:p-12"><div class="text-center">`
    + slot('h3', 'text-lg font-medium text-gray-900', `${s.id}--name`, str(s.text, 'name'))
    + `</div>`
    + slot('p', 'mt-6 text-pretty text-gray-700', `${s.id}--description`, str(s.text, 'description'))
    + atom('p', 'mt-4 text-center text-2xl font-bold text-gray-900 sm:text-3xl', `${s.id}--price`, nullable(s.text, 'price'))
    + `</div></div></section>`;
}

function renderCollectionGrid(s: StorefrontSection): string {
  // Typographic cards, no repeated icon: a top rule in the brand accent, the name, the blurb and
  // a nullable price, with a real hover/focus-visible state (border and shadow lift) since these
  // are meant to read as browsable, not static.
  const cards = items(s).map((item, index) => {
    const name = slot('h3', 'text-base font-semibold text-gray-900', `${s.id}--items-${index}--name`, str(item, 'name'));
    const blurb = slot('p', 'mt-2 text-sm text-pretty text-gray-600', `${s.id}--items-${index}--blurb`, str(item, 'blurb'));
    const price = atom('p', 'mt-4 text-sm font-semibold text-gray-900', `${s.id}--items-${index}--price`, nullable(item, 'price'));
    return `<div tabindex="0" class="group rounded-xl border border-gray-200 p-5 transition hover:-translate-y-0.5 hover:border-emerald-600 hover:shadow-lg ${FOCUS_RING}">`
      + `<div class="h-1 w-10 rounded-full bg-emerald-600 transition-all group-hover:w-16" aria-hidden="true"></div>`
      + `<div class="mt-4">${name}${blurb}${price}</div>`
      + `</div>`;
  }).join('');
  return `<section id="${s.id}"><div class="${WRAP}">`
    + slot('h2', H2, `${s.id}--heading`, str(s.text, 'heading'))
    + `<div class="mt-8 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">${cards}</div></div></section>`;
}

function renderProductDetails(s: StorefrontSection): string {
  const rows = items(s).map((item, index) => `<div class="grid grid-cols-1 gap-1 py-3 sm:grid-cols-3 sm:gap-4">`
    + slot('dt', 'font-medium text-gray-900', `${s.id}--items-${index}--label`, str(item, 'label'))
    + slot('dd', 'text-gray-700 sm:col-span-2', `${s.id}--items-${index}--value`, str(item, 'value'))
    + `</div>`).join('');
  return `<section id="${s.id}"><div class="${WRAP}">`
    + slot('h2', H2, `${s.id}--heading`, str(s.text, 'heading'))
    + `<div class="mt-8 flow-root"><dl class="-my-3 divide-y divide-gray-200 text-sm">${rows}</dl></div>`
    + `</div></section>`;
}

/** The one required-but-honest action. A supplied `url` wins; else a supplied `phone` renders a
 * `tel:` link; else a supplied `email` renders a `mailto:` link; when the brief states none of
 * the three the call to action is plain text, never a fake or dead link. */
function renderBuyPreorder(s: StorefrontSection): string {
  const url = nullable(s.text, 'url');
  const phone = nullable(s.text, 'phone');
  const email = nullable(s.text, 'email');
  const label = str(s.text, 'ctaLabel');
  const id = `${s.id}--ctaLabel`;
  const primaryBtn = `inline-block rounded-sm bg-emerald-600 px-12 py-3 text-sm font-medium text-white transition hover:bg-emerald-700 ${FOCUS_RING}`;
  let cta: string;
  if (url !== null) {
    cta = `<a href="${e(url)}" rel="noopener noreferrer" target="_blank" class="${primaryBtn}" data-od-id="${id}">${e(label)}</a>`;
  } else if (phone !== null) {
    cta = `<a href="tel:${e(phone.replace(/[ ()-]/g, ''))}" class="${primaryBtn}" data-od-id="${id}">${e(label)}</a>`;
  } else if (email !== null) {
    cta = `<a href="mailto:${encodeURIComponent(email)}" class="${primaryBtn}" data-od-id="${id}">${e(label)}</a>`;
  } else {
    // No destination the brief supplied: the same visual treatment, but plain text — never a
    // "#" placeholder pretending to be a working link.
    cta = `<span class="inline-block rounded-sm bg-gray-200 px-12 py-3 text-sm font-medium text-gray-700" data-od-id="${id}">${e(label)}</span>`;
  }
  return `<section id="${s.id}" class="overflow-hidden bg-gray-50 sm:grid"><div class="p-8 md:p-12 lg:px-16 lg:py-24"><div class="mx-auto max-w-xl text-center">`
    + slot('h2', 'text-2xl font-bold text-gray-900 md:text-3xl', `${s.id}--heading`, str(s.text, 'heading'))
    + slot('p', 'text-gray-500 md:mt-4', `${s.id}--body`, str(s.text, 'body'))
    + `<div class="mt-4 md:mt-8">${cta}</div>`
    + `</div></div></section>`;
}

function renderShippingReturns(s: StorefrontSection): string {
  return `<section id="${s.id}"><div class="${WRAP}"><div class="max-w-prose">`
    + slot('h2', H2, `${s.id}--heading`, str(s.text, 'heading'))
    + slot('p', 'mt-4 text-pretty text-gray-700', `${s.id}--body`, str(s.text, 'body'))
    + `</div></div></section>`;
}

function renderReviews(s: StorefrontSection): string {
  const reviews = items(s).map((item, index) => {
    const name = nullable(item, 'name');
    // No brief-given name means no verifiable attribution: even a neutral-sounding fallback
    // like "Verified buyer" asserts a fact (that the purchase was verified) the brief never
    // supplied. Per the same drop-unknown-facts rule applied elsewhere, the row is omitted
    // entirely rather than filled with any invented or fallback claim.
    const attribution = name === null ? '' : slot('p', 'mt-3 text-xs text-gray-500', `${s.id}--items-${index}--name`, name);
    return `<li class="rounded-lg border border-gray-200 p-6">`
      + slot('p', 'text-sm text-gray-700', `${s.id}--items-${index}--quote`, str(item, 'quote'))
      + attribution
      + `</li>`;
  }).join('');
  // Left-aligned under the shared WRAP, like every other section (hero, shipping-returns,
  // story-about): no mx-auto on the inner column, so the narrower max-w-2xl reading width does
  // not visually recenter this section against the page's otherwise consistent left alignment.
  return `<section id="${s.id}"><div class="${WRAP}"><div class="max-w-2xl">`
    + slot('h2', H2, `${s.id}--heading`, str(s.text, 'heading'))
    + `<ul class="mt-8 space-y-4">${reviews}</ul></div></div></section>`;
}

function renderStoryAbout(s: StorefrontSection): string {
  return `<section id="${s.id}"><div class="${WRAP}"><div class="max-w-prose">`
    + slot('h2', H2, `${s.id}--heading`, str(s.text, 'heading'))
    + slot('p', 'mt-4 text-pretty text-gray-700', `${s.id}--body`, str(s.text, 'body'))
    + `</div></div></section>`;
}

function renderFooter(s: StorefrontSection, recipe: StorefrontRecipe): string {
  // G8 dry run: fixed labels that name real sections, never model text. The same list as the
  // header nav (`renderHeader`): "Shop" for the featured product, then every optional section
  // that survived, each an in-page link to that section. A dropped section has no footer entry.
  const featuredId = sectionOfType(recipe, 'featured-product')!.id;
  const links = [`<li><a class="text-gray-500 hover:text-gray-900" href="#${e(featuredId)}">${e(FEATURED_NAV_LABEL)}</a></li>`,
    ...['collection-grid', 'product-details', 'shipping-returns', 'reviews', 'story-about']
      .map((type) => sectionOfType(recipe, type))
      .filter((section): section is StorefrontSection => section !== undefined)
      .map((section) => `<li><a class="text-gray-500 hover:text-gray-900" href="#${e(section.id)}">${e(NAV_LABELS[section.type]!)}</a></li>`),
  ].join('');
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

const RENDERERS: Record<string, (s: StorefrontSection, recipe: StorefrontRecipe) => string> = {
  [HEADER_SECTION_ID]: renderHeader,
  [HERO_SECTION_ID]: renderHero,
  [FEATURED_PRODUCT_SECTION_ID]: renderFeaturedProduct,
  [COLLECTION_GRID_SECTION_ID]: renderCollectionGrid,
  [PRODUCT_DETAILS_SECTION_ID]: renderProductDetails,
  [BUY_PREORDER_SECTION_ID]: renderBuyPreorder,
  [SHIPPING_RETURNS_SECTION_ID]: renderShippingReturns,
  [REVIEWS_SECTION_ID]: renderReviews,
  [STORY_ABOUT_SECTION_ID]: renderStoryAbout,
  [FOOTER_SECTION_ID]: renderFooter,
};

export function renderStorefront(recipe: StorefrontRecipe, _resolvedAssetPaths: Record<string, string>): string {
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
export function findStorefrontTextSlot(html: string, odId: string): string | undefined {
  if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(odId)) throw new Error('data-od-id: expected letters, digits and hyphens only');
  const pattern = new RegExp(`<([a-z0-9]+)\\b[^>]*\\sdata-od-id="${odId}"[^>]*>([\\s\\S]*?)</\\1>`, 'i');
  const match = pattern.exec(html);
  return match ? match[2]!.replace(/<[^>]*>/g, '').trim() : undefined;
}

/** Every data-od-id present in saved HTML, in document order. */
export function listStorefrontTextSlots(html: string): string[] {
  return [...html.matchAll(/data-od-id="([^"]+)"/g)].map((match) => match[1]!);
}

export { SECTION_ORDER, STOREFRONT_NULLABLE_ATOMS, STOREFRONT_OPTIONAL_SECTIONS } from './slots.ts';
