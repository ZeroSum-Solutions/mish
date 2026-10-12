import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseSourceAdmission } from '@open-design/contracts';
import type { TermsRecord, EvidenceRecord } from '../../src/workbench/source-records.js';
import { SourceRecordStore, migrateSourceRecords } from '../../src/storage/workbench-source-store.js';

const roots: string[] = [];
const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) if (db.open) db.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'source-record-test-')); roots.push(root);
  const db = new Database(join(root, 'fixture.sqlite')); databases.push(db);
  migrateSourceRecords(db, root);
  return { root, db, store: new SourceRecordStore(db, root) };
}
function admission(revision = 1) {
  return { kind: 'admission' as const, record: parseSourceAdmission({
    schema: 'source-admission/1', id: 'fixture-source', revision,
    resourceRef: { sourceType: 'section', sourceId: 'react-bits', itemId: 'item', revisionOrDigest: 'v1' },
    acquiredContent: { sha256: 'a'.repeat(64), bytes: 1 }, implementationOrigin: 'official',
    acquisition: { mode: 'project-fetch', connectorId: null, evidenceRefs: ['acquired'] },
    target: { profileId: 'react', nativeFormat: 'react-tsx', styleRuntime: 'css' },
    closure: { digest: 'b'.repeat(64), files: [{ path: 'main.tsx', sha256: 'c'.repeat(64), bytes: 1, role: 'source' }], dependencies: [], unresolved: [] }, stages: [],
  }) };
}
function dependentRecord(kind: 'terms' | 'evidence', admissionRevision = 1): TermsRecord | EvidenceRecord {
  const binding = { id: kind === 'terms' ? 'fixture-source' : 'dependent-proof', revision: 1, admissionId: 'fixture-source', admissionRevision };
  if (kind === 'terms') return { kind, record: { ...binding, terms: null, evidenceRefs: ['terms-proof'] } };
  return { kind, record: { ...binding, principalId: 'principal-a', proofSha256: 'd'.repeat(64), sourceSha256: 'a'.repeat(64),
    closureDigest: 'b'.repeat(64), terms: null, connectorId: null, type: 'acquisition', scope: { kind: 'source' }, validFrom: 1, expiresAt: 5000 } };
}
describe('inactive source records', () => {
  it('persists current records and immutable history across a real database reopen', () => {
    const { root, db, store } = setup(); store.publish(admission(), null); store.publish(admission(2), 1); db.close();
    const reopened = new Database(join(root, 'fixture.sqlite')); databases.push(reopened);
    const next = new SourceRecordStore(reopened, root); const snapshot = next.read('fixture-source');
    expect(snapshot.admission.record.revision).toBe(2); expect(snapshot.history.admission.map(row => row.record.revision)).toEqual([1, 2]);
  });
  it('rejects a conflicting writer without discarding the previous record', () => {
    const { store } = setup(); store.publish(admission(), null); store.publish(admission(2), 1);
    expect(() => store.publish(admission(3), 1)).toThrow(/revision-conflict/u);
    expect(store.read('fixture-source').history.admission).toHaveLength(2);
  });
  it('rejects rewriting a revision and replaying an old revision as current', () => {
    const { store } = setup(); store.publish(admission(), null);
    const changed = admission(); changed.record.acquiredContent!.sha256 = 'f'.repeat(64);
    expect(() => store.publish(changed, 1)).toThrow(/immutable-conflict/u);
    store.publish(admission(2), 1); expect(() => store.publish(admission(), 2)).toThrow(/revision-conflict/u);
  });
  it('makes an exact current retry idempotent without changing snapshot generation', () => {
    const { store } = setup(); store.publish(admission(), null); const before = store.read('fixture-source');
    store.publish(admission(), null); expect(store.read('fixture-source').generation).toBe(before.generation);
  });
  it('preserves SQL-level immutable records against update and delete', () => {
    const { store, db } = setup(); store.publish(admission(), null);
    expect(() => db.exec('UPDATE workbench_source_records SET revision = 5')).toThrow(/immutable/u);
    expect(() => db.exec('DELETE FROM workbench_source_records')).toThrow(/immutable/u);
    expect(store.read('fixture-source').admission.record.revision).toBe(1);
  });
  it('rejects cross-root reuse of the injected database', () => {
    const { db } = setup(); expect(() => new SourceRecordStore(db, '/different-resolved-root')).toThrow(/data-root-mismatch/u);
    expect(() => migrateSourceRecords(db, '/different-resolved-root')).toThrow(/data-root-mismatch/u);
  });
  it('never infers a root or migrates from the constructor', () => {
    const db = new Database(':memory:'); databases.push(db);
    expect(() => new SourceRecordStore(db, '')).toThrow(/data-root/u);
    expect(() => new SourceRecordStore(db, '/resolved-fixture')).toThrow();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'workbench_source_records'").get()).toBeUndefined();
  });
  it('uses F1 strict stored parsing instead of retaining caller permission fields', () => {
    const { store } = setup(); const row = admission();
    expect(() => store.publish({ ...row, verified: true }, null)).toThrow();
    expect(() => store.read('fixture-source')).toThrow(/record-missing/u);
  });
  it('refuses moving an immutable resource identity to another item', () => {
    const { store } = setup(); store.publish(admission(), null); const next = admission(2); next.record.resourceRef.itemId = 'other';
    expect(() => store.publish(next, 1)).toThrow(/binding-conflict/u);
  });
  it('refuses a dangling current head instead of silently omitting a restriction', () => {
    const { store, db } = setup(); store.publish(admission(), null); db.pragma('foreign_keys = OFF');
    db.prepare('INSERT INTO workbench_source_heads VALUES (?, ?, ?)').run('assessment', 'missing-restriction', 1);
    expect(() => store.read('fixture-source')).toThrow(/record-corrupt/u);
  });
  it.each(['terms', 'evidence'] as const)('refuses %s before its exact admission revision without storing or advancing anything', kind => {
    const { store, db } = setup(); store.publish(admission(), null); const before = store.generation();
    expect(() => store.publish(dependentRecord(kind, 2), null)).toThrow(/record-missing/u);
    expect(store.generation()).toBe(before);
    expect(db.prepare('SELECT id FROM workbench_source_records WHERE kind=?').all(kind)).toEqual([]);
    expect(db.prepare('SELECT id FROM workbench_source_heads WHERE kind=?').all(kind)).toEqual([]);
  });
  it.each(['terms', 'evidence'] as const)('allows retry after admission arrives and discovers %s across a same-resource alias', kind => {
    const { store } = setup(); const row = dependentRecord(kind);
    try { store.publish(row, null); } catch (error) { expect(error).toMatchObject({ code: 'record-missing' }); }
    store.publish(admission(), null); const alias = admission(); alias.record.id = 'alias-source'; store.publish(alias, null);
    store.publish(row, null);
    const snapshot = store.read('alias-source');
    expect(snapshot.history.records.some(record => record.kind === kind && record.record.id === row.record.id)).toBe(true);
    if (kind === 'evidence') expect(snapshot.evidence.some(record => record.record.id === row.record.id)).toBe(true);
  });

});
