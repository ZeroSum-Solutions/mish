import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { deleteProject } from '../../src/db.js';
import { migrateWorkbenchProjectContext, putProjectContext, readProjectContext, putProjectRubric, readProjectRubric, putWorkbenchPreferences, readWorkbenchPreferences } from '../../src/workbench/project-context.js';
import { contextDraft, rubricDraft, database, references } from './project-context-fixture.js';
const databases: Database.Database[] = [];
const folders: string[] = [];
afterEach(() => { databases.splice(0).forEach(db => { if (db.open) db.close(); }); folders.splice(0).forEach(folder => rmSync(folder, { recursive: true, force: true })); vi.useRealTimers(); });
const fixture = () => { const db = database(); databases.push(db); return db; };
it('creates six durable current/history tables idempotently with separate absent snapshots', () => {
  const db = fixture(); migrateWorkbenchProjectContext(db);
  expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'workbench_project_%'").all()).toHaveLength(6);
  expect(readProjectContext(db, 'p')).toEqual({ projectId: 'p', revision: 0, context: null });
  expect(readProjectRubric(db, 'p')).toEqual({ projectId: 'p', revision: 0, rubric: null, linkage: null });
  expect(readWorkbenchPreferences(db, 'p')).toEqual({ projectId: 'p', revision: 0, preferences: null, effective: { useProjectContext: true } });
});
it('converges normalized current and stale equal context retries while preserving timestamps and history', () => {
  const db = fixture(); vi.useFakeTimers(); vi.setSystemTime('2026-10-03T16:00:00Z');
  const first = putProjectContext(db, 'p', { expectedRevision: 0, draft: contextDraft() });
  expect(first.context?.updatedAt).toBe('2026-10-03T16:00:00.000Z'); expect(first.revision).toBe(1);
  vi.setSystemTime('2026-10-03T16:01:00Z');
  const normalized = contextDraft('  Book appointment  ');
  expect(putProjectContext(db, 'p', { expectedRevision: 1, draft: normalized })).toEqual(first);
  expect(putProjectContext(db, 'p', { expectedRevision: 0, draft: normalized })).toEqual(first);
  expect(() => putProjectContext(db, 'p', { expectedRevision: 0, draft: contextDraft('Call office') })).toThrowError(expect.objectContaining({ status: 409, code: 'CONFLICT', current: first }));
  expect(() => putProjectContext(db, 'p', { expectedRevision: 2, draft: normalized })).toThrowError(expect.objectContaining({ status: 400 }));
  expect(db.prepare('SELECT count(*) n FROM workbench_project_context_history').get()).toEqual({ n: 1 });
  const next = putProjectContext(db, 'p', { expectedRevision: 1, draft: contextDraft('Call office') });
  expect(next.revision).toBe(2); expect(readProjectContext(db, 'p', 1)).toEqual(first);
  // Equality is with the CURRENT draft, never an older matching history entry.
  expect(() => putProjectContext(db, 'p', { expectedRevision: 1, draft: contextDraft() })).toThrowError(expect.objectContaining({ status: 409, current: next }));
});
it('keeps preference CAS independent, including explicit default-on creation and stale equal retries', () => {
  const db = fixture();
  const context = putProjectContext(db, 'p', { expectedRevision: 0, draft: contextDraft() });
  const on = putWorkbenchPreferences(db, 'p', { expectedRevision: 0, useProjectContext: true });
  expect(on.revision).toBe(1); expect(on.preferences?.useProjectContext).toBe(true);
  expect(putWorkbenchPreferences(db, 'p', { expectedRevision: 0, useProjectContext: true })).toEqual(on);
  const off = putWorkbenchPreferences(db, 'p', { expectedRevision: 1, useProjectContext: false });
  expect(readProjectContext(db, 'p')).toEqual(context); expect(off.revision).toBe(2);
  // Both editors read before either saves; each family's revision fences its own write.
  const changed = putProjectContext(db, 'p', { expectedRevision: context.revision, draft: contextDraft('New context') });
  expect(changed.revision).toBe(2); expect(readWorkbenchPreferences(db, 'p')).toEqual(off);
  expect(readWorkbenchPreferences(db, 'p', 1)).toEqual(on);
  expect(() => putWorkbenchPreferences(db, 'p', { expectedRevision: 0, useProjectContext: true })).toThrowError(expect.objectContaining({ status: 409, current: off }));
  expect(() => putWorkbenchPreferences(db, 'p', { expectedRevision: 3, useProjectContext: false })).toThrowError(expect.objectContaining({ status: 400 }));
});
it('links a rubric to immutable same-project context and derives historical stale state without revising it', () => {
  const db = fixture(); putProjectContext(db, 'q', { expectedRevision: 0, draft: contextDraft() });
  expect(() => putProjectRubric(db, 'p', { expectedRevision: 0, draft: rubricDraft() })).toThrowError(expect.objectContaining({ status: 422, code: 'VALIDATION_FAILED' }));
  putProjectContext(db, 'p', { expectedRevision: 0, draft: contextDraft() });
  const first = putProjectRubric(db, 'p', { expectedRevision: 0, draft: rubricDraft() });
  expect(first.linkage).toEqual({ state: 'current', referencedContextRevision: 1, currentContextRevision: 1 });
  const immutableBytes = db.prepare('SELECT record_json FROM workbench_project_rubric_history WHERE project_id=? AND revision=1').get('p');
  putProjectContext(db, 'p', { expectedRevision: 1, draft: contextDraft('New brief') });
  const stale = readProjectRubric(db, 'p', 1); expect(stale.rubric).toEqual(first.rubric);
  expect(db.prepare('SELECT record_json FROM workbench_project_rubric_history WHERE project_id=? AND revision=1').get('p')).toEqual(immutableBytes);
  expect(stale.linkage).toEqual({ state: 'stale', referencedContextRevision: 1, currentContextRevision: 2 });
  expect(putProjectRubric(db, 'p', { expectedRevision: 0, draft: rubricDraft() })).toEqual(stale);
  const oldLink = putProjectRubric(db, 'p', { expectedRevision: 1, draft: { ...rubricDraft(), checks: [] } });
  expect(oldLink.linkage?.state).toBe('stale'); expect(readProjectRubric(db, 'p', 1).rubric).toEqual(first.rubric);
  expect(() => putProjectRubric(db, 'p', { expectedRevision: 2, draft: rubricDraft(1, 'missing') })).toThrowError(expect.objectContaining({ status: 422 }));
});
it('rejects invalid or missing historical revisions and missing project scope without exposing records', () => {
  const db = fixture();
  for (const read of [readProjectContext, readProjectRubric, readWorkbenchPreferences]) {
    for (const revision of [0, -1, 1.1, Number.MAX_SAFE_INTEGER + 1]) expect(() => read(db, 'p', revision)).toThrowError(expect.objectContaining({ status: 400 }));
    expect(() => read(db, 'p', 1)).toThrowError(expect.objectContaining({ status: 404 }));
    expect(() => read(db, 'missing', 1)).toThrowError(expect.objectContaining({ status: 403 }));
  }
});
it('rolls back current/history writes together when the history insertion fails', () => {
  const db = fixture(); const first = putProjectContext(db, 'p', { expectedRevision: 0, draft: contextDraft() });
  db.exec("CREATE TRIGGER fail_context_history BEFORE INSERT ON workbench_project_context_history WHEN NEW.revision=2 BEGIN SELECT RAISE(ABORT,'fixture failure'); END;");
  expect(() => putProjectContext(db, 'p', { expectedRevision: 1, draft: contextDraft('Changed') })).toThrow();
  expect(readProjectContext(db, 'p')).toEqual(first); expect(() => readProjectContext(db, 'p', 2)).toThrowError(expect.objectContaining({ status: 404 }));
});
it('reopens independent records and cascades deletion through the existing imported-folder project delete', () => {
  const folder = mkdtempSync(path.join(tmpdir(), 'workbench-context-')); folders.push(folder);
  const filename = path.join(folder, 'fixture.sqlite'); const db = database(filename); databases.push(db);
  const context = putProjectContext(db, 'p', { expectedRevision: 0, draft: contextDraft() });
  const rubric = putProjectRubric(db, 'p', { expectedRevision: 0, draft: rubricDraft() });
  const preference = putWorkbenchPreferences(db, 'p', { expectedRevision: 0, useProjectContext: false });
  expect([context.revision, rubric.revision, preference.revision]).toEqual([1, 1, 1]);
  db.close(); const reopened = database(filename); databases.push(reopened);
  expect(readProjectContext(reopened, 'p')).toEqual(context); expect(readProjectRubric(reopened, 'p')).toEqual(rubric); expect(readWorkbenchPreferences(reopened, 'p')).toEqual(preference);
  deleteProject(reopened, 'p');
  for (const row of reopened.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'workbench_project_%'").all() as { name: string }[]) expect(reopened.prepare(`SELECT count(*) n FROM ${row.name}`).get()).toEqual({ n: 0 });
});
it('requires exact authorized reference resolution and persists nothing on a safe refusal', () => {
  const db = fixture(); const resolver = references(db);
  for (const id of ['missing', 'foreign', 'stale']) {
    const draft = contextDraft(); draft.factSources[0]!.source = { assetId: id };
    expect(() => putProjectContext(db, 'p', { expectedRevision: 0, draft }, resolver)).toThrowError(expect.objectContaining({ status: 422, message: 'Project reference is invalid or unavailable' }));
  }
  const good = contextDraft(); good.factSources[0]!.source = { assetId: 'asset' };
  expect(() => putProjectContext(db, 'p', { expectedRevision: 0, draft: good })).toThrowError(expect.objectContaining({ status: 422 }));
  expect(readProjectContext(db, 'p').revision).toBe(0);
  expect(putProjectContext(db, 'p', { expectedRevision: 0, draft: good }, resolver).revision).toBe(1);
});
