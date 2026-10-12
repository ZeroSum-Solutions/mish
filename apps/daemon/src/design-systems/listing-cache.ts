// Fingerprint-validated cache for design-system catalogue listings.
//
// `listDesignSystems` parses every kit's DESIGN.md (swatch and colour regexes,
// frontmatter, manifest identity) on each call. Home re-reads the catalogue on
// every load, so with ~130 kits that parse cost ~100 ms of daemon CPU per call,
// and much more on a loaded machine, where it queued behind the rest of the
// page-load burst.
//
// The cache never trusts time: every call re-stats exactly the inputs the
// listing reads (each kit directory, DESIGN.md, metadata.json, manifest.json,
// assets/ and assets/preview.jpg, plus a manifest-declared design file) and
// reuses the previous answer only when every stat (mtime, ctime, size, inode)
// is unchanged. ctime moves on any write and cannot be set back, so even a
// same-size rewrite that restores the mtime invalidates the entry. On a volume
// with coarse timestamps two same-size rewrites in one tick can still look
// identical, so an entry is also rebuilt after a bounded age (60 s). Stats are
// cheap; parsing is what the cache saves.

import type { Dirent, BigIntStats } from 'node:fs';
import { readdir, readFile, stat, lstat } from 'node:fs/promises';
import path from 'node:path';

type Listing<T> = (root: string, options?: any) => Promise<T[]>;

const DEFAULT_MAX_AGE_MS = 60_000;

const KIT_INPUTS = ['DESIGN.md', 'metadata.json', 'manifest.json', 'assets', 'assets/preview.jpg'];

function statKey(stats: BigIntStats | null): string {
  if (!stats) return '-';
  return `${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`;
}

async function statOrNull(target: string): Promise<BigIntStats | null> {
  try {
    return await stat(target, { bigint: true });
  } catch {
    return null;
  }
}

/** The design file a kit's manifest declares, memoized by the manifest's stat. */
const declaredDesignFiles = new Map<string, { key: string; file: string | null }>();

async function declaredDesignFile(kitDir: string, manifestKey: string): Promise<string | null> {
  if (manifestKey === '-') return null;
  const memo = declaredDesignFiles.get(kitDir);
  if (memo?.key === manifestKey) return memo.file;
  let file: string | null = null;
  try {
    const parsed = JSON.parse(await readFile(path.join(kitDir, 'manifest.json'), 'utf8')) as {
      files?: { design?: unknown };
    };
    const design = parsed?.files?.design;
    if (typeof design === 'string' && design && design !== 'DESIGN.md') file = design;
  } catch {
    file = null;
  }
  declaredDesignFiles.set(kitDir, { key: manifestKey, file });
  return file;
}

async function kitFingerprint(kitDir: string): Promise<string> {
  const [dirStats, ...inputStats] = await Promise.all([
    statOrNull(kitDir),
    ...KIT_INPUTS.map((input) => statOrNull(path.join(kitDir, input))),
  ]);
  const keys = [statKey(dirStats), ...inputStats.map(statKey)];
  const manifestKey = keys[1 + KIT_INPUTS.indexOf('manifest.json')]!;
  const declared = await declaredDesignFile(kitDir, manifestKey);
  if (declared) keys.push(`${declared}=${statKey(await statOrNull(path.join(kitDir, declared)))}`);
  keys.push(await contentStats(kitDir));
  keys.push(statKey(await statOrNull(path.join(path.dirname(kitDir), '.approvals', path.basename(kitDir) + '.json'))));
  return keys.join('|');
}

