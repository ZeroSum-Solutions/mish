/**
 * guide family — trusted renderer.
 *
 * Public surface used by the compiler's `families/registry.ts`:
 *   validateGuideRecipe(input)          -> typed recipe
 *   getGuideAssetRequirements(recipe)   -> AssetRequirement[] (always empty: no images)
 *   renderGuide(recipe, resolvedPaths)  -> HTML string
 *
 * Every class string this module emits is checked, in `render.test.ts`, against the compiled
 * `css/guide.css` (built by `scripts/build-ui-kit-css.ts guide`, which scans both the vendored
 * HyperUI blocks named in `pagekinds.json` and this file, exactly the way the shared build tool
 * documents), so a class with no rule fails there rather than silently rendering unstyled.
 * Practical facts, places to see, the typographic gallery and plan-a-visit are all optional
 * sections; a brief that gives no evidence for one drops the whole section and, where it carries
 * one, the header/footer nav link that points only at it (`linkTo`).
 *
 * Every text slot sits in an element carrying `data-od-id`, emitted in `SECTIONS` order. Chapters,
 * places and gallery cards render exactly as many cards as the recipe carries (`slots.ts`'s
 * `min`/`count` on each) — never padded to a fixed count with invented or borrowed content.
 * Practical facts is different: its array is always a FIXED length (the closed category set,
 * `PRACTICAL_FACTS_LABELS`), and an unsupported category is a `null` value dropped per row, not a
 * shorter array — see `renderPracticalFacts`'s own doc. The gallery is pure CSS/typography: no
 * `<img>`, no background image, no
 * external embed anywhere on this page kind. Plan-a-visit's `url` is never a plain string href:
 * `planHref` only ever emits it verbatim as the honest `https:` scheme it already validated at
 * the contract boundary; a null `url` (or the whole section dropped) never renders a dead or
 * button-shaped link — see `planAVisitIsMeaningful`.
 */

import { readCompilerResource } from '../../resources.ts';
import type { AssetRequirement } from '../../assets.ts';
import { linkTo, presentSections, sectionOfType } from '../../sections.ts';
import { parseGuideRecipe, type GuideItem, type GuideRecipe, type GuideSection } from './contract.ts';
import {
  CHAPTER_LIST_SECTION_ID, FOOTER_SECTION_ID, GALLERY_NAV_LINK, GALLERY_SECTION_ID, HEADER_SECTION_ID,
  MASTHEAD_SECTION_ID, OPENING_CHAPTER_SECTION_ID, PLACES_NAV_LINK, PLACES_SECTION_ID,
  PLAN_A_VISIT_NAV_LINK, PLAN_A_VISIT_SECTION_ID, PRACTICAL_FACTS_LABELS, PRACTICAL_FACTS_NAV_LINK,
  PRACTICAL_FACTS_SECTION_ID,
} from './slots.ts';

/** Relative to `compiler/scripts/`, read through `resources.ts` (disk, or a supplied table). */
const HYPERUI_CSS = 'catalog/hyperui/guide.css';
/** The compiled Tailwind build for this page kind's blocks, read once and inlined once per page. */
function inlinedStyles(): string {
  return readCompilerResource(HYPERUI_CSS);
}

export function validateGuideRecipe(input: unknown): GuideRecipe {
  return parseGuideRecipe(input);
}

