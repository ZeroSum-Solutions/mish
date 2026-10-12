/**
 * listings family — the finite section and slot registry.
 *
 * A page kind for atlas archetype SM.02 (Directory or listings): search → filter → summary →
 * detail → contact. It composes twelve vendored HyperUI blocks (see `LISTINGS_BLOCKS`) into one
 * fixed layout. Only named text slots are exported here; `render.ts` owns the markup and a recipe
 * never carries markup or CSS. No asset system: the vendored blocks carry no `<img>`.
 *
 * Every section is declared as data (`SectionSpec`): its section-level text fields, then its
 * repeated items. `contract.ts` validates a recipe by walking these specs, `recipeSchema()` in
 * `contract.ts` derives `recipe.schema.json` from them, and `render.ts` emits each section's
 * slots in the order declared here — so `render.test.ts` can rebuild the full `data-od-id`
 * roster from this file alone and compare it with the page.
 *
 * Slot ids: `<sectionId>--<field>` for a section field, `<sectionId>--<field>-<j>` for the j-th
 * string of a list field, `<sectionId>--items-<i>--<field>` inside a repeat. `brand--name` and
 * `brand--descriptor` are two more reconcilable slots on top of the sections.
 */

export const FAMILY_ID = 'listings';
export const SCHEMA_VERSION = 2;

/** The HyperUI blocks this page kind is built from (`hyperui/pagekinds.json` lists the same). */
export const LISTINGS_BLOCKS = [
  'application/tabs/4', 'application/tabs/5', 'marketing/sections/4', 'marketing/ctas/2',
  'marketing/feature-grids/3', 'application/filters/1', 'marketing/feature-grids/2', 'application/tables/3',
  'application/details-list/1', 'marketing/testimonials/3', 'marketing/ctas/1', 'marketing/footers/4',
] as const;

export type TextSlot = { name: string; max: number };
/** A fact a brief may not state: the slot is `null` then, and the page drops its element. */
export type AtomKind = 'phone' | 'email' | 'address' | 'plain' | 'person-name';
export type Verify = 'quote';
/**
 * A text field. `list` makes it exactly that many strings; `atom` makes it nullable. `label` marks
 * template chrome — a nav link, a filter name, a column heading — as `"x-label": true` in the
 * schema: left exactly as the reference wrote it, the faithfulness gate skips it. Never on a slot
 * that can hold a fact (a price, a name, a place).
 */
export type FieldSpec = TextSlot & { list?: number; atom?: AtomKind; label?: true; verify?: Verify };
export type OptionalSpec = { label: string; dropWhen: string; keepWhen: string };
/**
 * A section's repeated items. `mock` marks the whole item group as illustrative sample data
 * (`"x-mock": true` in the schema): `render.ts` then puts the fixed `SAMPLE_DATA_CAPTION` before
 * every sample card, row or value of the section. The caption is template copy, never a slot.
 */
export type ItemsSpec = { count: number; fields: FieldSpec[]; mock?: true };
export type SectionSpec = {
  id: string;
  type: string;
  text: FieldSpec[];
  items?: ItemsSpec;
  /** Present on the one section a brief may give nothing for: its slot may be `null`. */
  optional?: OptionalSpec;
};

/** Brand fields a recipe carries. Both are plain text; there is no wordmark asset. */
export const BRAND_SLOTS: TextSlot[] = [
  { name: 'name', max: 60 },
  { name: 'descriptor', max: 200 },
];

export const HEADER_SECTION_ID = 'listings-header';
export const SEARCH_SECTION_ID = 'listings-search';
export const CATEGORIES_SECTION_ID = 'listings-categories';
export const FILTERS_SECTION_ID = 'listings-filters';
export const RESULTS_SECTION_ID = 'listings-results';
export const COMPARE_SECTION_ID = 'listings-compare';
export const FEATURED_SECTION_ID = 'listings-featured';
export const REVIEWS_SECTION_ID = 'listings-reviews';
export const INQUIRY_SECTION_ID = 'listings-inquiry';
export const FOOTER_SECTION_ID = 'listings-footer';

/**
 * The visible caption on every section that shows sample data. Family copy, not a locale string
 * (the rendered page is static HTML), and never model-writable: the fast lane's faithfulness gate
 * skips every `x-mock` value only because this exact sentence stands before it on the page.
 */
export const SAMPLE_DATA_CAPTION = 'Sample listings: examples only, not live data';

/**
 * The caption used to be a model-written `sampleNote` text slot on each sample-data section. A
 * recipe persisted before that change may still carry it there; `contract.ts` accepts the key on
 * those sections only and drops it, so the page always shows `SAMPLE_DATA_CAPTION` instead.
 */
export const LEGACY_SAMPLE_NOTE_FIELD = 'sampleNote';

