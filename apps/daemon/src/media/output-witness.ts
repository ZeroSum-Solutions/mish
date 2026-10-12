import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, unlink } from 'node:fs/promises';
import path from 'node:path';

import { MEDIA_OUTPUT_SUPERSEDED_CODE, mediaFailureNextStep } from '@mish/contracts';

import type { MediaTaskError } from './tasks.js';

export { MEDIA_OUTPUT_SUPERSEDED_CODE };

/**
 * How many outputs one task listing hashes at a time. Each check holds a file
 * descriptor for a full streamed read, and a project can hold hundreds of
 * generations; unbounded, a listing ran into EMFILE.
 */
export const MEDIA_OUTPUT_HASH_CONCURRENCY = 4;

/** Run `fn` over `items` with at most `limit` calls in flight. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  return results;
}

/** sha256 of the bytes a generation wrote, recorded on the task's file. */
export function mediaOutputDigest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** What a task recorded about the bytes it wrote. */
export interface MediaOutputRecord {
  name: string;
  size: number | null;
  sha256: string;
}

/** The witness a done task carries, or null for a task that predates it. */
export function mediaOutputRecord(file: unknown): MediaOutputRecord | null {
  if (!file || typeof file !== 'object') return null;
  const record = file as { name?: unknown; size?: unknown; sha256?: unknown };
  const name = typeof record.name === 'string' ? record.name.trim() : '';
  const sha256 = typeof record.sha256 === 'string' ? record.sha256 : '';
  if (!name || !/^[a-f0-9]{64}$/.test(sha256)) return null;
  const size = typeof record.size === 'number' && Number.isFinite(record.size) ? record.size : null;
  return { name, size, sha256 };
}

// O_NONBLOCK keeps a FIFO from blocking the open; O_NOFOLLOW refuses a
// symlink at the final path component. Both are POSIX; Windows has neither,
// and there the fstat check below still refuses anything but a regular file.
const WITNESS_OPEN_FLAGS =
  constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

/**
 * Whether `target` holds exactly the bytes a task recorded.
 *
 * Only a regular file can match: a FIFO, device, directory or symlink at the
 * path is someone else's object, never this task's output, and reading it
 * could block or escape the project. An I/O failure is 'unreadable', never
 * 'mismatch': only bytes actually read can prove a replacement. The recorded size is compared before any
 * byte is read, and the hash streams, so a large video costs one sequential
 * read and a mismatched size costs none.
 */
export type MediaOutputVerdict = 'match' | 'mismatch' | 'missing' | 'unreadable';

export async function mediaOutputMatches(
  target: string,
  record: Pick<MediaOutputRecord, 'size' | 'sha256'>,
): Promise<MediaOutputVerdict> {
  let handle;
  try {
    handle = await open(target, WITNESS_OPEN_FLAGS);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') return 'missing';
    // O_NOFOLLOW refuses a symlink with ELOOP: proven not this task's file.
    if (code === 'ELOOP') return 'mismatch';
    // EMFILE, ENFILE, EACCES, EIO, …: the bytes were never seen.
    return 'unreadable';
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) return 'mismatch';
    if (record.size !== null && stats.size !== record.size) return 'mismatch';
    const hash = createHash('sha256');
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk as Buffer);
    return hash.digest('hex') === record.sha256 ? 'match' : 'mismatch';
  } catch {
    // A read that failed part-way proves nothing about the bytes.
    return 'unreadable';
  } finally {
    await handle.close().catch(() => {});
  }
}

/** Upper bound on one gallery reuse copy. */
export const MEDIA_REUSE_MAX_BYTES = 2 * 1024 * 1024 * 1024;

export type MediaOutputCopyResult =
  | { kind: 'copied'; bytes: number }
  | { kind: 'mismatch' | 'missing' | 'unreadable' | 'too-large' }
  | { kind: 'exists' };

/**
 * Copy the bytes a task recorded from `source` to a NEW file at `dest`, under
 * the same rules as `mediaOutputMatches`: the source must be a regular file
 * reached without following a final-component symlink, its size must equal
 * the recorded size, and the streamed sha256 must equal the recorded digest.
 * `dest` is created exclusively (`wx`), so an existing file or symlink there
 * is never overwritten or followed; every chunk is written in full (short
 * writes are continued), and the destination is re-hashed before the copy is
 * reported `copied`; a copy that fails either verification is removed.
 * Memory stays bounded: the copy streams.
 */
