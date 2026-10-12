/**
 * practice family — trusted renderer.
 *
 * Public surface used by the compiler's `families/registry.ts`:
 *   validatePracticeRecipe(input)          -> typed recipe
 *   getPracticeAssetRequirements(recipe)   -> AssetRequirement[] (always empty: no images)
 *   renderPractice(recipe, resolvedPaths)  -> HTML string
 *
 * Every class string this module emits is checked, in `render.test.ts`, against the compiled
 * `css/practice.css` (built by `scripts/build-ui-kit-css.ts practice`, which scans both the
 * vendored HyperUI blocks named in `pagekinds.json` and this file, exactly the way the shared
 * build tool documents), so a class with no rule fails there rather than silently rendering
 * unstyled. Reviews, insurance/pricing, FAQ, and hours-and-location are optional sections; a
 * brief that gives no evidence for one drops the whole section and, for FAQ and hours-location,
 * the header nav link that points only at it (`linkTo`).
 *
 * Every text slot sits in an element carrying `data-od-id`, emitted in `SECTIONS` order. Lists
 * (services, providers, reviews, insurance, FAQ) render exactly as many cards as the recipe
 * carries (`slots.ts`'s `min`/`count` on each) — never padded to a fixed count with invented or
 * borrowed content. The book section's `destination` is never a plain string href: `bookHref`
 * classifies the filled text as an email, a phone number or a URL and only ever emits the
 * matching honest scheme (`mailto:`, `tel:`, or the URL itself). A missing `destination` falls
 * back to a phone or email the SAME recipe already validated elsewhere on the page (hours &
 * location, then the footer) before it renders as plain, non-interactive text — see
 * `effectiveBookDestination`; it never invents a new fact, only reuses one the page already
 * shows. `meaningfulHoursRows` strips any hours row that reads as an unknown-fact placeholder
 * rather than a real hour, and the whole hours-and-location section (and its nav link) is
 * dropped when nothing meaningful remains in it. No map embed: this page kind carries no images,
 * iframes, external embeds or `<script>`.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { AssetRequirement } from '../../assets.ts';
import { linkTo, presentSections, sectionOfType } from '../../sections.ts';
import { parsePracticeRecipe, type PracticeItem, type PracticeRecipe, type PracticeSection } from './contract.ts';
import {
  BOOK_SECTION_ID, EXPECT_SECTION_ID, FAQ_NAV_LINK, FAQ_SECTION_ID, FOOTER_SECTION_ID, HEADER_SECTION_ID,
  HERO_SECTION_ID, HOURS_LOCATION_SECTION_ID, HOURS_NAV_LINK, INSURANCE_SECTION_ID, PROVIDERS_SECTION_ID,
  REVIEWS_SECTION_ID, SERVICES_SECTION_ID,
} from './slots.ts';

const HERE = import.meta.dirname;
const HYPERUI_CSS = path.join(HERE, '../../catalog/hyperui/practice.css');
let hyperuiCss: string | undefined;
/** The compiled Tailwind build for this page kind's blocks, read once and inlined once per page. */
function inlinedStyles(): string {
  hyperuiCss ??= readFileSync(HYPERUI_CSS, 'utf8');
  return hyperuiCss;
}

export function validatePracticeRecipe(input: unknown): PracticeRecipe {
  return parsePracticeRecipe(input);
}

