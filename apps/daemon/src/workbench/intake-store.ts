import type Database from 'better-sqlite3';
import type { CreateIntakeBatchRequest, IntakeFileDescriptor, IntakeFileState, ApiError } from '@mish/contracts';
export type IntakeSelector = [workspaceId: string, memberId: string] | null;
export interface IntakeBatchRow { id: string; manifest_json: string; selector_json: string; revision: number; created_at: number; updated_at: number }
export interface Materialization { projectId: string; conversationId?: string; relPath: string; complete: boolean }
export interface IntakeItemRow {
  batch_id: string; client_file_id: string; descriptor_json: string; state: IntakeFileState;
  asset_id: string | null; content_hash: string | null; detected_mime: string | null; intake_kind: string | null;
  error_json: string | null; materializations_json: string;
}
export function getIntakeBatch(db: Database.Database, id: string): IntakeBatchRow | undefined {
  return db.prepare('SELECT * FROM workbench_intake_batches WHERE id = ?').get(id) as IntakeBatchRow | undefined;
}
export function getIntakeItem(db: Database.Database, batchId: string, fileId: string): IntakeItemRow | undefined {
  return db.prepare('SELECT * FROM workbench_intake_items WHERE batch_id = ? AND client_file_id = ?').get(batchId, fileId) as IntakeItemRow | undefined;
}
export function intakeItems(db: Database.Database, batchId: string): IntakeItemRow[] {
  return db.prepare('SELECT * FROM workbench_intake_items WHERE batch_id = ?').all(batchId) as IntakeItemRow[];
}
export function intakeManifest(row: IntakeBatchRow): CreateIntakeBatchRequest { return JSON.parse(row.manifest_json) as CreateIntakeBatchRequest; }
export function intakeDescriptor(row: IntakeItemRow): IntakeFileDescriptor { return JSON.parse(row.descriptor_json) as IntakeFileDescriptor; }
export function materializations(row: IntakeItemRow): Materialization[] { return JSON.parse(row.materializations_json) as Materialization[]; }
export function bumpIntake(db: Database.Database, id: string): void {
  db.prepare('UPDATE workbench_intake_batches SET revision = revision + 1, updated_at = ? WHERE id = ?').run(Date.now(), id);
}
export function setIntakeError(db: Database.Database, batchId: string, fileId: string, state: IntakeFileState, error: ApiError): void {
  db.prepare("UPDATE workbench_intake_items SET state = ?, error_json = ? WHERE batch_id = ? AND client_file_id = ? AND state != 'cleared'").run(state, JSON.stringify(error), batchId, fileId);
  bumpIntake(db, batchId);
}
