import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

/**
 * Font files are untrusted binaries. The daemon never parses them: it only checks
 * that the catalogued path is a bounded regular file inside the resource root, that
 * its size and first four bytes match the declared format, and that its sha256
 * equals the digest pinned in the snapshot. The browser's font sanitizer is the
 * only parser that ever sees the bytes.
 */
export const FONT_FILE_LIMIT = 2 * 1024 * 1024;
export const FONT_NOTICE_LIMIT = 64 * 1024;
export type FontFormat = 'woff2' | 'woff' | 'ttf' | 'otf';
export const FONT_CONTENT_TYPES: Record<FontFormat, string> = { woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', otf: 'font/otf' };
const MAGIC: Record<FontFormat, readonly string[]> = { woff2: ['774f4632'], woff: ['774f4646'], ttf: ['00010000', '74727565'], otf: ['4f54544f'] };

export type VerifiedRead =
  | { state: 'available'; bytes: Buffer }
  | { state: 'unavailable'; reason: 'unreadable' | 'size-mismatch' | 'magic-mismatch' | 'digest-mismatch' };

/** A resource-root-relative path: no absolute form, backslash, drive letter, empty or dot segment. */
export function isSafeRelativePath(value: string): boolean {
  return !!value && !value.startsWith('/') && !value.includes('\\') && !/^[A-Za-z]:/.test(value) && value.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}
const within = (parent: string, child: string) => child.startsWith(parent + path.sep);
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

type CacheEntry = { key: string; result: VerifiedRead };
/** Verified results keyed by path and the opened inode's identity/size/times; a changed file re-verifies. */
const cache = new Map<string, CacheEntry>();
const CACHE_LIMIT = 512;

/**
 * Reads `relative` under `rootReal` (already realpath-resolved) at most `limit` bytes.
 * Opens with O_NOFOLLOW, requires the open handle to be the same inode as the realpath
 * inside the root, and checks the expected size, magic and digest. Paths never leave.
 */
export async function readVerifiedFile(rootReal: string, relative: string, expected: { sha256: string; bytes?: number; format?: FontFormat }, limit: number): Promise<VerifiedRead> {
  if (!isSafeRelativePath(relative)) return { state: 'unavailable', reason: 'unreadable' };
  const filename = path.join(rootReal, relative);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile()) return { state: 'unavailable', reason: 'unreadable' };
    const real = await realpath(filename);
    if (!within(rootReal, real)) return { state: 'unavailable', reason: 'unreadable' };
    const checked = await stat(real);
    if (checked.dev !== opened.dev || checked.ino !== opened.ino) return { state: 'unavailable', reason: 'unreadable' };
    if (opened.size > limit || (expected.bytes !== undefined && opened.size !== expected.bytes)) return { state: 'unavailable', reason: 'size-mismatch' };
    const key = `${expected.sha256}:${opened.dev}:${opened.ino}:${opened.size}:${opened.mtimeMs}:${opened.ctimeMs}`;
    const cached = cache.get(filename);
    if (cached?.key === key) return cached.result;
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    for (let read = -1; read !== 0 && length <= limit;) {
      ({ bytesRead: read } = await handle.read(buffer, length, buffer.length - length, null));
      length += read;
    }
    if (length > limit || (expected.bytes !== undefined && length !== expected.bytes)) return { state: 'unavailable', reason: 'size-mismatch' };
    const bytes = Buffer.from(buffer.subarray(0, length));
    let result: VerifiedRead;
    if (expected.format && !MAGIC[expected.format].includes(bytes.subarray(0, 4).toString('hex'))) result = { state: 'unavailable', reason: 'magic-mismatch' };
    else if (sha256(bytes) !== expected.sha256) result = { state: 'unavailable', reason: 'digest-mismatch' };
    else result = { state: 'available', bytes };
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
    cache.set(filename, { key, result });
    return result;
  } catch { return { state: 'unavailable', reason: 'unreadable' }; } finally { await handle?.close(); }
}
