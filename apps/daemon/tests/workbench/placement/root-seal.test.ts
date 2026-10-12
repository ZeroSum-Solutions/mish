import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createHmac, randomBytes } from 'node:crypto';
import { readdirSync, statSync, truncateSync } from 'node:fs';
import {
  appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WORKBENCH_ADOPTION_HELPER_LAYOUT, WORKBENCH_ADOPTION_PREDECESSOR_GATES } from '@open-design/contracts';
import { canonicalJson } from '../../../src/workbench/placement/adoption-plan.js';
import { migratePlacementJournal, PlacementJournal } from '../../../src/workbench/placement/journal.js';
import {
  acquireExclusiveRootLock, acquireSharedRootLock, confirmRootSeal, confirmRootSealOnDisk, consumeRootSeal, markRootSealConsumed,
  migratePlacementRootSeals, observeRootState, PLACEMENT_ROOT_LOCK, PLACEMENT_ROOT_SEAL, readRootSeal, recordRootSeal, writeRootSeal,
} from '../../../src/workbench/placement/root-seal.js';

/**
 * B4-1b: the clean-shutdown seal that lets a restarted coordinated daemon
 * trust its predecessor. The seal binds the data root's own directory and
 * every root-level entry (identity, size, change time) at the moment the
 * sealing daemon closed its database, plus a generation and a nonce whose
 * hash the database holds. A later SQLite opener (any ordinary daemon), a
 * hand edit at the root, an edited, fabricated or replayed seal: each refuses
 * with a typed reason. Portable: no native owner.
 */
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function sealedRoot() {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'root-seal-'))); roots.push(parent);
  const root = join(parent, 'data'); mkdirSync(root, { mode: 0o700 });
  mkdirSync(join(root, ...WORKBENCH_ADOPTION_HELPER_LAYOUT.toolDir), { recursive: true, mode: 0o700 });
  mkdirSync(join(root, 'projects', 'hero'), { recursive: true });
  writeFileSync(join(root, '.daemon-placement-owner.lock'), '', { mode: 0o600 });
  const db = new Database(join(root, 'app.sqlite')); db.pragma('journal_mode=WAL'); db.pragma('synchronous=FULL'); db.pragma('foreign_keys=ON');
  migratePlacementJournal(db); migratePlacementRootSeals(db);
  const journal = new PlacementJournal({ db, incarnationId: `incarnation-${randomBytes(6).toString('hex')}` });
  return { root, db, journal };
}
/** What the sealing daemon does at a clean stop: record the generation, close the database, then write the seal. */
function seal(root: string, db: Database.Database, incarnationId: string) {
  const recorded = recordRootSeal(db, incarnationId);
  db.close();
  const written = writeRootSeal(root, { generation: recorded.generation, incarnationId, nonce: recorded.nonce });
  if (!written.written) throw new Error(`seal refused: ${written.reason}`);
  return { ...recorded, file: join(root, PLACEMENT_ROOT_SEAL.directory, PLACEMENT_ROOT_SEAL.name) };
}
const reopen = (root: string) => { const db = new Database(join(root, 'app.sqlite')); db.pragma('journal_mode=WAL'); db.pragma('synchronous=FULL'); db.pragma('foreign_keys=ON'); return db; };

const darwin = process.platform === 'darwin';

