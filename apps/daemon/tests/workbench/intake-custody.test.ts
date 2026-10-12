import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { libraryObjectPath } from '../../src/library.js';
import { createIntakeWriteAuthority, IntakeService } from '../../src/workbench/intake.js';
import { createFenceOnlyProjectWrites } from '../../src/workbench/placement/project-writes.js';
import { PlacementCoordinationError } from '../../src/workbench/placement/write-coordinator.js';
import { mapPlacementFailure } from '../../src/workbench/placement/runtime-status.js';
import { cleanupIntakeRoots, coordinatedIntake, filesUnder, intakeManifest, outcome, ticks, waitFor } from './intake-placement-fixture.js';

/**
 * Intake root-store and project custody through the real coordinator,
 * registry and coordinated project writes (synthetic owner binding).
 * Every case fails on a service that writes outside admission.
 */
afterEach(cleanupIntakeRoots);
type Fixture = ReturnType<typeof coordinatedIntake>;
type Hooks = { afterCopy?: () => Promise<void>; beforePublish?: (temporaryPath: string) => Promise<void>; projectDirectory?: (id: string, dir: string) => Promise<string> };
const service = (f: Fixture, hooks: Hooks = {}) => new IntakeService({ db: f.db, libraryDir: f.libraryDir, projectsDir: f.projects, projectDirectory: f.projectDirectory, authority: f.authority, ...hooks } as ConstructorParameters<typeof IntakeService>[0]);
const settle = <T>(work: () => T | Promise<T>) => Promise.resolve().then(work);
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const tempDir = (f: Fixture) => path.join(f.libraryDir, 'intake-temp');
const temps = (f: Fixture) => existsSync(tempDir(f)) ? readdirSync(tempDir(f)) : [];
const receipts = (f: Fixture, batchId: string, fileId: string) => JSON.parse(f.row(batchId, fileId).materializations_json) as { relPath: string; complete: boolean }[];

describe('startup interrupted-transfer recovery is an admitted root write', () => {
  it('leaves queued rows while admission is closed and reselects them once admitted', async () => {
    const f = coordinatedIntake(); const input = intakeManifest(); const id = input.files[0]!.clientFileId;
    await settle(() => service(f).create(input, null));
    f.loseRecovery();
    const restarted = service(f);
    expect(f.row(input.intakeBatchId, id)).toMatchObject({ state: 'queued', error_json: null });
    expect(await (restarted as unknown as { recoverInterrupted(): Promise<string> }).recoverInterrupted()).toBe('deferred');
    expect(f.row(input.intakeBatchId, id)).toMatchObject({ state: 'queued', error_json: null });
    f.recover();
    // The next admitted root write applies the deferred recovery before its own effect.
    const later = intakeManifest(); await restarted.create(later, null);
    expect(f.row(input.intakeBatchId, id).state).toBe('needs-reselection');
    expect(f.row(later.intakeBatchId, later.files[0]!.clientFileId).state).toBe('queued');
    expect(await (restarted as unknown as { recoverInterrupted(): Promise<string> }).recoverInterrupted()).toBe('recovered');
  });
});

describe('closed coordinated admission refuses before the first root effect', () => {
  it('create and raw PUT refuse (503) with no SQL row, temp directory, object or error state', async () => {
    const f = coordinatedIntake(); const input = intakeManifest(); const id = input.files[0]!.clientFileId;
    const live = service(f); await settle(() => live.create(input, null));
    f.loseRecovery();
    const refusedCreate = await settle(() => live.create(intakeManifest(), null)).then(() => null, error => error);
    expect(refusedCreate).toMatchObject({ code: 'OWNER_RECOVERING' }); expect(mapPlacementFailure(refusedCreate)).toMatchObject({ status: 503 });
    expect(f.count('workbench_intake_batches')).toBe(1);
    const refusedPut = await live.put(input.intakeBatchId, id, Readable.from(['abc'])).then(() => null, error => error);
    expect(refusedPut).toMatchObject({ code: 'OWNER_RECOVERING' }); expect(mapPlacementFailure(refusedPut)).toMatchObject({ status: 503 });
    expect(existsSync(tempDir(f))).toBe(false); expect(filesUnder(f.libraryDir)).toEqual([]);
    expect(f.row(input.intakeBatchId, id)).toMatchObject({ state: 'queued', error_json: null }); expect(f.count('library_assets')).toBe(0);
    f.recover();
    expect((await live.put(input.intakeBatchId, id, Readable.from(['abc']))).file.state).toBe('stored');
  });
});

