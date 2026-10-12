/**
 * storefront family — executable recipe contract.
 *
 * Validates at the JSON boundary by walking `SECTIONS` (slots.ts) and returns only the fields the
 * renderer understands. It refuses: an unknown field anywhere, a wrong schema version or family,
 * a bad revision, a missing, misplaced or malformed section, a text slot carrying markup or a
 * control character, a text slot over its bound, a wrong repeat count, a malformed email, phone
 * number or url, and a `null` anywhere but a nullable atom or an optional section's own slot.
 *
 * `recipeSchema()` derives the JSON schema from the same specs; `render.test.ts` checks it equals
 * the committed `recipe.schema.json`, so the two can never drift.
 */

import { isDroppedOptional } from '../../sections.ts';
import {
  BRAND_SLOTS, FAMILY_ID, SCHEMA_VERSION, SECTIONS, STOREFRONT_OPTIONAL_SECTIONS,
  type FieldSpec, type SectionSpec, type TextSlot,
} from './slots.ts';
export { STOREFRONT_NULLABLE_ATOMS, STOREFRONT_OPTIONAL_SECTIONS } from './slots.ts';

export type FieldValue = string | string[] | null;
export type StorefrontItem = Record<string, FieldValue>;
export type StorefrontSection = { id: string; type: string; text: Record<string, FieldValue>; items?: StorefrontItem[] };
export type StorefrontRecipe = {
  schemaVersion: 2;
  family: 'storefront';
  revision: number;
  brand: { name: string; descriptor: string };
  /** In `SECTIONS` order; an optional section's slot is `null` when the page drops it. */
  sections: (StorefrontSection | null)[];
};