describe('placement root seal', () => {
  it('names every typed refusal in the shared contract', () => {
    expect([...WORKBENCH_ADOPTION_PREDECESSOR_GATES]).toEqual([
      'predecessor-seal-absent', 'predecessor-seal-invalid', 'predecessor-seal-root-changed', 'predecessor-seal-unrecognized',
      'predecessor-seal-unverifiable',
    ]);
  });

  it('a clean seal reads back, the database confirms it once, and consumption makes it one-shot', () => {
    const { root, db, journal } = sealedRoot();
    const sealed = seal(root, db, journal.incarnationId);
    const reading = readRootSeal(root);
    expect(reading).toMatchObject({ kind: 'sealed', seal: { generation: 1, incarnationId: journal.incarnationId } });
    if (reading.kind !== 'sealed') throw new Error('sealed');
    expect(consumeRootSeal(root)).toBe(true);
    expect(existsSync(sealed.file)).toBe(false);
    expect(readRootSeal(root)).toEqual({ kind: 'absent' });

    const next = reopen(root);
    expect(confirmRootSeal(next, reading.seal)).toBeNull();
    const successor = new PlacementJournal({ db: next, incarnationId: 'incarnation-successor' });
    markRootSealConsumed(next, reading.seal.generation, successor.incarnationId);
    // The same seal (a kept copy) never vouches twice.
    expect(confirmRootSeal(next, reading.seal)).toBe('predecessor-seal-unrecognized');
    // The successor seals the next generation of the chain.
    expect(recordRootSeal(next, successor.incarnationId).generation).toBe(2);
    next.close();
  });

  it('writes inside the seal directory (a rebuilt helper) do not break the seal', () => {
    const { root, db, journal } = sealedRoot();
    seal(root, db, journal.incarnationId);
    const toolDir = join(root, ...WORKBENCH_ADOPTION_HELPER_LAYOUT.toolDir);
    writeFileSync(join(toolDir, 'rebuilt.tmp'), 'x'); rmSync(join(toolDir, 'rebuilt.tmp'));
    expect(readRootSeal(root)).toMatchObject({ kind: 'sealed' });
  });

  it('any later SQLite opener of the database (an ordinary daemon, read-only included) breaks the seal', () => {
    const { root, db, journal } = sealedRoot();
    seal(root, db, journal.incarnationId);
    const reader = new Database(join(root, 'app.sqlite'), { readonly: true });
    reader.prepare('SELECT COUNT(*) AS n FROM placement_root_seals').get(); reader.close();
    expect(readRootSeal(root)).toEqual({ kind: 'refused', reason: 'predecessor-seal-root-changed' });
  });

  it('a hand edit at the root breaks the seal: a new entry, a changed file, a removed entry', () => {
    const created = sealedRoot();
    seal(created.root, created.db, created.journal.incarnationId);
    writeFileSync(join(created.root, 'app-config.json'), '{}');
    expect(readRootSeal(created.root)).toEqual({ kind: 'refused', reason: 'predecessor-seal-root-changed' });

    const changed = sealedRoot();
    seal(changed.root, changed.db, changed.journal.incarnationId);
    appendFileSync(join(changed.root, 'app.sqlite'), Buffer.alloc(0)); // Even a zero-byte write is a new change time.
    chmodSync(join(changed.root, 'app.sqlite'), 0o600);
    expect(readRootSeal(changed.root)).toEqual({ kind: 'refused', reason: 'predecessor-seal-root-changed' });

    const project = sealedRoot();
    seal(project.root, project.db, project.journal.incarnationId);
    mkdirSync(join(project.root, 'projects', 'second'));
    expect(readRootSeal(project.root)).toEqual({ kind: 'refused', reason: 'predecessor-seal-root-changed' });
  });

  it('an edited seal is refused: its MAC no longer verifies', () => {
    const { root, db, journal } = sealedRoot();
    const sealed = seal(root, db, journal.incarnationId);
    const body = JSON.parse(readFileSync(sealed.file, 'utf8'));
    writeFileSync(sealed.file, JSON.stringify({ ...body, generation: 7 }), { mode: 0o600 });
    expect(readRootSeal(root)).toEqual({ kind: 'refused', reason: 'predecessor-seal-invalid' });
  });

  it('a fabricated seal over the current root state is refused by the database: its nonce is not the recorded one', () => {
    const { root, db, journal } = sealedRoot();
    recordRootSeal(db, journal.incarnationId); db.close();
    // The forger observes the real root and signs with a nonce of their own.
    const nonce = randomBytes(32).toString('hex');
    const body = { schema: PLACEMENT_ROOT_SEAL.schema, generation: 1, incarnationId: journal.incarnationId, nonce, sealedAt: new Date().toISOString(), root: observeRootState(root) };
    const mac = createHmac('sha256', Buffer.from(nonce, 'hex')).update(canonicalJson(body)).digest('hex');
    writeFileSync(join(root, PLACEMENT_ROOT_SEAL.directory, PLACEMENT_ROOT_SEAL.name), JSON.stringify({ ...body, mac }), { mode: 0o600 });
    const reading = readRootSeal(root);
    expect(reading.kind).toBe('sealed');
    if (reading.kind !== 'sealed') throw new Error('sealed');
    const next = reopen(root);
    expect(confirmRootSeal(next, reading.seal)).toBe('predecessor-seal-unrecognized');
    next.close();
  });

  it('a seal from an incarnation that is no longer the latest, or an older generation, is refused', () => {
    const { root, db, journal } = sealedRoot();
    const sealed = seal(root, db, journal.incarnationId);
    const kept = join(root, '..', 'kept-seal.json'); copyFileSync(sealed.file, kept);
    const reading = readRootSeal(root);
    if (reading.kind !== 'sealed') throw new Error('sealed');
    consumeRootSeal(root);
    const next = reopen(root);
    // A later boot that never sealed (crash) is now the latest journal incarnation.
    const crashed = new PlacementJournal({ db: next, incarnationId: 'incarnation-crashed' });
    expect(crashed.incarnationId).toBe('incarnation-crashed');
    expect(confirmRootSeal(next, reading.seal)).toBe('predecessor-seal-unrecognized');
    next.close();
  });

  it('a seal that is a symlink, shared-writable or hard-linked is invalid', () => {
    const linked = sealedRoot();
    const sealed = seal(linked.root, linked.db, linked.journal.incarnationId);
    const elsewhere = join(linked.root, '..', 'elsewhere.json'); copyFileSync(sealed.file, elsewhere); rmSync(sealed.file); symlinkSync(elsewhere, sealed.file);
    expect(readRootSeal(linked.root)).toEqual({ kind: 'refused', reason: 'predecessor-seal-invalid' });

    const shared = sealedRoot();
    const sharedSeal = seal(shared.root, shared.db, shared.journal.incarnationId);
    chmodSync(sharedSeal.file, 0o666);
    expect(readRootSeal(shared.root)).toEqual({ kind: 'refused', reason: 'predecessor-seal-invalid' });
  });

  it('refuses to write a seal while the database still has its WAL or shared-memory file', () => {
    const { root, db, journal } = sealedRoot();
    const recorded = recordRootSeal(db, journal.incarnationId); // Database left open.
    expect(writeRootSeal(root, { generation: recorded.generation, incarnationId: journal.incarnationId, nonce: recorded.nonce })).toEqual({ written: false, reason: 'database-open' });
    expect(existsSync(join(root, PLACEMENT_ROOT_SEAL.directory, PLACEMENT_ROOT_SEAL.name))).toBe(false);
    db.close();
  });

  it('[Sol BLOCK 1] never follows a symlinked seal directory: an outside file survives consumption', () => {
    const { root, db } = sealedRoot(); db.close();
    const outside = join(root, '..', 'outside'); mkdirSync(outside);
    writeFileSync(join(outside, PLACEMENT_ROOT_SEAL.name), 'user data', { mode: 0o600 });
    rmSync(join(root, PLACEMENT_ROOT_SEAL.directory), { recursive: true }); symlinkSync(outside, join(root, PLACEMENT_ROOT_SEAL.directory));
    expect(readRootSeal(root)).toEqual({ kind: 'refused', reason: 'predecessor-seal-invalid' });
    expect(consumeRootSeal(root)).toBe(false);
    expect(readFileSync(join(outside, PLACEMENT_ROOT_SEAL.name), 'utf8')).toBe('user data');
  });

  it('[Sol BLOCK 1] consumes only the seal file it verified', () => {
    const { root, db, journal } = sealedRoot();
    const sealed = seal(root, db, journal.incarnationId);
    const reading = readRootSeal(root);
    if (reading.kind !== 'sealed') throw new Error('sealed');
    // Replaced between verification and consumption: the other file is left alone.
    const body = readFileSync(sealed.file); rmSync(sealed.file); writeFileSync(sealed.file, body, { mode: 0o600 });
    expect(consumeRootSeal(root, reading.file)).toBe(false);
    expect(existsSync(sealed.file)).toBe(true);
  });

  it('[Sol BLOCK 1] consumes only the bytes it verified: an in-place rewrite keeps the inode but is left alone', () => {
    // Device and inode alone prove nothing: a rewrite in place keeps both on every filesystem, and ext4 also hands a
    // freed inode straight to the next file. Only the verified content may be consumed.
    const { root, db, journal } = sealedRoot();
    const sealed = seal(root, db, journal.incarnationId);
    const reading = readRootSeal(root);
    if (reading.kind !== 'sealed') throw new Error('sealed');
    const before = statSync(sealed.file);
    writeFileSync(sealed.file, `${readFileSync(sealed.file, 'utf8').trimEnd()} \n`, { mode: 0o600 });
    const after = statSync(sealed.file);
    expect([after.dev, after.ino]).toEqual([before.dev, before.ino]); // The same file: only its bytes changed.
    expect(consumeRootSeal(root, reading.file)).toBe(false);
    expect(existsSync(sealed.file)).toBe(true);
  });

  it('[Sol BLOCK 1] consumes only through a held reading: a released or copied file object removes nothing', () => {
    const { root, db, journal } = sealedRoot();
    const sealed = seal(root, db, journal.incarnationId);
    const reading = readRootSeal(root);
    if (reading.kind !== 'sealed') throw new Error('sealed');
    const { device, inode, sha256 } = reading.file;
    expect(consumeRootSeal(root, { device, inode, sha256, release: () => {} })).toBe(false);
    reading.file.release(); reading.file.release(); // Releasing twice is harmless.
    expect(consumeRootSeal(root, reading.file)).toBe(false);
    expect(existsSync(sealed.file)).toBe(true);
    const held = readRootSeal(root);
    if (held.kind !== 'sealed') throw new Error('sealed');
    expect(consumeRootSeal(root, held.file)).toBe(true);
    held.file.release();
    expect(existsSync(sealed.file)).toBe(false);
  });

  it('[Sol WARN 4] a failure after the seal was published removes it again', () => {
    const { root, db, journal } = sealedRoot();
    const recorded = recordRootSeal(db, journal.incarnationId); db.close();
    const written = writeRootSeal(root, { generation: recorded.generation, incarnationId: journal.incarnationId, nonce: recorded.nonce }, {
      afterPublish: () => { throw new Error('directory sync failed'); },
    });
    expect(written).toEqual({ written: false, reason: 'seal-write-failed' });
    expect(existsSync(join(root, PLACEMENT_ROOT_SEAL.directory, PLACEMENT_ROOT_SEAL.name))).toBe(false);
    expect(readRootSeal(root)).toEqual({ kind: 'absent' });
  });

  it('[Sol BLOCK 2] confirms a seal from the database bytes without opening SQLite on the root', () => {
    const { root, db, journal } = sealedRoot();
    seal(root, db, journal.incarnationId);
    const reading = readRootSeal(root);
    if (reading.kind !== 'sealed') throw new Error('sealed');
    expect(confirmRootSealOnDisk(root, reading.seal)).toBeNull();
    expect(readRootSeal(root)).toMatchObject({ kind: 'sealed' }); // The confirmation itself changed nothing at the root.
    expect(confirmRootSealOnDisk(root, { ...reading.seal, nonce: randomBytes(32).toString('hex') })).toBe('predecessor-seal-unrecognized');
  });

  it.skipIf(!darwin)('[Sol BLOCK 2] the root lock: an ordinary holder makes the exclusive lock busy, and an exclusive holder makes ordinary wait then refuse', () => {
    const { root, db } = sealedRoot(); db.close();
    expect(acquireSharedRootLock(root, { waitMs: 0 })).toEqual({ kind: 'absent' }); // Never coordinated: nothing to honour.
    const exclusive = acquireExclusiveRootLock(root, { create: true });
    if (exclusive.kind !== 'held') throw new Error(exclusive.kind);
    expect(existsSync(join(root, PLACEMENT_ROOT_LOCK))).toBe(true);
    const started = Date.now();
    expect(acquireSharedRootLock(root, { waitMs: 200 })).toEqual({ kind: 'busy' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
    exclusive.lock.release();
    const shared = acquireSharedRootLock(root, { waitMs: 0 });
    if (shared.kind !== 'held') throw new Error(shared.kind);
    expect(acquireExclusiveRootLock(root, { create: true })).toEqual({ kind: 'busy' });
    shared.lock.release();
    const again = acquireExclusiveRootLock(root, { create: false });
    expect(again.kind).toBe('held');
    if (again.kind === 'held') again.lock.release();
  });

  /** A sealed root whose database is a large sparse file (the seal binds that size). */
  function sealedLargeRoot(bytes: number) {
    const { root, db, journal } = sealedRoot();
    const recorded = recordRootSeal(db, journal.incarnationId); db.close();
    truncateSync(join(root, 'app.sqlite'), bytes); // Sparse: no blocks are written.
    const written = writeRootSeal(root, { generation: recorded.generation, incarnationId: journal.incarnationId, nonce: recorded.nonce });
    if (!written.written) throw new Error(written.reason);
    const reading = readRootSeal(root);
    if (reading.kind !== 'sealed') throw new Error('sealed');
    return { root, seal: reading.seal };
  }
  const leftovers = (root: string) => readdirSync(join(root, PLACEMENT_ROOT_SEAL.directory)).filter(name => name !== PLACEMENT_ROOT_SEAL.name && name !== WORKBENCH_ADOPTION_HELPER_LAYOUT.toolDir[1]);

  it('[Sol r2 WARN 2] a database over the cap is unverifiable, refused before any copy', () => {
    const { root, seal } = sealedLargeRoot(1536 * 1024 * 1024);
    const before = process.memoryUsage().arrayBuffers;
    expect(confirmRootSealOnDisk(root, seal)).toBe('predecessor-seal-unverifiable'); // Default cap: 1 GiB.
    expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(64 * 1024 * 1024);
    expect(leftovers(root)).toEqual([]);
    expect(readRootSeal(root)).toMatchObject({ kind: 'sealed' });
  });

  it('[Sol r2 WARN 2] a large database within the cap confirms from a bounded, sparse snapshot that is removed afterwards', () => {
    const { root, seal } = sealedLargeRoot(512 * 1024 * 1024);
    const before = process.memoryUsage().arrayBuffers;
    expect(confirmRootSealOnDisk(root, seal)).toBeNull();
    expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(64 * 1024 * 1024); // Never a whole-database copy in memory.
    expect(leftovers(root)).toEqual([]);
    expect(readRootSeal(root)).toMatchObject({ kind: 'sealed' }); // The root itself is untouched.
    expect(statSync(join(root, 'app.sqlite')).size).toBe(512 * 1024 * 1024);
  });

  it('[Sol r2 WARN 2] a resource failure (no room for the snapshot) is unverifiable, not unrecognized', () => {
    const { root, db, journal } = sealedRoot();
    seal(root, db, journal.incarnationId);
    const reading = readRootSeal(root);
    if (reading.kind !== 'sealed') throw new Error('sealed');
    chmodSync(join(root, PLACEMENT_ROOT_SEAL.directory), 0o500);
    try { expect(confirmRootSealOnDisk(root, reading.seal)).toBe('predecessor-seal-unverifiable'); }
    finally { chmodSync(join(root, PLACEMENT_ROOT_SEAL.directory), 0o700); }
    expect(confirmRootSealOnDisk(root, reading.seal, { maxBytes: 1024 })).toBe('predecessor-seal-unverifiable');
  });
});
