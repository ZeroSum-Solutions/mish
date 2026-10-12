/**
 * restaurant family — the finite section and slot registry.
 *
 * A page kind for atlas archetype BA.02 (Restaurant or food business): menu, photography,
 * story, reviews, location, hours, reservation, ordering. It composes eleven vendored HyperUI
 * blocks (see `RESTAURANT_BLOCKS`) into one fixed layout. Only named text slots are exported
 * here; `render.ts` owns the markup and a recipe never carries markup or CSS. No asset system:
 * the vendored blocks carry no `<img>`, so the gallery section is caption-only, a placeholder for
 * photography the operator adds later.
 *
 * Every section is declared as data (`SectionSpec`): its section-level text fields, then its
 * repeated items. `contract.ts` validates a recipe by walking these specs, `recipeSchema()` in
 * `contract.ts` derives `recipe.schema.json` from them, and `render.ts` emits each section's
 * slots in the order declared here — so `render.test.ts` can rebuild the full `data-od-id`
 * roster from this file alone and compare it with the page.
 *
 * Slot ids: `<sectionId>--<field>` for a section field, `<sectionId>--<field>-<j>` for the j-th
 * string of a list field, `<sectionId>--items-<i>--<field>` inside a repeat. `brand--name` and
 * `brand--descriptor` are two more reconcilable slots on top of the sections; `brand.descriptor`
 * carries the cuisine, e.g. "Wood-fired Neapolitan pizza and a short Italian wine list."
 */

export const FAMILY_ID = 'restaurant';
export const SCHEMA_VERSION = 2;

/** The HyperUI blocks this page kind is built from (`hyperui/pagekinds.json` lists the same). */
export const RESTAURANT_BLOCKS = [
  'application/tabs/4', 'application/tabs/5', 'marketing/sections/4', 'marketing/ctas/2',
  'marketing/pricing/1', 'application/details-list/1', 'marketing/ctas/1', 'marketing/sections/2',
  'marketing/feature-grids/3', 'marketing/testimonials/3', 'marketing/footers/4',
] as const;

export type TextSlot = { name: string; max: number };
/** A fact a brief may not state: the slot is `null` then, and the page drops its element. */
/** `person-name` is a reviewer's attributed name: nullable (a diner review may go unnamed), like
 * every other atom, but marked `x-atom: 'person-name'` in the schema so the shared deterministic
 * checker (`spine.ts`'s `personNamePathsFor`, `jev.ts`'s `deterministicAttributionFlags`) traces
 * a filled value against the brief's own text — the same rule storefront and practice already
 * carry for their own reviewer/testimonial names (G5, "every family with name or quote slots"). */
export type AtomKind = 'phone' | 'email' | 'address' | 'plain' | 'person-name';
/** `verify: 'quote'` marks a required (non-nullable) text slot the shared deterministic checker
 * (`spine.ts`'s `quotePathsFor`, `jev.ts`'s `deterministicQuoteFlags`) traces word-for-word
 * against the brief, so a review's quote can never be invented even when Jev itself misses it. */
export type Verify = 'quote' | 'hours-label';
/** A text field. `list` makes it exactly that many strings; `atom` makes it nullable; `label`
 * marks it a fixed template LABEL (`x-label`, G5/G6's shared marker — see `spine.ts`'s
 * `labelPathsFor`): a section heading naming the section's own fixed structure, not a fact about
 * the client, and exempt from the faithfulness gate WHILE the fill leaves it exactly as the
 * template wrote it (`template-chrome.ts`). */
export type FieldSpec = TextSlot & { list?: number; atom?: AtomKind; verify?: Verify; label?: boolean; hoursValue?: string; hoursGroup?: string };
export type OptionalSpec = { label: string; dropWhen: string; keepWhen: string };
export type SectionSpec = {
  id: string;
  type: string;
  text: FieldSpec[];
  items?: { count: number; fields: FieldSpec[] };
  /** Present on the one section a brief may give nothing for: its slot may be `null`. */
  optional?: OptionalSpec;
};

/** Brand fields a recipe carries. Both are plain text; there is no wordmark asset. */
export const BRAND_SLOTS: TextSlot[] = [
  { name: 'name', max: 60 },
  { name: 'descriptor', max: 200 },
];

export const HEADER_SECTION_ID = 'restaurant-header';
export const HERO_SECTION_ID = 'restaurant-hero';
export const MENU_SECTION_ID = 'restaurant-menu';
export const HOURS_LOCATION_SECTION_ID = 'restaurant-hours-location';
export const RESERVATIONS_SECTION_ID = 'restaurant-reservations';
export const STORY_SECTION_ID = 'restaurant-story';
export const GALLERY_SECTION_ID = 'restaurant-gallery';
export const REVIEWS_SECTION_ID = 'restaurant-reviews';
export const FOOTER_SECTION_ID = 'restaurant-footer';

