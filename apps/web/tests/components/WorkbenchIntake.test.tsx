// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { parseRoute } from '../../src/router';
import { applyLibraryAsset, fetchProjectFiles, invalidateProjectFilesCache } from '../../src/providers/registry';
import type { CreateIntakeBatchRequest, IntakeBatchSnapshot, IntakeFilePutResponse } from '@open-design/contracts';
import { IntakeStore, type IntakeTarget } from '../../src/runtime/intake/intake-store';
import { INTAKE_ATTACHED_EVENT, INTAKE_PROJECT_FILE_ADDED_EVENT, WorkbenchDropModeButton, WorkbenchIntake, useIntakeDropTarget, useWorkbenchIntake } from '../../src/components/WorkbenchIntake';
import { IframeKeepAliveProvider, PooledIframe } from '../../src/components/IframeKeepAlivePool';
import { installMockOpenDesignHost } from '@open-design/host/testing';
import { HomeHero } from '../../src/components/HomeHero';
import { ChatComposer } from '../../src/components/ChatComposer';
import { ChatPane } from '../../src/components/ChatPane';
import { DesignFilesPanel } from '../../src/components/DesignFilesPanel';
import { materializeHomeModelHandoff } from '../../src/runtime/workbench/home-model-handoff';
import { flushMounts } from '../helpers/lexical-composer';

