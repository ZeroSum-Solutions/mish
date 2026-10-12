// Licensed packs: bounded archive extraction and safe file placement.
//
// A pack archive is untrusted input (a GitHub tarball or an offline .tgz).
// Extraction here is new code, not the plugin installer's extractor, because
// every budget must hold while bytes are written, not afterwards:
//
//   - the archive is read through a counter (archive byte cap) and hashed in
//     the same pass, so the digest covers exactly the bytes extracted;
//   - gzip output passes a second counter (decompressed byte cap) before the
//     tar parser sees it;
//   - each entry header is checked before its body is written: entry count,
//     per-file size, and the running total of file sizes;
//   - only regular files and directories are written. Symlinks, hard links,
//     devices, FIFOs and every other type are refused;
//   - every entry path is checked segment by segment (no absolute path, no
//     `\`, no empty, `.` or `..` segment, no control character) and each file
//     is created with O_EXCL | O_NOFOLLOW inside the destination;
//   - every entry, listed in pack.json or not, must be portable (no `:`, no
//     trailing dot or space, no Windows device name) and must not alias an
//     earlier entry by letter case or Unicode normalisation;
//   - macOS metadata that BSD tar and Finder add (the bare `.`/`./` root
//     folder, anything under `__MACOSX/`, and a `._<name>` file whose body
//     starts with the AppleDouble magic) is skipped, never written, and only
//     after the type, path and byte-cap checks above have passed, so a
//     skipped-looking name cannot hide a link, a traversal or extra bytes. A
//     `._<name>` file without the magic is ordinary content;
//   - every refusal names the offending entry, JSON-quoted and capped
//     (`describeEntry`), so an untrusted name cannot inject control or
//     direction-changing characters into a message.
//
// After extraction the service verifies and places only the files `pack.json`
// lists (`placeVerifiedFiles`). Folder sources skip extraction: every listed
// path is checked with lstat before a single byte is copied
// (`assertFolderSourceSafe`), and each copy is hashed from the same file
// descriptor whose identity was checked.

import { createHash, type Hash } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  createReadStream,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  writeSync,
} from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';

import { Parser, type ReadEntry } from 'tar';

import {
  PACK_ARCHIVE_MAX_BYTES,
  PACK_EXTRACTED_MAX_BYTES,
  PACK_FILE_MAX_BYTES,
  PACK_MANIFEST_FILENAME,
  PACK_MAX_ENTRIES,
  PACK_RELATIVE_PATH_PATTERN,
  packPathCollisionKey,
  type PackFileEntry,
} from '@mish/contracts';

import { O_NOFOLLOW, PackError } from './manifest.js';

const MIB = 1024 * 1024;

export interface PackArchiveLimits {
  /** Bytes of the archive file itself. */
  archiveMaxBytes: number;
  /** Sum of the sizes of extracted regular files. */
  extractedMaxBytes: number;
  /** Tar entries of any type. */
  maxEntries: number;
  /** One regular file. */
  fileMaxBytes: number;
  /**
   * Bytes out of the decompressor. Defaults to `extractedMaxBytes` plus room
   * for tar headers and padding; it also bounds data no entry claims.
   */
  decompressedMaxBytes?: number;
}

export const DEFAULT_PACK_LIMITS: Readonly<PackArchiveLimits> = Object.freeze({
  archiveMaxBytes: PACK_ARCHIVE_MAX_BYTES,
  extractedMaxBytes: PACK_EXTRACTED_MAX_BYTES,
  maxEntries: PACK_MAX_ENTRIES,
  fileMaxBytes: PACK_FILE_MAX_BYTES,
});

function decompressedCap(limits: PackArchiveLimits): number {
  if (limits.decompressedMaxBytes !== undefined) return limits.decompressedMaxBytes;
  // Headers (512 B), pax/long-name records and block padding: bounded by entries.
  return limits.extractedMaxBytes + Math.min(limits.maxEntries * 2048, 128 * MIB) + MIB;
}

export interface ExtractPackArchiveResult {
  /** sha256 hex of the archive bytes read. */
  archiveSha256: string;
  archiveBytes: number;
  extractedBytes: number;
  entries: number;
}

