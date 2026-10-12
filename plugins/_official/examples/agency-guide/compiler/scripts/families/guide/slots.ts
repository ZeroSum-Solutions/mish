/**
 * guide family — the finite section and slot registry.
 *
 * A page kind for atlas archetype CS.01 (shared with `publication`): one destination — a city,
 * region, trail or island — told as chapters plus practical facts. The visitor READS the place;
 * there is no subscription, no issue archive, no room or booking inventory and no reservations.
 * It composes nine vendored HyperUI blocks (see `GUIDE_BLOCKS`) into one fixed layout. Only named
 * text slots are exported here; `render.ts` owns the markup and a recipe never carries markup or
 * CSS. No asset system: the vendored blocks carry no `<img>` — the "gallery" section is a pure
 * CSS/typography treatment of named places, never a photograph.
 *
 * Every section is declared as data (`SectionSpec`): its section-level text fields, then its
 * repeated items. `contract.ts` validates a recipe by walking these specs, `recipeSchema()` in
 * `contract.ts` derives `recipe.schema.json` from them, and `render.ts` emits each section's
 * slots in the order declared here — so `render.test.ts` can rebuild the full `data-od-id`
 * roster from this file alone and compare it with the page.
 *
 * Slot ids: `<sectionId>--<field>` for a section field, `<sectionId>--items-<i>--<field>` inside a
 * repeat. `brand--name` and `brand--descriptor` are two more reconcilable slots on top of the
 * sections.
 */

export const FAMILY_ID = 'guide';
export const SCHEMA_VERSION = 2;

/** The HyperUI blocks this page kind is built from (`hyperui/pagekinds.json` lists the same). */
export const GUIDE_BLOCKS = [
  'application/tabs/4', 'marketing/sections/4', 'marketing/sections/1', 'marketing/feature-grids/2',
  'application/details-list/1', 'marketing/feature-grids/1', 'marketing/testimonials/3',
  'marketing/ctas/1', 'marketing/footers/4',
] as const;

export type TextSlot = { name: string; max: number };
/**
 * The fixed, closed set of practical-fact categories this family recognizes — getting there, best
 * time to visit, currency, language, in this order. Two live-build rounds shaped this design:
 *
 * Round 3 found the ORIGINAL design let the model write its OWN category name (a free `label`
 * field beside `value`) — free model text, not a fact from the brief — and a sparse brief drove
 * the filler to invent plausible-looking category names ("Around the crossing", "Farmers' stall").
 *
 * Round 4 (this fix) found the round-3 fix over-corrected the OTHER way: making every one of the
 * four rows REQUIRED (a fixed-length array, `value` merely nullable) forced the model to invent a
 * value for a category the brief never states at all — the family's own bar has always been "drop
 * an unstated fact", not "state something for every category" — and a strict build correctly
 * refused a Cerebras run that invented "parking", an unstated season and an unstated language
 * rather than dropping those three rows. The fix: each ROW (label AND value together) is nullable
 * as a whole (see `SectionSpec.items.itemAtom`'s own doc) — a category the brief supports gets a
 * real row at its fixed position; one it does not gets `null` for the WHOLE item, dropped by
 * `render.ts`, never a guessed value under a real label. `label` still stays IN the schema (so the
 * model can see, per position, which category it is answering) and `contract.ts` still hard-
 * refuses any PRESENT row's label that is not `PRACTICAL_FACTS_LABELS[index]` exactly — the round-4
 * fix only widens what a row may be (a real row, or nothing) without touching that guard. If all
 * four rows end up `null`, `practicalFactsAreMeaningful` returns false and the WHOLE section is
 * dropped, same as any other empty optional section.
 */