describe('project materialization runs under the physical project gate after root custody settles', () => {
  it('recovers an incomplete imported alias receipt after another project publishes that filename', async () => {
    const f = coordinatedIntake(); const shared = f.imported('a', 'shared'); f.imported('b', 'shared');
    let refuseFirstCopy = true;
    const a = service(f, { beforePublish: async () => { if (refuseFirstCopy) { refuseFirstCopy = false; throw new Error('copy interrupted'); } } });
    const b = service(f);
    const aInput = intakeManifest({ kind: 'project', projectId: 'a' });
    const bInput = intakeManifest({ kind: 'project', projectId: 'b' });
    await a.create(aInput, null); await b.create(bInput, null);
    const first = await a.put(aInput.intakeBatchId, aInput.files[0]!.clientFileId, Readable.from(['abc']));
    expect(first.file.hasSuccessfulAttachment).toBe(false);
    expect(receipts(f, aInput.intakeBatchId, aInput.files[0]!.clientFileId)).toEqual([{ projectId: 'a', relPath: 'héllo.bin', complete: false }]);
    const second = await b.put(bInput.intakeBatchId, bInput.files[0]!.clientFileId, Readable.from(['xyz']));
    expect(second.file.hasSuccessfulAttachment).toBe(true);
    expect(readFileSync(path.join(shared, 'héllo.bin'), 'utf8')).toBe('xyz');
    const retried = await a.retryProjectPlacement(aInput.intakeBatchId, aInput.files[0]!.clientFileId);
    expect(retried.file).toMatchObject({ hasSuccessfulAttachment: true, stored: { projectFile: { projectId: 'a', relPath: 'héllo-1.bin' } } });
    expect(readFileSync(path.join(shared, 'héllo.bin'), 'utf8')).toBe('xyz');
    expect(readFileSync(path.join(shared, 'héllo-1.bin'), 'utf8')).toBe('abc');
  });

  it('retries a nested imported root collision using the physical target, leaving one current receipt', async () => {
    const f = coordinatedIntake(); const shared = f.imported('a', 'shared'); f.imported('b', 'shared/sub');
    let interrupt = true;
    const a = service(f, { beforePublish: async () => { if (interrupt) { interrupt = false; throw new Error('copy interrupted'); } } });
    const b = service(f);
    const aInput = intakeManifest({ kind: 'project', projectId: 'a', dir: 'sub' });
    const bInput = intakeManifest({ kind: 'project', projectId: 'b' });
    await a.create(aInput, null); await b.create(bInput, null);
    const aId = aInput.files[0]!.clientFileId;
    expect((await a.put(aInput.intakeBatchId, aId, Readable.from(['abc']))).file.hasSuccessfulAttachment).toBe(false);
    expect(receipts(f, aInput.intakeBatchId, aId)).toEqual([{ projectId: 'a', relPath: 'sub/héllo.bin', complete: false }]);
    expect((await b.put(bInput.intakeBatchId, bInput.files[0]!.clientFileId, Readable.from(['xyz']))).file.hasSuccessfulAttachment).toBe(true);
    expect(readFileSync(path.join(shared, 'sub', 'héllo.bin'), 'utf8')).toBe('xyz');
    const result = await a.retryProjectPlacement(aInput.intakeBatchId, aId);
    expect(result.file.stored?.projectFile).toEqual({ projectId: 'a', relPath: 'sub/héllo-1.bin' });
    expect(receipts(f, aInput.intakeBatchId, aId)).toEqual([{ projectId: 'a', relPath: 'sub/héllo-1.bin', complete: true }]);
    expect(readFileSync(path.join(shared, 'sub', 'héllo.bin'), 'utf8')).toBe('xyz');
    expect(readFileSync(path.join(shared, 'sub', 'héllo-1.bin'), 'utf8')).toBe('abc');
  });

  it('recovers a pending attachment after a nested imported root takes its incomplete target', async () => {
    const f = coordinatedIntake(); const shared = f.imported('a', 'shared'); f.imported('b', 'shared/sub');
    let interrupt = true;
    const a = service(f, { beforePublish: async () => { if (interrupt) { interrupt = false; throw new Error('copy interrupted'); } } });
    const b = service(f);
    const pending = intakeManifest();
    const aInput = { ...pending, files: [{ ...pending.files[0]!, relativePath: 'sub/héllo.bin' }] };
    const bInput = intakeManifest({ kind: 'project', projectId: 'b' });
    const aId = aInput.files[0]!.clientFileId;
    await a.create(aInput, null); await b.create(bInput, null);
    expect((await a.put(aInput.intakeBatchId, aId, Readable.from(['abc']))).file.hasSuccessfulAttachment).toBe(false);
    const request = { projectId: 'a', conversationId: 'c' };
    const interrupted = await a.attach(aInput.intakeBatchId, request);
    expect(interrupted.attachments).toEqual([]);
    expect(interrupted.files[0]).toMatchObject({ error: { code: 'intake-copy-failed', retryable: true } });
    expect(receipts(f, aInput.intakeBatchId, aId)).toEqual([{ projectId: 'a', conversationId: 'c', relPath: 'sub/héllo.bin', complete: false }]);
    expect(await a.retryProjectPlacement(aInput.intakeBatchId, aId).then(() => null, error => error)).toMatchObject({ code: 'intake-conflict' });
    expect((await b.put(bInput.intakeBatchId, bInput.files[0]!.clientFileId, Readable.from(['xyz']))).file.hasSuccessfulAttachment).toBe(true);
    expect(readFileSync(path.join(shared, 'sub', 'héllo.bin'), 'utf8')).toBe('xyz');
    const retried = await a.attach(aInput.intakeBatchId, request);
    expect(retried.attachments).toMatchObject([{ projectId: 'a', conversationId: 'c', relPath: 'sub/héllo-1.bin' }]);
    expect(receipts(f, aInput.intakeBatchId, aId)).toEqual([{ projectId: 'a', conversationId: 'c', relPath: 'sub/héllo-1.bin', complete: true }]);
    expect(readFileSync(path.join(shared, 'sub', 'héllo.bin'), 'utf8')).toBe('xyz');
    expect(readFileSync(path.join(shared, 'sub', 'héllo-1.bin'), 'utf8')).toBe('abc');
  });

  it('recovers an incomplete pending receipt after authorization returns and a nested alias takes its target', async () => {
    const f = coordinatedIntake(); const shared = f.imported('a', 'shared'); f.imported('b', 'shared/sub');
    let allowed = true, revokeOnce = true;
    const a = service(f, { beforePublish: async () => { if (revokeOnce) { revokeOnce = false; allowed = false; } } });
    const b = service(f);
    const pending = intakeManifest();
    const aInput = { ...pending, files: [{ ...pending.files[0]!, relativePath: 'sub/héllo.bin' }] };
    const bInput = intakeManifest({ kind: 'project', projectId: 'b' });
    const aId = aInput.files[0]!.clientFileId;
    await a.create(aInput, null); await b.create(bInput, null);
    await a.put(aInput.intakeBatchId, aId, Readable.from(['abc']));
    const request = { projectId: 'a', conversationId: 'c' };
    const verifyWrite = async () => allowed;
    await expect(a.attach(aInput.intakeBatchId, request, verifyWrite)).rejects.toMatchObject({ code: 'project-forbidden', status: 403 });
    expect(receipts(f, aInput.intakeBatchId, aId)).toEqual([{ projectId: 'a', conversationId: 'c', relPath: 'sub/héllo.bin', complete: false }]);
    expect(f.row(aInput.intakeBatchId, aId).error_json).toContain('project-forbidden');
    allowed = true;
    expect((await b.put(bInput.intakeBatchId, bInput.files[0]!.clientFileId, Readable.from(['xyz']))).file.hasSuccessfulAttachment).toBe(true);
    expect(readFileSync(path.join(shared, 'sub', 'héllo.bin'), 'utf8')).toBe('xyz');
    const retried = await a.attach(aInput.intakeBatchId, request, verifyWrite);
    expect(retried.attachments).toMatchObject([{ projectId: 'a', conversationId: 'c', relPath: 'sub/héllo-1.bin' }]);
    expect(receipts(f, aInput.intakeBatchId, aId)).toEqual([{ projectId: 'a', conversationId: 'c', relPath: 'sub/héllo-1.bin', complete: true }]);
    expect(readFileSync(path.join(shared, 'sub', 'héllo.bin'), 'utf8')).toBe('xyz');
    expect(readFileSync(path.join(shared, 'sub', 'héllo-1.bin'), 'utf8')).toBe('abc');
  });

  it.each(['managed', 'imported'] as const)('%s: root bytes and receipt may settle, but no project directory, reservation, temp or final appears before the gate releases', async kind => {
    const f = coordinatedIntake(); const dest = kind === 'managed' ? f.managed('dest') : f.imported('dest');
    const lease = await f.projectWrites.admit('dest');
    const input = intakeManifest({ kind: 'project', projectId: 'dest', dir: 'incoming' }); const id = input.files[0]!.clientFileId;
    const svc = service(f); await settle(() => svc.create(input, null));
    const putting = svc.put(input.intakeBatchId, id, Readable.from(['abc']));
    await waitFor(() => f.row(input.intakeBatchId, id).state === 'stored', 'root receipt');
    await ticks();
    expect(receipts(f, input.intakeBatchId, id)).toEqual([]);
    expect(existsSync(path.join(dest, 'incoming'))).toBe(false); expect(filesUnder(dest)).toEqual([]);
    expect(await outcome(putting)).toBe('pending');
    await lease.settle();
    const stored = await putting;
    expect(stored.file.stored?.projectFile).toEqual({ projectId: 'dest', relPath: 'incoming/héllo.bin' });
    expect(readFileSync(path.join(dest, 'incoming', 'héllo.bin'), 'utf8')).toBe('abc');
    expect(f.coordinator.snapshot().registrations).toBe(0);
  });

  it.each([
    { kind: 'imported', drift: (f: Fixture) => { f.imported('dest', 'rebound'); } },
    { kind: 'managed', drift: (f: Fixture) => { renameSync(path.join(f.projects, 'dest'), path.join(f.projects, 'dest-moved')); mkdirSync(path.join(f.projects, 'dest')); } },
  ])('$kind root rebound or replaced while queued refuses 409 with no file or complete receipt at either root', async ({ kind, drift }) => {
    const f = coordinatedIntake(); if (kind === 'managed') f.managed('dest', true); else f.imported('dest');
    const lease = await f.projectWrites.admit('dest');
    const input = intakeManifest({ kind: 'project', projectId: 'dest' }); const id = input.files[0]!.clientFileId;
    const svc = service(f); await settle(() => svc.create(input, null));
    const putting = svc.put(input.intakeBatchId, id, Readable.from(['abc'])).then(() => null, error => error);
    await waitFor(() => f.row(input.intakeBatchId, id).state === 'stored', 'root receipt');
    await waitFor(() => f.coordinator.snapshot().acquiring === 1, 'queued project admission');
    drift(f); await lease.settle();
    const refusal = await putting;
    expect(refusal).toMatchObject({ code: 'RUN_SCOPE_CHANGED' }); expect(mapPlacementFailure(refusal)).toMatchObject({ status: 409 });
    expect(filesUnder(f.external)).toEqual([]); expect(filesUnder(f.projects)).toEqual([]);
    expect(receipts(f, input.intakeBatchId, id).some(item => item.complete)).toBe(false);
    expect(svc.snapshot(input.intakeBatchId).files[0]).toMatchObject({ state: 'stored', hasSuccessfulAttachment: false });
  });

  it('drift after the temporary copy and before link retains the uncertain temp and publishes no final (409)', async () => {
    const f = coordinatedIntake(); const dest = f.imported('dest');
    const svc = service(f, { beforePublish: async () => { f.imported('dest', 'elsewhere'); } });
    const input = intakeManifest(); const id = input.files[0]!.clientFileId;
    await settle(() => svc.create(input, null)); await svc.put(input.intakeBatchId, id, Readable.from(['abc']));
    const refusal = await svc.attach(input.intakeBatchId, { projectId: 'dest', conversationId: 'c' }).then(() => null, error => error);
    expect(refusal).toMatchObject({ code: 'RUN_SCOPE_CHANGED' }); expect(mapPlacementFailure(refusal)).toMatchObject({ status: 409 });
    expect(existsSync(path.join(dest, 'héllo.bin'))).toBe(false);
    expect(readdirSync(dest).filter(name => name.startsWith('.intake-'))).toHaveLength(1);
    expect(receipts(f, input.intakeBatchId, id).map(item => item.complete)).toEqual([false]);
    expect(svc.snapshot(input.intakeBatchId).files[0]).toMatchObject({ state: 'stored', hasSuccessfulAttachment: false });
  });

  it('drift after link and before the receipt keeps the published bytes and reports no complete attachment (409)', async () => {
    const f = coordinatedIntake(); const dest = f.imported('dest');
    const svc = service(f, { afterCopy: async () => { f.imported('dest', 'elsewhere'); } });
    const input = intakeManifest({ kind: 'project', projectId: 'dest' }); const id = input.files[0]!.clientFileId;
    await settle(() => svc.create(input, null));
    const refusal = await svc.put(input.intakeBatchId, id, Readable.from(['abc'])).then(() => null, error => error);
    expect(refusal).toMatchObject({ code: 'RUN_SCOPE_CHANGED' });
    expect(readFileSync(path.join(dest, 'héllo.bin'), 'utf8')).toBe('abc');
    expect(receipts(f, input.intakeBatchId, id).map(item => item.complete)).toEqual([false]);
    expect(svc.snapshot(input.intakeBatchId).files[0]).toMatchObject({ state: 'stored', hasSuccessfulAttachment: false });
  });
});

