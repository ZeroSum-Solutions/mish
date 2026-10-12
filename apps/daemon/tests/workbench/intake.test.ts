import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, symlink, writeFile, rm, lstat, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { migrateLibrary, deleteLibraryAsset } from '../../src/library-store.js';
import { parseAttachIntakeResponse } from '@mish/contracts';
import { IntakeService } from '../../src/workbench/intake.js';
import { ordinaryIntakeAuthority } from './intake-placement-fixture.js';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(afterCopy?: () => Promise<void>, beforePublish?: (temporaryPath: string) => Promise<void>, linkProjectCopy?: (temporaryPath: string, target: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), 'intake-')); roots.push(root);
  const db = new Database(':memory:'); db.pragma('foreign_keys = ON'); migrateLibrary(db);
  const project = path.join(root, 'project'); await mkdir(project);
  const authority = ordinaryIntakeAuthority();
  const service = new IntakeService({ db, libraryDir: path.join(root, 'library'), projectsDir: root, authority, projectDirectory: async (_id, dir) => { const p = path.join(project, dir); await mkdir(p, { recursive: true }); return p; }, ...(afterCopy ? { afterCopy } : {}), ...(beforePublish ? { beforePublish } : {}), ...(linkProjectCopy ? { linkProjectCopy } : {}) } as ConstructorParameters<typeof IntakeService>[0]);
  return { db, service, project, deps: { db, libraryDir: path.join(root, 'library'), projectsDir: root, authority, projectDirectory: async (_id: string, dir: string) => { const p = path.join(project, dir); await mkdir(p, { recursive: true }); return p; } } as ConstructorParameters<typeof IntakeService>[0] };
}
function manifest(size = 3, filename = 'héllo.bin') { return { intakeBatchId: randomUUID(), destination: { kind: 'pending' as const }, files: [{ clientFileId: randomUUID(), order: 0, filename, size }] }; }
describe('streamed intake receipts', () => {
  it('converges concurrent same bytes and rejects new bytes under the same identity', async () => {
    const { service, db } = await fixture(); const input = manifest(); await service.create(input, null);
    const id = input.files[0]!.clientFileId;
    const [a, b] = await Promise.all([service.put(input.intakeBatchId, id, Readable.from([Buffer.from('abc')])), service.put(input.intakeBatchId, id, Readable.from([Buffer.from('abc')]))]);
    expect(a.file.stored?.assetId).toBe(b.file.stored?.assetId);
    expect(db.prepare('SELECT count(*) AS n FROM library_assets').get()).toEqual({ n: 1 });
    await expect(service.put(input.intakeBatchId, id, Readable.from([Buffer.from('def')]))).rejects.toMatchObject({ code: 'intake-conflict' });
    expect(service.snapshot(input.intakeBatchId).files[0]!.stored?.contentHash).toBe(createHash('sha256').update('abc').digest('hex'));
  });
  it('keeps descriptor provenance independent of global dedup and preserves receipt after legacy deletion', async () => {
    const { service, db } = await fixture(); const a = manifest(3, 'first.bin'), b = manifest(3, 'second.txt');
    await service.create(a, null); await service.create(b, null);
    const stored = await service.put(a.intakeBatchId, a.files[0]!.clientFileId, Readable.from(['abc']));
    await service.put(b.intakeBatchId, b.files[0]!.clientFileId, Readable.from(['abc']));
    expect(service.snapshot(b.intakeBatchId).files[0]!.stored?.filename).toBe('second.txt');
    expect(service.snapshot(b.intakeBatchId).files[0]!.stored?.kind).toBe('text');
    const object = service.download(a.intakeBatchId, a.files[0]!.clientFileId).path;
    expect(await readdir(path.dirname(object))).toHaveLength(1);
    deleteLibraryAsset(db, stored.file.stored!.assetId);
    expect(service.snapshot(a.intakeBatchId).files[0]).toMatchObject({ state: 'needs-reselection', error: { code: 'bytes-removed' } });
  });
  it('clears tray references without deleting bytes and requires re-selection after restart', async () => {
    const { service, db } = await fixture(); const input = manifest(); await service.create(input, null);
    const stored = await service.put(input.intakeBatchId, input.files[0]!.clientFileId, Readable.from(['abc']));
    await service.clear(input.intakeBatchId, {});
    expect(service.snapshot(input.intakeBatchId).files[0]!.state).toBe('cleared');
    expect(db.prepare('SELECT id FROM library_assets').get()).toEqual({ id: stored.file.stored!.assetId });
    await expect(service.put(input.intakeBatchId, input.files[0]!.clientFileId, Readable.from(['abc']))).rejects.toMatchObject({ code: 'intake-cleared' });
  });
  it('recovers the exact reserved project copy after a crash gap and preserves an external edit', async () => {
    let crash = true;
    const { service, project, deps } = await fixture(async () => { if (crash) { crash = false; throw new Error('simulated process exit after copy'); } });
    const input = manifest(); await service.create(input, null); await service.put(input.intakeBatchId, input.files[0]!.clientFileId, Readable.from(['abc']));
    const request = { projectId: 'p', conversationId: 'c' };
    await service.attach(input.intakeBatchId, request);
    const before = await readdir(project); expect(before).toHaveLength(1);
    const restarted = new IntakeService(deps);
    const attached = await restarted.attach(input.intakeBatchId, request); expect(attached.attachments).toHaveLength(1);
    expect(await readdir(project)).toEqual(before); expect(await readFile(path.join(project, before[0]!), 'utf8')).toBe('abc');
    await writeFile(path.join(project, before[0]!), 'edited');
    const retry = await restarted.attach(input.intakeBatchId, request);
    expect(retry.files[0]!.error?.code).toBe('intake-conflict');
    expect(await readFile(path.join(project, before[0]!), 'utf8')).toBe('edited');
  });
});