const CONTROL = new RegExp('[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]');
const MARKUP = /[<>]|&(?:[a-z][a-z0-9]{1,31}|#[0-9]{1,7}|#x[0-9a-f]{1,6});/i;
/** A raw URL spelled out in prose (a bare domain or scheme) belongs only in the one `url` atom
 * this family declares (`buy-preorder.url`), where it becomes a real link's href; anywhere else
 * it is dead text a visitor cannot click, and a page that prints "preorder at
 * example.com/drop" beside a working Buy button reads as though the compiler forgot to link it.
 * `field()` skips this check for the url atom itself. */
const BARE_URL = /https?:\/\/\S+|\b[a-z0-9-]+\.(?:com|net|org|shop|store|example)\b/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** A storefront destination: `http://` or `https://`, host non-empty, no whitespace or control
 * characters anywhere in the value (already refused by `plainText` before this runs). Never a
 * bare domain or a `mailto:`/`tel:` scheme — those are the separate `phone`/`email` atoms. */
const URL = /^https?:\/\/[^\s/?#]+(?:[/?#]\S*)?$/i;

const PHONE_SEPARATOR_TOKENS = [' (', ') ', ')-', ' ', '.', '-', '(', ')'];

/** A phone number, checked by tokenizing rather than by one regular expression — see
 * `agency-restaurant`'s `contract.ts` for the full rationale; this is the same routine. */
function isPhoneNumber(text: string): boolean {
  const body = text.startsWith('+') ? text.slice(1) : text;
  if (body.length === 0) return false;
  let index = 0;
  let digits = 0;
  let sawDigitRun = false;
  let precededBySeparator = false;
  let opens = 0;
  let closes = 0;
  let openBeforeClose = true;
  while (index < body.length) {
    if (body[index]! >= '0' && body[index]! <= '9') {
      const start = index;
      while (index < body.length && body[index]! >= '0' && body[index]! <= '9') index += 1;
      digits += index - start;
      sawDigitRun = true;
      precededBySeparator = false;
      continue;
    }
    const token = PHONE_SEPARATOR_TOKENS.find((candidate) => body.startsWith(candidate, index));
    if (!token || precededBySeparator) return false;
    for (const char of token) {
      if (char === '(') opens += 1;
      else if (char === ')') { closes += 1; if (opens === 0) openBeforeClose = false; }
    }
    precededBySeparator = true;
    index += token.length;
  }
  return !precededBySeparator && sawDigitRun && opens <= 1 && closes <= 1 && openBeforeClose && digits >= 7 && digits <= 15;
}

function object(value: unknown, at: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new Error(`${at}: expected a plain object`);
  }
  return value as Record<string, unknown>;
}
function keys(record: Record<string, unknown>, allowed: string[], at: string): void {
  for (const key of Object.keys(record)) if (!allowed.includes(key)) throw new Error(`${at}.${key}: unknown field`);
}

function plainText(value: unknown, slot: FieldSpec, at: string): string {
  if (typeof value !== 'string') throw new Error(`${at}: expected plain text`);
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${at}: expected non-empty plain text`);
  if (trimmed.length > slot.max) throw new Error(`${at}: at most ${slot.max} characters, received ${trimmed.length}`);
  if (CONTROL.test(trimmed)) throw new Error(`${at}: control characters are not allowed in a text slot`);
  if (MARKUP.test(trimmed)) throw new Error(`${at}: markup is not allowed in a text slot`);
  // Only checked on genuinely free-form fields (no `x-atom` of any kind): url/email/phone/address
  // atoms already carry their own dedicated format checks and legitimately hold domain-shaped
  // text (an email's own domain, a supplied url).
  if (!slot.atom && BARE_URL.test(trimmed)) throw new Error(`${at}: a URL belongs only in the buy-preorder url slot, never spelled out in prose`);
  return trimmed;
}

function field(value: unknown, spec: FieldSpec, at: string): FieldValue {
  if (value === undefined) throw new Error(`${at}: required text slot is missing`);
  if (spec.list !== undefined) {
    if (!Array.isArray(value) || value.length !== spec.list) throw new Error(`${at}: expected exactly ${spec.list} items`);
    return value.map((raw, index) => plainText(raw, spec, `${at}[${index}]`));
  }
  if (value === null) {
    if (spec.atom) return null;
    throw new Error(`${at}: expected plain text`);
  }
  const text = plainText(value, spec, at);
  if (spec.atom === 'email' && !EMAIL.test(text)) throw new Error(`${at}: expected an email address`);
  if (spec.atom === 'phone' && !isPhoneNumber(text)) throw new Error(`${at}: expected a phone number`);
  if (spec.atom === 'url' && !URL.test(text)) throw new Error(`${at}: expected an http:// or https:// url`);
  // 'address' carries no format check beyond plainText's bounds, matching every other page-kind
  // family's address atom. 'plain' (the product price atom) is likewise text-only: no currency or
  // format is enforced, since the fast lane never invents a price and only ever carries one
  // through from the brief.
  return text;
}

function fields(value: unknown, specs: FieldSpec[], at: string): Record<string, FieldValue> {
  const record = object(value, at);
  keys(record, specs.map((spec) => spec.name), at);
  const out: Record<string, FieldValue> = {};
  for (const spec of specs) out[spec.name] = field(record[spec.name], spec, `${at}.${spec.name}`);
  return out;
}

/**
 * A legacy field this family used to carry, stripped on parse rather than rejected, so a recipe
 * saved before the field was removed still compiles (G5 round 3): the featured-product nav
 * label's `header.text.links` (a model-writable array) was replaced with the fixed
 * `FEATURED_NAV_LABEL` in `render.ts` — the renderer never reads `header.text.links` any more, so
 * an old recipe that still carries it is stripped, never rendered, rather than refused outright.
 */
const LEGACY_TEXT_FIELDS: Readonly<Record<string, readonly string[]>> = {
  header: ['links'],
  // G8 dry run: the footer's model-writable `links` became fixed section labels (`render.ts`'s
  // `renderFooter`), the same move G5 made for the header.
  footer: ['links'],
};

function section(value: unknown, spec: SectionSpec, at: string): StorefrontSection {
  const record = object(value, at);
  keys(record, spec.items ? ['id', 'type', 'text', 'items'] : ['id', 'type', 'text'], at);
  if (record.id !== spec.id) throw new Error(`${at}.id: expected "${spec.id}"`);
  if (record.type !== spec.type) throw new Error(`${at}.type: expected "${spec.type}"`);
  const rawText = object(record.text, `${at}.text`);
  for (const legacyField of LEGACY_TEXT_FIELDS[spec.type] ?? []) delete rawText[legacyField];
  const out: StorefrontSection = { id: spec.id, type: spec.type, text: fields(rawText, spec.text, `${at}.text`) };
  if (spec.items) {
    const { count, fields: itemFields } = spec.items;
    const min = spec.items.min ?? count;
    if (!Array.isArray(record.items) || record.items.length < min || record.items.length > count) {
      throw new Error(min === count ? `${at}.items: expected exactly ${count} items` : `${at}.items: expected ${min} to ${count} items`);
    }
    out.items = record.items.map((raw, index) => fields(raw, itemFields, `${at}.items[${index}]`));
  }
  return out;
}

/** Validate a storefront recipe. Throws an Error naming the offending field. */
export function parseStorefrontRecipe(input: unknown): StorefrontRecipe {
  const root = object(input, 'recipe');
  keys(root, ['schemaVersion', 'family', 'revision', 'brand', 'sections'], 'recipe');
  if (root.schemaVersion !== SCHEMA_VERSION) throw new Error(`recipe.schemaVersion: expected ${SCHEMA_VERSION}`);
  if (root.family !== FAMILY_ID) throw new Error(`recipe.family: expected "${FAMILY_ID}"`);
  if (typeof root.revision !== 'number' || !Number.isSafeInteger(root.revision) || root.revision < 1 || root.revision > 9999) {
    throw new Error('recipe.revision: expected a positive integer from 1 to 9999');
  }
  const brandRecord = object(root.brand, 'recipe.brand');
  keys(brandRecord, BRAND_SLOTS.map((slot) => slot.name), 'recipe.brand');
  const brand = { name: '', descriptor: '' };
  for (const slot of BRAND_SLOTS) {
    if (brandRecord[slot.name] === undefined) throw new Error(`recipe.brand.${slot.name}: required text slot is missing`);
    brand[slot.name as keyof typeof brand] = plainText(brandRecord[slot.name], slot, `recipe.brand.${slot.name}`);
  }
  if (!Array.isArray(root.sections) || root.sections.length !== SECTIONS.length) throw new Error(`recipe.sections: expected exactly ${SECTIONS.length} sections`);
  const sections = SECTIONS.map((spec, index) => {
    const raw = (root.sections as unknown[])[index];
    return isDroppedOptional(raw, spec.type, STOREFRONT_OPTIONAL_SECTIONS) ? null : section(raw, spec, `sections[${index}]`);
  });
  return { schemaVersion: SCHEMA_VERSION as 2, family: FAMILY_ID as 'storefront', revision: root.revision, brand, sections };
}

// ---------------------------------------------------------------------------------------------
// The JSON schema, derived from the same specs.
// ---------------------------------------------------------------------------------------------

type Schema = { [key: string]: unknown };
const text = (max: number): Schema => ({ type: 'string', minLength: 1, maxLength: max });

function fieldSchema(spec: FieldSpec): Schema {
  // `x-label` marks template chrome (a nav link, a fixed neutral heading) — see FieldSpec's own
  // docblock on `label` and template-chrome.ts's exemption that reads this marker.
  const label = spec.label ? { 'x-label': true } : {};
  // `x-verify: 'quote'`/`'traceable'` marks a slot the shared deterministic checker traces against
  // the brief in addition to Jev — see spine.ts's `quotePathsFor`/`traceablePathsFor` and jev.ts's
  // `deterministicQuoteFlags`/`deterministicTraceableFlags`. Computed once, ahead of the `atom`
  // branch below (a round-11 audit pass fix, item A): a nullable atom such as `price` still needs
  // `x-verify` on it when the brief DOES supply a value, and the original `atom` branch returned
  // before this line ever ran, so a `verify` alongside an `atom` was silently dropped.
  const verify = spec.verify ? { 'x-verify': spec.verify } : {};
  if (spec.list !== undefined) return { type: 'array', ...label, minItems: spec.list, maxItems: spec.list, items: text(spec.max) };
  if (spec.atom) return { type: ['string', 'null'], 'x-atom': spec.atom, minLength: 1, maxLength: spec.max, ...verify };
  if (spec.verify) return { ...text(spec.max), ...verify };
  return { ...text(spec.max), ...label };
}

function objectSchema(specs: FieldSpec[]): Schema {
  return {
    type: 'object', additionalProperties: false, required: specs.map((spec) => spec.name),
    properties: Object.fromEntries(specs.map((spec) => [spec.name, fieldSchema(spec)])),
  };
}

function sectionSchema(spec: SectionSpec): Schema {
  const required = spec.items ? ['id', 'type', 'text', 'items'] : ['id', 'type', 'text'];
  return {
    type: spec.optional ? ['object', 'null'] : 'object',
    ...(spec.optional ? { 'x-optional': { ...spec.optional, navSlots: [] } } : {}),
    additionalProperties: false,
    required,
    properties: {
      id: { const: spec.id },
      type: { const: spec.type },
      text: objectSchema(spec.text),
      ...(spec.items ? { items: { type: 'array', minItems: spec.items.min ?? spec.items.count, maxItems: spec.items.count, ...(spec.items.drop ? { 'x-drop': 'items' } : {}), items: objectSchema(spec.items.fields) } } : {}),
    },
  };
}

/** The recipe's JSON schema, as committed in `recipe.schema.json`. */
export function recipeSchema(): Schema {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `https://github.com/ZeroSum-Solutions/mish/schemas/agency-site/${FAMILY_ID}/recipe.v2.json`,
    title: `${FAMILY_ID} recipe`,
    description: 'A retail storefront page kind (atlas CO.01): header, hero, one featured product, an optional short collection grid, optional product details, a required buy-or-preorder step whose destination is honest to the brief, optional shipping and returns, optional reviews, optional story or about, and a footer. Derived from compiler/scripts/families/storefront/slots.ts by contract.ts recipeSchema(); render.test.ts checks the two are equal.',
    $comment: 'contract.ts additionally enforces markup-free plain text, email, phone and url formats on the nullable atoms, and that a null appears only on an x-atom string leaf or in an x-optional section slot.',
    type: 'object',
    additionalProperties: false,
    required: ['schemaVersion', 'family', 'revision', 'brand', 'sections'],
    sectionOrder: SECTIONS.map((spec) => spec.id),
    properties: {
      schemaVersion: { const: SCHEMA_VERSION },
      family: { const: FAMILY_ID },
      revision: { type: 'integer', minimum: 1, maximum: 9999 },
      brand: objectSchema(BRAND_SLOTS),
      sections: { type: 'array', minItems: SECTIONS.length, maxItems: SECTIONS.length, items: false, prefixItems: SECTIONS.map(sectionSchema) },
    },
  };
}
