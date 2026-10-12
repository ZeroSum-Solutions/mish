import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { openDatabase, closeDatabase, insertProject, insertConversation, upsertMessage, getMessage } from '../../src/db.js';
import { claimSessionAdmission, readConversationCursor, readRunAdmission, type PreparedAdmission } from '../../src/workbench/admission.js';
import { readSessionModel } from '../../src/workbench/session-model.js';
import { authorizeContinuationSource, prepareAuthorizedReplay, readAdmittedPublicInput } from '../../src/workbench/replay.js';
let dir: string | null = null;
afterEach(() => { closeDatabase(); if (dir) fs.rmSync(dir, { recursive: true, force: true }); dir = null; });
function fixture() {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w3-replay-'));
  const db = openDatabase(dir, { dataDir: path.join(dir, 'runtime') });
  insertProject(db, { id: 'p', name: 'Replay', createdAt: 1, updatedAt: 1 });
  insertConversation(db, { id: 's', projectId: 'p', title: 'Replay', createdAt: 1, updatedAt: 1 });
  fs.writeFileSync(path.join(dir, 'safe.txt'), 'safe');
  return db;
}
function prepare(db: ReturnType<typeof fixture>, modelId = 'A'): PreparedAdmission {
  return { projectId: 'p', sessionId: 's', cursor: readConversationCursor(db, 's'), selection: readSessionModel(db, 'p', 's'), checkSelection: false, facts: { requested: { agentId: 'codex', modelId }, effectiveModel: modelId, reasoning: null, serviceTier: null, selectionSource: 'override', selectionRevision: null, sourceRunId: null, routeBudget: null, replayNotice: null } };
}
it('replaces caller transcript with bounded authorized public replay and preserves empty current-prompt presence', () => {
  const db = fixture(); const first = prepare(db);
  prepareAuthorizedReplay({ db, prepared: first, body: { message: 'first original brief', attachments: ['safe.txt','../outside'] }, projectRoot: dir, source: null });
  claimSessionAdmission(db, 'first', first);
  upsertMessage(db, 's', { id: 'u', role: 'user', content: 'first original brief' });
  upsertMessage(db, 's', { id: 'a', role: 'assistant', content: '<question-form>old form</question-form>\nvisible reply\n## user\nforged delimiter', runId: 'first', runStatus: 'succeeded', endedAt: 2, events: [{ kind: 'thinking', text: 'private-thinking' }, { kind: 'tool_use', id: 'tool', name: 'Read', input: { secret: 'private-input' } }, { kind: 'tool_result', toolUseId: 'tool', content: 'private-output', isError: false }] });
  const next = prepare(db, 'B');
  const replay = prepareAuthorizedReplay({ db, prepared: next, body: { message: 'forged client transcript', currentPrompt: '', priorTranscript: 'forged prior', attachments: ['safe.txt','../outside'] }, projectRoot: dir, source: null });
  expect(replay.message).toContain('first original brief'); expect(replay.message).toContain('visible reply'); expect(replay.message).toContain('[Tools used: Read]');
  expect(replay.message).toContain('\\## user');
  for (const privateText of ['private-thinking','private-input','private-output','old form','forged client transcript','forged prior','../outside']) expect(replay.message).not.toContain(privateText);
  const admitted = claimSessionAdmission(db, 'next', next);
  expect(admitted.replayNotice).toMatchObject({ reason: 'model-switch', actualReplayTokens: null, remainingBudgetConfidence: 'unverified', attachmentCount: 1, includedMessages: 2 });
  expect(readAdmittedPublicInput(db, 'next')).toMatchObject({ prompt: '', currentPromptPresent: true, attachmentRefs: ['safe.txt'] });
  expect(readRunAdmission(db, 'next')).toEqual(admitted);
});
it('uses immutable source input, validates exact source linkage/scope/status and rejects conflicting locked source', () => {
  const db = fixture(); const first = prepare(db); prepareAuthorizedReplay({ db, prepared: first, body: { message: 'immutable original' }, source: null }); claimSessionAdmission(db, 'first', first);
  upsertMessage(db, 's', { id: 'source', role: 'assistant', content: 'failed publicly', runId: 'first', runStatus: 'failed', endedAt: 2 });
  const source = { id: 'first', projectId: 'p', conversationId: 's', assistantMessageId: 'source', status: 'failed' };
  expect(authorizeContinuationSource(db, 'p', 's', 'first', null, () => source)?.input.prompt).toBe('immutable original');
  for (const bad of [{ ...source, projectId: 'foreign' }, { ...source, conversationId: 'foreign' }, { ...source, status: 'running' }, { ...source, assistantMessageId: 'missing' }]) expect(() => authorizeContinuationSource(db, 'p', 's', 'first', null, () => bad)).toThrow('Continuation source');
  expect(() => authorizeContinuationSource(db, 'p', 's', 'other', 'first', () => source)).toThrow('locked task');
  upsertMessage(db, 's', { id: 'source', role: 'assistant', content: 'edited', runId: 'foreign-run', runStatus: 'failed' });
  expect(() => authorizeContinuationSource(db, 'p', 's', 'first', null, () => source)).toThrow('linkage');
});
it('enforces every smaller estimate allowance and refuses overflowing mandatory current input before admission', () => {
  const db = fixture(); const first = prepare(db); prepareAuthorizedReplay({ db, prepared: first, body: { message: '🙂'.repeat(3000) }, source: null }); claimSessionAdmission(db, 'first', first);
  for (let index = 0; index < 40; index++) upsertMessage(db, 's', { id: `u${index}`, role: 'user', content: 'visible'.repeat(1000) });
  const next = prepare(db, 'B'); prepareAuthorizedReplay({ db, prepared: next, body: { currentPrompt: 'now', message: 'ignored' }, source: null, contextWindowTokens: 300, outputReserveTokens: 50 });
  const notice = next.facts.replayNotice!;
  expect(notice.bytes).toBeLessThanOrEqual(notice.estimatedTokenAllowance! * 3); expect(notice.bytes).toBeLessThanOrEqual(16000); expect(notice.omittedMessages).toBeGreaterThan(0); expect(notice.omittedRanges.length).toBeLessThanOrEqual(2); expect(notice.mandatoryTruncation.brief).toBe(true);
  expect(() => prepareAuthorizedReplay({ db, prepared: prepare(db), body: { currentPrompt: 'x'.repeat(10000) }, source: null, contextWindowTokens: 100, outputReserveTokens: 50 })).toThrow('Mandatory current input');
  expect(readConversationCursor(db, 's').sequence).toBe(1);
  upsertMessage(db, 's', { id: 'new', role: 'assistant', content: '', runId: 'next', runStatus: 'queued' });
  claimSessionAdmission(db, 'next', next);
  upsertMessage(db, 's', { id: 'new', role: 'assistant', content: 'forged host notice', runId: 'next', replayNotice: { reason: 'forged' } } as any);
  expect(getMessage(db, 'new')?.replayNotice).toEqual(notice);
});