it('retains oversized/short-file failures independently of valid siblings and projects an interrupted restart', async () => {
  const { service, deps } = await fixture();
  const input = manifest(); const extra = { clientFileId: randomUUID(), order: 1, filename: 'large.bin', size: 209715201 };
  await service.create({ ...input, files: [...input.files, extra] }, null);
  expect(service.snapshot(input.intakeBatchId).files[1]).toMatchObject({ state: 'failed', error: { code: 'intake-size-exceeded' }, retryable: false });
  await expect(service.put(input.intakeBatchId, input.files[0]!.clientFileId, Readable.from(['a']))).rejects.toMatchObject({ code: 'intake-size-mismatch' });
  await service.put(input.intakeBatchId, input.files[0]!.clientFileId, Readable.from(['abc']));
  expect(service.snapshot(input.intakeBatchId).files[0]!.state).toBe('stored');
  const queued = manifest(); await service.create(queued, null);
  const restarted = new IntakeService(deps); expect(await restarted.recoverInterrupted()).toBe('recovered');
  expect(restarted.snapshot(queued.intakeBatchId).files[0]).toMatchObject({ state: 'needs-reselection', error: { code: 'intake-interrupted' } });
});
it('reuses the project copy on attachment and returns its prior receipt after tray clear', async () => {
  const { service, project } = await fixture(); const input = manifest();
  await service.create({ ...input, destination: { kind: 'project', projectId: 'p' } }, null);
  await service.put(input.intakeBatchId, input.files[0]!.clientFileId, Readable.from(['abc']));
  const attached = await service.attach(input.intakeBatchId, { projectId: 'p', conversationId: 'c' }); expect(attached.attachments).toHaveLength(1);
  expect(await readdir(project)).toHaveLength(1); await service.clear(input.intakeBatchId, {});
  const retry = await service.attach(input.intakeBatchId, { projectId: 'p', conversationId: 'c' }); expect(retry.attachments).toEqual(attached.attachments); expect(await readdir(project)).toHaveLength(1);
});

