// Which Search-panel facets discriminate over the profiles currently loaded, and which are
// dominated enough by one bucket to hide behind "More filters" by default.
//
// Kept dependency-free (no React, no JSX) so it can be imported and run outside the app — by a
// test, or by a plain `node --experimental-strip-types` script — against the exact same
// `DesignProfile[]` the Search panel holds, rather than a second hand-written reimplementation
// drifting from the component.

import {
  DESIGN_INDEX_DEFAULT_MIN,
  DESIGN_INDEX_QUERY_LIST_KEYS,
  DESIGN_STYLE_AXES,
  type DesignProfile,
  type DesignStyleAxis,
} from '@mish/contracts';

/** Tied to `DESIGN_INDEX_QUERY_LIST_KEYS` itself, not a hand-copied literal union, so a list
 *  facet added to the query contract cannot silently go unrecognized here. */
export type ListFacetKey = (typeof DESIGN_INDEX_QUERY_LIST_KEYS)[number];
export type RouteFacetKey = 'spine' | 'archetype' | 'family';
export type FacetKey = ListFacetKey | RouteFacetKey | DesignStyleAxis;

/** A facet whose largest bucket holds more than this share of the loaded profiles is dominated. */
export const FACET_DOMINANCE_THRESHOLD = 0.6;
/** Below this many loaded profiles, a share is not a meaningful read — show every facet. */
export const FACET_DOMINANCE_MIN_PROFILES = 5;

const LIST_FACET_FIELD: Record<ListFacetKey, 'sections' | 'components' | 'mechanics' | 'depth'> = {
  section: 'sections',
  component: 'components',
  mechanic: 'mechanics',
  depth: 'depth',
};

const ROUTE_FACET_CHOICE: Record<RouteFacetKey, (profile: DesignProfile) => string> = {
  spine: (profile) => profile.route.spine.choice,
  archetype: (profile) => profile.route.archetype?.choice ?? 'none',
  family: (profile) => profile.route.family.choice,
};

/** Whether `key` is a list facet (bucketed on presence) rather than a scalar one (`.choice`). */
export function isListFacetKey(key: FacetKey): key is ListFacetKey {
  return Object.hasOwn(LIST_FACET_FIELD, key);
}

function isRouteFacetKey(key: FacetKey): key is RouteFacetKey {
  return Object.hasOwn(ROUTE_FACET_CHOICE, key);
}

function largestBucketShare(values: string[], total: number): number {
  if (total === 0) return 0;
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  let largest = 0;
  for (const count of counts.values()) if (count > largest) largest = count;
  return largest / total;
}

/**
 * The largest-bucket share for one facet, over the profiles currently loaded.
 *
 * A list facet (section/component/mechanic/depth) buckets on presence — a label counts if its
 * probability is at least the search query's own default threshold (`DESIGN_INDEX_DEFAULT_MIN`)
 * — because a profile can carry several of its labels at once. A scalar facet (spine, archetype,
 * family, the six style axes) buckets on its one `.choice`.
 */
export function facetShare(key: FacetKey, profiles: DesignProfile[]): number {
  if (profiles.length === 0) return 0;
  if (isListFacetKey(key)) {
    const field = LIST_FACET_FIELD[key];
    const present: string[] = [];
    for (const profile of profiles) {
      for (const [label, probability] of Object.entries(profile[field])) {
        if (probability >= DESIGN_INDEX_DEFAULT_MIN) present.push(label);
      }
    }
    return largestBucketShare(present, profiles.length);
  }
  if (isRouteFacetKey(key)) {
    return largestBucketShare(profiles.map(ROUTE_FACET_CHOICE[key]), profiles.length);
  }
  return largestBucketShare(profiles.map((profile) => profile.style[key].choice), profiles.length);
}

/**
 * Every facet key the Search panel renders, in the order it renders them — the four list facets,
 * then spine/archetype/family, then the six style axes. `DesignIndexView` renders exactly this
 * list (split between the visible group and "More filters" by `collapsedFacetKeys`); the eval
 * verifier deliberately does NOT import it — it rediscovers the same keys with its own grep of
 * `LIST_FACET_SOURCE` and `DESIGN_STYLE_AXES` (enforced identical to this list by
 * `LIST_FACET_FIELD`'s `Record<ListFacetKey, …>` exhaustiveness (itself tied to
 * `DESIGN_INDEX_QUERY_LIST_KEYS`) and by `DESIGN_STYLE_AXES` being this module's own import), so a
 * facet added to the component's query contract without updating this module still shows up in
 * what the eval checks.
 */
export const ALL_FACET_KEYS: readonly FacetKey[] = [
  ...DESIGN_INDEX_QUERY_LIST_KEYS,
  'spine',
  'archetype',
  'family',
  ...DESIGN_STYLE_AXES,
];

/**
 * Which of `keys` should collapse behind "More filters": dominated (share over the threshold) on
 * the loaded profiles, and not one the caller already has a value set for — a filter already in
 * use keeps discriminating regardless of what the rest of the loaded set now looks like. Below
 * `FACET_DOMINANCE_MIN_PROFILES` loaded profiles, a share is too thin to act on, so nothing
 * collapses.
 */
export function collapsedFacetKeys(
  keys: readonly FacetKey[],
  profiles: DesignProfile[],
  setKeys: ReadonlySet<FacetKey>,
): Set<FacetKey> {
  const collapsed = new Set<FacetKey>();
  if (profiles.length < FACET_DOMINANCE_MIN_PROFILES) return collapsed;
  for (const key of keys) {
    if (setKeys.has(key)) continue;
    if (facetShare(key, profiles) > FACET_DOMINANCE_THRESHOLD) collapsed.add(key);
  }
  return collapsed;
}
