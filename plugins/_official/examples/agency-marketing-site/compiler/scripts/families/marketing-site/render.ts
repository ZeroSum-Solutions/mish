/**
 * marketing-site family — trusted renderer.
 *
 * Public surface used by the compiler's `families/registry.ts`:
 *   validateMarketingSiteRecipe(input)          -> typed recipe
 *   getMarketingSiteAssetRequirements(recipe)   -> AssetRequirement[] (always empty: no images)
 *   renderMarketingSite(recipe, resolvedPaths)  -> HTML string
 *
 * The page composes six vendored HyperUI marketing blocks
 * (`plugins/_official/shared/ui-kits/hyperui/blocks/marketing/{sections/1,feature-grids/1,
 * testimonials/1,pricing/1,ctas/1,footers/1}.html`) into one fixed layout, in the same "typed
 * slots over a frame taken from the reference" style `crm-dashboard/render.ts` uses. Every named
 * text slot reaches the page inside an element carrying `data-od-id="<sectionId>--<slot>"` (or
 * `--items-<index>--<slot>` inside a repeat); `findMarketingSiteTextSlot` and
 * `listMarketingSiteTextSlots` read those ids back out of saved HTML, unchanged from
 * crm-dashboard's convention.
 *
 * The hero section's two buttons (`primaryCta`, `secondaryCta`) have no button markup of their
 * own in `marketing/sections/1.html` (it is a bare heading-and-body block), so their styling is
 * borrowed from the two button variants `marketing/pricing/1.html` already ships — a filled
 * indigo button for the highlighted tier, and an outline indigo button for the other tier. Both
 * class strings are already scanned into `css/marketing-site.css` because `pricing/1.html` is one
 * of this page kind's six vendored blocks, so no new Tailwind utility is introduced.
 *
 * `brand.name` and `brand.descriptor` reach `<title>`/`<meta name="description">` as usual, but
 * ALSO each get their own hidden `data-od-id="brand--name"`/`"brand--descriptor"` element (the
 * crm-dashboard pattern) so a canvas edit to either is reconcilable.
 */

import { readCompilerResource } from '../../resources.ts';
import type { AssetRequirement } from '../../assets.ts';
import { catalogBlock } from '../../catalog-block.ts';
import { presentSections } from '../../sections.ts';
import {
  parseMarketingSiteRecipe,
  type MarketingSiteFeature, type MarketingSiteFooterColumn, type MarketingSitePricingTier,
  type MarketingSiteRecipe, type MarketingSiteTestimonial,
} from './contract.ts';
import {
  CTA_SECTION_ID, FEATURES_SECTION_ID, FOOTER_SECTION_ID, HERO_SECTION_ID, ILLUSTRATIVE_PRICING_CAPTION, PRICING_SECTION_ID,
  PROOF_SECTION_ID,
} from './slots.ts';

// The package-local copy under compiler/scripts/catalog/ (written by
// packages/genui-catalog/scripts/sync-catalog-assets.ts), so the read resolves inside a packed plugin.
// The path is relative to compiler/scripts/ and read through resources.ts (disk, or a supplied table).
const HYPERUI_CSS = 'catalog/hyperui/marketing-site.css';
/** Read once; the compiled Tailwind build for this page kind's six vendored blocks
 * (`plugins/_official/shared/ui-kits/hyperui/css/marketing-site.css`, copied into this package), inlined once per page. */
function inlinedStyles(): string {
  return readCompilerResource(HYPERUI_CSS);
}

export function validateMarketingSiteRecipe(input: unknown): MarketingSiteRecipe {
  return parseMarketingSiteRecipe(input);
}