it('cancels an active file without leaving a Library row or temp bytes', async () => {
  const { service, deps, db } = await fixture(); const input = manifest(); await service.create(input, null);
  const stream = new PassThrough(); const completed = service.put(input.intakeBatchId, input.files[0]!.clientFileId, stream).catch(error => error);
  stream.write('a');
  for (let attempt = 0; attempt < 50; attempt++) { if ((await readdir(path.join(deps.libraryDir, 'intake-temp')).catch(() => [])).length) break; await new Promise(resolve => setTimeout(resolve, 5)); }
  await service.clear(input.intakeBatchId, {}); expect(await completed).toMatchObject({ code: 'intake-cleared' });
  expect(service.snapshot(input.intakeBatchId).files[0]!.state).toBe('cleared');
  expect(db.prepare('SELECT count(*) AS n FROM library_assets').get()).toEqual({ n: 0 });
  expect(await readdir(path.join(deps.libraryDir, 'intake-temp'))).toEqual([]);
});
it('promotes a referenced asset to verified owned bytes without changing its source metadata', async () => {
  const { service, db, deps } = await fixture(); const referenced = path.join(deps.projectsDir, 'mutable.txt'); await writeFile(referenced, 'abc');
  const { registerLibraryAsset } = await import('../../src/library.js');
  const existing = await registerLibraryAsset({ db, libraryDir: deps.libraryDir, storage: 'referenced', source: { sourceKind: 'agent-task', projectId: 'p' }, absPath: referenced, sourceTitle: 'Original title' });
  await writeFile(referenced, 'changed'); const input = manifest(); await service.create(input, null);
  const stored = await service.put(input.intakeBatchId, input.files[0]!.clientFileId, Readable.from(['abc'])); expect(stored.file.stored?.assetId).toBe(existing.asset.id);
  const { getLibraryAsset } = await import('../../src/library-store.js'); const asset = getLibraryAsset(db, existing.asset.id)!;
  expect(asset.storage).toBe('owned'); expect(asset.sourceTitle).toBe('Original title'); expect(await readFile(service.download(input.intakeBatchId, input.files[0]!.clientFileId).path, 'utf8')).toBe('abc');
});

it('preserves imported-folder hidden-path and symlink boundaries while retaining spaces', async () => {
  const { project, deps } = await fixture(); const metadata = { baseDir: project };
  const { ensureValidatedProjectSubdir } = await import('../../src/projects.js');
  await expect(ensureValidatedProjectSubdir(deps.projectsDir, 'p', '.ssh/incoming', metadata)).rejects.toThrow('hidden path segments');
  expect(await readdir(project)).toEqual([]);
  const outside = path.join(deps.projectsDir, 'outside'); await mkdir(outside); await symlink(outside, path.join(project, 'escape'));
  await expect(ensureValidatedProjectSubdir(deps.projectsDir, 'p', 'escape/uploads', metadata)).rejects.toThrow('symlink'); expect(await readdir(outside)).toEqual([]);
  const accepted = await ensureValidatedProjectSubdir(deps.projectsDir, 'p', 'Photo References', metadata); expect(accepted.relDir).toBe('Photo References');
});

it('does not commit an attachment receipt if write authority changes after copy', async () => {
  let allowed = true; const { service, db } = await fixture(async () => { allowed = false; }); const input = manifest();
  await service.create(input, null); await service.put(input.intakeBatchId, input.files[0]!.clientFileId, Readable.from(['abc']));
  await expect(service.attach(input.intakeBatchId, { projectId: 'p', conversationId: 'c' }, async () => allowed)).rejects.toMatchObject({ code: 'project-forbidden' });
  const row = db.prepare('SELECT materializations_json FROM workbench_intake_items').get() as { materializations_json: string };
  expect(JSON.parse(row.materializations_json)[0].complete).toBe(false); expect(service.snapshot(input.intakeBatchId).files[0]!.error?.code).toBe('project-forbidden');
});