export const PRACTICAL_FACTS_LABELS = ['Getting there', 'Best time to visit', 'Currency', 'Language'] as const;
/**
 * The fact kind an item-level `itemAtom` (see `SectionSpec.items`'s own doc) or a leaf `atom`
 * names — sent to the model VERBATIM inside `prompt.ts`'s NULLABLE block (the shared fast lane
 * just JSON-stringifies whatever string `x-atom` carries; it does not interpret it), so this is
 * ALSO the one per-item instructional channel a family has with no shared-file change. A round-4
 * live-build regression found the SHORT kind `'plain'` was not enough on its own: the model saw
 * `NULLABLE.items` as `["plain","plain","plain","plain"]` with no cue that "null" means the WHOLE
 * item, or that a present item's `label` must match TEMPLATE's own label at that position rather
 * than being invented — and kept writing its own category names into every row instead of ever
 * returning `null`. `PRACTICAL_FACTS_ITEM_ATOM` (below) is the fix: a longer, explicit sentence in
 * place of a short kind word.
 */
export type AtomKind = string;
/**
 * practical-facts' item-level `itemAtom` value (see `AtomKind`'s own doc for why this is a full
 * sentence, not a short kind word): tells the model, inside NULLABLE, both halves of the round-4
 * fix in one place — return `null` for the WHOLE row when unsupported, and never invent a label
 * for a row that IS present.
 */
export const PRACTICAL_FACTS_ITEM_ATOM =
  'this whole row (its fixed label AND its value together) — return null for the WHOLE item, '
  + 'not just its value, when the brief does not support this exact category; a present item\'s '
  + '"label" must be copied VERBATIM from this same position in TEMPLATE, never invented or reworded';
/**
 * A text field. `atom` makes it nullable (see `AtomKind`'s own doc for this family's one user,
 * practical-facts' `value`). `label` marks template chrome — left exactly as the reference wrote
 * it, the faithfulness gate skips it (this family has no such SCHEMA-carried chrome fields: every
 * heading here is real, brief-supplied content, never fixed UI text — see `render.ts`'s
 * `HEADER_NAV_LABELS`/`FOOTER_NAV_LABELS`/`PRACTICAL_FACTS_LABELS`, which are TypeScript constants,
 * never a schema field, for the places this family has genuinely fixed chrome).
 *
 * `contactAtom: 'url'` marks the plan-a-visit section's own `url` field — the ONE slot this family
 * can turn into a live `https:` link. Carried through to the schema as `x-atom: 'url'`, the SAME
 * shared marker `spine.ts`'s `contactPathsFor` reads for any family's contact atom (an email, a
 * phone, or here a URL): `jev.ts`'s `deterministicContactFlags` traces its value against the
 * brief's own URL tokens, by token equality, never a substring match or a plausible-looking
 * invention. Unlike a nullable `atom` field, `url` is never nullable itself: a brief with no
 * plan-a-visit URL drops the WHOLE section instead (see `slots.ts`'s `OptionalSpec` below) — there
 * is no such thing as a plan-a-visit section that exists with no link. Kept as its own field
 * (rather than reusing `atom`) for exactly that reason: `contract.ts`'s `fieldSchema()` must not
 * add `'null'` to this field's type the way it does for a nullable atom.
 *
 * `traceable: true` marks a free-prose slot with `x-verify: 'traceable'` — the same shared marker
 * `spine.ts`'s `traceablePathsFor` reads for any family: `jev.ts`'s `deterministicTraceableFlags`
 * traces every stemmed content word of the slot's value against the brief, catching an invented
 * fact (a season, a language, a proximity claim, a mis-stated name) that Jev's own judgment might
 * plausibly miss. Marks this family's practical-facts `value` (never `label`, which is fixed chrome
 * — see `PRACTICAL_FACTS_LABELS`), gallery labels, place cards (`name` and `body`) and the brand
 * descriptor — every free-prose slot that states a fact about the destination rather than writing
 * a heading, a button label, fixed chrome, or unconstrained narrative prose.
 */
