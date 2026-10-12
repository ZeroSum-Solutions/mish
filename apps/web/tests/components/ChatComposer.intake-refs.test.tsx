import { workspaceContextFixture } from '../helpers/workspace-context';
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { IntakeBatchSnapshot } from '@mish/contracts';
import { ChatComposer } from '../../src/components/ChatComposer';
import { WorkbenchIntake, WorkbenchIntakeTarget } from '../../src/components/WorkbenchIntake';
import { IntakeStore } from '../../src/runtime/intake/intake-store';
import { flushMounts } from '../helpers/lexical-composer';

afterEach(cleanup);

it('adopts refs attached before composer mount once, and only stages them again after explicit attachment', async () => {
 const id = '00000000-0000-4000-8000-000000000001'; const fileId = '00000000-0000-4000-8000-000000000002';
 const receipt: IntakeBatchSnapshot = { intakeBatchId: id, revision: 2, destination: { kind: 'pending' }, createdAt: 1, updatedAt: 2, files: [{ clientFileId: fileId, order: 0, descriptor: { clientFileId: fileId, order: 0, filename: 'archive.zip', size: 1 }, state: 'stored', retryable: false, hasSuccessfulAttachment: true, stored: { assetId: 'asset', contentHash: 'a'.repeat(64), size: 1, filename: 'archive.zip', detectedMime: 'application/zip', kind: 'file', downloadUrl: '/download' } }] };
 const put = vi.fn(); const attach = vi.fn(async () => ({ intakeBatchId: id, revision: 2, files: receipt.files, attachments: [{ clientFileId: fileId, assetId: 'asset', contentHash: 'a'.repeat(64), projectId: 'p1', conversationId: 'c1', relPath: 'archive.zip', filename: 'archive.zip', size: 1 }] }));
 const store = new IntakeStore({ create: vi.fn(), get: async () => receipt, list: async () => ({ batches: [receipt] }), put, clear: vi.fn(), attach });
 await store.hydrate(null); await store.attach(id, { projectId: 'p1', conversationId: 'c1' });
 const onSend = vi.fn();
 render(<WorkbenchIntake store={store} target={{ destination: { kind: 'project', projectId: 'p1', conversationId: 'c1' }, context: null }}>
  <ChatComposer projectId="p1" projectFiles={[]} streaming={false} onEnsureProject={async () => 'p1'} onSend={onSend} onStop={vi.fn()} />
 </WorkbenchIntake>);
 await flushMounts(); expect(screen.getByTestId('staged-attachments').textContent).toContain('archive'); expect(onSend).not.toHaveBeenCalled(); expect(put).not.toHaveBeenCalled();
 fireEvent.click(screen.getByTestId('staged-attachments').querySelector('.msg-att-del')!);
 expect(screen.queryByTestId('staged-attachments')).toBeNull();
 await act(async () => { await store.hydrate(null); });
 expect(screen.queryByTestId('staged-attachments')).toBeNull(); expect(onSend).not.toHaveBeenCalled();
 await act(async () => { await store.attach(id, { projectId: 'p1', conversationId: 'c1' }); });
 expect(screen.getByTestId('staged-attachments').textContent).toContain('archive'); expect(put).not.toHaveBeenCalled(); expect(attach).toHaveBeenCalledTimes(2);
});