describe('owner/recovery refusal at each root and project stage', () => {
  it.each(['temp', 'object', 'receipt'] as const)('root %s stage: typed 503, no Library row, truthful queued state, retry after recovery', async stage => {
    const f = coordinatedIntake(); const input = intakeManifest(); const id = input.files[0]!.clientFileId;
    const svc = service(f); await settle(() => svc.create(input, null));
    let checks = 0; const verifyWrite = async () => { checks++; if ((stage === 'object' && checks === 1) || (stage === 'receipt' && checks === 2)) f.loseRecovery(); return true; };
    let putting: Promise<unknown>;
    if (stage === 'temp') {
      const stream = new PassThrough(); putting = svc.put(input.intakeBatchId, id, stream).then(() => null, error => error);
      stream.write('a'); await waitFor(() => temps(f).length === 1, 'temp file'); f.loseRecovery(); stream.end('bc');
    } else putting = svc.put(input.intakeBatchId, id, Readable.from(['abc']), undefined, verifyWrite).then(() => null, error => error);
    const refusal = await putting;
    expect(refusal).toMatchObject({ code: 'OWNER_RECOVERING' }); expect(mapPlacementFailure(refusal)).toMatchObject({ status: 503 });
    expect(f.count('library_assets')).toBe(0); expect(f.row(input.intakeBatchId, id)).toMatchObject({ state: 'queued', error_json: null });
    const object = libraryObjectPath(f.libraryDir, sha('abc'), '.bin');
    expect(existsSync(object)).toBe(stage === 'receipt');
    // Uncertain owned temp bytes stay for recovery instead of an unguarded delete.
    expect(temps(f)).toHaveLength(stage === 'receipt' ? 0 : 1);
    f.recover();
    const retried = await svc.put(input.intakeBatchId, id, Readable.from(['abc']));
    expect(retried.file).toMatchObject({ state: 'stored', stored: { contentHash: sha('abc') } }); expect(readFileSync(object, 'utf8')).toBe('abc');
  });

  it.each(['mkdir', 'reservation', 'link', 'receipt'] as const)('project %s stage: typed 503, no success-shaped attachment, retry after recovery', async stage => {
    const f = coordinatedIntake(); const dest = f.managed('dest');
    let flipped = false;
    const svc = service(f, { projectDirectory: async (id, dir) => { const created = await f.projectDirectory(id, dir); if (stage === 'reservation' && !flipped) { flipped = true; f.loseRecovery(); } return created; } });
    const input = intakeManifest(); const id = input.files[0]!.clientFileId;
    await settle(() => svc.create(input, null)); await svc.put(input.intakeBatchId, id, Readable.from(['abc']));
    let checks = 0; const verifyWrite = async () => { checks++; if ((stage === 'mkdir' && checks === 1) || (stage === 'link' && checks === 2) || (stage === 'receipt' && checks === 3)) f.loseRecovery(); return true; };
    const refusal = await svc.attach(input.intakeBatchId, { projectId: 'dest', conversationId: 'c' }, verifyWrite).then(() => null, error => error);
    expect(refusal).toMatchObject({ code: 'OWNER_RECOVERING' }); expect(mapPlacementFailure(refusal)).toMatchObject({ status: 503 });
    expect(existsSync(dest)).toBe(stage !== 'mkdir');
    expect(receipts(f, input.intakeBatchId, id).map(item => item.complete)).toEqual(stage === 'mkdir' || stage === 'reservation' ? [] : [false]);
    expect(existsSync(path.join(dest, 'héllo.bin'))).toBe(stage === 'receipt');
    expect(f.row(input.intakeBatchId, id)).toMatchObject({ state: 'stored', error_json: null });
    f.recover();
    const attached = await svc.attach(input.intakeBatchId, { projectId: 'dest', conversationId: 'c' });
    expect(attached.attachments).toHaveLength(1); expect(readFileSync(path.join(dest, 'héllo.bin'), 'utf8')).toBe('abc');
  });
});

