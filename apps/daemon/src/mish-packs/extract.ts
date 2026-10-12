// Mish packs: bounded, path-checked placement of an untrusted pack source into a staging folder.
//
// A pack is a trusted team packet, but its bytes still arrive from outside. Every rule here holds
// while bytes are written, not afterwards:
//   - entry count, per-file size and the running total are capped;
//   - a zip entry path is checked segment by segment (no absolute path, no `\`, no empty, `.` or
//     `..` segment, no drive letter, no control character) and written with O_EXCL;
//   - links, devices and every other non-regular entry are refused;
//   - two entries that differ only by letter case are refused (they would collide on macOS and
//     Windows);
//   - macOS metadata (`__MACOSX/`, `.DS_Store`, `._*`) and `.git` folders are skipped.
//
// A .zip is read as a stream: the central directory first (ZIP64 included), then one entry at a
// time from disk, inflated and written as it is read. A packet of several gigabytes never sits in
// memory.

import { constants as fsConstants, createReadStream, createWriteStream, promises as fsp } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform, type TransformCallback } from 'node:stream';
import { createInflateRaw } from 'node:zlib';

import yauzl from 'yauzl';

import { MISH_PACK_LIMITS } from '@mish/contracts';

import { MishPackError } from './errors.js';

export interface MishPackLimits {
  archiveMaxBytes: number;
  extractedMaxBytes: number;
  maxEntries: number;
  fileMaxBytes: number;
}

export const DEFAULT_MISH_PACK_LIMITS: Readonly<MishPackLimits> = Object.freeze({
  archiveMaxBytes: MISH_PACK_LIMITS.archiveMaxBytes,
  extractedMaxBytes: MISH_PACK_LIMITS.extractedMaxBytes,
  maxEntries: MISH_PACK_LIMITS.maxEntries,
  fileMaxBytes: MISH_PACK_LIMITS.fileMaxBytes,
});

const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;

/** Names that are metadata, never pack content. */
export function isIgnoredPackEntry(relative: string): boolean {
  const segments = relative.split('/');
  if (segments[0] === '__MACOSX') return true;
  return segments.some((segment) => segment === '.DS_Store' || segment === '.git' || segment.startsWith('._') || segment === 'Thumbs.db');
}

