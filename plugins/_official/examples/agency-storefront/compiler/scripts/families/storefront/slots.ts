/**
 * storefront family — the finite section and slot registry.
 *
 * A page kind for atlas archetype CO.01 (Commerce): merchandise, buy or preorder. It composes
 * twelve vendored HyperUI blocks (see `STOREFRONT_BLOCKS`) into one fixed layout. Only named text
 * slots are exported here; `render.ts` owns the markup and a recipe never carries markup or CSS.
 * No image asset system: the vendored blocks carry no `<img>`, so the collection grid and
 * featured product are caption-only, placeholders for product photography an operator adds later.
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
 * carries the short pitch, e.g. "Hand-finished leather goods, made in small runs."
 *
 * `buy-preorder` is REQUIRED — it is the one section a shop brief must always have, since a
 * storefront exists to take a visitor to a buy or preorder decision — but its destination is
 * honest: a supplied `url` wins, else a supplied `phone` or `email` renders a real `tel:`/
 * `mailto:` link, and when the brief gives none of the three the section still renders (its
 * heading and body stand) but its call to action is plain text, never a fake or dead link. See
 * `render.ts`'s `renderBuyPreorder`.
 */

export const FAMILY_ID = 'storefront';
export const SCHEMA_VERSION = 2;

/** The HyperUI blocks this page kind is built from (`hyperui/pagekinds.json` lists the same). */
export const STOREFRONT_BLOCKS = [
  'application/tabs/4', 'application/tabs/5', 'marketing/sections/4', 'marketing/pricing/1',
  'marketing/feature-grids/3', 'application/details-list/1', 'marketing/ctas/1',
  'marketing/sections/1', 'marketing/testimonials/3', 'marketing/sections/3', 'marketing/footers/4',
] as const;

export type TextSlot = { name: string; max: number };
/** A fact a brief may not state: the slot is `null` then, and the page drops its element.
 * `url` is a storefront-only addition (see `contract.ts`'s `isUrl`): a full `https://` or
 * `http://` destination, never invented when the brief gives none. */
/** `person-name` is a reviewer's attributed name: nullable (a brief that names no one gets
 * `null`, and a null name renders NO attribution line at all — see `render.ts`'s `renderReviews`), and
 * checked deterministically against the brief in addition to Jev — see `jev.ts`'s
 * `deterministicAttributionFlags` and `spine.ts`'s `personNamePathsFor`. */
export type AtomKind = 'phone' | 'email' | 'address' | 'plain' | 'url' | 'person-name';
/** A text field. `list` makes it exactly that many strings; `atom` makes it nullable. */
/** `verify: 'quote'` marks a required (non-nullable) text slot the shared deterministic checker
 * traces against the brief in addition to Jev — see contract.ts's `fieldSchema` and jev.ts's
 * `deterministicQuoteFlags`. Distinct from `atom`, which also makes a slot nullable; a quote is
 * always required when its containing item exists. */
/** `label: true` marks TEMPLATE CHROME (`x-label`, the same convention nonprofit/listings/
 * publication already use) — text that names the page's own structure rather than stating a fact
 * about the brand, so `template-chrome.ts`'s exemption applies when the fill leaves it exactly as
 * the reference wrote it. A fourth audit pass proved this is needed here specifically: shipping-
 * returns's own `heading` is documented neutral chrome ("Shipping and returns"), and a live
 * Cerebras build showed that once `deterministicCommercialWordFlags` checks every slot, an
 * unlabeled heading containing "shipping" fails an exact match against a brief that only ever
 * uses the verb "ship" — the same problem `x-label` already exists to solve for a nav link. */
/** `verify: 'traceable'` (round-11 audit pass, item A) marks a slot that states a COMMERCIAL FACT
 * (a price, a shipping/returns policy, a stock/availability line, a product-detail row) whose
 * every stemmed content word must trace to the brief — see `spine.ts`'s `traceablePathsFor` and
 * `jev.ts`'s `deterministicTraceableFlags`. Looser than `'quote'` (no verbatim run required),
 * stricter than the bare LLM judge, and — unlike the commercial-word/claim-token gates — never an
 * open word list: an invented "Half off" or "complimentary delivery" has no digit, no denylist
 * word and no claim token, but every one of its content words still has to appear somewhere in
 * the brief. Coexists with `atom` (see `contract.ts`'s `fieldSchema`): a nullable price is still
 * traced when the brief supplies one. */
