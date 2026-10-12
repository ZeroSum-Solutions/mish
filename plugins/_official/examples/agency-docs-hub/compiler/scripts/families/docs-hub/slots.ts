/**
 * docs-hub family — the finite section and slot registry.
 *
 * A page kind for atlas archetype CS.02 (Documentation or knowledge base): orient → search →
 * follow steps → verify → troubleshoot → continue. It composes ten vendored HyperUI blocks (see
 * `DOCS_HUB_BLOCKS`) into one fixed layout. Only named text slots are exported here; `render.ts`
 * owns the markup and a recipe never carries markup or CSS. No asset system: the vendored blocks
 * carry no `<img>`.
 *
 * The header's search field and the code sample's `<pre>` block are static mocks, not a real
 * `<input>` or model-written code: the page has no script and its CSP forbids form submission, so
 * every "control" is a styled, labelled, inert element carrying only reconcilable text slots.
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

export const FAMILY_ID = 'docs-hub';
export const SCHEMA_VERSION = 2;

/** The HyperUI blocks this page kind is built from (`hyperui/pagekinds.json` lists the same). */
export const DOCS_HUB_BLOCKS = [
  'application/tabs/4', 'application/empty-states/5', 'marketing/ctas/1', 'application/details-list/3',
  'marketing/feature-grids/1', 'application/details-list/1', 'application/tables/2', 'application/timelines/3',
  'marketing/ctas/4', 'marketing/footers/1',
] as const;

export type TextSlot = { name: string; max: number };
/** A fact a brief may not state: the slot is `null` then, and the page drops its element. */
export type AtomKind = 'phone' | 'email' | 'address' | 'plain';
/** A text field. `list` makes it exactly that many strings; `atom` makes it nullable. */
export type FieldSpec = TextSlot & { list?: number; atom?: AtomKind };
export type OptionalSpec = { label: string; dropWhen: string; keepWhen: string };
export type SectionSpec = {
  id: string;
  type: string;
  text: FieldSpec[];
  /** `drop`: unsupported items may be removed after the repairs (`x-drop: 'items'`); never for a procedure. */
  items?: { count: number; min?: number; drop?: true; fields: FieldSpec[] };
  /** Present on a section a brief may give nothing for: its slot may be `null`. */
  optional?: OptionalSpec;
};

/** Brand fields a recipe carries. Both are plain text; there is no wordmark asset. */
export const BRAND_SLOTS: TextSlot[] = [
  { name: 'name', max: 60 },
  { name: 'descriptor', max: 200 },
];

export const HEADER_SECTION_ID = 'docs-hub-header';
export const HERO_SECTION_ID = 'docs-hub-hero';
export const QUICKSTART_SECTION_ID = 'docs-hub-quickstart';
export const GUIDES_SECTION_ID = 'docs-hub-guides';
export const API_SECTION_ID = 'docs-hub-api';
export const CODE_SAMPLE_SECTION_ID = 'docs-hub-code-sample';
export const CHANGELOG_SECTION_ID = 'docs-hub-changelog';
export const COMMUNITY_SECTION_ID = 'docs-hub-community';
export const FOOTER_SECTION_ID = 'docs-hub-footer';

