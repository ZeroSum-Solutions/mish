/**
 * practice family — executable recipe contract.
 *
 * Validates at the JSON boundary by walking `SECTIONS` (slots.ts) and returns only the fields the
 * renderer understands. It refuses: an unknown field anywhere, a wrong schema version or family,
 * a bad revision, a missing, misplaced or malformed section, a text slot carrying markup or a
 * control character, a text slot over its bound, a wrong repeat count, a malformed email, phone
 * or book destination, and a `null` anywhere but a nullable atom or an optional section's own
 * slot.
 *
 * `recipeSchema()` derives the JSON schema from the same specs; `render.test.ts` checks it equals
 * the committed `recipe.schema.json`, so the two can never drift.
 */

import { isDroppedOptional } from '../../sections.ts';
import {
  BRAND_SLOTS, FAMILY_ID, PRACTICE_OPTIONAL_SECTIONS, SCHEMA_VERSION, SECTIONS,
  type FieldSpec, type SectionSpec, type TextSlot,
} from './slots.ts';
export { PRACTICE_NULLABLE_ATOMS, PRACTICE_OPTIONAL_SECTIONS } from './slots.ts';

export type FieldValue = string | string[] | null;
export type PracticeItem = Record<string, FieldValue>;
export type PracticeSection = { id: string; type: string; text: Record<string, FieldValue>; items?: PracticeItem[] };
export type PracticeRecipe = {
  schemaVersion: 2;
  family: 'practice';
  revision: number;
  brand: { name: string; descriptor: string };
  /** In `SECTIONS` order; an optional section's slot is `null` when the page drops it. */
  sections: (PracticeSection | null)[];
};