describe('stream, Clear and admission-close settlement', () => {
  it('closing admission waits for the accepted raw stream, which still completes; new admission refuses', async () => {
    const f = coordinatedIntake(); const input = intakeManifest(); const id = input.files[0]!.clientFileId;
    const svc = service(f); await settle(() => svc.create(input, null));
    const stream = new PassThrough(); const putting = svc.put(input.intakeBatchId, id, stream);
    stream.write('a'); await waitFor(() => temps(f).length === 1, 'temp file');
    let closed = false; const closing = f.coordinator.closeAdmission().then(() => { closed = true; });
    await ticks(); expect(closed).toBe(false);
    expect(await settle(() => svc.create(intakeManifest(), null)).then(() => null, error => error)).toMatchObject({ code: 'ADMISSION_CLOSED' });
    stream.end('bc'); expect((await putting).file.state).toBe('stored');
    await closing; expect(closed).toBe(true); expect(temps(f)).toEqual([]);
    f.recover(); expect((await settle(() => svc.create(intakeManifest(), null)))).toBeTruthy();
  });

  it('Clear of a held stream settles the transfer, removes only its owned temp and keeps a stored sibling', async () => {
    const f = coordinatedIntake(); const input = intakeManifest({ kind: 'pending' }, [3, 3]);
    const [first, second] = input.files.map(file => file.clientFileId) as [string, string];
    const svc = service(f); await settle(() => svc.create(input, null));
    await svc.put(input.intakeBatchId, first, Readable.from(['abc']));
    const stream = new PassThrough(); const putting = svc.put(input.intakeBatchId, second, stream).then(() => null, error => error);
    stream.write('d'); await waitFor(() => temps(f).length === 1, 'temp file');
    const cleared = await svc.clear(input.intakeBatchId, { clientFileIds: [second] });
    expect(cleared.files.map(file => file.state)).toEqual(['stored', 'cleared']);
    expect(await putting).toMatchObject({ code: 'intake-cleared' });
    expect(temps(f)).toEqual([]); expect(f.count('library_assets')).toBe(1);
    expect(readFileSync(svc.download(input.intakeBatchId, first).path, 'utf8')).toBe('abc');
    expect(f.coordinator.snapshot().registrations).toBe(0);
  });

  it('a root CAS collision keeps the existing different inode and bytes and returns conflict', async () => {
    const f = coordinatedIntake(); const input = intakeManifest(); const id = input.files[0]!.clientFileId;
    const object = libraryObjectPath(f.libraryDir, sha('abc'), '.bin'); mkdirSync(path.dirname(object), { recursive: true }); writeFileSync(object, 'xyz');
    const before = lstatSync(object);
    const svc = service(f); await settle(() => svc.create(input, null));
    expect(await svc.put(input.intakeBatchId, id, Readable.from(['abc'])).then(() => null, error => error)).toMatchObject({ code: 'intake-conflict', status: 409 });
    const after = lstatSync(object); expect({ dev: after.dev, ino: after.ino }).toEqual({ dev: before.dev, ino: before.ino });
    expect(readFileSync(object, 'utf8')).toBe('xyz'); expect(f.count('library_assets')).toBe(0); expect(temps(f)).toEqual([]);
  });
});

