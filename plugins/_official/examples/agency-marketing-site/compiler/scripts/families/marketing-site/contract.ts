/**
 * marketing-site family — executable recipe contract.
 *
 * Validates at the JSON boundary and returns only the fields the renderer understands. It
 * refuses: an unknown field anywhere, a wrong schema version or family, a non-positive or
 * non-integer revision, a missing or malformed section, a text slot carrying markup or a control
 * character, a text slot over its bound, and a wrong repeat count anywhere the contract does not
 * allow it.
 */

import { isDroppedOptional } from '../../sections.ts';
import {
  BRAND_SLOTS,
  CTA_SECTION_ID, CTA_SLOTS,
  FAMILY_ID,
  FEATURES_SECTION_ID, FEATURES_TEXT_SLOTS, FEATURE_COUNT, FEATURE_ITEM_SLOTS,
  FOOTER_COLUMN_COUNT, FOOTER_COLUMN_HEADING_SLOT, FOOTER_LINK_COUNT, FOOTER_LINK_SLOT,
  FOOTER_SECTION_ID, FOOTER_TEXT_SLOTS,
  HERO_SECTION_ID, HERO_SLOTS,
  MARKETING_SITE_OPTIONAL_SECTIONS,
  PRICING_FEATURE_COUNT, PRICING_FEATURE_SLOT, PRICING_SECTION_ID, PRICING_TEXT_SLOTS,
  PRICING_TIER_COUNT, PRICING_TIER_PERIOD_SLOT, PRICING_TIER_SLOTS,
  PROOF_SECTION_ID,
  SCHEMA_VERSION,
  TESTIMONIAL_COUNT, TESTIMONIAL_SLOTS,
  type TextSlot,
} from './slots.ts';
export { MARKETING_SITE_NULLABLE_ATOMS, MARKETING_SITE_OPTIONAL_SECTIONS } from './slots.ts';
export type { MarketingSiteAtomKind, MarketingSiteNullableSlot } from './slots.ts';

export type MarketingSiteFeature = { title: string; body: string };
export type MarketingSiteTestimonial = { quote: string; name: string | null; role: string };
export type MarketingSitePricingTier = { name: string; price: string; period: string; features: string[]; cta: string };
/** A footer link is `null` when the brief names no such page or service (a nullable atom): the
 * renderer omits it, and a column left with no link omits its heading too. */
export type MarketingSiteFooterColumn = { heading: string; links: (string | null)[] };

export type MarketingSiteRecipe = {
  schemaVersion: 2;
  family: 'marketing-site';
  revision: number;
  brand: { name: string; descriptor: string };
  /** `sections[2]` (testimonials) is `null` when the whole section is dropped
   * (`MARKETING_SITE_OPTIONAL_SECTIONS`), distinct from `items: null` (a nullable atom: the
   * section stub stays, only its content is absent). */
  sections: [
    { id: typeof HERO_SECTION_ID; type: 'hero'; text: { eyebrow: string; heading: string; body: string; primaryCta: string; secondaryCta: string } },
    { id: typeof FEATURES_SECTION_ID; type: 'feature-grid'; text: { heading: string; body: string }; items: MarketingSiteFeature[] },
    ({ id: typeof PROOF_SECTION_ID; type: 'testimonials'; items: MarketingSiteTestimonial[] | null }) | null,
    { id: typeof PRICING_SECTION_ID; type: 'pricing'; text: { heading: string }; items: MarketingSitePricingTier[] | null },
    { id: typeof CTA_SECTION_ID; type: 'cta'; text: { heading: string; body: string; cta: string } },
    { id: typeof FOOTER_SECTION_ID; type: 'footer'; text: { tagline: string }; items: { columns: MarketingSiteFooterColumn[] } },
  ];
};

