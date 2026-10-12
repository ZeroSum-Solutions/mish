/**
 * marketing-site family — the finite section and slot registry.
 *
 * The page kind is a fixed composition of six vendored HyperUI marketing blocks
 * (`marketing/sections/1`, `feature-grids/1`, `testimonials/1`, `pricing/1`, `ctas/1`,
 * `footers/1`; see `plugins/_official/shared/ui-kits/hyperui/`), the same "typed slots over a
 * fixed layout" shape crm-dashboard and the seven Agency Site families use. Only controlled,
 * named slots are exported here; executable rendering stays in `render.ts` and a recipe never
 * carries markup or CSS.
 *
 * No asset system: the six source blocks carry no images once vendored (Task 1 strips every
 * `<img>`), so this family has no `AssetSlot`/`DESTINATIONS` roster the way maben and watson do.
 *
 * Slot budget: the six sections carry 57 editable text slots between them (see the per-section
 * comments below). `BRAND_SLOTS` are two more reconcilable slots ON TOP of that section budget —
 * `render.ts` gives `brand.name`/`brand.descriptor` their own hidden
 * `data-od-id="brand--name"`/`"brand--descriptor"` elements, the crm-dashboard convention, so a
 * canvas edit to either is findable again. A fully populated reference fixture therefore renders
 * 59 slots in total; `render.test.ts` checks the exact count against the fixture's own content.
 */

export const FAMILY_ID = 'marketing-site';
export const SCHEMA_VERSION = 2;

export type TextSlot = { name: string; max: number };

/** Brand fields a recipe may carry. Both are plain text; there is no wordmark asset. */
export const BRAND_SLOTS: TextSlot[] = [
  { name: 'name', max: 60 },
  { name: 'descriptor', max: 200 },
];

/** `marketing-site-hero` — one hero (`marketing/sections/1`). All five fields are required. */
export const HERO_SECTION_ID = 'marketing-site-hero';
export const HERO_SLOTS: TextSlot[] = [
  { name: 'eyebrow', max: 40 },
  { name: 'heading', max: 60 },
  { name: 'body', max: 200 },
  { name: 'primaryCta', max: 32 },
  { name: 'secondaryCta', max: 32 },
];

/** `marketing-site-features` — one heading and body plus exactly three feature items
 * (`marketing/feature-grids/1`). */
export const FEATURES_SECTION_ID = 'marketing-site-features';
export const FEATURE_COUNT = 3;
export const FEATURES_TEXT_SLOTS: TextSlot[] = [
  { name: 'heading', max: 60 },
  { name: 'body', max: 200 },
];
export const FEATURE_ITEM_SLOTS: TextSlot[] = [
  { name: 'title', max: 60 },
  { name: 'body', max: 200 },
];

/** `marketing-site-proof` — exactly three testimonials when present
 * (`marketing/testimonials/1`); the whole section is a nullable atom. */
export const PROOF_SECTION_ID = 'marketing-site-proof';
export const TESTIMONIAL_COUNT = 3;
export const TESTIMONIAL_SLOTS: TextSlot[] = [
  { name: 'quote', max: 200 },
  { name: 'name', max: 60 },
  { name: 'role', max: 60 },
];

/** `marketing-site-pricing` — one heading plus exactly three pricing tiers when present
 * (`marketing/pricing/1`); the whole tier list is a nullable atom. A tier's `period` (for
 * example "/month") is a required, validated recipe field that render.ts does not give its own
 * reconcilable text slot — kept the family inside the 40-60 slot budget, the same way
 * crm-dashboard's chart `unit` field works. */
export const PRICING_SECTION_ID = 'marketing-site-pricing';
export const PRICING_TIER_COUNT = 3;
export const PRICING_FEATURE_COUNT = 3;
export const PRICING_TEXT_SLOTS: TextSlot[] = [{ name: 'heading', max: 60 }];
export const PRICING_TIER_SLOTS: TextSlot[] = [
  { name: 'name', max: 60 },
  { name: 'price', max: 16 },
  { name: 'cta', max: 32 },
];
export const PRICING_TIER_PERIOD_SLOT: TextSlot = { name: 'period', max: 16 };
export const PRICING_FEATURE_SLOT: TextSlot = { name: 'feature', max: 48 };