it('recovers every frozen descriptor after queue, failure, restart, byte removal and tray clear', async () => {
  const { service, deps, db } = await fixture(); const input = manifest();
  const descriptor = { ...input.files[0]!, declaredMime: 'application/octet-stream', relativePath: 'references/héllo.bin' };
  const oversized = { ...descriptor, clientFileId: randomUUID(), order: 1, filename: 'large.bin', relativePath: 'references/large.bin', size: 209715201 };
  await service.create({ ...input, files: [descriptor, oversized] }, null);
  let snapshot = service.snapshot(input.intakeBatchId); expect(snapshot.files[0]!.state).toBe('queued'); expect(snapshot.files.map(file => file.descriptor)).toEqual([descriptor, oversized]); expect(snapshot.files[1]!.state).toBe('failed');
  const restarted = new IntakeService(deps); expect(await restarted.recoverInterrupted()).toBe('recovered'); expect(restarted.snapshot(input.intakeBatchId).files[0]!.descriptor).toEqual(descriptor);
  const stored = await restarted.put(input.intakeBatchId, descriptor.clientFileId, Readable.from(['abc'])); expect(stored.file.descriptor).toEqual(descriptor);
  deleteLibraryAsset(db, stored.file.stored!.assetId); snapshot = restarted.snapshot(input.intakeBatchId); expect(snapshot.files[0]!.state).toBe('needs-reselection'); expect(snapshot.files[0]!.error?.code).toBe('bytes-removed'); expect(snapshot.files[0]!.descriptor).toEqual(descriptor);
  await restarted.clear(input.intakeBatchId, {}); snapshot = restarted.snapshot(input.intakeBatchId); expect(snapshot.files.map(file => file.state)).toEqual(['cleared','cleared']); expect(snapshot.files.map(file => file.descriptor)).toEqual([descriptor, oversized]);
});


it('persists per-file attachment completion across copy failure, restart, byte removal and clear', async () => {
  let crash = true;
  const { service, deps, db } = await fixture(async () => { if (crash) { crash = false; throw new Error('simulated copy/receipt gap'); } });
  const input = manifest(); const firstId = input.files[0]!.clientFileId;
  const second = { clientFileId: randomUUID(), order: 1, filename: 'second.bin', size: 3 };
  const oversized = { clientFileId: randomUUID(), order: 2, filename: 'large.bin', size: 209715201 };
  const flags = (owner: IntakeService) => owner.snapshot(input.intakeBatchId).files.map(file => file.hasSuccessfulAttachment);
  await service.create({ ...input, files: [...input.files, second, oversized] }, null);
  expect(flags(service)).toEqual([false, false, false]);
  const first = await service.put(input.intakeBatchId, firstId, Readable.from(['abc']));
  await service.put(input.intakeBatchId, second.clientFileId, Readable.from(['def']));
  expect(flags(service)).toEqual([false, false, false]);
  const request = { projectId: 'p', conversationId: 'c' };
  const failed = await service.attach(input.intakeBatchId, { ...request, clientFileIds: [firstId] });
  expect(failed.attachments).toEqual([]); expect(failed.files[0]!.error?.code).toBe('intake-copy-failed');
  const reserved = db.prepare('SELECT materializations_json FROM workbench_intake_items WHERE client_file_id = ?').get(firstId) as { materializations_json: string };
  expect(JSON.parse(reserved.materializations_json)[0].complete).toBe(false);
  expect(flags(service)).toEqual([false, false, false]);
  const attached = await service.attach(input.intakeBatchId, { ...request, clientFileIds: [second.clientFileId] });
  expect(attached.attachments).toHaveLength(1); expect(flags(service)).toEqual([false, true, false]);
  const restarted = new IntakeService(deps);
  expect(flags(restarted)).toEqual([false, true, false]);
  expect((await restarted.attach(input.intakeBatchId, { ...request, clientFileIds: [firstId] })).attachments).toHaveLength(1);
  expect(flags(restarted)).toEqual([true, true, false]);
  deleteLibraryAsset(db, first.file.stored!.assetId);
  expect(restarted.snapshot(input.intakeBatchId).files[0]).toMatchObject({ state: 'needs-reselection', error: { code: 'bytes-removed' }, hasSuccessfulAttachment: true });
  await restarted.clear(input.intakeBatchId, { clientFileIds: [second.clientFileId, oversized.clientFileId] });
  expect(restarted.snapshot(input.intakeBatchId).files.slice(1).map(file => ({ state: file.state, hasSuccessfulAttachment: file.hasSuccessfulAttachment }))).toEqual([{ state: 'cleared', hasSuccessfulAttachment: true }, { state: 'cleared', hasSuccessfulAttachment: false }]);
  expect(flags(new IntakeService(deps))).toEqual([true, true, false]);
});