export const SECTIONS: readonly SectionSpec[] = [
  // `application/tabs/4`: the product name (brand--name), three nav links and a labelled,
  // non-functional search field (searchLabel is the accessible <label>; searchPlaceholder is the
  // static mock's own text — never a live <input>).
  // `links` used to be three model-authored labels zipped to nav targets by array position — a
  // Grok audit (G5, round 2) found that meant "Guides"/"Reference"/"Changelog" could each open the
  // wrong section. Nav is now generated entirely from the rendered sections themselves (`NAV_LABELS`
  // in render.ts), so there is no free-text label left to point at the wrong place.
  {
    id: HEADER_SECTION_ID, type: 'header',
    text: [
      { name: 'searchLabel', max: 40 },
      { name: 'searchPlaceholder', max: 40 }, { name: 'cta', max: 24 },
    ],
  },
  // `marketing/ctas/1`: what the docs cover, with a "Get started" CTA.
  { id: HERO_SECTION_ID, type: 'hero', text: [{ name: 'heading', max: 90 }, { name: 'body', max: 280 }, { name: 'cta', max: 24 }] },
  // `application/details-list/3`: up to five quick-start steps.
  {
    id: QUICKSTART_SECTION_ID, type: 'quickstart',
    text: [{ name: 'heading', max: 60 }],
    // Exactly five steps, never variable and never dropped (Sol review of #286, round 2): a procedure
    // with a step left out, by the model or by a repair, publishes a gapped "five steps". A step the
    // brief does not support refuses the build. Known gap: a brief with fewer steps (R3 follow-up).
    items: { count: 5, fields: [{ name: 'title', max: 60 }, { name: 'description', max: 160 }] },
  },
  // `marketing/feature-grids/1`: the guides grid, six topic cards.
  {
    id: GUIDES_SECTION_ID, type: 'guides',
    text: [{ name: 'heading', max: 60 }, { name: 'body', max: 200 }],
    // `min: 1`, `drop` (2026-10-10, R3): a brief rarely names this many; an unsupported item is dropped, never invented.
    items: { min: 1, count: 6, drop: true, fields: [{ name: 'title', max: 60 }, { name: 'description', max: 160 }] },
  },
  // `application/details-list/1`: optional API or reference entry points. A brief naming no API
  // or reference surface (a pure how-to guide site) drops this section whole.
  {
    id: API_SECTION_ID, type: 'api-reference',
    text: [{ name: 'heading', max: 60 }],
    // `min: 1`, `drop` (2026-10-10, R3): a brief rarely names this many; an unsupported item is dropped, never invented.
    items: { min: 1, count: 4, drop: true, fields: [{ name: 'name', max: 60 }, { name: 'description', max: 160 }] },
    optional: {
      label: 'API or reference entry points',
      dropWhen: 'The brief names no API, SDK or reference surface to link into.',
      keepWhen: 'The brief names a real API, SDK or reference surface (a resource or endpoint name and what it does).',
    },
  },
  // `application/tables/2`: one static placeholder code sample with a caption. No model-written
  // code: `code` is a fixed, non-reconcilable literal in render.ts, never a recipe slot.
  { id: CODE_SAMPLE_SECTION_ID, type: 'code-sample', text: [{ name: 'heading', max: 60 }, { name: 'caption', max: 160 }] },
  // `application/timelines/3`: optional changelog, four entries. version and date are nullable
  // facts: a brief that gives no version numbers or dates still gets the entry's title and summary.
  {
    id: CHANGELOG_SECTION_ID, type: 'changelog',
    text: [{ name: 'heading', max: 60 }],
    items: {
      count: 4,
      fields: [
        { name: 'version', max: 20, atom: 'plain' }, { name: 'date', max: 24, atom: 'plain' },
        { name: 'title', max: 90 }, { name: 'summary', max: 160 },
      ],
    },
    optional: {
      label: 'changelog or what’s new',
      dropWhen: 'The brief gives no release history or "what’s new" entries to show.',
      keepWhen: 'The brief names real releases, versions or recent changes to list.',
    },
  },
  // `marketing/ctas/4`: optional community and support links. supportEmail, communityLink and
  // statusLink are each independently nullable facts.
  {
    id: COMMUNITY_SECTION_ID, type: 'community-support',
    text: [
      { name: 'heading', max: 60 }, { name: 'body', max: 200 },
      { name: 'supportEmail', max: 80, atom: 'email' }, { name: 'communityLink', max: 60, atom: 'plain' },
      { name: 'statusLink', max: 60, atom: 'plain' },
    ],
    optional: {
      label: 'community and support links',
      dropWhen: 'The brief names no community, support channel or status page.',
      keepWhen: 'The brief names a real community, support channel or status page to point at.',
    },
  },
  // `marketing/footers/1`: tagline and three independently nullable links, plus the nullable
  // editorial contact email.
  {
    id: FOOTER_SECTION_ID, type: 'footer',
    text: [
      { name: 'tagline', max: 120 }, { name: 'link1', max: 32, atom: 'plain' },
      { name: 'link2', max: 32, atom: 'plain' }, { name: 'link3', max: 32, atom: 'plain' },
      { name: 'contactEmail', max: 80, atom: 'email' },
    ],
  },
];

export const SECTION_ORDER = SECTIONS.map((section) => section.id);

/** The nullable string leaves, by section id and field: facts a brief may not state. */
export const DOCS_HUB_NULLABLE_ATOMS: Readonly<Record<string, Readonly<Record<string, AtomKind>>>> = Object.fromEntries(
  SECTIONS.flatMap((section) => {
    const textAtoms = section.text.filter((field) => field.atom).map((field) => [field.name, field.atom!] as const);
    const itemAtoms = (section.items?.fields ?? []).filter((field) => field.atom).map((field) => [field.name, field.atom!] as const);
    const atoms = [...textAtoms, ...itemAtoms];
    return atoms.length > 0 ? [[section.id, Object.fromEntries(atoms)]] : [];
  }),
);

/** Section types a brief may give nothing for: the whole slot in `sections` may be `null`. */
export const DOCS_HUB_OPTIONAL_SECTIONS: ReadonlySet<string> = new Set(SECTIONS.filter((section) => section.optional).map((section) => section.type));
