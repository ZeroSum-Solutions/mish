import { WORKBENCH_ADOPTION_HELPER_LAYOUT, type WorkbenchAdoptionPredecessorGate } from '@open-design/contracts';
import DatabaseConstructor from 'better-sqlite3';
import type Database from 'better-sqlite3';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  closeSync, constants, fstatSync, fsyncSync, ftruncateSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readSync, renameSync, rmSync,
  unlinkSync, writeSync,
} from 'node:fs';
import path from 'node:path';
import { canonicalJson } from './adoption-plan.js';

/**
 * B4-1b: the clean-shutdown seal (see ADOPTION.md "Undo across a restart").
 *
 * A restarted coordinated daemon may trust its predecessor only when it can
 * prove that nothing touched the data root between the runs. The sealing
 * daemon closes its database (SQLite then removes its WAL and shared-memory
 * files) and records the exact state of the root: the root directory itself
 * and every root-level entry (kind, identity, mode, owner, link count, size,
 * modification and change time). Any later SQLite opener of the database,
 * read-only included, recreates those files, so the root directory's change
 * time moves; any write changes the file's change time, which a process cannot
 * set back. The seal lives in the placement directory, whose contents (the
 * helper tool directory and the adoption work root) are excluded: writing the
 * seal there does not change the root, and tools-dev may rebuild the helper.
 * Recorded project files are proven separately, by undo's own exact check.
 *
 * Generation and epoch: the database holds one row per seal (generation,
 * sealing incarnation, SHA-256 of a random nonce). The seal file holds the
 * nonce and an HMAC over its body keyed by it. A boot accepts a seal only when
 * the file is a private regular file of the closed shape, its MAC verifies,
 * the root is exactly as sealed, and the database's latest, unconsumed row
 * names the same generation, the same incarnation (also the journal's current
 * one) and the nonce's hash. The seal file is removed by the first coordinated
 * boot that reads it, whatever the outcome, and the row is marked consumed by
 * the accepting incarnation, so a seal never vouches twice.
 *
 * Trust root: the same as phase A, "anything running as the daemon user". A
 * process with that authority that reads the genuine seal before the next boot
 * can rewrite it consistently. The seal detects ordinary daemons, hand edits
 * and edited, fabricated or replayed seals; it is not a defence against a
 * deliberate forger with the daemon user's authority.
 */
export const PLACEMENT_ROOT_SEAL = Object.freeze({
  directory: WORKBENCH_ADOPTION_HELPER_LAYOUT.toolDir[0],
  name: 'root-seal.json',
  schema: 'mishmash.placement-root-seal/v1' as const,
});
export type RootSealGate = WorkbenchAdoptionPredecessorGate;

// Darwin O_NOFOLLOW_ANY (as in driver.ts): no symlink anywhere in the named path.
const NOFOLLOW_ANY = process.platform === 'darwin' ? 0x20000000 : constants.O_NOFOLLOW;
const MAX_SEAL_BYTES = 1024 * 1024;
const currentUid = () => (typeof process.getuid === 'function' ? process.getuid() : -1);
const privateStat = (stat: { uid: number | bigint; mode: number | bigint }) => Number(stat.uid) === currentUid() && (Number(stat.mode) & 0o022) === 0;

interface StatFacts { kind: 'file' | 'directory' | 'symlink' | 'other'; device: string; inode: string; mode: string; uid: string; nlink: string; size: string; mtimeNs: string; ctimeNs: string }
interface IdentityFacts { kind: 'directory'; device: string; inode: string }
/** The root directory and every root-level entry by name; the seal directory by identity only. */
export interface RootState { directory: StatFacts; entries: ReadonlyArray<{ name: string; facts: StatFacts | IdentityFacts }> }
export interface RootSeal { schema: typeof PLACEMENT_ROOT_SEAL.schema; generation: number; incarnationId: string; nonce: string; sealedAt: string; root: RootState; mac: string }
export type RootSealReading =
  | { kind: 'absent' }
  | { kind: 'refused'; reason: 'predecessor-seal-invalid' | 'predecessor-seal-root-changed' }
  | { kind: 'sealed'; seal: RootSeal; file: RootSealFile };

