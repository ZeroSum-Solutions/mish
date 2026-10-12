import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SOURCE_OPERATIONS } from '@open-design/contracts';
import { LicenceRecordError, migrateWorkbenchLicenceRecords, putLicenceRecord, readLicenceRecord } from '../../src/workbench/licence-record.js';

let db: Database.Database;
afterEach(() => db?.close());
function open() { db = new Database(':memory:'); migrateWorkbenchLicenceRecords(db); return db; }
const terms = { kind: 'agreement', sha256: 'a'.repeat(64), citationUrl: null, clauseRefs: ['2.1', '2.4'] };
const draft = (patch: Record<string, unknown> = {}) => ({ holder: 'Example Owner', termsVersion: '2026-01', termsEvidence: terms, operationScope: [], ...patch });
function refusal(run: () => unknown): LicenceRecordError {
  try { run(); } catch (error) { if (error instanceof LicenceRecordError) return error; throw error; }
  throw new Error('expected a refusal');
}

describe('R16 preamble: the held-licence record', () => {
  it('starts from owner-confirmed licence existence with no principal and every operation pending', () => {
    const snapshot = readLicenceRecord(open(), 'react-bits');
    expect(snapshot).toMatchObject({ revision: 0, recordState: 'none', record: null, licenceExistence: 'owner-confirmed' });
    expect(snapshot.operations).toHaveLength(SOURCE_OPERATIONS.length);
    expect(snapshot.operations.every(item => item.decision === 'pending' && item.reason === 'licence-record-missing')).toBe(true);
  });
  it('records the holder without terms evidence and leaves only the operations pending', () => {
    const saved = putLicenceRecord(open(), 'react-bits', { expectedRevision: 0, draft: draft({ termsVersion: null, termsEvidence: null }) });
    expect(saved).toMatchObject({ revision: 1, recordState: 'current', record: { holder: 'Example Owner', recordedBy: { role: 'source-curator', basis: 'specific-grant', surface: 'http' } } });
    expect(saved.operations.every(item => item.decision === 'pending' && item.reason === 'terms-evidence-missing')).toBe(true);
  });
  it('refuses a bare assertion that widens scope beyond the held terms and saves nothing', () => {
    open();
    const bare = refusal(() => putLicenceRecord(db, 'react-bits', { expectedRevision: 0, draft: draft({ termsVersion: null, termsEvidence: null, operationScope: [{ operation: 'redistribute-unit', decision: 'allowed', clauseRefs: ['owner'] }] }) }));
    expect(bare).toMatchObject({ status: 422, details: { reason: 'licence-scope-widening', operations: ['redistribute-unit'] } });
    const outside = refusal(() => putLicenceRecord(db, 'react-bits', { expectedRevision: 0, draft: draft({ operationScope: [{ operation: 'host-preview', decision: 'allowed', clauseRefs: ['7.7'] }] }) }));
    expect(outside).toMatchObject({ status: 422, details: { reason: 'licence-scope-widening' } });
    expect(readLicenceRecord(db, 'react-bits').revision).toBe(0);
  });
  it('maps cited held-terms clauses to operations and keeps unassessed operations pending', () => {
    const saved = putLicenceRecord(open(), 'react-bits', { expectedRevision: 0, draft: draft({ operationScope: [
      { operation: 'host-preview', decision: 'allowed', clauseRefs: ['2.1'] }, { operation: 'redistribute-unit', decision: 'blocked', clauseRefs: ['2.4'] }] }) });
    const byOperation = Object.fromEntries(saved.operations.map(item => [item.operation, item]));
    expect(byOperation['host-preview']).toMatchObject({ decision: 'allowed', clauseRefs: ['2.1'] });
    expect(byOperation['redistribute-unit']).toMatchObject({ decision: 'blocked', reason: 'held-terms-restriction' });
    expect(byOperation['save-private-unit']).toMatchObject({ decision: 'pending', reason: 'not-assessed-from-terms' });
  });
  it('refuses to override an explicit restriction under the same terms, and re-evaluates new terms only on explicit re-assessment', () => {
    open();
    putLicenceRecord(db, 'react-bits', { expectedRevision: 0, draft: draft({ operationScope: [{ operation: 'redistribute-unit', decision: 'blocked', clauseRefs: ['2.4'] }] }) });
    const lift = { operationScope: [{ operation: 'redistribute-unit', decision: 'allowed', clauseRefs: ['2.1'] }] };
    expect(refusal(() => putLicenceRecord(db, 'react-bits', { expectedRevision: 1, draft: draft(lift) }))).toMatchObject({ status: 422, details: { reason: 'licence-restriction-override' } });
    const renewed = { termsVersion: '2026-09', termsEvidence: { ...terms, sha256: 'b'.repeat(64) } };
    expect(refusal(() => putLicenceRecord(db, 'react-bits', { expectedRevision: 1, draft: draft({ ...lift, ...renewed }) }))).toMatchObject({ status: 422, details: { reason: 'licence-reassessment-required' } });
    const reassessed = putLicenceRecord(db, 'react-bits', { expectedRevision: 1, draft: draft({ ...renewed, operationScope: [{ ...lift.operationScope[0], reassessed: true }] }) });
    expect(reassessed.operations.find(item => item.operation === 'redistribute-unit')).toMatchObject({ decision: 'allowed' });
    expect(reassessed.record?.changes).toContainEqual({ kind: 'restriction-reassessed', operation: 'redistribute-unit', clauseRefs: ['2.1'] });
  });
  it('refuses the two-step lift: drop the restriction row, then allow under the same digest', () => {
    open();
    putLicenceRecord(db, 'react-bits', { expectedRevision: 0, draft: draft({ operationScope: [{ operation: 'redistribute-unit', decision: 'blocked', clauseRefs: ['2.4'] }] }) });
    const dropped = putLicenceRecord(db, 'react-bits', { expectedRevision: 1, draft: draft() });
    expect(dropped.operations.find(item => item.operation === 'redistribute-unit')).toMatchObject({ decision: 'blocked', reason: 'carried-restriction' });
    const lift = refusal(() => putLicenceRecord(db, 'react-bits', { expectedRevision: 2, draft: draft({ operationScope: [{ operation: 'redistribute-unit', decision: 'allowed', clauseRefs: ['2.1'] }] }) }));
    expect(lift).toMatchObject({ status: 422, details: { reason: 'licence-restriction-override' } });
    expect(readLicenceRecord(db, 'react-bits').revision).toBe(2);
  });
  it('refuses the two-step lift through a revision with no terms evidence', () => {
    open();
    putLicenceRecord(db, 'react-bits', { expectedRevision: 0, draft: draft({ operationScope: [{ operation: 'redistribute-unit', decision: 'blocked', clauseRefs: ['2.4'] }] }) });
    const nulled = putLicenceRecord(db, 'react-bits', { expectedRevision: 1, draft: draft({ termsVersion: null, termsEvidence: null }) });
    expect(nulled.operations.find(item => item.operation === 'redistribute-unit')).toMatchObject({ decision: 'blocked', reason: 'carried-restriction' });
    const lift = refusal(() => putLicenceRecord(db, 'react-bits', { expectedRevision: 2, draft: draft({ operationScope: [{ operation: 'redistribute-unit', decision: 'allowed', clauseRefs: ['2.1'] }] }) }));
    expect(lift).toMatchObject({ status: 422, details: { reason: 'licence-restriction-override' } });
  });
  it('refuses a terms digest change under an unchanged terms version', () => {
    open();
    putLicenceRecord(db, 'react-bits', { expectedRevision: 0, draft: draft() });
    const swap = refusal(() => putLicenceRecord(db, 'react-bits', { expectedRevision: 1, draft: draft({ termsEvidence: { ...terms, sha256: `${'a'.repeat(63)}b` } }) }));
    expect(swap).toMatchObject({ status: 422, details: { reason: 'licence-terms-digest-conflict' } });
  });
  it('refuses an allowance on a clause newly added under the same digest unless re-assessed, and records the addition', () => {
    open();
    putLicenceRecord(db, 'react-bits', { expectedRevision: 0, draft: draft() });
    const added = { termsEvidence: { ...terms, clauseRefs: ['2.1', '2.4', '99'] } };
    expect(refusal(() => putLicenceRecord(db, 'react-bits', { expectedRevision: 1, draft: draft({ ...added, operationScope: [{ operation: 'save-private-unit', decision: 'allowed', clauseRefs: ['99'] }] }) })))
      .toMatchObject({ status: 422, details: { reason: 'licence-reassessment-required', operations: ['save-private-unit'] } });
    const saved = putLicenceRecord(db, 'react-bits', { expectedRevision: 1, draft: draft({ ...added, operationScope: [{ operation: 'save-private-unit', decision: 'allowed', clauseRefs: ['99'], reassessed: true }] }) });
    expect(saved.record?.changes).toContainEqual({ kind: 'clauses-added', operation: null, clauseRefs: ['99'] });
  });
  it('records the write surface label it is given, defaulting to raw HTTP', () => {
    open();
    expect(putLicenceRecord(db, 'react-bits', { expectedRevision: 0, draft: draft() }).record?.recordedBy.surface).toBe('http');
    expect(putLicenceRecord(db, 'react-bits', { expectedRevision: 1, draft: draft({ holder: 'Second' }) }, { surface: 'cli' }).record?.recordedBy.surface).toBe('cli');
  });
  it('degrades an unreadable stored record instead of failing reads, and refuses allowances over unreadable history', () => {
    open();
    putLicenceRecord(db, 'react-bits', { expectedRevision: 0, draft: draft() });
    const corrupt = JSON.stringify({ schema: 'licence-record/1', sourceId: 'react-bits', revision: 1, holder: 'x', future: true });
    db.prepare('UPDATE workbench_licence_record_current SET record_json=?').run(corrupt);
    db.prepare('UPDATE workbench_licence_record_history SET record_json=?').run(corrupt);
    const snapshot = readLicenceRecord(db, 'react-bits');
    expect(snapshot).toMatchObject({ revision: 1, recordState: 'unreadable', record: null });
    expect(snapshot.operations.every(item => item.decision === 'pending' && item.reason === 'licence-record-unreadable')).toBe(true);
    expect(refusal(() => putLicenceRecord(db, 'react-bits', { expectedRevision: 1, draft: draft({ operationScope: [{ operation: 'host-preview', decision: 'allowed', clauseRefs: ['2.1'] }] }) })))
      .toMatchObject({ status: 422, details: { reason: 'licence-history-unreadable' } });
    expect(putLicenceRecord(db, 'react-bits', { expectedRevision: 1, draft: draft() })).toMatchObject({ revision: 2, recordState: 'current' });
  });
  it('uses compare-and-set revisions, returns an equal retry unchanged and keeps history', () => {
    open();
    const first = putLicenceRecord(db, 'react-bits', { expectedRevision: 0, draft: draft() });
    expect(putLicenceRecord(db, 'react-bits', { expectedRevision: 0, draft: draft() })).toEqual(first);
    const conflict = refusal(() => putLicenceRecord(db, 'react-bits', { expectedRevision: 0, draft: draft({ holder: 'Someone Else' }) }));
    expect(conflict).toMatchObject({ status: 409, details: { current: first } });
    putLicenceRecord(db, 'react-bits', { expectedRevision: 1, draft: draft({ holder: 'Zero Sum Solutions' }) });
    expect(readLicenceRecord(db, 'react-bits')).toMatchObject({ revision: 2, record: { holder: 'Zero Sum Solutions' } });
    expect(readLicenceRecord(db, 'react-bits', 1)).toEqual(first);
  });
  it('refuses malformed, credential-bearing and unknown-source writes', () => {
    open();
    expect(refusal(() => putLicenceRecord(db, 'react-bits', { expectedRevision: 0, draft: draft({ holder: 'sk-live-0123456789abcdef' }) }))).toMatchObject({ status: 400 });
    expect(refusal(() => putLicenceRecord(db, 'react-bits', { expectedRevision: 0, draft: { ...draft(), licenceKey: 'x' } }))).toMatchObject({ status: 400 });
    expect(refusal(() => putLicenceRecord(db, 'other-source', { expectedRevision: 0, draft: draft() }))).toMatchObject({ status: 404 });
    expect(refusal(() => readLicenceRecord(db, 'other-source'))).toMatchObject({ status: 404 });
  });
  it('survives a reopened database through the migration', () => {
    const dir = mkdtempSync(join(tmpdir(), 'od-licence-')); const file = join(dir, 'app.sqlite');
    const first = new Database(file); migrateWorkbenchLicenceRecords(first);
    putLicenceRecord(first, 'react-bits', { expectedRevision: 0, draft: draft() }); first.close();
    db = new Database(file); migrateWorkbenchLicenceRecords(db);
    expect(readLicenceRecord(db, 'react-bits')).toMatchObject({ revision: 1, record: { holder: 'Example Owner' } });
    db.close(); db = new Database(':memory:');
    rmSync(dir, { recursive: true, force: true });
  });
});
