import type Database from 'better-sqlite3';
import {
  LICENCE_RECORD_SOURCES, licenceOperationStatuses, licenceScopeViolations, materializeLicenceDraft, parseLicenceRecord,
  parseLicenceRecordSnapshot, parsePutLicenceRecord, unreadableLicenceStatuses,
  type ApiErrorCode, type LicenceRecord, type LicenceRecordSnapshot, type LicenceScopeViolation, type LicenceWriteSurface,
} from '@open-design/contracts';

type Db = Database.Database;
type SourceId = (typeof LICENCE_RECORD_SOURCES)[number];

/**
 * R16 held-licence record (Oct6 owner decision, Q3 option B). The owner enters the
 * licence holder and held terms once in Settings; this record, not a workspace header,
 * project, token or registry credential, names the licence-holding principal. Operation
 * scope comes only from cited held-terms clauses; without terms evidence the record
 * still stands and only the operations stay pending. A recorded restriction carries
 * forward and cannot be lifted under the same terms; lifting it under new terms needs an
 * explicit re-assessment. Revisions are immutable history and record their write surface.
 */
export class LicenceRecordError extends Error {
  constructor(public readonly status: number, public readonly code: ApiErrorCode, message: string, public readonly details?: Record<string, unknown>) { super(message); }
}

