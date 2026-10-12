import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseReviewRun, parseStartReviewRunRequest, type ReviewRun } from '@mish/contracts';
import { createReviewRunStore } from '../../src/workbench/review/run-store.js';
import { createReviewRunService } from '../../src/workbench/review/run-service.js';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, readFile: vi.fn(actual.readFile), rename: vi.fn(actual.rename), readdir: vi.fn(actual.readdir) };
});

function record(id = 'rr_test', createdAt = '2026-10-09T00:00:00.000Z'): ReviewRun {
  return parseReviewRun({
    schema: 'workbench-review-run/1', id, projectId: 'p',
    operation: { id: `op_${id}`, kind: 'collect-review', status: 'running', stage: 'mechanical', interruptReason: null, attempt: 1, idempotencyKey: id, inputDigest: 'a'.repeat(64), cancelRequested: false, error: null, createdAt, updatedAt: createdAt },
    frozen: { snapshot: { entry: 'index.html', versionId: null, contentDigest: null }, scope: { kind: 'all' }, rubricRevision: 0, contextRevision: 0, sourceHashes: [], plan: { mechanicalCheckIds: [], judgmentCheckIds: [], manualCheckIds: [], reviewers: [] }, reviewerModelIds: [] },
    bundleId: null, screenshotEvidenceIds: [], reviewers: [], findings: [], completedIndependentReviewers: 0, outcome: null, reasons: [], incompleteCheckIds: [], createdAt, endedAt: null,
  });
}