vi.mock('../../src/providers/registry', async importOriginal => ({ ...await importOriginal<typeof import('../../src/providers/registry')>(), applyLibraryAsset: vi.fn(), fetchProjectFiles: vi.fn(async () => []), invalidateProjectFilesCache: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
function fixture() {
 const receipts = new Map<string, IntakeBatchSnapshot>(); const manifests = new Map<string, CreateIntakeBatchRequest>();
 const create = vi.fn(async (request: CreateIntakeBatchRequest) => {
  manifests.set(request.intakeBatchId, request);
  const receipt: IntakeBatchSnapshot = { intakeBatchId: request.intakeBatchId, revision: 1, destination: request.destination, files: request.files.map(file => ({ clientFileId: file.clientFileId, order: file.order, descriptor: file, state: 'queued', retryable: true, hasSuccessfulAttachment: false })), createdAt: 1, updatedAt: 1 };
  receipts.set(receipt.intakeBatchId, receipt); return receipt;
 });
 const get = vi.fn(async (id: string) => receipts.get(id)!);
 const list = vi.fn(async () => ({ batches: [...receipts.values()] }));
 const put = vi.fn(async (id: string, fileId: string, _body: Blob): Promise<IntakeFilePutResponse> => {
  const receipt = receipts.get(id)!; const descriptor = manifests.get(id)!.files.find(file => file.clientFileId === fileId)!;
  const file = { clientFileId: fileId, order: descriptor.order, descriptor, state: 'stored' as const, retryable: false, hasSuccessfulAttachment: false, stored: { assetId: fileId, contentHash: 'a'.repeat(64), size: descriptor.size, filename: descriptor.filename, detectedMime: 'application/octet-stream', kind: 'file' as const, downloadUrl: '/download' } };
  const next = { ...receipt, revision: receipt.revision + 1, files: receipt.files.map(item => item.clientFileId === fileId ? file : item) }; receipts.set(id, next); return { intakeBatchId: id, revision: next.revision, file };
 });
 const clear = vi.fn(async (id: string, request: { clientFileIds?: string[] }) => { const receipt = receipts.get(id)!; const next: IntakeBatchSnapshot = { ...receipt, revision: receipt.revision + 1, files: receipt.files.map(file => request.clientFileIds?.includes(file.clientFileId) ? { ...file, state: 'cleared', retryable: false } : file) }; receipts.set(id, next); return next; });
 const attach = vi.fn(async (id: string, request: { projectId: string; conversationId: string; clientFileIds?: string[] }) => {
  const receipt = receipts.get(id)!;
  const attachments = receipt.files.filter(file => file.stored && (!request.clientFileIds || request.clientFileIds.includes(file.clientFileId))).map(file => ({ clientFileId: file.clientFileId, assetId: file.stored!.assetId, contentHash: file.stored!.contentHash, projectId: request.projectId, conversationId: request.conversationId, relPath: file.stored!.filename, filename: file.stored!.filename, size: file.stored!.size }));
  const next = { ...receipt, revision: receipt.revision + 1, files: receipt.files.map(file => attachments.some(attached => attached.clientFileId === file.clientFileId) ? { ...file, hasSuccessfulAttachment: true } : file) };
  receipts.set(id, next); return { intakeBatchId: id, revision: next.revision, attachments, files: next.files };
 });
 const store = new IntakeStore({ create, get, list, put, clear, attach }); return { store, create, put, attach, clear, receipts };
}

it('dismisses only the successful Home send selection and keeps unattached Ready siblings', async () => {
 const f = fixture();
 const accepted = f.store.accept([new File(['a'], 'sent.zip'), new File(['b'], 'ready.zip')], { destination: { kind: 'pending' }, context: null });
 await accepted.settled;
 const sentId = f.store.getSnapshot()[0]!.descriptors[0]!.clientFileId;
 f.store.stagePending(accepted.id, sentId);
 render(<WorkbenchIntake store={f.store} target={{ destination: { kind: 'pending' }, context: null }}><div /></WorkbenchIntake>);
 const sentFiles = [{ batchId: accepted.id, clientFileId: sentId }];
 expect(await screen.findByText('sent.zip')).toBeInTheDocument();
 await act(async () => { f.store.finishHomeSend(sentFiles); });
 expect(screen.getByText('sent.zip')).toBeInTheDocument();
 expect(f.store.messageFileIds(accepted.id)).toEqual([sentId]);
 await act(async () => { await f.store.attach(accepted.id, { projectId: 'project', conversationId: 'conversation', clientFileIds: [sentId] }); });
 expect(screen.getByText('sent.zip')).toBeInTheDocument();
 await act(async () => { f.store.finishHomeSend(sentFiles); });
 expect(screen.queryByText('sent.zip')).toBeNull();
 expect(screen.getByText('ready.zip').closest('li')).toHaveTextContent('Ready');
 expect(f.store.getSnapshot()[0]!.receipt!.files[0]!.stored).toBeDefined();
 expect(f.clear).not.toHaveBeenCalled();
});
function drop(element: Element, files: File[]) { fireEvent.drop(element, { dataTransfer: { types: ['Files'], files, items: [] } }); }
function FolderTarget({ target }: { target: IntakeTarget }) { const ref = useIntakeDropTarget(target); return <div ref={ref} data-testid="folder">Folder</div>; }

function HomeComposer({ onSubmit = vi.fn() }: { onSubmit?: () => void }) {
 return <HomeHero prompt="" onPromptChange={vi.fn()} onSubmit={onSubmit} activePluginTitle={null} activeChipId={null} onClearActivePlugin={vi.fn()} pluginOptions={[]} pluginsLoading={false} pendingPluginId={null} pendingChipId={null} onPickPlugin={vi.fn()} onPickExamplePlugin={vi.fn()} onOpenPluginDetails={vi.fn()} onPickChip={vi.fn()} onClearActiveChip={vi.fn()} contextItemCount={0} error={null} />;
}

it('lets Home attach one saved tray file to its pending message without re-uploading siblings', async () => {
 const f = fixture(); const onSubmit = vi.fn(); const target: IntakeTarget = { destination: { kind: 'pending' }, context: null };
 render(<WorkbenchIntake store={f.store} homeComposerVisible target={target}><div data-testid="shell" /><HomeComposer onSubmit={onSubmit} /></WorkbenchIntake>);
 await flushMounts();
 drop(screen.getByTestId('shell'), [new File(['html'], 'scaffold.html'), new File(['keep'], 'later.txt')]);
 await screen.findAllByText('Ready');
 expect(screen.queryByTestId('home-hero-intake-files')).toBeNull();
 fireEvent.click(screen.getAllByRole('button', { name: 'Attach to message' })[0]!);
 expect(screen.getByTestId('home-hero-intake-files').textContent).toContain('scaffold.html');
 expect(screen.getByTestId('home-hero-intake-files').textContent).not.toContain('later.txt');
 expect(onSubmit).not.toHaveBeenCalled(); expect(f.attach).not.toHaveBeenCalled();
 const batch = f.store.getSnapshot()[0]!;
 const choice = { agentId: 'codex', modelId: 'gpt-6.1-sol' };
 await act(async () => { await materializeHomeModelHandoff({ projectId: 'created-project', sessionId: 'seed-conversation', choice, modelRevision: 0, modelSaveFailed: false, prompt: '', autoSend: true, workingDirReady: true, batchIds: f.store.messageBatchIds(null), completedBatchIds: [], attachments: [], ready: false }, {
  saveModel: async () => ({ projectId: 'created-project', sessionId: 'seed-conversation', choice, revision: 1, updatedAt: 1 }),
  pendingFileIds: id => f.store.messageFileIds(id),
  attach: (id, clientFileIds) => f.store.attach(id, { projectId: 'created-project', conversationId: 'seed-conversation', clientFileIds }, { stage: false }),
  persist: vi.fn(),
 }); });
 expect(f.attach.mock.calls[0]?.[1].clientFileIds).toEqual([batch.descriptors[0]!.clientFileId]);
 expect(screen.queryByTestId('home-hero-intake-files')).toBeNull();
 expect(f.store.messageBatchIds(null)).toEqual([]);
 expect(f.put).toHaveBeenCalledTimes(2);
 expect(screen.getAllByRole('link', { name: 'Download' })).toHaveLength(2);
 expect(screen.getAllByRole('button', { name: 'Clear' })).toHaveLength(2);
});

it('automatically stages a Home composer drop and can remove its chip while keeping the stored download', async () => {
 const f = fixture(); const onSubmit = vi.fn();
 render(<WorkbenchIntake store={f.store} homeComposerVisible target={{ destination: { kind: 'pending' }, context: null }}><HomeComposer onSubmit={onSubmit} /></WorkbenchIntake>);
 await flushMounts();
 drop(screen.getByTestId('home-hero').querySelector('[data-native-file-drop]')!, [new File(['zip'], 'source.zip')]);
 await screen.findByText('Ready');
 expect(screen.getByTestId('home-hero-intake-files').textContent).toContain('source.zip');
 expect(onSubmit).not.toHaveBeenCalled(); expect(f.put).toHaveBeenCalledTimes(1);
 fireEvent.click(screen.getByRole('button', { name: 'Remove source.zip' }));
 expect(screen.queryByTestId('home-hero-intake-files')).toBeNull();
 expect(f.store.messageFileIds(f.store.getSnapshot()[0]!.id)).toEqual([]);
 expect(screen.getByRole('link', { name: 'Download' })).toBeTruthy();
});

it('stores a chat-pane drop once without a project write until Attach to this chat is clicked', async () => {
 const f = fixture();
 render(<WorkbenchIntake store={f.store} target={{ destination: { kind: 'project', projectId: 'p', conversationId: 'c' }, context: null }}><div data-testid="chat-pane"><span data-testid="chat-pane-inner" /></div><ChatComposer projectId="p" projectFiles={[]} streaming={false} onEnsureProject={async () => 'p'} onSend={vi.fn()} onStop={vi.fn()} /></WorkbenchIntake>);
 await flushMounts(); drop(screen.getByTestId('chat-pane-inner'), [new File(['html'], 'scaffold.html')]);
 await screen.findByText('Ready');
 expect(f.store.getSnapshot()).toHaveLength(1);
 expect(f.store.getSnapshot()[0]!.target.destination).toEqual({ kind: 'pending' });
 expect(f.attach).not.toHaveBeenCalled(); expect(screen.queryByTestId('staged-attachments')).toBeNull();
 fireEvent.click(screen.getByRole('button', { name: 'Attach to this chat' }));
 await vi.waitFor(() => expect(screen.getByTestId('staged-attachments').children).toHaveLength(1));
 expect(f.put).toHaveBeenCalledTimes(1); expect(f.attach).toHaveBeenCalledTimes(1);
 const attached = screen.getByRole('button', { name: 'Attached' });
 expect(attached).toBeDisabled(); fireEvent.click(attached);
 expect(f.attach).toHaveBeenCalledTimes(1);
 expect(screen.getByText('scaffold.html attached to this chat.')).toHaveAttribute('aria-live', 'polite');
});

it('locks a chat row while its attachment write is in flight', async () => {
 const f = fixture(); const implementation = f.attach.getMockImplementation()!;
 let finish!: (value: Awaited<ReturnType<typeof f.attach>>) => void;
 f.attach.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
 render(<WorkbenchIntake store={f.store} target={{ destination: { kind: 'project', projectId: 'p', conversationId: 'c' }, context: null }}><div data-testid="shell" /></WorkbenchIntake>);
 drop(screen.getByTestId('shell'), [new File(['html'], 'scaffold.html')]); await screen.findByText('Ready');
 const attach = screen.getByRole('button', { name: 'Attach to this chat' });
 fireEvent.click(attach); fireEvent.click(attach);
 expect(attach).toBeDisabled();
 await vi.waitFor(() => expect(f.attach).toHaveBeenCalledTimes(1));
 const id = f.store.getSnapshot()[0]!.id;
 await act(async () => { finish(await implementation(id, { projectId: 'p', conversationId: 'c' })); });
 expect(screen.getByRole('button', { name: 'Attached' })).toBeDisabled();
 expect(f.attach).toHaveBeenCalledTimes(1);
});

it('lets the nested chat composer consume a drop before a parent project upload handler', async () => {
 const f = fixture(); const projectUpload = vi.fn();
 render(<WorkbenchIntake store={f.store} target={{ destination: { kind: 'project', projectId: 'p', conversationId: 'c' }, context: null }}><div data-native-file-drop onDrop={projectUpload}><ChatComposer projectId="p" projectFiles={[]} streaming={false} onEnsureProject={async () => 'p'} onSend={vi.fn()} onStop={vi.fn()} /></div></WorkbenchIntake>);
 await flushMounts(); drop(screen.getByTestId('chat-composer').querySelector('[contenteditable]')!, [new File(['html'], 'scaffold.html')]);
 await screen.findByText('Ready');
 expect(projectUpload).not.toHaveBeenCalled(); expect(f.store.getSnapshot()).toHaveLength(1); expect(f.put).toHaveBeenCalledTimes(1);
 expect((await screen.findByTestId('staged-attachments')).children).toHaveLength(1);
});

it.each(['/projects/p', '/projects/p/files/existing.html'])('adds a saved file from %s without a conversation exactly once and opens it', async path => {
 const f = fixture(); const open = vi.fn(); const addedEvent = vi.fn(); window.addEventListener(INTAKE_PROJECT_FILE_ADDED_EVENT, addedEvent); const route = parseRoute(path);
 if (route.kind !== 'project') throw new Error('Expected project route');
 expect(route.conversationId).toBeFalsy();
 let finish!: (result: { relPath: string }) => void;
 vi.mocked(applyLibraryAsset).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
 render(<WorkbenchIntake store={f.store} onOpenProjectFile={open} target={{ destination: { kind: 'project', projectId: route.projectId }, context: null }}><div data-testid="shell" /></WorkbenchIntake>);
 drop(screen.getByTestId('shell'), [new File(['html'], 'scaffold.html')]); await screen.findByText('Ready');
 expect(f.store.getSnapshot()[0]!.target.destination).toEqual({ kind: 'pending' });
 expect(applyLibraryAsset).not.toHaveBeenCalled(); expect(screen.getByRole('link', { name: 'Download' })).toBeTruthy();
 const add = screen.getByRole('button', { name: 'Add to project files' });
 fireEvent.click(add); fireEvent.click(add);
 await vi.waitFor(() => expect(applyLibraryAsset).toHaveBeenCalledExactlyOnceWith(expect.any(String), 'p', undefined, undefined, null));
 expect(add).toBeDisabled(); expect(open).not.toHaveBeenCalled();
 await act(async () => { finish({ relPath: 'library/aaaaaaaaaaaa.html' }); });
 expect(open).toHaveBeenCalledExactlyOnceWith('p', 'library/aaaaaaaaaaaa.html');
 expect(addedEvent).toHaveBeenCalledTimes(1);
 expect((addedEvent.mock.calls[0]![0] as CustomEvent).detail).toMatchObject({ projectId: 'p', relPath: 'library/aaaaaaaaaaaa.html' });
 window.removeEventListener(INTAKE_PROJECT_FILE_ADDED_EVENT, addedEvent);
 expect(invalidateProjectFilesCache).toHaveBeenCalledExactlyOnceWith('p', null);
 const added = screen.getByRole('button', { name: 'Added to project files' });
 expect(added).toBeDisabled(); fireEvent.click(added);
 expect(applyLibraryAsset).toHaveBeenCalledTimes(1); expect(f.attach).not.toHaveBeenCalled(); expect(f.put).toHaveBeenCalledTimes(1);
 expect(screen.getByText('scaffold.html added to project files.')).toHaveAttribute('aria-live', 'polite');
});

it('reuses an existing project copy after reload without overwriting edits', async () => {
 const f = fixture(); const open = vi.fn();
 vi.mocked(fetchProjectFiles).mockResolvedValueOnce([{ name: 'library/aaaaaaaaaaaa.html' } as Awaited<ReturnType<typeof fetchProjectFiles>>[number]]);
 render(<WorkbenchIntake store={f.store} onOpenProjectFile={open} target={{ destination: { kind: 'project', projectId: 'p' }, context: null }}><div data-testid="shell" /></WorkbenchIntake>);
 drop(screen.getByTestId('shell'), [new File(['html'], 'scaffold.html')]); await screen.findByText('Ready');
 fireEvent.click(screen.getByRole('button', { name: 'Add to project files' }));
 await vi.waitFor(() => expect(open).toHaveBeenCalledExactlyOnceWith('p', 'library/aaaaaaaaaaaa.html'));
 expect(fetchProjectFiles).toHaveBeenCalledWith('p', { fresh: true, requireAuthoritative: true, workspaceContext: null });
 expect(applyLibraryAsset).not.toHaveBeenCalled();
 expect(screen.getByRole('button', { name: 'Added to project files' })).toBeDisabled();
});

it('copies the saved asset rather than opening an element companion or backup with the same hash prefix', async () => {
 const f = fixture(); const open = vi.fn();
 vi.mocked(fetchProjectFiles).mockResolvedValueOnce(['library/aaaaaaaaaaaa.element.html', 'library/aaaaaaaaaaaa.html.bak'].map(name => ({ name } as Awaited<ReturnType<typeof fetchProjectFiles>>[number])));
 vi.mocked(applyLibraryAsset).mockResolvedValueOnce({ relPath: 'library/aaaaaaaaaaaa.html' });
 render(<WorkbenchIntake store={f.store} onOpenProjectFile={open} target={{ destination: { kind: 'project', projectId: 'p' }, context: null }}><div data-testid="shell" /></WorkbenchIntake>);
 drop(screen.getByTestId('shell'), [new File(['html'], 'scaffold.html')]); await screen.findByText('Ready');
 fireEvent.click(screen.getByRole('button', { name: 'Add to project files' }));
 await vi.waitFor(() => expect(open).toHaveBeenCalledExactlyOnceWith('p', 'library/aaaaaaaaaaaa.html'));
 expect(applyLibraryAsset).toHaveBeenCalledTimes(1);
});

it('does not reopen a project after its pending Add finishes on another route', async () => {
 const f = fixture(); const open = vi.fn(); const target: IntakeTarget = { destination: { kind: 'project', projectId: 'p' }, context: null };
 let finish!: (result: { relPath: string }) => void;
 vi.mocked(applyLibraryAsset).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
 const view = render(<WorkbenchIntake store={f.store} target={target} generationKey="project" onOpenProjectFile={open}><div data-testid="shell" /></WorkbenchIntake>);
 drop(screen.getByTestId('shell'), [new File(['html'], 'scaffold.html')]); await screen.findByText('Ready');
 fireEvent.click(screen.getByRole('button', { name: 'Add to project files' }));
 await vi.waitFor(() => expect(applyLibraryAsset).toHaveBeenCalledTimes(1));
 view.rerender(<WorkbenchIntake store={f.store} target={{ destination: { kind: 'pending' }, context: null }} generationKey="home" onOpenProjectFile={open}><div /></WorkbenchIntake>);
 await act(async () => { finish({ relPath: 'library/aaaaaaaaaaaa.html' }); });
 expect(open).not.toHaveBeenCalled();
});

it('scopes completed writes to their chat and keeps project-file Add separate', async () => {
 const f = fixture(); const target = (projectId: string, conversationId?: string): IntakeTarget => ({ destination: { kind: 'project', projectId, ...(conversationId ? { conversationId } : {}) }, context: null });
 const content = (projectId: string, conversationId?: string) => <WorkbenchIntake store={f.store} target={target(projectId, conversationId)}><div data-testid="shell" /></WorkbenchIntake>;
 const view = render(content('p', 'c1'));
 drop(screen.getByTestId('shell'), [new File(['html'], 'scaffold.html')]); await screen.findByText('Ready');
 fireEvent.click(screen.getByRole('button', { name: 'Attach to this chat' })); await screen.findByRole('button', { name: 'Attached' });
 view.rerender(content('p', 'c2'));
 expect(screen.getByRole('button', { name: 'Attach to this chat' })).toBeEnabled();
 fireEvent.click(screen.getByRole('button', { name: 'Attach to this chat' })); await screen.findByRole('button', { name: 'Attached' });
 view.rerender(content('other', 'c3'));
 expect(screen.getByRole('button', { name: 'Attach to this chat' })).toBeEnabled();
 expect(f.attach).toHaveBeenCalledTimes(2);
 view.rerender(content('add-only'));
 vi.mocked(applyLibraryAsset).mockResolvedValueOnce({ relPath: 'library/aaaaaaaaaaaa.html' });
 fireEvent.click(screen.getByRole('button', { name: 'Add to project files' })); await screen.findByRole('button', { name: 'Added to project files' });
 view.rerender(content('add-only', 'c4'));
 expect(screen.getByRole('button', { name: 'Attach to this chat' })).toBeEnabled();
});

it('keeps the saved download and retries an unsuccessful Add without opening a file', async () => {
 const f = fixture(); const open = vi.fn();
 vi.mocked(applyLibraryAsset).mockResolvedValueOnce(null).mockResolvedValueOnce({ relPath: 'library/scaffold.html' });
 render(<WorkbenchIntake store={f.store} onOpenProjectFile={open} target={{ destination: { kind: 'project', projectId: 'p' }, context: null }}><div data-testid="shell" /></WorkbenchIntake>);
 drop(screen.getByTestId('shell'), [new File(['html'], 'scaffold.html')]); await screen.findByText('Ready');
 fireEvent.click(screen.getByRole('button', { name: 'Add to project files' }));
 await screen.findByText('Could not add the file. Try again.');
 expect(open).not.toHaveBeenCalled(); expect(screen.getByRole('link', { name: 'Download' })).toBeTruthy();
 const retry = screen.getByRole('button', { name: 'Add to project files' }); expect(retry).toBeEnabled(); fireEvent.click(retry);
 await vi.waitFor(() => expect(open).toHaveBeenCalledExactlyOnceWith('p', 'library/scaffold.html'));
 expect(applyLibraryAsset).toHaveBeenCalledTimes(2); expect(f.put).toHaveBeenCalledTimes(1);
});

it.each(['Settings', 'Library'])('offers Use on Home on %s and visibly stages the file after navigation', async () => {
 const f = fixture(); const home = vi.fn(); const target: IntakeTarget = { destination: { kind: 'pending' }, context: null };
 const view = render(<WorkbenchIntake store={f.store} target={target} onUseOnHome={home}><div data-testid="shell" /></WorkbenchIntake>);
 drop(screen.getByTestId('shell'), [new File(['html'], 'scaffold.html')]); await screen.findByText('Ready');
 expect(screen.queryByRole('button', { name: 'Attach to message' })).toBeNull();
 expect(f.store.messageBatchIds(null)).toEqual([]);
 fireEvent.click(screen.getByRole('button', { name: 'Use on Home' }));
 expect(home).toHaveBeenCalledTimes(1); expect(f.attach).not.toHaveBeenCalled();
 view.rerender(<WorkbenchIntake store={f.store} homeComposerVisible target={target} onUseOnHome={home}><HomeComposer /></WorkbenchIntake>);
 await flushMounts();
 expect(screen.getByTestId('home-hero-intake-files').textContent).toContain('scaffold.html');
 expect(screen.getByRole('button', { name: 'Attach to message' })).toBeDisabled();
 expect(screen.getByText('scaffold.html attached to the Home message.')).toHaveAttribute('aria-live', 'polite');
 expect(f.put).toHaveBeenCalledTimes(1);
});

it('acknowledges a shell drop, freezes its local folder, and only attaches refs without starting generation', async () => {
 const f = fixture(); const events = vi.fn(); window.addEventListener(INTAKE_ATTACHED_EVENT, events);
 const target: IntakeTarget = { destination: { kind: 'project', projectId: 'first', conversationId: 'conversation' }, context: null };
 const folder: IntakeTarget = { ...target, destination: { kind: 'project', projectId: 'first', conversationId: 'conversation', dir: 'chosen-folder' } };
 const view = render(<WorkbenchIntake store={f.store} target={target}><FolderTarget target={folder} /></WorkbenchIntake>);
 drop(screen.getByTestId('folder'), [new File(['opaque'], 'original.zip')]);
 expect(screen.getByTestId('workbench-intake-tray')).toBeTruthy(); expect(screen.getByText('original.zip')).toBeTruthy();
 view.rerender(<WorkbenchIntake store={f.store} target={{ destination: { kind: 'project', projectId: 'second', conversationId: 'other' }, context: null }}><FolderTarget target={{ destination: { kind: 'project', projectId: 'second', dir: 'other' }, context: null }} /></WorkbenchIntake>);
 await screen.findByText('Ready');
 expect(f.create.mock.calls[0]?.[0].destination).toEqual(folder.destination); await vi.waitFor(() => expect(f.attach).toHaveBeenCalledWith(expect.any(String), { projectId: 'first', conversationId: 'conversation' }, null));
 expect(f.put).toHaveBeenCalledTimes(1); expect(events).toHaveBeenCalledTimes(1); expect(screen.getByRole('link', { name: 'Download' }).getAttribute('href')).toContain('/download');
 window.removeEventListener(INTAKE_ATTACHED_EVENT, events);
});

it('shows21files as one20file batch plus explicit continuation and restores stored refs after reload', async () => {
 const f = fixture(); const target: IntakeTarget = { destination: { kind: 'pending' }, context: null };
 const view = render(<WorkbenchIntake store={f.store} target={target}><div data-testid="shell" /></WorkbenchIntake>);
 drop(screen.getByTestId('shell'), Array.from({ length: 21 }, (_, index) => new File(['a'], `${index}.zip`)));
 expect(screen.getByText('1 files remain. Continue to add the next 20.')).toBeTruthy();
 await vi.waitFor(() => expect(f.put).toHaveBeenCalledTimes(20)); expect(f.create).toHaveBeenCalledTimes(1);
 fireEvent.click(screen.getByRole('button', { name: 'Continue' })); await vi.waitFor(() => expect(f.put).toHaveBeenCalledTimes(21)); expect(f.create).toHaveBeenCalledTimes(2);
 view.unmount(); const reloaded = new IntakeStore({ create: f.create, get: async id => f.receipts.get(id)!, list: async () => ({ batches: [...f.receipts.values()] }), put: f.put, clear: f.clear, attach: f.attach });
 render(<WorkbenchIntake store={reloaded} target={target}><div /></WorkbenchIntake>);
 await screen.findByText('20.zip'); expect(f.put).toHaveBeenCalledTimes(21); expect(screen.getAllByRole('link', { name: 'Download' })).toHaveLength(21);
 await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: 'Clear' })[0]!); });
 expect(screen.queryByText('0.zip')).toBeNull(); expect(f.clear).toHaveBeenCalledTimes(1);
});

