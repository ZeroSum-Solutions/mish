// Licensed packs: reading `pack.json` from disk, the pack digest, and the one
// error type every pack module throws.
//
// The schema itself is pure and lives in `@mish/contracts`
// (`packages/contracts/src/api/packs.ts`). This module adds the Node side:
// a byte cap enforced before parsing, a no-follow open, and sha256.

import { createHash } from 'node:crypto';
import { closeSync, constants as fsConstants, fstatSync, openSync, readSync } from 'node:fs';

import {
  canonicalPackManifestJson,
  PACK_MANIFEST_MAX_BYTES,
  parsePackManifest,
  type PackInstallErrorCode,
  type PackManifest,
  type PackRemoveErrorCode,
} from '@mish/contracts';

export type PackErrorCode = PackInstallErrorCode | PackRemoveErrorCode;

/**
 * Every pack failure. `message` is a fixed template (plus, at most, a pack id
 * or a manifest field path): it never carries a URL, a token, an absolute
 * path or a name taken from an archive entry. No `cause` is attached.
 */
export class PackError extends Error {
  readonly code: PackErrorCode;
  /** Warnings gathered before the failure (handler warnings, for example). */
  warnings: string[];

  constructor(code: PackErrorCode, message: string, warnings: string[] = []) {
    super(message);
    this.name = 'PackError';
    this.code = code;
    this.warnings = warnings;
  }
}

export function isPackError(value: unknown): value is PackError {
  return value instanceof PackError;
}

/** `O_NOFOLLOW` where the platform has it (not on Windows). */
export const O_NOFOLLOW: number = fsConstants.O_NOFOLLOW ?? 0;

/** sha256 hex of the canonical manifest text: the digest a receipt records. */
export function packManifestDigest(manifest: PackManifest): string {
  return createHash('sha256').update(canonicalPackManifestJson(manifest)).digest('hex');
}

export interface ReadPackManifestResult {
  manifest: PackManifest;
  /** The exact bytes read. */
  bytes: Buffer;
  /** sha256 hex of `bytes` (compared with P1-3's `expectedManifestSha256`). */
  bytesSha256: string;
  /** `packManifestDigest(manifest)`. */
  digest: string;
}

const MAX_ISSUES_IN_MESSAGE = 3;
const MAX_ISSUE_LENGTH = 160;

function invalidManifestMessage(issues: string[]): string {
  const shown = issues
    .slice(0, MAX_ISSUES_IN_MESSAGE)
    .map((issue) => (issue.length > MAX_ISSUE_LENGTH ? `${issue.slice(0, MAX_ISSUE_LENGTH)}…` : issue))
    // Field paths and our own messages only; strip anything URL- or path-shaped a key could smuggle in.
    .map((issue) => issue.replace(/[a-z][a-z0-9+.-]*:\/\/\S*/gi, '<url>'));
  return `pack.json is not a valid mishh-pack@1 manifest: ${shown.join('; ')}`;
}

/**
 * Read and validate a `pack.json`. The file is opened without following a
 * final symlink, must be a regular file, and is refused with `TOO_LARGE` from
 * its size alone, before any byte is parsed. Synchronous: manifests are small
 * and the registry answers synchronously.
 */
export function readPackManifestFile(
  filePath: string,
  options: { maxBytes?: number } = {},
): ReadPackManifestResult {
  const maxBytes = options.maxBytes ?? PACK_MANIFEST_MAX_BYTES;
  let fd: number;
  try {
    fd = openSync(filePath, fsConstants.O_RDONLY | O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new PackError('INVALID_MANIFEST', 'pack.json is missing');
    throw new PackError('INVALID_MANIFEST', 'pack.json could not be opened as a regular file');
  }
  let bytes: Buffer;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new PackError('INVALID_MANIFEST', 'pack.json is not a regular file');
    if (stat.size > maxBytes) throw new PackError('TOO_LARGE', 'pack.json exceeds the manifest size limit');
    // Read at most maxBytes + 1, so a file that grows after fstat is still caught.
    const buffer = Buffer.alloc(Math.min(stat.size, maxBytes) + 1);
    let length = 0;
    for (;;) {
      const read = readSync(fd, buffer, length, buffer.length - length, length);
      if (read === 0) break;
      length += read;
      if (length > maxBytes) throw new PackError('TOO_LARGE', 'pack.json exceeds the manifest size limit');
      if (length === buffer.length) break;
    }
    bytes = buffer.subarray(0, length);
  } finally {
    closeSync(fd);
  }

  let value: unknown;
  try {
    const text = bytes.toString('utf8');
    value = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    throw new PackError('INVALID_MANIFEST', 'pack.json is not valid JSON');
  }
  const parsed = parsePackManifest(value);
  if (!parsed.ok) throw new PackError('INVALID_MANIFEST', invalidManifestMessage(parsed.issues));
  return {
    manifest: parsed.manifest,
    bytes,
    bytesSha256: createHash('sha256').update(bytes).digest('hex'),
    digest: packManifestDigest(parsed.manifest),
  };
}