/** No image, font or video assets: the gallery is a pure CSS/typography treatment. */
export function getGuideAssetRequirements(_recipe: GuideRecipe): AssetRequirement[] {
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
/** A nullable atom: nothing at all when the brief states no such fact — the same convention
 * storefront's own render.ts `atom()` uses for its nullable leaves. `brand.descriptor` is this
 * family's one user (round 4): a brief that gives no real descriptor for the destination drops
 * this slot entirely rather than forcing a guessed or over-general one. */
function atom(tag: string, className: string, id: string, value: string | null): string {
  return value === null ? '' : slot(tag, className, id, value);
}
const str = (record: Record<string, unknown>, name: string) => record[name] as string;
const items = (s: GuideSection) => s.items ?? [];

// ---------------------------------------------------------------------------------------------
// Shared layout tokens. Consistent vertical rhythm, a centered narrow header for every content
// section, and a visible keyboard-focus ring on every interactive element.
// ---------------------------------------------------------------------------------------------

const WRAP = 'mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-20 lg:px-8';
const PROSE_WRAP = 'mx-auto max-w-2xl px-4 py-16 sm:px-6 sm:py-20 lg:px-8';
const HEAD_WRAP = 'mx-auto max-w-2xl text-center';
const H2 = 'text-3xl font-semibold tracking-tight text-gray-900 sm:text-4xl';
const LEAD = 'mt-4 text-pretty text-gray-600';
const CARD = 'rounded-2xl border border-gray-200 bg-white p-6 shadow-sm transition-shadow hover:shadow-md sm:p-8';
const FOCUS = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600';
/** The primary action button, styled for use on the plan-a-visit section's own blue background:
 * white fill, blue text — a blue-on-blue button would be all but invisible. */
const BTN_PRIMARY_ON_BLUE = `inline-flex items-center justify-center gap-2 rounded-full bg-white px-6 py-3 text-sm font-semibold text-blue-700 shadow-sm transition hover:bg-blue-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white`;
const LINK = `text-gray-600 transition hover:text-gray-900 ${FOCUS}`;

/** A section's centered heading + optional lead, the same shape on every content section below
 * the masthead, so alignment and max-width read as one consistent rhythm. */
function sectionHead(headingId: string, heading: string, bodyId?: string, body?: string): string {
  return `<div class="${HEAD_WRAP}">`
    + slot('h2', H2, headingId, heading)
    + (bodyId && body ? slot('p', LEAD, bodyId, body) : '')
    + `</div>`;
}

/** The section id each header nav link (by index) points at — a real in-page anchor, never a
 * placeholder `#`, so `dishonestLinks` (the shared link-honesty check) passes. `links[0]`
 * (Chapters) always resolves, since chapter-list is required and never empty. */
const NAV_LINK_TARGETS: Readonly<Record<number, string>> = {
  0: CHAPTER_LIST_SECTION_ID,
  [PRACTICAL_FACTS_NAV_LINK]: PRACTICAL_FACTS_SECTION_ID,
  [PLACES_NAV_LINK]: PLACES_SECTION_ID,
  [GALLERY_NAV_LINK]: GALLERY_SECTION_ID,
  [PLAN_A_VISIT_NAV_LINK]: PLAN_A_VISIT_SECTION_ID,
};
/**
 * A FIXED label per header nav index, never model text (the same practice-audit lesson: a
 * model-written label is never checked against the section its index actually points at). These
 * are the SAME literal strings `FOOTER_NAV_LABELS` uses for the same sections, so the header and
 * footer never disagree about what to call one.
 */
const HEADER_NAV_LABELS: Readonly<Record<number, string>> = {
  0: 'Chapters',
  [PRACTICAL_FACTS_NAV_LINK]: 'Practical facts',
  [PLACES_NAV_LINK]: 'Places to see',
  [GALLERY_NAV_LINK]: 'Gallery',
  [PLAN_A_VISIT_NAV_LINK]: 'Plan a visit',
};

function renderHeader(s: GuideSection, recipe: GuideRecipe): string {
  const practicalFacts = sectionOfType(recipe, 'practical-facts');
  const places = sectionOfType(recipe, 'places-to-see');
  const gallery = sectionOfType(recipe, 'gallery');
  const planAVisit = sectionOfType(recipe, 'plan-a-visit');
  const showPractical = practicalFacts && practicalFactsAreMeaningful(practicalFacts);
  const showPlaces = places && items(places).length > 0;
  const showGallery = gallery && items(gallery).length > 0;
  const showPlan = planAVisit && planAVisitIsMeaningful(planAVisit);
  const links = Object.entries(HEADER_NAV_LABELS).map(([indexKey, label]) => {
    const index = Number(indexKey);
    const target = NAV_LINK_TARGETS[index];
    // No `data-od-id`: like the footer nav, this is fixed chrome, never a model-editable slot.
    const html = `<li><a href="#${target}" class="border-b-2 border-transparent px-4 py-2 text-sm font-medium text-gray-600 transition-colors hover:text-gray-900 hover:border-gray-300 ${FOCUS}">${e(label)}</a></li>`;
    if (index === PRACTICAL_FACTS_NAV_LINK) return linkTo(showPractical ? practicalFacts : undefined, html);
    if (index === PLACES_NAV_LINK) return linkTo(showPlaces ? places : undefined, html);
    if (index === GALLERY_NAV_LINK) return linkTo(showGallery ? gallery : undefined, html);
    if (index === PLAN_A_VISIT_NAV_LINK) return linkTo(showPlan ? planAVisit : undefined, html);
    return html;
  }).join('');
  // Sticky, compact header: the destination's name stays reachable while scrolling, with no script.
  // No fixed height — a fixed `h-16` fought `flex-wrap` at narrow widths (five nav links do not
  // fit one 4rem-tall row at 390px), so the wrapped second row painted over the masthead below it
  // instead of pushing it down. Letting the bar grow with its own content is what `flex-wrap` is
  // for; `py-3` keeps it compact on the common one-row case.
  return `<header id="${s.id}" class="sticky top-0 z-10 border-b border-gray-200 bg-white/95 backdrop-blur"><div class="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8"><div class="flex flex-wrap items-center justify-between gap-4 py-3">`
    + slot('p', 'text-base font-semibold text-gray-900', 'brand--name', recipe.brand.name)
    + atom('p', 'sr-only', 'brand--descriptor', recipe.brand.descriptor)
    + `<nav><ul class="flex flex-wrap gap-2">${links}</ul></nav>`
    + `</div></div></header>`;
}

function renderMasthead(s: GuideSection): string {
  return `<section id="${s.id}" class="border-b border-gray-100 bg-linear-to-b from-blue-50/60 to-white"><div class="mx-auto max-w-3xl px-4 py-20 text-center sm:px-6 sm:py-28 lg:px-8">`
    + slot('h1', 'text-4xl font-bold tracking-tight text-gray-900 sm:text-6xl', `${s.id}--heading`, str(s.text, 'heading'))
    + slot('p', 'mt-6 text-lg text-pretty text-gray-600 sm:text-xl', `${s.id}--standfirst`, str(s.text, 'standfirst'))
    + `</div></section>`;
}

function renderOpeningChapter(s: GuideSection): string {
  // One text slot, one data-od-id (the same one-field-one-slot rule every other section
  // follows) — a multi-paragraph brief still renders as a single flowing block; `whitespace-
  // pre-line` keeps a blank line the brief itself used as a paragraph break, without splitting
  // the field into several ids `slots.ts` never declared.
  return `<section id="${s.id}"><div class="${PROSE_WRAP}">`
    + slot('h2', H2, `${s.id}--heading`, str(s.text, 'heading'))
    + slot('p', 'mt-6 text-pretty text-lg whitespace-pre-line text-gray-700', `${s.id}--body`, str(s.text, 'body'))
    + `</div></section>`;
}

function renderChapterList(s: GuideSection): string {
  const list = items(s);
  const cards = list.map((item, index) => `<div class="${CARD}">`
    + slot('h3', 'text-lg font-semibold text-gray-900', `${s.id}--items-${index}--title`, str(item, 'title'))
    + slot('p', 'mt-2 text-pretty text-gray-600', `${s.id}--items-${index}--body`, str(item, 'body'))
    + `</div>`).join('');
  const cols = list.length >= 3 ? 'sm:grid-cols-2 lg:grid-cols-3' : 'sm:grid-cols-2';
  return `<section id="${s.id}" class="bg-gray-50"><div class="${WRAP}">`
    + sectionHead(`${s.id}--heading`, str(s.text, 'heading'))
    + `<div class="mt-12 grid grid-cols-1 gap-6 ${cols}">${cards}</div></div></section>`;
}

/**
 * `true` when at least one practical-fact row survives: the recipe always carries exactly
 * `PRACTICAL_FACTS_LABELS.length` item SLOTS (a FIXED, closed category set — see `slots.ts`'s own
 * doc), one per category, but a category the brief does not support is a `null` ITEM (the whole
 * row, not just its value) — `slots.ts`'s `SectionSpec.items.itemAtom` doc explains why the row is
 * nullable as a whole rather than `value` alone. So "any row real" means "any item non-null",
 * never `items(s).length > 0` (which is always true here).
 */
function practicalFactsAreMeaningful(s: GuideSection): boolean {
  return items(s).some((item) => item !== null);
}

/**
 * Each PRESENT row's `label` is in the recipe (unlike a pure TypeScript constant such as
 * `HEADER_NAV_LABELS`) SO THE MODEL CAN SEE, per fixed position, which category it is answering
 * — but `contract.ts`'s `parseGuideRecipe` hard-refuses any present row whose `label` at index N
 * is not `PRACTICAL_FACTS_LABELS[N]` exactly, so what renders here is provably always the fixed
 * category name, never free model text (see `slots.ts`'s own doc on this row for the live-build
 * history this closes: an invented category name, a real fact answered under the wrong category,
 * and — the round-4 fix — a forced answer for a category the brief never states at all). A
 * category the brief does not support is a `null` item and its whole row is dropped, never
 * rendered as an empty or placeholder line, and never forcing a guessed value.
 */
function renderPracticalFacts(s: GuideSection): string {
  const rows = items(s)
    .map((item, index) => ({ item, index }))
    .filter((row): row is { item: GuideItem; index: number } => row.item !== null)
    .map((row) => `<div class="grid grid-cols-2 gap-4 py-3">`
      + slot('dt', 'font-medium text-gray-900', `${s.id}--items-${row.index}--label`, PRACTICAL_FACTS_LABELS[row.index])
      + slot('dd', 'text-right text-gray-600', `${s.id}--items-${row.index}--value`, str(row.item, 'value'))
      + `</div>`).join('');
  if (!rows) return '';
  return `<section id="${s.id}"><div class="${WRAP}">`
    + sectionHead(`${s.id}--heading`, str(s.text, 'heading'))
    + `<div class="mt-8 flow-root"><dl class="mx-auto max-w-sm -my-3 divide-y divide-gray-200 text-sm">${rows}</dl></div>`
    + `</div></section>`;
}

function renderPlaces(s: GuideSection): string {
  const list = items(s);
  if (list.length === 0) return '';
  const cards = list.map((item, index) => `<div class="${CARD}">`
    + slot('h3', 'text-lg font-semibold text-gray-900', `${s.id}--items-${index}--name`, str(item, 'name'))
    + slot('p', 'mt-2 text-pretty text-gray-600', `${s.id}--items-${index}--body`, str(item, 'body'))
    + `</div>`).join('');
  const cols = list.length >= 3 ? 'sm:grid-cols-2 lg:grid-cols-3' : list.length === 2 ? 'sm:grid-cols-2' : 'mx-auto max-w-sm';
  return `<section id="${s.id}" class="bg-gray-50"><div class="${WRAP}">`
    + sectionHead(`${s.id}--heading`, str(s.text, 'heading'), `${s.id}--body`, str(s.text, 'body'))
    + `<div class="mt-12 grid grid-cols-1 gap-6 ${cols}">${cards}</div></div></section>`;
}

/**
 * A pure typographic place card: a large numeral, the place's name set in display type, and a
 * hairline rule — no icon, no photograph, no background image, nothing the "no stock photos, no
 * external images" rule would catch even loosely.
 */
function renderGallery(s: GuideSection): string {
  const list = items(s);
  if (list.length === 0) return '';
  const cards = list.map((item, index) => `<div class="${CARD} border-t-4 border-t-blue-600 text-center">`
    + `<span aria-hidden="true" class="text-sm font-semibold tracking-widest text-blue-600 uppercase">${String(index + 1).padStart(2, '0')}</span>`
    + slot('p', 'mt-3 text-2xl font-bold tracking-tight text-gray-900', `${s.id}--items-${index}--label`, str(item, 'label'))
    + `</div>`).join('');
  const cols = list.length >= 3 ? 'sm:grid-cols-2 lg:grid-cols-3' : 'sm:grid-cols-2';
  return `<section id="${s.id}"><div class="${WRAP}">`
    + sectionHead(`${s.id}--heading`, str(s.text, 'heading'))
    + `<div class="mt-12 grid grid-cols-1 gap-6 ${cols}">${cards}</div></div></section>`;
}

/** `true` when a plan-a-visit section is present in the recipe at all: `url` is never nullable
 * (see slots.ts's FieldSpec doc), so a present section always has a real link. */
function planAVisitIsMeaningful(_s: GuideSection): boolean {
  return true;
}
function planHref(url: string): string {
  return url;
}

function renderPlanAVisit(s: GuideSection): string {
  const url = str(s.text, 'url');
  return `<section id="${s.id}" class="bg-blue-600"><div class="mx-auto max-w-3xl px-4 py-16 text-center sm:px-6 sm:py-20 lg:px-8">`
    + slot('h2', 'text-3xl font-semibold tracking-tight text-white sm:text-4xl', `${s.id}--heading`, str(s.text, 'heading'))
    + slot('p', 'mt-4 text-pretty text-blue-100', `${s.id}--body`, str(s.text, 'body'))
    + `<div class="mt-8"><a href="${e(planHref(url))}" class="${BTN_PRIMARY_ON_BLUE} px-10 py-4 text-base" data-od-id="${s.id}--cta">${e(str(s.text, 'cta'))}</a></div>`
    + slot('span', 'sr-only', `${s.id}--url`, url)
    + `</div></section>`;
}

/**
 * A fixed, human-written label and anchor for every section type this family can render — never
 * model text. The footer nav is built only from the ids of sections actually present in this
 * recipe, so it can name only a page this site itself renders. Header, masthead, opening chapter
 * and footer are never listed: those are always present or self-evident, never a useful footer
 * jump target of their own.
 */
const FOOTER_NAV_LABELS: Readonly<Record<string, string>> = {
  'chapter-list': 'Chapters',
  'practical-facts': 'Practical facts',
  'places-to-see': 'Places to see',
  gallery: 'Gallery',
  'plan-a-visit': 'Plan a visit',
};
function deterministicFooterNav(recipe: GuideRecipe): string {
  return presentSections(recipe.sections)
    .filter((section) => section.type in FOOTER_NAV_LABELS)
    // A section present in the RECIPE (not dropped by the pre-fill keep/drop step) can still
    // render nothing at all once its own content turns out meaningless — the header nav already
    // makes this same render-time check; the footer must make it too, or the two navs disagree
    // about what's really on the page.
    .filter((section) => section.type !== 'practical-facts' || practicalFactsAreMeaningful(section))
    .filter((section) => section.type !== 'places-to-see' || items(section).length > 0)
    .filter((section) => section.type !== 'gallery' || items(section).length > 0)
    .filter((section) => section.type !== 'plan-a-visit' || planAVisitIsMeaningful(section))
    .map((section) => `<li><a href="#${section.id}" class="${LINK}">${e(FOOTER_NAV_LABELS[section.type]!)}</a></li>`)
    .join('');
}

function renderFooter(s: GuideSection, recipe: GuideRecipe): string {
  const links = deterministicFooterNav(recipe);
  return `<footer id="${s.id}" class="border-t border-gray-100 bg-white"><div class="mx-auto max-w-6xl px-4 py-16 sm:px-6 lg:px-8">`
    + `<div class="grid grid-cols-1 gap-10 text-center sm:grid-cols-2 sm:text-left">`
    + `<div>`
    + `<p class="text-base font-semibold text-gray-900">${e(recipe.brand.name)}</p>`
    + slot('p', 'mt-3 max-w-sm text-sm text-pretty text-gray-500 mx-auto sm:mx-0', `${s.id}--tagline`, str(s.text, 'tagline'))
    + `</div>`
    + `<div class="sm:text-right">`
    + `<ul class="flex flex-wrap justify-center gap-x-6 gap-y-2 text-sm sm:justify-end">${links}</ul>`
    + `</div>`
    + `</div>`
    + `<p class="mt-12 border-t border-gray-100 pt-8 text-center text-xs text-gray-400">${e(recipe.brand.name)}</p>`
    + `</div></footer>`;
}

const RENDERERS: Record<string, (s: GuideSection, recipe: GuideRecipe) => string> = {
  [HEADER_SECTION_ID]: renderHeader,
  [MASTHEAD_SECTION_ID]: renderMasthead,
  [OPENING_CHAPTER_SECTION_ID]: renderOpeningChapter,
  [CHAPTER_LIST_SECTION_ID]: renderChapterList,
  [PRACTICAL_FACTS_SECTION_ID]: renderPracticalFacts,
  [PLACES_SECTION_ID]: renderPlaces,
  [GALLERY_SECTION_ID]: renderGallery,
  [PLAN_A_VISIT_SECTION_ID]: renderPlanAVisit,
  [FOOTER_SECTION_ID]: renderFooter,
};

export function renderGuide(recipe: GuideRecipe, _resolvedAssetPaths: Record<string, string>): string {
  // A dropped optional section (a null slot) renders nothing at all.
  const body = presentSections(recipe.sections).map((section) => RENDERERS[section.id]!(section, recipe)).join('');
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'none'; style-src 'unsafe-inline'; script-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'">`
    + (recipe.brand.descriptor === null ? '' : `<meta name="description" content="${e(recipe.brand.descriptor)}">`)
    + `<title>${e(recipe.brand.name)}</title><style>${inlinedStyles()}</style></head>`
    + `<body class="bg-white">${body}</body></html>\n`;
}

/** Read one text slot back out of saved HTML by its data-od-id. */
export function findGuideTextSlot(html: string, odId: string): string | undefined {
  if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(odId)) throw new Error('data-od-id: expected letters, digits and hyphens only');
  const pattern = new RegExp(`<([a-z0-9]+)\\b[^>]*\\sdata-od-id="${odId}"[^>]*>([\\s\\S]*?)</\\1>`, 'i');
  const match = pattern.exec(html);
  return match ? match[2]!.replace(/<[^>]*>/g, '').trim() : undefined;
}

/** Every data-od-id present in saved HTML, in document order. */
export function listGuideTextSlots(html: string): string[] {
  return [...html.matchAll(/data-od-id="([^"]+)"/g)].map((match) => match[1]!);
}

export { SECTION_ORDER, GUIDE_NULLABLE_ATOMS, GUIDE_OPTIONAL_SECTIONS } from './slots.ts';
