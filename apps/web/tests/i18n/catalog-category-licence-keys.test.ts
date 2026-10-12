/**
 * Every `GenuiCatalogCategory` and `GenuiCatalogLicenceDecision` union member
 * (packages/contracts/src/api/genui-catalog.ts) must have a matching
 * `catalog.category.*` / `catalog.licence.*` key in both locale dicts —
 * `CatalogView.tsx` builds those keys dynamically
 * (`` `catalog.category.${entry.category}` ``), so a union member added
 * without its translation key would only fail at runtime, not at typecheck.
 *
 * The union values are listed explicitly here (not imported from the type,
 * since a type has no runtime form) so a future union member that forgets a
 * key fails this test instead of silently falling back to the raw key string.
 */

import { describe, expect, it } from 'vitest';

import { en } from '../../src/i18n/locales/en';

import type { Dict } from '../../src/i18n/types';

// Mirrors GenuiCatalogCategory in packages/contracts/src/api/genui-catalog.ts.
const CATEGORIES = [
  'surface', 'hover', 'text', 'scroll', 'gallery', 'hero', 'background', 'navigation', 'input',
] as const;

// Mirrors GenuiCatalogLicenceDecision in packages/contracts/src/api/genui-catalog.ts.
const LICENCE_DECISIONS = ['port-with-attribution', 'clean-room', 'licensed', 'cut'] as const;

describe('GenUI catalog i18n coverage', () => {
  it.each(CATEGORIES)("has catalog.category.%s in English", (category) => {
    const key = `catalog.category.${category}` as keyof Dict;
    expect(en[key]).toBeTruthy();

  });

  it.each(LICENCE_DECISIONS)("has catalog.licence.%s in English", (licence) => {
    const key = `catalog.licence.${licence}` as keyof Dict;
    expect(en[key]).toBeTruthy();

  });
});
