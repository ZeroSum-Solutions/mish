import type Database from 'better-sqlite3';
import {
  parseProjectDesignContextSnapshot, parseProjectRubricSnapshot, parseWorkbenchPreferencesSnapshot,
  parsePutProjectDesignContext, parsePutProjectRubric, parsePutWorkbenchPreferences,
  serializeProjectDesignContextDraft, serializeProjectRubricDraft,
  type ProjectDesignContextDraft, type ProjectDesignContextSnapshot, type ProjectRubricSnapshot,
  type WorkbenchPreferencesSnapshot, type ResourceRef, type ApiErrorCode,
} from '@open-design/contracts';

type Db = Database.Database;
type Family = 'context' | 'rubric' | 'preferences';
type Snapshot = ProjectDesignContextSnapshot | ProjectRubricSnapshot | WorkbenchPreferencesSnapshot;
/** Fresh async lookup evidence with synchronous current DB association checks. */
export interface ProjectContextReferences {
  asset(projectId: string, assetId: string): boolean;
  resource(projectId: string, reference: ResourceRef): boolean;
  designSystem(projectId: string, reference: NonNullable<ProjectDesignContextDraft['designSystemRef']>): boolean;
}
export class ProjectContextError extends Error {
  constructor(public readonly status: number, public readonly code: ApiErrorCode, message: string, public readonly current?: Snapshot) { super(message); }
}
/** Called by the existing database migration owner, never from an HTTP request. */
export function migrateWorkbenchProjectContext(db: Db): void {
  db.transaction(() => {
    for (const family of ['context', 'rubric', 'preferences'] as const) {
      db.exec(`CREATE TABLE IF NOT EXISTS workbench_project_${family}_current (
        project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
        record_json TEXT NOT NULL CHECK(json_valid(record_json))
      );
      CREATE TABLE IF NOT EXISTS workbench_project_${family}_history (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
        record_json TEXT NOT NULL CHECK(json_valid(record_json)),
        PRIMARY KEY(project_id, revision)
      );`);
    }
  }).immediate();
}
export function assertContextProject(db: Db, projectId: string): void {
  if (!db.prepare('SELECT 1 FROM projects WHERE id=?').get(projectId)) throw new ProjectContextError(403, 'project-forbidden', 'Project scope is not authorized');
}
function row(db: Db, projectId: string, family: Family, revision?: number): { revision: number; record: unknown } | null {
  assertContextProject(db, projectId);
  if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1)) throw new ProjectContextError(400, 'VALIDATION_FAILED', 'Historical revision must be a positive safe integer');
  const found = db.prepare(`SELECT revision,record_json FROM workbench_project_${family}_${revision === undefined ? 'current' : 'history'} WHERE project_id=?${revision === undefined ? '' : ' AND revision=?'}`).get(...[projectId, ...(revision === undefined ? [] : [revision])]) as { revision: number; record_json: string } | undefined;
  if (!found && revision !== undefined) throw new ProjectContextError(404, 'NOT_FOUND', 'Project record revision not found');
  return found ? { revision: found.revision, record: JSON.parse(found.record_json) as unknown } : null;
}
export function readProjectContext(db: Db, projectId: string, revision?: number): ProjectDesignContextSnapshot {
  return db.transaction(() => {
    const current = row(db, projectId, 'context', revision);
    return parseProjectDesignContextSnapshot({ projectId, revision: current?.revision ?? 0, context: current?.record ?? null });
  })();
}
export function readProjectRubric(db: Db, projectId: string, revision?: number): ProjectRubricSnapshot {
  return db.transaction(() => {
    const current = row(db, projectId, 'rubric', revision);
    const context = readProjectContext(db, projectId);
    const parsed = current?.record as { contextRevision: number } | undefined;
    return parseProjectRubricSnapshot({ projectId, revision: current?.revision ?? 0, rubric: current?.record ?? null, linkage: parsed ? { state: parsed.contextRevision === context.revision ? 'current' : 'stale', referencedContextRevision: parsed.contextRevision, currentContextRevision: context.revision } : null });
  })();
}
export function readWorkbenchPreferences(db: Db, projectId: string, revision?: number): WorkbenchPreferencesSnapshot {
  return db.transaction(() => {
    const current = row(db, projectId, 'preferences', revision);
    const parsed = current?.record as { useProjectContext: boolean } | undefined;
    return parseWorkbenchPreferencesSnapshot({ projectId, revision: current?.revision ?? 0, preferences: current?.record ?? null, effective: { useProjectContext: parsed?.useProjectContext ?? true } });
  })();
}
function editable<T extends { schema: string; projectId: string; revision: number; updatedAt: string }>(record: T): Omit<T, 'schema' | 'projectId' | 'revision' | 'updatedAt'> {
  const { schema: _schema, projectId: _projectId, revision: _revision, updatedAt: _updatedAt, ...draft } = record;
  return draft;
}
function checkWrite<S extends Snapshot>(current: S, expectedRevision: number, canonical: string, canonicalCurrent: (snapshot: S) => string | null): S | null {
  if (expectedRevision > current.revision) throw new ProjectContextError(400, 'VALIDATION_FAILED', 'Expected revision is ahead of the current project record');
  if (canonical === canonicalCurrent(current)) return current;
  if (expectedRevision !== current.revision) throw new ProjectContextError(409, 'CONFLICT', 'Project record changed; reload or explicitly retry the saved revision', current);
  if (current.revision === Number.MAX_SAFE_INTEGER) throw new ProjectContextError(400, 'VALIDATION_FAILED', 'Project record revision cannot advance');
  return null;
}
/** Preliminary CAS avoids lookup on conflicts and accepted canonical retries.
 * The final save repeats this decision in its immediate transaction. */
