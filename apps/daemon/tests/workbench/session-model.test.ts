import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { migrateSessionModels, readSessionModel, putSessionModel } from '../../src/workbench/session-model.js';

const databases: Database.Database[] = [];
afterEach(() => databases.splice(0).forEach(db => db.close()));
function fixture() {
  const db = new Database(':memory:'); databases.push(db); db.pragma('foreign_keys = ON');
  db.exec('CREATE TABLE conversations (id TEXT PRIMARY KEY, project_id TEXT); INSERT INTO conversations VALUES (\'a\',\'p\'), (\'b\',\'p\')');
  migrateSessionModels(db); return db;
}
it('persists complete independent choices and converges stale equal retries without another revision', () => {
  const db = fixture();
  expect(readSessionModel(db, 'p', 'a')).toMatchObject({ revision: 0, choice: null, updatedAt: 0 });
  const first = putSessionModel(db, 'p', 'a', { agentId: 'claude', modelId: 'default', expectedRevision: 0 });
  expect(first.revision).toBe(1);
  expect(putSessionModel(db, 'p', 'a', { agentId: 'claude', modelId: 'default', expectedRevision: 0 })).toEqual(first);
  expect(readSessionModel(db, 'p', 'b').choice).toBeNull();
  expect(() => putSessionModel(db, 'p', 'a', { agentId: 'codex', modelId: 'default', expectedRevision: 0 })).toThrowError(expect.objectContaining({ code: 'SESSION_MODEL_REVISION_CONFLICT', current: first }));
  expect(() => putSessionModel(db, 'p', 'a', { agentId: 'claude', modelId: 'default', expectedRevision: 2 })).toThrowError(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
  expect(readSessionModel(db, 'p', 'a')).toEqual(first);
  db.prepare('DELETE FROM conversations WHERE id=?').run('a');
  expect(db.prepare('SELECT count(*) n FROM session_models').get()).toEqual({ n: 0 });
});
it('compares endpoint identity and clears BYOK binding on native replacement', () => {
  const db = fixture();
  const binding = { protocol: 'openai' as const, baseUrl: 'https://EXAMPLE.com:443/v1/', requiresApiKey: true };
  const first = putSessionModel(db, 'p', 'a', { agentId: 'byok-opencode', modelId: 'raw-model', byokBinding: binding, expectedRevision: 0 });
  expect(first.choice?.byokBinding?.baseUrl).toBe('https://example.com/v1');
  expect(putSessionModel(db, 'p', 'a', { ...first.choice!, expectedRevision: 0 })).toEqual(first);
  const second = putSessionModel(db, 'p', 'a', { ...first.choice!, byokBinding: { ...binding, baseUrl: 'https://example.com/different/v1' }, expectedRevision: 1 });
  expect(second.revision).toBe(2);
  const native = putSessionModel(db, 'p', 'a', { agentId: 'codex', modelId: 'default', expectedRevision: 2 });
  expect(native.choice).toEqual({ agentId: 'codex', modelId: 'default' });
});
it('strictly rejects forged secrets, malformed revisions and foreign or comment-anchor sessions', () => {
  const db = fixture();
  expect(() => putSessionModel(db, 'p', 'a', { agentId: 'claude', modelId: 'default', expectedRevision: 0, apiKey: 'secret' })).toThrow();
  expect(() => putSessionModel(db, 'p', 'a', { agentId: 'claude', modelId: 'default', expectedRevision: -1 })).toThrow();
  for (const [project, session] of [['foreign', 'a'], ['p', 'missing'], ['p', 'comment-anchor-p']]) {
    expect(() => readSessionModel(db, project!, session!)).toThrowError(expect.objectContaining({ code: 'project-forbidden' }));
  }
});
