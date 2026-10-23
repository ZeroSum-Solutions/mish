import {
  addProfile,
  findProfiles,
  loadDesignIndex,
  saveDesignIndex,
  type DesignIndex,
  type FindQuery,
} from '@mish/agency-fast-lane/design-index';
import type { DesignProfile } from '@mish/agency-fast-lane/profile';
import type { DesignTaxonomy } from '@mish/agency-fast-lane/taxonomy';
import { parseDesignProfile } from './design-profile-parse.js';

export interface DesignIndexQueryResult {
  profiles: DesignProfile[];
  /** How many profiles matched before `limit` was applied. */
  matched: number;
  /** Index size. */
  total: number;
}

export interface DesignIndexAddOptions {
  /** Overwrite an entry of the same `source.digest` in place instead of keeping the stored one. */
  replace?: boolean;
}

export interface DesignIndexAddResult {
  profile: DesignProfile;
  added: boolean;
  replaced: boolean;
  total: number;
}

export interface DesignIndexStore {
  add(profile: DesignProfile, options?: DesignIndexAddOptions): Promise<DesignIndexAddResult>;
  find(query: FindQuery, taxonomy: DesignTaxonomy, limit: number): Promise<DesignIndexQueryResult>;
  list(limit: number): Promise<DesignIndexQueryResult>;
  get(digest: string): Promise<DesignProfile | undefined>;
  remove(digest: string): Promise<{ removed: boolean; total: number }>;
}

/**
 * The daemon's view of the fast lane's flat-file design index: `loadDesignIndex` /
 * `saveDesignIndex` / `addProfile` / `findProfiles`, with every operation put on one in-process
 * promise chain.
 *
 * The fast lane's save is atomic (temp file + rename), which protects a *reader* from a partial
 * write but not two writers from each other: both would read the same index, each add its own
 * profile, and the second rename would drop the first one's. The CLI runs one command per process
 * and never hit that; the daemon takes concurrent requests, so the read-modify-save cycle is
 * serialised here instead.
 *
 * Profiles are keyed by `source.digest`, and an add of a digest already in the index is refused
 * rather than overwritten (`added: false`, the stored profile returned), which is the
 * `DesignIndexAddResponse` contract. `add(profile, { replace: true })` overwrites it instead,
 * in place — the whole read, replace and save happening inside the one `serialize` callback, so
 * concurrent replaces of the same digest cannot each append their own copy. A missing file is an
 * empty index, as in the fast lane.
 *
 * Every read goes through `sanitizeIndex`, so no profile this store hands out is ever the object
 * that was on disk.
 */

/**
 * The name to put in the warning for an entry the parser refused: its digest when it has one that
 * survived the JSON, otherwise its position in the file.
 */
function entryName(entry: unknown, position: number): string {
  const digest = (entry as { source?: { digest?: unknown } } | null | undefined)?.source?.digest;
  return typeof digest === 'string' && digest.length > 0 ? `digest ${digest}` : `entry ${position}`;
}

/**
 * Rebuilds every stored profile through `parseDesignProfile`, the same allowlisting parser
 * `POST /api/design-index` runs on an incoming one.
 *
 * `loadDesignIndex` casts the file's JSON to `DesignIndex` without checking it, and the index is a
 * plain file: a legacy entry, a hand-edited one, or one written by the fast lane's catalog
 * hydration never passed through the endpoint. Without this, a stored `source.text` holding the
 * profiled page — the one thing the fast lane's profiler deliberately keeps out of a profile —
 * would be served verbatim by list/get and reach the browser.
 *
 * An entry the parser refuses is skipped with one warning naming it and the reason, not thrown:
 * one bad record must not take the whole index down. Since the sanitised set is the in-memory one,
 * the next `add` or `remove` writes it back, so a refused entry also leaves the file then.
 */
function sanitizeIndex(index: DesignIndex): DesignIndex {
  const stored: unknown[] = Array.isArray(index.profiles) ? index.profiles : [];
  const profiles: DesignProfile[] = [];
  stored.forEach((entry, position) => {
    const parsed = parseDesignProfile(entry);
    if ('error' in parsed) {
      console.warn(`[design-index] skipped stored profile (${entryName(entry, position)}): ${parsed.error}`);
      return;
    }
    profiles.push(parsed.profile);
  });
  return { ...index, profiles };
}

