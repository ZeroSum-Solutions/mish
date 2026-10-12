import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { bindPlacementRuntimeOwner, authorizePlacementRecovery, PlacementWriteCoordinator } from '../../../src/workbench/placement/write-coordinator.js';
import { migratePlacementJournal, PlacementJournal, type OperationManifest, type ProcessIdentity, type RecoveryObservation } from '../../../src/workbench/placement/journal.js';

const owned: Array<{ root: string; db: Database.Database }> = [];
const digest = 'a'.repeat(64), otherDigest = 'b'.repeat(64);
const identity: ProcessIdentity = { pid: 71, bootId: 'boot-a', startToken: 'start-a', handshakeId: 'handshake-a' };
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'placement-journal-'));
  const db = new Database(path.join(root, 'fixture.sqlite'));
  db.pragma('journal_mode=WAL'); db.pragma('synchronous=FULL'); db.pragma('foreign_keys=ON');
  migratePlacementJournal(db); owned.push({ root, db });
  const journal = new PlacementJournal({ db, incarnationId: 'first' });
  const projectRoot = path.join(root, 'project');
  const manifest: OperationManifest = { operationId: 'operation', principalId: 'principal', projectId: 'project', projectRoot, kind: 'apply', idempotencyKey: 'key', inputDigest: digest, planDigest: digest,
    movements: [{ movementId: 'publish', kind: 'publish', source: path.join(root, 'staged'), destination: path.join(projectRoot, 'entry.tsx'), expectedSource: { device: '1', inode: '2', sha256: digest, byteLength: 3 }, snapshot: { snapshotId: 'immutable-after', sha256: digest, byteLength: 3 } }] };
  return { root, db, journal, manifest };
}
afterEach(() => { for (const item of owned.splice(0).reverse()) { if (item.db.open) item.db.close(); rmSync(item.root, { recursive: true, force: true }); } });