export function checkProjectContextWrite(db: Db, projectId: string, input: unknown, authorize?: () => void): ProjectDesignContextSnapshot | null {
  const { expectedRevision, draft } = parsePutProjectDesignContext(input);
  return db.transaction(() => {
    authorize?.();
    return checkWrite(readProjectContext(db, projectId), expectedRevision, serializeProjectDesignContextDraft(draft), snapshot => snapshot.context ? serializeProjectDesignContextDraft(editable(snapshot.context)) : null);
  }).immediate();
}
export function checkProjectRubricWrite(db: Db, projectId: string, input: unknown, authorize?: () => void): ProjectRubricSnapshot | null {
  const { expectedRevision, draft } = parsePutProjectRubric(input);
  return db.transaction(() => {
    authorize?.();
    return checkWrite(readProjectRubric(db, projectId), expectedRevision, serializeProjectRubricDraft(draft), snapshot => snapshot.rubric ? serializeProjectRubricDraft(editable(snapshot.rubric)) : null);
  }).immediate();
}
function save<S extends Snapshot>(db: Db, projectId: string, family: Family, expectedRevision: number, canonical: string, deps: {
  read(): S; canonicalCurrent(snapshot: S): string | null; authorize?: (() => void) | undefined; validate(): void; record(revision: number, updatedAt: string): unknown;
}): S {
  return db.transaction(() => {
    deps.authorize?.();
    const current = deps.read();
    const equal = checkWrite(current, expectedRevision, canonical, deps.canonicalCurrent);
    if (equal) return equal;
    deps.validate();
    const revision = current.revision + 1;
    const json = JSON.stringify(deps.record(revision, new Date().toISOString()));
    db.prepare(`INSERT INTO workbench_project_${family}_current(project_id,revision,record_json) VALUES(?,?,?) ON CONFLICT(project_id) DO UPDATE SET revision=excluded.revision,record_json=excluded.record_json`).run(projectId, revision, json);
    db.prepare(`INSERT INTO workbench_project_${family}_history(project_id,revision,record_json) VALUES(?,?,?)`).run(projectId, revision, json);
    return deps.read();
  }).immediate();
}
const invalidReference = () => new ProjectContextError(422, 'VALIDATION_FAILED', 'Project reference is invalid or unavailable');
function validateSource(projectId: string, source: { assetId: string } | { resourceRef: ResourceRef } | null, references?: ProjectContextReferences): void {
  if (!source) return;
  try {
    const allowed = 'assetId' in source ? references?.asset(projectId, source.assetId) : references?.resource(projectId, source.resourceRef);
    if (allowed !== true) throw invalidReference();
  } catch { throw invalidReference(); }
}
export function putProjectContext(db: Db, projectId: string, input: unknown, references?: ProjectContextReferences, authorize?: () => void): ProjectDesignContextSnapshot {
  assertContextProject(db, projectId);
  const { expectedRevision, draft } = parsePutProjectDesignContext(input);
  return save(db, projectId, 'context', expectedRevision, serializeProjectDesignContextDraft(draft), {
    authorize,
    read: () => readProjectContext(db, projectId),
    canonicalCurrent: snapshot => snapshot.context ? serializeProjectDesignContextDraft(editable(snapshot.context)) : null,
    validate: () => {
      draft.factSources.forEach(fact => validateSource(projectId, fact.source, references));
      if (draft.designSystemRef) {
        try { if (references?.designSystem(projectId, draft.designSystemRef) !== true) throw invalidReference(); } catch { throw invalidReference(); }
      }
    },
    record: (revision, updatedAt) => ({ ...draft, schema: 'workbench-context/1', projectId, revision, updatedAt }),
  });
}
export function putProjectRubric(db: Db, projectId: string, input: unknown, references?: ProjectContextReferences, authorize?: () => void): ProjectRubricSnapshot {
  assertContextProject(db, projectId);
  const { expectedRevision, draft } = parsePutProjectRubric(input);
  return save(db, projectId, 'rubric', expectedRevision, serializeProjectRubricDraft(draft), {
    authorize,
    read: () => readProjectRubric(db, projectId),
    canonicalCurrent: snapshot => snapshot.rubric ? serializeProjectRubricDraft(editable(snapshot.rubric)) : null,
    validate: () => {
      let linked: ProjectDesignContextSnapshot;
      try { linked = readProjectContext(db, projectId, draft.contextRevision); } catch { throw invalidReference(); }
      const conversions = new Set(linked.context!.conversions.map(conversion => conversion.id));
      for (const check of draft.checks) {
        validateSource(projectId, check.provenance.source, references);
        if ('targets' in check.parameters && check.parameters.targets?.some(target => target.type === 'conversion' && !conversions.has(target.id))) throw invalidReference();
      }
    },
    record: (revision, updatedAt) => ({ ...draft, schema: 'workbench-rubric/1', projectId, revision, updatedAt }),
  });
}
export function putWorkbenchPreferences(db: Db, projectId: string, input: unknown, authorize?: () => void): WorkbenchPreferencesSnapshot {
  assertContextProject(db, projectId);
  const { expectedRevision, useProjectContext } = parsePutWorkbenchPreferences(input);
  return save(db, projectId, 'preferences', expectedRevision, JSON.stringify({ useProjectContext }), {
    authorize,
    read: () => readWorkbenchPreferences(db, projectId),
    canonicalCurrent: snapshot => snapshot.preferences ? JSON.stringify({ useProjectContext: snapshot.preferences.useProjectContext }) : null,
    validate: () => {},
    record: (revision, updatedAt) => ({ schema: 'workbench-preferences/1', projectId, revision, useProjectContext, updatedAt }),
  });
}