it('shows original metadata for a needs-reselection receipt after a fresh controller reload', async () => {
 const f = fixture(); const id = '00000000-0000-4000-8000-000000000001'; const fileId = '00000000-0000-4000-8000-000000000002';
 f.receipts.set(id, { intakeBatchId: id, revision: 4, destination: { kind: 'pending' }, createdAt: 1, updatedAt: 2, files: [{ clientFileId: fileId, order: 0, descriptor: { clientFileId: fileId, order: 0, filename: 'resume.zip', size: 1024, declaredMime: 'application/zip', relativePath: 'selected/resume.zip' }, state: 'needs-reselection', retryable: true, hasSuccessfulAttachment: false }] });
 render(<WorkbenchIntake store={f.store} target={{ destination: { kind: 'pending' }, context: null }}><div /></WorkbenchIntake>);
 const filename = await screen.findByText('resume.zip'); const row = filename.closest('li')!;
 expect(row.textContent).toContain('1 KB'); expect(row.textContent).toContain('application/zip'); expect(row.textContent).toContain('selected/resume.zip');
 fireEvent.change(row.querySelector('input')!, { target: { files: [new File(['a'], 'wrong.zip', { type: 'application/zip' })] } });
 await screen.findByText('Choose the original file with the same name, size and type'); expect(f.put).not.toHaveBeenCalled(); expect(f.create).not.toHaveBeenCalled();
});

