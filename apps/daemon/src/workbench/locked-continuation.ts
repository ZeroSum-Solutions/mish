import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { composeOdNextFreshContinuationV1, parseOdNextRequestTurnV1, type SessionRunAdmission } from '@open-design/contracts';
import type { StrategyTaskExecutionRecord } from '../strategies/task-store.js';
import { assertOdNextSemanticRequestFactProducerCoverage } from '../runtimes/od-next-exact-input.js';
import { AdmissionError, executionIdentitiesEqual, readConversationCursor, sourceRequiresFresh, type PreparedAdmission } from './admission.js';
import { prepareAuthorizedReplay, readAdmittedPublicInput } from './replay.js';

/** Called before the immediate claim. It consumes only the validated task owner. */
export function prepareLockedContinuation(input: {
  db: Database.Database; prepared: PreparedAdmission; body: Record<string, unknown>;
  task: StrategyTaskExecutionRecord; stageInstruction: string;
  projectRoot?: string | null; projectMetadata?: unknown;
  lockedPlan?: StrategyTaskExecutionRecord['planContract'];
}): string {
  const { db, prepared, task } = input;
  const stage = parseOdNextRequestTurnV1(input.stageInstruction);
  if (task.projectId !== prepared.projectId || task.conversationId !== prepared.sessionId
    || task.selectedAgentId !== prepared.facts.requested.agentId
    || task.latestRunId !== prepared.facts.sourceRunId
    || stage.taskExecutionId !== task.taskExecutionId || stage.taskRunIndex !== task.runs.length
    || Buffer.byteLength(task.promptBundle.text) !== task.promptBundle.utf8Bytes
    || createHash('sha256').update(task.promptBundle.text).digest('hex') !== task.promptBundle.sha256) {
    throw new AdmissionError('VALIDATION_FAILED', 'Locked continuation input does not match its immutable task/source scope');
  }
  const fresh = sourceRequiresFresh(db, task.latestRunId, prepared.cursor)
    || 'kind' in prepared.facts.requested
    || Boolean(prepared.cursor.admission && !executionIdentitiesEqual(prepared.cursor.admission, prepared.facts));
  const sourceInput = readAdmittedPublicInput(db, task.latestRunId);
  if (fresh && !sourceInput) throw new AdmissionError('VALIDATION_FAILED', 'Fresh locked continuation requires the original admitted source input');
  const source = sourceInput ? { runId: task.latestRunId, input: sourceInput } : null;
  const facts = {
    locked_scope: JSON.stringify({ taskExecutionId: task.taskExecutionId, projectId: task.projectId, conversationId: task.conversationId, agentId: task.selectedAgentId, snapshotId: task.snapshotId, manifestSha256: task.frozenInputIdentity.taskInputManifestSha256, sourceRunId: task.latestRunId, stage: stage.stage, taskRunIndex: stage.taskRunIndex }),
    locked_task_snapshot: task.promptBundle.text,
    locked_plan: JSON.stringify(input.lockedPlan ?? task.planContract ?? null),
    authorized_source_input: sourceInput?.prompt ?? '',
    bounded_public_replay: '',
    locked_stage_instruction: input.stageInstruction,
  };
  assertOdNextSemanticRequestFactProducerCoverage('fresh_continuation', facts);
  const compose = (replay: string) => composeOdNextFreshContinuationV1({ lockedScope: facts.locked_scope, lockedTaskSnapshot: facts.locked_task_snapshot, lockedPlan: facts.locked_plan, authorizedSourceInput: facts.authorized_source_input, boundedPublicReplay: replay, stageInstruction: facts.locked_stage_instruction });
  const budget = prepared.facts.routeBudget;
  const replay = prepareAuthorizedReplay({ db, prepared, body: input.body, projectRoot: input.projectRoot ?? null, projectMetadata: input.projectMetadata, source, contextWindowTokens: budget?.contextWindowTokens ?? null, outputReserveTokens: budget?.outputReserveTokens ?? null, mandatoryInputText: fresh ? compose('') : input.stageInstruction });
  if (!fresh) return input.stageInstruction;
  prepared.requiresFresh = true;
  const text = compose(replay.priorTranscript);
  if (prepared.originalInput) (prepared.originalInput as ReturnType<typeof readAdmittedPublicInput> & object).freshLockedText = text;
  return text;
}

/** Missing native context is still rejected unless the admission owns this exact exception. */
export function canStartFreshLockedContinuation(db: Database.Database, admission: SessionRunAdmission | null | undefined, sourceRunId: string | undefined, exactText: string, physicalAttempt = 1): boolean {
  if (physicalAttempt !== 1 || !admission?.forceFresh || !sourceRunId || admission.sourceRunId !== sourceRunId) return false;
  if (db.prepare('SELECT 1 FROM session_native_handle_history WHERE run_id=? LIMIT 1').get(admission.runId)) return false;
  const original = readAdmittedPublicInput(db, admission.runId);
  if (!original?.freshLockedText || original.freshLockedText !== exactText) return false;
  return readConversationCursor(db, admission.sessionId).identityEpoch === (db.prepare('SELECT identity_epoch FROM session_run_admissions WHERE run_id=?').get(admission.runId) as { identity_epoch: number } | undefined)?.identity_epoch;
}