export type FieldSpec = TextSlot & { list?: number; atom?: AtomKind; verify?: 'quote' | 'traceable'; label?: true };
export type OptionalSpec = { label: string; dropWhen: string; keepWhen: string };
export type SectionSpec = {
  id: string;
  type: string;
  text: FieldSpec[];
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

export const HEADER_SECTION_ID = 'storefront-header';
export const HERO_SECTION_ID = 'storefront-hero';
export const FEATURED_PRODUCT_SECTION_ID = 'storefront-featured-product';
export const COLLECTION_GRID_SECTION_ID = 'storefront-collection-grid';
export const PRODUCT_DETAILS_SECTION_ID = 'storefront-product-details';
export const BUY_PREORDER_SECTION_ID = 'storefront-buy-preorder';
export const SHIPPING_RETURNS_SECTION_ID = 'storefront-shipping-returns';
export const REVIEWS_SECTION_ID = 'storefront-reviews';
export const STORY_ABOUT_SECTION_ID = 'storefront-story-about';
export const FOOTER_SECTION_ID = 'storefront-footer';

export const SECTIONS: readonly SectionSpec[] = [
  // `application/tabs/4` + `application/tabs/5`: the wordmark (brand--name), one fixed "Shop" nav
  // link plus up to three links for the optional sections that survived (rendered dynamically;
  // see `render.ts`'s `renderHeader` — capped at four total, since a one-page site's nav is a
  // table of contents, not a full site map), and one buy call to action.
  // G5 round 2: the featured-product nav link's label used to be a model-writable `links` field
  // whose text a live fill could change (e.g. to "Shipping") while the anchor still silently
  // pointed at the product section — a label that no longer named its own destination. The label
  // is now the same fixed, non-model "Shop" every reference build has always shown (`render.ts`'s
  // `FEATURED_NAV_LABEL`), matching every other nav entry's `NAV_LABELS` pattern.
  { id: HEADER_SECTION_ID, type: 'header', text: [{ name: 'cta', max: 32 }] },
  // `marketing/sections/4`: eyebrow, heading, body. No hero CTA — the buy/preorder section below
  // is the one honest call to action; a second hero button would either repeat it or invent one.
  // `hero.body` is this page's one-line pitch — the label and what it makes, never a list of
  // every product and price (that is the featured-product and collection-grid sections' own
  // job). Its 140-character bound is deliberately too short to enumerate a catalog. It,
  // `featured-product.description`, `story-about.body` and `footer.tagline` are four separately
  // model-authored free-text fields covering overlapping ground (what the label makes, why it's
  // worth buying, who makes it); the fast lane must give each its own distinct wording, never
  // repeat the same sentence or founding fact verbatim across two of them. `render.test.ts`'s
  // duplicate-fact test checks this on the reference fixture.
  { id: HERO_SECTION_ID, type: 'hero', text: [{ name: 'eyebrow', max: 40 }, { name: 'heading', max: 72 }, { name: 'body', max: 140 }] },
  // `marketing/pricing/1` card layout, repurposed as the one anchor product: name, description
  // and a nullable price so the fast lane never invents one.
  {
    id: FEATURED_PRODUCT_SECTION_ID, type: 'featured-product',
    text: [{ name: 'heading', max: 60 }, { name: 'name', max: 60 }, { name: 'description', max: 200 }, { name: 'price', max: 24, atom: 'plain', verify: 'traceable' }],
  },
  // `marketing/feature-grids/3`: the rest of a short catalog. Optional — a single-product brief
  // (a preorder drop, one SKU) has nothing to grid.
  {
    id: COLLECTION_GRID_SECTION_ID, type: 'collection-grid',
    text: [{ name: 'heading', max: 60 }],
    items: { count: 4, fields: [{ name: 'name', max: 48 }, { name: 'blurb', max: 64 }, { name: 'price', max: 24, atom: 'plain', verify: 'traceable' }] },
    optional: {
      label: 'collection grid',
      dropWhen: 'The brief names fewer than four more products beyond the featured one (including one product or SKU only). This section takes exactly four items and never pads with an invented product to reach that count, so a catalog of two or three extra products still drops the grid.',
      keepWhen: 'The brief names four or more real products beyond the featured one; only the first four are shown, never fewer than four and never a fabricated one to fill the rest.',
    },
  },
  // `application/details-list/1`: material, sizing, care or origin rows. Optional — many briefs
  // give a name and a price and nothing else about the piece itself.
  {
    id: PRODUCT_DETAILS_SECTION_ID, type: 'product-details',
    text: [{ name: 'heading', max: 60 }],
    // `label` stays a plain, untraced category name ("Material", "Made in", "Care") — a row's own
    // fact lives in `value`, which IS traced; the label just names the KIND of fact and does not
    // need to be a word the brief itself used (a round-11 audit pass, item A, found the reference
    // fixture's own "Care" label — a normal category header — has no brief support at all, since
    // rich.txt never uses that word, and marking it traceable false-flagged an honest fixture).
    // `min: 1` (2026-10-10, R2): a brief rarely states three product details; an unsupported row is dropped.
    items: { count: 3, min: 1, drop: true, fields: [{ name: 'label', max: 24 }, { name: 'value', max: 60, verify: 'traceable' }] },
    optional: {
      label: 'product details',
      dropWhen: 'The brief gives no material, sizing, care or origin facts about the product.',
      keepWhen: 'The brief states real material, sizing, care or origin facts.',
    },
  },
  // `marketing/ctas/1`: the one required action. `url`, `phone` and `email` are all nullable —
  // see the module doc above and `render.ts`'s `renderBuyPreorder` for the honest-destination
  // fallback order (url, then phone, then email, then plain text — never a dead "#" link).
  // `body` is NOT marked `verify: 'traceable'` (a round-11 audit pass, item A, considered and
  // rejected it): unlike shipping-returns' body, this section is REQUIRED and never nullable, so
  // a brief with nothing to say about stock or availability still forces the model to write
  // SOMETHING here, and full word-tracing has no legal escape for that case the way an optional
  // or nullable slot does. A stock/availability claim actually stated here is still caught by the
  // sentence-level claim-bearing check (`jev.ts`'s `deterministicSentenceClaimFlags`, item B) —
  // neutral fallback prose with no claim signal at all never trips it.
  {
    id: BUY_PREORDER_SECTION_ID, type: 'buy-preorder',
    text: [
      { name: 'heading', max: 60 }, { name: 'body', max: 200 }, { name: 'ctaLabel', max: 32 },
      { name: 'url', max: 300, atom: 'url' }, { name: 'phone', max: 40, atom: 'phone' }, { name: 'email', max: 80, atom: 'email' },
    ],
  },
  // `marketing/sections/1`: shipping, returns or preorder-timing facts. Optional — a brief that
  // states no policy gets no invented one.
  {
    // `heading` is neutral chrome ("Shipping and returns"), never a promotional adjective the
    // brief did not supply ("Fast", "Easy") — a heading is not the place to make a claim. Marked
    // `label: true` so template-chrome.ts's existing x-label exemption covers it when the fill
    // leaves it exactly as the reference wrote it (see FieldSpec's own docblock on `label`).
    id: SHIPPING_RETURNS_SECTION_ID, type: 'shipping-returns',
    text: [{ name: 'heading', max: 60, label: true }, { name: 'body', max: 280, verify: 'traceable' }],
    optional: {
      label: 'shipping and returns',
      dropWhen: 'The brief states no shipping, delivery, preorder-timing or returns policy.',
      keepWhen: 'The brief states a real shipping, delivery, preorder-timing or returns policy.',
    },
  },
  // `marketing/testimonials/3`: optional, a new drop or a made-to-order run often has no
  // reviews yet.
  {
    // No `title`/heading per review: a short editorial tagline over a quote is the model's own
    // invented summary, not a fact the brief stated — the exact "True to the photos" defect a
    // review of a live build found. Showing only the quote itself (plus an honest attribution)
    // cannot invent a heading, because there is no heading slot to invent one into.
    id: REVIEWS_SECTION_ID, type: 'reviews',
    text: [{ name: 'heading', max: 60 }],
    items: { count: 2, fields: [{ name: 'quote', max: 240, verify: 'quote' }, { name: 'name', max: 60, atom: 'person-name' }] },
    optional: {
      label: 'customer reviews',
      dropWhen: 'The brief carries no buyer reviews or quotes to show.',
      keepWhen: 'The brief supplies real reviews from buyers (at least a quote).',
    },
  },
  // `marketing/sections/3`: the maker, brand or label's own story. Optional — distinct variant
  // from shipping-returns above so the two plain-text sections are not visually identical.
  {
    id: STORY_ABOUT_SECTION_ID, type: 'story-about',
    text: [{ name: 'heading', max: 60 }, { name: 'body', max: 280 }],
    optional: {
      label: 'story or about',
      dropWhen: 'The brief gives no maker, brand or label story to tell.',
      keepWhen: 'The brief states a real founding, maker or brand story.',
    },
  },
  // `marketing/footers/4`: tagline and nullable contact facts so the footer never states a phone
  // number, email or address the brief did not give. G8 dry run: the footer's three link labels
  // used to be a model-writable `links` list; a live Cerebras fill wrote "Shipping", a label that
  // named no section on the page, and the commercial-word gate (rightly) refused it. The footer
  // now lists the page's own sections with the same fixed labels as the header nav
  // (`render.ts`'s `NAV_LABELS`), so no fill can write a footer link label at all.
  {
    id: FOOTER_SECTION_ID, type: 'footer',
    text: [
      { name: 'tagline', max: 120 },
      { name: 'phone', max: 40, atom: 'phone' }, { name: 'email', max: 80, atom: 'email' }, { name: 'address', max: 120, atom: 'address' },
    ],
  },
];

export const SECTION_ORDER = SECTIONS.map((section) => section.id);

/** The nullable string leaves, by section id and field: facts a brief may not state. */
export const STOREFRONT_NULLABLE_ATOMS: Readonly<Record<string, Readonly<Record<string, AtomKind>>>> = Object.fromEntries(
  SECTIONS.flatMap((section) => {
    const atoms = section.text.filter((field) => field.atom).map((field) => [field.name, field.atom!] as const);
    return atoms.length > 0 ? [[section.id, Object.fromEntries(atoms)]] : [];
  }),
);

/** Section types a brief may give nothing for: the whole slot in `sections` may be `null`. */
export const STOREFRONT_OPTIONAL_SECTIONS: ReadonlySet<string> = new Set(SECTIONS.filter((section) => section.optional).map((section) => section.type));
