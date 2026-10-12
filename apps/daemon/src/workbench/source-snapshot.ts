import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { parseSourceAdmission, SOURCE_OPERATIONS, type SourceAdmission, type OperationRight } from '@mish/contracts';
import { SourceRecordStore, type SourceRecordSnapshot } from '../storage/workbench-source-store.js';
import type { AdmissionRecord, AssessmentRecord, EvidenceRecord, TermsRecord } from './source-records.js';
import { evaluateSourceOperation, type SourceOperationAuthority, type SourceOperationDecision } from './source-rights.js';

export interface SourceSnapshotRequest {
  admissionId: string; projectId: string; target: SourceAdmission['target'];
  visibility: OperationRight['scope']['visibility']; operation: OperationRight['operation'];
}
export interface SourceVerificationContext extends SourceSnapshotRequest { principalId: string; resolvedDataRoot: string; now: number }
export interface ObservedSourceBytes {
  acquiredBytes: Uint8Array; closureDigest: string;
  files: { path: string; role: SourceAdmission['closure']['files'][number]['role']; bytes: Uint8Array }[];
  dependencies: SourceAdmission['closure']['dependencies'];
}
type BoundAuthority = Pick<SourceOperationAuthority, 'acquisitionLicensee' | 'projectUse' | 'clientCoverage' | 'requiredObligations' | 'obligationReceipts'> & { evidenceRefs: readonly string[] };

/** Inject actual current server verification, never request JSON/model callbacks.
 * Epoch must change on any relevant authentication, source/terms/bytes, issuer,
 * grant, project, licence or client-authority change across these dependencies.
 * Inspectors read actual bytes; closureDigest/dependencies are audited observations
 * under the acquisition's existing digest convention, not copied admission labels.
 */
export interface TrustedSourceSnapshotDependencies {
  now(): number;
  authenticate(): Promise<string | null>;
  authorityEpoch(context: SourceVerificationContext): Promise<string>;
  authorizeProject(context: SourceVerificationContext): Promise<SourceOperationAuthority['projectAuthorization']>;
  /** Verify actual acquisition/origin/target/bytes and legitimate supersession of
   * every same-ResourceRef admission history, including prior restrictions.
   */
  authorizeSource(context: SourceVerificationContext, admission: SourceAdmission, immutableHistory: readonly AdmissionRecord[]): Promise<boolean>;
  /** Authenticate the exact issued record and current issuer authority; explicitly
   * validate head selection/supersession against history, including prior denials.
   */
  verifyAssessmentIssuer(record: AssessmentRecord, immutableHistory: readonly AssessmentRecord[], context: SourceVerificationContext): Promise<boolean>;
  verifyTerms(record: TermsRecord, immutableHistory: readonly TermsRecord[], context: SourceVerificationContext): Promise<boolean>;
  inspectSource(admission: SourceAdmission, context: SourceVerificationContext): Promise<ObservedSourceBytes | null>;
  readEvidenceBytes(record: EvidenceRecord, context: SourceVerificationContext): Promise<Uint8Array | null>;
  /** Authenticate these already-hashed proof bytes, current revision and complete
   * binding under live authority. A stored type/hash/status is insufficient.
   */
  verifyEvidence(record: EvidenceRecord, immutableHistory: readonly EvidenceRecord[], context: SourceVerificationContext, proofBytes: Uint8Array): Promise<'verified' | 'expired' | 'revoked' | 'contradictory' | 'incomplete'>;
  resolveBindings(context: SourceVerificationContext, snapshot: SourceRecordSnapshot): Promise<BoundAuthority>;
}
export class SourceSnapshotError extends Error {
  constructor(public readonly code: 'authentication-unverified' | 'project-unverified' | 'source-unverified' | 'issuer-unverified' | 'terms-unverified' | 'evidence-unverified' | 'licence-unverified' | 'snapshot-changed' | 'rights-incomplete', public readonly decision?: SourceOperationDecision) { super(code); }
}
function fail(code: SourceSnapshotError['code']): never { throw new SourceSnapshotError(code); }
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function validId(value: unknown): value is string { return typeof value === 'string' && value.length <= 200 && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value); }
function verifyBytes(admission: SourceAdmission, observed: ObservedSourceBytes | null) {
  if (!observed || !admission.acquiredContent || !(observed.acquiredBytes instanceof Uint8Array)
    || hash(observed.acquiredBytes) !== admission.acquiredContent.sha256 || observed.acquiredBytes.byteLength !== admission.acquiredContent.bytes
    || observed.closureDigest !== admission.closure.digest || !isDeepStrictEqual(observed.dependencies, admission.closure.dependencies)
    || observed.files.length !== admission.closure.files.length || new Set(observed.files.map(file => file.path)).size !== observed.files.length) fail('source-unverified');
  for (const expected of admission.closure.files) {
    const actual = observed.files.find(file => file.path === expected.path);
    if (!actual || actual.role !== expected.role || !(actual.bytes instanceof Uint8Array)
      || actual.bytes.byteLength !== expected.bytes || hash(actual.bytes) !== expected.sha256) fail('source-unverified');
  }
}

