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

import { createReadStream, createWriteStream, promises as fsp } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform, type TransformCallback } from 'node:stream';

import JSZip from 'jszip';

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

  counter(name: string): Transform {
    let file = 0;
    return new Transform({
      transform: (chunk: Buffer, _encoding, callback: TransformCallback) => {
        file += chunk.length;
        this.total += chunk.length;
        if (file > this.limits.fileMaxBytes) return callback(new MishPackError('TOO_LARGE', `the pack file ${describePackPath(name)} is larger than the per-file limit`));
        if (this.total > this.limits.extractedMaxBytes) return callback(new MishPackError('TOO_LARGE', 'the pack expands beyond the size limit'));
        callback(null, chunk);
      },
    });
  }
}

function within(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

async function writeNew(dest: string, source: NodeJS.ReadableStream, counter: Transform): Promise<void> {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await pipeline(source, counter, createWriteStream(dest, { flags: 'wx', mode: 0o644 }));
}

/** Extracts a .zip into `stagingDir` (an existing, empty folder). */
export async function extractMishPackZip(zipFile: string, stagingDir: string, limits: MishPackLimits = DEFAULT_MISH_PACK_LIMITS): Promise<void> {
  const stat = await fsp.stat(zipFile);
  if (stat.size > limits.archiveMaxBytes) throw new MishPackError('TOO_LARGE', 'the pack archive is larger than the size limit');
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(await fsp.readFile(zipFile));
  } catch {
    throw new MishPackError('INVALID_ARCHIVE', 'the file is not a readable .zip archive');
  }
  const budget = new ByteBudget(limits);
  const seen = new Set<string>();
  const root = path.resolve(stagingDir);
  for (const [rawName, entry] of Object.entries(zip.files)) {
    const probe = rawName.endsWith('/') ? rawName.slice(0, -1) : rawName;
    if (probe === '__MACOSX' || probe.startsWith('__MACOSX/')) continue;
    const name = checkArchiveEntryPath(rawName);
    if (isIgnoredPackEntry(name)) continue;
    budget.entry();
    const mode = typeof entry.unixPermissions === 'number' ? entry.unixPermissions & S_IFMT : 0;
    if (mode === S_IFLNK || (mode !== 0 && mode !== S_IFREG && mode !== S_IFDIR)) {
      throw new MishPackError('INVALID_ARCHIVE', `the pack entry ${describePackPath(rawName)} is a link or special file`);
    }
    const folded = name.normalize('NFC').toLowerCase();
    if (seen.has(folded)) throw new MishPackError('INVALID_ARCHIVE', `the pack has two entries that differ only by letter case: ${describePackPath(rawName)}`);
    seen.add(folded);
    const dest = path.resolve(root, ...name.split('/'));
    if (!within(root, dest)) throw unsafe(rawName);
    if (entry.dir) {
      await fsp.mkdir(dest, { recursive: true });
      continue;
    }
    await writeNew(dest, entry.nodeStream('nodebuffer'), budget.counter(name));
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
    else if (entry.isFile()) await fsp.copyFile(from, to);
  }
}
