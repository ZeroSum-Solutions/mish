import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { createChatRunService } from '../../src/runtimes/runs.js';
import { acceptedRetryKind, admittedTransientCarrier, assertSameRunRecovery, claimDaemonAdmission, claimSessionAdmission, matchedTransientCarrier, migrateSessionAdmissions, originalCallerFingerprint, publicExecutionChoice, readConversationCursor, readRunAdmission, resolveAdmissionChoice, type PreparedAdmission } from '../../src/workbench/admission.js';
import { migrateSessionModels, putSessionModel, readSessionModel } from '../../src/workbench/session-model.js';
const databases: Database.Database[] = [];
afterEach(() => { databases.splice(0).forEach(db => db.close()); vi.useRealTimers(); });
function fixture() {
  const db = new Database(':memory:'); databases.push(db); db.pragma('foreign_keys=ON');
  db.exec("CREATE TABLE conversations(id TEXT PRIMARY KEY,project_id TEXT); INSERT INTO conversations VALUES('a','p'),('b','p')");
  migrateSessionModels(db); migrateSessionAdmissions(db); return db;
}
function prepare(db: Database.Database, modelId = 'one'): PreparedAdmission {
  return { projectId: 'p', sessionId: 'a', cursor: readConversationCursor(db, 'a'), selection: readSessionModel(db, 'p', 'a'), checkSelection: false,
    facts: { requested: { agentId: 'codex', modelId }, effectiveModel: modelId, reasoning: 'high', serviceTier: null, selectionSource: 'override', selectionRevision: null, sourceRunId: null, routeBudget: null, replayNotice: null } };
}
it('CAS admits once, advances each NEW run, and rejects stale capture without changing durable state', () => {
  const db = fixture(); const stale = prepare(db);
  const one = claimSessionAdmission(db, 'one', prepare(db));
  expect(one).toMatchObject({ cursorSequence: 1, forceFresh: false });
  expect(claimSessionAdmission(db, 'one', prepare(db, 'changed'))).toEqual(one);
  expect(() => claimSessionAdmission(db, 'stale', stale)).toThrowError(expect.objectContaining({ code: 'SESSION_CURSOR_CONFLICT' }));
  expect(readRunAdmission(db, 'stale')).toBeNull();
  expect(claimSessionAdmission(db, 'two', prepare(db))).toMatchObject({ cursorSequence: 2, forceFresh: false });
  expect(readConversationCursor(db, 'b').sequence).toBe(0);
});

