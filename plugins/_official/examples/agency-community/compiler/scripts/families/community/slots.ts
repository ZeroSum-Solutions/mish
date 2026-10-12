/**
 * community family — the finite section and slot registry.
 *
 * A page kind for atlas archetype LM.03 (Community or membership): shared identity → member
 * value → activity preview → norms → membership. It composes ten vendored HyperUI blocks (see
 * `COMMUNITY_BLOCKS`) into one fixed layout. Only named text slots are exported here; `render.ts`
 * owns the markup and a recipe never carries markup or CSS. No asset system: the vendored blocks
 * carry no `<img>`.
 *
 * This is a standing membership for a shared studio, club, coworking space or professional
 * community — ongoing access to a space and a group, not a course, cohort or curriculum
 * (spine LM's other archetype, LM.01, owns that shape; see `family-registry.json`).
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

export const FAMILY_ID = 'community';
export const SCHEMA_VERSION = 2;

/** The HyperUI blocks this page kind is built from (`hyperui/pagekinds.json` lists the same). */
export const COMMUNITY_BLOCKS = [
  'application/tabs/4', 'marketing/ctas/1', 'marketing/sections/1', 'marketing/feature-grids/1',
  'marketing/pricing/2', 'application/timelines/1', 'application/tables/3', 'marketing/testimonials/2',
  'application/details-list/3', 'marketing/footers/4',
] as const;

export type TextSlot = { name: string; max: number };
/** A fact a brief may not state: the slot is `null` then, and the page drops its element.
 * `plain` covers a generic fact (a price, a member count, a date, a link label) with no format
 * check beyond the usual text rules; `email`, `phone` and `address` are format-checked. */
export type AtomKind = 'phone' | 'email' | 'address' | 'plain' | 'person-name';
/** A text field. `list` makes it exactly that many strings; `atom` makes it nullable. */
export type Verify = 'quote';
export type FieldSpec = TextSlot & { list?: number; atom?: AtomKind; verify?: Verify };
export type OptionalSpec = {
  label: string; dropWhen: string; keepWhen: string;
  /** `x-optional.requires`: the fast lane drops the section without asking Jev when the brief
   * fails this precondition. `quote`: the brief must quote someone word for word — a member-voices
   * section asked for but not given a quote would otherwise be invented at fill time. */
  requires?: 'quote';
};
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

export const HEADER_SECTION_ID = 'community-header';
export const HERO_SECTION_ID = 'community-hero';
export const BENEFITS_SECTION_ID = 'community-benefits';
export const TIERS_SECTION_ID = 'community-tiers';
export const HOW_IT_WORKS_SECTION_ID = 'community-how-it-works';
export const EVENTS_SECTION_ID = 'community-events';
export const VOICES_SECTION_ID = 'community-voices';
export const FAQ_SECTION_ID = 'community-faq';
export const JOIN_SECTION_ID = 'community-join';
export const FOOTER_SECTION_ID = 'community-footer';

