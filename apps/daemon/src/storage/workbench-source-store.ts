import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { isAbsolute, normalize } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parseStoredSourceRecord, sourceRecordAdmissionId, type StoredSourceRecord, type AdmissionRecord, type AssessmentRecord, type TermsRecord, type EvidenceRecord } from '../workbench/source-records.js';

export class SourceStoreError extends Error {
  constructor(public readonly code: 'data-root-mismatch' | 'revision-conflict' | 'immutable-conflict' | 'binding-conflict' | 'record-missing' | 'record-corrupt') { super(code); }
}
function requireRoot(root: string) {
  if (!root || !isAbsolute(root) || normalize(root) !== root) throw new SourceStoreError('data-root-mismatch');
}
function checkRoot(db: Database.Database, root: string) {
  requireRoot(root);
  const row = db.prepare('SELECT data_root FROM workbench_source_meta WHERE singleton = 1').get() as { data_root: string } | undefined;
  if (row?.data_root !== root) throw new SourceStoreError('data-root-mismatch');
}

/** Explicit future migration hook; never registered with daemon bootstrap here. */
export function migrateSourceRecords(db: Database.Database, resolvedDataRoot: string): void {
  requireRoot(resolvedDataRoot);
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS workbench_source_meta (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1), data_root TEXT NOT NULL, generation INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workbench_source_records (
        kind TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL,
        admission_id TEXT NOT NULL, resource_key TEXT, record_json TEXT NOT NULL, sha256 TEXT NOT NULL,
        PRIMARY KEY(kind, id, revision)
      );
      CREATE TABLE IF NOT EXISTS workbench_source_heads (
        kind TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL,
        PRIMARY KEY(kind, id), FOREIGN KEY(kind, id, revision) REFERENCES workbench_source_records(kind, id, revision)
      );
      CREATE INDEX IF NOT EXISTS workbench_source_binding ON workbench_source_records(admission_id);
      CREATE INDEX IF NOT EXISTS workbench_source_resource ON workbench_source_records(resource_key);
      CREATE TRIGGER IF NOT EXISTS workbench_source_no_update BEFORE UPDATE ON workbench_source_records
        BEGIN SELECT RAISE(ABORT, 'immutable source record'); END;
      CREATE TRIGGER IF NOT EXISTS workbench_source_no_delete BEFORE DELETE ON workbench_source_records
        BEGIN SELECT RAISE(ABORT, 'immutable source record'); END;
    `);
    db.prepare('INSERT OR IGNORE INTO workbench_source_meta VALUES (1, ?, 0)').run(resolvedDataRoot);
    checkRoot(db, resolvedDataRoot);
  }).immediate();
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const resourceKey = (ref: AdmissionRecord['record']['resourceRef']) => JSON.stringify([ref.sourceType, ref.sourceId, ref.itemId, ref.revisionOrDigest]);
interface Row { kind: string; id: string; revision: number; admission_id: string; resource_key: string | null; record_json: string; sha256: string }
function decode(row: Row): StoredSourceRecord {
  try {
    if (digest(row.record_json) !== row.sha256) throw new Error('hash');
    const parsed = parseStoredSourceRecord(JSON.parse(row.record_json));
    if (parsed.kind !== row.kind || parsed.record.id !== row.id || parsed.record.revision !== row.revision
      || sourceRecordAdmissionId(parsed) !== row.admission_id
      || (parsed.kind === 'terms' && parsed.record.id !== parsed.record.admissionId)) throw new Error('identity');
    if ((parsed.kind === 'admission' && row.resource_key !== resourceKey(parsed.record.resourceRef))
      || (parsed.kind === 'assessment' && row.resource_key !== resourceKey(parsed.record.source.ref))) throw new Error('resource identity');
    return parsed;
  } catch { throw new SourceStoreError('record-corrupt'); }
}
export interface SourceRecordSnapshot {
  generation: number;
  admission: AdmissionRecord;
  admissionHeads: AdmissionRecord[];
  terms: TermsRecord | null;
  assessments: AssessmentRecord[];
  evidence: EvidenceRecord[];
  history: { records: StoredSourceRecord[]; admission: AdmissionRecord[]; assessments: Record<string, AssessmentRecord[]> };
}

/** The owner injects an already-open database and its resolved RUNTIME_DATA_DIR.
 * Publication stores claims, not verified permissions. Snapshot verification is separate.
 */
export class SourceRecordStore {
  constructor(private readonly db: Database.Database, public readonly resolvedDataRoot: string) { checkRoot(db, resolvedDataRoot); }
  generation(): number {
    checkRoot(this.db, this.resolvedDataRoot);
    return (this.db.prepare('SELECT generation FROM workbench_source_meta WHERE singleton = 1').get() as { generation: number }).generation;
  }
  publish(input: unknown, expectedRevision: number | null): void {
    const record = parseStoredSourceRecord(input); const { id, revision } = record.record;
    if (expectedRevision !== null && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)) throw new SourceStoreError('revision-conflict');
    this.db.transaction(() => {
      checkRoot(this.db, this.resolvedDataRoot);
      const existing = this.db.prepare('SELECT * FROM workbench_source_records WHERE kind = ? AND id = ? AND revision = ?').get(record.kind, id, revision) as Row | undefined;
      if (existing && !isDeepStrictEqual(decode(existing), record)) throw new SourceStoreError('immutable-conflict');
      const head = this.db.prepare('SELECT r.* FROM workbench_source_heads h JOIN workbench_source_records r USING(kind,id,revision) WHERE h.kind = ? AND h.id = ?').get(record.kind, id) as Row | undefined;
      if (head?.revision === revision && existing) return; // Exact retry of current publication.
      if ((head?.revision ?? null) !== expectedRevision || (head && revision <= head.revision)) throw new SourceStoreError('revision-conflict');
      if (head) {
        const prior = decode(head);
        if (sourceRecordAdmissionId(prior) !== sourceRecordAdmissionId(record)) throw new SourceStoreError('binding-conflict');
        if ((prior.kind === 'admission' && record.kind === 'admission' && !isDeepStrictEqual(prior.record.resourceRef, record.record.resourceRef))
          || (prior.kind === 'assessment' && record.kind === 'assessment' && !isDeepStrictEqual(prior.record.source.ref, record.record.source.ref))) throw new SourceStoreError('binding-conflict');
      }
      if (record.kind === 'terms' && id !== record.record.admissionId) throw new SourceStoreError('binding-conflict');
      let key: string | null = null;
      if (record.kind === 'admission') key = resourceKey(record.record.resourceRef);
      else if (record.kind === 'assessment') key = resourceKey(record.record.source.ref);
      else {
        const boundRow = this.db.prepare("SELECT * FROM workbench_source_records WHERE kind='admission' AND id=? AND revision=?").get(record.record.admissionId, record.record.admissionRevision) as Row | undefined;
        if (!boundRow) throw new SourceStoreError('record-missing');
        const bound = decode(boundRow); if (bound.kind !== 'admission') throw new SourceStoreError('record-corrupt');
        key = resourceKey(bound.record.resourceRef);
      }
      const json = JSON.stringify(record);
      this.db.prepare('INSERT INTO workbench_source_records VALUES (?, ?, ?, ?, ?, ?, ?)').run(record.kind, id, revision, sourceRecordAdmissionId(record), key, json, digest(json));
      this.db.prepare('INSERT INTO workbench_source_heads VALUES (?, ?, ?) ON CONFLICT(kind,id) DO UPDATE SET revision=excluded.revision').run(record.kind, id, revision);
      this.db.prepare('UPDATE workbench_source_meta SET generation=generation+1 WHERE singleton=1').run();
    }).immediate();
  }
  read(admissionId: string): SourceRecordSnapshot {
    return this.db.transaction(() => {
      const generation = this.generation();
      const admissionRow = this.db.prepare("SELECT r.* FROM workbench_source_heads h JOIN workbench_source_records r USING(kind,id,revision) WHERE h.kind='admission' AND h.id=?").get(admissionId) as Row | undefined;
      if (!admissionRow) throw new SourceStoreError('record-missing');
      const admission = decode(admissionRow); if (admission.kind !== 'admission') throw new SourceStoreError('record-corrupt');
      const key = resourceKey(admission.record.resourceRef);
      const current = (this.db.prepare('SELECT r.* FROM workbench_source_heads h LEFT JOIN workbench_source_records r USING(kind,id,revision) WHERE r.admission_id = ? OR r.resource_key = ? OR r.id IS NULL').all(admissionId, key) as Row[]).map(decode);
      const history = (this.db.prepare('SELECT * FROM workbench_source_records WHERE admission_id = ? OR resource_key = ? ORDER BY revision').all(admissionId, key) as Row[]).map(decode);
      const assessments = current.filter((row): row is AssessmentRecord => row.kind === 'assessment' && resourceKey(row.record.source.ref) === key);
      return { generation, admission, admissionHeads: current.filter((row): row is AdmissionRecord => row.kind === 'admission'), terms: current.find((row): row is TermsRecord => row.kind === 'terms' && row.record.admissionId === admissionId) ?? null,
        assessments, evidence: current.filter((row): row is EvidenceRecord => row.kind === 'evidence'),
        history: { records: history, admission: history.filter((row): row is AdmissionRecord => row.kind === 'admission'),
          assessments: Object.fromEntries(assessments.map(row => [row.record.id, history.filter((entry): entry is AssessmentRecord => entry.kind === 'assessment' && entry.record.id === row.record.id)])),
        },
      };
    })();
  }
}