describe('review store robustness (D4–D6)', () => {
  let root: string;
  let dir: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(tmpdir(), 'wave-b-review-'));
    dir = path.join(root, 'workbench-review', 'runs', createHash('sha256').update('p').digest('hex').slice(0, 32));
  });
  afterEach(async () => {
    vi.restoreAllMocks(); vi.useRealTimers();
    const actual = await vi.importActual<typeof fs>('node:fs/promises');
    vi.mocked(fs.readFile).mockReset().mockImplementation(actual.readFile);
    vi.mocked(fs.rename).mockReset().mockImplementation(actual.rename);
    vi.mocked(fs.readdir).mockReset().mockImplementation(actual.readdir);
    await fs.rm(root, { recursive: true, force: true });
  });

  it.each(['{', '{}'])('D5 skips corrupt/invalid run JSON %s with a typed corrupt result and warning', async text => {
    const store = createReviewRunStore(root);
    await store.save(record());
    await fs.writeFile(path.join(dir, 'rr_test.json'), text);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(store.read('p', 'rr_test')).resolves.toBeNull();
    await expect(store.readResult('p', 'rr_test')).resolves.toEqual({ status: 'corrupt' });
    await expect(store.list('p')).resolves.toEqual([]);
    expect(warning).toHaveBeenCalled();
  });

  it.each(['{', '{}', '{"runId":"../escape"}', '{"runId":"rr_missing"}'])('D5 reports a bad key index %s without deleting or replacing it', async text => {
    const store = createReviewRunStore(root);
    await store.save(record()); await store.saveKey('p', 'retry', 'rr_test');
    const file = path.join(dir, 'keys', `${createHash('sha256').update('retry').digest('hex')}.json`);
    await fs.writeFile(file, text);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(store.findByKeyResult('p', 'retry')).resolves.toEqual({ status: 'corrupt' });
    await expect(store.findByKey('p', 'retry')).resolves.toBeNull();
    expect(await fs.readFile(file, 'utf8')).toBe(text);
    await expect(store.saveKey('p', 'retry', 'rr_test')).rejects.toMatchObject({ code: 'EEXIST' });
  });

  it.each(['key', 'run'])('preserves the idempotency link on a transient %s read failure', async target => {
    const store = createReviewRunStore(root);
    await store.save(record()); await store.saveKey('p', 'retry', 'rr_test');
    const key = path.join(dir, 'keys', `${createHash('sha256').update('retry').digest('hex')}.json`);
    const realRead = (await vi.importActual<typeof fs>('node:fs/promises')).readFile;
    const failingPath = target === 'key' ? key : path.join(dir, 'rr_test.json');
    const reader = vi.spyOn(fs, 'readFile').mockImplementation((...args: Parameters<typeof fs.readFile>) => {
      if (String(args[0]) === failingPath) return Promise.reject(Object.assign(new Error('temporary I/O failure'), { code: 'EIO' }));
      return realRead(...args);
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await store.findByKeyResult('p', 'retry')).toEqual({ status: 'unavailable' });
    expect((await fs.stat(key)).isFile()).toBe(true);
    reader.mockRestore();
    expect((await store.findByKey('p', 'retry'))?.id).toBe('rr_test');
  });

  it('D5 preserves a key whose run was truncated and recovers when the original run is repaired', async () => {
    const store = createReviewRunStore(root);
    await store.save(record()); await store.saveKey('p', 'broken', 'rr_test');
    await fs.writeFile(path.join(dir, 'rr_test.json'), '{');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await store.findByKeyResult('p', 'broken')).toEqual({ status: 'corrupt' });
    await expect(store.saveKey('p', 'broken', 'rr_replacement')).rejects.toMatchObject({ code: 'EEXIST' });
    await store.save(record());
    expect((await store.findByKey('p', 'broken'))?.id).toBe('rr_test');
    await expect(store.saveKey('p', 'broken', 'rr_test')).rejects.toMatchObject({ code: 'EEXIST' });
  });

  it('isolates an unavailable record, reconciles healthy runs, and permits another project to start', async () => {
    const store = createReviewRunStore(root);
    await store.save(record('rr_bad')); await store.save(record('rr_good'));
    const realRead = (await vi.importActual<typeof fs>('node:fs/promises')).readFile;
    const reader = vi.spyOn(fs, 'readFile').mockImplementation((...args: Parameters<typeof fs.readFile>) => {
      if (String(args[0]).endsWith('rr_bad.json')) return Promise.reject(Object.assign(new Error('temporary failure'), { code: 'EIO' }));
      return realRead(...args);
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect((await store.listAll()).map(run => run.id)).toEqual(['rr_good']);
    const service = createReviewRunService({ dataDir: root, projectInputs: () => ({ root, context: null, rubric: null }), mechanical: { read: async () => null, run: async () => { throw new Error('unused'); } }, entryVersion: async () => ({ versionId: null, contentDigest: 'a'.repeat(64), current: true }), reviewers: {} });
    await service.idle();
    expect(service.reconciliationStatus('p')).toEqual({ state: 'degraded', failedRunIds: ['rr_bad'] });
    expect(service.reconciliationStatus('other')).toEqual({ state: 'ready', failedRunIds: [] });
    expect((await store.read('p', 'rr_good'))?.operation.status).toBe('interrupted');
    let release!: () => void; let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const reading = new Promise<void>(resolve => { entered = resolve; });
    reader.mockImplementation((...args: Parameters<typeof fs.readFile>) => {
      if (String(args[0]).endsWith('rr_bad.json')) { entered(); return gate.then(() => Promise.reject(new Error('still unavailable'))); }
      return realRead(...args);
    });
    const retry = service.list('other');
    await reading;
    expect(service.reconciliationStatus('p')).toEqual({ state: 'degraded', failedRunIds: ['rr_bad'] });
    expect(service.reconciliationStatus('other')).toEqual({ state: 'ready', failedRunIds: [] });
    release(); await retry;
    await expect(service.start(parseStartReviewRunRequest({ projectId: 'p', snapshot: {}, rubricRevision: 0 }), 'blocked')).rejects.toMatchObject({ code: 'review-store-degraded' });
    // Repeated per-record failures must never enter the whole-store backoff.
    for (let i = 0; i < 6; i++) await service.list('p');
    expect((await service.start(parseStartReviewRunRequest({ projectId: 'other', snapshot: {}, rubricRevision: 0 }), 'fresh')).projectId).toBe('other');
    await service.idle();
    expect((await service.read('p', 'rr_good')).reconciliation).toEqual({ state: 'degraded', failedRunIds: ['rr_bad'] });
    reader.mockRestore();
    await service.list('p');
    expect(service.reconciliationStatus()).toEqual({ state: 'ready', failedRunIds: [] });
    expect((await store.read('p', 'rr_bad'))?.operation.status).toBe('interrupted');
  });

  it('refuses a corrupt idempotency link before creating any replacement run', async () => {
    const store = createReviewRunStore(root);
    await store.save(record()); await store.saveKey('p', 'broken', 'rr_test');
    const key = path.join(dir, 'keys', `${createHash('sha256').update('broken').digest('hex')}.json`);
    await fs.writeFile(key, '{');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const service = createReviewRunService({ dataDir: root, projectInputs: () => ({ root, context: null, rubric: null }), mechanical: { read: async () => null, run: async () => { throw new Error('unused'); } }, entryVersion: async () => null, reviewers: {} });
    await expect(service.start(parseStartReviewRunRequest({ projectId: 'p', snapshot: {}, rubricRevision: 0 }), 'broken')).rejects.toMatchObject({ code: 'review-store-unavailable' });
    expect(await fs.readFile(key, 'utf8')).toBe('{');
    expect((await store.listAll()).map(run => run.id)).toEqual(['rr_test']);
  });

  it('isolates an unreadable project directory and retries it without rescanning healthy projects', async () => {
    const store = createReviewRunStore(root);
    await store.save(record('rr_bad'));
    await store.save({ ...record('rr_good'), projectId: 'other' });
    const original = (await vi.importActual<typeof fs>('node:fs/promises')).readdir;
    const enumeration = vi.spyOn(fs, 'readdir').mockImplementation((...args: Parameters<typeof fs.readdir>) => {
      if (String(args[0]) === dir) return Promise.reject(Object.assign(new Error('directory unreadable'), { code: 'EACCES' }));
      return original(...args);
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const service = createReviewRunService({ dataDir: root, projectInputs: () => ({ root, context: null, rubric: null }), mechanical: { read: async () => null, run: async () => { throw new Error('unused'); } }, entryVersion: async () => ({ versionId: null, contentDigest: 'a'.repeat(64), current: true }), reviewers: {} });
    await service.idle();
    expect(service.reconciliationStatus('p')).toEqual({ state: 'degraded', failedRunIds: [] });
    expect(service.reconciliationStatus('other')).toEqual({ state: 'ready', failedRunIds: [] });
    expect((await store.read('other', 'rr_good'))?.operation.status).toBe('interrupted');
    await expect(service.start(parseStartReviewRunRequest({ projectId: 'p', snapshot: {}, rubricRevision: 0 }), 'blocked')).rejects.toMatchObject({ code: 'review-store-degraded' });
    expect((await service.start(parseStartReviewRunRequest({ projectId: 'other', snapshot: {}, rubricRevision: 0 }), 'fresh')).projectId).toBe('other');
    await service.idle();
    enumeration.mockImplementation(original); enumeration.mockClear();
    await service.list('p');
    expect(service.reconciliationStatus()).toEqual({ state: 'ready', failedRunIds: [] });
    expect((await store.read('p', 'rr_bad'))?.operation.status).toBe('interrupted');
    const otherDir = path.join(root, 'workbench-review', 'runs', createHash('sha256').update('other').digest('hex').slice(0, 32));
    expect(enumeration.mock.calls.some(call => String(call[0]) === otherDir)).toBe(false);
  });

  it('drops a corrupt-on-retry record from pending recovery and preserves its bytes', async () => {
    const store = createReviewRunStore(root);
    await store.save(record('rr_bad')); await store.save(record('rr_good'));
    const realRead = (await vi.importActual<typeof fs>('node:fs/promises')).readFile;
    const reader = vi.spyOn(fs, 'readFile').mockImplementation((...args: Parameters<typeof fs.readFile>) => {
      if (String(args[0]).endsWith('rr_bad.json')) return Promise.reject(new Error('temporary I/O error'));
      return realRead(...args);
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const service = createReviewRunService({ dataDir: root, projectInputs: () => ({ root, context: null, rubric: null }), mechanical: { read: async () => null, run: async () => { throw new Error('unused'); } }, entryVersion: async () => null, reviewers: {} });
    await service.idle();
    expect(service.reconciliationStatus('p').state).toBe('degraded');
    await fs.writeFile(path.join(dir, 'rr_bad.json'), '{'); reader.mockRestore();
    await service.list('p');
    expect(service.reconciliationStatus()).toEqual({ state: 'ready', failedRunIds: [] });
    expect(await fs.readFile(path.join(dir, 'rr_bad.json'), 'utf8')).toBe('{');
    expect((await store.listAll()).map(run => run.id)).toEqual(['rr_good']);
  });

  it('interrupts an abandoned run even when its evidence bundle cannot be read', async () => {
    const store = createReviewRunStore(root);
    await store.save({ ...record(), bundleId: 'rv_bad' });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const service = createReviewRunService({ dataDir: root, projectInputs: () => ({ root, context: null, rubric: null }), mechanical: { read: async () => { throw new Error('corrupt evidence'); }, run: async () => { throw new Error('unused'); } }, entryVersion: async () => null, reviewers: {} });
    await service.idle();
    expect(service.reconciliationStatus()).toEqual({ state: 'ready', failedRunIds: [] });
    expect((await store.read('p', 'rr_test'))?.operation).toMatchObject({ status: 'interrupted', interruptReason: 'daemon-restart' });
    expect(warning).toHaveBeenCalledWith('[review-runs] Could not read recovered evidence bundle', 'rr_test', expect.any(Error));
  });

  it('D4 catches whole-store startup failure immediately and retries once for concurrent callers', async () => {
    const original = (await vi.importActual<typeof fs>('node:fs/promises')).readdir;
    const enumeration = vi.spyOn(fs, 'readdir').mockRejectedValue(new Error('storage offline'));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const service = createReviewRunService({ dataDir: root, projectInputs: () => ({ root, context: null, rubric: null }), mechanical: { read: async () => null, run: async () => { throw new Error('unused'); } }, entryVersion: async () => null, reviewers: {} });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(service.reconciliationStatus().state).toBe('degraded');
    const scansBefore = enumeration.mock.calls.filter(call => call[0] === path.join(root, 'workbench-review', 'runs')).length;
    enumeration.mockImplementation(original);
    await Promise.all([service.list('p'), service.list('p')]);
    expect(service.reconciliationStatus()).toEqual({ state: 'ready', failedRunIds: [] });
    expect(enumeration.mock.calls.filter(call => call[0] === path.join(root, 'workbench-review', 'runs'))).toHaveLength(scansBefore + 1);
  });

  it('D4 backs off repeated whole-store failures after the immediate recovery attempt', async () => {
    vi.useFakeTimers();
    const enumeration = vi.spyOn(fs, 'readdir').mockRejectedValue(new Error('offline'));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const service = createReviewRunService({ dataDir: root, projectInputs: () => ({ root, context: null, rubric: null }), mechanical: { read: async () => null, run: async () => { throw new Error('unused'); } }, entryVersion: async () => null, reviewers: {} });
    await service.idle();
    await service.list('p');
    const scans = () => enumeration.mock.calls.filter(call => call[0] === path.join(root, 'workbench-review', 'runs')).length;
    expect(scans()).toBe(2);
    await service.list('p'); await service.list('p');
    expect(scans()).toBe(2);
    await vi.advanceTimersByTimeAsync(1000);
    await service.list('p');
    expect(scans()).toBe(3);
  });

  it('D4 ignores stray non-directory entries at the project-root layer', async () => {
    const store = createReviewRunStore(root);
    await store.save(record());
    await fs.writeFile(path.join(root, 'workbench-review', 'runs', 'f'.repeat(32)), 'stray file');
    expect((await store.listAll()).map(run => run.id)).toEqual(['rr_test']);
  });

  it('D6 indexes many runs once, keeps newest-200 ordering, and reparses only changed records', async () => {
    await fs.mkdir(dir, { recursive: true });
    const records = Array.from({ length: 450 }, (_, i) => record(`rr_${String(((449 - i) * 197) % 450).padStart(3, '0')}`, new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString()));
    await Promise.all(records.map(run => fs.writeFile(path.join(dir, `${run.id}.json`), JSON.stringify(run))));
    const store = createReviewRunStore(root);
    const reads = vi.spyOn(fs, 'readFile');
    expect((await store.list('p')).map(run => run.id)).toEqual(records.slice(-200).reverse().map(run => run.id));
    reads.mockClear();
    expect(await store.list('p')).toHaveLength(200);
    expect(reads.mock.calls.length).toBe(0);
    const updated = { ...records[0]!, createdAt: '2027-01-01T00:00:00.000Z' };
    await fs.writeFile(path.join(dir, `${updated.id}.json`), JSON.stringify(updated));
    reads.mockClear();
    const listed = await store.list('p');
    expect(listed[0]?.id).toBe(updated.id);
    expect(reads.mock.calls.length).toBeLessThanOrEqual(201);
    listed[0]!.operation.status = 'done';
    expect((await store.list('p'))[0]?.operation.status).toBe('running');
    await fs.rm(path.join(dir, `${updated.id}.json`));
    expect((await store.list('p'))[0]?.id).toBe(records.at(-1)?.id);
  });

  it('D4 logs reconcile failure, exposes degraded state, continues other runs, and retries next call', async () => {
    const store = createReviewRunStore(root);
    await store.save(record('rr_bad')); await store.save(record('rr_good'));
    const realRename = (await vi.importActual<typeof fs>('node:fs/promises')).rename;
    const rename = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(to).endsWith('rr_bad.json')) throw new Error('disk unavailable');
      return realRename(from, to);
    });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const service = createReviewRunService({ dataDir: root, projectInputs: () => ({ root, context: null, rubric: null }), mechanical: { read: async () => null, run: async () => { throw new Error('unused'); } }, entryVersion: async () => null, reviewers: {} });
    // Let startup fail before a public method awaits readiness; Vitest catches unhandled rejections.
    await new Promise(resolve => setTimeout(resolve, 10));
    await service.idle();
    expect(service.reconciliationStatus()).toMatchObject({ state: 'degraded', failedRunIds: ['rr_bad'] });
    expect((await store.read('p', 'rr_good'))?.operation.status).toBe('interrupted');
    expect(warning).toHaveBeenCalled();
    const reads = vi.mocked(fs.readFile); reads.mockClear();
    await expect(service.start(parseStartReviewRunRequest({ projectId: 'p', snapshot: { entry: 'index.html' }, rubricRevision: 0 }), 'fresh')).rejects.toMatchObject({ status: 409, code: 'review-store-degraded' });
    expect(reads.mock.calls.filter(call => String(call[0]).endsWith('rr_good.json'))).toHaveLength(0);
    rename.mockRestore();
    await service.list('p');
    expect(service.reconciliationStatus()).toEqual({ state: 'ready', failedRunIds: [] });
    expect((await store.read('p', 'rr_bad'))?.operation.status).toBe('interrupted');
  });
});
