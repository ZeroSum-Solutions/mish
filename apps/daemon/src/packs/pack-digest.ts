// `od pack digest`: the sha256 a local pack install needs, computed on the
// author's own disk (team drop-in QA, 2026-10-08).
//
// - A folder's digest is the sha256 of its canonical pack.json
//   (`packManifestDigest`), the value a folder install checks. It is not the
//   sha256 of the pack.json bytes, so `shasum pack.json` cannot produce it.
//   Before printing it, every files[] entry is checked against the disk, so a
//   file edited after pack.json was written is named here instead of failing
//   the install with INTEGRITY_MISMATCH and no file name.
// - An archive's digest is the sha256 of the file bytes, the value of a
//   `<file>.sha256` sidecar.
//
// Both refuse what an install refuses (FU-15): a folder whose listed paths
// pass through a link fails INVALID_ARCHIVE through the installer's own
// `assertFolderSourceSafe`, and a path that is neither a folder nor a regular
// file (a FIFO, a device) is not hashed. A read failure is a fixed message
// without the path, never a raw fs error.
//
// This reads only local files and never talks to the daemon. There is no
// HTTP/UI twin on purpose: it is an authoring step, and a web form that hashed
// the very file it uploads would make the fail-closed sha256 check vacuous.

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';

import { PACK_MANIFEST_FILENAME } from '@open-design/contracts';

import { assertFolderSourceSafe } from './archive.js';
import { isPackError, PackError, readPackManifestFile } from './manifest.js';

export interface PackFileMismatch {
  index: number;
  path: string;
  expectedBytes: number;
  expectedSha256: string;
  /** null when the file is missing. */
  actualBytes: number | null;
  actualSha256: string | null;
  problem: 'missing' | 'changed';
}

export type PackDigestResult =
  | { ok: true; kind: 'archive'; sha256: string }
  | { ok: true; kind: 'folder'; sha256: string; id: string; version: string }
  | { ok: false; kind: 'folder'; id: string; version: string; mismatches: PackFileMismatch[] }
  | { ok: false; kind: 'folder' | 'archive'; code: string; message: string };

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

const unreadable = {
  archive: () => new PackError('BAD_REQUEST', 'the pack archive could not be read'),
  folder: () => new PackError('BAD_REQUEST', 'the pack folder could not be read'),
  file: () => new PackError('INTERNAL_ERROR', 'a pack file could not be read'),
};

async function hashOr(filePath: string, failure: () => PackError): Promise<string> {
  try {
    return await sha256File(filePath);
  } catch {
    throw failure();
  }
}

/**
 * Check one files[] entry. The installer's no-link check runs first, on
 * every parent and the file itself, so nothing outside the pack root is
 * read; it throws `INVALID_ARCHIVE` for a link or special file, which fails
 * the digest the way it fails the install.
 */
async function checkListedFile(
  root: string,
  index: number,
  entry: { path: string; bytes: number; sha256: string },
): Promise<PackFileMismatch | null> {
  const base = { index, path: entry.path, expectedBytes: entry.bytes, expectedSha256: entry.sha256 };
  try {
    assertFolderSourceSafe(root, [entry.path]);
  } catch (error) {
    if (isPackError(error) && error.code === 'INTEGRITY_MISMATCH') {
      return { ...base, actualBytes: null, actualSha256: null, problem: 'missing' };
    }
    throw error;
  }
  const filePath = path.join(root, ...entry.path.split('/'));
  let size: number;
  try {
    size = (await stat(filePath)).size;
  } catch {
    throw unreadable.file();
  }
  const actualSha256 = await hashOr(filePath, unreadable.file);
  if (size === entry.bytes && actualSha256 === entry.sha256) return null;
  return { ...base, actualBytes: size, actualSha256, problem: 'changed' };
}

/** Digest of a pack folder or archive at an absolute path that exists. */
export async function computePackDigest(absPath: string): Promise<PackDigestResult> {
  let info;
  try {
    info = await stat(absPath);
  } catch {
    return failed('archive', unreadable.archive());
  }
  if (info.isDirectory()) {
    try {
      return await folderDigest(absPath);
    } catch (error) {
      if (isPackError(error)) return failed('folder', error);
      return failed('folder', unreadable.folder());
    }
  }
  if (!info.isFile()) {
    return failed('archive', new PackError('BAD_REQUEST', 'the path is not a pack folder or archive (not a folder or regular file)'));
  }
  try {
    return { ok: true, kind: 'archive', sha256: await hashOr(absPath, unreadable.archive) };
  } catch (error) {
    return failed('archive', isPackError(error) ? error : unreadable.archive());
  }
}

function failed(kind: 'folder' | 'archive', error: PackError): PackDigestResult {
  return { ok: false, kind, code: error.code, message: error.message };
}

async function folderDigest(absPath: string): Promise<PackDigestResult> {
  const read = readPackManifestFile(path.join(absPath, PACK_MANIFEST_FILENAME));
  const { manifest } = read;
  const mismatches: PackFileMismatch[] = [];
  for (const [index, entry] of manifest.files.entries()) {
    const mismatch = await checkListedFile(absPath, index, entry);
    if (mismatch) mismatches.push(mismatch);
  }
  if (mismatches.length > 0) return { ok: false, kind: 'folder', id: manifest.id, version: manifest.version, mismatches };
  return { ok: true, kind: 'folder', sha256: read.digest, id: manifest.id, version: manifest.version };
}

/** One stderr line per mismatching files[] entry. */
export function describeMismatch(mismatch: PackFileMismatch): string {
  const head = `files[${mismatch.index}] ${mismatch.path}`;
  if (mismatch.problem === 'missing') return `${head}: the file is missing`;
  return `${head}: pack.json says ${mismatch.expectedBytes} bytes, sha256 ${mismatch.expectedSha256}; the file is ${mismatch.actualBytes} bytes, sha256 ${mismatch.actualSha256}`;
}
