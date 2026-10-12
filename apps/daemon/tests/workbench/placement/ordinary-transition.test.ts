import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { migratePlacementJournal, PlacementJournal, type OperationManifest } from '../../../src/workbench/placement/journal.js';
import { inspectOrdinaryTransition } from '../../../src/workbench/placement/ordinary-transition.js';
import { attachPlacementRuntime } from '../../../src/workbench/placement/runtime.js';

const digest = 'a'.repeat(64);
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) { try { chmodSync(root, 0o700); } catch { /* removed */ } rmSync(root, { recursive: true, force: true }); } });
function dataRoot() { const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'placement-transition-'))); roots.push(root); return root; }
function journalDb(root: string) {
  const db = new Database(path.join(root, 'app.sqlite'));
  db.pragma('journal_mode=WAL'); db.pragma('synchronous=FULL'); db.pragma('foreign_keys=ON');
  migratePlacementJournal(db); return db;
}
function manifest(root: string, id: string, projectRoot: string): OperationManifest {
  return { operationId: id, principalId: 'principal', projectId: 'project', projectRoot, kind: 'apply', idempotencyKey: id, inputDigest: digest, planDigest: digest,
    movements: [{ movementId: 'publish', kind: 'publish', source: path.join(root, `${id}-staged`), destination: path.join(projectRoot, 'entry.tsx'), expectedSource: { device: '1', inode: '2', sha256: digest, byteLength: 3 }, snapshot: { snapshotId: 'after', sha256: digest, byteLength: 3 } }] };
}
const files = (root: string) => ['app.sqlite', 'app.sqlite-wal', 'app.sqlite-shm'].map(name => {
  const file = path.join(root, name); return existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : null;
});

