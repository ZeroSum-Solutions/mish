/**
 * guide family — executable recipe contract.
 *
 * Validates at the JSON boundary by walking `SECTIONS` (slots.ts) and returns only the fields the
 * renderer understands. It refuses: an unknown field anywhere, a wrong schema version or family,
 * a bad revision, a missing, misplaced or malformed section, a text slot carrying markup or a
 * control character, a text slot over its bound, a wrong repeat count, a malformed plan-a-visit
 * URL, a practical-facts row whose `label` is not its fixed category name at that exact position,
 * and a `null` anywhere but a nullable atom or an optional section's own slot.
 *
 * `recipeSchema()` derives the JSON schema from the same specs; `render.test.ts` checks it equals
 * the committed `recipe.schema.json`, so the two can never drift.
 */

import { isDroppedOptional } from '../../sections.ts';
import {
  BRAND_SLOTS, FAMILY_ID, GUIDE_OPTIONAL_SECTIONS, PRACTICAL_FACTS_LABELS, PRACTICAL_FACTS_SECTION_ID,
  SCHEMA_VERSION, SECTIONS, type FieldSpec, type SectionSpec, type TextSlot,
} from './slots.ts';
export { GUIDE_NULLABLE_ATOMS, GUIDE_OPTIONAL_SECTIONS } from './slots.ts';

export type FieldValue = string | null;
export type GuideItem = Record<string, FieldValue>;
/** An item may be `null` as a whole when its section's `items.itemAtom` is set (practical-facts:
 * a category the brief does not support drops its whole row, never a half-filled one) — see
 * `slots.ts`'s own doc on `PRACTICAL_FACTS_LABELS`. Every other family array is either fully
 * present (fixed count) or shorter (variable count via `min`), never carrying a `null` item. */
export type GuideSection = { id: string; type: string; text: Record<string, FieldValue>; items?: (GuideItem | null)[] };
export type GuideRecipe = {
  schemaVersion: 2;
  family: 'guide';
  revision: number;
  brand: { name: string; descriptor: FieldValue };
  /** In `SECTIONS` order; an optional section's slot is `null` when the page drops it. */
  sections: (GuideSection | null)[];
};