export const SECTIONS: readonly SectionSpec[] = [
  // `application/tabs/4`: the wordmark (brand--name), four nav links and one join call to action.
  // `links` used to be four model-authored labels zipped to nav targets by array position — a
  // Grok audit (G5, round 2) found that meant labels like "Events"/"Members" could open the wrong
  // section. Nav is now generated entirely from the rendered sections themselves (`NAV_LABELS` in
  // render.ts), so there is no free-text label left to point at the wrong place.
  { id: HEADER_SECTION_ID, type: 'header', text: [{ name: 'cta', max: 32 }] },
  // `marketing/sections/1` heading/body + `marketing/ctas/1`'s button: who this is for and the join CTA.
  {
    id: HERO_SECTION_ID, type: 'hero',
    text: [
      { name: 'eyebrow', max: 72 }, { name: 'heading', max: 80 }, { name: 'body', max: 220 },
      { name: 'cta', max: 32 }, { name: 'memberCount', max: 48, atom: 'plain' },
    ],
  },
  // `marketing/feature-grids/1`: icon cards, three to six member benefits — four here.
  { id: BENEFITS_SECTION_ID, type: 'benefits', text: [{ name: 'heading', max: 60 }], items: { count: 4, fields: [{ name: 'title', max: 48 }, { name: 'blurb', max: 120 }] } },
  // `marketing/pricing/2`: three membership tiers; price is a nullable atom, the tier name is not.
  {
    id: TIERS_SECTION_ID, type: 'tiers',
    text: [{ name: 'heading', max: 60 }, { name: 'body', max: 160 }],
    items: { count: 3, fields: [
      { name: 'name', max: 40 }, { name: 'description', max: 120 }, { name: 'price', max: 40, atom: 'plain' },
      { name: 'cta', max: 32 }, { name: 'features', max: 60, list: 3 },
    ] },
  },
  // `application/timelines/1`'s ordered list, without the date: three onboarding steps.
  { id: HOW_IT_WORKS_SECTION_ID, type: 'how-it-works', text: [{ name: 'heading', max: 60 }], items: { count: 3, fields: [{ name: 'title', max: 48 }, { name: 'body', max: 160 }] } },
  // `application/tables/3`-style rows: three upcoming events, each with a nullable date.
  {
    id: EVENTS_SECTION_ID, type: 'events',
    text: [{ name: 'heading', max: 60 }],
    items: { count: 3, fields: [{ name: 'title', max: 60 }, { name: 'date', max: 40, atom: 'plain' }, { name: 'blurb', max: 120 }] },
  },
  // `marketing/testimonials/2`: optional, a new or quiet community often has no quotes yet.
  {
    id: VOICES_SECTION_ID, type: 'voices',
    text: [{ name: 'heading', max: 60 }],
    items: { count: 3, fields: [{ name: 'quote', max: 240, verify: 'quote' }, { name: 'name', max: 60, atom: 'person-name' }, { name: 'role', max: 60 }] },
    optional: {
      label: 'member voices',
      dropWhen: 'The brief quotes no member word for word. A brief that only asks for member voices or testimonials supplies none.',
      keepWhen: 'The brief itself contains a member\'s own words in quotation marks, with who said them, to show as social proof.',
      requires: 'quote',
    },
  },
  // `application/details-list/3`'s bordered dt/dd pairs, reused as four question/answer rows.
  { id: FAQ_SECTION_ID, type: 'faq', text: [{ name: 'heading', max: 60 }], items: { count: 4, fields: [{ name: 'question', max: 80 }, { name: 'answer', max: 200 }] } },
  // `marketing/ctas/1`: the final join step, with phone and email as nullable facts.
  {
    id: JOIN_SECTION_ID, type: 'join',
    text: [
      { name: 'heading', max: 60 }, { name: 'body', max: 200 }, { name: 'cta', max: 32 },
      { name: 'phone', max: 40, atom: 'phone' }, { name: 'email', max: 80, atom: 'email' },
    ],
  },
  // `marketing/footers/4`: tagline, three nullable legal/contact links, and a nullable address.
  {
    id: FOOTER_SECTION_ID, type: 'footer',
    text: [
      { name: 'tagline', max: 120 }, { name: 'link1', max: 32, atom: 'plain' },
      { name: 'link2', max: 32, atom: 'plain' }, { name: 'link3', max: 32, atom: 'plain' },
      { name: 'address', max: 120, atom: 'address' },
    ],
  },
];

export const SECTION_ORDER = SECTIONS.map((section) => section.id);

/** The nullable string leaves, by section id and field: facts a brief may not state. */
export const COMMUNITY_NULLABLE_ATOMS: Readonly<Record<string, Readonly<Record<string, AtomKind>>>> = Object.fromEntries(
  SECTIONS.flatMap((section) => {
    const atoms = section.text.filter((field) => field.atom).map((field) => [field.name, field.atom!] as const);
    return atoms.length > 0 ? [[section.id, Object.fromEntries(atoms)]] : [];
  }),
);

/** Section types a brief may give nothing for: the whole slot in `sections` may be `null`. */
export const COMMUNITY_OPTIONAL_SECTIONS: ReadonlySet<string> = new Set(SECTIONS.filter((section) => section.optional).map((section) => section.type));