/** No image, font or video assets: the six vendored blocks carry no `<img>` once vendored. */
export function getMarketingSiteAssetRequirements(_recipe: MarketingSiteRecipe): AssetRequirement[] {
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

const QUOTE_MARK = '<svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor" class="mx-auto size-8 text-indigo-600"><path d="M7.17 6.17A5.5 5.5 0 0 0 3 11.5V18a1 1 0 0 0 1 1h6.5a1 1 0 0 0 1-1v-6a1 1 0 0 0-1-1H6.06a3.5 3.5 0 0 1 2.35-2.79 1 1 0 1 0-.62-1.9Zm10 0A5.5 5.5 0 0 0 13 11.5V18a1 1 0 0 0 1 1h6.5a1 1 0 0 0 1-1v-6a1 1 0 0 0-1-1h-4.44a3.5 3.5 0 0 1 2.35-2.79 1 1 0 1 0-.62-1.9Z"/></svg>';
const CHECK_MARK = '<svg aria-hidden="true" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="size-5 text-indigo-700"><path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5"/></svg>';

/**
 * The hero card is the catalog's `glass-surface` and its eyebrow the catalog's `shiny-text`, both
 * declared in ./catalog.json. The page CSP is `script-src 'none'`, so both are CSS-only blocks:
 * the host class and `--genui-*` properties are the whole effect, and no script is inlined.
 */
function renderHero(s: MarketingSiteRecipe['sections'][0]): string {
  const eyebrow = catalogBlock('shiny-text', e(s.text.eyebrow), {
    tag: 'p', className: 'text-sm font-semibold', attrs: { 'data-od-id': `${s.id}--eyebrow` },
    vars: { base: '#4f46e5', shine: '#c7d2fe', speed: '3.5s', pause: '2s' },
  });
  return `<section id="${s.id}"><div class="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">`
    + catalogBlock('glass-surface', eyebrow
    + slot('h1', 'mt-2 text-2xl font-semibold text-gray-900 sm:text-3xl', `${s.id}--heading`, s.text.heading)
    + slot('p', 'mt-4 text-pretty text-gray-700', `${s.id}--body`, s.text.body)
    + `<div class="mt-6 flex flex-wrap gap-4">`
    + `<a href="#${CTA_SECTION_ID}" class="rounded-full border border-indigo-600 bg-indigo-600 px-8 py-3 text-center text-sm font-medium text-white hover:bg-indigo-700 hover:ring-1 hover:ring-indigo-700" `
    + `data-od-id="${s.id}--primaryCta">${e(s.text.primaryCta)}</a>`
    + `<a href="#${FEATURES_SECTION_ID}" class="rounded-full border border-indigo-600 bg-white px-8 py-3 text-center text-sm font-medium text-indigo-600 hover:ring-1 hover:ring-indigo-600" `
    + `data-od-id="${s.id}--secondaryCta">${e(s.text.secondaryCta)}</a>`
    + `</div>`, {
      className: 'max-w-prose md:max-w-none border border-gray-200 p-6 shadow-xs',
      vars: { tint: '#eef2ff', opacity: 0.55, blur: '10px' },
    })
    + `</div></section>`;
}

function featureCard(sectionId: string, index: number, item: MarketingSiteFeature): string {
  return `<div class="rounded-lg border border-gray-200 p-6">`
    + slot('h3', 'mt-4 text-lg font-semibold text-gray-900', `${sectionId}--items-${index}--title`, item.title)
    + slot('p', 'mt-2 text-pretty text-gray-700', `${sectionId}--items-${index}--body`, item.body)
    + `</div>`;
}

function renderFeatures(s: MarketingSiteRecipe['sections'][1]): string {
  return `<section id="${s.id}"><div class="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">`
    + `<div class="mx-auto max-w-lg text-center">`
    + slot('h2', 'text-3xl/tight font-bold text-gray-900 sm:text-4xl', `${s.id}--heading`, s.text.heading)
    + slot('p', 'mt-4 text-lg text-pretty text-gray-700', `${s.id}--body`, s.text.body)
    + `</div>`
    + `<div class="mt-8 grid grid-cols-1 gap-8 md:grid-cols-3">`
    + s.items.map((item, index) => featureCard(s.id, index, item)).join('')
    + `</div></div></section>`;
}

function testimonialCard(sectionId: string, index: number, item: MarketingSiteTestimonial): string {
  // `name` is nullable (G5 FIX): a quote the brief attributes to no one still renders, just
  // without a named byline.
  const name = item.name === null ? '' : slot('p', 'text-sm font-medium text-gray-900', `${sectionId}--items-${index}--name`, item.name);
  return `<figure class="mx-auto max-w-2xl text-center">${QUOTE_MARK}`
    + `<blockquote class="mt-4">${slot('p', 'text-xl font-medium text-pretty text-gray-900 sm:text-2xl', `${sectionId}--items-${index}--quote`, item.quote)}</blockquote>`
    + `<figcaption class="mt-6 flex items-center justify-center gap-3"><div class="text-left">`
    + name
    + slot('p', 'text-sm text-gray-500', `${sectionId}--items-${index}--role`, item.role)
    + `</div></figcaption></figure>`;
}

/** The whole testimonial strip is a nullable atom (MARKETING_SITE_NULLABLE_ATOMS.proof): when
 * the brief states no proof, nothing is emitted for this section at all, not an empty frame. The
 * section can separately be dropped outright (MARKETING_SITE_OPTIONAL_SECTIONS): renderProof is
 * then never called at all (see `presentSections` below), so this only handles `items: null`. */
function renderProof(s: NonNullable<MarketingSiteRecipe['sections'][2]>): string {
  if (s.items === null) return '';
  return `<section id="${s.id}"><div class="mx-auto max-w-7xl space-y-12 px-4 py-8 sm:px-6 lg:px-8">`
    + s.items.map((item, index) => testimonialCard(s.id, index, item)).join('')
    + `</div></section>`;
}

function pricingTierCard(sectionId: string, index: number, item: MarketingSitePricingTier, featured: boolean): string {
  const cardClass = featured
    ? 'rounded-2xl border border-indigo-600 p-6 shadow-xs ring-1 ring-indigo-600 sm:px-8 lg:p-12'
    : 'rounded-2xl border border-gray-200 p-6 shadow-xs sm:px-8 lg:p-12';
  const ctaClass = featured
    ? 'mt-8 block rounded-full border border-indigo-600 bg-indigo-600 px-12 py-3 text-center text-sm font-medium text-white hover:bg-indigo-700 hover:ring-1 hover:ring-indigo-700'
    : 'mt-8 block rounded-full border border-indigo-600 bg-white px-12 py-3 text-center text-sm font-medium text-indigo-600 hover:ring-1 hover:ring-indigo-600';
  const features = item.features.map((feature, index2) =>
    `<li class="flex items-center gap-1">${CHECK_MARK}`
    + `${slot('span', 'text-gray-700', `${sectionId}--items-${index}--feature-${index2}`, feature)}</li>`).join('');
  return `<div class="${cardClass}"><div class="text-center">`
    + slot('h3', 'text-lg font-medium text-gray-900', `${sectionId}--items-${index}--name`, item.name)
    + `<p class="mt-2 sm:mt-4"><strong class="text-3xl font-bold text-gray-900 sm:text-4xl">`
    + `<span data-od-id="${sectionId}--items-${index}--price">${e(item.price)}</span></strong> `
    + `<span class="text-sm font-medium text-gray-700">${e(item.period)}</span></p></div>`
    + `<ul class="mt-6 space-y-2">${features}</ul>`
    // No real destination for a tier's own cta lives anywhere in this family (G5 round 2: the old
    // `href="#${sectionId}"` was a dead button on the section it already sits in) — plain text.
    + `${slot('span', 'mt-8 block text-center text-sm font-medium text-gray-700', `${sectionId}--items-${index}--cta`, item.cta)}`
    + `</div>`;
}

/** The whole pricing table is a nullable atom (MARKETING_SITE_NULLABLE_ATOMS.pricing): dropped
 * entirely, not an empty frame, when the brief carries no pricing to show. When shown, its tiers
 * are sample data (MARKETING_SITE_MOCK_SLOTS), so a visible caption sits under the heading. */
function renderPricing(s: MarketingSiteRecipe['sections'][3]): string {
  if (s.items === null) return '';
  return `<section id="${s.id}" data-od-mock="illustrative-pricing"><div class="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">`
    + slot('h2', 'text-center text-2xl font-semibold text-gray-900 sm:text-3xl', `${s.id}--heading`, s.text.heading)
    + `<p class="mt-2 text-center text-sm font-medium text-gray-500" data-od-mock="caption">${e(ILLUSTRATIVE_PRICING_CAPTION)}</p>`
    + `<div class="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-3 sm:items-center md:gap-8">`
    + s.items.map((item, index) => pricingTierCard(s.id, index, item, index === 1)).join('')
    + `</div></div></section>`;
}

function renderCta(s: MarketingSiteRecipe['sections'][4]): string {
  return `<section id="${s.id}" class="overflow-hidden bg-gray-50 sm:grid">`
    + `<div class="p-8 md:p-12 lg:px-16 lg:py-24"><div class="mx-auto max-w-xl text-center">`
    + slot('h2', 'text-2xl font-bold text-gray-900 md:text-3xl', `${s.id}--heading`, s.text.heading)
    + slot('p', 'text-gray-500 md:mt-4', `${s.id}--body`, s.text.body)
// No real destination lives anywhere in this family for the closing cta either (G5 round 2).
    + `<div class="mt-4 md:mt-8">${slot('span', 'inline-block text-sm font-medium text-gray-700', `${s.id}--cta`, s.text.cta)}</div>`
    + `</div></div></section>`;
}

/** A column whose links are all null states nothing: it renders no heading and no empty list.
 * A filled link is plain text, never an `<a>` (G5): "Product", "Company" and "Legal" columns
 * name no real page this compiler builds. */
function footerColumnHtml(sectionId: string, index: number, column: MarketingSiteFooterColumn): string {
  if (column.links.every((link) => link === null)) return '';
  const links = column.links.map((link, index2) => (link === null ? '' :
    `<li>${slot('span', 'text-gray-700', `${sectionId}--columns-${index}--link-${index2}`, link)}</li>`)).join('');
  return `<div><p class="font-medium text-gray-900" data-od-id="${sectionId}--columns-${index}--heading">${e(column.heading)}</p>`
    + `<ul class="mt-6 space-y-4 text-sm">${links}</ul></div>`;
}

function renderFooter(s: MarketingSiteRecipe['sections'][5]): string {
  const columns = s.items.columns.map((column, index) => footerColumnHtml(s.id, index, column)).join('');
  return `<footer id="${s.id}" class="bg-white"><div class="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">`
    + slot('p', 'text-gray-500', `${s.id}--tagline`, s.text.tagline)
    + (columns ? `<div class="mt-8 grid grid-cols-1 gap-8 sm:grid-cols-3">${columns}</div>` : '')
    + `</div></footer>`;
}

const RENDERERS: Record<string, (s: MarketingSiteRecipe['sections'][number]) => string> = {
  [HERO_SECTION_ID]: (s) => renderHero(s as MarketingSiteRecipe['sections'][0]),
  [FEATURES_SECTION_ID]: (s) => renderFeatures(s as MarketingSiteRecipe['sections'][1]),
  [PROOF_SECTION_ID]: (s) => renderProof(s as NonNullable<MarketingSiteRecipe['sections'][2]>),
  [PRICING_SECTION_ID]: (s) => renderPricing(s as MarketingSiteRecipe['sections'][3]),
  [CTA_SECTION_ID]: (s) => renderCta(s as MarketingSiteRecipe['sections'][4]),
  [FOOTER_SECTION_ID]: (s) => renderFooter(s as MarketingSiteRecipe['sections'][5]),
};

export function renderMarketingSite(recipe: MarketingSiteRecipe, _resolvedAssetPaths: Record<string, string>): string {
  // A dropped optional section (null, e.g. a null sections[2]) renders nothing at all.
  const body = presentSections(recipe.sections).map((section) => RENDERERS[section.id]!(section)).join('');
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'none'; style-src 'unsafe-inline'; script-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'">`
    + `<meta name="description" content="${e(recipe.brand.descriptor)}">`
    + `<title>${e(recipe.brand.name)}</title><style>${inlinedStyles()}</style></head>`
    + `<body class="bg-white">`
    + `<p class="sr-only" data-od-id="brand--name">${e(recipe.brand.name)}</p>`
    + `<p class="sr-only" data-od-id="brand--descriptor">${e(recipe.brand.descriptor)}</p>`
    + `${body}</body></html>\n`;
}

/** Read one text slot back out of saved HTML by its data-od-id. */
export function findMarketingSiteTextSlot(html: string, odId: string): string | undefined {
  if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(odId)) throw new Error('data-od-id: expected letters, digits and hyphens only');
  const pattern = new RegExp(`<([a-z0-9]+)\\b[^>]*\\sdata-od-id="${odId}"[^>]*>([\\s\\S]*?)</\\1>`, 'i');
  const match = pattern.exec(html);
  return match ? match[2]!.replace(/<[^>]*>/g, '').trim() : undefined;
}

/** Every data-od-id present in saved HTML, in document order. */
export function listMarketingSiteTextSlots(html: string): string[] {
  return [...html.matchAll(/data-od-id="([^"]+)"/g)].map((match) => match[1]!);
}

export { SECTION_ORDER, MARKETING_SITE_MOCK_SLOTS, MARKETING_SITE_NULLABLE_ATOMS, MARKETING_SITE_OPTIONAL_SECTIONS } from './slots.ts';