const ALLOWED_FILE_TYPES = new Set(['File', 'OldFile', 'ContiguousFile']);
const MAX_ENTRY_PATH_LENGTH = 1024;

const MAX_NAMED_ENTRY_LENGTH = 200;
// JSON.stringify escapes C0 controls and quotes; these it leaves raw: C1
// controls, line and paragraph separators, BOM, and every Bidi_Control
// character (U+061C, U+200E/F, U+202A-E, U+2066-9).
// eslint-disable-next-line no-control-regex
const UNSAFE_MESSAGE_CHARS = /[\u007f-\u009f\u2028\u2029\ufeff\p{Bidi_Control}]/gu;

/**
 * An untrusted archive entry path as it may appear in an error message:
 * capped, JSON-quoted, with control, line-separator and bidirectional
 * characters escaped as `\uXXXX`.
 */
export function describeEntry(rawPath: string): string {
  const capped = rawPath.length > MAX_NAMED_ENTRY_LENGTH ? `${rawPath.slice(0, MAX_NAMED_ENTRY_LENGTH)}...` : rawPath;
  return JSON.stringify(capped).replace(
    UNSAFE_MESSAGE_CHARS,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

const tooLarge = {
  archive: () => new PackError('TOO_LARGE', 'the pack archive exceeds the size limit'),
  decompressed: () => new PackError('TOO_LARGE', 'the pack archive expands beyond the size limit'),
  entries: () => new PackError('TOO_LARGE', 'the pack archive has too many entries'),
  file: (entry: string) =>
    new PackError('TOO_LARGE', `the pack archive entry ${describeEntry(entry)} exceeds the per-file size limit`),
  total: (entry: string) =>
    new PackError('TOO_LARGE', `the pack archive expands beyond the size limit at entry ${describeEntry(entry)}`),
};

const invalid = {
  type: (entry: string) =>
    new PackError(
      'INVALID_ARCHIVE',
      `the pack archive entry ${describeEntry(entry)} is a link, device or other entry that is not a file or folder`,
    ),
  path: (entry: string) =>
    new PackError('INVALID_ARCHIVE', `the pack archive entry ${describeEntry(entry)} has an unsafe path`),
  duplicate: (entry: string) =>
    new PackError(
      'INVALID_ARCHIVE',
      `the pack archive entry ${describeEntry(entry)} repeats an earlier path (letter case and Unicode normalisation count as the same path)`,
    ),
  format: () => new PackError('INVALID_ARCHIVE', 'the file is not a readable tar or tar.gz archive'),
  layout: () => new PackError('INVALID_ARCHIVE', 'the pack has no pack.json at its root or inside one top-level folder'),
  folderLink: () => new PackError('INVALID_ARCHIVE', 'the pack folder holds a link or special file where a listed file should be'),
};

/**
 * Split an archive entry path into safe segments, or null. A single leading
 * `./` is accepted (tar run on `.`); a trailing `/` is accepted on folders.
 * The archive root folder itself (`.` or `./`, as BSD tar writes it) yields
 * no segments; a root that is not a folder is refused.
 */
export function safeEntrySegments(rawPath: string, isDirectory: boolean): string[] | null {
  let value = rawPath;
  if (value.length === 0 || value.length > MAX_ENTRY_PATH_LENGTH) return null;
  if (value === '.') return isDirectory ? [] : null;
  if (value.startsWith('./')) value = value.slice(2);
  if (isDirectory && value.endsWith('/')) value = value.slice(0, -1);
  if (value.length === 0) return isDirectory ? [] : null;
  // eslint-disable-next-line no-control-regex
  if (value.startsWith('/') || value.includes('\\') || /[\u0000-\u001f\u007f]/.test(value)) return null;
  const segments = value.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') return null;
  }
  return segments;
}

/** The AppleDouble header magic (RFC 1740), big-endian 0x00051607. */
const APPLE_DOUBLE_MAGIC = Buffer.from([0x00, 0x05, 0x16, 0x07]);

/**
 * Finder's zip layout keeps macOS metadata under a top-level `__MACOSX/`; a
 * pack never needs it. Takes segments that already passed
 * `safeEntrySegments`, so the name check cannot be reached by a traversal.
 */
export function isMacosxEntry(segments: readonly string[]): boolean {
  return segments.length > 0 && segments[0] === '__MACOSX';
}

/**
 * A name BSD tar (COPYFILE_DISABLE unset) and Finder use for AppleDouble
 * sidecars. The name alone is not enough: such a file is skipped only when
 * `hasAppleDoubleMagic` holds for its body, so a pack may ship `._config`.
 */
export function isAppleDoubleName(segments: readonly string[]): boolean {
  return segments.length > 0 && segments[segments.length - 1]!.startsWith('._');
}

export function hasAppleDoubleMagic(head: Buffer): boolean {
  return head.length >= APPLE_DOUBLE_MAGIC.length && head.subarray(0, APPLE_DOUBLE_MAGIC.length).equals(APPLE_DOUBLE_MAGIC);
}

// Every segment portable to macOS, Linux and Windows: no `:`, no trailing dot
// or space, no Windows device name (with or without an extension).
const PORTABLE_ENTRY_PATH_RE = new RegExp(PACK_RELATIVE_PATH_PATTERN, 'u');

/**
 * Claims entry paths by their collision key (letter case and Unicode
 * normalisation folded), for every archive entry, listed in pack.json or not.
 * A folder may be claimed again with the same spelling; anything else that
 * folds onto a claimed key is an alias and is refused.
 */
class EntryPathClaims {
  private readonly claimed = new Map<string, { spelling: string; folder: boolean }>();

  claim(segments: string[], isDirectory: boolean): boolean {
    for (let i = 1; i <= segments.length; i += 1) {
      const spelling = segments.slice(0, i).join('/');
      const folder = i < segments.length || isDirectory;
      const key = packPathCollisionKey(spelling);
      const previous = this.claimed.get(key);
      if (!previous) {
        this.claimed.set(key, { spelling, folder });
        continue;
      }
      if (!folder || !previous.folder || previous.spelling !== spelling) return false;
    }
    return true;
  }
}

class ByteCounter extends Transform {
  bytes = 0;

  constructor(
    private readonly max: number,
    private readonly onOverflow: () => PackError,
    private readonly hash?: Hash,
    private readonly onBytes?: (bytes: number) => void,
  ) {
    super();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.bytes += chunk.length;
    if (this.bytes > this.max) {
      callback(this.onOverflow());
      return;
    }
    this.hash?.update(chunk);
    this.onBytes?.(this.bytes);
    callback(null, chunk);
  }
}

function hasGzipMagic(archivePath: string): boolean {
  const fd = openSync(archivePath, fsConstants.O_RDONLY | O_NOFOLLOW);
  try {
    const head = Buffer.alloc(2);
    const read = readSync(fd, head, 0, 2, 0);
    return read === 2 && head[0] === 0x1f && head[1] === 0x8b;
  } finally {
    closeSync(fd);
  }
}

/**
 * Extract a tar or tar.gz into `destDir` (which must exist and be empty)
 * under `limits`. Throws `PackError` (`TOO_LARGE`, `INVALID_ARCHIVE`,
 * `CANCELLED`, `INTERNAL_ERROR`). On failure, files already written stay in
 * `destDir`; the caller owns and removes that directory.
 */
export async function extractPackArchive(opts: {
  archivePath: string;
  destDir: string;
  limits?: PackArchiveLimits | undefined;
  signal?: AbortSignal | undefined;
  /** Archive bytes read so far, and the archive size. */
  onProgress?: (bytesRead: number, totalBytes: number) => void;
}): Promise<ExtractPackArchiveResult> {
  const limits = opts.limits ?? DEFAULT_PACK_LIMITS;
  const destDir = path.resolve(opts.destDir);
  if (opts.signal?.aborted) throw new PackError('CANCELLED', 'the pack install was cancelled');

  let archiveSize: number;
  let gzip: boolean;
  try {
    const stat = lstatSync(opts.archivePath);
    if (!stat.isFile()) throw invalid.format();
    archiveSize = stat.size;
    if (archiveSize > limits.archiveMaxBytes) throw tooLarge.archive();
    gzip = hasGzipMagic(opts.archivePath);
  } catch (error) {
    if (error instanceof PackError) throw error;
    throw new PackError('BAD_REQUEST', 'the pack archive could not be read');
  }

  const hash = createHash('sha256');
  const rawCounter = new ByteCounter(limits.archiveMaxBytes, tooLarge.archive, hash, (bytes) =>
    opts.onProgress?.(bytes, archiveSize),
  );
  const tarCounter = new ByteCounter(decompressedCap(limits), tooLarge.decompressed);

  let failure: PackError | null = null;
  let entries = 0;
  let extractedBytes = 0;
  let openFd: number | null = null;
  const fail = (error: PackError): void => {
    if (!failure) failure = error;
  };
  const closeOpen = (): void => {
    if (openFd !== null) {
      try {
        closeSync(openFd);
      } catch {
        // already closed
      }
      openFd = null;
    }
  };

  const claims = new EntryPathClaims();

  /**
   * Check a content entry's name (portable, not an alias of an earlier entry,
   * inside `destDir`) and create it: a folder, or a file opened
   * O_EXCL | O_NOFOLLOW whose descriptor becomes `openFd`. Returns that
   * descriptor, or null for a folder or a refusal (already recorded).
   */
  const createEntry = (entry: ReadEntry, segments: string[], isDirectory: boolean): number | null => {
    if (!PORTABLE_ENTRY_PATH_RE.test(segments.join('/'))) {
      fail(invalid.path(entry.path));
      return null;
    }
    if (!claims.claim(segments, isDirectory)) {
      fail(invalid.duplicate(entry.path));
      return null;
    }
    const target = path.join(destDir, ...segments);
    if (!target.startsWith(destDir + path.sep)) {
      fail(invalid.path(entry.path));
      return null;
    }
    try {
      if (isDirectory) {
        mkdirSync(target, { recursive: true, mode: 0o755 });
        return null;
      }
      mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
      const fd = openSync(target, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW, 0o644);
      openFd = fd;
      return fd;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST' || code === 'ENOTDIR' || code === 'EISDIR' || code === 'ELOOP') fail(invalid.duplicate(entry.path));
      else fail(new PackError('INTERNAL_ERROR', 'the pack archive could not be written to the staging folder'));
      return null;
    }
  };

  const writeChunk = (fd: number, chunk: Buffer): void => {
    if (failure || openFd !== fd) return;
    try {
      let offset = 0;
      while (offset < chunk.length) offset += writeSync(fd, chunk, offset, chunk.length - offset);
    } catch {
      fail(new PackError('INTERNAL_ERROR', 'the pack archive could not be written to the staging folder'));
    }
  };

  const onEntry = (entry: ReadEntry): void => {
    if (failure) {
      entry.resume();
      return;
    }
    entries += 1;
    if (entries > limits.maxEntries) {
      fail(tooLarge.entries());
      entry.resume();
      return;
    }
    const isDirectory = entry.type === 'Directory';
    // Type, path and byte caps hold for every entry, skipped ones included.
    if (!isDirectory && !ALLOWED_FILE_TYPES.has(entry.type)) {
      fail(invalid.type(entry.path));
      entry.resume();
      return;
    }
    const segments = safeEntrySegments(entry.path, isDirectory);
    if (!segments) {
      fail(invalid.path(entry.path));
      entry.resume();
      return;
    }
    if (segments.length === 0) {
      // The archive root folder (`.` or `./`): nothing to write.
      entry.resume();
      return;
    }
    const size = isDirectory ? 0 : (entry.size ?? 0);
    if (size > limits.fileMaxBytes) {
      fail(tooLarge.file(entry.path));
      entry.resume();
      return;
    }
    if (extractedBytes + size > limits.extractedMaxBytes) {
      fail(tooLarge.total(entry.path));
      entry.resume();
      return;
    }
    extractedBytes += size;
    if (isMacosxEntry(segments)) {
      entry.resume();
      return;
    }
    if (isDirectory) {
      createEntry(entry, segments, true);
      entry.resume();
      return;
    }

    // A `._<name>` file is skipped only when its body starts with the
    // AppleDouble magic; otherwise it is ordinary content. Its first bytes
    // are held until that is known, and nothing is created before then.
    let head: Buffer | null = isAppleDoubleName(segments) ? Buffer.alloc(0) : null;
    let fd: number | null = null;
    if (head === null) {
      fd = createEntry(entry, segments, false);
      if (fd === null) {
        entry.resume();
        return;
      }
    }
    const decide = (): void => {
      const pending = head ?? Buffer.alloc(0);
      head = null;
      if (hasAppleDoubleMagic(pending)) return;
      fd = createEntry(entry, segments, false);
      if (fd !== null) writeChunk(fd, pending);
    };
    let written = 0;
    entry.on('data', (chunk: Buffer) => {
      if (failure) return;
      written += chunk.length;
      if (written > size) {
        fail(tooLarge.file(entry.path));
        return;
      }
      if (head !== null) {
        head = Buffer.concat([head, chunk]);
        if (head.length >= APPLE_DOUBLE_MAGIC.length) decide();
        return;
      }
      if (fd !== null) writeChunk(fd, chunk);
    });
    entry.on('end', () => {
      if (head !== null && !failure) decide();
      if (fd !== null && openFd === fd) closeOpen();
    });
  };

  const parser = new Parser({ strict: true });
  parser.on('entry', onEntry);
  let parserError: unknown = null;
  const parserDone = new Promise<void>((resolve) => {
    parser.on('error', (error: unknown) => {
      parserError ??= error;
      resolve();
    });
    parser.on('end', () => resolve());
    parser.on('close', () => resolve());
  });

  const consume = async (source: AsyncIterable<Buffer>): Promise<void> => {
    for await (const chunk of source) {
      if (opts.signal?.aborted) throw new PackError('CANCELLED', 'the pack install was cancelled');
      if (failure) throw failure;
      if (parserError) throw invalid.format();
      parser.write(chunk);
      if (failure) throw failure;
    }
    parser.end();
    await parserDone;
  };
  const pipelineOptions = opts.signal ? { signal: opts.signal } : {};

  try {
    // Open without following a final symlink; the stream owns and closes the fd.
    const fd = openSync(opts.archivePath, fsConstants.O_RDONLY | O_NOFOLLOW);
    const source = createReadStream(opts.archivePath, { fd, highWaterMark: 256 * 1024, autoClose: true });
    if (gzip) await pipeline(source, rawCounter, createGunzip(), tarCounter, consume, pipelineOptions);
    else await pipeline(source, rawCounter, tarCounter, consume, pipelineOptions);
  } catch (error) {
    closeOpen();
    if (failure) throw failure;
    if (error instanceof PackError) throw error;
    if (opts.signal?.aborted) throw new PackError('CANCELLED', 'the pack install was cancelled');
    throw invalid.format();
  }
  closeOpen();
  if (failure) throw failure;
  if (parserError) throw invalid.format();

  return { archiveSha256: hash.digest('hex'), archiveBytes: rawCounter.bytes, extractedBytes, entries };
}

/**
 * The folder holding `pack.json`: the extraction root itself, or its only
 * top-level entry when that is a folder (the GitHub tarball shape,
 * `<owner>-<repo>-<sha>/`).
 */
export function findPackRoot(extractDir: string): string {
  const isFile = (target: string): boolean => {
    try {
      return lstatSync(target).isFile();
    } catch {
      return false;
    }
  };
  if (isFile(path.join(extractDir, PACK_MANIFEST_FILENAME))) return extractDir;
  const top = readdirSync(extractDir, { withFileTypes: true });
  if (top.length === 1 && top[0]!.isDirectory()) {
    const wrapper = path.join(extractDir, top[0]!.name);
    if (isFile(path.join(wrapper, PACK_MANIFEST_FILENAME))) return wrapper;
  }
  throw invalid.layout();
}

export interface FolderFileIdentity {
  dev: number;
  ino: number;
}

/**
 * Check every listed path in a folder source before anything is copied: each
 * parent must be a real folder and each file a regular file, with no symlink
 * at any level. Returns each file's (dev, ino) so the copy can prove it opened
 * the same file. Throws `INVALID_ARCHIVE` for a link or special file and
 * `INTEGRITY_MISMATCH` for a missing file.
 */
export function assertFolderSourceSafe(root: string, filePaths: readonly string[]): Map<string, FolderFileIdentity> {
  const identities = new Map<string, FolderFileIdentity>();
  const checkedDirs = new Set<string>();
  for (const rel of filePaths) {
    const segments = rel.split('/');
    let current = root;
    for (let i = 0; i < segments.length; i++) {
      current = path.join(current, segments[i]!);
      const last = i === segments.length - 1;
      if (!last && checkedDirs.has(current)) continue;
      let stat;
      try {
        stat = lstatSync(current);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') {
          throw new PackError('INTEGRITY_MISMATCH', 'a file listed in pack.json is missing');
        }
        throw new PackError('INTERNAL_ERROR', 'the pack folder could not be read');
      }
      if (last) {
        if (!stat.isFile()) throw invalid.folderLink();
        identities.set(rel, { dev: stat.dev, ino: stat.ino });
      } else {
        if (!stat.isDirectory()) throw invalid.folderLink();
        checkedDirs.add(current);
      }
    }
  }
  return identities;
}

