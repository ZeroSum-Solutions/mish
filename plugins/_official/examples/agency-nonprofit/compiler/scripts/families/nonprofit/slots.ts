/**
 * nonprofit family — the finite section and slot registry.
 *
 * A page kind for atlas archetype MI.01 (Nonprofit or charity): stakes → mission → approach →
 * evidence → participation. It composes twelve vendored HyperUI blocks (see `NONPROFIT_BLOCKS`)
 * into one fixed layout. Only named text slots are exported here; `render.ts` owns the markup and a recipe
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

export const FAMILY_ID = 'nonprofit';
export const SCHEMA_VERSION = 2;

/** The HyperUI blocks this page kind is built from (`hyperui/pagekinds.json` lists the same). */
export const NONPROFIT_BLOCKS = [
  'application/tabs/4', 'marketing/sections/1', 'marketing/sections/3', 'marketing/feature-grids/1',
  'marketing/stats/3', 'marketing/testimonials/1', 'application/details-list/3', 'application/timelines/1',
  'marketing/pricing/1', 'marketing/ctas/1', 'marketing/ctas/2', 'marketing/footers/1',
] as const;

export type TextSlot = { name: string; max: number };
/** A fact a brief may not state: the slot is `null` then, and the page drops its element. */
export type AtomKind = 'phone' | 'email' | 'address' | 'plain' | 'date' | 'amount' | 'person-name';
export type Verify = 'quote';
/**
 * A text field. `list` makes it exactly that many strings; `atom` makes it nullable. `label` marks
 * template chrome — a nav link, a column heading, a period such as "a month" — as `"x-label": true`
 * in the schema: left exactly as the reference wrote it, the faithfulness gate skips it. Never on
 * a slot that can hold a fact (a price, a name, a place).
 */
export type FieldSpec = TextSlot & { list?: number; atom?: AtomKind; label?: true; verify?: Verify };
/** `navSlots`: full path labels of nav text that only points at this section (cut with it). */
export type OptionalSpec = { label: string; dropWhen: string; keepWhen: string; navSlots?: string[] };
export type SectionSpec = {
  id: string;
  type: string;
  text: FieldSpec[];
  items?: { count: number; fields: FieldSpec[] };
  /** Present on a section a brief may give nothing for: its slot may be `null`. */
  optional?: OptionalSpec;
};

/** Brand fields a recipe carries. Both are plain text; there is no wordmark asset. */
export const BRAND_SLOTS: TextSlot[] = [
  { name: 'name', max: 60 },
  { name: 'descriptor', max: 200 },
];

export const HEADER_SECTION_ID = 'nonprofit-header';
export const HERO_SECTION_ID = 'nonprofit-hero';
export const MISSION_SECTION_ID = 'nonprofit-mission';
export const PROGRAMS_SECTION_ID = 'nonprofit-programs';
export const IMPACT_SECTION_ID = 'nonprofit-impact';
export const STORIES_SECTION_ID = 'nonprofit-stories';
export const ACCOUNTABILITY_SECTION_ID = 'nonprofit-accountability';
export const EVENTS_SECTION_ID = 'nonprofit-events';
export const GIVE_SECTION_ID = 'nonprofit-give';
export const VOLUNTEER_SECTION_ID = 'nonprofit-volunteer';
export const FOOTER_SECTION_ID = 'nonprofit-footer';

