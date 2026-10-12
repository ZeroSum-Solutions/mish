/**
 * publication family — the finite section and slot registry.
 *
 * A page kind for atlas archetype CS.01 (Publication or media): headline → consume → related →
 * subscribe. It composes ten vendored HyperUI blocks (see `PUBLICATION_BLOCKS`) into one fixed
 * layout. Only named text slots are exported here; `render.ts` owns the markup and a recipe
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

export const FAMILY_ID = 'publication';
export const SCHEMA_VERSION = 2;

/** The HyperUI blocks this page kind is built from (`hyperui/pagekinds.json` lists the same). */
export const PUBLICATION_BLOCKS = [
  'application/tabs/4', 'marketing/sections/2', 'application/tabs/5', 'marketing/feature-grids/4',
  'marketing/feature-grids/3', 'application/timelines/1', 'marketing/testimonials/2', 'marketing/ctas/2',
  'marketing/pricing/1', 'marketing/footers/1',
] as const;

export type TextSlot = { name: string; max: number };
/** A fact a brief may not state: the slot is `null` then, and the page drops its element. */
export type AtomKind = 'phone' | 'email' | 'address' | 'plain' | 'date' | 'price' | 'person-name';
/**
 * A text field. `list` makes it exactly that many strings; `atom` makes it nullable. `label` marks
 * template chrome — a nav link, a column heading, a period such as "a month" — as `"x-label": true`
 * in the schema: left exactly as the reference wrote it, the faithfulness gate skips it. Never on
 * a slot that can hold a fact (a price, a name, a place).
 */
export type FieldSpec = TextSlot & { list?: number; atom?: AtomKind; label?: true };
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

export const MASTHEAD_SECTION_ID = 'publication-masthead';
export const LEAD_SECTION_ID = 'publication-lead';
export const TOPICS_SECTION_ID = 'publication-topics';
export const LATEST_SECTION_ID = 'publication-latest';
export const SERIES_SECTION_ID = 'publication-series';
export const ARCHIVE_SECTION_ID = 'publication-archive';
export const AUTHORS_SECTION_ID = 'publication-authors';
export const NEWSLETTER_SECTION_ID = 'publication-newsletter';
export const MEMBERSHIP_SECTION_ID = 'publication-membership';
export const FOOTER_SECTION_ID = 'publication-footer';

export const SECTIONS: readonly SectionSpec[] = [
  // `application/tabs/4`: the masthead (brand--name), four section links and a subscribe button.
  // `links` used to be four model-authored (fixed-chrome) labels zipped to nav targets by array
  // position — a Grok audit (G5, round 2) found this exact pattern mislabeling nav in five other
  // families. Nav is now generated entirely from the rendered sections themselves (`NAV_LABELS`
  // in render.ts), so there is no label left to point at the wrong place.
  { id: MASTHEAD_SECTION_ID, type: 'masthead', text: [{ name: 'cta', max: 24 }] },
  // `marketing/sections/2`: the lead story; the byline names a real writer, so it is a nullable fact.
  {
    id: LEAD_SECTION_ID, type: 'lead-story',
    text: [
      { name: 'kicker', max: 32 }, { name: 'headline', max: 90 }, { name: 'dek', max: 240 },
      { name: 'byline', max: 60, atom: 'person-name' }, { name: 'readCta', max: 24 },
    ],
  },
  // `application/tabs/5`: five topic pills.
  { id: TOPICS_SECTION_ID, type: 'topics', text: [{ name: 'heading', max: 40 }, { name: 'topics', max: 24, list: 5 }] },
  // `marketing/feature-grids/4`: four story cards; each publication date is a nullable fact.
  {
    id: LATEST_SECTION_ID, type: 'latest',
    text: [{ name: 'heading', max: 60 }],
    items: { count: 4, fields: [{ name: 'topic', max: 24 }, { name: 'title', max: 90 }, { name: 'dek', max: 160 }, { name: 'date', max: 24, atom: 'date' }] },
  },
  // `marketing/feature-grids/3`: four running series.
  { id: SERIES_SECTION_ID, type: 'series', text: [{ name: 'heading', max: 60 }], items: { count: 4, fields: [{ name: 'title', max: 60 }, { name: 'blurb', max: 120 }] } },
  // `application/timelines/1`: four archive entries; each date (or issue) is a nullable fact.
  {
    id: ARCHIVE_SECTION_ID, type: 'archive',
    text: [{ name: 'heading', max: 60 }],
    items: { count: 4, fields: [{ name: 'date', max: 24, atom: 'date' }, { name: 'title', max: 90 }, { name: 'summary', max: 160 }] },
  },
  // `marketing/testimonials/2`: optional, a new title often has no named contributors yet.
  {
    id: AUTHORS_SECTION_ID, type: 'authors',
    text: [{ name: 'heading', max: 60 }],
    items: { count: 3, fields: [{ name: 'bio', max: 200 }, { name: 'name', max: 60, atom: 'person-name' }, { name: 'beat', max: 60 }] },
    optional: {
      label: 'writers and contributors',
      dropWhen: 'The brief names no writers, editors or contributors to introduce.',
      keepWhen: 'The brief names real writers, editors or contributors (a name and what they cover).',
    },
  },
  // `marketing/ctas/2`: the newsletter sign-up; the send cadence is a nullable fact.
  {
    id: NEWSLETTER_SECTION_ID, type: 'newsletter',
    text: [
      { name: 'heading', max: 60 }, { name: 'body', max: 200 }, { name: 'emailPlaceholder', max: 48 },
      { name: 'cta', max: 24 }, { name: 'cadence', max: 60, atom: 'plain' },
    ],
  },
  // `marketing/pricing/1`: two membership tiers; the price and its period are nullable facts (the
  // tier's name, features and button stay when the brief states no price).
  {
    id: MEMBERSHIP_SECTION_ID, type: 'membership',
    text: [{ name: 'heading', max: 60 }],
    items: { count: 2, fields: [{ name: 'name', max: 40 }, { name: 'price', max: 16, atom: 'price' }, { name: 'period', max: 16, atom: 'plain' }, { name: 'features', max: 48, list: 3 }, { name: 'cta', max: 24 }] },
  },
  // `marketing/footers/1`: tagline, three links, and the editorial contact email as a nullable fact.
  { id: FOOTER_SECTION_ID, type: 'footer', text: [{ name: 'tagline', max: 120 }, { name: 'links', max: 32, list: 3, label: true }, { name: 'contactEmail', max: 80, atom: 'email' }] },
];

export const SECTION_ORDER = SECTIONS.map((section) => section.id);

/** The nullable string leaves, by section id and field (a repeat's field too): facts a brief may not state. */
export const PUBLICATION_NULLABLE_ATOMS: Readonly<Record<string, Readonly<Record<string, AtomKind>>>> = Object.fromEntries(
  SECTIONS.flatMap((section) => {
    const atoms = [...section.text, ...(section.items?.fields ?? [])].filter((field) => field.atom).map((field) => [field.name, field.atom!] as const);
    return atoms.length > 0 ? [[section.id, Object.fromEntries(atoms)]] : [];
  }),
);

/** Section types a brief may give nothing for: the whole slot in `sections` may be `null`. */
export const PUBLICATION_OPTIONAL_SECTIONS: ReadonlySet<string> = new Set(SECTIONS.filter((section) => section.optional).map((section) => section.type));
