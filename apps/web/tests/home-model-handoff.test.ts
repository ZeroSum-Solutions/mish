import type { AttachIntakeResponse } from '@mish/contracts';
import { describe, expect, it, vi } from 'vitest';
import { materializeHomeModelHandoff, saveCreatedHomeModelHandoff, homeModelHandoffOwnsInput, readHomeModelHandoff, writeHomeModelHandoff, type HomeModelHandoff } from '../src/runtime/workbench/home-model-handoff';
const record: HomeModelHandoff = { projectId: 'actual-project', sessionId: 'actual-seed', choice: { agentId: 'codex', modelId: 'default' }, modelRevision: 0, modelSaveFailed: false, prompt: 'retained input', context: { workspaceItems: [] }, autoSend: true, workingDirReady: true, batchIds: ['saved-batch'], batchFileIds: { 'saved-batch': ['good', 'bad'] }, completedBatchIds: [], attachments: [{ path: 'existing.txt', name: 'existing.txt', kind: 'file', size: 1 }], ready: false };
const snapshot = { projectId: record.projectId, sessionId: record.sessionId, revision: 1, choice: record.choice, updatedAt: 0 };
function receipt(ids: string[]): AttachIntakeResponse {
  return { intakeBatchId: 'saved-batch', revision: 3, attachments: ids.map(clientFileId => ({ clientFileId, assetId: clientFileId, contentHash: 'a'.repeat(64), projectId: record.projectId, conversationId: record.sessionId, relPath: `${clientFileId}.txt`, filename: `${clientFileId}.txt`, size: 2 })), files: ids.map((clientFileId, order) => ({ clientFileId, order, descriptor: { clientFileId, order, filename: `${clientFileId}.txt`, size: 2 }, state: 'stored', retryable: false, hasSuccessfulAttachment: true })) };
}
describe('actual Home seed model/materialization handoff', () => {
  it('retains the exact accepted R15 revision across model setup, storage and recovery', async () => {
    const designBrief = { id: 'brief_home', revision: 3, hash: 'b'.repeat(64) };
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    const result = await materializeHomeModelHandoff({ ...record, designBrief }, {
      saveModel: async () => snapshot, attach: async () => receipt(['good', 'bad']),
      persist: next => writeHomeModelHandoff(next, 'local', storage),
    });
    expect(result.designBrief).toEqual(designBrief);
    expect(readHomeModelHandoff(record.projectId, 'local', storage)?.designBrief).toEqual(designBrief);
  });

  it('saves the model before attachment and never settles input merely for setup completion', async () => {
    const order: string[] = [];
    const result = await materializeHomeModelHandoff(record, { saveModel: async () => { order.push('PUT'); return snapshot; }, attach: async () => { order.push('attach saved ref'); return receipt(['good', 'bad']); }, persist: () => {} });
    expect(order).toEqual(['PUT', 'attach saved ref']);
    expect(result.prompt).toBe(record.prompt);
    expect(result.autoSend).toBe(true);
    expect(result.sessionId).toBe('actual-seed');
    expect(result.ready).toBe(true);
  });
  it('holds exact input, IDs and refs when PUT fails, without attaching or creating another seed', async () => {
    const attach = vi.fn(); const persist = vi.fn();
    await expect(materializeHomeModelHandoff(record, { saveModel: async () => { throw new Error('PUT failed'); }, attach, persist })).rejects.toThrow('PUT failed');
    expect(attach).not.toHaveBeenCalled(); expect(persist).not.toHaveBeenCalled();
    expect(record.prompt).toBe('retained input'); expect(record.attachments[0]?.path).toBe('existing.txt');
  });
  it('persists completed attachment batches and skips them after retry/reload', async () => {
    let durable = record;
    const failed = { ...record, batchIds: ['completed', 'failed'], batchFileIds: { completed: ['good'], failed: ['bad'] } };
    await expect(materializeHomeModelHandoff(failed, { saveModel: async () => snapshot, attach: async id => { if (id === 'failed') throw new Error('409 attach'); return { ...receipt(['good']), intakeBatchId: id }; }, persist: next => { durable = next; } })).rejects.toThrow('409 attach');
    expect(durable.completedBatchIds).toEqual(['completed']);
    const attach = vi.fn().mockResolvedValue({ ...receipt(['bad']), intakeBatchId: 'failed' });
    const result = await materializeHomeModelHandoff(durable, { saveModel: async () => snapshot, attach, persist: () => {} });
    expect(attach.mock.calls).toEqual([['failed', ['bad']]]); expect(result.prompt).toBe(record.prompt);
  });
  it('keeps a partially failed batch pending and preserves successfully attached refs for retry', async () => {
    const result: AttachIntakeResponse = { intakeBatchId: 'saved-batch', revision: 2,
      attachments: [{ clientFileId: 'good', assetId: 'asset', contentHash: 'a'.repeat(64), projectId: record.projectId, conversationId: record.sessionId, relPath: 'good.txt', filename: 'good.txt', size: 2 }],
      files: [
        { clientFileId: 'good', order: 0, descriptor: { clientFileId: 'good', order: 0, filename: 'good.txt', size: 2 }, state: 'stored', retryable: false, hasSuccessfulAttachment: true },
        { clientFileId: 'bad', order: 1, descriptor: { clientFileId: 'bad', order: 1, filename: 'bad.txt', size: 2 }, state: 'failed', retryable: true, hasSuccessfulAttachment: false },
      ],
    };
    let durable = record;
    await expect(materializeHomeModelHandoff(record, { saveModel: async () => snapshot, attach: async () => result, persist: next => { durable = next; } })).rejects.toThrow('home-attachment-incomplete');
    expect(durable.ready).toBe(false);
    expect(durable.completedBatchIds).toEqual([]);
    expect(durable.attachments.map(file => file.path)).toEqual(['existing.txt', 'good.txt']);
    const attach = vi.fn(async () => ({ ...result, attachments: receipt(['good', 'bad']).attachments, files: result.files.map(file => ({ ...file, state: 'stored' as const, hasSuccessfulAttachment: true })) }));
    const complete = await materializeHomeModelHandoff(durable, { saveModel: async () => snapshot, attach, persist: () => {} });
    expect(attach).toHaveBeenCalledWith('saved-batch', ['good', 'bad']);
    expect(complete.ready).toBe(true);
    expect(complete.attachments.map(file => file.path)).toEqual(['existing.txt', 'good.txt', 'bad.txt']);
  });

  it('never treats missing attach acknowledgement or completed booleans as target receipts', async () => {
    for (const response of [undefined, { ...receipt(['good', 'bad']), attachments: [] }]) {
      let durable = record;
      await expect(materializeHomeModelHandoff(record, { saveModel: async () => snapshot, attach: async () => response, persist: next => { durable = next; } })).rejects.toThrow('home-attachment-incomplete');
      expect(durable.ready).toBe(false);
      expect(durable.completedBatchIds).toEqual([]);
    }
  });
  it.each(['success', 'failure'] as const)('does not swallow a scope fence after deferred model %s', async outcome => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    vi.stubGlobal('window', { sessionStorage: storage, dispatchEvent: vi.fn() });
    let current = true; let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const assertCurrent = () => { if (!current) throw new Error('home-handoff-scope-changed'); };
    try {
      const pending = saveCreatedHomeModelHandoff(record, 'original-scope', async () => { await gate; if (outcome === 'failure') throw new Error('offline'); return snapshot; }, assertCurrent);
      const before = [...values]; current = false; release();
      await expect(pending).rejects.toThrow('home-handoff-scope-changed');
      expect([...values]).toEqual(before);
      expect(readHomeModelHandoff(record.projectId, 'original-scope', storage)?.modelSaveFailed).toBe(false);
    } finally { vi.unstubAllGlobals(); }
  });

  it('keeps a failed working directory guard before model/save/ref operations', async () => {
    const saveModel = vi.fn();
    await expect(materializeHomeModelHandoff({ ...record, workingDirReady: false }, { saveModel, attach: vi.fn(), persist: vi.fn() })).rejects.toThrow('home-working-dir-not-ready');
    expect(saveModel).not.toHaveBeenCalled();
  });
  it('settles only the retained actual seed and complete input, including refs/context', () => {
    const ready = { ...record, ready: true };
    expect(homeModelHandoffOwnsInput(ready, record.sessionId, record.prompt, record.attachments, record.context)).toBe(true);
    expect(homeModelHandoffOwnsInput(ready, 'another-seed', record.prompt, record.attachments, record.context)).toBe(false);
    expect(homeModelHandoffOwnsInput(ready, record.sessionId, 'different prompt', record.attachments, record.context)).toBe(false);
    expect(homeModelHandoffOwnsInput(ready, record.sessionId, record.prompt, [], record.context)).toBe(false);
    expect(homeModelHandoffOwnsInput(ready, record.sessionId, record.prompt, record.attachments)).toBe(false);
    expect(homeModelHandoffOwnsInput({ ...record, ready: false }, record.sessionId, record.prompt, record.attachments, record.context)).toBe(false);
  });
  it('partitions retained public choices/input by account/workspace and rejects credentials', () => {
    const values = new Map<string, string>(); const storage = { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => { values.set(k, v); } };
    writeHomeModelHandoff(record, 'current-account', storage);
    expect(readHomeModelHandoff(record.projectId, 'current-account', storage)).toEqual(record);
    expect(readHomeModelHandoff(record.projectId, 'new-account', storage)).toBeNull();
    expect(() => writeHomeModelHandoff({ ...record, choice: { ...record.choice!, apiKey: 'fixture-secret' } as never }, 'current-account', storage)).toThrow();
  });
});