/** Recursively stat content without reading asset bytes or following links. */
export async function contentStats(root: string, prefix = ''): Promise<string> {
  try {
    const entries = (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    const keys = await Promise.all(entries.filter(entry => prefix || !['.git', 'node_modules', 'revisions'].includes(entry.name)).map(async entry => {
      const relative = prefix + entry.name;
      const target = path.join(root, entry.name);
      const stats = await lstat(target, { bigint: true });
      return `${relative}=${statKey(stats)}${entry.isDirectory() ? await contentStats(target, relative + '/') : ''}`;
    }));
    return keys.join('|');
  } catch { return 'unreadable'; }
}

/** Null when the root cannot be read: such a root is never cached. */
async function rootFingerprint(root: string, approvalReceiptRoot?: string): Promise<string | null> {
  const rootStats = await statOrNull(root);
  if (!rootStats) return null;
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }
  const kits = entries
    .filter((entry) => !entry.name.startsWith('.') && (entry.isDirectory() || entry.isSymbolicLink()))
    .map((entry) => entry.name)
    .sort();
  const prints = await Promise.all(
    kits.map(async (name) => `${name}#${await kitFingerprint(path.join(root, name))}`),
  );
  const receipts = approvalReceiptRoot ? await contentStats(path.join(approvalReceiptRoot, '.approvals')) : '';
  return `${statKey(rootStats)}\n${prints.join('\n')}\n${receipts}`;
}

function cloneSummary<T>(summary: T): T {
  if (!summary || typeof summary !== 'object') return summary;
  const copy = { ...(summary as Record<string, unknown>) };
  for (const [key, value] of Object.entries(copy)) {
    if (Array.isArray(value)) copy[key] = [...value];
    else if (value && typeof value === 'object') copy[key] = { ...(value as Record<string, unknown>) };
  }
  return copy as T;
}

/**
 * Wrap a catalogue listing so an unchanged root is answered from memory.
 * Each caller receives its own copies of the summaries.
 */
export function createDesignSystemListingCache<T>(
  list: Listing<T>,
  cacheOptions: {
    /**
     * Rebuild an entry this old even when its fingerprint is unchanged. On a
     * volume with coarse timestamps two same-size rewrites inside one tick
     * leave every stat equal; the bound caps how long such a change can hide.
     */
    maxAgeMs?: number;
    /** Monotonic clock in milliseconds. */
    now?: () => number;
  } = {},
): Listing<T> {
  const maxAgeMs = cacheOptions.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const now = cacheOptions.now ?? (() => performance.now());
  const entries = new Map<string, { fingerprint: string; result: T[]; storedAt: number }>();
  // One listing per key and fingerprint at a time: the startup warm-up and
  // the first Home request arrive together, and the second must reuse the
  // first parse instead of starting another.
  const inFlight = new Map<string, { fingerprint: string; pending: Promise<T[]> }>();
  return async (root, options) => {
    const key = `${root}\0${JSON.stringify(options ?? {})}`;
    const fingerprint = await rootFingerprint(root, options?.approvalReceiptRoot);
    if (fingerprint === null) {
      entries.delete(key);
      return list(root, options);
    }
    const hit = entries.get(key);
    if (hit && hit.fingerprint === fingerprint && now() - hit.storedAt <= maxAgeMs) {
      return hit.result.map(cloneSummary);
    }
    const running = inFlight.get(key);
    if (running && running.fingerprint === fingerprint) {
      return (await running.pending).map(cloneSummary);
    }
    const pending = readAndStore(root, options, key, fingerprint);
    inFlight.set(key, { fingerprint, pending });
    try {
      return (await pending).map(cloneSummary);
    } finally {
      if (inFlight.get(key)?.pending === pending) inFlight.delete(key);
    }
  };

  async function readAndStore(
    root: string,
    options: any,
    key: string,
    fingerprint: string,
  ): Promise<T[]> {
    // A kit whose files exist but could not be read is skipped (or read as
    // empty metadata) by the listing. Its stats are unchanged, so storing that
    // answer would keep serving the gap; answer uncached and retry next time.
    let readFailed = false;
    const startedAt = now();
    const result = await list(root, {
      ...(options ?? {}),
      onEntryError: (entryName: string, error: unknown) => {
        readFailed = true;
        options?.onEntryError?.(entryName, error);
      },
    });
    if (readFailed) entries.delete(key);
    else entries.set(key, { fingerprint, result, storedAt: startedAt });
    return result;
  }
}
