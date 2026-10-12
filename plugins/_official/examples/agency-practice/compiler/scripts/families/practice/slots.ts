/**
 * practice family — the finite section and slot registry.
 *
 * A page kind for atlas archetypes TL.01 (Local appointment business) and TL.02 (Healthcare or
 * aesthetic practice): local need -> services -> credentials -> what to expect -> book. It
 * composes eleven vendored HyperUI blocks (see `PRACTICE_BLOCKS`) into one fixed layout. Only
 * named text slots are exported here; `render.ts` owns the markup and a recipe never carries
 * markup or CSS. No asset system: the vendored blocks carry no `<img>`.
 *
 * A public site for a local clinical or appointment practice (dental, vet, medical specialist,
 * physiotherapy, aesthetics or med-spa) whose visitor judges fit and books — not a signed-in
 * patient portal. Book, hours and insurance are all nullable facts or optional sections: a brief
 * that gives no booking URL, phone or email drops the book CTA's destination text down to a
 * plain contact fallback (see render.ts), and a brief with no hours, insurance, reviews or FAQ
 * drops those whole sections and their nav links.
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

export const FAMILY_ID = 'practice';
export const SCHEMA_VERSION = 2;

/** The HyperUI blocks this page kind is built from (`hyperui/pagekinds.json` lists the same). */
export const PRACTICE_BLOCKS = [
  'application/tabs/4', 'application/tabs/5', 'marketing/sections/4', 'marketing/ctas/2', 'marketing/feature-grids/1',
  'marketing/feature-grids/2', 'application/timelines/1', 'marketing/ctas/1', 'marketing/testimonials/3',
  'marketing/pricing/1', 'application/details-list/1', 'marketing/footers/4',
] as const;

export type TextSlot = { name: string; max: number };
/** A fact a brief may not state: the slot is `null` then, and the page drops its element. */
export type AtomKind = 'phone' | 'email' | 'address' | 'plain' | 'destination';
/**
 * A text field. `list` makes it exactly that many strings; `atom` makes it nullable. `label`
 * marks template chrome — a nav link, a column heading — as `"x-label": true` in the schema: left
 * exactly as the reference wrote it, the faithfulness gate skips it.
 */
/**
 * `personName: true` marks a required (never nullable) text slot as a person's own name —
 * `x-atom: 'person-name'` in the schema (`contract.ts`'s `fieldSchema`) — for the shared fast
 * lane's deterministic attribution gate (`packages/agency-fast-lane/src/jev.ts`'s
 * `deterministicAttributionFlags`, driven by `spine.ts`'s `personNamePathsFor`): every such slot
 * is checked against the client's brief by a hard string-presence test in addition to Jev's own
 * LLM-based faithfulness judgment, never instead of it. Distinct from `atom` (which also makes a
 * slot nullable): a review or a provider must NAME someone when the item exists at all — the
 * whole item is what `min`/`count` may drop, not the name alone.
 *
 * `verify: 'quote'` marks a required text slot as a quote attributed to the brief itself — a
 * testimonial, a review — as `x-verify: 'quote'` in the schema: the shared fast lane's other
 * deterministic supplement (`jev.ts`'s `deterministicQuoteFlags`, driven by `spine.ts`'s
 * `quotePathsFor`) traces it against the brief's own words (a run of at least 6 consecutive
 * shared words, or 70% overlap for a shorter quote) in addition to Jev's own judgment. Never
 * nullable: a review item that exists always has its quote, the same way it always names someone.
 *
 * `verify: 'destination'` marks EVERY slot this family can turn into a live `tel:`/`mailto:`/
 * `https:` link — the book section's own `destination` atom, and ALSO hours-location's `phone`
 * and the footer's `phone`/`email`, since `render.ts`'s `effectiveBookDestination` falls back to
 * those same atoms when the book section's own destination is null, and each also renders its own
 * live link directly in its own section (`telAtom`/`emailAtom`). A live link anyone can click or
 * call must be checked no matter which slot supplies it — marking only the book section's own
 * field left the fallback atoms free to carry a fabricated phone or email straight to a visitor,
 * the round-2 audit finding this closes. `verify: 'destination'` drives the shared fast lane's
 * deterministic destination-tracing gate (`jev.ts`'s `deterministicDestinationFlags`, driven by
 * `spine.ts`'s `destinationPathsFor`): a non-null value at any of these paths must be the EXACT
 * URL, email or phone the brief itself gives (by token equality, never a substring match — see
 * `deterministicDestinationFlags`'s own doc), the same bar `personName` holds an attributed name
 * to. On `book.destination` this pairs with `atom: 'destination'` (nullable, `contract.ts`'s
 * format check); on the `phone`/`email` atoms it pairs with their own existing `atom` kind, since
 * those already have their own nullability and format check — `verify` only adds the brief-trace
 * requirement on top.
 *
 * `verify: 'hours-label'` marks the hours-and-location row `label` field ("Mon-Thu", "Fri",
 * "Sat-Sun") — a day or day-range is a FACT (it claims the practice is open on those days), never
 * `label: true` chrome, however short and digit-free it reads (round-4 Grok audit: `label: true`
 * let an unchanged reference-recipe day label skip the faithfulness gate entirely). Drives
 * `jev.ts`'s `deterministicHoursLabelFlags` (via `spine.ts`'s `hoursLabelPathsFor`): every
 * day-of-week token the label text names must also appear, as a day token, somewhere in the
 * brief — not a whole-string match (a label may legitimately read "Mon-Thu" for a brief that
 * says "Monday through Thursday"), but every day the label claims must be one the brief actually
 * gives.
 */