it('preserves a legacy secret-URL launch carrier without persisting or hashing it and forces each new admission fresh', () => {
  const db = fixture();
  const provider = { protocol: 'openai' as const, baseUrl: 'https://user:password@example.com/v1?token=private-query#private-fragment', requiresApiKey: true, apiKey: 'private-key' };
  const body = { agentId: 'byok-opencode', model: 'raw-model', message: 'original', byokProvider: provider };
  const choice = publicExecutionChoice(body.agentId, body.model, provider);
  expect(choice).toMatchObject({ kind: 'legacy-run-only', protocol: 'openai', modelId: 'raw-model' });
  const first = claimSessionAdmission(db, 'legacy-one', { ...prepare(db), facts: { ...prepare(db).facts, requested: choice, effectiveModel: 'raw-model' } });
  const nextChoice = publicExecutionChoice(body.agentId, body.model, provider);
  expect(nextChoice).not.toEqual(choice);
  expect(claimSessionAdmission(db, 'legacy-two', { ...prepare(db), facts: { ...prepare(db).facts, requested: nextChoice, effectiveModel: 'raw-model' } }).forceFresh).toBe(true);
  expect(first.forceFresh).toBe(true);
  expect(matchedTransientCarrier(choice, provider)?.baseUrl).toBe(provider.baseUrl);
  const stored = JSON.stringify(db.prepare('SELECT snapshot_json FROM session_run_admissions').all());
  for (const secret of ['password','private-query','private-fragment','private-key','example.com']) expect(stored).not.toContain(secret);
  const fingerprint = originalCallerFingerprint(body);
  const changed = originalCallerFingerprint({ ...body, byokProvider: { ...provider, baseUrl: 'https://other:secret@example.org/v1?new-secret', apiKey: 'rotated-key' } });
  expect(changed).not.toBe(fingerprint);
  expect(acceptedRetryKind(fingerprint, changed, body)).toBe('conflict');
  expect(acceptedRetryKind(fingerprint, originalCallerFingerprint(body), body)).toBe('conflict');
  expect(acceptedRetryKind(fingerprint, fingerprint, body)).toBe('conflict');
});
it('forces A→B→A fresh and forbids historical same-run recovery even when the current model returned to A', () => {
  const db = fixture(); claimSessionAdmission(db, 'a-one', prepare(db, 'A'));
  expect(claimSessionAdmission(db, 'b', prepare(db, 'B')).forceFresh).toBe(true);
  expect(claimSessionAdmission(db, 'a-two', prepare(db, 'A')).forceFresh).toBe(true);
  expect(() => assertSameRunRecovery(db, 'a-one')).toThrowError(expect.objectContaining({ code: 'SESSION_RECOVERY_REQUIRES_NEW_TURN' }));
  expect(assertSameRunRecovery(db, 'a-two')?.requested.modelId).toBe('A');
  expect(readRunAdmission(db, 'a-one')?.cursorSequence).toBe(1);
  db.prepare("DELETE FROM conversations WHERE id='a'").run();
  expect(db.prepare('SELECT count(*) n FROM session_run_admissions').get()).toEqual({ n: 0 });
});
it('captures pinned/session choices and detects selection changes at the immediate claim', () => {
  const db = fixture(); const choice = { agentId: 'codex', modelId: 'one' };
  putSessionModel(db, 'p', 'a', { ...choice, expectedRevision: 0 });
  const resolved = resolveAdmissionChoice(db, { projectId: 'p', conversationId: 'a', ...{ agentId: choice.agentId, model: choice.modelId }, expectedModelRevision: 1 }, choice);
  const input = { ...prepare(db), selection: resolved.selection!, checkSelection: true };
  putSessionModel(db, 'p', 'a', { ...choice, modelId: 'two', expectedRevision: 1 });
  expect(() => claimSessionAdmission(db, 'refused', input)).toThrowError(expect.objectContaining({ code: 'SESSION_MODEL_REVISION_CONFLICT' }));
  expect(readConversationCursor(db, 'a').sequence).toBe(0);
  expect(resolveAdmissionChoice(db, { projectId: 'p', conversationId: 'a' }, choice).choice.modelId).toBe('two');
  expect(resolveAdmissionChoice(db, { projectId: 'p', conversationId: 'a', agentId: 'codex' }, choice).source).toBe('override');
});
it('fingerprints original intent, not rewritten replay/defaults or credentials; endpoint identity never aliases legacy BYOK', () => {
  const binding = { protocol: 'openai', baseUrl: 'https://gateway.example/v1', requiresApiKey: true };
  const input = { agentId: 'byok-opencode', model: 'raw', expectedModelRevision: 1, byokBinding: binding, byokProvider: { ...binding, apiKey: 'key-one' }, message: 'original', reasoning: 'high' };
  const fp = originalCallerFingerprint(input);
  expect(originalCallerFingerprint({ ...input, byokProvider: { ...binding, baseUrl: 'https://changed-carrier.example', apiKey: 'key-two' } })).toBe(fp);
  expect(originalCallerFingerprint({ ...input, reasoning: 'low' })).not.toBe(fp);
  expect(originalCallerFingerprint({ ...input, expectedModelRevision: 2 })).not.toBe(fp);
  expect(originalCallerFingerprint({ ...input, byokBinding: { ...binding, baseUrl: 'https://other.example' } })).not.toBe(fp);
  expect(originalCallerFingerprint({ message: 'x', currentPrompt: '' })).not.toBe(originalCallerFingerprint({ message: 'x' }));
  expect(acceptedRetryKind('old-unversioned-hash', fp, input)).toBe('conflict');
  expect(acceptedRetryKind('old-unversioned-hash', fp, { agentId: 'codex' })).toBe('legacy-v1');
  expect(acceptedRetryKind(fp, fp, input)).toBe('equal');
});
it('matches transient carrier against the complete canonical binding and overrides its stale model', () => {
  const byokBinding = { protocol: 'openai' as const, baseUrl: 'https://example.com/v1', requiresApiKey: true };
  const choice = { agentId: 'byok-opencode', modelId: 'accepted-model', byokBinding };
  expect(matchedTransientCarrier(choice, { ...byokBinding, baseUrl: 'https://EXAMPLE.com:443/v1/', apiKey: 'private-key', model: 'wrong-model' })).toMatchObject({ baseUrl: byokBinding.baseUrl, model: 'accepted-model' });
  for (const carrier of [null, { ...byokBinding, apiKey: '' }, { ...byokBinding, baseUrl: 'https://foreign.example/v1', apiKey: 'key' }]) {
    expect(() => matchedTransientCarrier(choice, carrier)).toThrowError(expect.objectContaining({ code: 'SESSION_BYOK_CARRIER_REQUIRED' }));
  }
});

