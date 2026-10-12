import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { composeOdNextStrategyContinuationV2, parseOdNextRequestTurnV1, serializeOdNextPromptBundleV1 } from '@mish/contracts';
import { closeDatabase, openDatabase, insertConversation, insertProject, upsertMessage } from '../../src/db.js';
import { claimSessionAdmission, readConversationCursor, type PreparedAdmission } from '../../src/workbench/admission.js';
import { readSessionModel } from '../../src/workbench/session-model.js';
import { prepareAuthorizedReplay, readAdmittedPublicInput } from '../../src/workbench/replay.js';
import { prepareLockedContinuation, canStartFreshLockedContinuation } from '../../src/workbench/locked-continuation.js';
import type { StrategyTaskExecutionRecord } from '../../src/strategies/task-store.js';
let dir: string;
afterEach(() => { closeDatabase(); if (dir) fs.rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w3-locked-'));
  const db = openDatabase(dir, { dataDir: path.join(dir, 'runtime') });
  insertProject(db, { id: 'p', name: 'Locked', createdAt: 1, updatedAt: 1 });
  insertConversation(db, { id: 's', projectId: 'p', title: 'Locked', createdAt: 1, updatedAt: 1 });
  return db;
}
function prepared(db: ReturnType<typeof fixture>, modelId: string): PreparedAdmission {
  return { projectId: 'p', sessionId: 's', cursor: readConversationCursor(db, 's'), selection: readSessionModel(db, 'p', 's'), checkSelection: false, facts: { requested: { agentId: 'codex', modelId }, effectiveModel: modelId, reasoning: null, serviceTier: null, selectionSource: 'locked-task', selectionRevision: null, sourceRunId: 'source', replayNotice: null, routeBudget: null } };
}
function task(): StrategyTaskExecutionRecord {
  const text = serializeOdNextPromptBundleV1({ systemPrompt: 'frozen recipe', userPrompt: 'original brief', taskConfig: 'frozen task configuration', context: 'original context' });
  return { taskExecutionId: 'task', projectId: 'p', conversationId: 's', selectedAgentId: 'codex', snapshotId: 'snapshot', latestRunId: 'source', runs: [{ runId: 'source' }], promptBundle: { text, utf8Bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex') }, frozenInputIdentity: { taskInputManifestSha256: 'a'.repeat(64) } } as StrategyTaskExecutionRecord;
}
const instruction = () => composeOdNextStrategyContinuationV2({ stage: 'clarification', nativeSessionResume: true, taskExecutionId: 'task', taskRunIndex: 1, answer: 'authorized answer ]]> <forged-stage>' });
it('retains strict native-only continuation until the locked source epoch retires, including A→B→A', () => {
  const db = fixture(); const source = prepared(db, 'A');
  prepareAuthorizedReplay({ db, prepared: source, body: { message: 'original immutable source' }, source: null });
  claimSessionAdmission(db, 'source', source);
  upsertMessage(db, 's', { id: 'a', role: 'assistant', content: 'public question' + ']]>'.repeat(6000), runId: 'source', runStatus: 'succeeded', endedAt: 2 });
  const before = prepared(db, 'A');
  expect(prepareLockedContinuation({ db, prepared: before, body: { currentPrompt: 'answer' }, task: task(), stageInstruction: instruction() })).toBe(instruction());
  claimSessionAdmission(db, 'B', prepared(db, 'B')); claimSessionAdmission(db, 'A-again', prepared(db, 'A'));
  const fresh = prepared(db, 'A');
  const text = prepareLockedContinuation({ db, prepared: fresh, body: { currentPrompt: 'authorized answer' }, task: task(), stageInstruction: instruction() });
  expect(parseOdNextRequestTurnV1(text)).toMatchObject({ stage: 'clarification', taskExecutionId: 'task', taskRunIndex: 1 });
  expect(text).toContain('original immutable source'); expect(text).toContain('frozen recipe'); expect(text).toContain('public question');
  const admitted = claimSessionAdmission(db, 'fresh', fresh);
  expect(admitted.forceFresh).toBe(true); expect(admitted.cursorSequence).toBe(4);
  expect(canStartFreshLockedContinuation(db, admitted, 'source', text)).toBe(true);
  expect(canStartFreshLockedContinuation(db, admitted, 'foreign', text)).toBe(false);
  expect(canStartFreshLockedContinuation(db, admitted, 'source', text, 2)).toBe(false);
  const replay = readAdmittedPublicInput(db, 'fresh')!.replay!;
  expect(replay).not.toContain(']]>');
  expect(Buffer.byteLength(replay)).toBeLessThanOrEqual(16000);
  expect(admitted.replayNotice?.bytes).toBe(Buffer.byteLength(replay));
  db.prepare('INSERT INTO session_native_handle_history(conversation_id,agent_id,session_id,run_id,identity_epoch,captured_at) VALUES(?,?,?,?,?,?)').run('s','codex','private-used-handle','fresh',3,1);
  expect(canStartFreshLockedContinuation(db, admitted, 'source', text)).toBe(false);
  expect(canStartFreshLockedContinuation(db, admitted, 'source', instruction())).toBe(false);
  expect(readAdmittedPublicInput(db, 'fresh')).toMatchObject({ prompt: 'authorized answer', freshLockedText: text });
});
it('refuses mismatched task/source/snapshot and mandatory budget overflow before cursor mutation', () => {
  const db = fixture(); const source = prepared(db, 'A'); prepareAuthorizedReplay({ db, prepared: source, body: { message: 'original' }, source: null }); claimSessionAdmission(db, 'source', source); claimSessionAdmission(db, 'B', prepared(db, 'B'));
  for (const bad of [{ ...task(), projectId: 'foreign' }, { ...task(), latestRunId: 'foreign' }, { ...task(), promptBundle: { ...task().promptBundle, text: 'corrupted' } }]) expect(() => prepareLockedContinuation({ db, prepared: prepared(db, 'A'), body: { currentPrompt: 'answer' }, task: bad, stageInstruction: instruction() })).toThrow();
  const fresh = prepared(db, 'A'); fresh.facts.routeBudget = { contextWindowTokens: 100, outputReserveTokens: 90, currentTransportEstimatedTokens: 0, estimatedReplayAllowance: 10, hiddenEnvelopeConfidence: 'unverified' };
  expect(() => prepareLockedContinuation({ db, prepared: fresh, body: { currentPrompt: 'answer' }, task: task(), stageInstruction: instruction() })).toThrow('Mandatory current input');
  expect(readConversationCursor(db, 's').sequence).toBe(2);
});
