import type Database from 'better-sqlite3';
import { parsePutSessionModel, parseSessionModelSnapshot, sessionModelChoicesEqual, type SessionModelSnapshot } from '@open-design/contracts';

export class SessionModelError extends Error {
  constructor(public readonly status: number, public readonly code: 'project-forbidden' | 'SESSION_MODEL_REVISION_CONFLICT' | 'VALIDATION_FAILED', message: string, public readonly current?: SessionModelSnapshot) { super(message); }
}
/** Choice and admission state remain owned by the conversation in the daemon's SQLite. */
export function migrateSessionModels(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS session_models (
    conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL CHECK (revision >= 0),
    choice_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
}
export function assertModelSession(db: Database.Database, projectId: string, sessionId: string): void {
  if (sessionId.startsWith('comment-anchor-') || !db.prepare('SELECT 1 FROM conversations WHERE id=? AND project_id=?').get(sessionId, projectId)) {
    throw new SessionModelError(403, 'project-forbidden', 'Project scope is not authorized');
  }
}
export function readSessionModel(db: Database.Database, projectId: string, sessionId: string): SessionModelSnapshot {
  assertModelSession(db, projectId, sessionId);
  const row = db.prepare('SELECT revision, choice_json, updated_at FROM session_models WHERE conversation_id=?').get(sessionId) as { revision: number; choice_json: string; updated_at: number } | undefined;
  return parseSessionModelSnapshot({ sessionId, projectId, revision: row?.revision ?? 0, choice: row ? JSON.parse(row.choice_json) : null, updatedAt: row?.updated_at ?? 0 });
}
export function putSessionModel(db: Database.Database, projectId: string, sessionId: string, input: unknown): SessionModelSnapshot {
  assertModelSession(db, projectId, sessionId);
  const { expectedRevision, ...choice } = parsePutSessionModel(input);
  return db.transaction(() => {
    const current = readSessionModel(db, projectId, sessionId);
    if (expectedRevision > current.revision) throw new SessionModelError(400, 'VALIDATION_FAILED', 'Expected revision is ahead of the current session');
    if (sessionModelChoicesEqual(current.choice, choice)) return current;
    if (expectedRevision !== current.revision) throw new SessionModelError(409, 'SESSION_MODEL_REVISION_CONFLICT', 'Session model changed; reload the current choice before retrying', current);
    if (current.revision === Number.MAX_SAFE_INTEGER) throw new SessionModelError(400, 'VALIDATION_FAILED', 'Session revision cannot advance');
    const updatedAt = Date.now();
    db.prepare('INSERT INTO session_models (conversation_id,revision,choice_json,updated_at) VALUES (?,?,?,?) ON CONFLICT(conversation_id) DO UPDATE SET revision=excluded.revision,choice_json=excluded.choice_json,updated_at=excluded.updated_at').run(sessionId, current.revision + 1, JSON.stringify(choice), updatedAt);
    return readSessionModel(db, projectId, sessionId);
  }).immediate();
}