export const SECTIONS: readonly SectionSpec[] = [
  // `application/tabs/4`: the name (brand--name) and a donate button. `links` used to be four
  // model-authored (fixed-chrome) labels zipped to nav targets by array position — a Grok audit
  // (G5, round 2) found that meant a label like "About us" could open the beneficiary-stories
  // section instead. Nav is now generated entirely from the rendered sections themselves
  // (`NAV_LABELS` in render.ts), so there is no label left to point at the wrong place.
  { id: HEADER_SECTION_ID, type: 'header', text: [{ name: 'donateCta', max: 24 }] },
  // `marketing/sections/1`: what is at stake, with the two ways to take part.
  {
    id: HERO_SECTION_ID, type: 'hero',
    text: [
      { name: 'eyebrow', max: 40 }, { name: 'heading', max: 72 }, { name: 'body', max: 240 },
      { name: 'donateCta', max: 24 }, { name: 'volunteerCta', max: 24 },
    ],
  },
  // `marketing/sections/3`: the mission statement.
  { id: MISSION_SECTION_ID, type: 'mission', text: [{ name: 'heading', max: 60 }, { name: 'body', max: 400 }] },
  // `marketing/feature-grids/1`: three programmes.
  { id: PROGRAMS_SECTION_ID, type: 'programs', text: [{ name: 'heading', max: 60 }, { name: 'body', max: 200 }], items: { count: 3, fields: [{ name: 'title', max: 60 }, { name: 'body', max: 200 }] } },
  // `marketing/stats/3`: optional, measured outcomes are exactly what a brief must not invent.
  {
    id: IMPACT_SECTION_ID, type: 'impact',
    text: [{ name: 'heading', max: 60 }, { name: 'body', max: 200 }],
    items: { count: 4, fields: [{ name: 'label', max: 40, label: true }, { name: 'value', max: 16 }] },
    optional: {
      label: 'impact figures',
      dropWhen: 'The brief states no measured outcomes (people helped, sites restored, money raised).',
      keepWhen: 'The brief states real, measured outcomes with numbers the organisation can stand behind.',
    },
  },
  // `marketing/testimonials/1`: optional, two named stories from people the work reached.
  {
    id: STORIES_SECTION_ID, type: 'stories',
    text: [{ name: 'heading', max: 60 }],
    items: { count: 2, fields: [{ name: 'quote', max: 240, verify: 'quote' }, { name: 'name', max: 60, atom: 'person-name' }, { name: 'role', max: 60 }] },
    optional: {
      label: 'named stories',
      dropWhen: 'The brief gives no quote attributable to a named person the work reached.',
      keepWhen: 'The brief quotes real, named volunteers, beneficiaries or supporters.',
    },
  },
  // `application/details-list/3`: three accountability facts (registration, spend, audit), each nullable.
  { id: ACCOUNTABILITY_SECTION_ID, type: 'accountability', text: [{ name: 'heading', max: 60 }, { name: 'body', max: 200 }], items: { count: 3, fields: [{ name: 'fact', max: 120, atom: 'plain' }] } },
  // `application/timelines/1`: optional, three upcoming events, each date a nullable fact. The
  // header's third nav link ("Events" in the reference) points only here and is cut with it.
  {
    id: EVENTS_SECTION_ID, type: 'events',
    text: [{ name: 'heading', max: 60 }],
    items: { count: 3, fields: [{ name: 'date', max: 24, atom: 'date' }, { name: 'title', max: 60 }, { name: 'body', max: 160 }] },
    optional: {
      label: 'upcoming events',
      dropWhen: 'The brief names no real, dated event (a clean-up day, a training session, a fundraiser on a stated date).',
      keepWhen: 'The brief names at least one real upcoming event with a date.',
    },
  },
  // `marketing/pricing/1`: two ways to give; the amount and its period are nullable facts (the
  // option's name, impact line and button stay when the brief states no amount).
  {
    id: GIVE_SECTION_ID, type: 'give',
    text: [{ name: 'heading', max: 60 }, { name: 'body', max: 200 }],
    items: { count: 2, fields: [{ name: 'name', max: 40 }, { name: 'amount', max: 16, atom: 'amount' }, { name: 'period', max: 16, atom: 'plain' }, { name: 'impact', max: 120 }, { name: 'cta', max: 24 }] },
  },
  // `marketing/ctas/2`: the volunteer call.
  { id: VOLUNTEER_SECTION_ID, type: 'volunteer', text: [{ name: 'heading', max: 60 }, { name: 'body', max: 200 }, { name: 'cta', max: 24 }] },
  // `marketing/footers/1`: tagline, three links, and the address, phone and email as nullable facts.
  {
    id: FOOTER_SECTION_ID, type: 'footer',
    text: [
      { name: 'tagline', max: 120 }, { name: 'links', max: 32, list: 3, label: true },
      { name: 'address', max: 120, atom: 'address' }, { name: 'phone', max: 40, atom: 'phone' }, { name: 'email', max: 80, atom: 'email' },
    ],
  },
];

export const SECTION_ORDER = SECTIONS.map((section) => section.id);

/** The nullable string leaves, by section id and field (a repeat's field too): facts a brief may not state. */
export const NONPROFIT_NULLABLE_ATOMS: Readonly<Record<string, Readonly<Record<string, AtomKind>>>> = Object.fromEntries(
  SECTIONS.flatMap((section) => {
    const atoms = [...section.text, ...(section.items?.fields ?? [])].filter((field) => field.atom).map((field) => [field.name, field.atom!] as const);
    return atoms.length > 0 ? [[section.id, Object.fromEntries(atoms)]] : [];
  }),
);

/** Section types a brief may give nothing for: the whole slot in `sections` may be `null`. */
export const NONPROFIT_OPTIONAL_SECTIONS: ReadonlySet<string> = new Set(SECTIONS.filter((section) => section.optional).map((section) => section.type));
