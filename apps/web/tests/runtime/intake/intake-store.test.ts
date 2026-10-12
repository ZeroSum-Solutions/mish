import { describe, expect, it, vi } from 'vitest';
import { IntakeStore } from '../../../src/runtime/intake/intake-store';
import type { AttachIntakeResponse, IntakeBatchSnapshot } from '@mish/contracts';
import { advanceWorkspaceAccountGeneration, resetWorkspaceAccountGeneration } from '../../../src/collab/workspace-identity';

const batchId = '00000000-0000-4000-8000-000000000001';
const fileId = '00000000-0000-4000-8000-000000000002';
const descriptor = { clientFileId: fileId, order: 0, filename: 'a.zip', size: 1 };
const receipt = (state: 'queued' | 'stored' | 'cleared' | 'failed' | 'needs-reselection' = 'queued'): IntakeBatchSnapshot => ({ intakeBatchId: batchId, revision: state === 'queued' ? 1 : 2, destination: { kind: 'pending' }, createdAt: 1, updatedAt: 1, files: [{ clientFileId: fileId, order: 0, descriptor, state, hasSuccessfulAttachment: false, retryable: state !== 'cleared', ...(state === 'stored' ? { stored: { assetId: 'asset', contentHash: 'a'.repeat(64), size: 1, filename: 'a.zip', detectedMime: 'application/zip', kind: 'file', downloadUrl: '/download' } } : {}) }] });
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
function fixture() {
 const api = { create: vi.fn(async (_request: import('@mish/contracts').CreateIntakeBatchRequest, _context?: import('@mish/contracts').WorkspaceCollabContext | null) => receipt()), list: vi.fn(async () => ({ batches: [receipt('stored')] })), get: vi.fn(async () => receipt('stored')), put: vi.fn(async (_batchId: string, _fileId: string, _body: Blob) => ({ intakeBatchId: batchId, revision: 2, file: receipt('stored').files[0]! })), clear: vi.fn(async () => receipt('cleared')), attach: vi.fn(async (): Promise<AttachIntakeResponse> => ({ intakeBatchId: batchId, revision: 3, attachments: [], files: receipt('stored').files })) };
 const ids = [batchId, fileId]; const store = new IntakeStore(api, () => ids.shift() ?? crypto.randomUUID()); return { api, store };
}
describe('durable intake projection', () => {
 it('acknowledges immediately and freezes destination before async create/upload', async () => {
  const { api, store } = fixture(); const gate = deferred<IntakeBatchSnapshot>(); api.create.mockImplementation(() => gate.promise);
  const file = new File(['a'], 'a.zip'); const destination = { kind: 'project' as const, projectId: 'first', dir: 'folder' };
  const batch = store.accept([file], { destination, context: null }); destination.projectId = 'second'; destination.dir = 'other';
  expect(store.getSnapshot()[0]?.descriptors[0]?.filename).toBe('a.zip'); expect(api.put).not.toHaveBeenCalled();
  gate.resolve({ ...receipt(), destination: { kind: 'project', projectId: 'first', dir: 'folder' } }); await batch.settled;
  expect(api.create.mock.calls[0]?.[0]?.destination).toEqual({ kind: 'project', projectId: 'first', dir: 'folder' }); expect(api.put.mock.calls[0]?.[2]).toBe(file);
 });
 it('recovers a committed lost response before retry and never resends stored bytes', async () => {
  const { api, store } = fixture(); api.put.mockRejectedValueOnce(new Error('lost response'));
  await store.accept([new File(['a'], 'a.zip')], { destination: { kind: 'pending' }, context: null }).settled;
  expect(store.getSnapshot()[0]?.receipt?.files[0]?.state).toBe('stored');
  await store.retry(batchId, fileId); expect(api.put).toHaveBeenCalledTimes(1); expect(api.get).toHaveBeenCalled();
 });
 it('holds cleared tombstones against late successful PUT responses', async () => {
  const { api, store } = fixture(); const gate = deferred<Awaited<ReturnType<typeof api.put>>>(); api.put.mockImplementation(() => gate.promise);
  const batch = store.accept([new File(['a'], 'a.zip')], { destination: { kind: 'pending' }, context: null }); await vi.waitFor(() => expect(api.put).toHaveBeenCalled());
  await store.clear(batchId, fileId); gate.resolve({ intakeBatchId: batchId, revision: 5, file: receipt('stored').files[0]! }); await batch.settled;
  expect(store.getSnapshot()[0]?.receipt?.files[0]?.state).toBe('cleared');
 });
 it('persists a clear made before the POST manifest finishes', async () => {
  const { api, store } = fixture(); const gate = deferred<IntakeBatchSnapshot>(); api.create.mockImplementation(() => gate.promise);
  const batch = store.accept([new File(['a'], 'a.zip')], { destination: { kind: 'pending' }, context: null });
  const clearing = store.clear(batchId, fileId); expect(api.clear).not.toHaveBeenCalled();
  gate.resolve(receipt()); await clearing; await batch.settled;
  expect(api.clear).toHaveBeenCalled(); expect(api.put).not.toHaveBeenCalled(); expect(store.getSnapshot()[0]?.receipt?.files[0]?.state).toBe('cleared');
 });
 it('keeps both per-file successes when completion responses arrive out of revision order', async () => {
  const { api, store } = fixture(); const secondId = '00000000-0000-4000-8000-000000000003';
  const first = deferred<Awaited<ReturnType<typeof api.put>>>();
  api.create.mockImplementation(async () => ({ ...receipt(), files: [...receipt().files, { clientFileId: secondId, order: 1, descriptor: { ...descriptor, clientFileId: secondId, order: 1, filename: 'b.zip' }, state: 'queued', retryable: true, hasSuccessfulAttachment: false }] }));
  api.put.mockImplementation(async (_batch, id) => id === fileId ? first.promise : { intakeBatchId: batchId, revision: 3, file: { ...receipt('stored').files[0]!, clientFileId: secondId, order: 1, descriptor: { ...descriptor, clientFileId: secondId, order: 1, filename: 'b.zip' } } });
  const ids = [batchId, fileId, secondId]; const other = new IntakeStore(api, () => ids.shift()!);
  const batch = other.accept([new File(['a'], 'a.zip'), new File(['a'], 'b.zip')], { destination: { kind: 'pending' }, context: null });
  await vi.waitFor(() => expect(other.getSnapshot()[0]?.receipt?.revision).toBe(3));
  first.resolve({ intakeBatchId: batchId, revision: 2, file: receipt('stored').files[0]! }); await batch.settled;
  expect(other.getSnapshot()[0]?.receipt?.files.map(file => file.state)).toEqual(['stored', 'stored']);
 });
 it('rehydrates receipts and attaches refs without retaining or fetching File bytes', async () => {
  const { api, store } = fixture(); await store.hydrate(null); await store.attach(batchId, { projectId: 'new-project', conversationId: 'conversation' });
  expect(api.put).not.toHaveBeenCalled(); expect(api.attach).toHaveBeenCalledWith(batchId, { projectId: 'new-project', conversationId: 'conversation' }, null);
  expect(store.getSnapshot()[0]?.receipt?.files[0]?.stored?.filename).toBe('a.zip');
 });
 it.each(['stored', 'failed', 'cleared'] as const)('keeps a previously attached %s receipt saved without offering it to another Home project after reload', async state => {
  const { api, store } = fixture();
  const used = { ...receipt(state), files: receipt(state).files.map(file => ({ ...file, hasSuccessfulAttachment: true })) };
  api.list.mockResolvedValue({ batches: [used] }); api.get.mockResolvedValue(used);
  await store.hydrate(null);
  expect(store.getSnapshot()[0]?.receipt).toEqual(used);
  expect(store.pendingIds(null)).toEqual([]);
  await store.attachPending(batchId, { projectId: 'different-project', conversationId: 'different-conversation' });
  expect(api.attach).not.toHaveBeenCalled(); expect(api.put).not.toHaveBeenCalled();
 });
 it('refreshes a stale pending projection before Home attachment and skips a completion committed elsewhere', async () => {
  const { api, store } = fixture(); await store.hydrate(null);
  expect(store.pendingIds(null)).toEqual([batchId]);
  api.get.mockResolvedValue({ ...receipt('stored'), revision: 3, files: receipt('stored').files.map(file => ({ ...file, hasSuccessfulAttachment: true })) });
  expect(await store.attachPending(batchId, { projectId: 'another-project', conversationId: 'another-conversation' })).toBeUndefined();
  expect(api.get).toHaveBeenCalledWith(batchId, null); expect(store.pendingIds(null)).toEqual([]);
  expect(api.attach).not.toHaveBeenCalled(); expect(api.put).not.toHaveBeenCalled();
 });
 it('excludes completed files from mixed Home handoffs after reload, preserves failed siblings, and permits explicit reuse', async () => {
  const { api, store } = fixture();
  const secondId = '00000000-0000-4000-8000-000000000003'; const failedId = '00000000-0000-4000-8000-000000000004';
  const stored = receipt('stored').files[0]!;
  const unused = { ...stored, clientFileId: secondId, order: 1, descriptor: { ...descriptor, clientFileId: secondId, order: 1, filename: 'unused.zip' }, hasSuccessfulAttachment: false };
  const failed = { ...receipt('failed').files[0]!, clientFileId: failedId, order: 2, descriptor: { ...descriptor, clientFileId: failedId, order: 2, filename: 'failed.zip' }, hasSuccessfulAttachment: false };
  const mixed: IntakeBatchSnapshot = { ...receipt('stored'), files: [{ ...stored, hasSuccessfulAttachment: true }, unused, failed] };
  api.list.mockResolvedValue({ batches: [mixed] }); api.get.mockResolvedValue(mixed);
  const completed = { ...mixed, revision: 3, files: mixed.files.map(file => file.clientFileId === secondId ? { ...file, hasSuccessfulAttachment: true } : file) };
  api.attach.mockResolvedValue({ intakeBatchId: batchId, revision: 3, files: completed.files, attachments: [{ clientFileId: secondId, assetId: 'asset', contentHash: 'a'.repeat(64), projectId: 'second-project', conversationId: 'second-conversation', relPath: 'unused.zip', filename: 'unused.zip', size: 1 }] });
  await store.hydrate(null); expect(store.pendingIds(null)).toEqual([batchId]);
  await store.attachPending(batchId, { projectId: 'second-project', conversationId: 'second-conversation' });
  expect(api.attach).toHaveBeenLastCalledWith(batchId, { projectId: 'second-project', conversationId: 'second-conversation', clientFileIds: [secondId, failedId] }, null);
  expect(store.pendingIds(null)).toEqual([batchId]);
  api.list.mockResolvedValue({ batches: [completed] }); api.get.mockResolvedValue(completed);
  const reloaded = new IntakeStore(api); await reloaded.hydrate(null);
  api.attach.mockResolvedValue({ intakeBatchId: batchId, revision: 4, attachments: [], files: completed.files });
  await reloaded.attachPending(batchId, { projectId: 'third-project', conversationId: 'third-conversation' });
  expect(api.attach).toHaveBeenLastCalledWith(batchId, { projectId: 'third-project', conversationId: 'third-conversation', clientFileIds: [failedId] }, null);
  await reloaded.attach(batchId, { projectId: 'third-project', conversationId: 'third-conversation', clientFileIds: [fileId] });
  expect(api.attach).toHaveBeenLastCalledWith(batchId, { projectId: 'third-project', conversationId: 'third-conversation', clientFileIds: [fileId] }, null);
  expect(api.put).not.toHaveBeenCalled();
 });
 it.each(['failed', 'needs-reselection'] as const)('restores %s metadata and rejects wrong reselection before any raw PUT', async state => {
  const { api, store } = fixture();
  const original = { ...descriptor, filename: 'original.zip', size: 3, declaredMime: 'application/zip', relativePath: 'selected/original.zip' };
  const recovered: IntakeBatchSnapshot = { ...receipt(state), destination: { kind: 'project', projectId: 'original-project', dir: 'original-folder' }, files: [{ ...receipt(state).files[0]!, descriptor: original }] };
  api.list.mockResolvedValue({ batches: [recovered] }); api.get.mockResolvedValue(recovered);
  await store.hydrate(null);
  expect(store.getSnapshot()[0]?.descriptors).toEqual([original]);
  expect(store.getSnapshot()[0]?.target.destination).toEqual(recovered.destination);
  await expect(store.retry(batchId, fileId)).rejects.toThrow('Choose the original file again');
  const wrongPath = new File(['abc'], original.filename, { type: original.declaredMime });
  Object.defineProperty(wrongPath, 'webkitRelativePath', { value: 'other/original.zip' });
  for (const wrong of [new File(['abc'], 'wrong.zip', { type: original.declaredMime }), new File(['abcd'], original.filename, { type: original.declaredMime }), new File(['abc'], original.filename, { type: 'text/plain' }), wrongPath]) {
   await expect(store.retry(batchId, fileId, wrong)).rejects.toThrow('Choose the original file');
  }
  expect(api.put).not.toHaveBeenCalled(); expect(api.create).not.toHaveBeenCalled();
  const correct = new File(['abc'], original.filename, { type: original.declaredMime });
  Object.defineProperty(correct, 'webkitRelativePath', { value: original.relativePath });
  await store.retry(batchId, fileId, correct);
  expect(api.put).toHaveBeenCalledExactlyOnceWith(batchId, fileId, correct, null, expect.objectContaining({ signal: expect.any(AbortSignal) }));
 });
 it('does not replace a fresh account receipt with a delayed pre-sign-in list response', async () => {
  resetWorkspaceAccountGeneration();
  try {
   const { api, store } = fixture(); const oldResponse = deferred<{ batches: IntakeBatchSnapshot[] }>();
   api.list.mockImplementationOnce(() => oldResponse.promise);
   const staleRead = store.hydrate(null);
   advanceWorkspaceAccountGeneration('signed-in');
   await store.hydrate(null);
   expect(store.getSnapshot()[0]?.receipt?.files[0]?.state).toBe('stored');
   oldResponse.resolve({ batches: [receipt('failed')] }); await staleRead;
   expect(store.getSnapshot()[0]?.receipt?.files[0]?.state).toBe('stored'); expect(api.put).not.toHaveBeenCalled();
  } finally { resetWorkspaceAccountGeneration(); }
 });
 it('makes a21st file explicit remaining intake, without silently dropping it', () => {
  const { store } = fixture(); const accepted = store.accept(Array.from({ length: 21 }, (_, i) => new File(['a'], `${i}.zip`)), { destination: { kind: 'pending' }, context: null });
  expect(accepted.remaining).toHaveLength(1); expect(store.getSnapshot()[0]?.descriptors).toHaveLength(20);
 });
});