it('distinguishes saved opaque bytes from preview and agent readability without changing known preview kinds', async () => {
 const f = fixture(); const id = '00000000-0000-4000-8000-000000000001';
 const ids = ['00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000003'];
 f.receipts.set(id, { intakeBatchId: id, revision: 2, destination: { kind: 'pending' }, createdAt: 1, updatedAt: 2, files: ids.map((clientFileId, order) => {
  const filename = order === 0 ? 'opaque.zip' : 'view.html';
  return { clientFileId, order, descriptor: { clientFileId, order, filename, size: 1 }, state: 'stored', retryable: false, hasSuccessfulAttachment: false, stored: { assetId: clientFileId, contentHash: 'a'.repeat(64), size: 1, filename, detectedMime: order === 0 ? 'application/zip' : 'text/html', kind: order === 0 ? 'file' : 'html', downloadUrl: '/download' } };
 }) });
 render(<WorkbenchIntake store={f.store} target={{ destination: { kind: 'project', projectId: 'project', conversationId: 'conversation' }, context: null }}><div /></WorkbenchIntake>);
 const opaque = (await screen.findByText('opaque.zip')).closest('li')!; const known = screen.getByText('view.html').closest('li')!;
 expect(opaque.textContent).toContain('Ready'); expect(opaque.querySelector('[data-testid="intake-opaque-note"]')?.textContent).toBe('Stored; contents cannot be read by this model.');
 expect(opaque.querySelector('a[download]')).toBeTruthy(); expect(opaque.textContent).toContain('Attach to this chat');
 expect(known.querySelector('[data-testid="intake-opaque-note"]')).toBeNull(); expect(f.put).not.toHaveBeenCalled(); expect(f.attach).not.toHaveBeenCalled();
});

