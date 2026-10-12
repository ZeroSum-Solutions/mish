// The visible second-level row under the Prototype chip: one tab per Website
// Shape Atlas spine.
//
// The atlas says the functional spine is the category a website belongs to
// (format and visual skin are separate axes), so the Prototype row is the nine
// spines rather than the plugin catalog's keyword facets. The spines come from
// `@open-design/agency-fast-lane/data`, the same generated module the router
// and the family registry read, so a tab can never name a spine the router
// does not know.
//
// The legacy keyword scenes in `sub-chips.ts` stay where they are: persisted
// drafts, queued `mobile` / `wireframe` intents and the placeholder carousel
// still resolve through them. They are simply not rendered under Prototype.

import { shapeAtlas } from '@open-design/agency-fast-lane/data';
import type { IconName } from '../Icon';
import type { HomeHeroSubChip, SubChipLabelKey } from './sub-chips';

/**
 * Locale key per spine code. A table rather than a template string so tsc
 * proves every code maps to a key both dictionaries define; a spine the
 * atlas grows without a key here falls back to the atlas's own English name.
 */
const SPINE_LABEL_KEYS: Readonly<Record<string, SubChipLabelKey>> = {
  TL: 'homeHero.spine.TL',
  PA: 'homeHero.spine.PA',
  CO: 'homeHero.spine.CO',
  SM: 'homeHero.spine.SM',
  CS: 'homeHero.spine.CS',
  LM: 'homeHero.spine.LM',
  BA: 'homeHero.spine.BA',
  TU: 'homeHero.spine.TU',
  MI: 'homeHero.spine.MI',
};

// Deterministic glyph per spine code; a spine without an entry gets the
// neutral fallback rather than crashing the row.
const SPINE_ICONS: Readonly<Record<string, IconName>> = {
  TL: 'users',
  PA: 'blocks',
  CO: 'bar-chart-box',
  SM: 'search',
  CS: 'file-text',
  LM: 'lightbulb',
  BA: 'history',
  TU: 'sliders',
  MI: 'globe',
};

export const DEFAULT_SPINE_ICON: IconName = 'blocks';

/**
 * The locale key for a spine code, or null when the atlas grew a spine this
 * build has no copy for. Callers outside the tab row (the Jev notice) use it so
 * a spine is named the same way everywhere.
 */
export function spineLabelKeyForCode(code: string): SubChipLabelKey | null {
  return SPINE_LABEL_KEYS[code] ?? null;
}

/**
 * The Prototype row's tabs, in the atlas's own order. `slug` is the spine code
 * (`TL`, `PA`, …) — the same value the design index's `spine` query takes and
 * the family registry stores, so no translation table stands between a tab and
 * the cards it filters.
 */
export function prototypeSpineChips(): HomeHeroSubChip[] {
  return shapeAtlas.spines.map((spine) => {
    const labelKey = SPINE_LABEL_KEYS[spine.code];
    return {
      slug: spine.code,
      label: spine.name,
      icon: SPINE_ICONS[spine.code] ?? DEFAULT_SPINE_ICON,
      ...(labelKey ? { labelKey } : {}),
    };
  });
}