const CONTROL = new RegExp('[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]');
const MARKUP = /[<>]|&(?:[a-z][a-z0-9]{1,31}|#[0-9]{1,7}|#x[0-9a-f]{1,6});/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/**
 * A telephone number as people write it: an optional leading `+`, then digits, spaces, dots,
 * hyphens and parentheses; 7-20 characters with at least 7 digits. Accepts US `(828) 555-0135`
 * and `828-555-0135` and international `+44 20 7946 0958`.
 */
const PHONE = /^\+?[0-9 ().-]+$/;
export function isPhoneNumber(text: string): boolean {
  return text.length >= 7 && text.length <= 20 && PHONE.test(text) && (text.match(/[0-9]/g)?.length ?? 0) >= 7;
}
/**
 * A well-formed `http(s)://` URL: scheme required (a scheme-less string such as `acme.com/book`
 * is rejected — render.ts must never guess a scheme for a destination it turns into a live link),
 * a dotted host of at least two labels, an optional port, and an optional path/query/fragment
 * with no whitespace. Deliberately stricter than a general-purpose URL parser: the book
 * destination is a link a visitor clicks, not free text, so a bare word or a stray `@` must fail
 * this the same way it fails `EMAIL`/`isPhoneNumber` above.
 */
const BOOKABLE_URL = /^https?:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+(?::[0-9]{1,5})?(?:\/\S*)?$/i;
export function isBookableUrl(text: string): boolean {
  return BOOKABLE_URL.test(text);
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

function plainText(value: unknown, slot: TextSlot, at: string): string {
  if (typeof value !== 'string') throw new Error(`${at}: expected plain text`);
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${at}: expected non-empty plain text`);
  if (trimmed.length > slot.max) throw new Error(`${at}: at most ${slot.max} characters, received ${trimmed.length}`);
  if (CONTROL.test(trimmed)) throw new Error(`${at}: control characters are not allowed in a text slot`);
  if (MARKUP.test(trimmed)) throw new Error(`${at}: markup is not allowed in a text slot`);
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
  if (spec.atom === 'phone' && !isPhoneNumber(text)) throw new Error(`${at}: expected a phone number (digits, spaces, dots, hyphens, parentheses and an optional leading +; 7-20 characters)`);
  // 'destination' (the book section's `destination` field, x-atom: 'destination'): must be an
  // exact URL, email, or phone shape — never prose, a scheme-less domain, or a stray `@` — since
  // render.ts turns this straight into a live `tel:`/`mailto:`/`https:` link. Whether it also
  // appears in the brief is a separate, deterministic check (`jev.ts`'s
  // `deterministicDestinationFlags`, driven by this same field's `x-verify: 'destination'`); this
  // check only guarantees the text is well-formed enough to be a real destination at all.
  if (spec.atom === 'destination' && !(EMAIL.test(text) || isPhoneNumber(text) || isBookableUrl(text))) {
    throw new Error(`${at}: expected a URL, email address, or phone number`);
  }
  // 'address' (x-atom: 'address') carries no format check beyond plainText's bounds above: it is
  // a nullable fact only, the same as every other page-kind family's address atom — none validate
  // street-address shape, since there is no single reliable pattern across countries. 'plain'
  // (insurance and pricing) is likewise text-only.
  return text;
}

function fields(value: unknown, specs: FieldSpec[], at: string): Record<string, FieldValue> {
  const record = object(value, at);
  keys(record, specs.map((spec) => spec.name), at);
  const out: Record<string, FieldValue> = {};
  for (const spec of specs) out[spec.name] = field(record[spec.name], spec, `${at}.${spec.name}`);
  return out;
}

function section(value: unknown, spec: SectionSpec, at: string): PracticeSection {
  const record = object(value, at);
  keys(record, spec.items ? ['id', 'type', 'text', 'items'] : ['id', 'type', 'text'], at);
  if (record.id !== spec.id) throw new Error(`${at}.id: expected "${spec.id}"`);
  if (record.type !== spec.type) throw new Error(`${at}.type: expected "${spec.type}"`);
  const out: PracticeSection = { id: spec.id, type: spec.type, text: fields(record.text, spec.text, `${at}.text`) };
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

/** Validate a practice recipe. Throws an Error naming the offending field. */
export function parsePracticeRecipe(input: unknown): PracticeRecipe {
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
    return isDroppedOptional(raw, spec.type, PRACTICE_OPTIONAL_SECTIONS) ? null : section(raw, spec, `sections[${index}]`);
  });
  return { schemaVersion: SCHEMA_VERSION as 2, family: FAMILY_ID as 'practice', revision: root.revision, brand, sections };
}

// ---------------------------------------------------------------------------------------------
// The JSON schema, derived from the same specs.
// ---------------------------------------------------------------------------------------------

type Schema = { [key: string]: unknown };
const text = (max: number): Schema => ({ type: 'string', minLength: 1, maxLength: max });

function fieldSchema(spec: FieldSpec): Schema {
  const label = spec.label ? { 'x-label': true } : {};
  if (spec.list !== undefined) return { type: 'array', ...label, minItems: spec.list, maxItems: spec.list, items: text(spec.max) };
  // `verify: 'destination'` always pairs with an `atom` (`'destination'` on the book section's own
  // field, or `'phone'`/`'email'` on a fallback atom hours-location/footer also render as a live
  // link — see slots.ts's `FieldSpec` doc): nullable like any other atom, but ALSO carries
  // `x-verify: 'destination'` on the same node so the shared fast lane's deterministic
  // destination-tracing gate (`jev.ts`'s `deterministicDestinationFlags`) can find it — unlike
  // `personName`/`verify: 'quote'` below, this is the one case a field needs both markers at
  // once, so it is checked before the plain `spec.atom` branch would otherwise return early
  // without the verify keyword.
  if (spec.atom && spec.verify === 'destination') return { type: ['string', 'null'], 'x-atom': spec.atom, 'x-verify': spec.verify, minLength: 1, maxLength: spec.max };
  if (spec.atom) return { type: ['string', 'null'], 'x-atom': spec.atom, minLength: 1, maxLength: spec.max };
  // `personName`: required (never nullable) — see slots.ts's FieldSpec doc. `x-atom: 'person-name'`
  // drives the shared fast lane's deterministic attribution gate; the field otherwise validates
  // exactly like any other required plain-text slot.
  if (spec.personName) return { ...text(spec.max), 'x-atom': 'person-name' };
  // `verify: 'quote'`: required (never nullable) — see slots.ts's FieldSpec doc. `x-verify:
  // 'quote'` drives the shared fast lane's deterministic quote-tracing gate.
  if (spec.verify === 'quote') return { ...text(spec.max), 'x-verify': 'quote' };
  // `verify: 'hours-label'`: required (never nullable) — see slots.ts's FieldSpec doc. `x-verify:
  // 'hours-label'` drives the shared fast lane's deterministic day-label gate. Deliberately NOT
  // also `x-label`: a day/day-range is a fact, not UI chrome, and must never skip the
  // faithfulness gate just because it happens to be short and digit-free (round-4 Grok audit).
  if (spec.verify === 'hours-label') return { ...text(spec.max), 'x-verify': 'hours-label', ...(spec.hoursValue ? { 'x-hours-value': spec.hoursValue } : {}), ...(spec.hoursGroup ? { 'x-hours-group': spec.hoursGroup } : {}) };
  // `verify: 'traceable'`: required (never nullable) — see slots.ts's FieldSpec doc. `x-verify:
  // 'traceable'` drives the shared fast lane's deterministic word-tracing gate (`jev.ts`'s
  // `deterministicTraceableFlags`), the same SHARED marker `agency-storefront` adopted first.
  if (spec.verify === 'traceable') return { ...text(spec.max), 'x-verify': 'traceable' };
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
    ...(spec.optional ? { 'x-optional': { ...spec.optional, navSlots: spec.optional.navSlots ?? [] } } : {}),
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
    $id: `https://mish.invalid/schemas/agency-site/${FAMILY_ID}/recipe.v2.json`,
    title: `${FAMILY_ID} recipe`,
    description: 'A local clinical or appointment practice page kind (atlas TL.01, TL.02): header, hero, services or treatments, provider credentials, what to expect, a book call, optional reviews, insurance or pricing, FAQ, and hours and location, and a footer. Derived from compiler/scripts/families/practice/slots.ts by contract.ts recipeSchema(); render.test.ts checks the two are equal.',
    $comment: 'contract.ts additionally enforces markup-free plain text, email and phone formats on the nullable atoms, and that a null appears only on an x-atom string leaf or in an x-optional section slot.',
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