it('keeps the opened project send gate held while Home receipt attachment is unfinished', async () => {
 const f = fixture(); const accepted = f.store.accept([new File(['a'], 'home.zip')], { destination: { kind: 'pending' }, context: null }); await accepted.settled;
 let finishAttach!: (value: Awaited<ReturnType<typeof f.attach>>) => void;
 const attached = f.attach.getMockImplementation()!;
 f.attach.mockImplementation(() => new Promise(resolve => { finishAttach = resolve; }));
 f.store.beginHomeHandoff('new-project', [accepted.id]);
 function ComposerGate() { const intake = useWorkbenchIntake(); return <button disabled={intake?.handoffPending}>Send</button>; }
 render(<WorkbenchIntake store={f.store} target={{ destination: { kind: 'project', projectId: 'new-project' }, context: null }}><ComposerGate /></WorkbenchIntake>);
 expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled(); expect(screen.getByText('home.zip')).toBeTruthy();
 const handoff = f.store.attach(accepted.id, { projectId: 'new-project', conversationId: 'conversation' });
 await vi.waitFor(() => expect(f.attach).toHaveBeenCalled()); expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
 await act(async () => { finishAttach(await attached(accepted.id, { projectId: 'new-project', conversationId: 'conversation' })); await handoff; f.store.finishHomeHandoff('new-project'); });
 expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled(); expect(f.put).toHaveBeenCalledTimes(1);
});

