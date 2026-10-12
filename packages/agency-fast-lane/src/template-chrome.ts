/**
 * Template chrome: filled text slots that state nothing about the client, so the faithfulness gate
 * must not send them to Jev as facts. Three kinds, and only these:
 *
 * 1. A LABEL the family template supplies and the fill left as it was — a row key such as
 *    "Postcode" or "Bus". The slot must be DECLARED a label by the family schema (`"x-label": true`,
 *    read by spine.ts's `labelPathsFor`), its text must equal the reference recipe's text at the
 *    same path, and it must still look like a label (no digit, at most three words, 24
 *    characters). Being short, digit-free and unchanged is NOT enough on its own: the reference
 *    holds facts too — an admission price of "Free", a city, a person's name — and a copied
 *    reference fact at an undeclared path always reaches the gate.
 * 2. A UNIT token on its own — "per month", "/yr", "Monthly" — left exactly as the reference
 *    recipe wrote it at the same path. It qualifies an amount; the amount lives in its own slot and
 *    is still checked. A unit the fill changed, or one that replaced a reference value, is checked.
 * 3. The COPYRIGHT line — "© 2026 Riverbend Physio. All rights reserved." — when nothing but the
 *    ©/Copyright mark, years, this recipe's own brand name and "all rights reserved" remains AND
 *    the line equals the reference line with the reference brand name swapped for this one
 *    (whitespace collapsed). A changed year, an altered brand or any added claim is still checked.
 *
 * A 4th category — a declared HEADING (`"x-heading": true`) exempted whenever its text equalled
 * the reference recipe's own text at that path AND `isClaimBearingHeading` judged it non-claim-
 * bearing — existed from g6-r2-gemini through g6-sol-r11 and was REMOVED in g6-sol-r12 (Sol's own
 * closure review of r11's audit): it never fired on any fixture this branch shipped, and Sol
 * proved decisively that it did not need to — an in-memory "Ships nationwide" at halcyon's own
 * declared heading path (`sections[6].content.title`) satisfies every one of
 * `isClaimBearingHeading`'s tests (short, no punctuation, no digit, no quantifier/commercial/
 * certification/superlative/number word, and "Ships"/"nationwide" are both ordinary dictionary
 * words) and so WAS exempted by it, while `main` (which has no such mechanism at all) flags it
 * 1/1 as an unsupported claim. The r11 tripwire test only checked 16 of the 22 fields the schema
 * declared `x-heading` at the time and never read live fixture heading text, so it could not have
 * caught this. Rather than narrow `isClaimBearingHeading` a third time to close this specific
 * gap (the same word-list-whack-a-mole pattern every prior round eventually admitted losing to —
 * see g6-r2-gemini, g6-r3-opus55 FIX F4, g6-r3b-opus55 FIX F-c above), the category is removed
 * outright: a declared heading is now checked exactly like any other filled fact slot, with no
 * exemption at all. `isClaimBearingHeading`, `headingPathsFor` (`spine.ts`) and the `"x-heading"`
 * schema markers themselves are removed alongside it — see each removal's own note.
 *
 * Every filled fact slot that is none of the three surviving categories above is checked exactly
 * as before.
 */

import { LOCKED_KEYS, isObject, type Json } from './spine.ts';

const UNIT = /^(?:(?:per|a|an|\/)\s*(?:month|mo|year|yr|annum|week|wk|day|hour|hr|night|person|session|class|visit)\.?|monthly|yearly|annually|weekly|daily|hourly|nightly)$/i;
const COPYRIGHT_MARK = /^\s*(?:©|\(c\)|copyright\b)/i;

function isLabel(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0 && trimmed.length <= 24 && !/[0-9]/.test(trimmed) && trimmed.split(/\s+/).length <= 3;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whether `text` is a copyright line and nothing more, for a page whose brand is `brandName`. */
export function isCopyrightLine(text: string, brandName: string | undefined): boolean {
  if (!COPYRIGHT_MARK.test(text)) return false;
  let rest = text.replace(/©|\(c\)|\bcopyright\b/gi, ' ');
  if (brandName && brandName.trim()) rest = rest.replace(new RegExp(escapeRegExp(brandName.trim()), 'gi'), ' ');
  rest = rest
    .replace(/\b(?:19|20)[0-9]{2}\b/g, ' ')
    .replace(/\ball rights reserved\b/gi, ' ')
    .replace(/[\s.,;:|·–—-]+/g, '');
  return rest.length === 0;
}

/** Trimmed, with every whitespace run collapsed to one space: the equality both rules use. */
function normalized(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

/**
 * Whether the filled copyright line is the reference line re-branded and nothing else: the
 * reference's own brand name replaced by this recipe's, compared with whitespace collapsed.
 */
export function copyrightMatchesReference(text: string, reference: string | undefined, brandName: string | undefined, referenceBrand: string | undefined): boolean {
  if (typeof reference !== 'string') return false;
  let expected = reference;
  if (referenceBrand && referenceBrand.trim() && brandName && brandName.trim()) {
    // Case-insensitive, like `isCopyrightLine`'s own brand match; the function form keeps a `$` in
    // the brand name literal.
    const swapped = brandName.trim();
    expected = expected.replace(new RegExp(escapeRegExp(referenceBrand.trim()), 'gi'), () => swapped);
  }
  return normalized(text) === normalized(expected);
}

/** Whether `text` is a unit or period token on its own ("per month", "/yr", "Monthly"). */
export function isUnitToken(text: string): boolean {
  return UNIT.test(text.trim());
}

/**
 * The paths of `filled` that are template chrome (see the module docblock), in the same path
 * notation `collectFaithfulnessSlots` uses. `reference` is the spine the fill started from;
 * `labelPaths` are the slots the family schema declares labels (`labelPathsFor`). With no
 * declaration, no slot is ever a label.
 */
export function templateChromePaths(filled: Json, reference: Json | undefined, labelPaths: ReadonlySet<string> = new Set()): Set<string> {
  const out = new Set<string>();
  const brandOf = (recipe: Json | undefined) => (isObject(recipe) && isObject(recipe.brand) && typeof recipe.brand.name === 'string' ? recipe.brand.name : undefined);
  const brand = brandOf(filled);
  const referenceBrand = brandOf(reference);
  const walk = (value: Json, ref: Json | undefined, key: string | undefined, at: string): void => {
    if (key !== undefined && LOCKED_KEYS.has(key)) return;
    if (typeof value === 'string') {
      if (!value.trim()) return;
      // `brand.*` is the client's own identity, never a template label.
      const inBrand = at === 'brand' || at.startsWith('brand.');
      const unchanged = typeof ref === 'string' && ref.trim() === value.trim();
      if (!inBrand && unchanged && labelPaths.has(at) && isLabel(value)) out.add(at);
      else if (!inBrand && unchanged && isUnitToken(value)) out.add(at);
      else if (isCopyrightLine(value, brand) && copyrightMatchesReference(value, typeof ref === 'string' ? ref : undefined, brand, referenceBrand)) out.add(at);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, Array.isArray(ref) ? ref[index] : undefined, undefined, `${at}[${index}]`));
      return;
    }
    if (isObject(value)) {
      for (const [childKey, child] of Object.entries(value)) {
        walk(child, isObject(ref) ? ref[childKey] : undefined, childKey, at ? `${at}.${childKey}` : childKey);
      }
    }
  };
  walk(filled, reference, undefined, '');
  return out;
}