const COPY_CHUNK = 1024 * 1024;

function integrityFailure(): PackError {
  return new PackError('INTEGRITY_MISMATCH', 'a file does not match its sha256 or size in pack.json');
}

/**
 * Verify every listed file in `sourceRoot` against its `bytes` and `sha256`
 * and place it at the same relative path under `destRoot`. `move` renames
 * (the source is the daemon's own extraction tree, on the same volume);
 * `copy` copies while hashing, from the descriptor whose identity
 * `identities` vouches for. Nothing unlisted is placed.
 */
export async function placeVerifiedFiles(opts: {
  sourceRoot: string;
  destRoot: string;
  files: readonly PackFileEntry[];
  mode: 'move' | 'copy';
  identities?: Map<string, FolderFileIdentity>;
  signal?: AbortSignal | undefined;
  onProgress?: (filesDone: number, totalFiles: number) => void;
}): Promise<void> {
  const total = opts.files.length;
  let done = 0;
  const buffer = Buffer.alloc(COPY_CHUNK);
  for (const file of opts.files) {
    if (opts.signal?.aborted) throw new PackError('CANCELLED', 'the pack install was cancelled');
    const segments = file.path.split('/');
    const source = path.join(opts.sourceRoot, ...segments);
    const dest = path.join(opts.destRoot, ...segments);
    let fd: number;
    try {
      fd = openSync(source, fsConstants.O_RDONLY | O_NOFOLLOW);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        throw new PackError('INTEGRITY_MISMATCH', 'a file listed in pack.json is missing');
      }
      if (code === 'ELOOP') throw invalid.folderLink();
      throw new PackError('INTERNAL_ERROR', 'a pack file could not be read');
    }
    let out: number | null = null;
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile()) throw opts.mode === 'copy' ? invalid.folderLink() : integrityFailure();
      const expected = opts.identities?.get(file.path);
      if (expected && (expected.dev !== stat.dev || expected.ino !== stat.ino)) throw invalid.folderLink();
      if (stat.size !== file.bytes) throw integrityFailure();
      await fsp.mkdir(path.dirname(dest), { recursive: true, mode: 0o755 });
      if (opts.mode === 'copy') {
        out = openSync(dest, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW, 0o644);
      }
      const hash = createHash('sha256');
      let position = 0;
      for (;;) {
        const read = readSync(fd, buffer, 0, buffer.length, position);
        if (read === 0) break;
        position += read;
        if (position > file.bytes) throw integrityFailure();
        hash.update(buffer.subarray(0, read));
        if (out !== null) {
          let offset = 0;
          while (offset < read) offset += writeSync(out, buffer, offset, read - offset);
        }
        // Let other work run between chunks of a large file.
        if (position % (8 * COPY_CHUNK) === 0) await new Promise<void>((resolve) => setImmediate(resolve));
      }
      if (position !== file.bytes || hash.digest('hex') !== file.sha256) throw integrityFailure();
    } finally {
      closeSync(fd);
      if (out !== null) closeSync(out);
    }
    if (opts.mode === 'move') {
      try {
        await fsp.rename(source, dest);
      } catch {
        throw new PackError('INTERNAL_ERROR', 'a pack file could not be moved into the staging folder');
      }
    }
    done += 1;
    opts.onProgress?.(done, total);
  }
}