it('sends an opaque .png as a file and a detected image as an image, matching outcomes by client ID', async () => {
 const id = '00000000-0000-4000-8000-000000000011';
 const opaqueId = '00000000-0000-4000-8000-000000000012'; const imageId = '00000000-0000-4000-8000-000000000013'; const unknownId = '00000000-0000-4000-8000-000000000014';
 const receipt: IntakeBatchSnapshot = { intakeBatchId: id, revision: 2, destination: { kind: 'pending' }, createdAt: 1, updatedAt: 2, files: [
  { clientFileId: imageId, order: 1, descriptor: { clientFileId: imageId, order: 1, filename: 'detected.data', size: 1 }, state: 'stored', retryable: false, hasSuccessfulAttachment: true, stored: { assetId: imageId, contentHash: 'a'.repeat(64), size: 1, filename: 'detected.data', detectedMime: 'image/png', kind: 'image', downloadUrl: '/download' } },
  { clientFileId: opaqueId, order: 0, descriptor: { clientFileId: opaqueId, order: 0, filename: 'opaque.png', size: 1 }, state: 'stored', retryable: false, hasSuccessfulAttachment: true, stored: { assetId: opaqueId, contentHash: 'b'.repeat(64), size: 1, filename: 'opaque.png', detectedMime: 'application/octet-stream', kind: 'file', downloadUrl: '/download' } },
 ] };
 const attachments = [{ clientFileId: opaqueId, filename: 'opaque.png' }, { clientFileId: imageId, filename: 'detected.data' }, { clientFileId: unknownId, filename: 'unknown.png' }].map(file => ({ ...file, assetId: file.clientFileId, contentHash: 'a'.repeat(64), projectId: 'kind-project', conversationId: 'kind-conversation', relPath: file.filename, size: 1 }));
 const put = vi.fn(); const store = new IntakeStore({ create: vi.fn(), get: async () => receipt, list: async () => ({ batches: [receipt] }), put, clear: vi.fn(), attach: async () => ({ intakeBatchId: id, revision: 2, files: receipt.files, attachments }) });
 await store.hydrate(null); await store.attach(id, { projectId: 'kind-project', conversationId: 'kind-conversation' });
 const onSend = vi.fn();
 render(<WorkbenchIntake store={store} target={{ destination: { kind: 'project', projectId: 'kind-project', conversationId: 'kind-conversation' }, context: null }}>
  <ChatComposer projectId="kind-project" projectFiles={[]} streaming={false} onEnsureProject={async () => 'kind-project'} onSend={onSend} onStop={vi.fn()} />
 </WorkbenchIntake>);
 await flushMounts(); expect(onSend).not.toHaveBeenCalled(); expect(put).not.toHaveBeenCalled();
 // AC-R01.3: only a stored opaque receipt carries the readability label on its chip.
 const chips = [...screen.getByTestId('staged-attachments').querySelectorAll('.msg-att-doc')];
 const notices = Object.fromEntries(chips.map(chip => [chip.getAttribute('title')?.split('\n')[0], chip.querySelector('[data-testid="staged-attachment-opaque-note"]')?.textContent ?? null]));
 expect(notices).toEqual({ 'opaque.png': 'Stored; contents cannot be read by this model.', 'unknown.png': null });
 fireEvent.click(screen.getByTestId('chat-send'));
 expect(onSend).toHaveBeenCalledTimes(1);
 expect(onSend.mock.calls[0]?.[1].map((file: { name: string; kind: string }) => [file.name, file.kind])).toEqual([['opaque.png', 'file'], ['detected.data', 'image'], ['unknown.png', 'file']]);
});

