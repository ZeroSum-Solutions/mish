import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { parseRightsAssessment, parseSourceAdmission, type RightsAssessment, type SourceAdmission } from '@mish/contracts';
import { SourceRecordStore, migrateSourceRecords } from '../../src/storage/workbench-source-store.js';
import type { EvidenceRecord } from '../../src/workbench/source-records.js';
import type { TrustedSourceSnapshotDependencies, SourceSnapshotRequest } from '../../src/workbench/source-snapshot.js';
export const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export interface SnapshotFixture {
  db: Database.Database; store: SourceRecordStore; admission: SourceAdmission; assessment: RightsAssessment;
  request: SourceSnapshotRequest; deps: TrustedSourceSnapshotDependencies;
  proof: Buffer; source: Buffer; notice: Buffer; acquired: Buffer;
}
export function snapshotFixture(): SnapshotFixture {
  const root = '/resolved-synthetic-root'; const db = new Database(':memory:'); migrateSourceRecords(db, root);
  const store = new SourceRecordStore(db, root);
  const acquired = Buffer.from('synthetic registry input'); const source = Buffer.from('synthetic editable source'); const notice = Buffer.from('synthetic notice');
  const proof = Buffer.from('synthetic evidence, never a real licence');
  const admission = parseSourceAdmission({ schema: 'source-admission/1', id: 'fixture-source', revision: 1,
    resourceRef: { sourceType: 'section', sourceId: 'react-bits', itemId: 'fixture-item', revisionOrDigest: 'v1' },
    acquiredContent: { sha256: hash(acquired), bytes: acquired.length }, implementationOrigin: 'official',
    acquisition: { mode: 'licensed-mcp', connectorId: 'fixture-connector', evidenceRefs: ['acquired-proof'] },
    target: { profileId: 'fixture-react18', nativeFormat: 'react-tsx', styleRuntime: 'css' },
    closure: { digest: 'b'.repeat(64), files: [{ path: 'component.tsx', role: 'source', sha256: hash(source), bytes: source.length },
      { path: 'NOTICE', role: 'notice', sha256: hash(notice), bytes: notice.length }], dependencies: [], unresolved: [] }, stages: [],
  });
  const assessment = parseRightsAssessment({ schema: 'rights-assessment/1', id: 'fixture-assessment', revision: 1,
    source: { ref: admission.resourceRef, contentSha256: admission.acquiredContent!.sha256, closureDigest: admission.closure.digest, fileScope: 'all', filePaths: [] },
    terms: { version: 'fixture-v1', sha256: hash(proof), canonicalUrl: null, clauseRefs: ['synthetic-only'] },
    acquisitionMode: 'licensed-mcp', evaluator: { id: 'fixture-human', role: 'source-curator', basis: 'specific-grant' },
    authorityScope: { kind: 'source-management', principalId: 'principal-a' }, evidenceRefs: ['terms-proof', 'rights-proof'], evaluatedAt: '2026-10-03T00:00:00.000Z',
    operationRights: [{ operation: 'incorporate-project', decision: 'allowed', reason: null,
      scope: { principalId: 'principal-a', projectScope: 'listed', projectIds: ['project-a'], targetScope: 'listed', targetProfileIds: ['fixture-react18'], visibility: 'private' },
      evidenceRefs: ['rights-proof'], obligations: [{ id: 'retain', kind: 'notice', description: 'Synthetic notice condition.' }],
    }],
  });
  store.publish({ kind: 'admission', record: admission }, null);
  store.publish({ kind: 'terms', record: { id: admission.id, revision: 1, admissionId: admission.id, admissionRevision: 1, terms: { version: 'fixture-v1', sha256: hash(proof) }, evidenceRefs: ['terms-proof'] } }, null);
  store.publish({ kind: 'assessment', admissionId: admission.id, record: assessment }, null);
  for (const [id, type] of [['acquired-proof', 'acquisition'], ['terms-proof', 'terms'], ['rights-proof', 'rights'], ['project-proof', 'project'], ['licence-proof', 'licence'], ['notice-proof', 'obligation']] as const) {
    const row: EvidenceRecord = { kind: 'evidence', record: { id, revision: 1, admissionId: admission.id, admissionRevision: 1, principalId: 'principal-a', proofSha256: hash(proof), type,
      sourceSha256: admission.acquiredContent!.sha256, closureDigest: admission.closure.digest, terms: { version: 'fixture-v1', sha256: hash(proof) }, connectorId: ['acquisition', 'licence'].includes(type) ? 'fixture-connector' : null,
      scope: ['acquisition', 'terms', 'licence'].includes(type) ? { kind: 'source' } : { kind: 'operation', projectId: 'project-a', targetProfileId: 'fixture-react18', visibility: 'private', operations: ['incorporate-project'] }, validFrom: 1, expiresAt: 5000 } };
    store.publish(row, null);
  }
  const request: SourceSnapshotRequest = { admissionId: admission.id, projectId: 'project-a', target: structuredClone(admission.target), visibility: 'private', operation: 'incorporate-project' };
  const deps: TrustedSourceSnapshotDependencies = {
    now: () => 1000, authenticate: async () => 'principal-a', authorityEpoch: async () => 'trusted-current-epoch',
    authorizeProject: async context => ({ principalId: context.principalId, projectId: context.projectId, target: context.target, visibility: context.visibility, evidenceRefs: ['project-proof'] }),
    authorizeSource: async () => true, verifyAssessmentIssuer: async () => true, verifyTerms: async () => true,
    inspectSource: async () => ({ acquiredBytes: acquired, closureDigest: admission.closure.digest,
      files: [{ path: 'component.tsx', role: 'source', bytes: source }, { path: 'NOTICE', role: 'notice', bytes: notice }], dependencies: [] }),
    readEvidenceBytes: async () => proof, verifyEvidence: async () => 'verified',
    resolveBindings: async () => ({ acquisitionLicensee: { principalId: 'principal-a', connectorId: 'fixture-connector' }, projectUse: 'own', clientCoverage: null,
      requiredObligations: [], evidenceRefs: ['licence-proof'], obligationReceipts: [{ assessmentId: assessment.id, assessmentRevision: 1, operation: 'incorporate-project',
        sourceSha256: admission.acquiredContent!.sha256, termsSha256: hash(proof), principalId: 'principal-a', projectId: 'project-a', targetProfileId: 'fixture-react18', visibility: 'private',
        obligation: assessment.operationRights[0]!.obligations[0]!, noticeFiles: [admission.closure.files[1]!], evidenceRefs: ['notice-proof'] }],
    }),
  };
  return { db, store, admission, assessment, request, deps, proof, source, notice, acquired };
}