export interface DesignIndexStoreOptions {
  /**
   * Read-only profiles from outside the person's own index (an installed Mish pack). They are
   * parsed like stored ones and served by `list`, `find` and `get` after the person's own; a
   * profile whose digest the person's index already has is left out. `add` and `remove` never
   * write them into the file, and `remove` cannot take one away.
   */
  extraProfiles?: () => unknown[];
}

export function createDesignIndexStore(file: string, options: DesignIndexStoreOptions = {}): DesignIndexStore {
  let chain: Promise<unknown> = Promise.resolve();

  function serialize<T>(work: () => Promise<T>): Promise<T> {
    // `chain.then(work, work)` runs the next operation whether the previous one resolved or
    // rejected, so one failed request never wedges the queue; `chain` itself only ever holds a
    // settled-either-way promise.
    const next = chain.then(work, work);
    chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  const read = async () => sanitizeIndex(await loadDesignIndex(file));

  /** The person's own profiles, then the read-only extra ones whose digest is not already there. */
  const readMerged = async (): Promise<DesignIndex> => {
    const own = await read();
    const extra = options.extraProfiles?.() ?? [];
    if (extra.length === 0) return own;
    const digests = new Set(own.profiles.map((profile) => profile.source.digest));
    const profiles = [...own.profiles];
    for (const entry of sanitizeIndex({ schema: 'design-index/1', profiles: extra as DesignProfile[] }).profiles) {
      if (digests.has(entry.source.digest)) continue;
      digests.add(entry.source.digest);
      profiles.push(entry);
    }
    return { ...own, profiles };
  };

  function byDigest(index: DesignIndex, digest: string): DesignProfile | undefined {
    return index.profiles.find((profile) => profile.source.digest === digest);
  }

  return {
    add(profile, options = {}) {
      return serialize(async () => {
        const index = await read();
        const at = index.profiles.findIndex((entry) => entry.source.digest === profile.source.digest);
        if (at >= 0 && !options.replace) {
          return { profile: index.profiles[at]!, added: false, replaced: false, total: index.profiles.length };
        }
        if (at >= 0) {
          // In place rather than through `addProfile`, which drops the old entry and appends the
          // new one at the end: the list order documented below depends on a replaced entry
          // keeping the position it already had.
          const profiles = [...index.profiles];
          profiles[at] = profile;
          const next: DesignIndex = { ...index, profiles };
          await saveDesignIndex(file, next);
          return { profile, added: false, replaced: true, total: next.profiles.length };
        }
        const next = addProfile(index, profile);
        await saveDesignIndex(file, next);
        return { profile, added: true, replaced: false, total: next.profiles.length };
      });
    },

    find(query, taxonomy, limit) {
      return serialize(async () => {
        const index = await readMerged();
        // `findProfiles` applies its own `limit` after ranking, so ask it for everything and cut
        // the page here: `matched` has to report the size of the full match set, not the page.
        const ranked = findProfiles(index.profiles, { ...query, limit: index.profiles.length }, taxonomy);
        return { profiles: ranked.slice(0, limit), matched: ranked.length, total: index.profiles.length };
      });
    },

    list(limit) {
      return serialize(async () => {
        const index = await readMerged();
        // Newest first by the profile's own `at`, which is when Jev produced it — the index file
        // itself is append-ordered, and an entry replaced in place keeps its old position.
        const ordered = [...index.profiles].sort((a, b) => b.at.localeCompare(a.at));
        return { profiles: ordered.slice(0, limit), matched: ordered.length, total: index.profiles.length };
      });
    },

    get(digest) {
      return serialize(async () => byDigest(await readMerged(), digest));
    },

    remove(digest) {
      return serialize(async () => {
        const index = await read();
        if (!byDigest(index, digest)) return { removed: false, total: index.profiles.length };
        const next: DesignIndex = {
          ...index,
          profiles: index.profiles.filter((profile) => profile.source.digest !== digest),
        };
        await saveDesignIndex(file, next);
        return { removed: true, total: next.profiles.length };
      });
    },
  };
}