const CONTROL = new RegExp('[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]');
const MARKUP = /[<>]|&(?:[a-z][a-z0-9]{1,31}|#[0-9]{1,7}|#x[0-9a-f]{1,6});/i;

function object(value: unknown, at: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new Error(`${at}: expected a plain object`);
  }
  return value as Record<string, unknown>;
}
function keys(record: Record<string, unknown>, allowed: string[], at: string): void {
  for (const key of Object.keys(record)) if (!allowed.includes(key)) throw new Error(`${at}.${key}: unknown field`);
}

function plainText(value: unknown, slot: TextSlot, at: string): string {
  if (typeof value !== 'string') throw new Error(`${at}: expected plain text`);
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${at}: expected non-empty plain text`);
  if (trimmed.length > slot.max) throw new Error(`${at}: at most ${slot.max} characters, received ${trimmed.length}`);
  if (CONTROL.test(trimmed)) throw new Error(`${at}: control characters are not allowed in a text slot`);
  if (MARKUP.test(trimmed)) throw new Error(`${at}: markup is not allowed in a text slot`);
  return trimmed;
}

function textGroup(value: unknown, slots: TextSlot[], at: string): Record<string, string> {
  const record = object(value, at);
  keys(record, slots.map((slot) => slot.name), at);
  const out: Record<string, string> = {};
  for (const slot of slots) {
    if (record[slot.name] === undefined) throw new Error(`${at}.${slot.name}: required text slot is missing`);
    out[slot.name] = plainText(record[slot.name], slot, `${at}.${slot.name}`);
  }
  return out;
}

function stringArray(value: unknown, count: number, slot: TextSlot, at: string): string[] {
  if (!Array.isArray(value) || value.length !== count) throw new Error(`${at}: expected exactly ${count} items`);
  return value.map((raw, index) => plainText(raw, slot, `${at}[${index}]`));
}

function heroSection(value: unknown, at: string): MarketingSiteRecipe['sections'][0] {
  const record = object(value, at);
  keys(record, ['id', 'type', 'text'], at);
  if (record.id !== HERO_SECTION_ID) throw new Error(`${at}.id: expected "${HERO_SECTION_ID}"`);
  if (record.type !== 'hero') throw new Error(`${at}.type: expected "hero"`);
  const text = textGroup(record.text, HERO_SLOTS, `${at}.text`) as unknown as MarketingSiteRecipe['sections'][0]['text'];
  return { id: HERO_SECTION_ID, type: 'hero', text };
}

function featureItem(value: unknown, at: string): MarketingSiteFeature {
  return textGroup(value, FEATURE_ITEM_SLOTS, at) as unknown as MarketingSiteFeature;
}

function featuresSection(value: unknown, at: string): MarketingSiteRecipe['sections'][1] {
  const record = object(value, at);
  keys(record, ['id', 'type', 'text', 'items'], at);
  if (record.id !== FEATURES_SECTION_ID) throw new Error(`${at}.id: expected "${FEATURES_SECTION_ID}"`);
  if (record.type !== 'feature-grid') throw new Error(`${at}.type: expected "feature-grid"`);
  const text = textGroup(record.text, FEATURES_TEXT_SLOTS, `${at}.text`) as unknown as { heading: string; body: string };
  if (!Array.isArray(record.items) || record.items.length !== FEATURE_COUNT) throw new Error(`${at}.items: expected exactly ${FEATURE_COUNT} items`);
  const items = record.items.map((raw, index) => featureItem(raw, `${at}.items[${index}]`));
  return { id: FEATURES_SECTION_ID, type: 'feature-grid', text, items };
}

/**
 * `name` is a nullable `x-atom: 'person-name'` (G5 FIX): a quote the brief attributes to no one
 * cannot honestly be filled with an invented name, so this field alone may be `null` — every
 * other testimonial field (`quote`, `role`) stays required plain text via the generic
 * `textGroup`.
 */
function testimonialItem(value: unknown, at: string): MarketingSiteTestimonial {
  const record = object(value, at);
  keys(record, TESTIMONIAL_SLOTS.map((slot) => slot.name), at);
  const nameSlot = TESTIMONIAL_SLOTS.find((slot) => slot.name === 'name')!;
  if (record.name === undefined) throw new Error(`${at}.name: required text slot is missing`);
  const name = record.name === null ? null : plainText(record.name, nameSlot, `${at}.name`);
  const rest = textGroup({ quote: record.quote, role: record.role }, TESTIMONIAL_SLOTS.filter((slot) => slot.name !== 'name'), at);
  return { ...rest, name } as unknown as MarketingSiteTestimonial;
}

function proofSection(value: unknown, at: string): MarketingSiteRecipe['sections'][2] {
  const record = object(value, at);
  keys(record, ['id', 'type', 'items'], at);
  if (record.id !== PROOF_SECTION_ID) throw new Error(`${at}.id: expected "${PROOF_SECTION_ID}"`);
  if (record.type !== 'testimonials') throw new Error(`${at}.type: expected "testimonials"`);
  if (record.items === null) return { id: PROOF_SECTION_ID, type: 'testimonials', items: null };
  if (!Array.isArray(record.items) || record.items.length !== TESTIMONIAL_COUNT) throw new Error(`${at}.items: expected exactly ${TESTIMONIAL_COUNT} items, or null`);
  const items = record.items.map((raw, index) => testimonialItem(raw, `${at}.items[${index}]`));
  return { id: PROOF_SECTION_ID, type: 'testimonials', items };
}

function pricingTier(value: unknown, at: string): MarketingSitePricingTier {
  const record = object(value, at);
  const names = [...PRICING_TIER_SLOTS.map((slot) => slot.name), PRICING_TIER_PERIOD_SLOT.name, 'features'];
  keys(record, names, at);
  const tier: Record<string, unknown> = {};
  for (const slot of PRICING_TIER_SLOTS) {
    if (record[slot.name] === undefined) throw new Error(`${at}.${slot.name}: required text slot is missing`);
    tier[slot.name] = plainText(record[slot.name], slot, `${at}.${slot.name}`);
  }
  if (record[PRICING_TIER_PERIOD_SLOT.name] === undefined) throw new Error(`${at}.${PRICING_TIER_PERIOD_SLOT.name}: required text slot is missing`);
  tier.period = plainText(record[PRICING_TIER_PERIOD_SLOT.name], PRICING_TIER_PERIOD_SLOT, `${at}.${PRICING_TIER_PERIOD_SLOT.name}`);
  tier.features = stringArray(record.features, PRICING_FEATURE_COUNT, PRICING_FEATURE_SLOT, `${at}.features`);
  return tier as unknown as MarketingSitePricingTier;
}

function pricingSection(value: unknown, at: string): MarketingSiteRecipe['sections'][3] {
  const record = object(value, at);
  keys(record, ['id', 'type', 'text', 'items'], at);
  if (record.id !== PRICING_SECTION_ID) throw new Error(`${at}.id: expected "${PRICING_SECTION_ID}"`);
  if (record.type !== 'pricing') throw new Error(`${at}.type: expected "pricing"`);
  const text = textGroup(record.text, PRICING_TEXT_SLOTS, `${at}.text`) as unknown as { heading: string };
  if (record.items === null) return { id: PRICING_SECTION_ID, type: 'pricing', text, items: null };
  if (!Array.isArray(record.items) || record.items.length !== PRICING_TIER_COUNT) throw new Error(`${at}.items: expected exactly ${PRICING_TIER_COUNT} items, or null`);
  const items = record.items.map((raw, index) => pricingTier(raw, `${at}.items[${index}]`));
  return { id: PRICING_SECTION_ID, type: 'pricing', text, items };
}

function ctaSection(value: unknown, at: string): MarketingSiteRecipe['sections'][4] {
  const record = object(value, at);
  keys(record, ['id', 'type', 'text'], at);
  if (record.id !== CTA_SECTION_ID) throw new Error(`${at}.id: expected "${CTA_SECTION_ID}"`);
  if (record.type !== 'cta') throw new Error(`${at}.type: expected "cta"`);
  const text = textGroup(record.text, CTA_SLOTS, `${at}.text`) as unknown as { heading: string; body: string; cta: string };
  return { id: CTA_SECTION_ID, type: 'cta', text };
}

function footerColumn(value: unknown, at: string): MarketingSiteFooterColumn {
  const record = object(value, at);
  keys(record, ['heading', 'links'], at);
  if (record.heading === undefined) throw new Error(`${at}.heading: required text slot is missing`);
  const heading = plainText(record.heading, FOOTER_COLUMN_HEADING_SLOT, `${at}.heading`);
  if (!Array.isArray(record.links) || record.links.length !== FOOTER_LINK_COUNT) throw new Error(`${at}.links: expected exactly ${FOOTER_LINK_COUNT} items`);
  // A footer link is a nullable atom (MARKETING_SITE_NULLABLE_ATOMS.footerLink): null keeps its
  // position and states no page or service; a string is still bounded plain text.
  const links = record.links.map((raw, index) => (raw === null ? null : plainText(raw, FOOTER_LINK_SLOT, `${at}.links[${index}]`)));
  return { heading, links };
}

function footerSection(value: unknown, at: string): MarketingSiteRecipe['sections'][5] {
  const record = object(value, at);
  keys(record, ['id', 'type', 'text', 'items'], at);
  if (record.id !== FOOTER_SECTION_ID) throw new Error(`${at}.id: expected "${FOOTER_SECTION_ID}"`);
  if (record.type !== 'footer') throw new Error(`${at}.type: expected "footer"`);
  const text = textGroup(record.text, FOOTER_TEXT_SLOTS, `${at}.text`) as unknown as { tagline: string };
  const itemsRecord = object(record.items, `${at}.items`);
  keys(itemsRecord, ['columns'], `${at}.items`);
  if (!Array.isArray(itemsRecord.columns) || itemsRecord.columns.length !== FOOTER_COLUMN_COUNT) {
    throw new Error(`${at}.items.columns: expected exactly ${FOOTER_COLUMN_COUNT} items`);
  }
  const columns = itemsRecord.columns.map((raw, index) => footerColumn(raw, `${at}.items.columns[${index}]`));
  return { id: FOOTER_SECTION_ID, type: 'footer', text, items: { columns } };
}

/** Validate a marketing-site recipe. Throws an Error naming the offending field. */
export function parseMarketingSiteRecipe(input: unknown): MarketingSiteRecipe {
  const root = object(input, 'recipe');
  keys(root, ['schemaVersion', 'family', 'revision', 'brand', 'sections'], 'recipe');
  if (root.schemaVersion !== SCHEMA_VERSION) throw new Error(`recipe.schemaVersion: expected ${SCHEMA_VERSION}`);
  if (root.family !== FAMILY_ID) throw new Error(`recipe.family: expected "${FAMILY_ID}"`);
  if (typeof root.revision !== 'number' || !Number.isSafeInteger(root.revision) || root.revision < 1 || root.revision > 9999) {
    throw new Error('recipe.revision: expected a positive integer from 1 to 9999');
  }
  const brandRecord = object(root.brand, 'recipe.brand');
  const brand = textGroup(brandRecord, BRAND_SLOTS, 'recipe.brand') as unknown as { name: string; descriptor: string };
  if (!Array.isArray(root.sections) || root.sections.length !== 6) throw new Error('recipe.sections: expected exactly 6 sections');
  const [rawHero, rawFeatures, rawProof, rawPricing, rawCta, rawFooter] = root.sections;
  return {
    schemaVersion: SCHEMA_VERSION as 2,
    family: FAMILY_ID as 'marketing-site',
    revision: root.revision,
    brand,
    sections: [
      heroSection(rawHero, 'sections[0]'),
      featuresSection(rawFeatures, 'sections[1]'),
      isDroppedOptional(rawProof, 'testimonials', MARKETING_SITE_OPTIONAL_SECTIONS) ? null : proofSection(rawProof, 'sections[2]'),
      pricingSection(rawPricing, 'sections[3]'),
      ctaSection(rawCta, 'sections[4]'),
      footerSection(rawFooter, 'sections[5]'),
    ],
  };
}
