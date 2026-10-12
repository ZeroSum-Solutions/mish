import { randomUUID } from '../../utils/uuid';
import type { AttachIntakeRequest, AttachIntakeResponse, CreateIntakeBatchRequest, IntakeBatchSnapshot, IntakeDestination, IntakeFileDescriptor, IntakeFilePutResponse, WorkspaceCollabContext } from '@mish/contracts';
import { attachIntakeBatch, clearIntakeBatch, createIntakeBatch, getIntakeBatch, listIntakeBatches, putIntakeFile } from '../../providers/intake';
import { workspaceAccountScopedCacheKey } from '../../collab/workspace-identity';

export interface IntakeTarget { destination: IntakeDestination; context: WorkspaceCollabContext | null }
interface IntakeApi {
 create: typeof createIntakeBatch; get: typeof getIntakeBatch; list: typeof listIntakeBatches;
 put: typeof putIntakeFile; clear: typeof clearIntakeBatch; attach: typeof attachIntakeBatch;
}
export interface IntakeView {
 homeSentFileIds?: readonly string[];
 id: string; scopeKey: string; attached?: AttachIntakeResponse; stageSequence?: number; homeHandoffProjectId?: string; pendingMessageFileIds?: readonly string[]; target: IntakeTarget; descriptors: readonly IntakeFileDescriptor[];
 receipt?: IntakeBatchSnapshot; uploading: readonly string[];
 progress: Readonly<Record<string, number>>; errors: Readonly<Record<string, string>>;
}
interface Batch {
 view: IntakeView; files: Map<string, File>; controllers: Map<string, AbortController>;
 cleared: Set<string>; manifestReady: Promise<void>; settled: Promise<void>; scopeKey: string;
}
const defaultApi: IntakeApi = { create: createIntakeBatch, get: getIntakeBatch, list: listIntakeBatches, put: putIntakeFile, clear: clearIntakeBatch, attach: attachIntakeBatch };
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Receipts are server truth. Files/progress here are transient attempt state only. */
export class IntakeStore {
 private batches = new Map<string, Batch>();
 private listeners = new Set<() => void>();
 private snapshot: readonly IntakeView[] = [];
 constructor(private readonly api: IntakeApi = defaultApi, private readonly uuid = randomUUID) {}
 getSnapshot = (): readonly IntakeView[] => this.snapshot;
 subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
 private publish(): void { this.snapshot = Array.from(this.batches.values(), b => b.view); for (const listener of this.listeners) listener(); }
 private merge(batch: Batch, receipt: IntakeBatchSnapshot): void {
  const previous = batch.view.receipt;
  if (previous && receipt.revision < previous.revision) return;
  batch.view = { ...batch.view, descriptors: receipt.files.map(file => file.descriptor).sort((a, b) => a.order - b.order), receipt: { ...receipt, files: receipt.files.map(file => batch.cleared.has(file.clientFileId) ? { ...file, state: 'cleared', stored: undefined, retryable: false } : file) } };
  for (const file of receipt.files) if (file.state === 'stored' || file.state === 'cleared' || (file.state === 'failed' && !file.retryable)) batch.files.delete(file.clientFileId);
  this.publish();
 }
 async hydrate(context: WorkspaceCollabContext | null): Promise<void> {
  const scopeKey = workspaceAccountScopedCacheKey(context);
  const response = await this.api.list(context);
  // An answer issued before sign-in changed cannot replace a fresh receipt.
  if (scopeKey !== workspaceAccountScopedCacheKey(context)) return;
  for (const receipt of response.batches) {
   const previous = this.batches.get(receipt.intakeBatchId);
   if (previous?.scopeKey === scopeKey) { this.merge(previous, receipt); continue; }
   const batch: Batch = { view: { id: receipt.intakeBatchId, scopeKey, target: { destination: receipt.destination, context }, descriptors: receipt.files.map(file => file.descriptor).sort((a, b) => a.order - b.order), receipt, uploading: [], progress: {}, errors: {} }, files: new Map(), controllers: new Map(), cleared: new Set(receipt.files.filter(f => f.state === 'cleared').map(f => f.clientFileId)), manifestReady: Promise.resolve(), settled: Promise.resolve(), scopeKey };
   this.batches.set(receipt.intakeBatchId, batch);
  }
  this.publish();
 }
 accept(files: readonly File[], target: IntakeTarget): { id: string; remaining: File[]; settled: Promise<void> } {
  const selected = files.slice(0, 20); if (!selected.length) throw new Error('Choose at least one file');
  const id = this.uuid(); const frozenTarget = structuredClone(target);
  const descriptors = selected.map((file, order): IntakeFileDescriptor => ({ clientFileId: this.uuid(), order, filename: file.name, size: file.size, ...(file.type ? { declaredMime: file.type } : {}) }));
  const batch: Batch = { view: { id, scopeKey: workspaceAccountScopedCacheKey(frozenTarget.context), target: frozenTarget, descriptors, uploading: [], progress: {}, errors: {} }, files: new Map(descriptors.map((descriptor, i) => [descriptor.clientFileId, selected[i]!])), controllers: new Map(), cleared: new Set(), manifestReady: Promise.resolve(), settled: Promise.resolve(), scopeKey: workspaceAccountScopedCacheKey(frozenTarget.context) };
  this.batches.set(id, batch); this.publish();
  let registered!: () => void;
  batch.manifestReady = new Promise(resolve => { registered = resolve; });
  batch.settled = this.start(batch, registered); return { id, remaining: files.slice(20), settled: batch.settled };
 }
 private async start(batch: Batch, registered: () => void): Promise<void> {
  const request: CreateIntakeBatchRequest = { intakeBatchId: batch.view.id, destination: batch.view.target.destination, files: [...batch.view.descriptors] };
  try { this.merge(batch, await this.api.create(request, batch.view.target.context)); }
  catch (error) {
   // A lost POST response may already have committed the immutable manifest.
   try { this.merge(batch, await this.api.get(batch.view.id, batch.view.target.context)); }
   catch { batch.view = { ...batch.view, errors: Object.fromEntries(batch.view.descriptors.map(file => [file.clientFileId, message(error)])) }; this.publish(); registered(); return; }
  }
  registered();
  await Promise.all(batch.view.descriptors.map(descriptor => this.transfer(batch, descriptor.clientFileId)));
 }
 private async transfer(batch: Batch, fileId: string): Promise<void> {
  const outcome = batch.view.receipt?.files.find(file => file.clientFileId === fileId);
  if (batch.cleared.has(fileId) || outcome?.state === 'stored' || outcome?.state === 'cleared' || (outcome?.state === 'failed' && !outcome.retryable)) return;
  const file = batch.files.get(fileId); if (!file) return;
  const controller = new AbortController(); batch.controllers.set(fileId, controller);
  const errors = { ...batch.view.errors }; delete errors[fileId];
  batch.view = { ...batch.view, uploading: [...batch.view.uploading, fileId], errors }; this.publish();
  try {
   const result: IntakeFilePutResponse = await this.api.put(batch.view.id, fileId, file, batch.view.target.context, { signal: controller.signal, onProgress: (loaded, total) => { batch.view = { ...batch.view, progress: { ...batch.view.progress, [fileId]: total > 0 ? Math.min(1, loaded / total) : 0 } }; this.publish(); } });
   if (batch.view.receipt) this.merge(batch, { ...batch.view.receipt, revision: Math.max(result.revision, batch.view.receipt.revision), files: batch.view.receipt.files.map(item => item.clientFileId === fileId ? result.file : item) });
  } catch (error) {
   if (!batch.cleared.has(fileId)) {
    try { this.merge(batch, await this.api.get(batch.view.id, batch.view.target.context)); } catch { /* Preserve the last authorized receipt when transport is unavailable. */ }
    if (batch.view.receipt?.files.find(item => item.clientFileId === fileId)?.state !== 'stored') batch.view = { ...batch.view, errors: { ...batch.view.errors, [fileId]: message(error) } };
   }
  } finally {
   if (batch.controllers.get(fileId) === controller) batch.controllers.delete(fileId);
   batch.view = { ...batch.view, uploading: batch.view.uploading.filter(id => id !== fileId) }; this.publish();
  }
 }
 async retry(batchId: string, fileId: string, reselected?: File): Promise<void> {
  const batch = this.require(batchId); if (batch.cleared.has(fileId) || batch.controllers.has(fileId)) return;
  try { this.merge(batch, await this.api.get(batchId, batch.view.target.context)); }
  catch (error) {
   if (batch.view.receipt) throw error;
   this.merge(batch, await this.api.create({ intakeBatchId: batchId, destination: batch.view.target.destination, files: [...batch.view.descriptors] }, batch.view.target.context));
  }
  if (batch.view.receipt?.files.find(file => file.clientFileId === fileId)?.state === 'stored') return;
  if (reselected) {
   const expected = batch.view.descriptors.find(file => file.clientFileId === fileId);
   if (!expected || reselected.name !== expected.filename || reselected.size !== expected.size || (expected.declaredMime && reselected.type !== expected.declaredMime) || (expected.relativePath && reselected.webkitRelativePath && reselected.webkitRelativePath !== expected.relativePath)) throw new Error('Choose the original file with the same name, size and type');
   batch.files.set(fileId, reselected);
  }
  if (!batch.files.has(fileId)) throw new Error('Choose the original file again');
  await this.transfer(batch, fileId);
 }
 cancel(batchId: string, fileId: string): void { this.require(batchId).controllers.get(fileId)?.abort(new DOMException('Transfer cancelled', 'AbortError')); }
 async clear(batchId: string, fileId: string): Promise<void> {
  const batch = this.require(batchId); batch.cleared.add(fileId); batch.controllers.get(fileId)?.abort(); batch.files.delete(fileId);
  if (batch.view.receipt) this.merge(batch, batch.view.receipt);
  await batch.manifestReady;
  try { this.merge(batch, await this.api.clear(batchId, { clientFileIds: [fileId] }, batch.view.target.context)); }
  catch (error) { batch.view = { ...batch.view, errors: { ...batch.view.errors, [fileId]: message(error) } }; this.publish(); throw error; }
 }
 async attach(batchId: string, request: AttachIntakeRequest, options: { stage?: boolean } = {}): Promise<AttachIntakeResponse> {
  const batch = this.require(batchId); await batch.settled;
  const result = await this.api.attach(batchId, request, batch.view.target.context);
  if (result.attachments.length && batch.view.target.destination.kind === 'pending') {
   const attachedIds = new Set(result.attachments.map(file => file.clientFileId));
   batch.view = { ...batch.view, pendingMessageFileIds: batch.view.pendingMessageFileIds?.filter(id => !attachedIds.has(id)) };
  }
  if (result.attachments.length && options.stage !== false) batch.view = { ...batch.view, attached: result, stageSequence: (batch.view.stageSequence ?? 0) + 1 };
  if (batch.view.receipt) this.merge(batch, { ...batch.view.receipt, revision: result.revision, files: result.files });
  return result;
 }
 /** Stage saved refs for Home without uploading bytes or consuming their downloads. */
 stagePending(batchId: string, fileId: string, selected = true): void {
  const batch = this.require(batchId);
  if (batch.view.target.destination.kind !== 'pending' || !batch.view.descriptors.some(file => file.clientFileId === fileId)) return;
  const ids = new Set(batch.view.pendingMessageFileIds ?? []);
  if (selected) ids.add(fileId); else ids.delete(fileId);
  batch.view = { ...batch.view, pendingMessageFileIds: [...ids], homeSentFileIds: selected ? batch.view.homeSentFileIds?.filter(id => id !== fileId) : batch.view.homeSentFileIds }; this.publish();
 }
 /** Dismiss only the captured Home send selection; keep saved bytes and Ready siblings. */
 finishHomeSend(files: readonly { batchId: string; clientFileId: string }[]): void {
  for (const file of files) {
   const batch = this.batches.get(file.batchId);
   if (!batch || batch.view.target.destination.kind !== 'pending') continue;
   if (!batch.view.receipt?.files.some(outcome => outcome.clientFileId === file.clientFileId && outcome.hasSuccessfulAttachment)) continue;
   batch.view = { ...batch.view, homeSentFileIds: [...new Set([...(batch.view.homeSentFileIds ?? []), file.clientFileId])], pendingMessageFileIds: batch.view.pendingMessageFileIds?.filter(id => id !== file.clientFileId) };
  }
  this.publish();
 }
 messageFileIds(batchId: string): string[] {
  const batch = this.require(batchId); const selected = new Set(batch.view.pendingMessageFileIds ?? []);
  return batch.view.descriptors.filter(file => selected.has(file.clientFileId) && !batch.cleared.has(file.clientFileId) && batch.view.receipt?.files.find(outcome => outcome.clientFileId === file.clientFileId)?.state !== 'cleared').sort((a, b) => a.order - b.order).map(file => file.clientFileId);
 }
 messageBatchIds(context: WorkspaceCollabContext | null): string[] {
  const scopeKey = workspaceAccountScopedCacheKey(context);
  return this.snapshot.filter(batch => batch.scopeKey === scopeKey && batch.target.destination.kind === 'pending' && this.messageFileIds(batch.id).length > 0).map(batch => batch.id);
 }
 /** Capture the original unused selection before an attach can commit. */
 pendingFileIds(batchId: string): string[] {
  const batch = this.require(batchId);
  return batch.view.descriptors.filter(file => {
   const outcome = batch.view.receipt?.files.find(item => item.clientFileId === file.clientFileId);
   return !batch.cleared.has(file.clientFileId) && outcome?.state !== 'cleared' && !outcome?.hasSuccessfulAttachment;
  }).sort((a, b) => a.order - b.order).map(file => file.clientFileId);
 }
 /** Automatic Home handoff consumes only files without a completed server receipt. */
 async attachPending(batchId: string, request: Pick<AttachIntakeRequest, 'projectId' | 'conversationId'>, options: { stage?: boolean } = {}): Promise<AttachIntakeResponse | undefined> {
  const batch = this.require(batchId); await batch.settled;
  // A preceding response may have been lost, or another tab may have attached
  // the saved file. Refresh the authoritative completion fact before selection.
  this.merge(batch, await this.api.get(batchId, batch.view.target.context));
  const clientFileIds = batch.view.receipt?.files.filter(file => file.state !== 'cleared' && !file.hasSuccessfulAttachment).sort((a, b) => a.order - b.order).map(file => file.clientFileId) ?? [];
  if (!clientFileIds.length) return;
  return this.attach(batchId, { ...request, clientFileIds }, options);
 }
 beginHomeHandoff(projectId: string, batchIds: readonly string[]): void {
  for (const id of batchIds) { const batch = this.require(id); batch.view = { ...batch.view, homeHandoffProjectId: projectId }; }
  this.publish();
 }
 finishHomeHandoff(projectId: string): void {
  for (const batch of this.batches.values()) if (batch.view.homeHandoffProjectId === projectId) batch.view = { ...batch.view, homeHandoffProjectId: undefined };
  this.publish();
 }
 pendingIds(context: WorkspaceCollabContext | null): string[] {
  const scopeKey = workspaceAccountScopedCacheKey(context);
  return Array.from(this.batches.values()).filter(batch => batch.scopeKey === scopeKey && batch.view.target.destination.kind === 'pending' && (batch.view.receipt?.files.some(file => file.state !== 'cleared' && !file.hasSuccessfulAttachment) ?? true)).map(batch => batch.view.id);
 }
 private require(id: string): Batch { const batch = this.batches.get(id); if (!batch) throw new Error('Intake receipt is not loaded'); return batch; }
}
export const workbenchIntakeStore = new IntakeStore();