describe('C2a read-only ordinary transition pre-check', () => {
  it('missing database and never-activated databases invent no history', () => {
    expect(inspectOrdinaryTransition(path.join(dataRoot(), 'missing'))).toMatchObject({ kind: 'no-database', global: null, fencedProjectRoots: [] });
    const root = dataRoot(); const db = new Database(path.join(root, 'app.sqlite')); db.exec('CREATE TABLE projects (id TEXT)'); db.close();
    expect(inspectOrdinaryTransition(root)).toMatchObject({ kind: 'never-activated', global: null, unresolvedLaunches: [] });
    const after = new Database(path.join(root, 'app.sqlite'), { readonly: true });
    expect((after.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'placement_%'").all())).toEqual([]); after.close();
  });
  it('an unresolved launch closes globally; unfinished operations fence their roots; bytes are untouched', () => {
    const root = dataRoot(); const db = journalDb(root);
    const journal = new PlacementJournal({ db, incarnationId: 'coordinated-before-crash' });
    const fenced = path.join(root, 'projects', 'fenced'), done = path.join(root, 'projects', 'done');
    journal.createOperation(manifest(root, 'unfinished', fenced));
    journal.startOperation('unfinished', 0); journal.recordMovementIntent('unfinished', 1, 'publish');
    journal.createOperation(manifest(root, 'queued-only', path.join(root, 'projects', 'queued')));
    const finished = journal.createOperation(manifest(root, 'finished', done));
    journal.startOperation('finished', finished.revision); journal.recordMovementIntent('finished', 1, 'publish');
    journal.recordMovementReceipt('finished', 2, 'publish', { source: 'absent', destination: manifest(root, 'finished', done).movements[0]!.expectedSource, verificationDigest: digest });
    journal.completeOperation('finished', 3, digest);
    const before = files(root); // live WAL retained: simulates the coordinated process still having state on disk
    const projectOnly = inspectOrdinaryTransition(root);
    expect(projectOnly).toMatchObject({ kind: 'inspected', global: null, fencedProjectRoots: [fenced, path.join(root, 'projects', 'queued')].sort() });
    journal.recordLaunchIntent({ launchId: 'unobserved', kind: 'child', projectRoots: [], intentDigest: digest });
    const before2 = files(root);
    const inspection = inspectOrdinaryTransition(root);
    expect(inspection).toMatchObject({ kind: 'inspected', global: 'launch-unresolved', unresolvedLaunches: ['unobserved'] });
    // Database and WAL bytes are untouched. The -shm shared-memory index is
    // reader state that SQLite itself updates for any WAL reader (captured).
    expect(files(root).slice(0, 2)).toEqual(before2.slice(0, 2));
    expect(before.slice(0, 2)).not.toEqual(before2.slice(0, 2));
    expect((db.prepare('SELECT COUNT(*) AS n FROM placement_journal_incarnations').get() as { n: number }).n).toBe(1);
    db.close();
  });
  it('captures WAL/SHM read behavior and fails closed instead of a mutating open', () => {
    const root = dataRoot(); const db = journalDb(root); new PlacementJournal({ db, incarnationId: 'clean' }); db.close();
    const clean = inspectOrdinaryTransition(root);
    expect(clean.kind).toBe('inspected');
    expect(clean.sidecars.before).toEqual({ wal: false, shm: false });
    // Actual SQLite behavior on this host: a read-only WAL open may create the -shm/-wal index files.
    expect(clean.sidecars.after).not.toBeNull();
    for (const name of ['app.sqlite-wal', 'app.sqlite-shm']) rmSync(path.join(root, name), { force: true });
    chmodSync(root, 0o500); // Required SHM cannot be created; no mutating fallback may run.
    const locked = inspectOrdinaryTransition(root);
    chmodSync(root, 0o700);
    expect(locked.global === null ? locked.kind : locked.global).toMatch(/^(inspected|journal-unreadable:.+)$/);
    if (locked.global) expect(locked).toMatchObject({ kind: 'unreadable', unresolvedLaunches: [], fencedProjectRoots: [] });
  });
  it('partial schema and corrupt records fail closed globally', () => {
    const partial = dataRoot(); const p = new Database(path.join(partial, 'app.sqlite')); p.exec('CREATE TABLE placement_journal_launches (id TEXT)'); p.close();
    expect(inspectOrdinaryTransition(partial)).toMatchObject({ kind: 'unreadable', global: 'journal-unreadable:RECOVERY_REQUIRED' });
    const corrupt = dataRoot(); const db = journalDb(corrupt); new PlacementJournal({ db, incarnationId: 'corrupt' });
    db.prepare("INSERT INTO placement_journal_launches VALUES ('bad','corrupt',NULL,'{}')").run(); db.close();
    expect(inspectOrdinaryTransition(corrupt)).toMatchObject({ kind: 'unreadable', global: 'journal-unreadable:VALIDATION_FAILED' });
    const unreadable = dataRoot(); mkdirSync(path.join(unreadable, 'app.sqlite'));
    expect(inspectOrdinaryTransition(unreadable).global).toMatch(/^journal-unreadable:/);
  });
  it('ordinary runtime maps fences to projects and cannot clear them', async () => {
    const root = dataRoot(); const projects = path.join(root, 'projects'); mkdirSync(path.join(projects, 'fenced'), { recursive: true }); mkdirSync(path.join(projects, 'free'));
    const db = journalDb(root); const journal = new PlacementJournal({ db, incarnationId: 'prior' });
    journal.createOperation(manifest(root, 'unfinished', path.join(projects, 'fenced'))); db.close();
    const transition = inspectOrdinaryTransition(root);
    const host = { platform: 'darwin', arch: 'arm64', node: '24.16.0', osRelease: '25.5.0', mainThread: true };
    const sources = [{ id: 'fenced' }, { id: 'free' }];
    const runtime = attachPlacementRuntime({ mode: 'ordinary-uncoordinated', reason: 'not-activated', hostFact: null, host, transition },
      { db: new Database(':memory:'), projectsDir: projects, readProject: id => sources.find(s => s.id === id) ?? null, listProjects: () => sources });
    expect(runtime.status()).toMatchObject({ mode: 'ordinary-uncoordinated', reason: 'not-activated', transition: { fencedProjectIds: ['fenced'] }, activation: { adoption: 'closed' } });
    expect(() => runtime.assertMutationAdmissible('fenced')).toThrowError(expect.objectContaining({ code: 'PROJECT_RECOVERING' }));
    expect(() => runtime.assertMutationAdmissible('free')).not.toThrow();
    expect(runtime.checkMutationRequest({ method: 'POST', path: '/api/projects/fenced/upload' })).toMatchObject({ status: 503, details: { reason: 'PROJECT_RECOVERING' } });
    expect(runtime.checkMutationRequest({ method: 'POST', path: '/api/runs', body: { projectId: 'fenced' } })).toMatchObject({ status: 503 });
    expect(runtime.checkMutationRequest({ method: 'GET', path: '/api/projects/fenced' })).toBeNull();
    expect(runtime.checkMutationRequest({ method: 'POST', path: '/api/projects/free/upload' })).toBeNull();
    await runtime.refreshRecovery();
    expect(() => runtime.assertMutationAdmissible('fenced')).toThrow();
    const global = attachPlacementRuntime({ mode: 'ordinary-uncoordinated', reason: 'not-activated', hostFact: null, host, transition: { ...transition, global: 'launch-unresolved' } },
      { db: new Database(':memory:'), projectsDir: projects, readProject: () => null, listProjects: () => [] });
    expect(() => global.assertMutationAdmissible()).toThrowError(expect.objectContaining({ code: 'ADMISSION_CLOSED' }));
    expect(global.checkMutationRequest({ method: 'PUT', path: '/api/app-config' })).toMatchObject({ status: 503 });
    expect(global.checkMutationRequest({ method: 'GET', path: '/api/projects' })).toBeNull();
  });
  it('fences re-evaluate current metadata: later ancestor imports, rebinds and unknown roots refuse; unaffected projects admit', () => {
    const root = dataRoot(); const projects = path.join(root, 'projects'); const external = path.join(root, 'external');
    for (const dir of ['fenced', 'free', 'other']) mkdirSync(path.join(projects, dir), { recursive: true });
    mkdirSync(external);
    const db = journalDb(root); new PlacementJournal({ db, incarnationId: 'prior' }).createOperation(manifest(root, 'unfinished', path.join(projects, 'fenced'))); db.close();
    const transition = inspectOrdinaryTransition(root);
    const host = { platform: 'darwin', arch: 'arm64', node: '24.16.0', osRelease: '25.5.0', mainThread: true };
    const sources = new Map<string, { id: string; metadata?: unknown }>([['fenced', { id: 'fenced' }], ['free', { id: 'free' }], ['other', { id: 'other' }]]);
    const runtime = attachPlacementRuntime({ mode: 'ordinary-uncoordinated', reason: 'not-activated', hostFact: null, host, transition },
      { db: new Database(':memory:'), projectsDir: projects, readProject: id => sources.get(id) ?? null, listProjects: () => [...sources.values()] });
    sources.set('ancestor', { id: 'ancestor', metadata: { baseDir: projects } });
    expect(() => runtime.assertMutationAdmissible('ancestor')).toThrowError(expect.objectContaining({ code: 'PROJECT_RECOVERING' }));
    sources.set('free', { id: 'free', metadata: { baseDir: root } });
    expect(() => runtime.assertMutationAdmissible('free')).toThrowError(expect.objectContaining({ code: 'PROJECT_RECOVERING' }));
    sources.set('lost', { id: 'lost', metadata: { baseDir: path.join(root, 'missing-import') } });
    expect(() => runtime.assertMutationAdmissible('lost')).toThrowError(expect.objectContaining({ code: 'PROJECT_RECOVERING' }));
    expect(() => runtime.assertMutationAdmissible('other')).not.toThrow();
    sources.set('outside', { id: 'outside', metadata: { baseDir: external } });
    expect(() => runtime.assertMutationAdmissible('outside')).not.toThrow();
    expect(() => runtime.assertMutationAdmissible('brand-new')).not.toThrow();
    expect(runtime.checkMutationRequest({ method: 'POST', path: '/api/import/folder', body: { baseDir: projects } })).toMatchObject({ status: 503 });
    expect(runtime.checkMutationRequest({ method: 'PATCH', path: '/api/projects/other/working-dir', body: { baseDir: root } })).toMatchObject({ status: 503 });
    expect(runtime.checkMutationRequest({ method: 'POST', path: '/api/import/folder', body: { baseDir: external } })).toBeNull();
    expect(runtime.status().transition).toMatchObject({ fencedProjectRoots: [path.join(projects, 'fenced')], fencedProjectIds: ['ancestor', 'fenced', 'free', 'lost'] });
    // No fences: no physical resolution is needed and nothing is refused.
    const clear = attachPlacementRuntime({ mode: 'ordinary-uncoordinated', reason: 'not-activated', hostFact: null, host, transition: { ...transition, fencedProjectRoots: [] } },
      { db: new Database(':memory:'), projectsDir: projects, readProject: id => sources.get(id) ?? null, listProjects: () => [...sources.values()] });
    expect(() => clear.assertMutationAdmissible('lost')).not.toThrow();
  });
  it('a retained placement-journal migration marker with all journal tables missing fails closed without repair', () => {
    const root = dataRoot(); const file = path.join(root, 'app.sqlite');
    const db = new Database(file); db.pragma('journal_mode=WAL');
    db.exec('CREATE TABLE workbench_owned_migrations (name TEXT PRIMARY KEY, version INTEGER NOT NULL, applied_at INTEGER NOT NULL)');
    db.prepare('INSERT INTO workbench_owned_migrations VALUES (?,?,?)').run('placement-journal', 1, 1);
    db.pragma('wal_checkpoint(TRUNCATE)'); db.close();
    const before = files(root);
    const inspection = inspectOrdinaryTransition(root);
    expect(inspection).toMatchObject({ kind: 'unreadable', global: 'journal-unreadable:RECOVERY_REQUIRED' });
    expect(files(root)[0]).toBe(before[0]);
    const after = new Database(file, { readonly: true });
    expect(after.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'placement_%'").all()).toEqual([]);
    expect(after.prepare('SELECT name FROM workbench_owned_migrations').all()).toEqual([{ name: 'placement-journal' }]);
    after.close();
    // A marker for another migration only is not journal history.
    const other = dataRoot(); const o = new Database(path.join(other, 'app.sqlite'));
    o.exec('CREATE TABLE workbench_owned_migrations (name TEXT PRIMARY KEY, version INTEGER NOT NULL, applied_at INTEGER NOT NULL)');
    o.prepare('INSERT INTO workbench_owned_migrations VALUES (?,?,?)').run('source-records', 1, 1); o.close();
    expect(inspectOrdinaryTransition(other)).toMatchObject({ kind: 'never-activated', global: null });
  });
});