it('cancels explicit guest drop mode on Escape and route generation change without replacing the node', async () => {
 const f = fixture(); const target: IntakeTarget = { destination: { kind: 'project', projectId: 'project' }, context: null };
 const view = render(<WorkbenchIntake store={f.store} generationKey="tab-a" target={target}><WorkbenchDropModeButton /><iframe title="Guest" src="about:blank" /></WorkbenchIntake>);
 const guest = screen.getByTitle('Guest'); const parent = guest.parentNode; const frame = (guest as HTMLIFrameElement).contentWindow;
 fireEvent.click(screen.getByTestId('workbench-drop-mode'));
 expect(screen.getByTestId('workbench-drop-overlay')).toBeTruthy(); expect(guest.style.visibility).toBe('hidden');
 fireEvent.keyDown(document, { key: 'Tab' }); expect(screen.getByRole('button', { name: 'Cancel' })).toBe(document.activeElement);
 fireEvent.keyDown(document, { key: 'Escape' }); expect(screen.queryByTestId('workbench-drop-overlay')).toBeNull(); expect(guest.style.visibility).toBe('');
 fireEvent.click(screen.getByTestId('workbench-drop-mode'));
 view.rerender(<WorkbenchIntake store={f.store} generationKey="tab-b" target={target}><WorkbenchDropModeButton /><iframe title="Guest" src="about:blank" /></WorkbenchIntake>);
 expect(screen.queryByTestId('workbench-drop-overlay')).toBeNull(); expect(screen.getByTitle('Guest')).toBe(guest); expect(guest.parentNode).toBe(parent); expect((guest as HTMLIFrameElement).contentWindow).toBe(frame); expect(guest.getAttribute('src')).toBe('about:blank'); expect(guest.style.visibility).toBe(''); expect(f.put).not.toHaveBeenCalled();
});

it('keeps the actual pooled preview hidden through an unrelated layout refresh during drop mode', async () => {
 const f = fixture(); const target: IntakeTarget = { destination: { kind: 'project', projectId: 'project' }, context: null };
 function Guest({ height }: { height: number }) {
  useWorkbenchIntake();
  return <PooledIframe cacheKey="project\0guest.html" title="Pooled guest" src="about:blank" style={{ visibility: 'visible', pointerEvents: 'auto', height: `${height}px` }} />;
 }
 const content = (height: number) => <IframeKeepAliveProvider><WorkbenchIntake store={f.store} target={target}><WorkbenchDropModeButton /><Guest height={height} /></WorkbenchIntake></IframeKeepAliveProvider>;
 const view = render(content(200)); const frame = screen.getByTitle('Pooled guest') as HTMLIFrameElement;
 const parent = frame.parentNode; const frameWindow = frame.contentWindow;
 fireEvent.click(screen.getByTestId('workbench-drop-mode'));
 expect(frame.style.visibility).toBe('hidden');
 view.rerender(content(400));
 await vi.waitFor(() => expect(frame.style.visibility).toBe('hidden'));
 expect(frame.style.pointerEvents).toBe('none'); expect(frame.style.height).toBe('400px');
 fireEvent.keyDown(document, { key: 'Escape' });
 expect(screen.queryByTestId('workbench-drop-overlay')).toBeNull(); expect(screen.getByTitle('Pooled guest')).toBe(frame);
 expect(frame.parentNode).toBe(parent); expect(frame.contentWindow).toBe(frameWindow); expect(frame.getAttribute('src')).toBe('about:blank');
 expect(frame.style.visibility).toBe('visible'); expect(frame.style.pointerEvents).toBe('auto'); expect(frame.style.height).toBe('400px');
});

// AC-R01.1 native folder drops through the desktop host listing.
function folderEntry(name: string, files: Record<string, string>) {
 const children = Object.entries(files).map(([child, body]) => ({ isFile: true, isDirectory: false, name: child, fullPath: `/${name}/${child}`, file: (ok: (file: File) => void) => ok(new File([body], child)) }));
 const pages: unknown[][] = [children, []];
 return { isFile: false, isDirectory: true, name, fullPath: `/${name}`, createReader: () => ({ readEntries: (ok: (entries: unknown[]) => void) => ok(pages.shift() ?? []) }) };
}
function dropFolder(element: Element, folder: File, entry: unknown) {
 fireEvent.drop(element, { dataTransfer: { types: ['Files'], files: [folder], items: [{ kind: 'file', getAsFile: () => folder, webkitGetAsEntry: () => entry }] } });
}

