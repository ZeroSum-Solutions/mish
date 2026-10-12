import Database from 'better-sqlite3';
import type { ProjectDesignContextDraft, ProjectRubricDraft } from '@open-design/contracts';
import { migrateWorkbenchProjectContext, type ProjectContextReferences } from '../../src/workbench/project-context.js';

export function contextDraft(label = 'Book appointment'): ProjectDesignContextDraft {
  return {
    purpose: null, audience: [], brandDirection: null, constraints: [], assumptions: ['Purpose, audience and brand are unknown'],
    conversions: [{ id: 'book', kind: 'booking', role: 'primary', label }],
    factSources: [['kind', 'booking'], ['role', 'primary'], ['label', label]].map(([field, value]) => ({ fieldPath: `/conversions/0/${field}`, value: value!, origin: 'user-confirmed', source: null, confidence: null, rationale: 'Project owner declaration' })),
  };
}
export function rubricDraft(contextRevision = 1, conversionId = 'book'): ProjectRubricDraft {
  return { contextRevision, checks: [{ checkId: 'cta', kind: 'mechanical', required: true, severity: 'high', requiredBasis: { type: 'mandatory', criterionId: 'core.declared-actions' }, provenance: { origin: 'user-confirmed', derivation: 'project-input', source: null, rationale: 'Project owner declaration' }, parameters: { type: 'cta', actionType: 'conversion', targets: [{ type: 'conversion', id: conversionId }], viewports: [320, 375, 768, 1440] }, evidenceTypes: ['probe'], sourceCriteria: [] }] };
}
export function database(filename = ':memory:'): Database.Database {
  const db = new Database(filename); db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,metadata_json TEXT);
    INSERT OR IGNORE INTO projects VALUES('p','{"importedFolder":true}'),('q','{}'),('readonly','{}');
    CREATE TABLE IF NOT EXISTS reference_inventory(kind TEXT,id TEXT,project_id TEXT,revision TEXT,state TEXT);
    INSERT INTO reference_inventory VALUES('asset','asset','p','v1','current'),('asset','foreign','q','v1','current'),('asset','stale','p','v1','stale'),
      ('resource','hero','p','v1','current'),('resource','foreign','q','v1','current'),('resource','stale','p','old','current'),
      ('design-system','neutral','p','v1','current'),('design-system','foreign','q','v1','current'),('design-system','stale','p','old','current');`);
  migrateWorkbenchProjectContext(db); return db;
}
/** Fixture uses local exact metadata/ownership, with no provider or guessed grants. */
export function references(db: Database.Database): ProjectContextReferences {
  const resolve = (kind: string, projectId: string, id: string, revision?: string) => !!db.prepare(`SELECT 1 FROM reference_inventory WHERE kind=? AND id=? AND project_id=? AND state='current' ${revision === undefined ? '' : 'AND revision=?'}`).get(...[kind, id, projectId, ...(revision === undefined ? [] : [revision])]);
  return { asset: (projectId, assetId) => resolve('asset', projectId, assetId), resource: (projectId, ref) => ref.sourceId === 'sections' && ref.sourceType === 'section' && resolve('resource', projectId, ref.itemId, ref.revisionOrDigest), designSystem: (projectId, ref) => resolve('design-system', projectId, ref.id, ref.revisionOrDigest) };
}