/**
 * The seal file a reading verified, pinned by the descriptor that read it
 * until `release()`. While that descriptor is open the file's inode cannot be
 * freed, so no file that replaces it can take the same device and inode (ext4
 * hands a freed inode number straight to the next file created in the same
 * directory). Identity comparisons between readings that are all still held,
 * and `consumeRootSeal(root, file)`, are therefore exact. `sha256` is the
 * digest of the bytes the reading verified. Release every reading once its
 * comparisons and consumption are done; releasing twice is harmless.
 */
export interface RootSealFile { readonly device: string; readonly inode: string; readonly sha256: string; release(): void }
const sealFileDescriptors = new WeakMap<RootSealFile, { fd: number | null }>();
const releasePin = (pin: { fd: number | null }) => { if (pin.fd !== null) { const open = pin.fd; pin.fd = null; try { closeSync(open); } catch { /* already closed */ } } };
// A reading dropped without `release()` is closed once it is collected, so a forgotten release never leaks for long.
const unreleasedSealFiles = new FinalizationRegistry<{ fd: number | null }>(releasePin);
function pinSealFile(fd: number, identity: { device: string; inode: string; sha256: string }): RootSealFile {
  const pin = { fd: fd as number | null };
  const file: RootSealFile = Object.freeze({ ...identity, release: () => releasePin(pin) });
  sealFileDescriptors.set(file, pin);
  unreleasedSealFiles.register(file, pin);
  return file;
}
/** Every byte of the descriptor from offset 0, up to `limit`; null when it holds more. */
function readAll(fd: number, limit: number): Buffer | null {
  const bytes = Buffer.alloc(limit + 1); let length = 0;
  for (let read = -1; read !== 0 && length < bytes.length;) { read = readSync(fd, bytes, length, bytes.length - length, length); length += read; }
  return length > limit ? null : bytes.subarray(0, length);
}

type BigStat = ReturnType<typeof lstatSync> & { dev: bigint; ino: bigint; mode: bigint; uid: bigint; nlink: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint };
function facts(stat: BigStat): StatFacts {
  const kind = stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : stat.isSymbolicLink() ? 'symlink' : 'other';
  return { kind, device: String(stat.dev), inode: String(stat.ino), mode: String(stat.mode), uid: String(stat.uid), nlink: String(stat.nlink), size: String(stat.size), mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs) };
}
const bigLstat = (target: string) => lstatSync(target, { bigint: true }) as unknown as BigStat;
const sameFile = (a: { dev: bigint; ino: bigint }, b: { dev: bigint; ino: bigint }) => a.dev === b.dev && a.ino === b.ino;
const sameDirectory = (a: BigStat, b: BigStat) => a.isDirectory() && b.isDirectory() && sameFile(a, b);