export const SECTIONS: readonly SectionSpec[] = [
  // `application/tabs/4` + `application/tabs/5`: the wordmark (brand--name), four nav links and
  // one reservation call to action.
  // `links` used to be four model-authored labels zipped to nav targets by array position — a
  // Grok audit (G5, round 2) found that meant a label like "Reservations" could open the hours
  // section instead. Nav is now generated entirely from the rendered sections themselves
  // (`NAV_LABELS` in render.ts), so there is no free-text label left to point at the wrong place.
  { id: HEADER_SECTION_ID, type: 'header', text: [{ name: 'cta', max: 32 }] },
  // `marketing/sections/4` + `marketing/ctas/2`: eyebrow, heading, body and the reservation CTA.
  // `brand.name` and `brand.descriptor` (rendered here too) carry the restaurant's name and
  // cuisine; this section adds the wider pitch and the button.
  {
    id: HERO_SECTION_ID, type: 'hero',
    text: [
      { name: 'eyebrow', max: 40 }, { name: 'heading', max: 72 }, { name: 'body', max: 200 },
      { name: 'reservationCta', max: 32 },
    ],
  },
  // `marketing/pricing/1` card layout, repurposed as dish cards: three to six highlights, each
  // with a nullable price so the fast lane never invents one.
  {
    id: MENU_SECTION_ID, type: 'menu',
    text: [{ name: 'heading', max: 60 }, { name: 'intro', max: 160 }],
    items: { count: 5, fields: [{ name: 'name', max: 60 }, { name: 'description', max: 140 }, { name: 'price', max: 24, atom: 'plain' }] },
  },
  // `application/details-list/1`: three opening-hours rows, plus the nullable address and phone
  // facts. No map: this page kind carries no images or embeds.
  {
    id: HOURS_LOCATION_SECTION_ID, type: 'hours-location',
    text: [
      // G6: a fixed section heading naming this section's own structure ("Hours and location"),
      // not a fact about the client — the sentence-claim gate previously flagged it (the DISTANCE
      // stem `hour` triggers `isClaimBearingSentence`, and neither `hours` nor `location` traces
      // word-for-word to a brief that only ever gives the hours and address themselves, never
      // this exact heading phrase). Marked `label: true` rather than reworded, so a live fill
      // that leaves the heading unchanged is exempt and one that genuinely rewrites it is still
      // checked like any other slot.
      { name: 'heading', max: 60, label: true }, { name: 'address', max: 120, atom: 'address' }, { name: 'phone', max: 40, atom: 'phone' },
    ],
    // G8 final (restaurant x Cerebras on 1f9dd02242): the day label is an hours fact, not free
    // prose. `verify: 'hours-label'` adds the shared row check (`hours-label.ts`: the label's day
    // set must be the day set the brief gives for this row's `value`); the proper-noun gate still
    // runs on it too, so the marker removes no check.
    // 2026-10-10: the value is a nullable atom so a row can be dropped. The gate shows the brief's
    // rows verbatim or none, and a brief rarely states exactly three, so a required value left
    // every other restaurant brief unpublishable (Home "Build with Jev" VERIFY_FAILED).
    items: { count: 3, fields: [{ name: 'label', max: 24, verify: 'hours-label', hoursValue: 'value', hoursGroup: 'table' }, { name: 'value', max: 48, atom: 'plain' }] },
  },
  // `marketing/ctas/1`: the booking step.
  { id: RESERVATIONS_SECTION_ID, type: 'reservations', text: [{ name: 'heading', max: 60 }, { name: 'body', max: 200 }, { name: 'cta', max: 32 }] },
  // `marketing/sections/2`: the chef, owner or founding story, one narrative block.
  { id: STORY_SECTION_ID, type: 'story', text: [{ name: 'heading', max: 60 }, { name: 'body', max: 280 }] },
  // `marketing/feature-grids/3`: a caption-only gallery placeholder (dish or interior photography
  // the operator adds later; this page kind renders no `<img>`).
  { id: GALLERY_SECTION_ID, type: 'gallery', text: [{ name: 'heading', max: 60 }], items: { count: 3, fields: [{ name: 'caption', max: 60 }, { name: 'blurb', max: 80 }] } },
  // `marketing/testimonials/3`: optional, a new restaurant often has no reviews yet.
  {
    id: REVIEWS_SECTION_ID, type: 'reviews',
    text: [{ name: 'heading', max: 60 }],
    items: { count: 3, fields: [{ name: 'title', max: 60 }, { name: 'quote', max: 240, verify: 'quote' }, { name: 'name', max: 60, atom: 'person-name' }] },
    optional: {
      label: 'customer reviews',
      dropWhen: 'The brief carries no diner reviews, names or quotes to show.',
      keepWhen: 'The brief supplies real reviews from diners or guests (a quote and a name).',
    },
  },
  // `marketing/footers/4`: tagline, three legal links, and nullable contact facts so the footer
  // never states a phone number, email or address the brief did not give.
  {
    id: FOOTER_SECTION_ID, type: 'footer',
    text: [
      { name: 'tagline', max: 120 }, { name: 'links', max: 32, list: 3 },
      { name: 'phone', max: 40, atom: 'phone' }, { name: 'email', max: 80, atom: 'email' }, { name: 'address', max: 120, atom: 'address' },
    ],
  },
];

export const SECTION_ORDER = SECTIONS.map((section) => section.id);

/** The nullable string leaves, by section id and field: facts a brief may not state. */
export const RESTAURANT_NULLABLE_ATOMS: Readonly<Record<string, Readonly<Record<string, AtomKind>>>> = Object.fromEntries(
  SECTIONS.flatMap((section) => {
    const atoms = section.text.filter((field) => field.atom).map((field) => [field.name, field.atom!] as const);
    return atoms.length > 0 ? [[section.id, Object.fromEntries(atoms)]] : [];
  }),
);

/** Section types a brief may give nothing for: the whole slot in `sections` may be `null`. */
export const RESTAURANT_OPTIONAL_SECTIONS: ReadonlySet<string> = new Set(SECTIONS.filter((section) => section.optional).map((section) => section.type));
