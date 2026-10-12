import { isDeepStrictEqual } from 'node:util';
import type { OperationRight, ResourceCandidate, RightsAssessment, SourceAdmission } from '@open-design/contracts';

type LegacyWorkbenchOperation = ResourceCandidate['operationGrants'][number]['operation'];

const legacyOperations = {
  'host-preview': 'host-preview',
  incorporation: 'incorporate-project',
  'private-save': 'save-private-unit',
  'private-reuse': 'reuse-private-project',
  export: 'export-application',
  redistribution: 'redistribute-unit',
  backup: 'private-backup',
} as const satisfies Record<LegacyWorkbenchOperation, OperationRight['operation']>;

/** Maps vocabulary only; a legacy permitted flag is not a source-operation right. */
export function mapLegacyWorkbenchOperation(operation: LegacyWorkbenchOperation) {
  return legacyOperations[operation];
}

type Obligation = OperationRight['obligations'][number];
type SourceFile = SourceAdmission['closure']['files'][number];

export interface SourceObligationReceipt {
  assessmentId: string;
  assessmentRevision: number;
  operation: OperationRight['operation'];
  sourceSha256: string;
  termsSha256: string | null;
  principalId: string;
  projectId: string;
  targetProfileId: string;
  visibility: OperationRight['scope']['visibility'];
  obligation: Obligation;
  noticeFiles: readonly SourceFile[];
  evidenceRefs: readonly string[];
}

/** Current server observations, never parsed from an operation request or model response.
 * Managers supply authorized human assessments and verified evidence/obligation receipts.
 * Record parsing alone cannot populate this authority boundary.
 */
export interface SourceOperationAuthority {
  principalId: string;
  projectId: string;
  target: SourceAdmission['target'];
  visibility: OperationRight['scope']['visibility'];
  acquisitionLicensee: { principalId: string; connectorId: string } | null;
  projectAuthorization: {
    principalId: string; projectId: string; target: SourceAdmission['target']; visibility: OperationRight['scope']['visibility']; evidenceRefs: readonly string[];
  } | null;
  currentAdmission: SourceAdmission;
  currentTerms: (Pick<NonNullable<RightsAssessment['terms']>, 'version' | 'sha256'> & { evidenceRefs: readonly string[] }) | null;
  authorizedAssessments: readonly RightsAssessment[];
  verifiedEvidenceRefs: readonly string[];
  requiredObligations: readonly Obligation[];
  obligationReceipts: readonly SourceObligationReceipt[];
  projectUse: 'own' | 'covered-client';
  clientCoverage: {
    principalId: string;
    projectId: string;
    target: SourceAdmission['target'];
    visibility: OperationRight['scope']['visibility'];
    sourceSha256: string;
    closureDigest: string;
    termsSha256: string | null;
    termsVersion: string | null;
    evidenceRefs: readonly string[];
  } | null;
}

export interface EvaluateSourceOperationInput {
  admission: SourceAdmission;
  assessments: readonly RightsAssessment[];
  operation: OperationRight['operation'];
  authority: SourceOperationAuthority;
}

export type SourceOperationReasonCode =
  | 'project-authority-unverified' | 'principal-mismatch' | 'authority-unverified' | 'source-mismatch'
  | 'terms-mismatch' | 'target-mismatch' | 'scope-mismatch' | 'evidence-unverified'
  | 'closure-unresolved' | 'file-right-missing' | 'right-blocked' | 'right-unknown'
  | 'obligation-unmet' | 'client-coverage-unverified' | 'acquisition-unverified';

export interface SourceOperationDecision {
  decision: OperationRight['decision'];
  reasons: { code: SourceOperationReasonCode; filePath: string | null; assessmentId: string | null }[];
  evidenceRefs: string[];
}