it('uploads a natively listed folder into the editor target it was dropped on and reports what it refused', async () => {
 const f = fixture(); const folder = new File([], 'Brand Kit');
 const listDroppedDirectory = vi.fn(async () => ({ rootName: 'Brand Kit', files: [{ relativePath: 'a.txt', size: 1 }, { relativePath: 'b.txt', size: 1 }], refused: [{ relativePath: 'escape.txt', reason: 'symlink-outside-tree' as const }], truncated: false }));
 const restore = installMockOpenDesignHost({ host: { intake: { listDroppedDirectory } } });
 try {
  const shell: IntakeTarget = { destination: { kind: 'project', projectId: 'p' }, context: null };
  const editor: IntakeTarget = { destination: { kind: 'project', projectId: 'p', dir: 'assets' }, context: null };
  render(<WorkbenchIntake store={f.store} target={shell}><FolderTarget target={editor} /></WorkbenchIntake>);
  dropFolder(screen.getByTestId('folder'), folder, folderEntry('Brand Kit', { 'a.txt': 'a', 'b.txt': 'b', 'escape.txt': 'secret' }));
  await vi.waitFor(() => expect(f.put).toHaveBeenCalledTimes(2));
  expect(listDroppedDirectory).toHaveBeenCalledExactlyOnceWith(folder);
  expect(f.create).toHaveBeenCalledTimes(1);
  expect(f.create.mock.calls[0]?.[0].destination).toEqual(editor.destination);
  expect(f.create.mock.calls[0]?.[0].files.map(file => file.filename)).toEqual(['a.txt', 'b.txt']);
  expect(screen.getByText(/escape\.txt/)).toBeTruthy();
  expect(screen.queryByText('Folder drops need a supported folder importer. Choose individual files.')).toBeNull();
 } finally { restore(); }
});

it('keeps the folder notice and uploads nothing for a folder drop without a native listing', async () => {
 const f = fixture(); const target: IntakeTarget = { destination: { kind: 'pending' }, context: null };
 render(<WorkbenchIntake store={f.store} target={target}><div data-testid="shell" /></WorkbenchIntake>);
 dropFolder(screen.getByTestId('shell'), new File([], 'Brand Kit'), folderEntry('Brand Kit', { 'a.txt': 'a' }));
 expect(await screen.findByText('Folder drops need a supported folder importer. Choose individual files.')).toBeTruthy();
 expect(f.create).not.toHaveBeenCalled();
});

// jsdom has no DragEvent, so set the modifier the way a real drag reports it.
function fileDragOver(element: Element, altKey: boolean) {
 const event = new Event('dragover', { bubbles: true, cancelable: true });
 Object.defineProperties(event, { dataTransfer: { value: { types: ['Files'], dropEffect: 'none' } }, altKey: { value: altKey } });
 act(() => { element.dispatchEvent(event); });
}

it('opens the visible intake overlay for an Option-drag over a guest and hands the drop back on release', () => {
 const f = fixture(); const target: IntakeTarget = { destination: { kind: 'project', projectId: 'project' }, context: null };
 render(<WorkbenchIntake store={f.store} target={target}><div data-testid="chrome" /><div className="db-fallback"><iframe title="Guest" src="about:blank" /></div></WorkbenchIntake>);
 const guest = screen.getByTitle('Guest');
 fileDragOver(screen.getByTestId('chrome'), false);
 expect(screen.queryByTestId('workbench-drop-overlay')).toBeNull(); expect(guest.style.visibility).toBe('');
 fileDragOver(screen.getByTestId('chrome'), true);
 expect(screen.getByTestId('workbench-drop-overlay')).toBeTruthy(); expect(guest.style.visibility).toBe('hidden');
 fileDragOver(screen.getByTestId('workbench-drop-overlay'), false);
 expect(screen.queryByTestId('workbench-drop-overlay')).toBeNull(); expect(guest.style.visibility).toBe('');
 expect(f.create).not.toHaveBeenCalled();
});

it('ignores an Option-drag when the only frames are app-owned previews, not guest websites', () => {
 const f = fixture(); const target: IntakeTarget = { destination: { kind: 'project', projectId: 'project' }, context: null };
 render(<WorkbenchIntake store={f.store} target={target}><div data-testid="chrome" /><iframe title="Preview" src="about:blank" /></WorkbenchIntake>);
 fileDragOver(screen.getByTestId('chrome'), true);
 expect(screen.queryByTestId('workbench-drop-overlay')).toBeNull();
 expect(screen.getByTitle('Preview').style.visibility).toBe('');
});

it('still uploads the loose files of a drop when one of its folders cannot be listed', async () => {
 const f = fixture(); const folder = new File([], 'Gone'); const loose = new File(['l'], 'loose.txt');
 const listDroppedDirectory = vi.fn(async () => { throw new Error('The dropped folder is unavailable'); });
 const restore = installMockOpenDesignHost({ host: { intake: { listDroppedDirectory } } });
 try {
  const target: IntakeTarget = { destination: { kind: 'project', projectId: 'p' }, context: null };
  render(<WorkbenchIntake store={f.store} target={target}><div data-testid="shell" /></WorkbenchIntake>);
  fireEvent.drop(screen.getByTestId('shell'), { dataTransfer: { types: ['Files'], files: [loose, folder], items: [
   { kind: 'file', getAsFile: () => loose, webkitGetAsEntry: () => ({ isFile: true, isDirectory: false, name: 'loose.txt', fullPath: '/loose.txt' }) },
   { kind: 'file', getAsFile: () => folder, webkitGetAsEntry: () => folderEntry('Gone', { 'x.txt': 'x' }) },
  ] } });
  await vi.waitFor(() => expect(f.put).toHaveBeenCalledTimes(1));
  expect(f.create.mock.calls[0]?.[0].files.map(file => file.filename)).toEqual(['loose.txt']);
  expect(await screen.findByText(/Gone.*The dropped folder is unavailable/)).toBeTruthy();
 } finally { restore(); }
});