/** SQLite gives a coherent read; asynchronous external verification then checks its
 * generation and a trusted authority epoch. This is not a publication permit.
 */
export async function buildTrustedSourceSnapshot(store: SourceRecordStore, request: SourceSnapshotRequest, deps: TrustedSourceSnapshotDependencies) {
  request = structuredClone({ admissionId: request.admissionId, projectId: request.projectId,
    target: request.target, visibility: request.visibility, operation: request.operation });
  const principalId = await deps.authenticate();
  if (!validId(principalId)) fail('authentication-unverified');
  if (!validId(request.admissionId) || !validId(request.projectId) || !SOURCE_OPERATIONS.includes(request.operation)
    || !['private', 'finished-application', 'reusable-distribution'].includes(request.visibility)) fail('source-unverified');
  const snapshot = store.read(request.admissionId); const admission = snapshot.admission.record;
  parseSourceAdmission({ ...admission, target: request.target });
  const now = deps.now(); if (!Number.isSafeInteger(now) || now < 0) fail('evidence-unverified');
  const context: SourceVerificationContext = structuredClone({ ...request, principalId, resolvedDataRoot: store.resolvedDataRoot, now });
  const freshContext = () => structuredClone(context);
  const epoch = await deps.authorityEpoch(freshContext()); if (!epoch || epoch.length > 1000) fail('snapshot-changed');
  const projectAuthorization = structuredClone(await deps.authorizeProject(freshContext()));
  if (!projectAuthorization || !projectAuthorization.evidenceRefs.length) fail('project-unverified');
  if (!await deps.authorizeSource(freshContext(), structuredClone(admission), structuredClone(snapshot.history.admission))) fail('source-unverified');
  verifyBytes(admission, await deps.inspectSource(structuredClone(admission), freshContext()));
  const terms = snapshot.terms;
  if (!terms || terms.record.admissionRevision !== admission.revision
    || !await deps.verifyTerms(structuredClone(terms), structuredClone(snapshot.history.records.filter((row): row is TermsRecord => row.kind === 'terms' && row.record.admissionId === admission.id)), freshContext())) fail('terms-unverified');
  const relevant = (row: AssessmentRecord) => row.record.authorityScope.principalId === principalId
    && (row.record.authorityScope.kind !== 'project' || row.record.authorityScope.projectId === request.projectId)
    && isDeepStrictEqual(row.record.source.ref, admission.resourceRef);
  const affectedStreams = snapshot.assessments.filter(row => (snapshot.history.assessments[row.record.id] ?? []).some(relevant));
  // A moved principal/project head must be authenticated before its earlier
  // restriction can disappear from this caller's applicable current records.
  for (const row of affectedStreams) {
    if (!await deps.verifyAssessmentIssuer(structuredClone(row), structuredClone(snapshot.history.assessments[row.record.id] ?? []), freshContext())) fail('issuer-unverified');
  }
  const assessments = affectedStreams.filter(relevant);
  if (!assessments.length) fail('issuer-unverified');
  const bindings = structuredClone(await deps.resolveBindings(freshContext(), structuredClone(snapshot)));
  if (admission.acquisition.mode === 'licensed-mcp' && (!bindings.acquisitionLicensee
    || bindings.acquisitionLicensee.principalId !== principalId || bindings.acquisitionLicensee.connectorId !== admission.acquisition.connectorId)) fail('licence-unverified');
  const demanded = new Map<string, Set<EvidenceRecord['record']['type']>>();
  const demandedOperations = new Map<string, Set<OperationRight['operation']>>();
  const requiredOperations: OperationRight['operation'][] = [request.operation];
  if (request.operation === 'reuse-private-project') requiredOperations.push('incorporate-project');
  if (request.visibility === 'reusable-distribution') requiredOperations.push('redistribute-unit');
  const requireEvidence = (refs: readonly string[], types: EvidenceRecord['record']['type'][], operations: readonly OperationRight['operation'][] = []) => {
    if (!refs.length) fail('evidence-unverified');
    for (const ref of refs) {
      const prior = demanded.get(ref);
      const allowed = new Set(types.filter(type => !prior || prior.has(type)));
      if (!allowed.size) fail('evidence-unverified'); demanded.set(ref, allowed);
      const required = demandedOperations.get(ref) ?? new Set<OperationRight['operation']>();
      operations.forEach(operation => required.add(operation)); demandedOperations.set(ref, required);
    }
  };
  requireEvidence(admission.acquisition.evidenceRefs, ['acquisition']);
  requireEvidence(terms.record.evidenceRefs, ['terms']);
  requireEvidence(projectAuthorization.evidenceRefs, ['project'], requiredOperations);
  for (const row of assessments) {
    requireEvidence(row.record.evidenceRefs, ['rights', 'terms']);
    for (const right of row.record.operationRights) {
      if (right.evidenceRefs.length && requiredOperations.includes(right.operation)) requireEvidence(right.evidenceRefs, ['rights'], [right.operation]);
    }
  }
  if (bindings.evidenceRefs.length) requireEvidence(bindings.evidenceRefs, ['licence', 'client', 'obligation']);
  if (bindings.clientCoverage) requireEvidence(bindings.clientCoverage.evidenceRefs, ['client'], requiredOperations);
  for (const receipt of bindings.obligationReceipts) requireEvidence(receipt.evidenceRefs, ['obligation'], [receipt.operation]);
  const verified: EvidenceRecord[] = [];
  for (const [id, types] of demanded) {
    const record = snapshot.evidence.find(row => row.record.id === id); if (!record) fail('evidence-unverified');
    const proof = record.record;
    const boundAdmission = snapshot.history.admission.find(row => row.record.id === proof.admissionId && row.record.revision === proof.admissionRevision)?.record;
    if (!boundAdmission || !snapshot.admissionHeads.some(row => row.record.id === proof.admissionId && row.record.revision === proof.admissionRevision)
      || !isDeepStrictEqual(boundAdmission.resourceRef, admission.resourceRef)
      || boundAdmission.acquisition.mode !== admission.acquisition.mode || boundAdmission.acquisition.connectorId !== admission.acquisition.connectorId
      || boundAdmission.acquiredContent?.sha256 !== proof.sourceSha256 || boundAdmission.closure.digest !== proof.closureDigest
      || (proof.admissionId === admission.id && proof.admissionRevision !== admission.revision)) fail('evidence-unverified');
    if (proof.principalId !== principalId || !types.has(proof.type)
      || proof.sourceSha256 !== admission.acquiredContent?.sha256 || proof.closureDigest !== admission.closure.digest
      || ((!['acquisition', 'project'].includes(proof.type) || proof.terms !== null) && !isDeepStrictEqual(proof.terms, terms.record.terms))
      || (['licence', 'acquisition'].includes(proof.type) && proof.connectorId !== admission.acquisition.connectorId)
      || now < proof.validFrom || now >= proof.expiresAt
      || (proof.scope.kind === 'operation' && (proof.scope.projectId !== request.projectId
        || proof.scope.targetProfileId !== request.target.profileId || proof.scope.visibility !== request.visibility
        || [...(demandedOperations.get(id) ?? [])].some(operation => proof.scope.kind === 'operation' && !proof.scope.operations.includes(operation))))) fail('evidence-unverified');
    const bytes = await deps.readEvidenceBytes(structuredClone(record), freshContext());
    if (!(bytes instanceof Uint8Array) || hash(bytes) !== proof.proofSha256
      || await deps.verifyEvidence(structuredClone(record), structuredClone(snapshot.history.records.filter((row): row is EvidenceRecord => row.kind === 'evidence' && row.record.id === id)), freshContext(), Uint8Array.from(bytes)) !== 'verified') fail('evidence-unverified');
    verified.push(record);
  }
  if (admission.acquisition.mode === 'licensed-mcp' && !verified.some(row => row.record.type === 'licence' && bindings.evidenceRefs.includes(row.record.id))) fail('licence-unverified');
  const finalPrincipal = await deps.authenticate(); const finalEpoch = await deps.authorityEpoch(freshContext());
  const endNow = deps.now();
  if (!Number.isSafeInteger(endNow) || endNow < now || verified.some(row => endNow >= row.record.expiresAt)) fail('evidence-unverified');
  if (store.generation() !== snapshot.generation || finalPrincipal !== principalId || finalEpoch !== epoch) fail('snapshot-changed');
  const authority: SourceOperationAuthority = { principalId, projectId: request.projectId, target: request.target, visibility: request.visibility,
    projectAuthorization, currentAdmission: admission, currentTerms: terms.record.terms === null ? null : { ...terms.record.terms, evidenceRefs: terms.record.evidenceRefs },
    authorizedAssessments: assessments.map(row => row.record), verifiedEvidenceRefs: verified.map(row => row.record.id),
    acquisitionLicensee: bindings.acquisitionLicensee, projectUse: bindings.projectUse, clientCoverage: bindings.clientCoverage,
    requiredObligations: bindings.requiredObligations, obligationReceipts: bindings.obligationReceipts,
  };
  const decision = evaluateSourceOperation({ admission, assessments: authority.authorizedAssessments, operation: request.operation, authority });
  if (decision.decision === 'unknown') throw new SourceSnapshotError('rights-incomplete', decision);
  return { authority, decision, generation: snapshot.generation, authorityEpoch: epoch };
}