export async function copyVerifiedMediaOutput(
  source: string,
  record: Pick<MediaOutputRecord, 'size' | 'sha256'>,
  dest: string,
  maxBytes = MEDIA_REUSE_MAX_BYTES,
): Promise<MediaOutputCopyResult> {
  let input;
  try {
    input = await open(source, WITNESS_OPEN_FLAGS);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') return { kind: 'missing' };
    if (code === 'ELOOP') return { kind: 'mismatch' };
    return { kind: 'unreadable' };
  }
  let output;
  try {
    const stats = await input.stat();
    if (!stats.isFile()) return { kind: 'mismatch' };
    if (record.size !== null && stats.size !== record.size) return { kind: 'mismatch' };
    if (stats.size > maxBytes) return { kind: 'too-large' };
    try {
      output = await open(dest, 'wx');
    } catch (err) {
      return (err as NodeJS.ErrnoException)?.code === 'EEXIST' ? { kind: 'exists' } : { kind: 'unreadable' };
    }
    const hash = createHash('sha256');
    let written = 0;
    for await (const chunk of input.createReadStream({ autoClose: false })) {
      const buffer = chunk as Buffer;
      hash.update(buffer);
      written += buffer.length;
      if (written > maxBytes) throw new Error('source grew past the copy limit');
      // A write may accept fewer bytes than it was given: loop until the whole chunk is down.
      for (let offset = 0; offset < buffer.length;) {
        const { bytesWritten } = await output.write(buffer, offset, buffer.length - offset);
        if (bytesWritten <= 0) throw new Error('the destination accepted no bytes');
        offset += bytesWritten;
      }
    }
    await output.close();
    output = undefined;
    if (hash.digest('hex') !== record.sha256) {
      await unlink(dest).catch(() => {});
      return { kind: 'mismatch' };
    }
    // The source verified; the destination must hold exactly those bytes before the copy counts.
    if (await mediaOutputMatches(dest, { size: written, sha256: record.sha256 }) !== 'match') {
      await unlink(dest).catch(() => {});
      return { kind: 'unreadable' };
    }
    return { kind: 'copied', bytes: written };
  } catch {
    if (output) {
      await output.close().catch(() => {});
      await unlink(dest).catch(() => {});
    }
    return { kind: 'unreadable' };
  } finally {
    await input.close().catch(() => {});
  }
}

/** Resolve a task's recorded output name inside its project directory. */
export function mediaOutputPath(projectDir: string, name: string): string | null {
  const root = path.resolve(projectDir);
  const target = path.resolve(root, name);
  return target !== root && target.startsWith(`${root}${path.sep}`) ? target : null;
}

/** The failure a done task reports once the file it wrote is no longer its. */
export function supersededMediaOutputErrorFor(
  name: string,
  verdict: 'mismatch' | 'missing',
): MediaTaskError {
  const message = verdict === 'missing'
    ? `${name} no longer exists; this task's output was moved or deleted`
    : `${name} was replaced after this task wrote it (another generation used the same --output, or the file was edited)`;
  return {
    message,
    code: MEDIA_OUTPUT_SUPERSEDED_CODE,
    nextStep: mediaFailureNextStep({ code: MEDIA_OUTPUT_SUPERSEDED_CODE, message }),
  };
}

/**
 * Whether a done media task's output, at its recorded name, still holds the
 * bytes THIS task wrote. Returns null when it does (or when the task predates
 * the digest and so cannot be checked), and the failure to report otherwise.
 * Callers that can follow a moved file do so before reporting this.
 */
export async function supersededMediaOutputError(
  projectDir: string,
  file: unknown,
): Promise<MediaTaskError | null> {
  const record = mediaOutputRecord(file);
  if (!record) return null;
  const target = mediaOutputPath(projectDir, record.name);
  if (!target) return supersededMediaOutputErrorFor(record.name, 'missing');
  const verdict = await mediaOutputMatches(target, record);
  if (verdict === 'match' || verdict === 'unreadable') return null;
  return supersededMediaOutputErrorFor(record.name, verdict);
}
