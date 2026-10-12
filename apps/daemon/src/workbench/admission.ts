import type Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { parsePutSessionModel, parseSessionByokBinding, parseSessionExecutionChoice, parseSessionRunAdmission, sessionByokBindingsEqual, sessionModelChoicesEqual, type ByokChatProviderConfig, type SessionExecutionChoice, type SessionModelSnapshot, type SessionRunAdmission } from '@open-design/contracts';
import { assertModelSession, readSessionModel } from './session-model.js';
import { buildOpenCodeByokProviderConfig } from '../runtimes/byok-opencode.js';

export class AdmissionError extends Error {
  constructor(public readonly code: 'SESSION_CURSOR_CONFLICT' | 'SESSION_RECOVERY_REQUIRES_NEW_TURN' | 'SESSION_BYOK_CARRIER_REQUIRED' | 'SESSION_MODEL_REVISION_CONFLICT' | 'VALIDATION_FAILED', message: string, public readonly current?: SessionModelSnapshot) { super(message); }
}
const excludedCallerFields = new Set(['clientRequestId','requestFingerprint','resume','analyticsHints','userMessageId','assistantMessageId','projectMetadata','workspaceScope','odNextTaskInputSnapshot','modelAdmission','replayNotice','rechargeResumeCapability','apiKey','byokProvider','byokProfileId','_preparedSessionAdmission','_inheritedSessionAdmission']);
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
/** Capture before default resolution or plugin/replay rewriting. Never hashes a key. */
export function originalCallerFingerprint(input: Record<string, unknown>): string {
  const caller = Object.fromEntries(Object.entries(input).filter(([key]) => !excludedCallerFields.has(key)));
  if (caller.byokBinding !== undefined) caller.byokBinding = parseSessionByokBinding(caller.byokBinding);
  // Legacy run-only BYOK still needs endpoint identity; the carrier's key/model
  // are transient and never identify an execution or an upstream principal.
  if (caller.byokBinding === undefined && input.agentId === 'byok-opencode' && input.byokProvider && typeof input.byokProvider === 'object') {
    const carrier = input.byokProvider as Record<string, unknown>;
    const publicCarrier = { protocol: carrier.protocol, baseUrl: carrier.baseUrl ?? '', requiresApiKey: carrier.requiresApiKey !== false, ...(carrier.apiVersion === undefined ? {} : { apiVersion: carrier.apiVersion }) };
    try { caller.byokPublicCarrier = parseSessionByokBinding(publicCarrier); }
    catch {
      // Secret-bearing URL equivalence cannot be certified without retaining or
      // hashing secrets. Each unsafe legacy caller gets an opaque identity, and
      // accepted-key retries must use a fresh authorized turn instead.
      caller.legacyByokCarrier = { kind: 'legacy-run-only', protocol: carrier.protocol, retryNonce: randomUUID() };
    }
  }
  return `caller-v2:${createHash('sha256').update(JSON.stringify(canonical(caller))).digest('hex')}`;
}
export function acceptedRetryKind(existingFingerprint: string | null | undefined, fingerprint: string, input: Record<string, unknown>): 'equal' | 'conflict' | 'legacy-v1' {
  if (input.agentId === 'byok-opencode' && input.byokBinding === undefined && input.byokProvider && typeof input.byokProvider === 'object') {
    const carrier = input.byokProvider as Record<string, unknown>;
    try { parseSessionByokBinding({ protocol: carrier.protocol, baseUrl: carrier.baseUrl ?? '', requiresApiKey: carrier.requiresApiKey !== false, ...(carrier.apiVersion === undefined ? {} : { apiVersion: carrier.apiVersion }) }); }
    catch { return 'conflict'; } // Includes already-persisted protocol-only v2 hashes.
  }
  if (existingFingerprint?.startsWith('caller-v2:')) return existingFingerprint === fingerprint ? 'equal' : 'conflict';
  // Old fingerprints excluded the entire carrier and cannot certify endpoint
  // equality. Refuse that alias; native v1 uses the existing comparison seam.
  return input.byokBinding !== undefined || input.byokProvider !== undefined || input.agentId === 'byok-opencode' ? 'conflict' : 'legacy-v1';
}
export interface ConversationCursor { sequence: number; identityEpoch: number; runId: string | null; admission: SessionRunAdmission | null }
export interface PreparedAdmission {
  projectId: string; sessionId: string; cursor: ConversationCursor;
  selection: SessionModelSnapshot; checkSelection: boolean;
  originalInput?: { prompt: string; currentPromptPresent: boolean; attachmentRefs: string[] };
  /** A locked source belongs to a retired epoch, even if A has since returned. */
  requiresFresh?: boolean;
  /** Process-local launch material. Never serialized into admission/input state. */
  transientCarrier?: ByokChatProviderConfig;
  facts: Omit<SessionRunAdmission, 'version' | 'runId' | 'sessionId' | 'projectId' | 'cursorSequence' | 'previousRunId' | 'admittedAt' | 'forceFresh'>;
}
const legacyRunCarriers = new Map<string, ByokChatProviderConfig>();
/** Terminal and dropped runs no longer need process-local launch credentials. */
export function releaseLegacyRunCarrier(runId: string): void { legacyRunCarriers.delete(runId); }
export function admittedTransientCarrier(admission: SessionRunAdmission, supplied: unknown): ByokChatProviderConfig | undefined {
  if (!('kind' in admission.requested)) return matchedTransientCarrier(admission.requested, supplied);
  const original = legacyRunCarriers.get(admission.runId);
  if (!original) throw new AdmissionError('SESSION_BYOK_CARRIER_REQUIRED', 'The original legacy provider carrier is unavailable; submit a new authorized turn');
  return { ...original, model: admission.requested.modelId };
}
export function migrateSessionAdmissions(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS session_run_admissions (
    run_id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    identity_epoch INTEGER NOT NULL,
    input_json TEXT,
    snapshot_json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS session_admission_cursors (
    conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
    sequence INTEGER NOT NULL,
    identity_epoch INTEGER NOT NULL,
    run_id TEXT NOT NULL REFERENCES session_run_admissions(run_id)
  )`);
  if (!(db.prepare('PRAGMA table_info(session_run_admissions)').all() as { name: string }[]).some(column => column.name === 'input_json')) db.exec('ALTER TABLE session_run_admissions ADD COLUMN input_json TEXT');
}
export function readRunAdmission(db: Database.Database, runId: string): SessionRunAdmission | null {
  const row = db.prepare('SELECT snapshot_json FROM session_run_admissions WHERE run_id=?').get(runId) as { snapshot_json: string } | undefined;
  return row ? parseSessionRunAdmission(JSON.parse(row.snapshot_json)) : null;
}
export function readConversationCursor(db: Database.Database, sessionId: string): ConversationCursor {
  const row = db.prepare('SELECT sequence,identity_epoch,run_id FROM session_admission_cursors WHERE conversation_id=?').get(sessionId) as { sequence: number; identity_epoch: number; run_id: string } | undefined;
  return { sequence: row?.sequence ?? 0, identityEpoch: row?.identity_epoch ?? 0, runId: row?.run_id ?? null, admission: row ? readRunAdmission(db, row.run_id) : null };
}
export function sourceRequiresFresh(db: Database.Database, sourceRunId: string, cursor: ConversationCursor): boolean {
  const row = db.prepare('SELECT identity_epoch FROM session_run_admissions WHERE run_id=?').get(sourceRunId) as { identity_epoch: number } | undefined;
  return Boolean(row && row.identity_epoch !== cursor.identityEpoch);
}
export function resolveAdmissionChoice(db: Database.Database, input: Record<string, unknown>, fallback: SessionExecutionChoice, locked?: SessionExecutionChoice, capturedSelection?: SessionModelSnapshot | null): { choice: SessionExecutionChoice; source: SessionRunAdmission['selectionSource']; selection: SessionModelSnapshot | null; checkSelection: boolean } {
  const projectId = typeof input.projectId === 'string' ? input.projectId : null;
  const sessionId = typeof input.conversationId === 'string' ? input.conversationId : null;
  const selection = capturedSelection === undefined ? (projectId && sessionId ? readSessionModel(db, projectId, sessionId) : null) : capturedSelection;
  let pinned: ReturnType<typeof parsePutSessionModel> | null = null;
  if (input.expectedModelRevision !== undefined) {
    if (!selection) throw new AdmissionError('VALIDATION_FAILED', 'Pinned model requests require a project conversation');
    try {
      const inheritSaved = input.agentId === undefined && input.model === undefined && input.byokBinding === undefined;
      pinned = parsePutSessionModel(inheritSaved
        ? { ...selection.choice, expectedRevision: input.expectedModelRevision }
        : { agentId: input.agentId, modelId: input.model, expectedRevision: input.expectedModelRevision, ...(input.byokBinding === undefined ? {} : { byokBinding: input.byokBinding }) });
    }
    catch { throw new AdmissionError('VALIDATION_FAILED', 'Pinned requests require a complete public choice and safe revision'); }
  }
  if (locked) return { choice: parseSessionExecutionChoice(locked), source: 'locked-task', selection, checkSelection: false };
  if (pinned) {
    const { expectedRevision, ...choice } = pinned;
    if (selection!.revision !== expectedRevision || !sessionModelChoicesEqual(selection!.choice, choice)) throw new AdmissionError('SESSION_MODEL_REVISION_CONFLICT', 'Session model changed; preserve the input and reload its choice', selection!);
    return { choice, source: 'session', selection, checkSelection: true };
  }
  const hasAgent = typeof input.agentId === 'string' && Boolean(input.agentId);
  const hasModel = typeof input.model === 'string' && Boolean(input.model);
  if (!hasAgent && !hasModel && selection?.choice) return { choice: selection.choice, source: 'session', selection, checkSelection: true };
  // Legacy partial pair uses the route's existing agent/model resolution.
  return { choice: parseSessionExecutionChoice(fallback), source: hasAgent || hasModel ? 'override' : 'default', selection, checkSelection: !hasAgent && !hasModel };
}
export function publicExecutionChoice(agentId: string, modelId: string, carrier: unknown): SessionExecutionChoice {
  if (agentId !== 'byok-opencode') return parseSessionExecutionChoice({ agentId, modelId });
  const provider = carrier as ByokChatProviderConfig | null;
  if (!buildOpenCodeByokProviderConfig(provider, modelId)) throw new AdmissionError('SESSION_BYOK_CARRIER_REQUIRED', 'Resupply complete transient provider configuration for this run');
  try { return parseSessionExecutionChoice({ agentId, modelId, byokBinding: parseSessionByokBinding({ protocol: provider!.protocol, baseUrl: provider!.baseUrl ?? '', requiresApiKey: provider!.requiresApiKey !== false, ...(provider!.apiVersion === undefined ? {} : { apiVersion: provider!.apiVersion }) }) }); }
  catch { return parseSessionExecutionChoice({ kind: 'legacy-run-only', agentId, modelId, protocol: provider!.protocol, nonce: randomUUID() }); }
}
export function matchedTransientCarrier(choice: SessionExecutionChoice, input: unknown): ByokChatProviderConfig | undefined {
  if (choice.agentId !== 'byok-opencode') return undefined;
  const carrier = input && typeof input === 'object' && !Array.isArray(input) ? input as ByokChatProviderConfig : null;
  try {
    if (!carrier) throw new Error();
    if ('kind' in choice) {
      if (carrier.protocol !== choice.protocol || !buildOpenCodeByokProviderConfig(carrier, choice.modelId)) throw new Error();
      return { ...carrier, model: choice.modelId };
    }
    const binding = parseSessionByokBinding({ protocol: carrier.protocol, baseUrl: carrier.baseUrl ?? '', requiresApiKey: carrier.requiresApiKey !== false, ...(carrier.apiVersion === undefined ? {} : { apiVersion: carrier.apiVersion }) });
    if (!sessionByokBindingsEqual(binding, choice.byokBinding)) throw new Error();
    const accepted = { ...binding, apiKey: carrier.apiKey, model: choice.modelId };
    if (!buildOpenCodeByokProviderConfig(accepted, choice.modelId)) throw new Error();
    return accepted;
  } catch { throw new AdmissionError('SESSION_BYOK_CARRIER_REQUIRED', 'Resupply a complete transient provider carrier matching the saved public binding'); }
}
export function executionIdentitiesEqual(a: Pick<SessionRunAdmission, 'requested' | 'effectiveModel'>, b: Pick<SessionRunAdmission, 'requested' | 'effectiveModel'>): boolean {
  if ('kind' in a.requested || 'kind' in b.requested) return false;
  return a.requested.agentId === b.requested.agentId && a.effectiveModel === b.effectiveModel && sessionByokBindingsEqual(a.requested.byokBinding, b.requested.byokBinding);
}
/** Called inside the existing immediate assistant claim, after external preparation. */
export function claimSessionAdmission(db: Database.Database, runId: string, prepared: PreparedAdmission): SessionRunAdmission {
  let created = false;
  const admitted = db.transaction(() => {
    assertModelSession(db, prepared.projectId, prepared.sessionId);
    const existing = readRunAdmission(db, runId);
    if (existing) return existing; // Physical reuse cannot advance a logical cursor.
    const cursor = readConversationCursor(db, prepared.sessionId);
    if (cursor.sequence !== prepared.cursor.sequence || cursor.runId !== prepared.cursor.runId) throw new AdmissionError('SESSION_CURSOR_CONFLICT', 'Another turn was admitted; preserve the input and submit again');
    if (prepared.checkSelection) {
      const current = readSessionModel(db, prepared.projectId, prepared.sessionId);
      if (current.revision !== prepared.selection.revision || !sessionModelChoicesEqual(current.choice, prepared.selection.choice)) throw new AdmissionError('SESSION_MODEL_REVISION_CONFLICT', 'Session model changed during preparation', current);
    }
    const forceFresh = prepared.requiresFresh === true || 'kind' in prepared.facts.requested || (cursor.admission !== null && !executionIdentitiesEqual(cursor.admission, prepared.facts));
    const identityEpoch = cursor.identityEpoch + (forceFresh ? 1 : 0);
    const snapshot = parseSessionRunAdmission({ ...prepared.facts, version: 1, runId, sessionId: prepared.sessionId, projectId: prepared.projectId, cursorSequence: cursor.sequence + 1, previousRunId: cursor.runId, admittedAt: Date.now(), forceFresh });
    db.prepare('INSERT INTO session_run_admissions(run_id,conversation_id,identity_epoch,input_json,snapshot_json) VALUES(?,?,?,?,?)').run(runId, prepared.sessionId, identityEpoch, prepared.originalInput ? JSON.stringify(prepared.originalInput) : null, JSON.stringify(snapshot));
    db.prepare('INSERT INTO session_admission_cursors(conversation_id,sequence,identity_epoch,run_id) VALUES(?,?,?,?) ON CONFLICT(conversation_id) DO UPDATE SET sequence=excluded.sequence,identity_epoch=excluded.identity_epoch,run_id=excluded.run_id').run(prepared.sessionId, snapshot.cursorSequence, identityEpoch, runId);
    created = true;
    return snapshot;
  }).immediate();
  if (created && 'kind' in admitted.requested && prepared.transientCarrier) legacyRunCarriers.set(runId, { ...prepared.transientCarrier });
  return admitted;
}
export function assertSameRunRecovery(db: Database.Database, runId: string): SessionRunAdmission | null {
  const admission = readRunAdmission(db, runId); if (!admission) return null;
  const row = db.prepare('SELECT identity_epoch FROM session_run_admissions WHERE run_id=?').get(runId) as { identity_epoch: number };
  if (row.identity_epoch !== readConversationCursor(db, admission.sessionId).identityEpoch) throw new AdmissionError('SESSION_RECOVERY_REQUIRES_NEW_TURN', 'An intervening model switch requires a new authorized continuation turn');
  return admission;
}

/** Only daemon-owned creators may pass these prepared/inherited values. */
export function claimDaemonAdmission(db: Database.Database, run: { id: string; modelAdmission?: SessionRunAdmission | null }, meta: Record<string, unknown>): void {
  if (typeof meta.projectId !== 'string' || typeof meta.conversationId !== 'string') return;
  const prepared = meta._preparedSessionAdmission as PreparedAdmission | undefined;
  if (!prepared) throw new AdmissionError('VALIDATION_FAILED', 'Conversation runs require model and replay preparation before the claim');
  if (prepared.projectId !== meta.projectId || prepared.sessionId !== meta.conversationId) throw new AdmissionError('VALIDATION_FAILED', 'Prepared admission must match the run project conversation');
  run.modelAdmission = claimSessionAdmission(db, run.id, prepared);
}
