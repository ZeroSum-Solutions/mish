/**
 * The design index: a flat file of `DesignProfile`s the CLI can query by section, component,
 * mechanic, depth, style axis, or route field. See `docs/plans/2026-09-19-design-profile-index-design.md`
 * section 6 for the `find` flag surface this backs.
 *
 * `addProfile` dedupes by `source.digest` (a re-profiled unchanged input replaces its old entry
 * instead of appending a duplicate); `findProfiles` is pure, taking the taxonomy in so it can
 * fail loudly — listing the valid ids — on an unknown filter label, instead of silently matching
 * nothing. Route-level filters (`spine`, `archetype`, `family`, `format`, `skin`) are not
 * label-checked here: the design taxonomy does not carry the Website Shape Atlas's own
 * vocabulary, so validating those against a controlled list would need the atlas/registry passed
 * in too. `action` is taxonomy-backed and is checked like any other label.
 */

import { readFile, rename, writeFile } from 'node:fs/promises';
import type { DesignProfile, Judgment } from './profile.ts';
import type { DesignTaxonomy, TaxonomyLabel } from './taxonomy.ts';

export type DesignIndex = { schema: 'design-index/1'; profiles: DesignProfile[] };

export function emptyDesignIndex(): DesignIndex {
  return { schema: 'design-index/1', profiles: [] };
}

export async function loadDesignIndex(file: string): Promise<DesignIndex> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as DesignIndex;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyDesignIndex();
    throw error;
  }
}

/**
 * Writes atomically: the full JSON lands in a sibling temp file first, then `rename` swaps it
 * into place in one filesystem operation, so a reader (or a crash mid-write) never sees a
 * truncated or partially-written index. The temp name carries the pid and a timestamp so two
 * concurrent runs writing the same index path never collide on the temp file itself.
 */