it('recovers legacy BYOK only with its original process-local carrier and refuses unavailable recovery', () => {
  const db = fixture();
  const carrier = { protocol: 'openai' as const, baseUrl: 'https://user:secret@example.com/v1?token=original', apiKey: 'original-key', requiresApiKey: true };
  const requested = publicExecutionChoice('byok-opencode', 'raw', carrier);
  const input = prepare(db);
  const original = claimSessionAdmission(db, 'original-carrier', { ...input, transientCarrier: carrier, facts: { ...input.facts, requested, effectiveModel: 'raw' } });
  expect(admittedTransientCarrier(original, { ...carrier, baseUrl: 'https://new.example', apiKey: 'new-key' })).toEqual({ ...carrier, model: 'raw' });
  const unavailable = claimSessionAdmission(db, 'unavailable-carrier', { ...prepare(db), facts: { ...input.facts, requested: publicExecutionChoice('byok-opencode', 'raw', carrier), effectiveModel: 'raw' } });
  expect(() => admittedTransientCarrier(unavailable, carrier)).toThrowError(expect.objectContaining({ code: 'SESSION_BYOK_CARRIER_REQUIRED' }));
});

it.each(['succeeded', 'failed', 'canceled', 'dropped'])('releases only the finalized legacy carrier on %s', async status => {
  vi.useFakeTimers();
  const db = fixture();
  const runs = createChatRunService({ createSseResponse: () => ({ send() {}, end() {}, cleanup() {} }), createSseErrorPayload: (code: string, message: string) => ({ error: { code, message } }), ttlMs: 60000 });
  const carrier = { protocol: 'openai' as const, baseUrl: 'https://user:secret@example.com/v1?token=original', apiKey: 'original-key', requiresApiKey: true };
  const admit = () => {
    const run = runs.create({ projectId: 'p', conversationId: 'a', agentId: 'byok-opencode' });
    const input = prepare(db);
    const admission = claimSessionAdmission(db, run.id, { ...input, transientCarrier: carrier, facts: { ...input.facts, requested: publicExecutionChoice('byok-opencode', 'raw', carrier), effectiveModel: 'raw' } });
    return { run, admission };
  };
  const first = admit(), sibling = admit();
  expect(admittedTransientCarrier(first.admission, undefined)?.apiKey).toBe('original-key');
  if (status === 'canceled') await runs.cancel(first.run);
  else if (status === 'dropped') runs.drop(first.run);
  else if (status === 'failed') runs.fail(first.run, 'SYNTHETIC_START_FAILURE', 'Synthetic failure');
  else runs.finish(first.run, 'succeeded', 0, null);
  expect(() => admittedTransientCarrier(first.admission, carrier)).toThrowError(expect.objectContaining({ code: 'SESSION_BYOK_CARRIER_REQUIRED' }));
  expect(admittedTransientCarrier(sibling.admission, undefined)?.apiKey).toBe('original-key');
  expect(readRunAdmission(db, first.run.id)).toEqual(first.admission);
  runs.drop(sibling.run); vi.clearAllTimers();
});

it('resolves implicit choice from the captured snapshot and rejects an intervening picker change', () => {
  const db = fixture(); putSessionModel(db, 'p', 'a', { agentId: 'codex', modelId: 'default', expectedRevision: 0 });
  const captured = readSessionModel(db, 'p', 'a');
  putSessionModel(db, 'p', 'a', { agentId: 'claude', modelId: 'default', expectedRevision: 1 });
  const resolved = resolveAdmissionChoice(db, { projectId: 'p', conversationId: 'a' }, captured.choice!, undefined, captured);
  expect(resolved.choice.agentId).toBe('codex');
  expect(() => claimSessionAdmission(db, 'mixed-refused', { ...prepare(db), selection: resolved.selection!, checkSelection: true, facts: { ...prepare(db).facts, requested: resolved.choice } })).toThrowError(expect.objectContaining({ code: 'SESSION_MODEL_REVISION_CONFLICT' }));
  expect(readConversationCursor(db, 'a').sequence).toBe(0);
});

it('inherits a complete saved choice with revision-only CAS and refuses stale or partial pinned pairs', () => {
  const db = fixture(); const choice = { agentId: 'codex', modelId: 'one' };
  putSessionModel(db, 'p', 'a', { ...choice, expectedRevision: 0 });
  expect(resolveAdmissionChoice(db, { projectId: 'p', conversationId: 'a', expectedModelRevision: 1 }, { agentId: 'claude', modelId: 'different-default' })).toMatchObject({ choice, source: 'session', checkSelection: true });
  for (const fields of [{ expectedModelRevision: 0 }, { expectedModelRevision: Number.MAX_SAFE_INTEGER + 1 }, { expectedModelRevision: 1, agentId: 'codex' }]) expect(() => resolveAdmissionChoice(db, { projectId: 'p', conversationId: 'a', ...fields }, choice)).toThrow();
});

it('refuses an unprepared daemon creator rather than deriving mutable facts inside the claim', () => {
  const db = fixture();
  expect(() => claimDaemonAdmission(db, { id: 'unprepared' }, { projectId: 'p', conversationId: 'a', agentId: 'codex', model: 'default' })).toThrow('preparation before the claim');
  expect(readConversationCursor(db, 'a').sequence).toBe(0);
});
