import { parseRightsAssessment, parseSourceAdmission, SOURCE_OPERATIONS, type SourceAdmission, type RightsAssessment, type OperationRight } from '@mish/contracts';

interface Binding { id: string; revision: number; admissionId: string; admissionRevision: number }
type TermsMetadata = { version: string; sha256: string } | null;
export interface AdmissionRecord { kind: 'admission'; record: SourceAdmission }
export interface AssessmentRecord { kind: 'assessment'; admissionId: string; record: RightsAssessment }
export interface TermsRecord { kind: 'terms'; record: Binding & { terms: TermsMetadata; evidenceRefs: string[] } }
export interface EvidenceRecord { kind: 'evidence'; record: Binding & {
  principalId: string; proofSha256: string;
  sourceSha256: string; closureDigest: string; terms: TermsMetadata; connectorId: string | null;
  type: 'acquisition' | 'terms' | 'rights' | 'licence' | 'project' | 'client' | 'obligation';
  scope: { kind: 'source' } | { kind: 'operation'; projectId: string; targetProfileId: string; visibility: OperationRight['scope']['visibility']; operations: OperationRight['operation'][] };
  validFrom: number; expiresAt: number;
} }
export type StoredSourceRecord = AdmissionRecord | AssessmentRecord | TermsRecord | EvidenceRecord;
export type SourceRecordKind = StoredSourceRecord['kind'];
const invalid = (): never => { throw new Error('invalid-source-record'); };
/** The daemon's verified local owner principal (the adoption principal of a local, unpaired request). */
export const LOCAL_OWNER_PRINCIPAL = 'local-owner';
/**
 * `owner-accepted-private-use` records the owner's own decision, so it binds to the
 * verified local owner only. The contract accepts any principal ID string; this daemon
 * boundary refuses every other principal before a record is stored or used.
 */
export function assertOwnerAcceptedPrincipal(record: RightsAssessment): RightsAssessment {
  if (record.evaluator.basis === 'owner-accepted-private-use'
    && (record.authorityScope.principalId !== LOCAL_OWNER_PRINCIPAL || record.operationRights.some(right => right.scope.principalId !== LOCAL_OWNER_PRINCIPAL))) {
    throw new Error('owner-accepted-private-use binds to the local owner principal only');
  }
  return record;
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key))) return invalid();
  return row;
}
function id(value: unknown): string {
  if (typeof value !== 'string' || value.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)) return invalid();
  return value;
}
function integer(value: unknown, minimum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) return invalid();
  return value;
}
function hash(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) return invalid();
  return value;
}
function refs(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 100) return invalid();
  const result = value.map(id); if (new Set(result).size !== result.length) return invalid(); return result;
}
function binding(row: Record<string, unknown>): Binding {
  return { id: id(row.id), revision: integer(row.revision, 1), admissionId: id(row.admissionId), admissionRevision: integer(row.admissionRevision, 1) };
}
function termsMetadata(input: unknown): TermsMetadata {
  if (input === null) return null;
  const metadata = object(input, ['version', 'sha256']);
  if (typeof metadata.version !== 'string' || !metadata.version.length || metadata.version.length > 2000 || /[\p{Cc}\p{Cf}]/u.test(metadata.version)) return invalid();
  return { version: metadata.version, sha256: hash(metadata.sha256) };
}
/** Strict stored metadata parsing proves shape only, never current authority or proof. */
export function parseStoredSourceRecord(input: unknown): StoredSourceRecord {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid();
  const kind = (input as Record<string, unknown>).kind;
  const envelope = object(input, kind === 'assessment' ? ['kind', 'admissionId', 'record'] : ['kind', 'record']);
  if (kind === 'admission') return { kind, record: parseSourceAdmission(envelope.record) };
  if (kind === 'assessment') return { kind, admissionId: id(envelope.admissionId), record: assertOwnerAcceptedPrincipal(parseRightsAssessment(envelope.record)) };
  if (kind === 'terms') {
    const row = object(envelope.record, ['id', 'revision', 'admissionId', 'admissionRevision', 'terms', 'evidenceRefs']);
    return { kind, record: { ...binding(row), terms: termsMetadata(row.terms), evidenceRefs: refs(row.evidenceRefs) } };
  }
  if (kind !== 'evidence') return invalid();
  const row = object(envelope.record, ['id', 'revision', 'admissionId', 'admissionRevision', 'principalId', 'proofSha256', 'sourceSha256', 'closureDigest', 'terms', 'connectorId', 'type', 'scope', 'validFrom', 'expiresAt']);
  const types = ['acquisition', 'terms', 'rights', 'licence', 'project', 'client', 'obligation'] as const;
  if (!types.includes(row.type as EvidenceRecord['record']['type'])) return invalid();
  const type = row.type as EvidenceRecord['record']['type'];
  const connectorId = row.connectorId === null ? null : id(row.connectorId);
  if ((type === 'licence' && connectorId === null) || (!['licence', 'acquisition'].includes(type) && connectorId !== null)) return invalid();
  let scope: EvidenceRecord['record']['scope'];
  if (row.scope && typeof row.scope === 'object' && (row.scope as Record<string, unknown>).kind === 'source') {
    object(row.scope, ['kind']); if (!['acquisition', 'terms', 'licence'].includes(type)) return invalid(); scope = { kind: 'source' };
  } else {
    const s = object(row.scope, ['kind', 'projectId', 'targetProfileId', 'visibility', 'operations']);
    if (s.kind !== 'operation' || !['private', 'finished-application', 'reusable-distribution'].includes(s.visibility as string)
      || !Array.isArray(s.operations) || !s.operations.length || s.operations.length > 9
      || s.operations.some(operation => !SOURCE_OPERATIONS.includes(operation)) || new Set(s.operations).size !== s.operations.length) return invalid();
    scope = { kind: 'operation', projectId: id(s.projectId), targetProfileId: id(s.targetProfileId), visibility: s.visibility as OperationRight['scope']['visibility'], operations: [...s.operations] as OperationRight['operation'][] };
  }
  const validFrom = integer(row.validFrom, 0); const expiresAt = integer(row.expiresAt, 1); if (expiresAt <= validFrom) return invalid();
  return { kind, record: { ...binding(row), principalId: id(row.principalId), proofSha256: hash(row.proofSha256),
    sourceSha256: hash(row.sourceSha256), closureDigest: hash(row.closureDigest), terms: termsMetadata(row.terms), connectorId, type, scope, validFrom, expiresAt } };
}
export function sourceRecordAdmissionId(row: StoredSourceRecord): string {
  return row.kind === 'admission' ? row.record.id : row.kind === 'assessment' ? row.admissionId : row.record.admissionId;
}
