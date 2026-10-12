import { parseRunDesignBriefBinding, parseSessionModelChoice, type RunDesignBriefBinding, type SessionModelChoice, type RunContextSelection, type AttachIntakeResponse, type SessionModelSnapshot } from '@open-design/contracts';
import type { ChatAttachment } from '../../types';
import { intakeAttachmentKind } from '../intake/intake-attachment-kind';
export interface HomeModelHandoff {
  projectId: string;
  sessionId: string;
  choice: SessionModelChoice | null;
  modelRevision: number;
  modelSaveFailed: boolean;
  prompt: string;
  context?: RunContextSelection | null;
  designBrief?: RunDesignBriefBinding;
  autoSend: boolean;
  workingDirReady: boolean;
  targetWorkingDir?: string;
  batchIds: string[];
  completedBatchIds: string[];
  /** Original selection, frozen before attach so a lost ACK cannot erase refs. */
  batchFileIds?: Record<string, string[]>;
  attachments: ChatAttachment[];
  ready: boolean;
}
export const HOME_MODEL_HANDOFF_CHANGED = 'od:home-model-handoff-changed';
function key(projectId: string, scopeKey: string): string { return `od:home-model-handoff:${scopeKey}:${projectId}`; }
export function readHomeModelHandoff(projectId: string, scopeKey: string, storage?: Pick<Storage, 'getItem'>): HomeModelHandoff | null {
  try {
    const raw = (storage ?? window.sessionStorage).getItem(key(projectId, scopeKey)); if (!raw) return null;
    const record = JSON.parse(raw) as HomeModelHandoff;
    if (record.projectId !== projectId || !record.sessionId || !Number.isSafeInteger(record.modelRevision) || record.modelRevision < 0 || !Array.isArray(record.batchIds) || !Array.isArray(record.completedBatchIds) || !Array.isArray(record.attachments)) return null;
    return { ...record, choice: record.choice ? parseSessionModelChoice(record.choice) : null, ...(record.designBrief ? { designBrief: parseRunDesignBriefBinding(record.designBrief) } : {}) };
  } catch { return null; }
}
export function writeHomeModelHandoff(record: HomeModelHandoff, scopeKey: string, storage?: Pick<Storage, 'setItem'>): void {
  const choice = record.choice ? parseSessionModelChoice(record.choice) : null;
  (storage ?? window.sessionStorage).setItem(key(record.projectId, scopeKey), JSON.stringify({ ...record, choice, ...(record.designBrief ? { designBrief: parseRunDesignBriefBinding(record.designBrief) } : {}) }));
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(HOME_MODEL_HANDOFF_CHANGED));
}
export function clearHomeModelHandoff(projectId: string, scopeKey: string): void {
  try { window.sessionStorage.removeItem(key(projectId, scopeKey)); window.dispatchEvent(new Event(HOME_MODEL_HANDOFF_CHANGED)); } catch { /* An admitted run remains server-owned. */ }
}
/** Save the actual seed conversation's complete model before attaching saved refs. */
export async function materializeHomeModelHandoff(record: HomeModelHandoff, deps: {
  saveModel(): Promise<SessionModelSnapshot>;
  pendingFileIds?(batchId: string): readonly string[];
  attach(batchId: string, clientFileIds: string[]): Promise<AttachIntakeResponse | undefined>;
  persist(record: HomeModelHandoff): void;
}): Promise<HomeModelHandoff> {
  if (!record.workingDirReady) throw new Error('home-working-dir-not-ready');
  const snapshot = await deps.saveModel();
  if (snapshot.sessionId !== record.sessionId || snapshot.projectId !== record.projectId || !snapshot.choice) throw new Error('session-model-scope-mismatch');
  let next = { ...record, choice: snapshot.choice, modelRevision: snapshot.revision, modelSaveFailed: false };
  deps.persist(next);
  for (const batchId of record.batchIds) {
    if (next.completedBatchIds.includes(batchId)) continue;
    const clientFileIds = next.batchFileIds?.[batchId] ?? deps.pendingFileIds?.(batchId);
    // Legacy handoffs without a selection cannot reconstruct already-used
    // files from GET booleans. Retain pending input instead of guessing.
    if (!clientFileIds?.length) throw new Error('home-attachment-incomplete');
    next = { ...next, batchFileIds: { ...next.batchFileIds, [batchId]: [...clientFileIds] } };
    deps.persist(next);
    const result = await deps.attach(batchId, [...clientFileIds]);
    if (result && (result.intakeBatchId !== batchId || result.attachments.some(file => file.projectId !== record.projectId || file.conversationId !== record.sessionId || !clientFileIds.includes(file.clientFileId)))) throw new Error('home-attachment-scope-mismatch');
    const attached = result?.attachments.map((file, index) => ({
      path: file.relPath, name: file.filename, size: file.size,
      kind: intakeAttachmentKind(file.clientFileId, result.files), order: next.attachments.length + index,
    })) ?? [];
    const incomplete = !result || clientFileIds.some(id => !result.attachments.some(file => file.clientFileId === id && file.relPath)
      && !result.files.some(file => file.clientFileId === id && file.state === 'cleared'));
    next = { ...next, attachments: [...next.attachments, ...attached.filter(file => !next.attachments.some(existing => existing.path === file.path))], completedBatchIds: incomplete ? next.completedBatchIds : [...next.completedBatchIds, batchId] };
    deps.persist(next);
    if (incomplete) throw new Error('home-attachment-incomplete');
  }
  next = { ...next, ready: true }; deps.persist(next); return next;
}

/** A lost model-save response keeps the actual created identity reviewable. */
export async function saveCreatedHomeModelHandoff(record: HomeModelHandoff, scopeKey: string, put: (input: SessionModelChoice & { expectedRevision: number }) => Promise<SessionModelSnapshot>, assertCurrent: () => void = () => {}): Promise<HomeModelHandoff> {
  const persist = (next: HomeModelHandoff) => { assertCurrent(); try { writeHomeModelHandoff(next, scopeKey); } catch { /* Existing server pendingPrompt is the manual recovery path. */ } };
  persist(record);
  if (!record.choice) return record;
  try {
    assertCurrent();
    const snapshot = await put({ ...record.choice, expectedRevision: record.modelRevision });
    assertCurrent();
    if (snapshot.projectId !== record.projectId || snapshot.sessionId !== record.sessionId) throw new Error('session-model-scope-mismatch');
    const saved = { ...record, modelRevision: snapshot.revision, choice: snapshot.choice, ready: true };
    persist(saved); return saved;
  } catch {
    assertCurrent();
    const failed = { ...record, modelSaveFailed: true };
    persist(failed); return failed;
  }
}

/** Only the retained seed input may consume its admission handoff. */
export function homeModelHandoffOwnsInput(record: HomeModelHandoff | null, sessionId: string, prompt: string, attachments: readonly ChatAttachment[], context?: RunContextSelection | null): boolean {
  return Boolean(record?.ready && record.sessionId === sessionId && record.prompt.trim() === prompt.trim()
    && JSON.stringify(record.attachments.map(file => file.path)) === JSON.stringify(attachments.map(file => file.path))
    && JSON.stringify(record.context ?? null) === JSON.stringify(context ?? null));
}
