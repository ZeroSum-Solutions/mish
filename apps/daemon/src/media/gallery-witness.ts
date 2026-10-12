import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

import { mediaOutputMatches, type MediaOutputRecord, type MediaOutputVerdict } from './output-witness.js';

/**
 * The output witness the gallery and reuse use: `mediaOutputMatches` plus the
 * three things a listing over many entries needs.
 *
 * - **Containment by realpath.** A recorded name can point through a parent
 *   directory that was later swapped for a symlink (a moved output's name is
 *   persisted, e.g. `nested/pic.png`). `O_NOFOLLOW` only guards the last path
 *   component, so the parent is resolved and must stay inside the project's
 *   real directory, the same rule `resolveSafeReal` applies to project files.
 * - **A byte budget.** Every hash, including the candidates a moved-file search
 *   tries, is charged before it is read. Past the budget the answer is
 *   `unreadable` (shown as unverifiable), never a mismatch.
 * - **A verdict cache** keyed by path, device, inode, size, mtime, ctime
 *   (nanoseconds) and the expected digest. An unchanged file is not re-hashed
 *   by the next page or request; any replacement or edit changes the key,
 *   including a same-size in-place write whose mtime was put back (the write
 *   and the restoring utimes both move ctime, which no caller can set).
 */

type CachedVerdict = 'match' | 'mismatch';

/** Process-wide cache, bounded; oldest entries are evicted first. */
const PROCESS_VERDICT_CACHE = new Map<string, CachedVerdict>();
const PROCESS_VERDICT_CACHE_LIMIT = 4096;

/**
 * Whether `target`'s parent directory resolves (through any symlinks) to a
 * directory inside `projectDir`'s real path. The final component is left to
 * the caller's `O_NOFOLLOW` open.
 */
export async function isContainedOutputPath(projectDir: string, target: string): Promise<boolean> {
  try {
    const [root, parent] = await Promise.all([realpath(projectDir), realpath(path.dirname(target))]);
    return parent === root || parent.startsWith(`${root}${path.sep}`);
  } catch {
    return false;
  }
}

export interface GalleryOutputMatcher {
  matches(target: string, record: Pick<MediaOutputRecord, 'size' | 'sha256'>): Promise<MediaOutputVerdict>;
  /** Bytes hashed so far (cache hits cost nothing). */
  spentBytes(): number;
}

export function createGalleryOutputMatcher(options: {
  projectDir: string;
  budgetBytes: number;
  cache?: Map<string, CachedVerdict>;
  cacheLimit?: number;
}): GalleryOutputMatcher {
  const cache = options.cache ?? PROCESS_VERDICT_CACHE;
  const cacheLimit = options.cacheLimit ?? PROCESS_VERDICT_CACHE_LIMIT;
  let remaining = options.budgetBytes;
  let spent = 0;
  let projectRoot: Promise<string | null> | null = null;
  const realProjectRoot = () => (projectRoot ??= realpath(options.projectDir).catch(() => null));

  const remember = (key: string, verdict: CachedVerdict) => {
    cache.delete(key);
    cache.set(key, verdict);
    while (cache.size > cacheLimit) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  };

  return {
    spentBytes: () => spent,
    async matches(target, record) {
      const root = await realProjectRoot();
      if (!root) return 'unreadable';
      let parent: string;
      try {
        parent = await realpath(path.dirname(target));
      } catch (err) {
        return (err as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'missing' : 'unreadable';
      }
      if (parent !== root && !parent.startsWith(`${root}${path.sep}`)) return 'mismatch';

      let stats;
      try {
        stats = await lstat(target, { bigint: true });
      } catch (err) {
        return (err as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'missing' : 'unreadable';
      }
      if (!stats.isFile()) return 'mismatch';
      if (record.size !== null && stats.size !== BigInt(record.size)) return 'mismatch';

      const key = [target, stats.dev, stats.ino, stats.size, stats.mtimeNs, stats.ctimeNs, record.sha256].join('\u0000');
      const cached = cache.get(key);
      if (cached) {
        remember(key, cached);
        return cached;
      }
      const size = Number(stats.size);
      if (size > remaining) return 'unreadable';
      remaining -= size;
      spent += size;
      const verdict = await mediaOutputMatches(target, record);
      if (verdict === 'match' || verdict === 'mismatch') remember(key, verdict);
      return verdict;
    },
  };
}