it('grounds streamed intake MIME in content instead of filename or declared MIME', async () => {
  const { service } = await fixture();
  const opaque = Buffer.from([255, 0, 31, 17]);
  for (const filename of ['opaque.png', 'opaque.html', 'opaque.txt', 'opaque.mp4', 'opaque.woff2']) {
    const input = manifest(opaque.length, filename); const descriptor = { ...input.files[0]!, declaredMime: 'image/png' };
    await service.create({ ...input, files: [descriptor] }, null);
    const result = await service.put(input.intakeBatchId, descriptor.clientFileId, Readable.from([opaque]));
    expect(result.file.stored).toMatchObject({ detectedMime: 'application/octet-stream', kind: 'file', filename, declaredMime: 'image/png' });
  }
  for (const bytes of [Buffer.from([0xc3, 0x28]), Buffer.from('hello\0world'), Buffer.concat([Buffer.alloc(65536, 0x61), Buffer.from([0xff])])]) {
    const input = manifest(bytes.length, 'invalid.txt'); await service.create(input, null);
    const result = await service.put(input.intakeBatchId, input.files[0]!.clientFileId, Readable.from([bytes.subarray(0, 65536), bytes.subarray(65536)]));
    expect(result.file.stored).toMatchObject({ detectedMime: 'application/octet-stream', kind: 'file' });
  }
});

it('recognizes bounded image, markup, text, font and video content evidence without extensions', async () => {
  const { service } = await fixture();
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7l8AAAAASUVORK5CYII=', 'base64');
  const woff = Buffer.alloc(68); woff.write('wOFF'); woff.writeUInt32BE(0x00010000, 4); woff.writeUInt32BE(woff.length, 8); woff.writeUInt16BE(1, 12); woff.writeUInt32BE(32, 16);
  const woff2 = Buffer.alloc(52); woff2.write('wOF2'); woff2.writeUInt32BE(0x00010000, 4); woff2.writeUInt32BE(woff2.length, 8); woff2.writeUInt16BE(1, 12); woff2.writeUInt32BE(32, 16);
  const mp4 = Buffer.from('00000018667479706d7034320000000069736f6d6d703432', 'hex');
  const webm = Buffer.from('1a45dfa3874282847765626d', 'hex');
  const cases: [Buffer, string, string][] = [[png, 'image/png', 'image'], [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), 'image/svg+xml', 'image'], [Buffer.from('<?xml version="1.0"?><svg></svg>'), 'image/svg+xml', 'image'], [Buffer.from('<?xml version="1.0"?><document/>'), 'text/plain', 'text'], [Buffer.from('<html><body>hello</body></html>'), 'text/html', 'html'], [Buffer.from('你好 résumé\n'), 'text/plain', 'text'], [woff, 'font/woff', 'font'], [woff2, 'font/woff2', 'font'], [mp4, 'video/mp4', 'video'], [webm, 'video/webm', 'video']];
  for (const [bytes, detectedMime, kind] of cases) {
    const input = manifest(bytes.length, 'content.bin'); await service.create(input, null);
    const result = await service.put(input.intakeBatchId, input.files[0]!.clientFileId, Readable.from([bytes.subarray(0, 1), bytes.subarray(1)]));
    expect(result.file.stored).toMatchObject({ detectedMime, kind });
  }
});