/** JSON-quoted, capped, control-free form of an untrusted path for an error message. */
export function describePackPath(raw: string): string {
  const capped = raw.length > 160 ? `${raw.slice(0, 160)}...` : raw;
  // Control, format (bidi, BOM) and line-separator characters are escaped so a name cannot spoof a message.
  return JSON.stringify(capped).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/**
 * Checks one archive entry path and returns it normalised (POSIX, no trailing slash), or throws
 * UNSAFE_PATH. Exported for tests.
 */
export function checkArchiveEntryPath(raw: string): string {
  // eslint-disable-next-line no-control-regex
  if (raw.length === 0 || raw.length > 1024 || /[\u0000-\u001f\u007f\\]/u.test(raw)) throw unsafe(raw);
  if (raw.startsWith('/') || /^[A-Za-z]:/u.test(raw)) throw unsafe(raw);
  const trimmed = raw.endsWith('/') ? raw.slice(0, -1) : raw;
  const segments = trimmed.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..' || segment.length > 255) throw unsafe(raw);
    if (/[<>:"|?*]/u.test(segment) || /[. ]$/u.test(segment)) throw unsafe(raw);
  }
  return segments.join('/');
}

function unsafe(raw: string): MishPackError {
  return new MishPackError('UNSAFE_PATH', `the pack has an entry with an unsafe path: ${describePackPath(raw)}`);
}

class ByteBudget {
  private total = 0;
  private count = 0;

  constructor(private readonly limits: MishPackLimits) {}

  entry(): void {
    this.count += 1;
    if (this.count > this.limits.maxEntries) throw new MishPackError('TOO_LARGE', 'the pack has too many files');
  }

  /** Counts one file's bytes against the budget. With `expected`, a different final size is refused. */
  counter(name: string, expected?: number): Transform {
    let file = 0;
    return new Transform({
      transform: (chunk: Buffer, _encoding, callback: TransformCallback) => {
        file += chunk.length;
        this.total += chunk.length;
        if (file > this.limits.fileMaxBytes) return callback(new MishPackError('TOO_LARGE', `the pack file ${describePackPath(name)} is larger than the per-file limit`));
        if (this.total > this.limits.extractedMaxBytes) return callback(new MishPackError('TOO_LARGE', 'the pack expands beyond the size limit'));
        if (expected !== undefined && file > expected) return callback(new MishPackError('INVALID_ARCHIVE', `the pack entry ${describePackPath(name)} is damaged`));
        callback(null, chunk);
      },
      flush: (callback: TransformCallback) => {
        if (expected !== undefined && file !== expected) return callback(new MishPackError('INVALID_ARCHIVE', `the pack entry ${describePackPath(name)} is damaged`));
        callback();
      },
    });
  }
}

function within(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

async function writeNew(dest: string, sources: NodeJS.ReadableStream | NodeJS.ReadWriteStream[], counter: Transform): Promise<void> {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const chain: Array<NodeJS.ReadableStream | NodeJS.ReadWriteStream | NodeJS.WritableStream> = Array.isArray(sources) ? [...sources] : [sources];
  chain.push(counter, createWriteStream(dest, { flags: 'wx', mode: 0o644 }));
  await pipeline(chain);
}

const UTF8 = new TextDecoder('utf-8', { fatal: true });
/** `versionMadeBy` host byte for Unix: only then do the high bits of the external attributes hold a file mode. */
const HOST_UNIX = 3;

function openZip(file: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    // decodeStrings: false hands over each name as written, so the checks below see it before any
    // reader normalises it; lazyEntries reads the central directory one entry at a time.
    yauzl.open(file, { lazyEntries: true, autoClose: false, decodeStrings: false, validateEntrySizes: true }, (error, zip) => {
      if (error || !zip) reject(error ?? new Error('no zip'));
      else resolve(zip);
    });
  });
}

/** The entries of an open zip, one at a time, in central-directory order. */
async function* zipEntries(zip: yauzl.ZipFile): AsyncGenerator<yauzl.Entry> {
  let failure: unknown = null;
  // yauzl reports a damaged central directory as an 'error' event; keep one listener for the
  // whole walk so an error between reads is never unhandled.
  const onError = (error: unknown) => { failure = error; };
  zip.on('error', onError);
  try {
    while (true) {
      const next = await new Promise<yauzl.Entry | null>((resolve, reject) => {
        const done = () => { zip.off('entry', onEntry); zip.off('end', onEnd); zip.off('error', onFail); };
        const onEntry = (entry: yauzl.Entry) => { done(); resolve(entry); };
        const onEnd = () => { done(); resolve(null); };
        const onFail = (error: unknown) => { done(); reject(error); };
        zip.on('entry', onEntry);
        zip.on('end', onEnd);
        zip.on('error', onFail);
        if (failure) onFail(failure);
        else zip.readEntry();
      });
      if (!next) return;
      yield next;
    }
  } finally {
    zip.off('error', onError);
  }
}

const LOCAL_HEADER = 0x04034b50;
const LOCAL_HEADER_BYTES = 30;

/**
 * The streams that yield one entry's bytes: a plain read of its stored range, inflated when it is
 * deflated. The entry's local header is read here to find where its data starts. yauzl's own
 * entry streams are not used: its stored-entry stream never ends on current Node, and reading the
 * file directly keeps every byte under the same size checks.
 */
async function entryStreams(zipFile: string, handle: FileHandle, fileSize: number, entry: yauzl.Entry, name: string): Promise<NodeJS.ReadWriteStream[] | NodeJS.ReadableStream> {
  const header = Buffer.alloc(LOCAL_HEADER_BYTES);
  const { bytesRead } = await handle.read(header, 0, LOCAL_HEADER_BYTES, entry.relativeOffsetOfLocalHeader);
  if (bytesRead !== LOCAL_HEADER_BYTES || header.readUInt32LE(0) !== LOCAL_HEADER) {
    throw new MishPackError('INVALID_ARCHIVE', `the pack entry ${describePackPath(name)} is damaged`);
  }
  const start = entry.relativeOffsetOfLocalHeader + LOCAL_HEADER_BYTES + header.readUInt16LE(26) + header.readUInt16LE(28);
  if (start + entry.compressedSize > fileSize) throw new MishPackError('INVALID_ARCHIVE', `the pack entry ${describePackPath(name)} is damaged`);
  const method = entry.compressionMethod;
  if (method !== 0 && method !== 8) throw new MishPackError('INVALID_ARCHIVE', `the pack entry ${describePackPath(name)} uses a compression the daemon does not read`);
  const raw = entry.compressedSize === 0 ? Readable.from([]) : createReadStream(zipFile, { start, end: start + entry.compressedSize - 1 });
  return method === 0 ? raw : [raw as unknown as NodeJS.ReadWriteStream, createInflateRaw()];
}

/** An entry name as written. Anything that is not valid UTF-8 is refused rather than guessed at. */
function entryName(entry: yauzl.Entry): string {
  const raw = entry.fileName as unknown;
  if (typeof raw === 'string') return raw;
  try {
    return UTF8.decode(raw as Buffer);
  } catch {
    throw new MishPackError('UNSAFE_PATH', 'the pack has an entry whose name is not UTF-8');
  }
}

/** Extracts a .zip into `stagingDir` (an existing, empty folder), streaming each entry to disk. */
export async function extractMishPackZip(zipFile: string, stagingDir: string, limits: MishPackLimits = DEFAULT_MISH_PACK_LIMITS): Promise<void> {
  const stat = await fsp.stat(zipFile);
  if (stat.size > limits.archiveMaxBytes) throw new MishPackError('TOO_LARGE', 'the pack archive is larger than the size limit');
  let zip: yauzl.ZipFile;
  try {
    zip = await openZip(zipFile);
  } catch {
    throw new MishPackError('INVALID_ARCHIVE', 'the file is not a readable .zip archive');
  }
  const handle = await fsp.open(zipFile, 'r');
  try {
    if (zip.entryCount > limits.maxEntries) throw new MishPackError('TOO_LARGE', 'the pack has too many files');
    const budget = new ByteBudget(limits);
    const seen = new Set<string>();
    const root = path.resolve(stagingDir);
    for await (const entry of zipEntries(zip)) {
      const rawName = entryName(entry);
      const probe = rawName.endsWith('/') ? rawName.slice(0, -1) : rawName;
      if (probe === '__MACOSX' || probe.startsWith('__MACOSX/')) continue;
      const name = checkArchiveEntryPath(rawName);
      if (isIgnoredPackEntry(name)) continue;
      budget.entry();
      const unixMode = (entry.versionMadeBy >> 8) === HOST_UNIX ? (entry.externalFileAttributes >>> 16) & S_IFMT : 0;
      if (unixMode === S_IFLNK || (unixMode !== 0 && unixMode !== S_IFREG && unixMode !== S_IFDIR)) {
        throw new MishPackError('INVALID_ARCHIVE', `the pack entry ${describePackPath(rawName)} is a link or special file`);
      }
      if (entry.isEncrypted()) throw new MishPackError('INVALID_ARCHIVE', `the pack entry ${describePackPath(rawName)} is encrypted`);
      const folded = name.normalize('NFC').toLowerCase();
      if (seen.has(folded)) throw new MishPackError('INVALID_ARCHIVE', `the pack has two entries that differ only by letter case: ${describePackPath(rawName)}`);
      seen.add(folded);
      const dest = path.resolve(root, ...name.split('/'));
      if (!within(root, dest)) throw unsafe(rawName);
      if (rawName.endsWith('/') || unixMode === S_IFDIR) {
        await fsp.mkdir(dest, { recursive: true });
        continue;
      }
      // The declared size is checked up front; the counter still enforces the real bytes.
      if (entry.uncompressedSize > limits.fileMaxBytes) throw new MishPackError('TOO_LARGE', `the pack file ${describePackPath(name)} is larger than the per-file limit`);
      await writeNew(dest, await entryStreams(zipFile, handle, stat.size, entry, name), budget.counter(name, entry.uncompressedSize));
    }
  } finally {
    await handle.close();
    zip.close();
  }
}

/** Copies a folder tree into `stagingDir`, refusing links and special files. */
export async function copyMishPackFolder(source: string, stagingDir: string, limits: MishPackLimits = DEFAULT_MISH_PACK_LIMITS): Promise<void> {
  const budget = new ByteBudget(limits);
  const root = path.resolve(stagingDir);
  const walk = async (dir: string, relative: string): Promise<void> => {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const rel = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (isIgnoredPackEntry(rel)) continue;
      const checked = checkArchiveEntryPath(rel);
      const abs = path.join(dir, entry.name);
      const info = await fsp.lstat(abs);
      if (info.isSymbolicLink()) throw new MishPackError('INVALID_ARCHIVE', `the pack entry ${describePackPath(rel)} is a link`);
      budget.entry();
      const dest = path.resolve(root, ...checked.split('/'));
      if (!within(root, dest)) throw unsafe(rel);
      if (info.isDirectory()) {
        await fsp.mkdir(dest, { recursive: true });
        await walk(abs, checked);
      } else if (info.isFile()) {
        await writeNew(dest, createReadStream(abs), budget.counter(checked));
      } else {
        throw new MishPackError('INVALID_ARCHIVE', `the pack entry ${describePackPath(rel)} is a special file`);
      }
    }
  };
  await walk(path.resolve(source), '');
}

/**
 * Copies `sourceDir` to `destDir` for activation (folders the daemon scans from a user root).
 * Links and special files are skipped, never followed.
 */
export async function copyTreeNoLinks(sourceDir: string, destDir: string): Promise<void> {
  await fsp.mkdir(destDir, { recursive: true });
  for (const entry of await fsp.readdir(sourceDir, { withFileTypes: true })) {
    const from = path.join(sourceDir, entry.name);
    const to = path.join(destDir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) await copyTreeNoLinks(from, to);
    // A copy-on-write clone where the filesystem has one (APFS, btrfs): gigabytes of project
    // folders then cost no extra space. Elsewhere it falls back to a plain copy.
    else if (entry.isFile()) await fsp.copyFile(from, to, fsConstants.COPYFILE_FICLONE);
  }
}