export async function saveDesignIndex(file: string, index: DesignIndex): Promise<void> {
  const tmpFile = `${file}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmpFile, `${JSON.stringify(index, null, 2)}\n`);
  await rename(tmpFile, file);
}

/**
 * Adds a profile, replacing any existing entry with the same `source.digest` (an unchanged input
 * re-profiled) rather than duplicating it. Returns a new index; does not mutate `index`.
 */
export function addProfile(index: DesignIndex, profile: DesignProfile): DesignIndex {
  const withoutMatch = index.profiles.filter((existing) => existing.source.digest !== profile.source.digest);
  return { ...index, profiles: [...withoutMatch, profile] };
}

// ---------------------------------------------------------------------------
// findProfiles
// ---------------------------------------------------------------------------

export type FindQuery = {
  sections?: string[];
  components?: string[];
  mechanics?: string[];
  depths?: string[];
  skin?: string;
  spine?: string;
  archetype?: string;
  family?: string;
  format?: string;
  action?: string;
  ground?: string;
  accent?: string;
  typography?: string;
  imagery?: string;
  topology?: string;
  density?: string;
  min?: number;
  text?: string;
  limit?: number;
};

const DEFAULT_MIN = 0.5;
const DEFAULT_LIMIT = 25;

function labelIds(list: TaxonomyLabel[]): Set<string> {
  return new Set(list.map((label) => label.id));
}

function assertKnownMany(kind: string, values: string[] | undefined, valid: Set<string>): void {
  if (!values) return;
  for (const value of values) assertKnownOne(kind, value, valid);
}

function assertKnownOne(kind: string, value: string | undefined, valid: Set<string>): void {
  if (value === undefined) return;
  if (!valid.has(value)) {
    throw new Error(`design-index: unknown ${kind} "${value}". Valid ${kind} values: ${[...valid].sort().join(', ')}`);
  }
}

function validateQuery(query: FindQuery, taxonomy: DesignTaxonomy): void {
  assertKnownMany('section', query.sections, labelIds(taxonomy.sections));
  assertKnownMany('component', query.components, labelIds(taxonomy.components));
  assertKnownMany('mechanic', query.mechanics, labelIds(taxonomy.mechanics));
  assertKnownMany('depth', query.depths, labelIds(taxonomy.depth));
  assertKnownOne('ground', query.ground, new Set([...labelIds(taxonomy.style.ground), 'unspecified']));
  assertKnownOne('accent', query.accent, new Set([...labelIds(taxonomy.style.accent), 'unspecified']));
  assertKnownOne('typography', query.typography, new Set([...labelIds(taxonomy.style.typography), 'unspecified']));
  assertKnownOne('imagery', query.imagery, new Set([...labelIds(taxonomy.style.imagery), 'unspecified']));
  assertKnownOne('topology', query.topology, new Set([...labelIds(taxonomy.style.topology), 'unspecified']));
  assertKnownOne('density', query.density, new Set([...labelIds(taxonomy.style.density), 'unspecified']));
  assertKnownOne('action', query.action, labelIds(taxonomy.action));
}

/** Matches a Choice judgment against a wanted value: either it is the judgment's own chosen
 * option, or its stored probability for that option meets `min`. Returns the probability to fold
 * into the ranking score, or `undefined` when the judgment does not match at all. */
function matchChoice(judgment: Judgment | undefined, wanted: string, min: number): number | undefined {
  if (!judgment) return undefined;
  const probability = judgment.probabilities[wanted];
  if (judgment.choice === wanted) return probability ?? judgment.confidence;
  if (typeof probability === 'number' && probability >= min) return probability;
  return undefined;
}

type Scored = { profile: DesignProfile; score: number };

/**
 * Every `--section/--component/--mechanic/--depth` value must reach `min` (default 0.5); a
 * Choice filter matches the judgment's own chosen option or a stored probability >= `min`.
 * Results are ranked by the product of every matched filter's probability, then by
 * `meta.total_likes` when present (higher first); ties with no `total_likes` on either side keep
 * their relative order. `limit` (default 25) caps the returned list after ranking.
 */
export function findProfiles(profiles: DesignProfile[], query: FindQuery, taxonomy: DesignTaxonomy): DesignProfile[] {
  validateQuery(query, taxonomy);
  const min = query.min ?? DEFAULT_MIN;
  const limit = query.limit ?? DEFAULT_LIMIT;

  const scored: Scored[] = [];
  for (const profile of profiles) {
    let score = 1;
    let matched = true;

    const applyNoul = (ids: string[] | undefined, record: Record<string, number>) => {
      if (!matched || !ids) return;
      for (const id of ids) {
        const value = record[id] ?? 0;
        if (value < min) {
          matched = false;
          return;
        }
        score *= value;
      }
    };
    applyNoul(query.sections, profile.sections);
    applyNoul(query.components, profile.components);
    applyNoul(query.mechanics, profile.mechanics);
    applyNoul(query.depths, profile.depth);
    if (!matched) continue;

    const applyChoice = (wanted: string | undefined, judgment: Judgment | undefined) => {
      if (!matched || wanted === undefined) return;
      const probability = matchChoice(judgment, wanted, min);
      if (probability === undefined) {
        matched = false;
        return;
      }
      score *= probability;
    };
    applyChoice(query.spine, profile.route.spine);
    applyChoice(query.archetype, profile.route.archetype);
    applyChoice(query.family, profile.route.family);
    applyChoice(query.format, profile.route.format);
    applyChoice(query.action, profile.route.action);
    applyChoice(query.skin, profile.route.skin);
    applyChoice(query.ground, profile.style.ground);
    applyChoice(query.accent, profile.style.accent);
    applyChoice(query.typography, profile.style.typography);
    applyChoice(query.imagery, profile.style.imagery);
    applyChoice(query.topology, profile.style.topology);
    applyChoice(query.density, profile.style.density);
    if (!matched) continue;

    if (query.text) {
      const needle = query.text.toLowerCase();
      const haystack = `${profile.source.title ?? ''} ${profile.source.id ?? ''}`.toLowerCase();
      if (!haystack.includes(needle)) continue;
    }

    scored.push({ profile, score });
  }

  scored.sort((a, b) => {
    if (Math.abs(a.score - b.score) > 1e-9) return b.score - a.score;
    const aLikes = typeof a.profile.meta?.total_likes === 'number' ? a.profile.meta.total_likes : -Infinity;
    const bLikes = typeof b.profile.meta?.total_likes === 'number' ? b.profile.meta.total_likes : -Infinity;
    return bLikes - aLikes;
  });

  return scored.slice(0, limit).map((entry) => entry.profile);
}