/**
 * `verify: 'traceable'` is the SHARED marker (`spine.ts`'s `traceablePathsFor`, `jev.ts`'s
 * `deterministicTraceableFlags`, adopted family-wide starting with `agency-storefront`'s
 * round-11 audit) adopted here on this family's own practical-fact rows: a service or treatment's
 * own short label (`SERVICES_SECTION_ID`'s `title` only — see that section's own comment for why
 * its longer `body` is deliberately excluded), a provider's own credential
 * (`PROVIDERS_SECTION_ID`'s `credential`), an insurance or plan row (`INSURANCE_SECTION_ID`'s
 * `name`/`detail`), and an hours row's own value (`HOURS_LOCATION_SECTION_ID`'s `value`, paired
 * with `label`'s own `verify: 'hours-label'`) — every stemmed content word of the slot must trace
 * to the brief, the same standard `deterministicQuoteFlags` holds a review to, but without a
 * verbatim-run requirement. `insurance` and `hours-location` are both `optional` sections (an
 * unsupported row is never reached at all: the whole section drops). `services` and `providers`
 * are required, but each carries `min: 1` below `count: 3` — `arrayMinimaFor`'s ARRAY MINIMA
 * block already tells the model it may submit fewer items than the template rather than pad with
 * an invented one, so a brief with only one real service or provider still has a legal, honest
 * shape to land in. This mirrors storefront's own explicit precedent for `FieldSpec`'s docblock
 * there: a required row with NO legal way to shrink or drop (a fixed CTA body with no minimum)
 * is deliberately never marked this way, since a brief with nothing to say still forces the model
 * to write something there with no escape.
 */
export type FieldSpec = TextSlot & { list?: number; atom?: AtomKind; label?: true; personName?: true; verify?: 'quote' | 'destination' | 'hours-label' | 'traceable'; hoursValue?: string; hoursGroup?: string };
/**
 * `navSlots`: full path labels of nav text that only points at this section (cut with it).
 * `requires: 'quote'`: the fast lane (`packages/agency-fast-lane/src/sections.ts`,
 * `briefHasQuote`) drops the section before any fill call, with no Jev round trip, when the
 * brief quotes no one word for word — the same deterministic gate `agency-community`'s `voices`
 * section uses. A brief that only asks for reviews, with nothing quoted, can never reach a model
 * call for this section at all.
 */
export type OptionalSpec = { label: string; dropWhen: string; keepWhen: string; navSlots?: string[]; requires?: 'quote' };
export type SectionSpec = {
  id: string;
  type: string;
  text: FieldSpec[];
  /**
   * `count` is the maximum repeat; `min` (default `count`, i.e. exact) is the fewest a recipe may
   * carry. A section whose real-world count varies (services, providers, reviews, insurance,
   * FAQ) sets `min` below `count` so the page never pads a short list with content borrowed from
   * elsewhere or invented to reach a minimum — see contract.ts's array-length check and render.ts,
   * which maps over whatever length the recipe actually carries.
   */
  /** `drop`: unsupported items may be removed after the repairs (`x-drop: 'items'`). */
  items?: { count: number; min?: number; drop?: true; fields: FieldSpec[] };
  /** Present on a section a brief may give nothing for: its slot may be `null`. */
  optional?: OptionalSpec;
};