/** Called by the existing database migration owner, never from an HTTP request. */
export function migrateWorkbenchLicenceRecords(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS workbench_licence_record_current (
    source_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
    record_json TEXT NOT NULL CHECK(json_valid(record_json))
  );
  CREATE TABLE IF NOT EXISTS workbench_licence_record_history (
    source_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
    record_json TEXT NOT NULL CHECK(json_valid(record_json)),
    PRIMARY KEY(source_id, revision)
  );`);
}

function sourceId(value: string): SourceId {
  if (!(LICENCE_RECORD_SOURCES as readonly string[]).includes(value)) throw new LicenceRecordError(404, 'NOT_FOUND', 'No licence record exists for this source');
  return value as SourceId;
}
function snapshot(source: SourceId, record: LicenceRecord | null): LicenceRecordSnapshot {
  return parseLicenceRecordSnapshot({
    schema: 'licence-record-snapshot/1', sourceId: source, revision: record?.revision ?? 0, recordState: record ? 'current' : 'none',
    licenceExistence: 'owner-confirmed', record, operations: licenceOperationStatuses(record),
  });
}
/** A stored revision that no longer parses degrades the read; it never grants anything. */
function unreadable(source: SourceId, revision: number): LicenceRecordSnapshot {
  return parseLicenceRecordSnapshot({
    schema: 'licence-record-snapshot/1', sourceId: source, revision, recordState: 'unreadable',
    licenceExistence: 'owner-confirmed', record: null, operations: unreadableLicenceStatuses(),
  });
}
function parseStored(json: string): LicenceRecord | null {
  try { return parseLicenceRecord(JSON.parse(json)); } catch { return null; }
}
export function readLicenceRecord(db: Db, source: string, revision?: number): LicenceRecordSnapshot {
  const id = sourceId(source);
  if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1)) throw new LicenceRecordError(400, 'VALIDATION_FAILED', 'Historical revision must be a positive safe integer');
  const row = (revision === undefined
    ? db.prepare('SELECT revision, record_json FROM workbench_licence_record_current WHERE source_id=?').get(id)
    : db.prepare('SELECT revision, record_json FROM workbench_licence_record_history WHERE source_id=? AND revision=?').get(id, revision)) as { revision: number; record_json: string } | undefined;
  if (!row && revision !== undefined) throw new LicenceRecordError(404, 'NOT_FOUND', 'Licence record revision not found');
  if (!row) return snapshot(id, null);
  const record = parseStored(row.record_json);
  return record && record.revision === row.revision && record.sourceId === id ? snapshot(id, record) : unreadable(id, row.revision);
}
function readHistory(db: Db, id: SourceId): { records: LicenceRecord[]; unreadable: boolean } {
  const rows = db.prepare('SELECT revision, record_json FROM workbench_licence_record_history WHERE source_id=? ORDER BY revision').all(id) as { revision: number; record_json: string }[];
  const records = rows.map(row => parseStored(row.record_json)).filter((record): record is LicenceRecord => record !== null);
  return { records, unreadable: records.length !== rows.length };
}
const comparable = (value: Pick<LicenceRecord, 'holder' | 'termsVersion' | 'termsEvidence' | 'operationScope'>) =>
  JSON.stringify([value.holder, value.termsVersion, value.termsEvidence, [...value.operationScope].sort((a, b) => a.operation.localeCompare(b.operation))]);
const REFUSALS: Record<LicenceScopeViolation['reason'], string> = {
  'licence-history-unreadable': 'An earlier licence revision cannot be read, so no allowance can be checked against it; record restrictions only, or repair the history',
  'licence-restriction-override': 'These terms recorded a restriction on this operation; it cannot be lifted under the same terms',
  'licence-terms-digest-conflict': 'A different terms digest needs a different terms version',
  'licence-reassessment-required': 'Lifting a prior restriction, or allowing on a newly added clause, needs an explicit re-assessment mark',
  'licence-scope-widening': 'An allowance must cite a clause from the recorded held terms',
};
const PRECEDENCE: LicenceScopeViolation['reason'][] = ['licence-history-unreadable', 'licence-restriction-override', 'licence-terms-digest-conflict', 'licence-reassessment-required', 'licence-scope-widening'];

export interface PutLicenceOptions {
  /** A label from request metadata (Settings fetch metadata, the od client header or neither). */
  surface?: LicenceWriteSurface;
  now?: () => Date;
}
export function putLicenceRecord(db: Db, source: string, input: unknown, options: PutLicenceOptions = {}): LicenceRecordSnapshot {
  const id = sourceId(source);
  let parsed: ReturnType<typeof parsePutLicenceRecord>;
  try { parsed = parsePutLicenceRecord(input); } catch {
    throw new LicenceRecordError(400, 'VALIDATION_FAILED', 'Pass an expected revision and a licence draft with no keys, tokens or extra fields');
  }
  return db.transaction(() => {
    const current = readLicenceRecord(db, id);
    const history = readHistory(db, id);
    const materialized = materializeLicenceDraft(parsed.draft, history.records);
    if (current.record && comparable(current.record) === comparable({ ...parsed.draft, ...materialized })) return current;
    if (parsed.expectedRevision !== current.revision) throw new LicenceRecordError(409, 'CONFLICT', 'The licence record changed; review the current record', { current });
    const violations: LicenceScopeViolation[] = [
      ...(history.unreadable ? parsed.draft.operationScope.filter(item => item.decision === 'allowed').map(item => ({ reason: 'licence-history-unreadable' as const, operation: item.operation })) : []),
      ...licenceScopeViolations(parsed.draft, history.records),
    ];
    const reason = PRECEDENCE.find(candidate => violations.some(item => item.reason === candidate));
    if (reason) {
      const operations = [...new Set(violations.filter(item => item.reason === reason && item.operation !== null).map(item => item.operation!))];
      throw new LicenceRecordError(422, 'VALIDATION_FAILED', REFUSALS[reason], { reason, operations });
    }
    const revision = current.revision + 1;
    const record = parseLicenceRecord({
      ...parsed.draft, ...materialized, schema: 'licence-record/1', sourceId: id, revision,
      recordedBy: { role: 'source-curator', basis: 'specific-grant', surface: options.surface ?? 'http' }, recordedAt: (options.now ?? (() => new Date()))().toISOString(),
    });
    const json = JSON.stringify(record);
    db.prepare('INSERT INTO workbench_licence_record_current(source_id,revision,record_json) VALUES(?,?,?) ON CONFLICT(source_id) DO UPDATE SET revision=excluded.revision,record_json=excluded.record_json').run(id, revision, json);
    db.prepare('INSERT INTO workbench_licence_record_history(source_id,revision,record_json) VALUES(?,?,?)').run(id, revision, json);
    return snapshot(id, record);
  }).immediate();
}

export function readAllLicenceRecords(db: Db): LicenceRecordSnapshot[] {
  return LICENCE_RECORD_SOURCES.map(source => readLicenceRecord(db, source));
}