export type FieldSpec = TextSlot & { atom?: AtomKind; label?: true; contactAtom?: 'url'; traceable?: true };
export type OptionalSpec = { label: string; dropWhen: string; keepWhen: string; navSlots?: string[] };
export type SectionSpec = {
  id: string;
  type: string;
  text: FieldSpec[];
  /**
   * `count` is the maximum repeat; `min` (default `count`, i.e. exact) is the fewest a recipe may
   * carry. A section whose real-world count varies (chapters, practical facts, places, gallery
   * cards) sets `min` below `count` so the page never pads a short list with content borrowed from
   * elsewhere or invented to reach a minimum — see contract.ts's array-length check and render.ts,
   * which maps over whatever length the recipe actually carries. A sparse brief with only one
   * further chapter must still render correctly: never padded to look like more.
   */
  items?: {
    count: number;
    min?: number;
    fields: FieldSpec[];
    /**
     * Marks the WHOLE ITEM (not one of its leaves) nullable, with the fact kind it holds — the
     * same shared convention `spine.ts`'s `atomKindsFor` already documents for "a whole repeat
     * item ... that is nullable as one piece" (its own doc, not new infrastructure): the item's
     * OWN schema node carries `type: ['object', 'null']` and `x-atom: itemAtom`, so
     * `atomKindsFor`/`nullablePathsOf`/`mergeIntoSpine`'s existing whole-group-null handling (used
     * elsewhere for a nullable KPI card) applies to it with ZERO changes to jev.ts, run.ts or
     * spine.ts. `practical-facts` is this family's only user: a category the brief does not
     * support is `null` — the WHOLE row, label included — never a half-filled row, and never a
     * variable array length (see `count`/`min` above, which this is NOT — the array always has
     * exactly `count` entries; some may be `null`).
     */
    itemAtom?: AtomKind;
  };
  /** Present on a section a brief may give nothing for: its slot may be `null`. */
  optional?: OptionalSpec;
};

/**
 * Brand fields a recipe carries. `name` is required plain text; there is no wordmark asset.
 * `descriptor` must use only words and facts the brief itself gives about the place — never a
 * plausible detail (a proximity claim, a season, a currency, a language) invented to sound like
 * local knowledge; a round-1 audit found exactly that in a committed fixture (see
 * `reference.fixture.json`'s history — the round-1 finding was Cerebras inventing "amber-coast"
 * there).
 *
 * `descriptor` carries BOTH `atom: 'plain'` and `traceable: true` (the same combination
 * storefront's own `price` field uses — see that family's `slots.ts`/`contract.ts` `fieldSchema`
 * doc: "a nullable-AND-traceable field"), as of a round-4 fix. Through round 1-3 it was
 * `traceable: true` alone, required. A round-4 live-build finding (Cerebras, sparse Lowmoor
 * Crossing brief) found the WHOLE-FIELD trace punished the same kind of faithful paraphrase
 * places-to-see's own `body` was fixed for in round 3: `descriptor` is a single synthesized
 * sentence stitching together facts the brief states across several separate sentences ("a stone
 * bridge", "a single row of shops", "a green", "a weekend farmers' stall"), and any ordinary
 * connecting word a weaker model reaches for while stitching them ("centered on", "along",
 * "welcome") — not a new fact — failed the trace and exhausted the faithfulness repair budget.
 *
 * The coordinator's own review rejected the first fix attempt (dropping `traceable` outright,
 * mirroring places-to-see's `body`): `descriptor` has no count, distance or time claim signal of
 * its own, so `deterministicSentenceClaimFlags` (guide's other backstop) can never reach it —
 * exactly the same field where the round-1 finding (an invented "amber-coast" claim) happened, so
 * losing whole-field tracing there specifically would reopen that class of bug. The ROOT fix is
 * this family's own established nullable-atom pattern instead: `descriptor` stays traceable when
 * PRESENT (an invented name/place/season/currency/language still fails the SAME word-for-word
 * check that caught the round-1 finding), but may now be `null` when the brief does not support a
 * one-sentence synthesis at all — `render.ts` drops the slot and the `<meta name="description">`
 * tag entirely rather than force a guessed or over-general sentence into existence. A model
 * should reach for the brief's own words when it writes one, or return `null` rather than
 * paraphrase; see `PROMPT_GUIDANCE` below, sent the same way `PRACTICAL_FACTS_ITEM_ATOM` is.
 */