it('keeps a partial temporary copy out of the reserved final and retries without touching stale temps', async () => {
  let fault = true;
  const { service, project, deps } = await fixture(undefined, async temporaryPath => {
    if (fault) {
      fault = false; await writeFile(temporaryPath, 'a');
      expect(await readFile(temporaryPath, 'utf8')).toBe('a');
      expect(await readdir(project)).not.toContain('héllo.bin');
      throw new Error('simulated interrupted partial copy before publication');
    }
  });
  const stale = path.join(project, '.intake-unknown-stale.tmp'); await writeFile(stale, 'old partial');
  const input = manifest(); await service.create(input, null); await service.put(input.intakeBatchId, input.files[0]!.clientFileId, Readable.from(['abc']));
  const request = { projectId: 'p', conversationId: 'c' };
  const failed = await service.attach(input.intakeBatchId, request);
  expect(failed.attachments).toEqual([]); expect(failed.files[0]).toMatchObject({ error: { code: 'intake-copy-failed' }, hasSuccessfulAttachment: false });
  expect(await readdir(project)).toEqual(['.intake-unknown-stale.tmp']);
  const restarted = new IntakeService(deps); const attached = await restarted.attach(input.intakeBatchId, request);
  expect(attached.attachments).toHaveLength(1); expect(attached.attachments[0]!.relPath).toBe('héllo.bin');
  const final = path.join(project, attached.attachments[0]!.relPath);
  expect(await readFile(final, 'utf8')).toBe('abc'); expect(await readFile(stale, 'utf8')).toBe('old partial');
  const sourceInfo = await lstat(restarted.download(input.intakeBatchId, input.files[0]!.clientFileId).path), finalInfo = await lstat(final);
  expect({ dev: finalInfo.dev, ino: finalInfo.ino }).not.toEqual({ dev: sourceInfo.dev, ino: sourceInfo.ino }); expect(finalInfo.nlink).toBe(1);
  expect((await readdir(project)).sort()).toEqual(['.intake-unknown-stale.tmp', 'héllo.bin']);
});

it('preserves an external final that appears before temporary copy publication', async () => {
  const { service, project, deps } = await fixture(undefined, async () => { await writeFile(path.join(project, 'héllo.bin'), 'external edit', { flag: 'wx' }); });
  const input = manifest(); await service.create(input, null); await service.put(input.intakeBatchId, input.files[0]!.clientFileId, Readable.from(['abc']));
  const request = { projectId: 'p', conversationId: 'c' };
  const first = await service.attach(input.intakeBatchId, request);
  expect(first.attachments).toEqual([]); expect(first.files[0]).toMatchObject({ error: { code: 'intake-conflict' }, hasSuccessfulAttachment: false });
  const restarted = new IntakeService(deps); expect((await restarted.attach(input.intakeBatchId, request)).attachments).toEqual([]);
  expect(await readFile(path.join(project, 'héllo.bin'), 'utf8')).toBe('external edit'); expect(await readdir(project)).toEqual(['héllo.bin']);
});

it('rechecks write authority before publishing a verified temporary project copy', async () => {
  let allowed = true;
  const { service, project } = await fixture(undefined, async () => { allowed = false; });
  const input = manifest(); await service.create(input, null); await service.put(input.intakeBatchId, input.files[0]!.clientFileId, Readable.from(['abc']));
  await expect(service.attach(input.intakeBatchId, { projectId: 'p', conversationId: 'c' }, async () => allowed)).rejects.toMatchObject({ code: 'project-forbidden' });
  expect(await readdir(project)).toEqual([]); expect(service.snapshot(input.intakeBatchId).files[0]!.hasSuccessfulAttachment).toBe(false);
});


