import { afterEach, describe, expect, it, vi } from 'vitest';
import { attachIntakeBatch, clearIntakeBatch, createIntakeBatch, getIntakeBatch, intakeFileDownloadUrl, listIntakeBatches, putIntakeFile } from '../../src/providers/intake';
import type { WorkspaceCollabContext } from '@open-design/contracts';

const batchId = '00000000-0000-4000-8000-000000000001';
const fileId = '00000000-0000-4000-8000-000000000002';
const descriptor = { clientFileId: fileId, order: 0, filename: 'opaque.zip', size: 1, declaredMime: 'application/zip' };
const snapshot = { intakeBatchId: batchId, revision: 1, destination: { kind: 'pending' }, files: [{ clientFileId: fileId, order: 0, descriptor, state: 'queued', retryable: true, hasSuccessfulAttachment: false }], createdAt: 1, updatedAt: 1 };
const context: WorkspaceCollabContext = { workspaceId: 'workspace', workspaceType: 'personal', workspaceMemberId: 'member', role: 'owner', lifecycleState: 'active', memberStatus: 'active', billingState: 'active', planId: null, providerMode: 'personal_byok', seatSummary: { seatLimit: 1, usedSeats: 1, availableSeats: 0, isSeatFull: true }, permissions: { canShareProjects: true, canWriteSyncedFiles: true, canManageMembers: true, canManageBilling: true, canInviteMembers: true, canManageAutoRecharge: true, canViewWorkspaceSettings: true, canManageSharedResources: true } };
afterEach(() => vi.unstubAllGlobals());

describe('durable intake provider boundary', () => {
  it('uses shared strict parsers and captured Workspace headers on create/get/list/clear/attach', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(snapshot))).mockResolvedValueOnce(new Response(JSON.stringify(snapshot))).mockResolvedValueOnce(new Response(JSON.stringify({ batches: [snapshot] }))).mockResolvedValueOnce(new Response(JSON.stringify(snapshot))).mockResolvedValueOnce(new Response(JSON.stringify({ intakeBatchId: batchId, revision: 2, attachments: [], files: snapshot.files })));
    vi.stubGlobal('fetch', fetcher);
    await createIntakeBatch({ intakeBatchId: batchId, destination: { kind: 'pending' }, files: [{ clientFileId: fileId, order: 0, filename: 'opaque.zip', size: 1 }] }, context);
    await getIntakeBatch(batchId, context); await listIntakeBatches(context);
    await clearIntakeBatch(batchId, { clientFileIds: [fileId] }, context);
    await attachIntakeBatch(batchId, { projectId: 'project', conversationId: 'conversation', clientFileIds: [fileId] }, context);
    expect(fetcher.mock.calls.map(([url, init]) => [url, init.method ?? 'GET'])).toEqual([
      ['/api/workbench/intake', 'POST'], [`/api/workbench/intake/${batchId}`, 'GET'], ['/api/workbench/intake?state=pending', 'GET'], [`/api/workbench/intake/${batchId}`, 'DELETE'], [`/api/workbench/intake/${batchId}/attach`, 'POST'],
    ]);
    for (const [, init] of fetcher.mock.calls) expect(init.headers).toMatchObject({ 'x-od-workspace-id': 'workspace', 'x-od-workspace-member-id': 'member' });
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ ...snapshot, destination: { kind: 'cloud', projectId: 'invented' } })));
    await expect(getIntakeBatch(batchId)).rejects.toThrow();
  });

  it('uploads the actual Blob body and retains a typed per-file refusal', async () => {
    const file = new File(['zip bytes'], 'opaque.zip', { type: 'application/zip' });
    const failed = { intakeBatchId: batchId, revision: 2, file: { clientFileId: fileId, order: 0, descriptor, state: 'failed', retryable: false, hasSuccessfulAttachment: false, error: { code: 'intake-size-mismatch', message: 'Wrong size' } } };
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(failed), { status: 400 })); vi.stubGlobal('fetch', fetcher);
    expect(await putIntakeFile(batchId, fileId, file, context)).toEqual(failed);
    expect(fetcher).toHaveBeenCalledWith(`/api/workbench/intake/${batchId}/files/${fileId}`, expect.objectContaining({ method: 'PUT', body: file, headers: expect.objectContaining({ 'Content-Type': 'application/octet-stream' }) }));
  });

  it('rejects a mismatched receipt identity', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ intakeBatchId: batchId, revision: 1, file: { clientFileId: batchId, order: 0, descriptor: { ...descriptor, clientFileId: batchId }, state: 'queued', retryable: true, hasSuccessfulAttachment: false } }))));
    await expect(putIntakeFile(batchId, fileId, new Blob(['a']))).rejects.toThrow('identity');
  });

  it('reports byte progress and aborts the raw XHR transport', async () => {
    let xhr!: FakeXhr;
    class FakeXhr {
      upload: { onprogress?: (event: { loaded: number; total: number; lengthComputable: boolean }) => void } = {};
      onload?: () => void; onabort?: () => void; onerror?: () => void;
      status = 200; responseText = ''; sent?: Blob; requestHeaders: Record<string, string> = {};
      constructor() { xhr = this; }
      open() {} setRequestHeader(key: string, value: string) { this.requestHeaders[key] = value; }
      send(body: Blob) { this.sent = body; }
      abort() { this.onabort?.(); }
      getAllResponseHeaders() { return 'content-type: application/json'; }
    }
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    const controller = new AbortController(); const progress = vi.fn(); const file = new Blob(['bytes']);
    const request = putIntakeFile(batchId, fileId, file, context, { signal: controller.signal, onProgress: progress });
    const rejection = expect(request).rejects.toThrow('cancelled');
    await vi.waitFor(() => expect(xhr?.sent).toBe(file));
    xhr.upload.onprogress?.({ loaded: 2, total: 5, lengthComputable: true });
    expect(progress).toHaveBeenCalledWith(2, 5); expect(xhr.requestHeaders['x-od-workspace-id']).toBe('workspace');
    controller.abort(new Error('cancelled')); await rejection;
  });

  it('retries daemon admission429 while preserving the same raw body and identity', async () => {
    const result = { intakeBatchId: batchId, revision: 2, file: { clientFileId: fileId, order: 0, descriptor, state: 'queued', retryable: true, hasSuccessfulAttachment: false } };
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('busy', { status: 429, headers: { 'Retry-After': '0' } })).mockResolvedValueOnce(new Response(JSON.stringify(result)));
    vi.stubGlobal('fetch', fetcher); const file = new Blob(['bytes']);
    expect(await putIntakeFile(batchId, fileId, file, context)).toEqual(result);
    expect(fetcher).toHaveBeenCalledTimes(2); expect(fetcher.mock.calls.every(([, init]) => init.body === file)).toBe(true);
  });

  it('returns receipt-addressed navigation links without fetching200MiB into a Blob', () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    expect(intakeFileDownloadUrl(batchId, fileId, context)).toBe(`/api/workbench/intake/${batchId}/files/${fileId}/download?workspaceId=workspace&workspaceMemberId=member`);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