it('keeps a Design Files drop inside its upload surface and out of enclosing upload handlers', async () => {
 const f = fixture(); const parentUpload = vi.fn();
 function FilesArea() {
  const intake = useWorkbenchIntake()!;
  return <DesignFilesPanel projectId="p" projectKind="prototype" files={[]} liveArtifacts={[]} onRefreshFiles={vi.fn()} onOpenFile={vi.fn()} onOpenLiveArtifact={vi.fn()} onRenameFile={vi.fn()} onDeleteFile={vi.fn()} onDeleteFiles={vi.fn()} onUpload={vi.fn()} onUploadFiles={files => intake.add(files)} onPaste={vi.fn()} onNewSketch={vi.fn()} />;
 }
 render(<WorkbenchIntake store={f.store} target={{ destination: { kind: 'project', projectId: 'p', conversationId: 'c' }, context: null }}><div data-native-file-drop onDrop={parentUpload}><FilesArea /></div></WorkbenchIntake>);
 drop(document.querySelector('.df-body')!, [new File(['html'], 'scaffold.html')]); await screen.findByText('Ready');
 expect(parentUpload).not.toHaveBeenCalled(); expect(f.store.getSnapshot()).toHaveLength(1); expect(f.put).toHaveBeenCalledTimes(1);
 expect(f.store.getSnapshot()[0]!.target.destination).toEqual({ kind: 'project', projectId: 'p', conversationId: 'c' });
});

it('stages the explicit Continue remainder of a Home composer drop in the same pending prompt', async () => {
 const f = fixture(); render(<WorkbenchIntake store={f.store} homeComposerVisible target={{ destination: { kind: 'pending' }, context: null }}><HomeComposer /></WorkbenchIntake>);
 await flushMounts(); drop(screen.getByTestId('home-hero').querySelector('[data-native-file-drop]')!, Array.from({ length: 21 }, (_, i) => new File(['x'], `file-${i}.txt`)));
 await vi.waitFor(() => expect(f.put).toHaveBeenCalledTimes(20));
 fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
 await vi.waitFor(() => expect(f.put).toHaveBeenCalledTimes(21));
 expect(screen.getByTestId('home-hero-intake-files').children).toHaveLength(21);
});

it('lets Home explicitly reuse a saved file after a completed handoff without re-uploading', async () => {
 const f = fixture(); const saved = f.store.accept([new File(['x'], 'reusable.txt')], { destination: { kind: 'pending' }, context: null }); await saved.settled;
 await f.store.attach(saved.id, { projectId: 'old-project', conversationId: 'old-session' }, { stage: false });
 render(<WorkbenchIntake store={f.store} homeComposerVisible target={{ destination: { kind: 'pending' }, context: null }}><HomeComposer /></WorkbenchIntake>);
 await flushMounts(); fireEvent.click(screen.getByRole('button', { name: 'Attach to message' }));
 expect(screen.getByTestId('home-hero-intake-files').textContent).toContain('reusable.txt');
 expect(f.store.messageBatchIds(null)).toEqual([saved.id]); expect(f.put).toHaveBeenCalledTimes(1);
});

it('J4-06: an accessible close control hides the tray without clearing its files, and a new drop reopens it', async () => {
 const f = fixture();
 const target: IntakeTarget = { destination: { kind: 'pending' }, context: null };
 render(<WorkbenchIntake store={f.store} target={target}><div data-testid="shell" /></WorkbenchIntake>);
 drop(screen.getByTestId('shell'), [new File(['html'], 'scaffold.html')]);
 await screen.findAllByText('Ready');
 const tray = screen.getByTestId('workbench-intake-tray');
 expect(tray).toBeTruthy();
 // J4-07: the copy must describe the current behavior — a drop already
 // saves the file; the attach actions are what use it.
 expect(tray.textContent).toContain('Dropped files save here right away');
 expect(tray.textContent).not.toContain('wait here until you choose to use them');
 fireEvent.click(screen.getByRole('button', { name: 'Close files tray' }));
 expect(screen.queryByTestId('workbench-intake-tray')).toBeNull();
 // The file itself is untouched — only the tray is hidden.
 expect(f.store.getSnapshot()).toHaveLength(1);
 expect(f.store.getSnapshot()[0]!.receipt?.files[0]?.state).toBe('stored');
 drop(screen.getByTestId('shell'), [new File(['html'], 'second.html')]);
 await screen.findByText('second.html');
 expect(screen.getByTestId('workbench-intake-tray')).toBeTruthy();
});

it('J4-06 round 2: anchors the tray below the live docked header height, so its close control is never covered by it', async () => {
 const header = document.createElement('header');
 header.className = 'app-chrome-header workspace-tabs-chrome';
 header.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 390, bottom: 52, width: 390, height: 52, toJSON: () => '' });
 document.body.appendChild(header);
 try {
  const f = fixture();
  const target: IntakeTarget = { destination: { kind: 'pending' }, context: null };
  render(<WorkbenchIntake store={f.store} target={target}><div data-testid="shell" /></WorkbenchIntake>);
  drop(screen.getByTestId('shell'), [new File(['html'], 'scaffold.html')]);
  await screen.findAllByText('Ready');
  const tray = screen.getByTestId('workbench-intake-tray');
  // The measured header height (52px) must reach the tray as a CSS variable
  // the narrow-viewport media query reads; a fixed 16px guess is exactly
  // what let the close button land under the header in the live QA pass.
  expect(tray.style.getPropertyValue('--intake-header-clearance')).toBe('52px');
  // The close button itself must still be reachable (not just positioned
  // correctly on paper) — clicking it must actually close the tray.
  fireEvent.click(screen.getByRole('button', { name: 'Close files tray' }));
  expect(screen.queryByTestId('workbench-intake-tray')).toBeNull();
 } finally { header.remove(); }
});

it('keeps a chat-pane drop pending even when the pane sits inside a project file drop area', async () => {
 const f = fixture();
 function ProjectArea() {
  const ref = useIntakeDropTarget({ destination: { kind: 'project', projectId: 'p', conversationId: 'c' }, context: null });
  return <div ref={ref}><ChatPane messages={[]} streaming={false} error={null} projectId="p" projectFiles={[]} onEnsureProject={async () => 'p'} onSend={vi.fn()} onStop={vi.fn()} conversations={[]} activeConversationId="c" onSelectConversation={vi.fn()} onDeleteConversation={vi.fn()} /></div>;
 }
 render(<WorkbenchIntake store={f.store} target={{ destination: { kind: 'project', projectId: 'p', conversationId: 'c' }, context: null }}><ProjectArea /></WorkbenchIntake>);
 await flushMounts(); drop(document.querySelector('.pane')!, [new File(['html'], 'scaffold.html')]); await screen.findByText('Ready');
 expect(f.store.getSnapshot()[0]!.target.destination).toEqual({ kind: 'pending' }); expect(f.attach).not.toHaveBeenCalled(); expect(f.put).toHaveBeenCalledTimes(1);
});