export function evaluateSourceOperation(input: EvaluateSourceOperationInput): SourceOperationDecision {
  const { assessments, operation, authority } = input;
  const admission = authority.currentAdmission;
  const reasons: SourceOperationDecision['reasons'] = [];
  const evidence = new Set<string>();
  let blocked = false;
  const report = (code: SourceOperationReasonCode, filePath: string | null = null, assessmentId: string | null = null) => {
    if (!reasons.some(reason => reason.code === code && reason.filePath === filePath && reason.assessmentId === assessmentId)) {
      reasons.push({ code, filePath, assessmentId });
    }
  };
  const verified = (refs: readonly string[]) => refs.length > 0 && refs.every(ref => authority.verifiedEvidenceRefs.includes(ref));
  const collect = (refs: readonly string[]) => refs.forEach(ref => evidence.add(ref));
  const result = (): SourceOperationDecision => ({ decision: blocked ? 'blocked' : reasons.length ? 'unknown' : 'allowed', reasons, evidenceRefs: [...evidence] });

  const projectAuthorization = authority.projectAuthorization;
  if (!projectAuthorization || projectAuthorization.projectId !== authority.projectId
    || projectAuthorization.visibility !== authority.visibility
    || !isDeepStrictEqual(projectAuthorization.target, authority.target) || !verified(projectAuthorization.evidenceRefs)) {
    blocked = true; report('project-authority-unverified');
  } else if (projectAuthorization.principalId !== authority.principalId) {
    blocked = true; report('principal-mismatch');
  } else collect(projectAuthorization.evidenceRefs);

  // A stored record and a current trusted observation must describe identical bytes and metadata.
  if (!isDeepStrictEqual(input.admission, admission)) report('source-mismatch');
  // A stale caller record cannot hide restrictions on the actual current source.
  if (!admission.acquiredContent) { report('source-mismatch'); return result(); }
  if (!isDeepStrictEqual(admission.target, authority.target)) report('target-mismatch');
  if (admission.acquisition.mode === 'licensed-mcp') {
    const licensee = authority.acquisitionLicensee;
    if (!licensee || licensee.connectorId !== admission.acquisition.connectorId) report('acquisition-unverified');
    else if (licensee.principalId !== authority.principalId) { blocked = true; report('principal-mismatch'); }
  }
  if (authority.currentTerms && !verified(authority.currentTerms.evidenceRefs)) report('evidence-unverified');
  if (!verified(admission.acquisition.evidenceRefs)) report('evidence-unverified');
  else collect(admission.acquisition.evidenceRefs);
  if (admission.closure.unresolved.length || !admission.closure.files.length
    || admission.closure.dependencies.some(dependency => dependency.version === null || (dependency.contentSha256 === null
      && !/(?:^| )sha(?:256|384|512)-/u.test(dependency.integrity ?? '')))) report('closure-unresolved');
  if (operation === 'host-preview' && authority.visibility !== 'private') report('scope-mismatch');
  if (authority.projectUse === 'covered-client') {
    const coverage = authority.clientCoverage;
    if (!coverage || coverage.principalId !== authority.principalId || coverage.projectId !== authority.projectId
      || coverage.visibility !== authority.visibility || !isDeepStrictEqual(coverage.target, authority.target)
      || coverage.sourceSha256 !== admission.acquiredContent.sha256 || coverage.closureDigest !== admission.closure.digest
      || coverage.termsSha256 !== (authority.currentTerms?.sha256 ?? null) || coverage.termsVersion !== (authority.currentTerms?.version ?? null)
      || !verified(coverage.evidenceRefs)) {
      report('client-coverage-unverified');
    } else collect(coverage.evidenceRefs);
  }

  const requiredOperations = new Set<OperationRight['operation']>([operation]);
  if (operation === 'reuse-private-project') requiredOperations.add('incorporate-project');
  if (authority.visibility === 'reusable-distribution') requiredOperations.add('redistribute-unit');
  const applicable: RightsAssessment[] = [];
  // Selected plan records cannot hide current server restrictions.
  for (const selected of assessments) {
    if (!authority.authorizedAssessments.some(record => isDeepStrictEqual(record, selected))) report('authority-unverified', null, selected.id);
  }
  const seen = new Map<string, RightsAssessment>();
  const conflictingIds = new Set<string>();
  // Compare the complete authoritative snapshot before scope skips. A narrowing
  // revision cannot make an older same-id allowance authoritative again.
  for (const assessment of authority.authorizedAssessments) {
    const prior = seen.get(assessment.id);
    if (prior && !isDeepStrictEqual(prior, assessment)) conflictingIds.add(assessment.id);
    seen.set(assessment.id, assessment);
  }
  for (const assessment of authority.authorizedAssessments) {
    if (assessment.authorityScope.principalId !== authority.principalId) continue;
    if (assessment.authorityScope.kind === 'project' && assessment.authorityScope.projectId !== authority.projectId) continue;
    if (!isDeepStrictEqual(assessment.source.ref, admission.resourceRef)) continue;
    if (conflictingIds.has(assessment.id)) report('authority-unverified', null, assessment.id);
    // The same resource may be admitted independently through another channel or target.
    if (assessment.acquisitionMode !== admission.acquisition.mode) continue;
    if (assessment.operationRights.every(right => right.scope.targetScope === 'listed'
      && !right.scope.targetProfileIds.includes(authority.target.profileId))) continue;
    if (assessment.source.contentSha256 !== admission.acquiredContent.sha256
      || assessment.source.closureDigest !== admission.closure.digest
      || assessment.source.filePaths.some(file => !admission.closure.files.some(entry => entry.path === file))) {
      report('source-mismatch', null, assessment.id); continue;
    }
    if (assessment.evaluator.basis === 'owned-source-evidence' && admission.implementationOrigin !== 'owned') {
      report('authority-unverified', null, assessment.id); continue;
    }
    const terms = assessment.terms === null ? null : { version: assessment.terms.version, sha256: assessment.terms.sha256 };
    if (!isDeepStrictEqual(terms, authority.currentTerms === null ? null : { version: authority.currentTerms.version, sha256: authority.currentTerms.sha256 })) {
      report('terms-mismatch', null, assessment.id); continue;
    }
    applicable.push(assessment);
  }

  const noticeFiles = admission.closure.files.filter(file => file.role === 'notice');
  for (const file of admission.closure.files) {
    for (const required of requiredOperations) {
      let matched = false;
      let sawOperation = false;
      for (const assessment of applicable) {
        if (assessment.source.fileScope !== 'all' && !assessment.source.filePaths.includes(file.path)) continue;
        for (const right of assessment.operationRights) {
          if (right.operation !== required) continue;
          sawOperation = true;
          const projectMatches = right.scope.projectScope === 'listed'
            ? right.scope.projectIds.includes(authority.projectId)
            : right.scope.projectScope === 'any-authorized';
          if (right.scope.principalId !== authority.principalId
            || !projectMatches
            || (right.scope.targetScope !== 'any' && !right.scope.targetProfileIds.includes(authority.target.profileId))
            || right.scope.visibility !== authority.visibility) {
            continue;
          }
          matched = true;
          if (right.decision === 'blocked') { blocked = true; report('right-blocked', file.path, assessment.id); continue; }
          if (!verified(assessment.evidenceRefs) || (right.evidenceRefs.length && !verified(right.evidenceRefs))) {
            report('evidence-unverified', file.path, assessment.id); continue;
          }
          collect(right.evidenceRefs);
          if (authority.currentTerms && verified(authority.currentTerms.evidenceRefs)) collect(authority.currentTerms.evidenceRefs);
          if (right.decision === 'unknown') { report('right-unknown', file.path, assessment.id); continue; }
          for (const obligation of [...right.obligations, ...authority.requiredObligations]) {
            const fulfilled = authority.obligationReceipts.find(receipt =>
              receipt.assessmentId === assessment.id && receipt.assessmentRevision === assessment.revision
              && receipt.operation === required && receipt.sourceSha256 === admission.acquiredContent!.sha256
              && receipt.termsSha256 === (assessment.terms?.sha256 ?? null)
              && receipt.principalId === authority.principalId && receipt.projectId === authority.projectId
              && receipt.targetProfileId === authority.target.profileId && receipt.visibility === authority.visibility
              && isDeepStrictEqual(receipt.obligation, obligation) && verified(receipt.evidenceRefs)
              && isDeepStrictEqual(receipt.noticeFiles, noticeFiles)
              && (obligation.kind !== 'notice' || noticeFiles.length > 0));
            if (!fulfilled) report('obligation-unmet', file.path, assessment.id);
            else collect(fulfilled.evidenceRefs);
          }
        }
      }
      if (!matched) {
        if (sawOperation) report('scope-mismatch', file.path);
        report('file-right-missing', file.path);
      }
    }
  }
  return result();
}