/** `marketing-site-cta` — one banner call to action (`marketing/ctas/1`). Required. */
export const CTA_SECTION_ID = 'marketing-site-cta';
export const CTA_SLOTS: TextSlot[] = [
  { name: 'heading', max: 60 },
  { name: 'body', max: 200 },
  { name: 'cta', max: 32 },
];

/** `marketing-site-footer` — one tagline plus exactly three link columns
 * (`marketing/footers/1`). */
export const FOOTER_SECTION_ID = 'marketing-site-footer';
export const FOOTER_COLUMN_COUNT = 3;
export const FOOTER_LINK_COUNT = 3;
export const FOOTER_TEXT_SLOTS: TextSlot[] = [{ name: 'tagline', max: 120 }];
export const FOOTER_COLUMN_HEADING_SLOT: TextSlot = { name: 'heading', max: 32 };
export const FOOTER_LINK_SLOT: TextSlot = { name: 'link', max: 32 };

export const SECTION_ORDER = [
  HERO_SECTION_ID,
  FEATURES_SECTION_ID,
  PROOF_SECTION_ID,
  PRICING_SECTION_ID,
  CTA_SECTION_ID,
  FOOTER_SECTION_ID,
] as const;
export type MarketingSiteSectionId = (typeof SECTION_ORDER)[number];

/**
 * The nullable atoms of this family, the marketing-site-specific counterpart of
 * CRM_DASHBOARD_NULLABLE_ATOMS: a fact a brief may legitimately not state, where `render.ts`
 * drops the whole fragment rather than emitting an empty one. `proof` and `pricing` null a whole
 * section's content (`sections[2].items` or `sections[3].items`); `footerLink` nulls one footer
 * link (`sections[5].items.columns[i].links[j]`), a page or service the brief never names — a
 * column left with no link drops its heading too. The kind is what the fill prompt's NULLABLE
 * block shows the model, so it names the fact: a page or service from the brief.
 */
export const MARKETING_SITE_NULLABLE_ATOMS = {
  proof: 'testimonials',
  pricing: 'pricing',
  footerLink: 'page-or-service-named-in-brief',
} as const;
export type MarketingSiteNullableSlot = keyof typeof MARKETING_SITE_NULLABLE_ATOMS;
export type MarketingSiteAtomKind = (typeof MARKETING_SITE_NULLABLE_ATOMS)[MarketingSiteNullableSlot];

/**
 * Section types a client brief may give nothing for at all. Unlike the nullable atoms above
 * (which null a section's own items but keep its `id`/`type` stub in the recipe), a section type
 * in this set may drop its whole slot in `sections` to `null` (see `../../sections.ts`): no
 * element, no `data-od-id`, no asset request. Testimonials is the one candidate — a brand-new
 * client brief often has no customer quotes yet to show as social proof.
 */
export const MARKETING_SITE_OPTIONAL_SECTIONS: ReadonlySet<string> = new Set(['testimonials']);
// The schema's `x-optional` for testimonials also carries `"requires": "quote"`: the fast lane
// drops the section without asking Jev when the brief quotes no one, since a brief that only
// asks for testimonials gives the fill nothing to quote.

/**
 * Illustrative sample-data slots, by section id: the slot names `recipe.schema.json` marks
 * `"x-mock": true`. They carry example tiers and prices, not claims about the client, so the fast lane's
 * faithfulness gate skips them — which is only honest because `render.ts` shows every section
 * that holds one under the visible caption below (`data-od-mock="illustrative-pricing"`). `render.test.ts` checks this list
 * against the schema marks, so the two cannot drift.
 */
export const MARKETING_SITE_MOCK_SLOTS: Readonly<Partial<Record<MarketingSiteSectionId, readonly string[]>>> = {
  [PRICING_SECTION_ID]: ['name', 'price', 'period', 'features', 'cta'],
};

/** The visible caption under the pricing heading. Family copy, not a locale string: the rendered
 * page is static HTML. Testimonials are deliberately NOT sample data: a quote the brief does not
 * support is a fabricated claim, so they stay fact-checked (and nullable). */
export const ILLUSTRATIVE_PRICING_CAPTION = 'Illustrative pricing';