/** No image, font or video assets. */
export function getPracticeAssetRequirements(_recipe: PracticeRecipe): AssetRequirement[] {
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
/** A nullable phone atom: nothing when null, else the displayed number wrapped in a `tel:` link. */
function telAtom(className: string, id: string, value: string | null): string {
  if (value === null) return '';
  const href = `tel:${value.replace(/[ ()-]/g, '')}`;
  const classes = className ? ` class="${className}"` : '';
  return `<a href="${e(href)}"${classes} data-od-id="${id}">${e(value)}</a>`;
}
/** A nullable email atom: nothing when null, else the displayed address wrapped in a `mailto:` link. */
function mailAtom(className: string, id: string, value: string | null): string {
  if (value === null) return '';
  const href = `mailto:${encodeURIComponent(value)}`;
  const classes = className ? ` class="${className}"` : '';
  return `<a href="${e(href)}"${classes} data-od-id="${id}">${e(value)}</a>`;
}
const str = (record: Record<string, unknown>, name: string) => record[name] as string;
const nullable = (record: Record<string, unknown>, name: string) => record[name] as string | null;
const items = (s: PracticeSection) => s.items ?? [];

// ---------------------------------------------------------------------------------------------
// Shared layout tokens. Consistent vertical rhythm, a centered narrow header for every content
// section, and a visible keyboard-focus ring on every interactive element.
// ---------------------------------------------------------------------------------------------

const WRAP = 'mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-20 lg:px-8';
const HEAD_WRAP = 'mx-auto max-w-2xl text-center';
const H2 = 'text-3xl font-semibold tracking-tight text-gray-900 sm:text-4xl';
const LEAD = 'mt-4 text-pretty text-gray-600';
const CARD = 'rounded-2xl border border-gray-200 bg-white p-6 shadow-sm transition-shadow hover:shadow-md sm:p-8';
const FOCUS = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600';
const BTN_PRIMARY = `inline-flex items-center justify-center gap-2 rounded-full bg-blue-600 px-6 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-700 ${FOCUS}`;
/** The primary button, inverted for use on the book section's own blue background: white fill,
 * blue text — bg-blue-600-on-blue-600 would be all but invisible. */
const BTN_PRIMARY_ON_BLUE = `inline-flex items-center justify-center gap-2 rounded-full bg-white px-6 py-3 text-sm font-semibold text-blue-700 shadow-sm transition hover:bg-blue-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white`;
const BTN_PILL = `rounded-full bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-700 ${FOCUS}`;
const LINK = `text-gray-600 transition hover:text-gray-900 ${FOCUS}`;

/** A section's centered heading + optional lead, the same shape on every content section below
 * the hero, so alignment and max-width read as one consistent rhythm instead of a mix of
 * left-aligned and centered blocks. */
function sectionHead(id: string, headingId: string, heading: string, bodyId?: string, body?: string): string {
  return `<div class="${HEAD_WRAP}">`
    + slot('h2', H2, headingId, heading)
    + (bodyId && body ? slot('p', LEAD, bodyId, body) : '')
    + `</div>`;
}

// ---------------------------------------------------------------------------------------------
// Service icons: a small, reviewed set of inline SVGs chosen deterministically by keyword match
// against a service's title, never a placeholder glyph. `genericIcon` (a calendar) is the
// fallback for a service whose title matches no keyword, since "book an appointment" is true of
// every service this page kind describes.
// ---------------------------------------------------------------------------------------------

const ICON_WRAP = 'inline-flex size-12 items-center justify-center rounded-full bg-blue-50 text-blue-600';
const iconSvg = (path1: string) => `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="size-6">${path1}</svg>`;
const ICONS: Record<string, string> = {
  tooth: iconSvg('<path d="M12 3c-2.5 0-4.5 1.3-5.5 2.7C5.6 6.8 5 8.4 5 10c0 2 .8 3.3 1.5 5 .6 1.4 1 3.3 1.8 4.6.4.7 1.4.6 1.7-.2l1.2-3.4c.2-.6.7-1 1.3-1h.5c.6 0 1.1.4 1.3 1l1.2 3.4c.3.8 1.3.9 1.7.2.8-1.3 1.2-3.2 1.8-4.6.7-1.7 1.5-3 1.5-5 0-1.6-.6-3.2-1.5-4.3C16.5 4.3 14.5 3 12 3Z"/>'),
  shield: iconSvg('<path d="M12 21c4-1.5 7-5 7-10V6l-7-3-7 3v5c0 5 3 8.5 7 10Z"/><path d="m9.5 12 1.8 1.8L14.5 10"/>'),
  sparkle: iconSvg('<path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8"/>'),
  paw: iconSvg('<circle cx="7" cy="9" r="1.7"/><circle cx="12" cy="6.5" r="1.7"/><circle cx="17" cy="9" r="1.7"/><path d="M12 12c-3 0-5.5 2-5.5 4.5S8.5 21 12 21s5.5-2 5.5-4.5S15 12 12 12Z"/>'),
  stethoscope: iconSvg('<path d="M6 4v6a4 4 0 0 0 8 0V4"/><path d="M10 20a4 4 0 0 0 4-4v-2"/><circle cx="18" cy="8" r="1.7"/>'),
  calendar: iconSvg('<rect x="4" y="5" width="16" height="16" rx="2"/><path d="M8 3v4M16 3v4M4 10h16"/>'),
  eye: iconSvg('<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="2.5"/>'),
  bone: iconSvg('<path d="M6.5 6.5a2 2 0 1 0-2.8 2.8L14.7 20.3a2 2 0 1 0 2.8-2.8L6.5 6.5Z"/><circle cx="5.5" cy="5.5" r="1.6"/><circle cx="18.5" cy="18.5" r="1.6"/>'),
};
const ICON_KEYWORDS: readonly [RegExp, string][] = [
  [/tooth|teeth|dental|denture|orthodont|filling|crown|root canal|whiten/i, 'tooth'],
  [/vaccin|shield|insurance|prevent|check-?up|screen|safety/i, 'shield'],
  [/cosmetic|whiten|veneer|aesthet|beauty|glow|smile makeover|sparkle/i, 'sparkle'],
  [/dog|cat|pet|animal|paw|vet/i, 'paw'],
  [/exam|physical|therapy|rehab|recovery|injury|stetho|clinical|surgery/i, 'stethoscope'],
  [/vision|eye|optic/i, 'eye'],
  [/ortho|bone|joint|spine|fracture/i, 'bone'],
];
/** The icon matching `title`'s first keyword hit, or the calendar fallback. Deterministic: same
 * title, same icon, every render. */
function iconFor(title: string): string {
  for (const [pattern, key] of ICON_KEYWORDS) if (pattern.test(title)) return ICONS[key]!;
  return ICONS.calendar!;
}

/** The section id each header nav link (by index) points at — a real in-page anchor, never a
 * placeholder `#`, so `dishonestLinks` (the shared link-honesty check) passes. `links[0]`
 * (Services) always resolves, since the section is required and never empty; `[1]` (Providers)
 * is required at the contract level but its render-time filter can still empty it out (see
 * `providersSectionIsMeaningful`), so it is linked only when a card actually survives, the same
 * as `[2]`/`[3]` (FAQ, hours), which are conditionally rendered below. */
const NAV_LINK_TARGETS: Readonly<Record<number, string>> = { 0: SERVICES_SECTION_ID, 1: PROVIDERS_SECTION_ID, [FAQ_NAV_LINK]: FAQ_SECTION_ID, [HOURS_NAV_LINK]: HOURS_LOCATION_SECTION_ID };
/** The header/footer nav index `NAV_LINK_TARGETS` gives the providers section. */
const PROVIDERS_NAV_LINK = 1;
/**
 * A FIXED label per header nav index, never model text (round-2 Grok audit: the header nav used
 * to carry a model-written `links` array, and nothing checked that a label actually named the
 * section its index pointed at — a live build wrote "Vaccinations" over the link that jumps to
 * "Meet your provider"). These are the SAME literal strings `FOOTER_NAV_LABELS` uses for the same
 * sections, so the header and footer never disagree about what to call one.
 */
const HEADER_NAV_LABELS: Readonly<Record<number, string>> = { 0: 'Services', [PROVIDERS_NAV_LINK]: 'Providers', [FAQ_NAV_LINK]: 'FAQ', [HOURS_NAV_LINK]: 'Hours & location' };

function renderHeader(s: PracticeSection, recipe: PracticeRecipe): string {
  const faq = sectionOfType(recipe, 'faq');
  const hoursLocation = sectionOfType(recipe, 'hours-location');
  const showHours = hoursLocation && hoursLocationIsMeaningful(hoursLocation);
  const showProviders = providersSectionIsMeaningful(recipe);
  const links = Object.entries(HEADER_NAV_LABELS).map(([indexKey, label]) => {
    const index = Number(indexKey);
    const target = NAV_LINK_TARGETS[index];
    // No `data-od-id`: like the footer nav, this is fixed chrome, never a model-editable slot.
    const html = `<li><a href="#${target}" class="border-b-2 border-transparent px-4 py-2 text-sm font-medium text-gray-600 transition-colors hover:text-gray-900 hover:border-gray-300 ${FOCUS}">${e(label)}</a></li>`;
    if (index === PROVIDERS_NAV_LINK) return showProviders ? html : '';
    if (index === FAQ_NAV_LINK) return linkTo(faq, html);
    if (index === HOURS_NAV_LINK) return showHours ? html : '';
    return html;
  }).join('');
  // Sticky, compact header: the book action stays reachable while scrolling, with no script. A
  // fixed `h-16` clipped the book/call controls at 390px whenever `flex-wrap` actually had to wrap
  // them onto a second row — the row wrapped, but the fixed-height box around it did not grow to
  // hold it (round-6 Grok audit). `min-h-16` sets the same one-row height as a floor, never a
  // ceiling, so a wrapped second row grows the header instead of being cut off by it.
  return `<header id="${s.id}" class="sticky top-0 z-10 border-b border-gray-200 bg-white/95 backdrop-blur"><div class="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8"><div class="flex min-h-16 flex-wrap items-center justify-between gap-4 py-2">`
    + slot('p', 'text-base font-semibold text-gray-900', 'brand--name', recipe.brand.name)
    + slot('p', 'sr-only', 'brand--descriptor', recipe.brand.descriptor)
    + `<nav class="hidden lg:block"><ul class="flex flex-wrap gap-2">${links}</ul></nav>`
    + `<a href="#${BOOK_SECTION_ID}" class="${BTN_PILL}" data-od-id="${s.id}--bookCta">${e(str(s.text, 'bookCta'))}</a>`
    + `</div></div></header>`;
}

/** Up to three non-fabricated trust facts for the hero's right-hand panel: counts the page's own
 * services and providers arrays (never a new number), plus the address/phone the page already
 * validates in hours-location, when that section carries one. Nothing here is a fact the rest of
 * the recipe does not already show. */
/**
 * Trust-panel facts for the hero — ONLY facts the brief actually supplied, reused from elsewhere
 * on the SAME recipe (hours-location's own phone/address, the footer's own phone/email as a
 * fallback). Never a count of this page's own rendered list items: "Services offered: 3" or
 * "Providers on staff: 1" is filler about the page's own layout, not a trust signal about the
 * practice, and it can silently disagree with what actually renders (a padded or later-filtered
 * list). No brief-supplied facts anywhere on the page means no trust panel at all — never a
 * fallback to counting.
 */
function heroTrustFacts(recipe: PracticeRecipe): { label: string; value: string }[] {
  const facts: { label: string; value: string }[] = [];
  const hoursLocation = sectionOfType(recipe, 'hours-location');
  const footer = sectionOfType(recipe, 'footer');
  const phone = (hoursLocation && nullable(hoursLocation.text, 'phone')) ?? (footer && nullable(footer.text, 'phone')) ?? null;
  const address = (hoursLocation && nullable(hoursLocation.text, 'address')) ?? (footer && nullable(footer.text, 'address')) ?? null;
  const email = footer ? nullable(footer.text, 'email') : null;
  if (phone) facts.push({ label: 'Call to book', value: phone });
  if (address) facts.push({ label: 'Location', value: address });
  if (facts.length === 0 && email) facts.push({ label: 'Email to book', value: email });
  // A panel whose ONLY fact is the same phone number the book section's own CTA already calls is
  // not a trust signal, just the same number said twice on one screen — drop it rather than show
  // a one-line panel that adds nothing a visitor cannot already do by pressing "Book".
  if (facts.length === 1 && facts[0]!.label === 'Call to book') {
    const bookPhone = effectiveBookDestination(recipe);
    const digits = (value: string) => value.replace(/\D/g, '');
    if (bookPhone !== null && digits(bookPhone) === digits(facts[0]!.value) && digits(bookPhone) !== '') return [];
  }
  return facts.slice(0, 3);
}

/**
 * A per-page dedup guard for the five always-rendered sections' own intro/body copy (hero,
 * services, providers, expect, book). A brief starved for facts — a sparse one-provider, one-
 * phone-number practice with almost nothing else to say — otherwise causes a model to restate its
 * one distinctive fact in every section's intro at once ("Dr. Hannah Okafor, DVM, sees every
 * patient" verbatim in hero, services, providers, expect and book copy all together, the exact
 * defect a review of a sparse-vet build found). `bodyText` tracks each section's own body against
 * every EARLIER section's already-rendered body, in render order; a body whose longest run of
 * consecutive shared words with an earlier one reaches the threshold (6 words — the same run
 * length `deterministicQuoteFlags` in packages/agency-fast-lane/src/jev.ts already uses to decide
 * "the same words, not a coincidence") is dropped entirely rather than shown a second time. The
 * FIRST section to state a fact always keeps it; only a LATER restatement is omitted, since the
 * fact itself is honest — sectionHead and the hero/book body slots already render nothing at all
 * for an empty body, so dropping down to `''` is enough.
 */
const BODY_REPEAT_WORD_THRESHOLD = 6;
function bodyWords(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
}
function longestSharedRun(a: readonly string[], b: readonly string[]): number {
  let best = 0;
  for (let start = 0; start < a.length; start++) {
    for (let len = a.length - start; len > best; len--) {
      const run = a.slice(start, start + len);
      for (let at = 0; at + len <= b.length; at++) {
        if (run.every((word, index) => b[at + index] === word)) { best = Math.max(best, len); break; }
      }
    }
  }
  return best;
}
function bodyText(seen: string[][], text: string): string {
  const own = bodyWords(text);
  if (seen.some((earlier) => longestSharedRun(own, earlier) >= BODY_REPEAT_WORD_THRESHOLD)) return '';
  seen.push(own);
  return text;
}

function renderHero(s: PracticeSection, recipe: PracticeRecipe, seen: string[][]): string {
  const facts = heroTrustFacts(recipe);
  const body = bodyText(seen, str(s.text, 'body'));
  // `flex-wrap` on the row, and `min-w-0` on the value, so a long trust value (a street address)
  // wraps onto its own line instead of being squeezed past the card's own edge at 390px
  // (round-6 Grok audit: "4820 NE Sandy Blvd, Portland, OR 97" was cut off mid-word). `w-full`
  // (mobile-first, `lg:w-80` still wins above `lg:`) matters as much as the row/value fixes above:
  // this card's own parent no longer stretches its flex children to the row's full cross-axis
  // width (the same `items-center` squeeze the hero copy column's own fix, above, removes), so
  // without an explicit width this card falls back to shrink-to-fit sizing — which sizes itself
  // to its UNWRAPPED content's own max-content width (the full address on one line) rather than
  // the viewport, and nothing then constrains that width back down to 390px at all.
  const trustPanel = facts.length === 0 ? '' : `<div class="${CARD} w-full lg:w-80"><dl class="space-y-6">`
    + facts.map((fact) => `<div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-gray-100 pb-4 last:border-0 last:pb-0">`
      + `<dt class="text-sm text-gray-500">${e(fact.label)}</dt>`
      + `<dd class="min-w-0 flex-1 text-right text-base font-semibold text-balance text-gray-900">${e(fact.value)}</dd>`
      + `</div>`).join('')
    + `</dl></div>`;
  // No trust panel: the copy takes the full width and centers itself, a deliberate one-column
  // layout rather than a narrow max-w-xl column with unused space where a panel used to sit.
  // `w-full min-w-0` (round-6 Grok audit): the flex parent below no longer puts `items-center` on
  // the cross axis for this case, which used to shrink-wrap this column to its own content's
  // natural width instead of the viewport's — at 390px that sized the headline to one long
  // unbroken line and clipped it at the edge instead of wrapping. `min-w-0` overrides a flex
  // item's default `min-width: auto` (content-based), which alone can still refuse to shrink
  // below a long word or heading's intrinsic width.
  const copyWidth = facts.length === 0 ? 'max-w-3xl text-center' : 'max-w-xl';
  const ctaWrap = facts.length === 0 ? 'mt-8 flex justify-center' : 'mt-8';
  return `<section id="${s.id}" class="border-b border-gray-100 bg-linear-to-b from-blue-50/60 to-white"><div class="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-24 lg:px-8">`
    + `<div class="flex flex-col items-start gap-10 lg:flex-row lg:items-center lg:justify-between">`
    + `<div class="${copyWidth} w-full min-w-0">`
    + slot('p', 'text-sm font-semibold tracking-wide text-blue-600 uppercase', `${s.id}--eyebrow`, str(s.text, 'eyebrow'))
    + slot('h1', 'mt-3 text-4xl font-bold tracking-tight text-balance text-gray-900 sm:text-5xl', `${s.id}--heading`, str(s.text, 'heading'))
    + (body ? slot('p', 'mt-6 text-lg text-pretty text-gray-600', `${s.id}--body`, body) : '')
    + `<div class="${ctaWrap}"><a href="#${BOOK_SECTION_ID}" class="${BTN_PRIMARY}" data-od-id="${s.id}--bookCta">${e(str(s.text, 'bookCta'))}</a></div>`
    + `</div>`
    + trustPanel
    + `</div></div></section>`;
}

function renderServices(s: PracticeSection, _recipe: PracticeRecipe, seen: string[][]): string {
  const list = items(s);
  const body = bodyText(seen, str(s.text, 'body'));
  const cards = list.map((item, index) => `<div class="${CARD}">`
    + `<span class="${ICON_WRAP}">${iconFor(str(item, 'title'))}</span>`
    + slot('h3', 'mt-5 text-lg font-semibold text-gray-900', `${s.id}--items-${index}--title`, str(item, 'title'))
    + slot('p', 'mt-2 text-pretty text-gray-600', `${s.id}--items-${index}--body`, str(item, 'body'))
    + `</div>`).join('');
  const cols = list.length >= 3 ? 'sm:grid-cols-2 lg:grid-cols-3' : list.length === 2 ? 'sm:grid-cols-2' : '';
  return `<section id="${s.id}"><div class="${WRAP}">`
    + sectionHead(s.id, `${s.id}--heading`, str(s.text, 'heading'), `${s.id}--body`, body)
    + `<div class="mt-12 grid grid-cols-1 gap-6 ${cols}">${cards}</div></div></section>`;
}

/**
 * Every other section's own item-title text (services' titles, expect's step titles) — text that
 * already stands for a THING, not a person, on this same page. A provider "name" that IS one of
 * these, word for word, is a treatment or a step standing in for a person's name, not a padding
 * the deterministic attribution gate alone can catch (a service title copied into a brief's
 * prose is a verbatim, brief-true string like any other, so it passes the name-appears-in-the-
 * brief check cleanly).
 */
function nonPersonTitlesOnPage(recipe: PracticeRecipe): string[] {
  const services = sectionOfType(recipe, 'services');
  const expect = sectionOfType(recipe, 'expect');
  return [...(services ? items(services).map((item) => str(item, 'title')) : []), ...(expect ? items(expect).map((item) => str(item, 'title')) : [])];
}
/** `text`, lowercased with all punctuation collapsed to single spaces — the shape whole-word
 * equality compares, so `"X-Rays"` becomes `"x rays"` and never equals a shorter word it merely
 * contains a run of characters from (`"Ray"` becomes `"ray"`, which is not `"x rays"`). */
function normalizedWords(text: string): string {
  return text.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}
/**
 * `true` when `name` is not a real provider name but a service's or step's own title leaked
 * across sections — the fabrication this contract exists to refuse. Matched by WHOLE-WORD
 * equality only (the full normalized name must equal the full normalized title), never a
 * substring test either direction: a substring test wrongly dropped real short names that
 * happen to share LETTERS with an unrelated title word — "Ray" inside "Exam and X-rays" (title
 * word "x-rays", not "ray"), "Sam" inside "Same-day crowns", "Ann" inside "Annual cleaning",
 * "Pat" inside "New patient exam". None of those are the title reused as a name; a real short
 * name is never dropped just because a longer title word happens to contain its letters.
 */
function isProviderNameBorrowedFromServices(recipe: PracticeRecipe, name: string): boolean {
  const normalized = normalizedWords(name);
  if (!normalized) return false;
  return nonPersonTitlesOnPage(recipe).some((title) => normalizedWords(title) === normalized);
}

/** A leading honorific ("Dr.", "Dr", "Mr.", "Ms.", "Mx.", "Prof.") — stripped before comparing two
 * spellings of the same provider's name for dedup. */
const HONORIFIC_PREFIX = /^(?:dr|mr|mrs|ms|mx|prof)\.?\s+/i;
/** A trailing professional-credential suffix ("DVM", "DDS", "DMD", "MD", "RDH", "PT", …), with or
 * without a leading comma — stripped, possibly more than once (`stripCredentialSuffixes` loops),
 * before comparing two spellings of the same provider's name for dedup. Scoped to the credentials
 * this family's own target practices actually use (dentistry, veterinary medicine, medicine,
 * physiotherapy, dermatology, fertility, aesthetics), not an exhaustive licensing-body list. */
const CREDENTIAL_SUFFIX = /,?\s*(?:dds|dmd|dvm|md|do|rdh|rn|np|pa-c|pa|dpt|pt|dc|od|pharmd|phd|lac|lmt|cnm)\.?\s*$/i;
function stripCredentialSuffixes(name: string): string {
  let out = name;
  let previous: string;
  do {
    previous = out;
    out = out.replace(CREDENTIAL_SUFFIX, '').trim();
  } while (out !== previous);
  return out;
}
/**
 * `name`, normalized for identity comparison: honorific prefix and credential suffix(es)
 * stripped, then case- and whitespace-folded — so `"Dr. Hannah Okafor"` and `"Dr. Hannah Okafor,
 * DVM"` (the SAME provider, written two different ways across two padded cards) compare equal,
 * the exact case the round-3 Grok audit found still rendering twice under a plain trim+casefold.
 */
function normalizedProviderIdentity(name: string): string {
  return stripCredentialSuffixes(name.trim().replace(HONORIFIC_PREFIX, '')).toLowerCase().replace(/\s+/g, ' ');
}

/**
 * The section's own items, minus any card whose name is borrowed padding
 * (`isProviderNameBorrowedFromServices`) or a duplicate of an earlier real name (a solo
 * practitioner padded to `count` by writing the SAME real person again under different filler
 * credential text, or under a differently-punctuated credential suffix on the name itself — as
 * dishonest as inventing a second person, just harder to catch by name alone; only the first card
 * for a given normalized identity survives).
 */
function meaningfulProviderItems(s: PracticeSection, recipe: PracticeRecipe): PracticeItem[] {
  const seenNames = new Set<string>();
  return items(s).filter((item) => {
    if (isProviderNameBorrowedFromServices(recipe, str(item, 'name'))) return false;
    const normalized = normalizedProviderIdentity(str(item, 'name'));
    if (seenNames.has(normalized)) return false;
    seenNames.add(normalized);
    return true;
  });
}
/** Whether the providers section has at least one real card left once the borrowed/duplicate
 * filter runs — the section is `min: 1` at the CONTRACT level, but that filter can still reduce
 * it to zero at render time, and this family never renders an empty section, its heading, or a
 * nav link pointing at one (see `renderProviders`, `renderHeader`, `deterministicFooterNav`). */
function providersSectionIsMeaningful(recipe: PracticeRecipe): boolean {
  const providers = sectionOfType(recipe, 'providers');
  return providers !== undefined && meaningfulProviderItems(providers, recipe).length > 0;
}

function renderProviders(s: PracticeSection, recipe: PracticeRecipe, seen: string[][]): string {
  const meaningful = meaningfulProviderItems(s, recipe);
  if (meaningful.length === 0) return '';
  const body = bodyText(seen, str(s.text, 'body'));
  const cards = items(s).map((item, index) => {
    if (!meaningful.includes(item)) return '';
    return `<div class="${CARD} text-center">`
      + slot('h3', 'text-lg font-semibold text-gray-900', `${s.id}--items-${index}--name`, str(item, 'name'))
      + slot('p', 'mt-2 text-sm text-pretty text-gray-600', `${s.id}--items-${index}--credential`, str(item, 'credential'))
      + `</div>`;
  }).join('');
  const cols = meaningful.length >= 3 ? 'sm:grid-cols-2 lg:grid-cols-3' : meaningful.length === 2 ? 'sm:grid-cols-2' : 'mx-auto max-w-sm';
  return `<section id="${s.id}" class="bg-gray-50"><div class="${WRAP}">`
    + sectionHead(s.id, `${s.id}--heading`, str(s.text, 'heading'), `${s.id}--body`, body)
    + `<div class="mt-12 grid grid-cols-1 gap-6 ${cols}">${cards}</div></div></section>`;
}

function renderExpect(s: PracticeSection, _recipe: PracticeRecipe, seen: string[][]): string {
  const body = bodyText(seen, str(s.text, 'body'));
  const steps = items(s).map((item, index) => `<li class="relative -ms-1.5 flex items-start gap-4"><span class="mt-1 size-3 shrink-0 rounded-full bg-blue-600"></span><div class="-mt-1 text-left">`
    + slot('p', 'text-xs/none font-semibold tracking-wide text-blue-600 uppercase', `${s.id}--items-${index}--step`, str(item, 'step'))
    + slot('h3', 'mt-1 text-lg font-semibold text-gray-900', `${s.id}--items-${index}--title`, str(item, 'title'))
    + slot('p', 'mt-1 text-sm text-gray-600', `${s.id}--items-${index}--body`, str(item, 'body'))
    + `</div></li>`).join('');
  return `<section id="${s.id}"><div class="${WRAP}">`
    + sectionHead(s.id, `${s.id}--heading`, str(s.text, 'heading'), `${s.id}--body`, body)
    + `<ol class="relative mx-auto mt-12 max-w-md space-y-8 before:absolute before:-ms-px before:h-full before:w-0.5 before:rounded-full before:bg-gray-200">${steps}</ol>`
    + `</div></section>`;
}

/**
 * The book call's link, built only from the filled destination text: a leading `http://`/
 * `https://` classifies it as a URL (used as-is) — checked FIRST, since a URL can legitimately
 * carry an `@` in its path, query or userinfo (`https://clinic.example/book?e=ada@clinic.example`
 * is a URL, never an email); only when there is no URL scheme does an `@` classify it as an email
 * (`mailto:`); anything else is a phone number (`tel:`, stripped the same way `telAtom` does).
 * Never a separate unvalidated href.
 */
function bookHref(destination: string): string {
  if (/^https?:\/\//i.test(destination)) return destination;
  if (destination.includes('@')) return `mailto:${encodeURIComponent(destination)}`;
  return `tel:${destination.replace(/[ ()-]/g, '')}`;
}

/**
 * The book call's real destination: the section's own `destination` atom, or — when that is
 * null — a phone or email the SAME recipe already validated elsewhere on the page (hours &
 * location's phone, then the footer's phone, then the footer's email), in that order. This never
 * invents a new fact: every value it can return is one the page already shows and reconciles
 * under its own data-od-id; it only saves the visitor from a working phone number sitting three
 * sections away from the one button asking them to use it.
 */
function effectiveBookDestination(recipe: PracticeRecipe): string | null {
  const book = sectionOfType(recipe, 'book');
  const own = book ? nullable(book.text, 'destination') : null;
  if (own !== null) return own;
  const hoursLocation = sectionOfType(recipe, 'hours-location');
  const footer = sectionOfType(recipe, 'footer');
  return (hoursLocation && nullable(hoursLocation.text, 'phone'))
    ?? (footer && nullable(footer.text, 'phone'))
    ?? (footer && nullable(footer.text, 'email'))
    ?? null;
}

function renderBook(s: PracticeSection, recipe: PracticeRecipe, seen: string[][]): string {
  const destination = nullable(s.text, 'destination');
  const effective = effectiveBookDestination(recipe);
  const body = bodyText(seen, str(s.text, 'body'));
  // A missing destination never becomes a dead, button-shaped link: when nothing at all is
  // available anywhere on the page, the call renders as plain text with no button chrome at all
  // (no border, no fill, no padding that would read as a disabled control).
  const cta = effective === null
    ? slot('span', 'block text-base font-medium text-blue-50', `${s.id}--cta`, str(s.text, 'cta'))
    : `<a href="${e(bookHref(effective))}" class="${BTN_PRIMARY_ON_BLUE} px-10 py-4 text-base" data-od-id="${s.id}--cta">${e(str(s.text, 'cta'))}</a>`;
  return `<section id="${s.id}" class="bg-blue-600"><div class="mx-auto max-w-3xl px-4 py-16 text-center sm:px-6 sm:py-20 lg:px-8">`
    + slot('h2', 'text-3xl font-semibold tracking-tight text-white sm:text-4xl', `${s.id}--heading`, str(s.text, 'heading'))
    + (body ? slot('p', 'mt-4 text-pretty text-blue-100', `${s.id}--body`, body) : '')
    + `<div class="mt-8">${cta}</div>`
    // The section's OWN destination atom keeps its own reconcilable data-od-id, sr-only, even
    // when the visible button used a fallback: a dropped own-destination is still traceable and
    // never silently invented back into the recipe.
    + atom('span', 'sr-only', `${s.id}--destination`, destination)
    + `</div></section>`;
}

function renderReviews(s: PracticeSection): string {
  const reviews = items(s).map((item, index) => `<li class="${CARD}">`
    + `<svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor" class="size-6 text-blue-200"><path d="M7.17 6.17A5.5 5.5 0 0 0 3 11.5V18a1 1 0 0 0 1 1h6.5a1 1 0 0 0 1-1v-6a1 1 0 0 0-1-1H6.06a3.5 3.5 0 0 1 2.35-2.79 1 1 0 1 0-.62-1.9Zm10 0A5.5 5.5 0 0 0 13 11.5V18a1 1 0 0 0 1 1h6.5a1 1 0 0 0 1-1v-6a1 1 0 0 0-1-1h-4.44a3.5 3.5 0 0 1 2.35-2.79 1 1 0 1 0-.62-1.9Z"/></svg>`
    + slot('p', 'mt-3 text-gray-700', `${s.id}--items-${index}--quote`, str(item, 'quote'))
    + slot('p', 'mt-4 text-sm font-semibold text-gray-900', `${s.id}--items-${index}--name`, str(item, 'name'))
    + `</li>`).join('');
  const cols = items(s).length >= 3 ? 'sm:grid-cols-2 lg:grid-cols-3' : items(s).length === 2 ? 'sm:grid-cols-2' : 'mx-auto max-w-md';
  return `<section id="${s.id}"><div class="${WRAP}">`
    + sectionHead(s.id, `${s.id}--heading`, str(s.text, 'heading'))
    + `<ul class="mt-12 grid grid-cols-1 gap-6 ${cols}">${reviews}</ul></div></section>`;
}

function renderInsurance(s: PracticeSection): string {
  const list = items(s);
  const rows = list.map((item, index) => {
    const rawPrice = nullable(item, 'price');
    // A vague hedge ("Varies by plan") is not a price the practice can stand behind — the same
    // failure shape VAGUE_FACT already catches for hours rows. Treated as if the fill had left
    // it null: the row keeps its name and detail, just never a fabricated-sounding price line.
    const price = atom('p', 'mt-3 text-sm font-semibold text-blue-600', `${s.id}--items-${index}--price`, rawPrice !== null && VAGUE_FACT.test(rawPrice) ? null : rawPrice);
    return `<div class="${CARD}">`
      + slot('h3', 'text-lg font-semibold text-gray-900', `${s.id}--items-${index}--name`, str(item, 'name'))
      + slot('p', 'mt-1 text-sm text-gray-600', `${s.id}--items-${index}--detail`, str(item, 'detail'))
      + price
      + `</div>`;
  }).join('');
  const cols = list.length >= 2 ? 'sm:grid-cols-2' : 'mx-auto max-w-md';
  return `<section id="${s.id}" class="bg-gray-50"><div class="${WRAP}">`
    + sectionHead(s.id, `${s.id}--heading`, str(s.text, 'heading'), `${s.id}--body`, str(s.text, 'body'))
    + `<div class="mt-12 grid grid-cols-1 gap-6 ${cols}">${rows}</div></div></section>`;
}

function renderFaq(s: PracticeSection): string {
  const rows = items(s).map((item, index) => `<div class="border-b border-gray-200 py-5 text-left first:pt-0 last:border-0 last:pb-0">`
    + slot('dt', 'font-semibold text-gray-900', `${s.id}--items-${index}--question`, str(item, 'question'))
    + slot('dd', 'mt-2 text-sm text-gray-600', `${s.id}--items-${index}--answer`, str(item, 'answer'))
    + `</div>`).join('');
  return `<section id="${s.id}"><div class="${WRAP}">`
    + sectionHead(s.id, `${s.id}--heading`, str(s.text, 'heading'))
    + `<div class="mx-auto mt-10 max-w-2xl">${rows}</div>`
    + `</div></section>`;
}

/**
 * `true` when a filled hours row is a real hour, not an "unknown" placeholder a model might write
 * when it is pressed to fill a row the brief gives no evidence for (`min: 0` on this section's
 * items means it never has to). Defensive: even a well-formed placeholder never gets past this.
 */
/**
 * A hedge or vague non-fact, standing in for a real one a fill had no evidence to state — "Not
 * published online" for an hours row, "Varies by plan" for an insurance price. `min: 0`/nullable
 * atoms mean a fill never HAS to write one of these to satisfy the schema; this is a defensive
 * filter for when one does anyway. Applied to hours rows (`meaningfulHoursRows`) and insurance
 * prices (`renderInsurance`) alike, since both are the same failure shape: a plausible-sounding
 * sentence with no actual content.
 */
const VAGUE_FACT = /not (published|available|listed|provided)|unknown|n\/?a\b|tbd|to be (confirmed|determined)|(contact|call|ask)(ing)? (us )?(for|about|to book)|please (call|contact)|see (phone|below|front desk|staff)|call for|call to book|varies|depends (on|by)/i;
/**
 * A row whose LABEL doesn't even read as a day-of-week or a day-range ("Patients: Dogs and cats",
 * "Care: Dr. Hannah Okafor, DVM") is not an hours row at all — a real one a model has no evidence
 * for. WHOLE-WORD only (round-3 Grok audit: an un-anchored substring test kept "Open" — no day
 * token at all — and "Birthday" — "day" as a fragment of an unrelated word, not a day name):
 * `\b…\b` requires the day token itself, never a fragment inside a longer unrelated word. Scoped
 * to day identifiers and day-ranges, not generic states like "open"/"closed"/"hour" on their own,
 * which name no particular day and are not day-range tokens either.
 *
 * This token set must stay byte-identical to `packages/agency-fast-lane/src/jev.ts`'s own
 * `DAY_TOKEN` (hand-kept in sync — this family-owned copy cannot import a fast-lane workspace
 * package). A round-5 Grok audit found the two had already drifted: this list accepts
 * `daily`/`weekday`/`weekend`/`holiday` as real rows, but `DAY_TOKEN` did not carry them at all,
 * so `deterministicHoursLabelFlags` silently skipped every one of those labels as "not a
 * day-shaped label" and never checked whether the brief actually supports it. Add a word here
 * only together with the matching addition (and grounding rule) in `jev.ts`.
 */
const HOURS_ROW_LABEL = /\b(?:mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?|daily|weekday|weekend|holiday)\b/i;
/**
 * `value` is a valid hours row's value only if it has REAL schedule content — a digit (an hour
 * such as "8am", a range like "8-5") or the word "closed" — or does not match `VAGUE_FACT` at
 * all. Without this, a value that MIXES real hours with a hedge aside ("8am-5pm, call for holiday
 * hours") was thrown out entirely just because it also matched `VAGUE_FACT`'s `call for`
 * fragment (round-3 Grok audit); a value is only rejected as a hedge when it carries no real
 * schedule fact of its own.
 */
function hoursRowValueIsMeaningful(value: string): boolean {
  return /\d/.test(value) || /\bclosed\b/i.test(value) || !VAGUE_FACT.test(value);
}
function meaningfulHoursRows(s: PracticeSection): { label: string; value: string }[] {
  return items(s)
    .map((item) => ({ label: str(item, 'label'), value: str(item, 'value') }))
    .filter((row) => HOURS_ROW_LABEL.test(row.label) && !VAGUE_FACT.test(row.label) && hoursRowValueIsMeaningful(row.value));
}
/**
 * `true` when hours-location has an actual HOURS or LOCATION fact to show: a real hour row, or
 * an address. A phone number alone does not qualify — a phone is not an hour and not a location,
 * and it is already shown elsewhere (the footer, the hero trust panel, the book CTA); a section
 * titled "Hours & location" that shows only a phone number is answering a question nobody asked
 * it under a heading that promises something it does not have. A section kept by the pre-fill
 * keep/drop step but left with nothing real (every row a placeholder, no address, phone-only)
 * renders — and links to — nothing.
 */
function hoursLocationIsMeaningful(s: PracticeSection): boolean {
  return meaningfulHoursRows(s).length > 0 || nullable(s.text, 'address') !== null;
}

function renderHoursLocation(s: PracticeSection): string {
  if (!hoursLocationIsMeaningful(s)) return '';
  const address = nullable(s.text, 'address');
  const phone = nullable(s.text, 'phone');
  const facts = address === null && phone === null ? ''
    : `<div class="mt-6 space-y-2 text-center text-sm">`
      + atom('p', 'text-gray-700', `${s.id}--address`, address)
      + telAtom(`font-semibold text-blue-600 ${FOCUS}`, `${s.id}--phone`, phone)
      + `</div>`;
  const meaningfulRows = meaningfulHoursRows(s);
  const rowsHtml = items(s).map((item, index) => {
    const label = str(item, 'label');
    const value = str(item, 'value');
    if (!meaningfulRows.some((row) => row.label === label && row.value === value)) return '';
    return `<div class="grid grid-cols-2 gap-4 py-3">`
      + slot('dt', 'font-medium text-gray-900', `${s.id}--items-${index}--label`, label)
      + slot('dd', 'text-right text-gray-600', `${s.id}--items-${index}--value`, value)
      + `</div>`;
  }).join('');
  const table = meaningfulRows.length === 0 ? '' : `<div class="mt-8 flow-root"><dl class="mx-auto max-w-sm -my-3 divide-y divide-gray-200 text-sm">${rowsHtml}</dl></div>`;
  return `<section id="${s.id}" class="bg-gray-50"><div class="${WRAP}">`
    + sectionHead(s.id, `${s.id}--heading`, str(s.text, 'heading'))
    + facts
    + table
    + `</div></section>`;
}

/**
 * A fixed, human-written label and anchor for every section type this family can render — never
 * model text. The footer nav is built only from the ids of sections actually present in this
 * recipe, so it can name only a page this site itself renders (its own anchors); it can never
 * name a page that does not exist ("Privacy policy", "Careers", "New patient forms" — the exact
 * class of invention a live build proved strict Jev verify can miss). Header, hero and footer are
 * never listed: navigating to the top or to itself is not a useful footer link.
 */
const FOOTER_NAV_LABELS: Readonly<Record<string, string>> = {
  services: 'Services',
  providers: 'Providers',
  expect: 'What to expect',
  book: 'Book',
  reviews: 'Reviews',
  insurance: 'Insurance & pricing',
  faq: 'FAQ',
  'hours-location': 'Hours & location',
};
function deterministicFooterNav(recipe: PracticeRecipe): string {
  return presentSections(recipe.sections)
    .filter((section) => section.type in FOOTER_NAV_LABELS)
    // A section present in the RECIPE (not dropped by the pre-fill keep/drop step) can still
    // render nothing at all once its own content turns out meaningless (hours-location with only
    // a phone number, see hoursLocationIsMeaningful) — a footer link to that section's id would
    // then point at an anchor the page never actually emits, exactly what dishonestLinks exists
    // to catch. The header nav already makes this same render-time check for hours-location; the
    // footer must make it too, or the two navs disagree about what's really on the page. The
    // providers section has the same gap: `min: 1` at the contract level, but the borrowed/
    // duplicate filter can still empty it out at render time (see `providersSectionIsMeaningful`).
    .filter((section) => section.type !== 'hours-location' || hoursLocationIsMeaningful(section))
    .filter((section) => section.type !== 'providers' || providersSectionIsMeaningful(recipe))
    .map((section) => `<li><a href="#${section.id}" class="${LINK}">${e(FOOTER_NAV_LABELS[section.type]!)}</a></li>`)
    .join('');
}

function renderFooter(s: PracticeSection, recipe: PracticeRecipe): string {
  const links = deterministicFooterNav(recipe);
  const phone = nullable(s.text, 'phone');
  const email = nullable(s.text, 'email');
  const address = nullable(s.text, 'address');
  const hoursLocation = sectionOfType(recipe, 'hours-location');
  const hoursRows = hoursLocation ? meaningfulHoursRows(hoursLocation) : [];
  const hoursSummary = hoursRows.length === 0 ? '' : `<dl class="mt-6 space-y-1 text-sm text-gray-500">${
    hoursRows.map((row) => `<div class="flex justify-center gap-3 sm:justify-start">`
      + `<dt>${e(row.label)}</dt>`
      + `<dd class="font-medium text-gray-700">${e(row.value)}</dd>`
      + `</div>`).join('')
  }</dl>`;
  const contact = phone === null && email === null && address === null ? ''
    : `<div class="mt-6 space-y-1 text-sm text-gray-500">`
      + atom('p', '', `${s.id}--address`, address)
      + telAtom(`block ${FOCUS}`, `${s.id}--phone`, phone)
      + mailAtom(`block ${FOCUS}`, `${s.id}--email`, email)
      + `</div>`;
  return `<footer id="${s.id}" class="border-t border-gray-100 bg-white"><div class="mx-auto max-w-6xl px-4 py-16 sm:px-6 lg:px-8">`
    + `<div class="grid grid-cols-1 gap-10 text-center sm:grid-cols-2 sm:text-left">`
    + `<div>`
    + `<p class="text-base font-semibold text-gray-900">${e(recipe.brand.name)}</p>`
    + slot('p', 'mt-3 max-w-sm text-sm text-pretty text-gray-500 mx-auto sm:mx-0', `${s.id}--tagline`, str(s.text, 'tagline'))
    + contact
    + `</div>`
    + `<div class="sm:text-right">`
    + `<ul class="flex flex-wrap justify-center gap-x-6 gap-y-2 text-sm sm:justify-end">${links}</ul>`
    + hoursSummary
    + `</div>`
    + `</div>`
    + `<p class="mt-12 border-t border-gray-100 pt-8 text-center text-xs text-gray-400">${e(recipe.brand.name)}</p>`
    + `</div></footer>`;
}

const RENDERERS: Record<string, (s: PracticeSection, recipe: PracticeRecipe, seen: string[][]) => string> = {
  [HEADER_SECTION_ID]: renderHeader,
  [HERO_SECTION_ID]: renderHero,
  [SERVICES_SECTION_ID]: renderServices,
  [PROVIDERS_SECTION_ID]: renderProviders,
  [EXPECT_SECTION_ID]: renderExpect,
  [BOOK_SECTION_ID]: renderBook,
  [REVIEWS_SECTION_ID]: renderReviews,
  [INSURANCE_SECTION_ID]: renderInsurance,
  [FAQ_SECTION_ID]: renderFaq,
  [HOURS_LOCATION_SECTION_ID]: renderHoursLocation,
  [FOOTER_SECTION_ID]: renderFooter,
};

export function renderPractice(recipe: PracticeRecipe, _resolvedAssetPaths: Record<string, string>): string {
  // A dropped optional section (a null slot) renders nothing at all. `seen` accumulates the
  // distinctive body/intro copy already rendered, in section order, so a later section's own
  // body never repeats an earlier one's fact — see `bodyText`'s own doc.
  const seen: string[][] = [];
  const body = presentSections(recipe.sections).map((section) => RENDERERS[section.id]!(section, recipe, seen)).join('');
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'none'; style-src 'unsafe-inline'; script-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'">`
    + `<meta name="description" content="${e(recipe.brand.descriptor)}">`
    + `<title>${e(recipe.brand.name)}</title><style>${inlinedStyles()}</style></head>`
    + `<body class="bg-white">${body}</body></html>\n`;
}

/** Read one text slot back out of saved HTML by its data-od-id. */
export function findPracticeTextSlot(html: string, odId: string): string | undefined {
  if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(odId)) throw new Error('data-od-id: expected letters, digits and hyphens only');
  const pattern = new RegExp(`<([a-z0-9]+)\\b[^>]*\\sdata-od-id="${odId}"[^>]*>([\\s\\S]*?)</\\1>`, 'i');
  const match = pattern.exec(html);
  return match ? match[2]!.replace(/<[^>]*>/g, '').trim() : undefined;
}

/** Every data-od-id present in saved HTML, in document order. */
export function listPracticeTextSlots(html: string): string[] {
  return [...html.matchAll(/data-od-id="([^"]+)"/g)].map((match) => match[1]!);
}

export { SECTION_ORDER, PRACTICE_NULLABLE_ATOMS, PRACTICE_OPTIONAL_SECTIONS } from './slots.ts';