describe('inactive placement journal', () => {
  it('round-trips 200-character principal and project identities through completion and reopen', () => {
    const f = fixture();
    const manifest = { ...f.manifest, principalId: 'p'.repeat(200), projectId: 'q'.repeat(200) };
    const op = completed(f, manifest);
    expect(op.manifest).toEqual(manifest);
    expect(f.journal.createOperation({ ...manifest, operationId: 'replay' })).toEqual(op);
    const next = new PlacementJournal({ db: f.db, incarnationId: 'next' });
    expect(next.readOperation(manifest.operationId).manifest).toEqual(manifest);
    expect(next.classifyRecovery([finalObservation(op)]).operations[0]!.disposition).toBe('verified');
  });
  it.each(['principalId', 'projectId'] as const)('refuses a 201-character %s before inserting an operation', (field) => {
    const { db, journal, manifest } = fixture();
    expect(() => journal.createOperation({ ...manifest, [field]: 'a'.repeat(201) }))
      .toThrowError(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
    expect(db.prepare('SELECT COUNT(*) AS n FROM placement_journal_operations').get()).toEqual({ n: 0 });
  });
  it('replays identical scoped input and refuses changed immutable manifests', () => {
    const { journal, manifest } = fixture();
    const first = journal.createOperation(manifest);
    expect(first).toMatchObject({ state: 'queued', revision: 0 });
    expect(journal.createOperation({ ...manifest, operationId: 'retry-id' })).toEqual(first);
    expect(() => journal.createOperation({ ...manifest, inputDigest: otherDigest })).toThrowError(expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' }));
    expect(() => journal.createOperation({ ...manifest, movements: [] })).toThrow();
  });
  it('requires durable intent and exact verified receipt before completion', () => {
    const { journal, manifest } = fixture(); journal.createOperation(manifest);
    expect(() => journal.recordMovementReceipt('operation', 0, 'publish', { source: 'absent', destination: manifest.movements[0]!.expectedSource, verificationDigest: digest })).toThrow();
    journal.startOperation('operation', 0);
    const intent = journal.recordMovementIntent('operation', 1, 'publish');
    expect(intent).toMatchObject({ created: true, operation: { revision: 2, stage: 'movement-intent' } });
    expect(() => journal.completeOperation('operation', 2, digest)).toThrowError(expect.objectContaining({ code: 'RECOVERY_REQUIRED' }));
    expect(() => journal.recordMovementReceipt('operation', 2, 'publish', { source: 'absent', destination: { ...manifest.movements[0]!.expectedSource, inode: 'foreign' }, verificationDigest: digest })).toThrow();
    const receipt = { source: 'absent' as const, destination: manifest.movements[0]!.expectedSource, verificationDigest: digest };
    journal.recordMovementReceipt('operation', 2, 'publish', receipt);
    expect(journal.recordMovementReceipt('operation', 2, 'publish', receipt).revision).toBe(3);
    expect(journal.completeOperation('operation', 3, digest)).toMatchObject({ state: 'done', stage: 'complete', revision: 4 });
  });
  it('keeps unknown prior launch globally closed even with interrupted labels and zero observed children', () => {
    const { db, journal, manifest } = fixture(); journal.createOperation(manifest); journal.startOperation('operation', 0);
    journal.recordLaunchIntent({ launchId: 'helper', kind: 'helper', operationId: 'operation', projectRoots: [manifest.projectRoot], intentDigest: digest });
    journal.interruptOperation('operation', 1, 'daemon-exit');
    const next = new PlacementJournal({ db, incarnationId: 'next' });
    expect(next.classifyRecovery([])).toMatchObject({ global: 'blocked', unresolvedLaunches: ['helper'], operations: [] });
    expect(() => next.readPreviousIncarnationRecovery([])).toThrowError(expect.objectContaining({ code: 'RECOVERY_REQUIRED' }));
    expect(() => new PlacementJournal({ db, incarnationId: 'first' })).toThrowError(expect.objectContaining({ code: 'INCARNATION_REUSED' }));
  });
  it('requires observed exact identity, actual exit and actual drain separately', () => {
    const { db, journal } = fixture();
    journal.recordLaunchIntent({ launchId: 'child', kind: 'child', projectRoots: [], intentDigest: digest });
    const next = new PlacementJournal({ db, incarnationId: 'next' });
    expect(() => next.recordLaunchExit('child', identity, digest)).toThrow();
    next.observeLaunch('child', identity, digest);
    expect(() => next.recordLaunchDrain('child', identity, digest)).toThrow();
    expect(() => next.recordLaunchExit('child', { ...identity, startToken: 'reused-pid' }, digest)).toThrowError(expect.objectContaining({ code: 'IDENTITY_CONFLICT' }));
    next.recordLaunchExit('child', identity, digest);
    expect(next.classifyRecovery([]).global).toBe('blocked');
    next.recordLaunchDrain('child', identity, digest);
    expect(next.recordLaunchDrain('child', identity, digest).drainDigest).toBe(digest);
    expect(next.readPreviousIncarnationRecovery([])).toEqual({ blockedProjectRoots: [] });
  });
  it('does not let an outer transaction or weak synchronization supply durable intent', () => {
    const { db, journal, manifest } = fixture(); journal.createOperation(manifest); journal.startOperation('operation', 0);
    expect(() => db.transaction(() => journal.recordMovementIntent('operation', 1, 'publish'))()).toThrowError(expect.objectContaining({ code: 'DURABILITY_UNQUALIFIED' }));
    db.pragma('synchronous=NORMAL');
    expect(() => journal.recordMovementIntent('operation', 1, 'publish')).toThrowError(expect.objectContaining({ code: 'DURABILITY_UNQUALIFIED' }));
    expect(journal.readOperation('operation').revision).toBe(1);
  });
});

function completed(f: ReturnType<typeof fixture>, manifest = f.manifest) {
  const { journal } = f;
  journal.createOperation(manifest); journal.startOperation(manifest.operationId, 0);
  let revision = 1;
  for (const move of manifest.movements) {
    journal.recordMovementIntent(manifest.operationId, revision++, move.movementId);
    journal.recordMovementReceipt(manifest.operationId, revision++, move.movementId, { source: 'absent', destination: move.expectedSource, verificationDigest: digest });
  }
  return journal.completeOperation(manifest.operationId, revision, digest);
}
function finalObservation(op: ReturnType<PlacementJournal['readOperation']>): RecoveryObservation {
  const objects = new Map<string, RecoveryObservation['objects'][number]['observation']>();
  for (const move of op.manifest.movements) { objects.set(move.source, { kind: 'absent' }); objects.set(move.destination, { kind: 'file', file: move.expectedSource }); }
  return { operationId: op.manifest.operationId, revision: op.revision, objects: [...objects].map(([location, observation]) => ({ location, observation })) };
}

describe('conservative journal reentry', () => {
  it('requires disk WAL and refuses memory or a different journal mode', () => {
    const memory = new Database(':memory:');
    try { memory.pragma('foreign_keys=ON'); migratePlacementJournal(memory); expect(() => new PlacementJournal({ db: memory, incarnationId: 'memory' })).toThrowError(expect.objectContaining({ code: 'DURABILITY_UNQUALIFIED' })); }
    finally { memory.close(); }
    const { db, journal, manifest } = fixture(); journal.createOperation(manifest); journal.startOperation('operation', 0); expect(db.pragma('journal_mode=DELETE', { simple: true })).toBe('delete');
    expect(() => journal.recordMovementIntent('operation', 1, 'publish')).toThrowError(expect.objectContaining({ code: 'DURABILITY_UNQUALIFIED' }));
  });
  it('reopens committed intent after owned fixture SIGKILL without inventing spawn or receipt', () => {
    const { db, root } = fixture(); db.close();
    const child = spawnSync(process.execPath, ['--experimental-strip-types', fileURLToPath(new URL('./journal-crash-fixture.ts', import.meta.url)), path.join(root, 'fixture.sqlite'), root], { encoding: 'utf8', timeout: 10_000, env: { PATH: process.env.PATH } });
    expect(child.error).toBeUndefined(); expect(child.signal).toBe('SIGKILL'); expect(child.stdout).toContain('durable-intents-committed');
    const reopened = new Database(path.join(root, 'fixture.sqlite')); owned.push({ root, db: reopened }); reopened.pragma('foreign_keys=ON'); reopened.pragma('synchronous=FULL');
    const next = new PlacementJournal({ db: reopened, incarnationId: 'after-crash' });
    expect(next.readOperation('crashed')).toMatchObject({ state: 'running', stage: 'movement-intent', revision: 2, movements: [{ intent: true, receipt: null }] });
    expect(next.classifyRecovery([])).toMatchObject({ global: 'blocked', unresolvedLaunches: ['unobserved-helper'] });
    expect(() => next.completeOperation('crashed', 2, digest)).toThrowError(expect.objectContaining({ code: 'RECOVERY_REQUIRED' }));
  });
  it('invalidates prior handles and never turns a replayed intent into permission to repeat movement', () => {
    const { db, journal, manifest } = fixture(); journal.createOperation(manifest); journal.startOperation('operation', 0);
    expect(journal.recordMovementIntent('operation', 1, 'publish').created).toBe(true);
    expect(journal.recordMovementIntent('operation', 1, 'publish').created).toBe(false);
    const next = new PlacementJournal({ db, incarnationId: 'next' });
    expect(() => journal.classifyRecovery([])).toThrowError(expect.objectContaining({ code: 'INCARNATION_REUSED' }));
    expect(next.recordMovementIntent('operation', 1, 'publish').created).toBe(false);
    expect(() => next.recordMovementReceipt('operation', 2, 'publish', { source: 'absent', destination: manifest.movements[0]!.expectedSource, verificationDigest: digest })).toThrow();
    expect(next.classifyRecovery([]).operations[0]!.disposition).toBe('recovery-required');
  });
  it('does not trust done labels without revision-bound current objects and exact inode/bytes', () => {
    const f = fixture(), op = completed(f), observation = finalObservation(op);
    const next = new PlacementJournal({ db: f.db, incarnationId: 'next' });
    expect(next.classifyRecovery([]).operations[0]!.disposition).toBe('recovery-required');
    expect(next.classifyRecovery([{ ...observation, revision: 0 }]).operations[0]!.disposition).toBe('recovery-required');
    expect(next.classifyRecovery([observation]).operations[0]!.disposition).toBe('verified');
    const changed = structuredClone(observation); const present = changed.objects.find(o => o.observation.kind === 'file')!;
    if (present.observation.kind !== 'file') throw new Error('fixture');
    present.observation.file = { ...present.observation.file, inode: '99' };
    expect(next.classifyRecovery([changed]).operations[0]!.disposition).toBe('conflict');
    present.observation.file = { ...present.observation.file, inode: '2', sha256: otherDigest };
    expect(next.classifyRecovery([changed]).operations[0]!.disposition).toBe('conflict');
  });
  it('classifies missing, absent, unknown and duplicate location observations conservatively', () => {
    const f = fixture(), op = completed(f), observation = finalObservation(op);
    const next = new PlacementJournal({ db: f.db, incarnationId: 'next' });
    expect(next.classifyRecovery([{ ...observation, objects: observation.objects.slice(0, 1) }]).operations[0]!.disposition).toBe('recovery-required');
    expect(next.classifyRecovery([{ ...observation, objects: observation.objects.map(o => ({ ...o, observation: { kind: 'unknown' as const } })) }]).operations[0]!.disposition).toBe('recovery-required');
    expect(next.classifyRecovery([{ ...observation, objects: observation.objects.map(o => ({ ...o, observation: { kind: 'absent' as const } })) }]).operations[0]!.disposition).toBe('conflict');
    expect(() => next.classifyRecovery([{ ...observation, objects: [...observation.objects, observation.objects[0]!] }])).toThrow();
    expect(() => next.classifyRecovery([observation, observation])).toThrow();
  });
  it('keeps lost receipts unresolved even when after bytes and identity currently match', () => {
    const f = fixture(); f.journal.createOperation(f.manifest); f.journal.startOperation('operation', 0); f.journal.recordMovementIntent('operation', 1, 'publish');
    const op = f.journal.readOperation('operation'), observation = finalObservation(op);
    const next = new PlacementJournal({ db: f.db, incarnationId: 'next' });
    expect(next.classifyRecovery([observation]).operations[0]!.disposition).toBe('recovery-required');
    expect(next.readOperation('operation').movements[0]!.receipt).toBeNull();
  });
  it('verifies final reused names after ordered retirement then publication', () => {
    const f = fixture(); const publication = f.manifest.movements[0]!;
    const before = { ...publication.expectedSource, inode: '1', sha256: otherDigest };
    const manifest: OperationManifest = { ...f.manifest, movements: [{ movementId: 'retire', kind: 'retire', source: publication.destination, destination: path.join(f.root, 'retained-before'), expectedSource: before, snapshot: { snapshotId: 'immutable-before', sha256: otherDigest, byteLength: 3 } }, publication] };
    f.journal.createOperation(manifest); f.journal.startOperation('operation', 0);
    expect(() => f.journal.recordMovementIntent('operation', 1, 'publish')).toThrowError(expect.objectContaining({ code: 'STATE_CONFLICT' }));
    f.journal.recordMovementIntent('operation', 1, 'retire'); f.journal.recordMovementReceipt('operation', 2, 'retire', { source: 'absent', destination: before, verificationDigest: digest });
    expect(() => f.journal.completeOperation('operation', 3, digest)).toThrow();
    f.journal.recordMovementIntent('operation', 3, 'publish'); f.journal.recordMovementReceipt('operation', 4, 'publish', { source: 'absent', destination: publication.expectedSource, verificationDigest: digest });
    const op = f.journal.completeOperation('operation', 5, digest);
    const next = new PlacementJournal({ db: f.db, incarnationId: 'next' });
    expect(next.classifyRecovery([finalObservation(op)]).operations[0]!.disposition).toBe('verified');
  });
  it('clears global uncertainty before classifying exact project conflicts and does no reconciliation writes', () => {
    const f = fixture(), op = completed(f); const other: OperationManifest = { ...f.manifest, operationId: 'other', projectId: 'other', projectRoot: path.join(f.root, 'other-project'), idempotencyKey: 'other-key', movements: f.manifest.movements.map(m => ({ ...m, destination: path.join(f.root, 'other-project', 'entry.tsx') })) };
    const otherOp = completed(f, other);
    f.journal.recordLaunchIntent({ launchId: 'prior-child', kind: 'child', projectRoots: [], intentDigest: digest });
    const next = new PlacementJournal({ db: f.db, incarnationId: 'next' });
    expect(next.classifyRecovery([finalObservation(op), finalObservation(otherOp)]).operations).toEqual([]);
    next.observeLaunch('prior-child', identity, digest); next.recordLaunchExit('prior-child', identity, digest); next.recordLaunchDrain('prior-child', identity, digest);
    const foreign = finalObservation(op); const actual = foreign.objects.find(o => o.observation.kind === 'file')!;
    actual.observation = { kind: 'file', file: { ...f.manifest.movements[0]!.expectedSource, inode: '99' } };
    const beforeChanges = f.db.prepare('SELECT total_changes() AS count').get();
    const report = next.classifyRecovery([foreign, finalObservation(otherOp)]);
    expect(report.operations.map(o => o.disposition)).toEqual(['conflict', 'verified']);
    expect(report.operations[0]!.partial).toEqual(foreign.objects);
    expect(next.readPreviousIncarnationRecovery([foreign, finalObservation(otherOp)])).toEqual({ blockedProjectRoots: [] });
    expect(f.db.prepare('SELECT total_changes() AS count').get()).toEqual(beforeChanges);
  });
  it('keeps failed/interrupted mutation states unresolved while pre-intent failure remains no-mutation', () => {
    const f = fixture(); f.journal.createOperation(f.manifest); f.journal.startOperation('operation', 0); f.journal.recordMovementIntent('operation', 1, 'publish');
    expect(f.journal.failOperation('operation', 2, 'lost-result').stage).toBe('recovery-required');
    const fresh = { ...f.manifest, operationId: 'preflight', idempotencyKey: 'preflight-key' }; f.journal.createOperation(fresh); f.journal.failOperation('preflight', 0, 'refused-before-intent');
    const next = new PlacementJournal({ db: f.db, incarnationId: 'next' });
    expect(next.classifyRecovery([]).operations.map(o => o.disposition)).toEqual(['recovery-required', 'no-mutation']);
    expect(() => next.startOperation('operation', 3)).toThrow();
  });
  it('keeps launch retries immutable and distinguishes new process identity from PID reuse', () => {
    const { journal } = fixture(); const intent = { launchId: 'one', kind: 'helper' as const, projectRoots: [], intentDigest: digest };
    expect(journal.recordLaunchIntent(intent).created).toBe(true); expect(journal.recordLaunchIntent(intent).created).toBe(false);
    expect(() => journal.recordLaunchIntent({ ...intent, intentDigest: otherDigest })).toThrow();
    journal.observeLaunch('one', identity, digest); journal.recordLaunchExit('one', identity, digest); journal.recordLaunchDrain('one', identity, digest);
    journal.recordLaunchIntent({ ...intent, launchId: 'two' });
    expect(() => journal.observeLaunch('two', identity, digest)).toThrowError(expect.objectContaining({ code: 'IDENTITY_CONFLICT' }));
    expect(journal.observeLaunch('two', { ...identity, startToken: 'new-process', handshakeId: 'new-handshake' }, digest).identity!.pid).toBe(identity.pid);
  });
  it('refuses completion until linked helper exit and process-tree drainage are separately committed', () => {
    const f = fixture(); f.journal.createOperation(f.manifest); f.journal.startOperation('operation', 0); f.journal.recordMovementIntent('operation', 1, 'publish');
    f.journal.recordMovementReceipt('operation', 2, 'publish', { source: 'absent', destination: f.manifest.movements[0]!.expectedSource, verificationDigest: digest });
    f.journal.recordLaunchIntent({ launchId: 'helper', kind: 'helper', operationId: 'operation', projectRoots: [f.manifest.projectRoot], intentDigest: digest });
    f.journal.observeLaunch('helper', identity, digest); f.journal.recordLaunchExit('helper', identity, digest);
    expect(() => f.journal.completeOperation('operation', 3, digest)).toThrow();
    f.journal.recordLaunchDrain('helper', identity, digest); expect(f.journal.completeOperation('operation', 3, digest).state).toBe('done');
  });
  it('preserves immutable input, revision conflicts and repeated terminal transitions', () => {
    const f = fixture(); f.journal.createOperation(f.manifest); f.manifest.movements[0]!.expectedSource.inode = '9';
    expect(f.journal.readOperation('operation').manifest.movements[0]!.expectedSource.inode).toBe('2');
    f.journal.startOperation('operation', 0); expect(f.journal.startOperation('operation', 0).revision).toBe(1);
    expect(() => f.journal.recordMovementIntent('operation', 0, 'publish')).toThrowError(expect.objectContaining({ code: 'REVISION_CONFLICT' }));
    f.journal.interruptOperation('operation', 1, 'cancelled-before-intent');
    expect(f.journal.interruptOperation('operation', 1, 'cancelled-before-intent').revision).toBe(2);
    expect(() => f.journal.failOperation('operation', 2, 'different-terminal')).toThrow();
  });
});


describe('journal integration boundary', () => {
  it('supplies F3 global refusal then project-local conflicts through a trusted future adapter', async () => {
    const f = fixture(); f.journal.createOperation(f.manifest); f.journal.startOperation('operation', 0); f.journal.recordMovementIntent('operation', 1, 'publish');
    f.journal.recordLaunchIntent({ launchId: 'prior', kind: 'helper', operationId: 'operation', projectRoots: [f.manifest.projectRoot], intentDigest: digest });
    const next = new PlacementJournal({ db: f.db, incarnationId: 'next' });
    const owner = bindPlacementRuntimeOwner({ canonicalDataRoot: f.root, inspect: () => ({ held: true, qualified: true }), readPreviousIncarnationRecovery: () => next.readPreviousIncarnationRecovery([]) });
    expect(() => authorizePlacementRecovery(owner)).toThrowError(expect.objectContaining({ code: 'OWNER_RECOVERING' }));
    next.observeLaunch('prior', identity, digest); next.recordLaunchExit('prior', identity, digest); next.recordLaunchDrain('prior', identity, digest);
    const coordinator = new PlacementWriteCoordinator({ owner, recovery: authorizePlacementRecovery(owner), resolveProjectRoot: async root => root });
    await expect(coordinator.acquireMutation({ projectRoots: [f.manifest.projectRoot] })).rejects.toMatchObject({ code: 'PROJECT_RECOVERING' });
    const unrelated = await coordinator.acquireMutation({ projectRoots: [path.join(f.root, 'unrelated')] }); coordinator.releaseMutation(unrelated);
    expect(coordinator.snapshot().registrations).toBe(0);
  });
  it('refuses malformed manifests, alias spellings and mismatched independent snapshots', () => {
    const f = fixture(), move = f.manifest.movements[0]!;
    expect(() => f.journal.createOperation({ ...f.manifest, projectRoot: f.manifest.projectRoot + path.sep })).toThrow();
    expect(() => f.journal.createOperation({ ...f.manifest, movements: [{ ...move, snapshot: { ...move.snapshot, sha256: otherDigest } }] })).toThrow();
    expect(() => f.journal.createOperation({ ...f.manifest, movements: [move, move] })).toThrow();
    expect(() => f.journal.recordLaunchIntent({ launchId: 'malformed', kind: 'child', projectRoots: ['relative'], intentDigest: digest })).toThrow();
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM placement_journal_operations').get()).toEqual({ n: 0 });
  });
  it('refuses corrupted done/drain labels instead of silently opening recovery', () => {
    const f = fixture(); f.journal.createOperation(f.manifest);
    const row = f.db.prepare('SELECT record_json FROM placement_journal_operations').get() as { record_json: string }; const op = JSON.parse(row.record_json); op.state = 'done'; op.stage = 'complete';
    f.db.prepare('UPDATE placement_journal_operations SET record_json=?').run(JSON.stringify(op));
    const next = new PlacementJournal({ db: f.db, incarnationId: 'next' });
    expect(() => next.readPreviousIncarnationRecovery([])).toThrow();
    next.recordLaunchIntent({ launchId: 'corrupt', kind: 'child', projectRoots: [], intentDigest: digest });
    const launchRow = f.db.prepare('SELECT record_json FROM placement_journal_launches').get() as { record_json: string }; const launch = JSON.parse(launchRow.record_json); launch.drainDigest = digest;
    f.db.prepare('UPDATE placement_journal_launches SET record_json=?').run(JSON.stringify(launch));
    expect(() => next.classifyRecovery([])).toThrowError(expect.objectContaining({ code: 'RECOVERY_REQUIRED' }));
  });
});

it('does not assign the same OS process to a second launch by changing only its handshake', () => {
  const { journal } = fixture(); const intent = { launchId: 'first-launch', kind: 'helper' as const, projectRoots: [], intentDigest: digest };
  journal.recordLaunchIntent(intent); journal.observeLaunch(intent.launchId, identity, digest);
  journal.recordLaunchIntent({ ...intent, launchId: 'second-launch' });
  expect(() => journal.observeLaunch('second-launch', { ...identity, handshakeId: 'another-handshake' }, digest)).toThrowError(expect.objectContaining({ code: 'IDENTITY_CONFLICT' }));
});

it('refuses a recovery decision inside an uncommitted outer transaction', () => {
  const f = fixture(); completed(f);
  const next = new PlacementJournal({ db: f.db, incarnationId: 'next' });
  expect(() => f.db.transaction(() => next.classifyRecovery([]))()).toThrowError(expect.objectContaining({ code: 'DURABILITY_UNQUALIFIED' }));
});


describe('Opus journal corrections', () => {
  it('M1 keeps completed historical drift informational instead of permanently blocking legitimate later writes', () => {
    const f = fixture(), first = completed(f);
    const second = { ...f.manifest, operationId: 'later', idempotencyKey: 'later-key', movements: f.manifest.movements.map(m => ({ ...m, expectedSource: { ...m.expectedSource, inode: '3' } })) };
    const secondOp = completed(f, second), firstRead = finalObservation(first);
    firstRead.objects.find(o => o.observation.kind === 'file')!.observation = { kind: 'file', file: second.movements[0]!.expectedSource };
    const next = new PlacementJournal({ db: f.db, incarnationId: 'next' });
    expect(next.classifyRecovery([firstRead, finalObservation(secondOp)]).operations.find(o => o.operationId === 'operation')!.disposition).toBe('conflict');
    expect(next.readPreviousIncarnationRecovery([firstRead, finalObservation(secondOp)])).toEqual({ blockedProjectRoots: [] });
    expect(next.readPreviousIncarnationRecovery([])).toEqual({ blockedProjectRoots: [] });
  });
  it('M2 does not claim no mutation for a live-root operation launch merely because intent observation is missing', () => {
    const f = fixture(); f.journal.createOperation(f.manifest); f.journal.startOperation('operation', 0);
    f.journal.recordLaunchIntent({ launchId: 'unconfined', kind: 'child', operationId: 'operation', projectRoots: [f.manifest.projectRoot], intentDigest: digest });
    const next = new PlacementJournal({ db: f.db, incarnationId: 'next' });
    next.observeLaunch('unconfined', identity, digest); next.recordLaunchExit('unconfined', identity, digest); next.recordLaunchDrain('unconfined', identity, digest);
    expect(next.classifyRecovery([]).operations[0]!.disposition).toBe('recovery-required');
    expect(next.readPreviousIncarnationRecovery([])).toEqual({ blockedProjectRoots: [f.manifest.projectRoot] });
  });
  it('M3 refuses oversized launch roots before commit so later evidence remains recordable', () => {
    const f = fixture();
    expect(() => f.journal.recordLaunchIntent({ launchId: 'too-many', kind: 'child', projectRoots: Array.from({ length: 257 }, (_, i) => path.join(f.root, String(i))), intentDigest: digest })).toThrow();
    expect(() => f.journal.recordLaunchIntent({ launchId: 'too-long', kind: 'child', projectRoots: [path.join(f.root, 'x'.repeat(4096))], intentDigest: digest })).toThrow();
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM placement_journal_launches').get()).toEqual({ n: 0 });
    f.journal.recordLaunchIntent({ launchId: 'valid', kind: 'child', projectRoots: [], intentDigest: digest });
    expect(f.journal.observeLaunch('valid', identity, digest).spawnDigest).toBe(digest);
  });
  it('M3 reserves worst-case receipt and terminal metadata space before any movement intent', () => {
    const f = fixture(), base = f.manifest.movements[0]!;
    const movements = Array.from({ length: 256 }, (_, i) => ({ ...base, movementId: 'm' + i, source: path.join(f.root, 's' + i + 'x'.repeat(3800)), destination: path.join(f.root, 'd' + i + 'x'.repeat(3800)) }));
    expect(() => f.journal.createOperation({ ...f.manifest, movements })).toThrow();
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM placement_journal_operations').get()).toEqual({ n: 0 });
  });
});