describe('production authority factory and admission boundaries', () => {
  it('refuses placement retry before Library bytes exist without claiming bytes were removed', async () => {
    const f = coordinatedIntake(); f.imported('dest'); const svc = service(f);
    const input = intakeManifest({ kind: 'project', projectId: 'dest' });
    await svc.create(input, null);
    const id = input.files[0]!.clientFileId;
    const stream = new PassThrough();
    const putting = svc.put(input.intakeBatchId, id, stream);
    await expect(svc.retryProjectPlacement(input.intakeBatchId, id)).rejects.toMatchObject({ status: 409, code: 'intake-conflict', retryable: false });
    expect(f.row(input.intakeBatchId, id)).toMatchObject({ state: 'queued', error_json: null });
    stream.end('abc'); expect((await putting).file.hasSuccessfulAttachment).toBe(true);
    const oversized = intakeManifest({ kind: 'project', projectId: 'dest' }, [209715201]);
    await svc.create(oversized, null);
    await expect(svc.retryProjectPlacement(oversized.intakeBatchId, oversized.files[0]!.clientFileId)).rejects.toMatchObject({ status: 409, code: 'intake-conflict', retryable: false });
    expect(f.row(oversized.intakeBatchId, oversized.files[0]!.clientFileId).state).toBe('failed');
  });
  it('coordinated factory holds a root-only permit through the accepted stream and gates project effects', async () => {
    const f = coordinatedIntake(); const dest = f.imported('dest');
    const authority = createIntakeWriteAuthority({ mode: 'coordinated-open', coordinator: f.coordinator, projectWrites: f.projectWrites, assertMutationAdmissible: () => undefined });
    const svc = new IntakeService({ db: f.db, libraryDir: f.libraryDir, projectsDir: f.projects, projectDirectory: f.projectDirectory, authority });
    const input = intakeManifest({ kind: 'project', projectId: 'dest' }); const id = input.files[0]!.clientFileId;
    expect(await svc.recoverInterrupted()).toBe('recovered'); await svc.create(input, null);
    const lease = await f.projectWrites.admit('dest');
    const stream = new PassThrough(); const putting = svc.put(input.intakeBatchId, id, stream);
    stream.write('a'); await waitFor(() => temps(f).length === 1, 'temp file');
    expect(f.coordinator.snapshot().registrations).toBe(2); // the held project lease and the root-only stream permit
    stream.end('bc'); await waitFor(() => f.row(input.intakeBatchId, id).state === 'stored', 'root receipt');
    await ticks(); expect(filesUnder(dest)).toEqual([]);
    await lease.settle(); expect((await putting).file.stored?.projectFile?.relPath).toBe('héllo.bin');
    expect(readFileSync(path.join(dest, 'héllo.bin'), 'utf8')).toBe('abc'); expect(f.coordinator.snapshot().registrations).toBe(0);
  });

  it('fails closed without the owned coordinator, with the runtime refusal, before any effect', async () => {
    const f = coordinatedIntake();
    const refusal = new PlacementCoordinationError('OWNER_RECOVERING', 'Coordinated mutations are closed: owned-database-unqualified');
    const closed = createIntakeWriteAuthority({ mode: 'coordinated-closed', coordinator: null, projectWrites: createFenceOnlyProjectWrites({ assertMutationAdmissible: () => { throw refusal; } }), assertMutationAdmissible: () => { throw refusal; } });
    const svc = new IntakeService({ db: f.db, libraryDir: f.libraryDir, projectsDir: f.projects, projectDirectory: f.projectDirectory, authority: closed });
    expect(await svc.recoverInterrupted()).toBe('deferred');
    await expect(svc.create(intakeManifest(), null)).rejects.toBe(refusal);
    const inconsistent = createIntakeWriteAuthority({ mode: 'coordinated-open', coordinator: null, projectWrites: f.projectWrites, assertMutationAdmissible: () => undefined });
    await expect(inconsistent.rootWrite(async () => 'written')).rejects.toMatchObject({ code: 'ADMISSION_CLOSED' });
    expect(f.count('workbench_intake_batches')).toBe(0); expect(existsSync(f.libraryDir)).toBe(false);
  });

  it('ordinary factory keeps not-activated behavior and refuses a globally fenced root write before its first effect', async () => {
    const f = coordinatedIntake(); let fence: string | null = null;
    const assertMutationAdmissible = () => { if (fence) throw new PlacementCoordinationError('ADMISSION_CLOSED', fence); };
    const authority = createIntakeWriteAuthority({ mode: 'ordinary-uncoordinated', coordinator: null, projectWrites: createFenceOnlyProjectWrites({ assertMutationAdmissible }), assertMutationAdmissible });
    const svc = new IntakeService({ db: f.db, libraryDir: f.libraryDir, projectsDir: f.projects, projectDirectory: f.projectDirectory, authority });
    const dest = f.managed('dest'); const input = intakeManifest({ kind: 'project', projectId: 'dest' });
    await svc.create(input, null);
    expect((await svc.put(input.intakeBatchId, input.files[0]!.clientFileId, Readable.from(['abc']))).file.stored?.projectFile?.relPath).toBe('héllo.bin');
    expect(readFileSync(path.join(dest, 'héllo.bin'), 'utf8')).toBe('abc');
    fence = 'transition fenced';
    await expect(svc.create(intakeManifest(), null)).rejects.toMatchObject({ code: 'ADMISSION_CLOSED' });
    expect(f.count('workbench_intake_batches')).toBe(1);
  });

  it('a caller cancellation while queued on the project gate cancels only that admission; root custody stays stored', async () => {
    const f = coordinatedIntake(); const dest = f.imported('dest');
    const lease = await f.projectWrites.admit('dest');
    const input = intakeManifest({ kind: 'project', projectId: 'dest' }); const id = input.files[0]!.clientFileId;
    const svc = service(f); await svc.create(input, null);
    const caller = new AbortController();
    const putting = svc.put(input.intakeBatchId, id, Readable.from(['abc']), undefined, undefined, { signal: caller.signal }).then(() => null, error => error);
    await waitFor(() => f.coordinator.snapshot().acquiring === 1, 'queued project admission');
    caller.abort();
    const refusal = await putting;
    expect(refusal).toMatchObject({ code: 'ADMISSION_CANCELLED' });
    expect(f.row(input.intakeBatchId, id)).toMatchObject({ state: 'stored', materializations_json: '[]' });
    expect(svc.snapshot(input.intakeBatchId).files[0]).toMatchObject({
      state: 'stored', stored: { contentHash: sha('abc') }, hasSuccessfulAttachment: false,
      retryable: true, error: { code: 'intake-copy-failed', retryable: true },
    });
    await lease.settle(); expect(filesUnder(dest)).toEqual([]); expect(f.coordinator.snapshot().registrations).toBe(0);
    const attached = await svc.attach(input.intakeBatchId, { projectId: 'dest', conversationId: 'c' });
    expect(attached.attachments).toHaveLength(1); expect(readFileSync(path.join(dest, 'héllo.bin'), 'utf8')).toBe('abc');
  });

  it('Clear from inside an accepted project callback refuses (no nested admission) and the attachment still settles', async () => {
    const f = coordinatedIntake(); const dest = f.imported('dest'); let nested: unknown;
    const input = intakeManifest(); const id = input.files[0]!.clientFileId;
    const svc: IntakeService = service(f, { beforePublish: async () => { nested = await svc.clear(input.intakeBatchId, {}).then(() => null, error => error); } });
    await svc.create(input, null); await svc.put(input.intakeBatchId, id, Readable.from(['abc']));
    const attached = await svc.attach(input.intakeBatchId, { projectId: 'dest', conversationId: 'c' });
    expect(nested).toMatchObject({ code: 'COORDINATOR_BUSY' }); expect(mapPlacementFailure(nested)).toMatchObject({ status: 409 });
    expect(attached.attachments).toHaveLength(1); expect(readFileSync(path.join(dest, 'héllo.bin'), 'utf8')).toBe('abc');
    expect((await svc.clear(input.intakeBatchId, {})).files[0]).toMatchObject({ state: 'cleared', hasSuccessfulAttachment: true });
  });
});