/** The current root state, read without following any symlink; null when it cannot be observed or the root is not private. */
export function observeRootState(root: string): RootState | null {
  try {
    const directory = bigLstat(root);
    if (!directory.isDirectory() || !privateStat(directory)) return null;
    const entries = readdirSync(root).sort().map(name => {
      const stat = bigLstat(path.join(root, name));
      return name === PLACEMENT_ROOT_SEAL.directory && stat.isDirectory()
        ? { name, facts: { kind: 'directory' as const, device: String(stat.dev), inode: String(stat.ino) } }
        : { name, facts: facts(stat) };
    });
    return { directory: facts(directory), entries };
  } catch { return null; }
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const macOf = (body: Omit<RootSeal, 'mac'>) => createHmac('sha256', Buffer.from(body.nonce, 'hex')).update(canonicalJson(body)).digest('hex');
const hexEqual = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
const absent = (target: string) => { try { lstatSync(target); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT'; } };

/** The seal directory as a real private directory (created privately when missing), or null. */
function sealDirectory(root: string, create: boolean): string | null {
  const directory = path.join(root, PLACEMENT_ROOT_SEAL.directory);
  try {
    if (create && absent(directory)) mkdirSync(directory, { mode: 0o700 });
    const stat = lstatSync(directory);
    return stat.isDirectory() && privateStat(stat) ? directory : null;
  } catch { return null; }
}

/**
 * Writes the seal at a clean stop: after the sealing daemon recorded the
 * generation (`recordRootSeal`) and closed its database, before it releases
 * the native owner. Refuses while the database still has its WAL or
 * shared-memory file (another connection is open), and removes the seal again
 * if writing it changed the root.
 */
export function writeRootSeal(
  root: string, input: { generation: number; incarnationId: string; nonce: string; databaseName?: string; now?: () => Date },
  hooks: { afterPublish?: () => void } = {},
): { written: true; seal: RootSeal } | { written: false; reason: string } {
  const database = input.databaseName ?? 'app.sqlite';
  if (!absent(path.join(root, `${database}-wal`)) || !absent(path.join(root, `${database}-shm`))) return { written: false, reason: 'database-open' };
  const directory = sealDirectory(root, true);
  if (!directory) return { written: false, reason: 'seal-directory-unsafe' };
  const state = observeRootState(root);
  if (!state) return { written: false, reason: 'root-unobservable' };
  const body: Omit<RootSeal, 'mac'> = {
    schema: PLACEMENT_ROOT_SEAL.schema, generation: input.generation, incarnationId: input.incarnationId, nonce: input.nonce,
    sealedAt: (input.now ?? (() => new Date()))().toISOString(), root: state,
  };
  const seal: RootSeal = { ...body, mac: macOf(body) };
  const target = path.join(directory, PLACEMENT_ROOT_SEAL.name);
  const temporary = path.join(directory, `.root-seal-${randomBytes(8).toString('hex')}.tmp`);
  let published = false;
  try {
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW_ANY, 0o600);
    try { writeSync(fd, `${JSON.stringify(seal)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, target);
    published = true;
    hooks.afterPublish?.();
    const dirFd = openSync(directory, constants.O_RDONLY | NOFOLLOW_ANY);
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  } catch {
    // Anything that fails after the rename leaves no seal behind: a reported failure never seals. The database
    // generation without its seal file is inert, because confirmation needs the nonce only the file carries.
    try { unlinkSync(published ? target : temporary); } catch { /* not created */ }
    return { written: false, reason: 'seal-write-failed' };
  }
  const after = observeRootState(root);
  if (!after || canonicalJson(after) !== canonicalJson(state)) {
    try { unlinkSync(target); } catch { /* reading it would refuse anyway */ }
    return { written: false, reason: 'root-unstable' };
  }
  return { written: true, seal };
}

const exactKeys = (value: unknown, names: readonly string[]): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
function parseSeal(bytes: Buffer): RootSeal | null {
  let input: unknown;
  try { input = JSON.parse(bytes.toString('utf8')); } catch { return null; }
  if (!exactKeys(input, ['schema', 'generation', 'incarnationId', 'nonce', 'sealedAt', 'root', 'mac'])) return null;
  const { schema, generation, incarnationId, nonce, sealedAt, root, mac } = input;
  if (schema !== PLACEMENT_ROOT_SEAL.schema || typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation < 1
    || typeof incarnationId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(incarnationId)
    || typeof nonce !== 'string' || !/^[0-9a-f]{64}$/.test(nonce) || typeof sealedAt !== 'string' || sealedAt.length > 64
    || typeof mac !== 'string' || !/^[0-9a-f]{64}$/.test(mac) || !exactKeys(root, ['directory', 'entries'])) return null;
  // The root's inner shape needs no parser of its own: a seal is accepted only when it equals a fresh observation.
  return { schema, generation, incarnationId, nonce, sealedAt, root: root as unknown as RootState, mac };
}

/**
 * Reads and verifies the seal against the current root. Never follows a
 * symlink; the seal must be a private, single-link regular file. `sealed`
 * means the file is genuine-shaped, its MAC verifies and the root is exactly
 * as sealed; the database must still confirm it (`confirmRootSeal`).
 */
export function readRootSeal(root: string): RootSealReading {
  const directory = path.join(root, PLACEMENT_ROOT_SEAL.directory);
  try { lstatSync(directory); } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'absent' } : { kind: 'refused', reason: 'predecessor-seal-invalid' };
  }
  if (!sealDirectory(root, false)) return { kind: 'refused', reason: 'predecessor-seal-invalid' };
  const file = path.join(directory, PLACEMENT_ROOT_SEAL.name);
  let directoryBefore: BigStat;
  try { directoryBefore = bigLstat(directory); } catch { return { kind: 'refused', reason: 'predecessor-seal-invalid' }; }
  let fd: number;
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK | NOFOLLOW_ANY); }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'absent' } : { kind: 'refused', reason: 'predecessor-seal-invalid' }; }
  // The descriptor stays open only on success, where it becomes the reading's pinned file.
  let pinned = false;
  try {
    let seal: RootSeal | null = null, identity = { device: '', inode: '', sha256: '' };
    try {
      const stat = fstatSync(fd, { bigint: true });
      if (!stat.isFile() || !privateStat(stat) || stat.nlink !== 1n || stat.size > BigInt(MAX_SEAL_BYTES)) return { kind: 'refused', reason: 'predecessor-seal-invalid' };
      // Root-bound: the opened file is the one named inside the real seal directory (O_NOFOLLOW guards only the last
      // component off Darwin, so a swapped directory is caught here).
      if (!sameDirectory(directoryBefore, bigLstat(directory)) || !sameFile(stat, bigLstat(file))) return { kind: 'refused', reason: 'predecessor-seal-invalid' };
      const bytes = readAll(fd, Number(stat.size));
      if (!bytes || bytes.length !== Number(stat.size)) return { kind: 'refused', reason: 'predecessor-seal-invalid' };
      seal = parseSeal(bytes);
      identity = { device: String(stat.dev), inode: String(stat.ino), sha256: createHash('sha256').update(bytes).digest('hex') };
    } catch { return { kind: 'refused', reason: 'predecessor-seal-invalid' }; }
    if (!seal) return { kind: 'refused', reason: 'predecessor-seal-invalid' };
    const { mac, ...body } = seal;
    if (!hexEqual(mac, macOf(body))) return { kind: 'refused', reason: 'predecessor-seal-invalid' };
    const state = observeRootState(root);
    if (!state || canonicalJson(state) !== canonicalJson(seal.root)) return { kind: 'refused', reason: 'predecessor-seal-root-changed' };
    const verified = pinSealFile(fd, identity);
    pinned = true;
    return { kind: 'sealed', seal, file: verified };
  } finally { if (!pinned) closeSync(fd); }
}

/**
 * Removes the seal file (or a link in its place) so it never vouches for a
 * later boot. Never follows a symlink: the root and the seal directory must be
 * real, private directories, checked without following and pinned by identity
 * through a no-follow descriptor, and re-checked right before the unlink.
 *
 * With `expected` (a verified reading's file, still held), the seal is
 * consumed only through the descriptor that verified it, never by re-opening
 * the path: that descriptor must still be the private single-link file the
 * reading saw, its bytes must still hash to the verified digest, and the
 * name must still point at it. Because the held descriptor keeps the inode
 * alive, a replacement file cannot take its device and inode, and the digest
 * catches a rewrite in place. A file object that no reading produced, or one
 * already released, consumes nothing. Anything unsafe leaves every file
 * untouched. True when the seal was removed.
 */
export function consumeRootSeal(root: string, expected?: RootSealFile): boolean {
  const directory = path.join(root, PLACEMENT_ROOT_SEAL.directory);
  const file = path.join(directory, PLACEMENT_ROOT_SEAL.name);
  const verifiedFd = expected ? sealFileDescriptors.get(expected)?.fd ?? null : null;
  if (expected && verifiedFd === null) return false;
  let dirFd: number | null = null;
  try {
    const rootStat = bigLstat(root), directoryStat = bigLstat(directory);
    if (!rootStat.isDirectory() || !privateStat(rootStat) || !directoryStat.isDirectory() || !privateStat(directoryStat)) return false;
    dirFd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | NOFOLLOW_ANY);
    const pinned = fstatSync(dirFd, { bigint: true });
    if (pinned.dev !== directoryStat.dev || pinned.ino !== directoryStat.ino) return false;
    if (expected && verifiedFd !== null && !stillVerified(verifiedFd, expected)) return false;
    const stat = bigLstat(file);
    if (!stat.isFile() && !stat.isSymbolicLink()) return false;
    if (expected && verifiedFd !== null && !sameFile(fstatSync(verifiedFd, { bigint: true }) as unknown as BigStat, stat)) return false;
    const again = bigLstat(directory);
    if (!again.isDirectory() || again.dev !== pinned.dev || again.ino !== pinned.ino) return false;
    unlinkSync(file);
    return true;
  } catch { return false; }
  finally { if (dirFd !== null) closeSync(dirFd); }
}

/** The held descriptor is still the private, single-link file the reading verified, holding the same bytes. */
function stillVerified(fd: number, expected: RootSealFile): boolean {
  const stat = fstatSync(fd, { bigint: true });
  if (!stat.isFile() || !privateStat(stat) || stat.nlink !== 1n || stat.size > BigInt(MAX_SEAL_BYTES)
    || String(stat.dev) !== expected.device || String(stat.ino) !== expected.inode) return false;
  const bytes = readAll(fd, MAX_SEAL_BYTES);
  return bytes !== null && hexEqual(createHash('sha256').update(bytes).digest('hex'), expected.sha256);
}

/**
 * Two held readings name the same verified seal file: the same device and
 * inode (exact while both descriptors are open) and the same verified bytes.
 */
export function sameRootSealFile(a: RootSealFile, b: RootSealFile): boolean {
  return a.device === b.device && a.inode === b.inode && hexEqual(a.sha256, b.sha256);
}

/**
 * B4-1b root lock (`.placement-root.lock`, root level): an advisory lock both
 * modes honour, so no ordinary daemon can open the database between seal
 * verification and database confirmation. The coordinated bootstrap holds it
 * exclusively from its first seal read through confirmation; an ordinary
 * daemon takes it shared before its first database touch and keeps it for its
 * life, so a coordinated boot that finds it busy knows another daemon uses the
 * root. Darwin `O_EXLOCK`/`O_SHLOCK` (flock semantics, released with the
 * descriptor or the process). The coordinated boot creates the file; an
 * ordinary daemon never does (no coordinated daemon, no seal to protect).
 */
export const PLACEMENT_ROOT_LOCK = '.placement-root.lock';
export interface RootLock { release(): void }
export type RootLockResult = { kind: 'held'; lock: RootLock } | { kind: 'busy' } | { kind: 'absent' } | { kind: 'unsupported' } | { kind: 'unsafe' };
const O_SHLOCK = 0x10, O_EXLOCK = 0x20;
function lockDescriptor(fd: number): RootLock {
  let open = true;
  return { release: () => { if (open) { open = false; try { closeSync(fd); } catch { /* the process releases it at exit */ } } } };
}
function openLock(root: string, flags: number): RootLockResult {
  if (process.platform !== 'darwin') return { kind: 'unsupported' };
  let fd: number;
  try { fd = openSync(path.join(root, PLACEMENT_ROOT_LOCK), flags | constants.O_NONBLOCK | constants.O_NOFOLLOW, 0o600); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' ? { kind: 'absent' } : code === 'EAGAIN' || code === 'EWOULDBLOCK' ? { kind: 'busy' } : { kind: 'unsafe' };
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || !privateStat(stat) || stat.nlink !== 1) { closeSync(fd); return { kind: 'unsafe' }; }
  } catch { closeSync(fd); return { kind: 'unsafe' }; }
  return { kind: 'held', lock: lockDescriptor(fd) };
}
/** Coordinated bootstrap: exclusive, never waits. `create` makes the file (only where creating it cannot spoil a proof). */
export function acquireExclusiveRootLock(root: string, options: { create: boolean }): RootLockResult {
  return openLock(root, constants.O_RDWR | O_EXLOCK | (options.create ? constants.O_CREAT : 0));
}
/** Ordinary daemon: shared, waiting up to `waitMs` for a coordinated boot to finish confirming its seal. */
export function acquireSharedRootLock(root: string, options: { waitMs: number }): RootLockResult {
  const deadline = Date.now() + Math.max(0, options.waitMs);
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    const result = openLock(root, constants.O_RDONLY | O_SHLOCK);
    if (result.kind !== 'busy' || Date.now() >= deadline) return result;
    Atomics.wait(pause, 0, 0, Math.min(50, Math.max(1, deadline - Date.now())));
  }
}

/** Largest database a boot copies to confirm a seal; above it the seal is `predecessor-seal-unverifiable`. */
export const SEAL_CONFIRM_MAX_BYTES = 1024 * 1024 * 1024;
const SNAPSHOT_CHUNK_BYTES = 1024 * 1024;
const ZERO_CHUNK = Buffer.alloc(SNAPSHOT_CHUNK_BYTES);

/**
 * Confirms a verified seal against the database without opening SQLite on the
 * root (which would recreate its WAL and shared-memory files) and without a
 * whole-database copy in memory. The sealed database is cleanly closed, so its
 * main file holds every committed row. It is read through a no-follow
 * descriptor in 1 MiB chunks into a bounded snapshot in a private temporary
 * directory inside the seal directory (which the seal excludes from the root
 * state; never a project). All-zero chunks are skipped, so the snapshot of a
 * sparse file stays sparse. The snapshot is read as a rollback-journal
 * database, read-only, and removed afterwards. A database over `maxBytes`, or
 * a snapshot that cannot be made, is `predecessor-seal-unverifiable` (a
 * resource limit, not evidence against the seal).
 */
export function confirmRootSealOnDisk(root: string, seal: RootSeal, options: { databaseName?: string; maxBytes?: number } = {}): RootSealGate | null {
  const maxBytes = options.maxBytes ?? SEAL_CONFIRM_MAX_BYTES;
  let source: number | null = null, target: number | null = null, scratch: string | null = null;
  try {
    try { source = openSync(path.join(root, options.databaseName ?? 'app.sqlite'), constants.O_RDONLY | constants.O_NONBLOCK | NOFOLLOW_ANY); }
    catch { return 'predecessor-seal-unrecognized'; }
    const stat = fstatSync(source);
    if (!stat.isFile()) return 'predecessor-seal-unrecognized';
    if (stat.size > maxBytes) return 'predecessor-seal-unverifiable';
    const directory = sealDirectory(root, false);
    if (!directory) return 'predecessor-seal-unverifiable';
    const snapshot = (() => {
      try {
        scratch = mkdtempSync(path.join(directory, '.seal-check-'));
        const file = path.join(scratch, 'snapshot.sqlite');
        target = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW_ANY, 0o600);
        const chunk = Buffer.alloc(SNAPSHOT_CHUNK_BYTES);
        for (let offset = 0; offset < stat.size;) {
          const length = readSync(source!, chunk, 0, Math.min(SNAPSHOT_CHUNK_BYTES, stat.size - offset), offset);
          if (length <= 0) return null;
          // A WAL-mode header (file format versions 2/2 at bytes 18-19) is read as rollback-journal: the WAL was
          // checkpointed and removed before the seal, so the main file is complete.
          if (offset === 0 && length >= 20 && chunk[18] === 2 && chunk[19] === 2) { chunk[18] = 1; chunk[19] = 1; }
          if (!chunk.subarray(0, length).equals(ZERO_CHUNK.subarray(0, length))) writeSync(target, chunk, 0, length, offset);
          offset += length;
        }
        ftruncateSync(target, stat.size);
        closeSync(target); target = null;
        return file;
      } catch { return null; }
    })();
    if (!snapshot) return 'predecessor-seal-unverifiable';
    let db: Database.Database | null = null;
    try {
      db = new DatabaseConstructor(snapshot, { readonly: true, fileMustExist: true });
      return confirmRootSeal(db, seal);
    } catch { return 'predecessor-seal-unrecognized'; }
    finally { try { db?.close(); } catch { /* read-only snapshot */ } }
  } catch { return 'predecessor-seal-unverifiable'; }
  finally {
    for (const fd of [source, target]) if (fd !== null) { try { closeSync(fd); } catch { /* already closed */ } }
    if (scratch) { try { rmSync(scratch, { recursive: true, force: true }); } catch { /* inside the excluded seal directory */ } }
  }
}

/** Owned migration `placement-root-seal` (version 1): one row per seal, the generation and epoch record. */
export const PLACEMENT_ROOT_SEAL_TABLES = Object.freeze(['placement_root_seals'] as const);
export function migratePlacementRootSeals(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS placement_root_seals (
      generation INTEGER PRIMARY KEY CHECK(generation > 0),
      incarnation_id TEXT NOT NULL UNIQUE REFERENCES placement_journal_incarnations(id),
      nonce_sha256 TEXT NOT NULL CHECK(length(nonce_sha256) = 64),
      sealed_at INTEGER NOT NULL,
      consumed_by TEXT UNIQUE REFERENCES placement_journal_incarnations(id)
    );
  `);
}

/** Records the next generation for the sealing incarnation; the nonce goes only into the seal file. */
export function recordRootSeal(db: Database.Database, incarnationId: string): { generation: number; nonce: string } {
  const nonce = randomBytes(32).toString('hex');
  const generation = db.transaction(() => {
    const row = db.prepare('SELECT COALESCE(MAX(generation), 0) AS latest FROM placement_root_seals').get() as { latest: number };
    const next = row.latest + 1;
    db.prepare('INSERT INTO placement_root_seals (generation, incarnation_id, nonce_sha256, sealed_at, consumed_by) VALUES (?,?,?,?,NULL)')
      .run(next, incarnationId, sha256(nonce), Date.now());
    return next;
  }).immediate();
  return { generation, nonce };
}

/**
 * The database's confirmation of a verified seal file, before the new journal
 * incarnation exists: the latest generation, unconsumed, sealed by the
 * incarnation that is still the journal's current one, with this nonce. Null
 * confirms; otherwise `predecessor-seal-unrecognized`.
 */
export function confirmRootSeal(db: Database.Database, seal: RootSeal): RootSealGate | null {
  try {
    const latest = db.prepare('SELECT generation, incarnation_id, nonce_sha256, consumed_by FROM placement_root_seals ORDER BY generation DESC LIMIT 1')
      .get() as { generation: number; incarnation_id: string; nonce_sha256: string; consumed_by: string | null } | undefined;
    const current = db.prepare('SELECT incarnation_id FROM placement_journal_current WHERE singleton=1').get() as { incarnation_id: string } | undefined;
    if (!latest || latest.generation !== seal.generation || latest.incarnation_id !== seal.incarnationId || latest.consumed_by !== null
      || current?.incarnation_id !== seal.incarnationId || !/^[0-9a-f]{64}$/.test(latest.nonce_sha256) || !hexEqual(latest.nonce_sha256, sha256(seal.nonce))) {
      return 'predecessor-seal-unrecognized';
    }
    return null;
  } catch { return 'predecessor-seal-unrecognized'; }
}

/** Marks the confirmed generation consumed by the accepting incarnation; throws unless exactly that row changed. */
export function markRootSealConsumed(db: Database.Database, generation: number, incarnationId: string): void {
  db.transaction(() => {
    const changed = db.prepare('UPDATE placement_root_seals SET consumed_by=? WHERE generation=? AND consumed_by IS NULL').run(incarnationId, generation).changes;
    if (changed !== 1) throw new Error('Root seal was already consumed');
  }).immediate();
}