/** Brand fields a recipe carries. Both are plain text; there is no wordmark asset. */
export const BRAND_SLOTS: TextSlot[] = [
  { name: 'name', max: 60 },
  { name: 'descriptor', max: 200 },
];

export const HEADER_SECTION_ID = 'practice-header';
export const HERO_SECTION_ID = 'practice-hero';
export const SERVICES_SECTION_ID = 'practice-services';
export const PROVIDERS_SECTION_ID = 'practice-providers';
export const EXPECT_SECTION_ID = 'practice-expect';
export const BOOK_SECTION_ID = 'practice-book';
export const REVIEWS_SECTION_ID = 'practice-reviews';
export const INSURANCE_SECTION_ID = 'practice-insurance';
export const FAQ_SECTION_ID = 'practice-faq';
export const HOURS_LOCATION_SECTION_ID = 'practice-hours-location';
export const FOOTER_SECTION_ID = 'practice-footer';
/** The header/footer nav index that points only at the FAQ section. */
export const FAQ_NAV_LINK = 2;
/** The header/footer nav index that points only at the hours-and-location section. */
export const HOURS_NAV_LINK = 3;

export const SECTIONS: readonly SectionSpec[] = [
  // `application/tabs/4`: the practice name (brand--name) and the book button. No model-written
  // `links` field (round-2 Grok audit): the header nav used to carry four free-text labels the
  // model wrote for whichever section each index actually pointed at, and nothing checked that
  // the label named the right target — a live build wrote "Vaccinations" over the link that
  // jumps to "Meet your provider". The header nav is now built the same way the footer's already
  // is (`render.ts`'s `HEADER_NAV_LABELS`, mirroring `FOOTER_NAV_LABELS`): a FIXED label per
  // section, never model text, so a label can never name anything but its own real target.
  { id: HEADER_SECTION_ID, type: 'header', text: [{ name: 'bookCta', max: 32 }] },
  // `marketing/sections/4` + `marketing/ctas/2`: the local need, the practice's pitch, and the
  // book call. `brand.name` and `brand.descriptor` (rendered here too) carry the practice's name
  // and what it treats; this section adds the wider pitch and the button.
  {
    id: HERO_SECTION_ID, type: 'hero',
    text: [
      { name: 'eyebrow', max: 48 }, { name: 'heading', max: 72 }, { name: 'body', max: 200 },
      { name: 'bookCta', max: 32 },
    ],
  },
  // `marketing/feature-grids/1`: the services or treatments the practice offers. Required —
  // every practice states what it does.
  // `min: 1`: a one-treatment or a three-treatment practice both describe themselves honestly;
  // never pad a short list to 3 with invented or borrowed content.
  {
    id: SERVICES_SECTION_ID, type: 'services',
    text: [{ name: 'heading', max: 60 }, { name: 'body', max: 200 }],
    // Only `title` (a short label: "Cosmetic dentistry") is marked `verify: 'traceable'`, not
    // `body` (a full descriptive sentence up to 200 characters). A round-1 live-build audit found
    // `body`'s own natural elaboration ("...porcelain veneers, planned around your smile.")
    // false-flagged on ordinary marketing flourish ("planned", "around", "smile") that states no
    // fact of its own at all — the exact reasoning `agency-storefront`'s own `FieldSpec` docblock
    // gives for never marking a required, no-escape prose body this way (see `buy-preorder.body`
    // there): a full sentence needs room to read naturally, and `deterministicClaimFlags` (every
    // slot, unconditionally) still catches any actual invented number here.
    items: { count: 3, min: 1, fields: [{ name: 'title', max: 60, verify: 'traceable' }, { name: 'body', max: 200 }] },
  },
  // `marketing/feature-grids/2`: the providers and their credentials. Required — a clinical or
  // appointment practice earns trust through who treats the visitor. `min: 1`: a solo-practitioner
  // brief names exactly one provider; the page renders one card, never two more borrowed from
  // `services` to reach a count of three.
  {
    id: PROVIDERS_SECTION_ID, type: 'providers',
    text: [{ name: 'heading', max: 60 }, { name: 'body', max: 200 }],
    items: { count: 3, min: 1, fields: [{ name: 'name', max: 60, personName: true }, { name: 'credential', max: 100, verify: 'traceable' }] },
    // Optional (Devin, 2026-10-10): a brief that names no clinician could only fill this by
    // inventing a person, which strict verify rightly refused, so the whole build failed.
    optional: {
      label: 'named dentists, doctors or clinicians',
      dropWhen: 'The brief names no dentist, doctor, hygienist or other clinician by name.',
      keepWhen: 'The brief names at least one real clinician of this practice.',
    },
  },
  // `application/timelines/1`: what to expect, the visit steps. Optional (see below).
  {
    id: EXPECT_SECTION_ID, type: 'expect',
    text: [{ name: 'heading', max: 60 }, { name: 'body', max: 200 }],
    // `min: 1`: a brief that describes one or two steps of a visit gets those, never three padded ones.
    items: { count: 3, min: 1, fields: [{ name: 'step', max: 24, label: true }, { name: 'title', max: 60 }, { name: 'body', max: 160 }] },
    // Optional (Devin, 2026-10-10): a brief that describes no visit could only fill three steps by
    // inventing them.
    optional: {
      label: 'what to expect at a visit, step by step',
      dropWhen: 'The brief does not describe what happens at a visit or appointment.',
      keepWhen: 'The brief describes the steps of a visit or appointment.',
    },
  },
  // `marketing/ctas/1`: the book step. `destination` is a nullable, verified atom: a brief with no
  // booking URL, phone or email still shows the call to book, but never a link render.ts cannot
  // honestly point anywhere real (see render.ts renderBook); a non-null destination must be a
  // well-formed URL/email/phone (contract.ts) that also appears verbatim in the brief
  // (jev.ts's deterministicDestinationFlags) — never a plausible-looking but invented one.
  {
    id: BOOK_SECTION_ID, type: 'book',
    text: [{ name: 'heading', max: 60 }, { name: 'body', max: 200 }, { name: 'cta', max: 32 }, { name: 'destination', max: 120, atom: 'destination', verify: 'destination' }],
  },
  // `marketing/testimonials/3`: optional, a new or privacy-conscious practice often has none to
  // show.
  {
    id: REVIEWS_SECTION_ID, type: 'reviews',
    text: [{ name: 'heading', max: 60 }],
    items: { count: 3, min: 1, fields: [{ name: 'quote', max: 240, verify: 'quote' }, { name: 'name', max: 60, personName: true }] },
    optional: {
      label: 'patient or client reviews',
      dropWhen: 'The brief quotes no patient or client word for word. A brief that only asks for reviews or testimonials supplies none.',
      keepWhen: "The brief itself contains a patient's or client's own words in quotation marks, with who said them, to show as social proof.",
      // Same deterministic pre-fill gate community's `voices` section uses (`briefHasQuote` in
      // packages/agency-fast-lane/src/sections.ts): a brief with no quoted passage at all never
      // reaches a fill call for this section, so a request that only asks for reviews can never
      // produce an invented one. See also `findUnverifiedNames` in contract.ts, a second,
      // deterministic (non-LLM) check against the actual filled recipe: every reviewer name and
      // quote must appear verbatim in the brief that produced it.
      requires: 'quote',
    },
  },
  // `marketing/pricing/1`: optional, insurance accepted or a nullable price per item — never an
  // invented figure.
  {
    id: INSURANCE_SECTION_ID, type: 'insurance',
    text: [{ name: 'heading', max: 60 }, { name: 'body', max: 200 }],
    items: { count: 2, min: 1, fields: [{ name: 'name', max: 60, verify: 'traceable' }, { name: 'detail', max: 120, verify: 'traceable' }, { name: 'price', max: 24, atom: 'plain' }] },
    optional: {
      label: 'insurance or pricing',
      dropWhen: 'The brief states no accepted insurance, plan or price the practice can stand behind.',
      keepWhen: 'The brief states real insurance accepted, a plan, or a real price for a service.',
    },
  },
  // `application/details-list/1` (question/answer pairs): optional FAQ. The header's third nav
  // slot points only here (a FIXED label, never model text — see `HEADER_SECTION_ID`'s own
  // comment above) and is shown only when this section renders.
  {
    id: FAQ_SECTION_ID, type: 'faq',
    text: [{ name: 'heading', max: 60 }],
    items: { count: 3, min: 1, fields: [{ name: 'question', max: 100 }, { name: 'answer', max: 240 }] },
    optional: {
      label: 'frequently asked questions',
      dropWhen: 'The brief supplies no real question a visitor would ask this practice and no answer for it.',
      keepWhen: 'The brief supplies real, answerable questions specific to this practice.',
    },
  },
  // `application/details-list/1` (label/value rows): optional hours and a nullable address and
  // phone; no map embed. The header's fourth nav slot points only here (a FIXED label) and is
  // shown only when this section actually renders something (see `hoursLocationIsMeaningful`).
  {
    id: HOURS_LOCATION_SECTION_ID, type: 'hours-location',
    text: [
      { name: 'heading', max: 60 }, { name: 'address', max: 120, atom: 'address' }, { name: 'phone', max: 40, atom: 'phone', verify: 'destination' },
    ],
    // `min: 0`: opening hours are themselves a fact the brief may not state (unlike `address` and
    // `phone`, an hours row has no single nullable atom of its own, since each row pairs a label
    // with a value). A brief with no real hours carries zero rows rather than a placeholder row
    // asserting "not published" — see render.ts's `meaningfulHoursRows`, which also strips any
    // row that reads as an unknown-fact placeholder rather than a real hour.
    //
    // The row's `label` is NOT `label: true` (round-4 Grok audit): a day or day-range ("Mon-Thu",
    // "Fri", "Sat-Sun") is a FACT — it claims the practice is open on those specific days — not
    // UI chrome. Marking it `x-label` let it skip the faithfulness gate entirely whenever it was
    // left unchanged from the reference recipe's own real schedule, so a Saturday-only brief
    // could still publish the reference's untouched Mon-Thu/Fri/Sat-Sun rows: nothing ever sent
    // those strings to the judge, and a repair that fixed only the `value` beside them left them
    // locked. `verify: 'hours-label'` drives a dedicated deterministic gate instead (`jev.ts`'s
    // `deterministicHoursLabelFlags`), the same architecture as `personName`/`verify: 'quote'`.
    // G8 final: `hoursValue: 'value'` names the row's value, so that gate checks the label's day
    // set against the day set the brief gives for THIS row's hours (`hours-label.ts`).
    items: { count: 3, min: 0, drop: true, fields: [{ name: 'label', max: 24, verify: 'hours-label', hoursValue: 'value', hoursGroup: 'table' }, { name: 'value', max: 48, verify: 'traceable' }] },
    optional: {
      label: 'hours and location',
      dropWhen: 'The brief states no real opening hours and no real address or phone for this practice.',
      keepWhen: 'The brief states real opening hours, or a real address or phone, for this practice.',
    },
  },
  // `marketing/footers/4`: tagline, three legal links, and nullable contact facts so the footer
  // never states a phone number, email or address the brief did not give.
  {
    // No free-form `links` field: a model-authored footer nav label ("Privacy policy", "New
    // patient forms", "Careers") names a page this site never renders, and strict Jev verify
    // proved it can miss that kind of invention. The footer's nav instead comes from
    // `render.ts`'s `deterministicFooterNav` — a FIXED label per section type, built only from
    // the sections that actually render in this recipe, anchored to their real `#id`. No model
    // text, so nothing to fabricate.
    id: FOOTER_SECTION_ID, type: 'footer',
    // Field order matches render.ts's DOM order (tagline, then contact facts).
    text: [
      { name: 'tagline', max: 120 },
      { name: 'address', max: 120, atom: 'address' }, { name: 'phone', max: 40, atom: 'phone', verify: 'destination' }, { name: 'email', max: 80, atom: 'email', verify: 'destination' },
    ],
  },
];

export const SECTION_ORDER = SECTIONS.map((section) => section.id);

/** The nullable string leaves, by section id and field (a repeat's field too): facts a brief may not state. */
export const PRACTICE_NULLABLE_ATOMS: Readonly<Record<string, Readonly<Record<string, AtomKind>>>> = Object.fromEntries(
  SECTIONS.flatMap((section) => {
    const atoms = [...section.text, ...(section.items?.fields ?? [])].filter((field) => field.atom).map((field) => [field.name, field.atom!] as const);
    return atoms.length > 0 ? [[section.id, Object.fromEntries(atoms)]] : [];
  }),
);

/** Section types a brief may give nothing for: the whole slot in `sections` may be `null`. */
export const PRACTICE_OPTIONAL_SECTIONS: ReadonlySet<string> = new Set(SECTIONS.filter((section) => section.optional).map((section) => section.type));