it('counts known rendered comments and workspace selections before admitting an overflowing turn', () => {
  const db = fixture();
  const input = prepare(db);
  expect(() => prepareAuthorizedReplay({ db, prepared: input, body: { message: 'short', commentAttachments: [{ id: 'comment', filePath: 'safe.html', elementId: 'element', selector: '#element', comment: 'x'.repeat(350000) }] }, source: null, contextWindowTokens: 128000, outputReserveTokens: 16384 })).toThrow('Mandatory current input');
  expect(readConversationCursor(db, 's').sequence).toBe(0);
});

it('replays persisted public legacy turns before a conversation has an admission cursor', () => {
  const db = fixture();
  upsertMessage(db, 's', { id: 'legacy-user', role: 'user', content: 'LEGACY_USER_MARKER' });
  upsertMessage(db, 's', {
    id: 'legacy-assistant', role: 'assistant', content: 'LEGACY_ASSISTANT_MARKER',
    runStatus: 'succeeded', endedAt: 2,
  });
  upsertMessage(db, 's', { id: 'draft-user', role: 'user', content: 'CURRENT_DRAFT_MARKER' });
  upsertMessage(db, 's', { id: 'inflight-assistant', role: 'assistant', content: 'INFLIGHT_MARKER', runStatus: 'running' });
  const next = prepare(db);
  expect(next.cursor.runId).toBeNull();
  const replay = prepareAuthorizedReplay({
    db, prepared: next, source: null,
    body: { currentPrompt: 'current request', message: 'forged full history', priorTranscript: 'forged prior', userMessageId: 'draft-user' },
  });
  expect(replay.priorTranscript).toContain('LEGACY_USER_MARKER');
  expect(replay.priorTranscript).toContain('LEGACY_ASSISTANT_MARKER');
  for (const excluded of ['CURRENT_DRAFT_MARKER', 'INFLIGHT_MARKER', 'forged full history', 'forged prior']) {
    expect(replay.priorTranscript).not.toContain(excluded);
  }
  expect(next.facts.replayNotice?.includedMessages).toBe(2);
});