const CONTROL = new RegExp('[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]');
const MARKUP = /[<>]|&(?:[a-z][a-z0-9]{1,31}|#[0-9]{1,7}|#x[0-9a-f]{1,6});/i;
/**
 * A well-formed `http(s)://` URL: scheme required (a scheme-less string such as `example.com/x`
 * is rejected — render.ts must never guess a scheme for a link it turns into a live anchor), a
 * dotted host of at least two labels, an optional port, and an optional path/query/fragment with
 * no whitespace. The same shape `practice`'s `isBookableUrl` checks.
 */
const PLAN_URL = /^https?:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+(?::[0-9]{1,5})?(?:\/\S*)?$/i;
export function isPlanUrl(text: string): boolean {
  return PLAN_URL.test(text);
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
  if (value === null) {
    if (spec.atom) return null;
    throw new Error(`${at}: expected plain text`);
  }
  const text = plainText(value, spec, at);
  // plan-a-visit's `url` (`contactAtom: 'url'`, never nullable — see slots.ts's FieldSpec doc):
  // must be a well-formed full `http(s)://` URL — never prose, a scheme-less domain, or a stray
  // `@` — since render.ts turns this straight into a live `https:` link. Whether it also appears
  // in the brief is a separate, deterministic check (`jev.ts`'s `deterministicContactFlags`,
  // driven by this same field's `x-atom: 'url'`); this check only guarantees the text is
  // well-formed enough to be a real destination at all.
  if (spec.contactAtom === 'url' && !isPlanUrl(text)) throw new Error(`${at}: expected a URL`);
  return text;
}

function fields(value: unknown, specs: FieldSpec[], at: string): Record<string, FieldValue> {
  const record = object(value, at);
  keys(record, specs.map((spec) => spec.name), at);
  const out: Record<string, FieldValue> = {};
  for (const spec of specs) out[spec.name] = field(record[spec.name], spec, `${at}.${spec.name}`);
  return out;
}

function section(value: unknown, spec: SectionSpec, at: string): GuideSection {
  const record = object(value, at);
  keys(record, spec.items ? ['id', 'type', 'text', 'items'] : ['id', 'type', 'text'], at);
  if (record.id !== spec.id) throw new Error(`${at}.id: expected "${spec.id}"`);
  if (record.type !== spec.type) throw new Error(`${at}.type: expected "${spec.type}"`);
  const out: GuideSection = { id: spec.id, type: spec.type, text: fields(record.text, spec.text, `${at}.text`) };
  if (spec.items) {
    const { count, fields: itemFields, itemAtom } = spec.items;
    const min = spec.items.min ?? count;
    if (!Array.isArray(record.items) || record.items.length < min || record.items.length > count) {
      throw new Error(min === count ? `${at}.items: expected exactly ${count} items` : `${at}.items: expected ${min} to ${count} items`);
    }
    // `itemAtom` (practical-facts' only user): the WHOLE item may be `null` — a category the
    // brief does not support — rather than each of its leaves independently. See `slots.ts`'s
    // `SectionSpec.items` doc for why this is the shared whole-group-nullable convention
    // (`spine.ts`'s `atomKindsFor`) applied at the item's own position, not new machinery.
    out.items = record.items.map((raw, index) => (itemAtom && raw === null ? null : fields(raw, itemFields, `${at}.items[${index}]`)));
    // practical-facts' `label` is fixed chrome naming a closed category, not free model text (see
    // `slots.ts`'s own doc on this row): a PRESENT item's label must equal `PRACTICAL_FACTS_LABELS`
    // at THAT EXACT index, or the row is refused outright — this is what keeps the category
    // positions honest (an invented category name, or a real fact answered under the WRONG
    // category, both fail here) rather than merely being flagged by the faithfulness gate
    // afterward. A `null` item (the category is unsupported) has no label to check at all.
    if (spec.id === PRACTICAL_FACTS_SECTION_ID) {
      out.items.forEach((item, index) => {
        if (item === null) return;
        const expected: string = PRACTICAL_FACTS_LABELS[index] as string;
        if (item.label !== expected) throw new Error(`${at}.items[${index}].label: expected "${expected}"`);
      });
    }
  }
  return out;
}

/** Validate a guide recipe. Throws an Error naming the offending field. */
export function parseGuideRecipe(input: unknown): GuideRecipe {
  const root = object(input, 'recipe');
  keys(root, ['schemaVersion', 'family', 'revision', 'brand', 'sections'], 'recipe');
  if (root.schemaVersion !== SCHEMA_VERSION) throw new Error(`recipe.schemaVersion: expected ${SCHEMA_VERSION}`);
  if (root.family !== FAMILY_ID) throw new Error(`recipe.family: expected "${FAMILY_ID}"`);
  if (typeof root.revision !== 'number' || !Number.isSafeInteger(root.revision) || root.revision < 1 || root.revision > 9999) {
    throw new Error('recipe.revision: expected a positive integer from 1 to 9999');
  }
  const brandRecord = object(root.brand, 'recipe.brand');
  keys(brandRecord, BRAND_SLOTS.map((slot) => slot.name), 'recipe.brand');
  const brand: { name: string; descriptor: FieldValue } = { name: '', descriptor: null };
  for (const slot of BRAND_SLOTS) {
    // `field()` (not `plainText()` directly) so `descriptor`'s `atom: DESCRIPTOR_ATOM` (round 4)
    // is honored the same way any other nullable atom leaf is: `field()` itself already refuses
    // `null` on any slot NOT marked `atom` (see its own doc above), so `name` stays required.
    brand[slot.name as keyof typeof brand] = field(brandRecord[slot.name], slot, `recipe.brand.${slot.name}`);
  }
  if (!Array.isArray(root.sections) || root.sections.length !== SECTIONS.length) throw new Error(`recipe.sections: expected exactly ${SECTIONS.length} sections`);
  const sections = SECTIONS.map((spec, index) => {
    const raw = (root.sections as unknown[])[index];
    return isDroppedOptional(raw, spec.type, GUIDE_OPTIONAL_SECTIONS) ? null : section(raw, spec, `sections[${index}]`);
  });
  return { schemaVersion: SCHEMA_VERSION as 2, family: FAMILY_ID as 'guide', revision: root.revision, brand, sections };
}

// ---------------------------------------------------------------------------------------------
// The JSON schema, derived from the same specs.
// ---------------------------------------------------------------------------------------------

type Schema = { [key: string]: unknown };
const text = (max: number): Schema => ({ type: 'string', minLength: 1, maxLength: max });

function fieldSchema(spec: FieldSpec): Schema {
  const label = spec.label ? { 'x-label': true } : {};
  // `x-verify: 'traceable'` composes with EITHER branch below (a nullable atom's stated value is
  // still a fact to trace; so is a required `verify`/plain field) — never its own standalone
  // branch, or a nullable-AND-traceable field (practical-facts' `value`) would lose its `x-atom`.
  const verify = spec.traceable ? { 'x-verify': 'traceable' } : {};
  if (spec.atom) return { type: ['string', 'null'], 'x-atom': spec.atom, minLength: 1, maxLength: spec.max, ...verify };
  // `contactAtom: 'url'` (plan-a-visit's `url`): required (never nullable — see slots.ts's
  // FieldSpec doc). Carries `x-atom: 'url'` so the shared fast lane's generic contact-atom gate
  // (`spine.ts`'s `contactPathsFor`, `jev.ts`'s `deterministicContactFlags`) can find it — the SAME
  // marker any family's email or phone field uses, never a guide-specific one.
  if (spec.contactAtom === 'url') return { ...text(spec.max), 'x-atom': 'url' };
  // `traceable: true`: a free-prose slot that states a fact about the destination. Carries
  // `x-verify: 'traceable'` so the shared fast lane's deterministic traceability gate (`spine.ts`'s
  // `traceablePathsFor`, `jev.ts`'s `deterministicTraceableFlags`) checks every stemmed content
  // word of its value against the brief.
  if (spec.traceable) return { ...text(spec.max), ...verify };
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
      // `itemAtom`: the item's OWN schema node carries `type: ['object', 'null']` and `x-atom`,
      // the same shared marker any nullable KPI-card-style group uses (`spine.ts`'s `atomKindsFor`
      // own doc) — this is what lets the fast lane's EXISTING generic nullable-group handling
      // (prompt.ts's NULLABLE block, mergeIntoSpine's whole-group-null merge) cover a whole
      // practical-facts row with no change to any shared file.
      ...(spec.items ? { items: { type: 'array', minItems: spec.items.min ?? spec.items.count, maxItems: spec.items.count, items: spec.items.itemAtom ? { ...objectSchema(spec.items.fields), type: ['object', 'null'], 'x-atom': spec.items.itemAtom } : objectSchema(spec.items.fields) } } : {}),
    },
  };
}

/** The recipe's JSON schema, as committed in `recipe.schema.json`. */
export function recipeSchema(): Schema {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `https://open-design.ai/schemas/agency-site/${FAMILY_ID}/recipe.v2.json`,
    title: `${FAMILY_ID} recipe`,
    description: 'A one-destination guide page kind (atlas CS.01): header/nav, masthead, an opening chapter, a chapter list, optional practical facts, optional places to see, an optional typographic gallery of place cards, an optional plan-a-visit link, and a footer. Derived from compiler/scripts/families/guide/slots.ts by contract.ts recipeSchema(); render.test.ts checks the two are equal.',
    $comment: 'contract.ts additionally enforces markup-free plain text and a well-formed URL on the plan-a-visit destination, and that a null appears only on an x-atom string leaf, an x-atom item (a whole practical-facts row), or in an x-optional section slot.',
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
