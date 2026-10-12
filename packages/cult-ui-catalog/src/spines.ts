/**
 * Spine affinities from the item's explicit use-case intent (port ruling §4): SaaS/product → PA,
 * commerce → CO, provider trust → TL, publication/subscription → CS, booking → BA,
 * membership/learning → LM, task tools → TU, cause → MI. A colour scheme or a generic label such
 * as "Landing pages" implies nothing.
 *
 * Only section and page rows get affinities: they are the rows the site planner routes. An item
 * whose use cases match no intent, or so many intents (four or more) that they do not
 * discriminate, gets `[]` (unclassified).
 */

import type { SpineCode } from './taxonomy.ts';
import type { AssetKind } from './types.ts';

const INTENT: ReadonlyArray<[SpineCode, RegExp]> = [
  ['TL', /agenc(y|ies)|consult|professional services|service (highlights|catalogs?|providers?|business)|law firm|clinic|freelanc|portfolio/],
  ['PA', /\bsaas\b|developer|dev[- ]?tools?|startup|\bproducts?\b|platform|\bapi\b|b2b|framework|software/],
  ['CO', /e-?commerce|\bshop|\bstores?\b|storefront|retail|checkout|merch|\bcart\b/],
  ['CS', /newsletter|\bblog|publication|publishing|magazine|editorial|podcast|content creators?|subscribers?/],
  ['BA', /booking|reservation|appointment|\bevents?\b|conference|ticket|webinar|scheduling/],
  ['LM', /course|membership|communit(y|ies)|learning|education|coaching|cohort|academy|students?/],
  ['TU', /productivity|dashboard|\btasks?\b|workflow|internal tools?|project management|admin/],
  ['MI', /non-?profit|charit|donat|\bcauses?\b|mission|volunteer|fundrais|advocacy/],
];

const AMBIGUOUS_AT = 4;

export function spineAffinities(useCases: readonly string[], assetKind: AssetKind): SpineCode[] {
  if (assetKind !== 'section' && assetKind !== 'page') return [];
  const text = useCases.join(' | ').toLowerCase();
  const matched = INTENT.filter(([, pattern]) => pattern.test(text)).map(([code]) => code);
  if (matched.length >= AMBIGUOUS_AT) return [];
  return matched.sort();
}
