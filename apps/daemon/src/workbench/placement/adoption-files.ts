import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readSync, unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';
import type { NamedFile } from './journal.js';

// Darwin O_NOFOLLOW_ANY (as in driver.ts): no symlink anywhere in the named path.
const NOFOLLOW_ANY = process.platform === 'darwin' ? 0x20000000 : constants.O_NOFOLLOW;
export const ADOPTION_MAX_FILE_BYTES = 32 * 1024 * 1024;
const BLOB_ID = /^sha256-[a-f0-9]{64}$/;

export type NamedRead = { kind: 'absent' } | { kind: 'unknown' } | { kind: 'file'; file: NamedFile; bytes: Buffer };
export const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
export const sameNamedFile = (a: NamedFile, b: NamedFile) => a.device === b.device && a.inode === b.inode && a.sha256 === b.sha256 && a.byteLength === b.byteLength;

/**
 * Identity and bytes of one named regular file from a single descriptor that
 * stayed unchanged while read, with the name still resolving to that inode
 * afterwards. Anything else is `unknown`; a missing name is `absent`. This is
 * evidence for preparation and verification, never a movement permit.
 */
export function readNamedRegularFile(location: string): NamedRead {
  let fd: number | null = null;
  try {
    try { fd = openSync(location, constants.O_RDONLY | constants.O_NONBLOCK | NOFOLLOW_ANY); }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'absent' } : { kind: 'unknown' }; }
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(ADOPTION_MAX_FILE_BYTES)) return { kind: 'unknown' };
    const bytes = Buffer.alloc(Number(before.size) + 1); let length = 0;
    for (let read = -1; read !== 0 && length < bytes.length;) { read = readSync(fd, bytes, length, bytes.length - length, length); length += read; }
    const after = fstatSync(fd, { bigint: true });
    if (length !== Number(before.size) || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs || after.ino !== before.ino) return { kind: 'unknown' };
    const named = lstatSync(location, { bigint: true });
    if (!named.isFile() || named.dev !== before.dev || named.ino !== before.ino) return { kind: 'unknown' };
    const content = Buffer.from(bytes.subarray(0, length));
    return { kind: 'file', bytes: content, file: { device: String(before.dev), inode: String(before.ino), sha256: sha256(content), byteLength: length } };
  } catch { return { kind: 'unknown' }; }
  finally { if (fd !== null) closeSync(fd); }
}

export class AdoptionBlobError extends Error {
  constructor(readonly reason: 'blob-missing' | 'blob-corrupt' | 'blob-invalid', message: string) { super(message); this.name = 'AdoptionBlobError'; }
}
export interface StoredBlob { blobId: string; sha256: string; byteLength: number }

/**
 * Content-addressed, durably retained bytes for prepared outputs and
 * independent preimages. The root is explicitly supplied by the runtime from
 * the resolved daemon data root. A blob is written to a new exclusive file,
 * flushed and then linked under its digest name, and every read re-verifies
 * the exact digest and length. Blobs are immutable and never removed here.
 */
export class AdoptionBlobStore {
  readonly #root: string;
  constructor(root: string) {
    if (!path.isAbsolute(root) || path.resolve(root) !== root) throw new AdoptionBlobError('blob-invalid', 'Explicit canonical blob root required');
    this.#root = root;
  }
  #path(blobId: string): string {
    if (!BLOB_ID.test(blobId)) throw new AdoptionBlobError('blob-invalid', 'Malformed blob identity');
    return path.join(this.#root, blobId);
  }
  put(bytes: Buffer): StoredBlob {
    if (bytes.length > ADOPTION_MAX_FILE_BYTES) throw new AdoptionBlobError('blob-invalid', 'Blob exceeds 32 MiB');
    const stored: StoredBlob = { blobId: `sha256-${sha256(bytes)}`, sha256: sha256(bytes), byteLength: bytes.length };
    const target = this.#path(stored.blobId);
    const existing = readNamedRegularFile(target);
    if (existing.kind === 'file') { this.read(stored); return stored; }
    if (existing.kind === 'unknown') throw new AdoptionBlobError('blob-corrupt', 'Existing blob name is not a verifiable file');
    mkdirSync(this.#root, { recursive: true, mode: 0o700 });
    // A partial write never occupies the digest name: flush a private temporary, then link it exclusively.
    const temporary = path.join(this.#root, `.incoming-${randomUUID()}`);
    writeExclusiveFile(temporary, bytes);
    try { linkSync(temporary, target); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    finally { unlinkSync(temporary); }
    this.read(stored);
    return stored;
  }
  read(expected: StoredBlob): Buffer {
    const found = readNamedRegularFile(this.#path(expected.blobId));
    if (found.kind === 'absent') throw new AdoptionBlobError('blob-missing', 'Retained blob is missing');
    if (found.kind !== 'file' || found.file.sha256 !== expected.sha256 || found.file.byteLength !== expected.byteLength || `sha256-${expected.sha256}` !== expected.blobId) {
      throw new AdoptionBlobError('blob-corrupt', 'Retained blob does not match its digest');
    }
    return found.bytes;
  }
}

/** New exclusive regular file (mode 0600), fully written and flushed. Returns its observed identity. */
export function writeExclusiveFile(location: string, bytes: Buffer): NamedFile {
  const fd = openSync(location, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW_ANY, 0o600);
  try {
    for (let written = 0; written < bytes.length;) written += writeSync(fd, bytes, written, bytes.length - written);
    fsyncSync(fd);
    const stat = fstatSync(fd, { bigint: true });
    return { device: String(stat.dev), inode: String(stat.ino), sha256: sha256(bytes), byteLength: bytes.length };
  } finally { closeSync(fd); }
}