it('keeps a tray clear before publication from exposing a new final project file', async () => {
  const input = manifest();
  const { service, project } = await fixture(undefined, async () => { await service.clear(input.intakeBatchId, {}); });
  await service.create(input, null); await service.put(input.intakeBatchId, input.files[0]!.clientFileId, Readable.from(['abc']));
  expect((await service.attach(input.intakeBatchId, { projectId: 'p', conversationId: 'c' })).attachments).toEqual([]);
  expect(service.snapshot(input.intakeBatchId).files[0]).toMatchObject({ state: 'cleared', hasSuccessfulAttachment: false }); expect(await readdir(project)).toEqual([]);
});

it('waits for final publication and its receipt before acknowledging Clear', async () => {
  const input = manifest();
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let proceed!: () => void;
  const release = new Promise<void>(resolve => { proceed = resolve; });
  const { service, project } = await fixture(undefined, undefined, async (temporaryPath, target) => {
    entered(); await release; await link(temporaryPath, target);
  });
  await service.create(input, null);
  await service.put(input.intakeBatchId, input.files[0]!.clientFileId, Readable.from(['abc']));
  const source = service.download(input.intakeBatchId, input.files[0]!.clientFileId).path;
  const request = { projectId: 'p', conversationId: 'c' };
  const attaching = service.attach(input.intakeBatchId, request);
  await started;
  let acknowledged = false;
  const clearing = service.clear(input.intakeBatchId, {}).then(result => { acknowledged = true; return result; });
  await new Promise(resolve => setImmediate(resolve));
  expect(acknowledged).toBe(false);
  expect(service.snapshot(input.intakeBatchId).files[0]!.state).toBe('stored');
  proceed();
  expect((await attaching).attachments).toHaveLength(1);
  expect((await clearing).files[0]).toMatchObject({ state: 'cleared', hasSuccessfulAttachment: true });
  expect((await service.attach(input.intakeBatchId, request)).attachments).toHaveLength(1);
  expect(await readdir(project)).toEqual(['héllo.bin']);
  expect(await readFile(path.join(project, 'héllo.bin'), 'utf8')).toBe('abc');
  expect(await readFile(source, 'utf8')).toBe('abc');
});

it('holds Clear through the published copy and receipt gap', async () => {
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let proceed!: () => void;
  const release = new Promise<void>(resolve => { proceed = resolve; });
  const { service, project, deps } = await fixture(async () => { entered(); await release; });
  const input = manifest(); await service.create(input, null);
  await service.put(input.intakeBatchId, input.files[0]!.clientFileId, Readable.from(['abc']));
  const attaching = service.attach(input.intakeBatchId, { projectId: 'p', conversationId: 'c' });
  await started;
  expect(await readFile(path.join(project, 'héllo.bin'), 'utf8')).toBe('abc');
  let acknowledged = false;
  const clearing = service.clear(input.intakeBatchId, {}).then(result => { acknowledged = true; return result; });
  await new Promise(resolve => setImmediate(resolve)); expect(acknowledged).toBe(false);
  proceed(); await attaching;
  expect((await clearing).files[0]).toMatchObject({ state: 'cleared', hasSuccessfulAttachment: true });
  expect(new IntakeService(deps).snapshot(input.intakeBatchId).files[0]!.hasSuccessfulAttachment).toBe(true);
  expect(await readdir(project)).toEqual(['héllo.bin']);
});

