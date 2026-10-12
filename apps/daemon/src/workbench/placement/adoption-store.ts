import type Database from 'better-sqlite3';
import { parsePreparedAdoptionPlan, type PreparedAdoptionPlan } from '@open-design/contracts';
import type { StoredBlob } from './adoption-files.js';

/** Owned versioned migration (`placement-adoption`): stored plans and apply/undo lineage. */
export function migratePlacementAdoption(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS placement_adoption_plans (
      id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, project_id TEXT NOT NULL, digest TEXT NOT NULL,
      record_json TEXT NOT NULL CHECK(json_valid(record_json))
    );
    CREATE TABLE IF NOT EXISTS placement_adoption_operations (
      operation_id TEXT PRIMARY KEY, plan_id TEXT NOT NULL REFERENCES placement_adoption_plans(id),
      kind TEXT NOT NULL CHECK(kind IN ('apply','undo')), undo_of TEXT UNIQUE REFERENCES placement_adoption_operations(operation_id)
    );
  `);
}
export const PLACEMENT_ADOPTION_TABLES = ['placement_adoption_plans', 'placement_adoption_operations'] as const;

/** Server-side record kept beside the plan: the retained preimage blob for each replaced path. */
export interface StoredAdoptionPlan {
  plan: PreparedAdoptionPlan; preimages: Record<string, StoredBlob>;
  /** Further dependency paths (beyond the root manifest and lockfiles) the dependencyDigest binds. */
  dependencyPaths?: string[];
}
export interface AdoptionOperationLink { operationId: string; planId: string; kind: 'apply' | 'undo'; undoOf: string | null }

/** Trusted injected SQLite only. Records are declarations the executor re-verifies; they grant nothing. */
export class AdoptionStore {
  constructor(private readonly db: Database.Database) {}
  savePlan(principalId: string, stored: StoredAdoptionPlan): void {
    this.db.prepare('INSERT INTO placement_adoption_plans VALUES (?,?,?,?,?)')
      .run(stored.plan.id, principalId, stored.plan.projectId, stored.plan.digest, JSON.stringify(stored));
  }
  readPlan(planId: string): StoredAdoptionPlan | null {
    const row = this.db.prepare('SELECT digest, record_json FROM placement_adoption_plans WHERE id=?').get(planId) as { digest: string; record_json: string } | undefined;
    if (!row) return null;
    const record = JSON.parse(row.record_json) as StoredAdoptionPlan;
    const plan = parsePreparedAdoptionPlan(record.plan);
    if (plan.id !== planId || plan.digest !== row.digest) throw new Error('Stored adoption plan is inconsistent');
    return { plan, preimages: record.preimages, ...(Array.isArray(record.dependencyPaths) && record.dependencyPaths.length ? { dependencyPaths: record.dependencyPaths } : {}) };
  }
  link(link: AdoptionOperationLink): void {
    this.db.prepare('INSERT OR IGNORE INTO placement_adoption_operations VALUES (?,?,?,?)').run(link.operationId, link.planId, link.kind, link.undoOf);
  }
  readLink(operationId: string): AdoptionOperationLink | null {
    const row = this.db.prepare('SELECT operation_id, plan_id, kind, undo_of FROM placement_adoption_operations WHERE operation_id=?').get(operationId) as { operation_id: string; plan_id: string; kind: 'apply' | 'undo'; undo_of: string | null } | undefined;
    return row ? { operationId: row.operation_id, planId: row.plan_id, kind: row.kind, undoOf: row.undo_of } : null;
  }
  undoOf(applyOperationId: string): string | null {
    const row = this.db.prepare('SELECT operation_id FROM placement_adoption_operations WHERE undo_of=?').get(applyOperationId) as { operation_id: string } | undefined;
    return row?.operation_id ?? null;
  }
}
