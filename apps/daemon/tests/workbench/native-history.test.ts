import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { openDatabase, closeDatabase, getAgentSession, insertProject, insertConversation, upsertAgentSession, clearAgentSession, deleteConversation } from '../../src/db.js';
import { claimSessionAdmission, readConversationCursor, readRunAdmission, type PreparedAdmission } from '../../src/workbench/admission.js';
import { readSessionModel } from '../../src/workbench/session-model.js';
import { persistCapturedAgentSession } from '../../src/agent-session-resume.js';
import { nativeHandleBelongsToRun } from '../../src/workbench/native-history.js';
let dir: string | null = null;
afterEach(() => { vi.restoreAllMocks(); closeDatabase(); if (dir) fs.rmSync(dir, { recursive: true, force: true }); dir = null; });
function fixture() {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w3-native-'));
  const db = openDatabase(dir, { dataDir: dir }); insertProject(db, { id: 'p', name: 'Private', createdAt: 1, updatedAt: 1 }); insertConversation(db, { id: 's', projectId: 'p', title: 'Private', createdAt: 1, updatedAt: 1 }); return db;
}
function admit(db: ReturnType<typeof fixture>, runId: string, modelId: string, agentId = 'codex') {
  const input: PreparedAdmission = { projectId: 'p', sessionId: 's', cursor: readConversationCursor(db, 's'), selection: readSessionModel(db, 'p', 's'), checkSelection: false, facts: { requested: { agentId, modelId }, effectiveModel: modelId, reasoning: null, serviceTier: null, selectionSource: 'override', selectionRevision: null, sourceRunId: null, routeBudget: null, replayNotice: null } };
  return claimSessionAdmission(db, runId, input);
}
it('preserves replaced private handles with immutable run/epoch provenance and deletes with its conversation', () => {
  const db = fixture();
  const first = admit(db, 'a1', 'A'); upsertAgentSession(db, { conversationId: 's', agentId: 'codex', sessionId: 'private-A1', runId: 'a1', model: 'A' });
  admit(db, 'b', 'B'); upsertAgentSession(db, { conversationId: 's', agentId: 'codex', sessionId: 'private-B', runId: 'b', model: 'B' });
  const last = admit(db, 'a2', 'A'); upsertAgentSession(db, { conversationId: 's', agentId: 'codex', sessionId: 'private-A2', runId: 'a2', model: 'A' });
  const history = db.prepare('SELECT session_id,run_id,identity_epoch,retired_at FROM session_native_handle_history ORDER BY id').all();
  expect(history).toMatchObject([{ session_id: 'private-A1', run_id: 'a1', identity_epoch: 0 }, { session_id: 'private-B', run_id: 'b', identity_epoch: 1 }, { session_id: 'private-A2', run_id: 'a2', identity_epoch: 2, retired_at: null }]);
  expect(nativeHandleBelongsToRun(db, 'a1', 'private-A2')).toBe(false); expect(nativeHandleBelongsToRun(db, 'a2', 'private-A2')).toBe(true);
  expect(JSON.stringify([first, last, readRunAdmission(db, 'a1')])).not.toContain('private-');
  clearAgentSession(db, 's', 'codex'); expect(db.prepare('SELECT count(*) n FROM session_native_handle_history').get()).toEqual({ n: 3 });
  expect(db.prepare('SELECT count(*) n FROM session_native_handle_history WHERE retired_at IS NULL').get()).toEqual({ n: 0 });
  deleteConversation(db, 's'); expect(db.prepare('SELECT count(*) n FROM session_native_handle_history').get()).toEqual({ n: 0 });
});
it('records shared native-handle use per admitted run but does not add physical-retry duplicates', () => {
  const db = fixture(); admit(db, 'first', 'A'); upsertAgentSession(db, { conversationId: 's', agentId: 'codex', sessionId: 'same-private', runId: 'first', model: 'A' });
  admit(db, 'next', 'A'); const next = { conversationId: 's', agentId: 'codex', sessionId: 'same-private', runId: 'next', model: 'A' };
  upsertAgentSession(db, next); upsertAgentSession(db, next);
  expect(db.prepare('SELECT count(*) n FROM session_native_handle_history').get()).toEqual({ n: 2 });
  expect(nativeHandleBelongsToRun(db, 'first', 'same-private')).toBe(true); expect(nativeHandleBelongsToRun(db, 'next', 'same-private')).toBe(true);
  expect(readConversationCursor(db, 's').sequence).toBe(2);
});

it('passes admission epoch and run ownership through the AMR/pi production capture helper', () => {
  const db = fixture(); admit(db, 'initial', 'A', 'amr'); admit(db, 'captured', 'B', 'amr');
  expect(persistCapturedAgentSession(db, { conversationId: 's', agentId: 'amr', sessionId: 'private-captured', runId: 'captured', model: 'B' })).toBe('stored');
  expect(db.prepare('SELECT run_id,identity_epoch,public_identity_json FROM session_native_handle_history WHERE session_id=?').get('private-captured')).toMatchObject({ run_id: 'captured', identity_epoch: 1, public_identity_json: expect.stringContaining('"runId":"captured"') });
  expect(nativeHandleBelongsToRun(db, 'captured', 'private-captured')).toBe(true);
});

it('preserves late old-epoch capture privately without replacing the active newer handle', () => {
  const db = fixture(); admit(db, 'old', 'A'); admit(db, 'new', 'B');
  upsertAgentSession(db, { conversationId: 's', agentId: 'codex', sessionId: 'current-B', runId: 'new', model: 'B' });
  upsertAgentSession(db, { conversationId: 's', agentId: 'codex', sessionId: 'late-A', runId: 'old', model: 'A' });
  clearAgentSession(db, 's', 'codex', 'old');
  expect(getAgentSession(db, 's', 'codex')).toBe('current-B');
  expect(db.prepare('SELECT retired_at FROM session_native_handle_history WHERE session_id=?').get('late-A')).toMatchObject({ retired_at: expect.any(Number) });
});

it.each(['replace', 'clear'])('fences an older same-identity turn that tries to %s a newer native pointer', operation => {
  vi.spyOn(Date, 'now').mockReturnValue(1000);
  const db = fixture(); const first = admit(db, 'old', 'A'); const last = admit(db, 'new', 'A');
  expect(first.cursorSequence).toBe(1); expect(last.cursorSequence).toBe(2); expect(first.admittedAt).toBe(last.admittedAt);
  expect(db.prepare('SELECT DISTINCT identity_epoch FROM session_run_admissions').all()).toEqual([{ identity_epoch: 0 }]);
  upsertAgentSession(db, { conversationId: 's', agentId: 'codex', sessionId: 'current-A', runId: 'new', model: 'A', lastMessageId: 'new-message' });
  if (operation === 'replace') upsertAgentSession(db, { conversationId: 's', agentId: 'codex', sessionId: 'late-A', runId: 'old', model: 'A', lastMessageId: 'old-message' });
  else clearAgentSession(db, 's', 'codex', 'old');
  expect(getAgentSession(db, 's', 'codex')).toBe('current-A');
  expect(db.prepare('SELECT last_message_id FROM agent_sessions WHERE conversation_id=?').get('s')).toEqual({ last_message_id: 'new-message' });
  if (operation === 'replace') expect(db.prepare('SELECT retired_at FROM session_native_handle_history WHERE session_id=?').get('late-A')).toMatchObject({ retired_at: expect.any(Number) });
});