export const DESCRIPTOR_ATOM =
  "the destination's one-sentence descriptor — use ONLY the brief's own words and phrasing to "
  + 'state its plain facts (place type, region, what it is known for); never paraphrase, '
  + 'summarize, or add a connecting detail the brief does not literally give; if no single '
  + 'sentence can be built from the brief\'s own words alone, return null rather than invent or '
  + 'loosely restate one';
export const BRAND_SLOTS: FieldSpec[] = [
  { name: 'name', max: 60 },
  { name: 'descriptor', max: 200, atom: DESCRIPTOR_ATOM, traceable: true },
];

export const HEADER_SECTION_ID = 'guide-header';
export const MASTHEAD_SECTION_ID = 'guide-masthead';
export const OPENING_CHAPTER_SECTION_ID = 'guide-opening-chapter';
export const CHAPTER_LIST_SECTION_ID = 'guide-chapter-list';
export const PRACTICAL_FACTS_SECTION_ID = 'guide-practical-facts';
export const PLACES_SECTION_ID = 'guide-places-to-see';
export const GALLERY_SECTION_ID = 'guide-gallery';
export const PLAN_A_VISIT_SECTION_ID = 'guide-plan-a-visit';
export const FOOTER_SECTION_ID = 'guide-footer';
/** The header/footer nav index that points only at practical facts. */
export const PRACTICAL_FACTS_NAV_LINK = 1;
/** The header/footer nav index that points only at places to see. */
export const PLACES_NAV_LINK = 2;
/** The header/footer nav index that points only at the gallery. */
export const GALLERY_NAV_LINK = 3;
/** The header/footer nav index that points only at plan-a-visit. */
export const PLAN_A_VISIT_NAV_LINK = 4;