export const SECTIONS: readonly SectionSpec[] = [
  // `application/tabs/4`: the wordmark (brand--name), four nav links and one call to action.
  // `links` used to be four model-authored (fixed-chrome) labels zipped to nav targets by array
  // position — a Grok audit (G5, round 2) found that meant labels like "Buy"/"Agents" could open
  // the wrong section. Nav is now generated entirely from the rendered sections themselves
  // (`NAV_LABELS` in render.ts), so there is no label left to point at the wrong place.
  { id: HEADER_SECTION_ID, type: 'header', text: [{ name: 'cta', max: 32 }] },
  // `marketing/sections/4` + the search row of `marketing/ctas/2`.
  {
    id: SEARCH_SECTION_ID, type: 'search-hero',
    text: [
      { name: 'eyebrow', max: 40 }, { name: 'heading', max: 72 }, { name: 'body', max: 200 },
      { name: 'queryPlaceholder', max: 48 }, { name: 'searchCta', max: 24 },
    ],
  },
  // `marketing/feature-grids/3`: four browse categories.
  { id: CATEGORIES_SECTION_ID, type: 'categories', text: [{ name: 'heading', max: 60 }], items: { count: 4, fields: [{ name: 'title', max: 40 }, { name: 'blurb', max: 80 }] } },
  // `application/filters/1`: three filter groups, three options each.
  { id: FILTERS_SECTION_ID, type: 'filters', text: [{ name: 'heading', max: 60 }], items: { count: 3, fields: [{ name: 'label', max: 24, label: true }, { name: 'options', max: 32, list: 3, label: true }] } },
  // `application/tabs/5` sort pills + `marketing/feature-grids/4`-style result cards. A brief
  // almost never supplies real inventory, so the cards are sample data under a visible caption.
  {
    id: RESULTS_SECTION_ID, type: 'results',
    text: [{ name: 'heading', max: 60 }, { name: 'sorts', max: 24, list: 3, label: true }],
    items: { count: 4, mock: true, fields: [{ name: 'location', max: 48 }, { name: 'title', max: 60 }, { name: 'price', max: 24 }, { name: 'summary', max: 120 }] },
  },
  // `application/tables/3`: three columns, three rows of sample cells under a visible caption.
  { id: COMPARE_SECTION_ID, type: 'comparison', text: [{ name: 'heading', max: 60 }, { name: 'columns', max: 24, list: 3, label: true }], items: { count: 3, mock: true, fields: [{ name: 'cells', max: 40, list: 3 }] } },
  // `marketing/feature-grids/2` layout around `application/details-list/1`: sample label/value facts.
  { id: FEATURED_SECTION_ID, type: 'featured', text: [{ name: 'heading', max: 60 }, { name: 'body', max: 200 }], items: { count: 3, mock: true, fields: [{ name: 'label', max: 32 }, { name: 'value', max: 80 }] } },
  // `marketing/testimonials/3`: optional, a new directory often has no reviews yet.
  {
    id: REVIEWS_SECTION_ID, type: 'reviews',
    text: [{ name: 'heading', max: 60 }],
    items: { count: 3, fields: [{ name: 'title', max: 60 }, { name: 'quote', max: 240, verify: 'quote' }, { name: 'name', max: 60, atom: 'person-name' }] },
    optional: {
      label: 'customer reviews',
      dropWhen: 'The brief carries no customer reviews, names or quotes to show.',
      keepWhen: 'The brief supplies real reviews from buyers, renters, guests or members (a quote and a name).',
    },
  },
  // `marketing/ctas/1`: the contact step, with the phone and email as nullable facts.
  {
    id: INQUIRY_SECTION_ID, type: 'inquiry',
    text: [
      { name: 'heading', max: 60 }, { name: 'body', max: 200 }, { name: 'cta', max: 32 },
      { name: 'phone', max: 40, atom: 'phone' }, { name: 'email', max: 80, atom: 'email' },
    ],
  },
  // `marketing/footers/4`: tagline, three legal links, and the office address as a nullable fact.
  { id: FOOTER_SECTION_ID, type: 'footer', text: [{ name: 'tagline', max: 120 }, { name: 'links', max: 32, list: 3, label: true }, { name: 'address', max: 120, atom: 'address' }] },
];

export const SECTION_ORDER = SECTIONS.map((section) => section.id);

/** The nullable string leaves, by section id and field: facts a brief may not state. */
export const LISTINGS_NULLABLE_ATOMS: Readonly<Record<string, Readonly<Record<string, AtomKind>>>> = Object.fromEntries(
  SECTIONS.flatMap((section) => {
    const atoms = section.text.filter((field) => field.atom).map((field) => [field.name, field.atom!] as const);
    // A repeated item's own atom (`reviews`' nullable `name`, G5) needs one entry per item index —
    // `${section.id}--items-${i}` — since the flat `${id}--${name}` id this registry's consumers
    // build (`render.test.ts`'s "omits unsupported facts") must disambiguate which review's name
    // is nulled, the same way `render.ts` itself addresses each item's slot by index.
    const itemAtoms = Array.from({ length: section.items?.count ?? 0 }, (_, i) => {
      const fields = section.items!.fields.filter((field) => field.atom).map((field) => [field.name, field.atom!] as const);
      return fields.length > 0 ? [[`${section.id}--items-${i}`, Object.fromEntries(fields)]] as const : [];
    }).flat();
    return [...(atoms.length > 0 ? [[section.id, Object.fromEntries(atoms)] as const] : []), ...itemAtoms];
  }),
);

/** Section types a brief may give nothing for: the whole slot in `sections` may be `null`. */
export const LISTINGS_OPTIONAL_SECTIONS: ReadonlySet<string> = new Set(SECTIONS.filter((section) => section.optional).map((section) => section.type));

/**
 * Illustrative sample-data slots, by section id: the item field names `recipe.schema.json` marks
 * `"x-mock": true` (on the section's `items` array). They carry example listings, not claims about
 * the client, so the fast lane's faithfulness gate skips them — honest only because `render.ts`
 * shows the fixed `SAMPLE_DATA_CAPTION` before every sample card, row or value.
 */
export const LISTINGS_MOCK_SLOTS: Readonly<Record<string, readonly string[]>> = Object.fromEntries(
  SECTIONS.filter((section) => section.items?.mock).map((section) => [section.id, section.items!.fields.map((field) => field.name)]),
);
