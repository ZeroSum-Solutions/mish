import type Database from 'better-sqlite3';

/** Private diagnostic provenance. Public DTOs never project these handles. */
export function migrateNativeHandleHistory(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS session_native_handle_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL, session_id TEXT NOT NULL,
    run_id TEXT, identity_epoch INTEGER NOT NULL,
    public_identity_json TEXT, model TEXT, cwd TEXT,
    captured_at INTEGER NOT NULL, retired_at INTEGER
  ); CREATE INDEX IF NOT EXISTS session_native_handle_history_scope ON session_native_handle_history(conversation_id,agent_id,id)`);
}
interface HandleInput { conversationId: string; agentId: string; sessionId: string; runId?: string; model?: string | null; cwd?: string | null }
interface ActiveHandle { id: number; run_id?: string | null; session_id: string; identity_epoch: number; model: string | null; cwd: string | null }
function preserveLegacyPointer(db: Database.Database, conversationId: string, agentId: string): ActiveHandle | undefined {
  let active = db.prepare('SELECT id,run_id,session_id,identity_epoch,model,cwd FROM session_native_handle_history WHERE conversation_id=? AND agent_id=? AND retired_at IS NULL ORDER BY id DESC LIMIT 1').get(conversationId, agentId) as ActiveHandle | undefined;
  if (!active) {
    const legacy = db.prepare('SELECT session_id,model,cwd,updated_at FROM agent_sessions WHERE conversation_id=? AND agent_id=?').get(conversationId, agentId) as { session_id: string; model: string | null; cwd: string | null; updated_at: number } | undefined;
    if (legacy) {
      const result = db.prepare('INSERT INTO session_native_handle_history(conversation_id,agent_id,session_id,identity_epoch,model,cwd,captured_at) VALUES(?,?,?,0,?,?,?)').run(conversationId, agentId, legacy.session_id, legacy.model, legacy.cwd, legacy.updated_at);
      active = { id: Number(result.lastInsertRowid), session_id: legacy.session_id, identity_epoch: 0, model: legacy.model, cwd: legacy.cwd };
    }
  }
  return active;
}
/** Must run inside the same transaction as replacing the active pointer. */
export function recordNativeHandleReplacement(db: Database.Database, input: HandleInput): boolean {
  const active = preserveLegacyPointer(db, input.conversationId, input.agentId);
  const admission = input.runId ? db.prepare("SELECT identity_epoch,snapshot_json,json_extract(snapshot_json,'$.cursorSequence') AS cursor_sequence FROM session_run_admissions WHERE run_id=? AND conversation_id=?").get(input.runId, input.conversationId) as { identity_epoch: number; snapshot_json: string; cursor_sequence: number } | undefined : undefined;
  const identityEpoch = admission?.identity_epoch ?? 0;
  const cursor = db.prepare('SELECT identity_epoch,sequence FROM session_admission_cursors WHERE conversation_id=?').get(input.conversationId) as { identity_epoch: number; sequence: number } | undefined;
  if (admission && cursor && (identityEpoch !== cursor.identity_epoch || admission.cursor_sequence !== cursor.sequence)) {
    // A late completion keeps provenance but cannot overwrite the current
    // turn's active native pointer after a newer admitted turn, even when its
    // model identity is unchanged. Persisted cursorSequence owns turn order.
    db.prepare('INSERT INTO session_native_handle_history(conversation_id,agent_id,session_id,run_id,identity_epoch,public_identity_json,model,cwd,captured_at,retired_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(input.conversationId, input.agentId, input.sessionId, input.runId!, identityEpoch, admission.snapshot_json, input.model ?? null, input.cwd ?? null, Date.now(), Date.now());
    return false;
  }
  if (active && active.session_id === input.sessionId && active.identity_epoch === identityEpoch && active.model === (input.model ?? null) && active.cwd === (input.cwd ?? null) && (input.runId === undefined || active.run_id === input.runId)) return true;
  const now = Date.now();
  if (active) db.prepare('UPDATE session_native_handle_history SET retired_at=? WHERE id=?').run(now, active.id);
  // Snapshot contains only strict public admission fields. Credential material
  // belongs to the transient runtime carrier and cannot enter this history.
  db.prepare('INSERT INTO session_native_handle_history(conversation_id,agent_id,session_id,run_id,identity_epoch,public_identity_json,model,cwd,captured_at) VALUES(?,?,?,?,?,?,?,?,?)').run(input.conversationId, input.agentId, input.sessionId, input.runId ?? null, identityEpoch, admission?.snapshot_json ?? null, input.model ?? null, input.cwd ?? null, now);
  return true;
}
export function retireNativeHandle(db: Database.Database, conversationId: string, agentId: string): void {
  const active = preserveLegacyPointer(db, conversationId, agentId);
  if (active) db.prepare('UPDATE session_native_handle_history SET retired_at=? WHERE id=?').run(Date.now(), active.id);
}

export function nativeHandleBelongsToRun(db: Database.Database, runId: string, sessionId: string): boolean {
  return Boolean(db.prepare('SELECT 1 FROM session_native_handle_history WHERE run_id=? AND session_id=? LIMIT 1').get(runId, sessionId));
}

/** Legacy name retained; clearing also requires current admitted turn ownership. */
export function isCurrentNativeEpoch(db: Database.Database, runId: string, conversationId: string): boolean {
  const row = db.prepare("SELECT a.identity_epoch admitted,c.identity_epoch current,json_extract(a.snapshot_json,'$.cursorSequence') admitted_sequence,c.sequence current_sequence FROM session_run_admissions a JOIN session_admission_cursors c ON c.conversation_id=a.conversation_id WHERE a.run_id=? AND a.conversation_id=?").get(runId, conversationId) as { admitted: number; current: number; admitted_sequence: number; current_sequence: number } | undefined;
  return !row || (row.admitted === row.current && row.admitted_sequence === row.current_sequence);
}