export const SECTIONS: readonly SectionSpec[] = [
  // `application/tabs/4`: the destination's name and the nav. No model-written `links` field
  // (the same round-2 practice-audit lesson): every nav label is FIXED per section
  // (`render.ts`'s `HEADER_NAV_LABELS`, mirroring `FOOTER_NAV_LABELS`), never model text, so a
  // label can never name a target it does not point at.
  { id: HEADER_SECTION_ID, type: 'header', text: [] },
  // `marketing/sections/4`: the place name (brand.name, rendered here as the masthead's own
  // heading) and the standfirst — the visitor's very first read of what this destination is.
  {
    id: MASTHEAD_SECTION_ID, type: 'masthead',
    text: [{ name: 'heading', max: 72 }, { name: 'standfirst', max: 220 }],
  },
  // `marketing/sections/1`: the opening chapter — required prose from the brief, no invented
  // facts. This is the first chapter; `chapter-list` below holds the further ones.
  {
    id: OPENING_CHAPTER_SECTION_ID, type: 'opening-chapter',
    text: [{ name: 'heading', max: 60 }, { name: 'body', max: 1800 }],
  },
  // `marketing/feature-grids/2`: typically two to six further chapters, each its own title and
  // text — but `min: 1`, not 2: a sparse, honest brief that supports only ONE further chapter
  // (beyond the always-present opening chapter) must still render correctly, never padded to
  // look like more with a fabricated second or third.
  {
    id: CHAPTER_LIST_SECTION_ID, type: 'chapter-list',
    text: [{ name: 'heading', max: 60 }],
    items: { count: 6, min: 1, fields: [{ name: 'title', max: 60 }, { name: 'body', max: 600 }] },
  },
  // `application/details-list/1` (label/value rows): optional practical facts — only stated
  // facts (getting there, best time, currency, language); unstated rows are dropped, never
  // invented, never a placeholder ("Not published").
  {
    id: PRACTICAL_FACTS_SECTION_ID, type: 'practical-facts',
    text: [{ name: 'heading', max: 60 }],
    // FIXED length, exactly the closed category set (`PRACTICAL_FACTS_LABELS`), one item slot per
    // category IN THAT ORDER — but each ITEM AS A WHOLE is nullable (`itemAtom: PRACTICAL_FACTS_ITEM_ATOM`, see
    // `SectionSpec.items`'s own doc): a category the brief does not support is `null`, dropped
    // entirely, never a guessed value the round-4 fix exists to stop. `label` stays in the schema
    // (`x-label: true`, so an unchanged copy is chrome the faithfulness gate skips) on a PRESENT
    // row SO THE MODEL CAN SEE which category each fixed position is — a live build with `label`
    // removed entirely lost that context and put a getting-there fact under the Language row
    // purely because it had no positional cue at all (the round-3-then-4 history). `contract.ts`'s
    // `parseGuideRecipe` hard-refuses any PRESENT row's `label` that is not
    // `PRACTICAL_FACTS_LABELS[index]` exactly — a closed-set equality check, not a faithfulness
    // judgment call — so the model cannot invent a category name OR silently answer the wrong
    // category and have either one merely FLAGGED; both are a hard compiler refusal that feeds the
    // same repair loop as any other malformed answer. `value` is the only genuinely model-authored
    // field, required text once its row is present — an unstated category never reaches `value` at
    // all, because the WHOLE row is null instead.
    items: {
      count: PRACTICAL_FACTS_LABELS.length,
      itemAtom: PRACTICAL_FACTS_ITEM_ATOM,
      fields: [{ name: 'label', max: 40, label: true }, { name: 'value', max: 200, traceable: true }],
    },
    optional: {
      label: 'practical facts',
      dropWhen: 'The brief states no real practical fact (getting there, best time to visit, currency or language) for this destination. Getting there, best time, currency and language are four independent facts — the section is kept, but any one of them the brief does not state is its own row to OMIT ENTIRELY (return null for that whole row, not just its value), never guessed and never a row filled with a plausible-sounding guess (a season, a currency name, a language, a road or parking note the brief never gave). Omit the row; never guess.',
      keepWhen: 'The brief states at least one real practical fact for this destination.',
    },
  },
  // `marketing/feature-grids/1`: optional places to see — only named places the brief actually
  // gives; never a generic filler attraction.
  {
    id: PLACES_SECTION_ID, type: 'places-to-see',
    text: [{ name: 'heading', max: 60 }, { name: 'body', max: 200 }],
    // `name` (a proper noun) stays `traceable: true`: it must come from the brief verbatim, the
    // same as any other named entity this family checks. `body` is DELIBERATELY NOT marked
    // `traceable` (round-5 fix, mirroring storefront's own `body` field, which storefront's
    // slots.ts explicitly does not mark traceable either): a full-field word-for-word trace over
    // free descriptive prose punishes ordinary, faithful PARAPHRASE — the fact that matters is a
    // CLAIM (a count, a distance, a time), not every word of how it is phrased. The check for
    // that is a per-sentence claim gate over number/number-word/distance-stem/commercial-stem/
    // clock-time signals — `deterministicSentenceClaimFlags` (`jev.ts`), the same one storefront
    // opts its own free-prose fields into. As of round 4, `guide` IS registered in `run.ts`'s
    // `SENTENCE_CLAIM_FAMILIES` (NOT the older, storefront-only `COMMERCIAL_WORD_FAMILIES` set,
    // which this comment used to wrongly name), so this check is LIVE for every real build — see
    // `packages/agency-fast-lane/tests/guide-sentence-claims.test.ts` for the exact mechanism and
    // its full, currently-caught reach (a spelled-out small count, a bare distance/proximity
    // phrase with no number, and a glued clock time are all live signals, not documented gaps).
    items: { count: 5, min: 1, fields: [{ name: 'name', max: 60, traceable: true }, { name: 'body', max: 200 }] },
    optional: {
      label: 'places to see',
      dropWhen: 'The brief names no real place within this destination worth a visitor seeing, or names a place but gives nothing to say about it. Each place card is its own row, and both parts of it are optional together: a card whose name or body claims something the brief never said (a proximity to another place, a distance, a walking time, a count of places, a superlative such as "best" or "most") is inventing, not describing, and that card should be OMITTED entirely rather than written with an invented or padded description. Describe a kept place using the brief\'s OWN words and facts — never a distance, a walking or driving time, or a count the brief does not give.',
      keepWhen: 'The brief names at least one real place within this destination AND gives something real to say about it.',
    },
  },
  // `marketing/testimonials/3` (grid shape, reused for a typographic card layout — no quote glyph,
  // no image): optional gallery-style typographic place cards. Pure CSS/typography, never a stock
  // photo or an `<img>`. Reuses the SAME named places a visitor already read about above — a
  // second, more visual pass over the same honest facts, never a new invented place.
  {
    id: GALLERY_SECTION_ID, type: 'gallery',
    text: [{ name: 'heading', max: 60 }],
    items: { count: 6, min: 2, fields: [{ name: 'label', max: 60, traceable: true }] },
    optional: {
      label: 'gallery-style typographic place cards',
      dropWhen: 'The brief names fewer than two real places within this destination to show as a typographic card grid. Each label reuses a place name (and, if needed, at most a short honest descriptor of it) the brief already gave elsewhere — never a new claim about that place — and a label with no brief-given place behind it is its own row to omit.',
      keepWhen: 'The brief names at least two real places within this destination for a typographic card grid.',
    },
  },
  // `marketing/ctas/1`: optional plan-a-visit — a single link to the brief-supplied URL only.
  // Dropped entirely (the whole section, never a null link inside a present one) when the brief
  // gives no URL.
  {
    id: PLAN_A_VISIT_SECTION_ID, type: 'plan-a-visit',
    text: [
      { name: 'heading', max: 60 }, { name: 'body', max: 200 }, { name: 'cta', max: 32 },
      { name: 'url', max: 200, contactAtom: 'url' },
    ],
    optional: {
      label: 'plan a visit',
      dropWhen: 'The brief gives no real URL for planning a visit to this destination.',
      keepWhen: 'The brief gives one real URL for planning a visit to this destination.',
    },
  },
  // `marketing/footers/4`: a closing line. No contact atoms — this page kind has no booking or
  // contact facts of its own beyond the optional plan-a-visit link above.
  {
    id: FOOTER_SECTION_ID, type: 'footer',
    text: [{ name: 'tagline', max: 160 }],
  },
];

export const SECTION_ORDER = SECTIONS.map((section) => section.id);

/** The nullable string leaves, by section id and field (a repeat's field too), PLUS a synthetic
 * `'brand'` entry for `BRAND_SLOTS` (brand is not itself a section, but follows the exact same
 * `field.atom` convention as of round 4's `descriptor` fix — see that field's own doc in
 * `BRAND_SLOTS`): facts a brief may not state. */
export const GUIDE_NULLABLE_ATOMS: Readonly<Record<string, Readonly<Record<string, AtomKind>>>> = Object.fromEntries(
  [...SECTIONS.map((section) => [section.id, [...section.text, ...(section.items?.fields ?? [])]] as const), ['brand', BRAND_SLOTS] as const]
    .flatMap(([id, specs]) => {
      const atoms = specs.filter((field) => field.atom).map((field) => [field.name, field.atom!] as const);
      return atoms.length > 0 ? [[id, Object.fromEntries(atoms)]] : [];
    }),
);

/** Section types a brief may give nothing for: the whole slot in `sections` may be `null`. */
export const GUIDE_OPTIONAL_SECTIONS: ReadonlySet<string> = new Set(SECTIONS.filter((section) => section.optional).map((section) => section.type));