it('stages a native DS composer drop using its scoped project, conversation and Workspace authority', async () => {
 const context = workspaceContextFixture({ workspaceId: 'ds-workspace', workspaceMemberId: 'ds-member' }); let receipt: IntakeBatchSnapshot | undefined;
 const store = new IntakeStore({
  create: async request => (receipt = { ...request, revision: 1, createdAt: 1, updatedAt: 1, files: request.files.map(descriptor => ({ clientFileId: descriptor.clientFileId, order: descriptor.order, descriptor, state: 'queued', retryable: true, hasSuccessfulAttachment: false })) }),
  get: async () => receipt!, list: async () => ({ batches: [] }), clear: vi.fn(),
  put: async (id, fileId) => { const file = receipt!.files.find(file => file.clientFileId === fileId)!; const stored = { ...file, state: 'stored' as const, retryable: false, stored: { assetId: fileId, contentHash: 'a'.repeat(64), size: file.descriptor.size, filename: file.descriptor.filename, detectedMime: 'application/zip', kind: 'file' as const, downloadUrl: '/download' } }; receipt = { ...receipt!, revision: 2, files: [stored] }; return { intakeBatchId: id, revision: 2, file: stored }; },
  attach: async (id, target, authority) => { expect(authority).toEqual(context); return { intakeBatchId: id, revision: 3, files: receipt!.files, attachments: receipt!.files.map(file => ({ clientFileId: file.clientFileId, assetId: file.stored!.assetId, contentHash: file.stored!.contentHash, projectId: target.projectId, conversationId: target.conversationId, relPath: file.descriptor.filename, filename: file.descriptor.filename, size: file.descriptor.size })) }; },
 });
 const onSend = vi.fn(); const scope = { destination: { kind: 'project' as const, projectId: 'ds-project', conversationId: 'ds-conversation' }, context };
 render(<WorkbenchIntake store={store} target={{ destination: { kind: 'pending' }, context }}><WorkbenchIntakeTarget target={scope}><ChatComposer projectId="ds-project" projectFiles={[]} streaming={false} onEnsureProject={async () => 'ds-project'} onSend={onSend} onStop={vi.fn()} /></WorkbenchIntakeTarget></WorkbenchIntake>);
 await flushMounts(); fireEvent.drop(screen.getByTestId('chat-composer'), { dataTransfer: { types: ['Files'], files: [new File(['source'], 'ds-original.zip')], items: [] } });
 expect((await screen.findByTestId('staged-attachments')).textContent).toContain('ds-original'); expect(store.getSnapshot()[0]?.target).toEqual(scope); expect(store.getSnapshot()[0]?.attached?.attachments[0]).toMatchObject({ projectId: 'ds-project', conversationId: 'ds-conversation' }); expect(onSend).not.toHaveBeenCalled();
});

it('keeps one chip per clientFileId when repeated attachment receipts change its path', async () => {
 const batchId = '00000000-0000-4000-8000-000000000021'; const fileId = '00000000-0000-4000-8000-000000000022';
 const receipt: IntakeBatchSnapshot = { intakeBatchId: batchId, revision: 2, destination: { kind: 'pending' }, createdAt: 1, updatedAt: 2, files: [{ clientFileId: fileId, order: 0, descriptor: { clientFileId: fileId, order: 0, filename: 'scaffold.html', size: 1 }, state: 'stored', retryable: false, hasSuccessfulAttachment: false }] };
 const ref = { clientFileId: fileId, assetId: 'asset', contentHash: 'a'.repeat(64), projectId: 'p', conversationId: 'c', relPath: 'scaffold.html', filename: 'scaffold.html', size: 1 };
 const store = new IntakeStore({ create: vi.fn(), get: async () => receipt, list: async () => ({ batches: [receipt] }), put: vi.fn(), clear: vi.fn(), attach: vi.fn().mockResolvedValueOnce({ intakeBatchId: batchId, revision: 3, files: receipt.files, attachments: [ref] }).mockResolvedValue({ intakeBatchId: batchId, revision: 4, files: receipt.files, attachments: [{ ...ref, relPath: 'scaffold-1.html' }] }) });
 const onSend = vi.fn();
 render(<WorkbenchIntake store={store} target={{ destination: { kind: 'project', projectId: 'p', conversationId: 'c' }, context: null }}><ChatComposer projectId="p" projectFiles={[]} streaming={false} onEnsureProject={async () => 'p'} onSend={onSend} onStop={vi.fn()} /></WorkbenchIntake>);
 await flushMounts(); await act(async () => { await store.attach(batchId, { projectId: 'p', conversationId: 'c', clientFileIds: [fileId] }); });
 expect(screen.getByTestId('staged-attachments').children).toHaveLength(1);
 await act(async () => { await store.attach(batchId, { projectId: 'p', conversationId: 'c', clientFileIds: [fileId] }); });
 await vi.waitFor(() => expect(store.getSnapshot()[0]?.stageSequence).toBe(2));
 expect(screen.getByTestId('staged-attachments').children).toHaveLength(1);
 fireEvent.click(screen.getByTestId('chat-send')); expect(onSend.mock.calls[0]?.[1]).toHaveLength(1);
});
