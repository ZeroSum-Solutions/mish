import { describe, expect, it, vi } from 'vitest';
import type { AttachIntakeRequest, AttachIntakeResponse, IntakeBatchSnapshot } from '@open-design/contracts';
import { IntakeStore } from '../src/runtime/intake/intake-store';
import { materializeHomeModelHandoff, type HomeModelHandoff } from '../src/runtime/workbench/home-model-handoff';

describe('Home lost attachment acknowledgement recovery', () => {
  it.each(['full', 'partial'] as const)('recovers %s lost acknowledgement after reload with exact original receipts', async loss => {
    const files = ['predecessor', 'good', 'bad'].map((clientFileId, order) => ({ clientFileId, order, descriptor: { clientFileId, order, filename: `${clientFileId}.txt`, size: 1 }, state: 'stored' as const, retryable: false, hasSuccessfulAttachment: clientFileId === 'predecessor', stored: { assetId: clientFileId, contentHash: 'a'.repeat(64), filename: `${clientFileId}.txt`, size: 1, detectedMime: 'text/plain', kind: 'text' as const, downloadUrl: '/download' } }));
    let server: IntakeBatchSnapshot = { intakeBatchId: 'batch', revision: 1, destination: { kind: 'pending' }, createdAt: 1, updatedAt: 1, files };
    const target = { projectId: 'actual-project', conversationId: 'actual-seed' };
    const createdPaths = new Set<string>();
    const api = {
      create: vi.fn(async () => server), get: vi.fn(async () => server), list: vi.fn(async () => ({ batches: [server] })),
      put: vi.fn(async () => ({ intakeBatchId: 'batch', revision: server.revision, file: files[0]! })), clear: vi.fn(async () => server),
      attach: vi.fn(async (_batch: string, request: AttachIntakeRequest): Promise<AttachIntakeResponse> => {
        const selected = files.filter(file => request.clientFileIds?.includes(file.clientFileId));
        selected.forEach(file => createdPaths.add(`${request.projectId}:${request.conversationId}:${file.clientFileId}`));
        server = { ...server, revision: server.revision + 1, files: server.files.map(file => selected.some(s => s.clientFileId === file.clientFileId) ? { ...file, hasSuccessfulAttachment: true } : file) };
        const attachments = selected.map(file => ({ clientFileId: file.clientFileId, assetId: file.clientFileId, contentHash: 'a'.repeat(64), ...request, relPath: `references/${file.clientFileId}.txt`, filename: file.descriptor.filename, size: 1 }));
        if (api.attach.mock.calls.length === 1 && loss === 'full') throw new Error('lost response');
        return { intakeBatchId: 'batch', revision: server.revision, files: server.files, attachments: api.attach.mock.calls.length === 1 ? attachments.slice(0, 1) : attachments };
      }),
    };
    let store = new IntakeStore(api); await store.hydrate(null);
    let durable: HomeModelHandoff = { projectId: target.projectId, sessionId: target.conversationId, choice: { agentId: 'codex', modelId: 'default' }, modelRevision: 0, modelSaveFailed: false, prompt: 'original input', autoSend: true, workingDirReady: true, batchIds: ['batch'], completedBatchIds: [], attachments: [], ready: false };
    const materialize = () => materializeHomeModelHandoff(durable, {
      saveModel: async () => ({ projectId: target.projectId, sessionId: target.conversationId, choice: durable.choice, revision: 1, updatedAt: 1 }),
      pendingFileIds: batchId => store.pendingFileIds(batchId),
      attach: (batchId, clientFileIds) => clientFileIds ? store.attach(batchId, { ...target, clientFileIds }) : store.attachPending(batchId, target),
      persist: next => { durable = JSON.parse(JSON.stringify(next)); },
    });
    await expect(materialize()).rejects.toThrow(loss === 'full' ? 'lost response' : 'home-attachment-incomplete');
    expect(durable.ready).toBe(false);
    expect(durable.batchFileIds).toEqual({ batch: ['good', 'bad'] });
    store = new IntakeStore(api); await store.hydrate(null);
    const ready = await materialize();
    expect(ready.sessionId).toBe(target.conversationId);
    expect(ready.attachments.map(file => file.path)).toEqual(['references/good.txt', 'references/bad.txt']);
    expect(ready.ready).toBe(true);
    expect(api.attach).toHaveBeenLastCalledWith('batch', { ...target, clientFileIds: ['good', 'bad'] }, null);
    expect(createdPaths.size).toBe(2);
    expect(api.create).not.toHaveBeenCalled(); expect(api.put).not.toHaveBeenCalled();
  });
});