it('preserves other completed project/conversation copies and external edits during Clear', async () => {
  const { deps } = await fixture();
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let proceed!: () => void;
  const release = new Promise<void>(resolve => { proceed = resolve; });
  const service = new IntakeService({ ...deps,
    projectDirectory: async (projectId, dir) => {
      const directory = path.join(deps.projectsDir, projectId, dir); await mkdir(directory, { recursive: true }); return directory;
    },
    linkProjectCopy: async (temporaryPath, target) => {
      if (target.includes(`${path.sep}second${path.sep}`)) { entered(); await release; }
      await link(temporaryPath, target);
    },
  });
  const input = manifest(); await service.create(input, null);
  await service.put(input.intakeBatchId, input.files[0]!.clientFileId, Readable.from(['abc']));
  const source = service.download(input.intakeBatchId, input.files[0]!.clientFileId).path;
  for (const conversationId of ['c1', 'c2']) expect((await service.attach(input.intakeBatchId, { projectId: 'first', conversationId })).attachments).toHaveLength(1);
  const first = path.join(deps.projectsDir, 'first', 'héllo.bin'); await writeFile(first, 'external edit');
  const attaching = service.attach(input.intakeBatchId, { projectId: 'second', conversationId: 'c3' }); await started;
  const clearing = service.clear(input.intakeBatchId, {});
  const second = path.join(deps.projectsDir, 'second', 'héllo.bin'); await writeFile(second, 'external replacement', { flag: 'wx' });
  proceed(); expect((await attaching).attachments).toEqual([]);
  expect((await clearing).files[0]).toMatchObject({ state: 'cleared', hasSuccessfulAttachment: true });
  expect(await readFile(first, 'utf8')).toBe('external edit'); expect(await readFile(second, 'utf8')).toBe('external replacement');
  expect(await readFile(source, 'utf8')).toBe('abc');
  const row = deps.db.prepare('SELECT materializations_json FROM workbench_intake_items').get() as { materializations_json: string };
  expect(JSON.parse(row.materializations_json).map((receipt: { complete: boolean }) => receipt.complete)).toEqual([true, true, false]);
  expect(await readdir(path.dirname(second))).toEqual(['héllo.bin']);
});

it('refuses a reentrant Clear from the receipt hook without deadlock or early acknowledgement', async () => {
  const input = manifest();
  const { service, project } = await fixture(async () => {
    await expect(service.clear(input.intakeBatchId, {})).rejects.toMatchObject({ code: 'intake-conflict', retryable: true });
  });
  await service.create(input, null); await service.put(input.intakeBatchId, input.files[0]!.clientFileId, Readable.from(['abc']));
  expect((await service.attach(input.intakeBatchId, { projectId: 'p', conversationId: 'c' })).attachments).toHaveLength(1);
  expect((await service.clear(input.intakeBatchId, {})).files[0]).toMatchObject({ state: 'cleared', hasSuccessfulAttachment: true });
  expect(await readdir(project)).toEqual(['héllo.bin']);
});


it('refuses unsupported atomic project publication without retry or a partial final', async () => {
  for (const code of ['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EPERM', 'EACCES']) {
    const { service, project } = await fixture(undefined, undefined, async temporaryPath => {
      expect(await readFile(temporaryPath, 'utf8')).toBe('abc');
      throw Object.assign(new Error('injected link failure'), { code });
    });
    const input = manifest(); await service.create(input, null); await service.put(input.intakeBatchId, input.files[0]!.clientFileId, Readable.from(['abc']));
    const refused = parseAttachIntakeResponse(await service.attach(input.intakeBatchId, { projectId: 'p', conversationId: 'c' }));
    expect(refused.attachments).toEqual([]);
    const unsupported = code !== 'EACCES';
    expect(refused.files[0]).toMatchObject({ state: 'stored', hasSuccessfulAttachment: false, retryable: !unsupported, error: { code: unsupported ? 'intake-destination-unsupported' : 'intake-copy-failed', retryable: !unsupported } });
    if (unsupported) expect(refused.files[0]!.error!.message).toBe('This destination filesystem cannot publish the attachment atomically. Select a supported project destination.');
    expect(await readdir(project)).toEqual([]); expect(await readFile(service.download(input.intakeBatchId, input.files[0]!.clientFileId).path, 'utf8')).toBe('abc');
  }
});
