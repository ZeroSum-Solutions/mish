import { describe, expect, it } from 'vitest';
import { parseRightsAssessment, parseSourceAdmission } from '@open-design/contracts';
import { evaluateSourceOperation, mapLegacyWorkbenchOperation, type EvaluateSourceOperationInput } from '../../src/workbench/source-rights.js';

describe('legacy workbench operation semantics', () => {
  it('maps finished application export without granting reusable-source distribution', () => {
    expect(mapLegacyWorkbenchOperation('export')).toBe('export-application');
    expect(mapLegacyWorkbenchOperation('redistribution')).toBe('redistribute-unit');
  });

  it('keeps private save, private reuse and incorporation separate', () => {
    expect(mapLegacyWorkbenchOperation('private-save')).toBe('save-private-unit');
    expect(mapLegacyWorkbenchOperation('private-reuse')).toBe('reuse-private-project');
    expect(mapLegacyWorkbenchOperation('incorporation')).toBe('incorporate-project');
  });
});


function fixture(): EvaluateSourceOperationInput {
  const admission = parseSourceAdmission({
    schema: 'source-admission/1', id: 'fixture-admission', revision: 1,
    resourceRef: { sourceType: 'section', sourceId: 'react-bits', itemId: 'fixture-item', revisionOrDigest: 'fixture-v1' },
    acquiredContent: { sha256: 'a'.repeat(64), bytes: 100 }, implementationOrigin: 'official',
    acquisition: { mode: 'licensed-mcp', connectorId: 'fixture-connector', evidenceRefs: ['acquisition-proof'] },
    target: { profileId: 'fixture-react18', nativeFormat: 'react-tsx', styleRuntime: 'tailwind4' },
    closure: { digest: 'b'.repeat(64), dependencies: [], unresolved: [], files: [
      { path: 'component.tsx', sha256: 'c'.repeat(64), bytes: 60, role: 'source' },
      { path: 'NOTICE', sha256: 'd'.repeat(64), bytes: 40, role: 'notice' },
    ] }, stages: [],
  });
  const assessment = parseRightsAssessment({
    schema: 'rights-assessment/1', id: 'fixture-assessment', revision: 1,
    source: { ref: admission.resourceRef, contentSha256: 'a'.repeat(64), closureDigest: 'b'.repeat(64), fileScope: 'listed', filePaths: ['component.tsx', 'NOTICE'] },
    terms: { version: 'fixture-terms-v1', sha256: 'e'.repeat(64), canonicalUrl: null, clauseRefs: ['fixture-private-use'] },
    acquisitionMode: 'licensed-mcp', evaluator: { id: 'fixture-human', role: 'source-curator', basis: 'specific-grant' },
    authorityScope: { kind: 'source-management', principalId: 'principal-a' },
    evidenceRefs: ['terms-proof', 'grant-proof'], evaluatedAt: '2026-10-03T00:00:00.000Z',
    operationRights: [{ operation: 'incorporate-project', decision: 'allowed', reason: null,
      scope: { targetScope: 'listed', projectScope: 'listed', principalId: 'principal-a', projectIds: ['project-a'], targetProfileIds: ['fixture-react18'], visibility: 'private' },
      evidenceRefs: ['grant-proof'], obligations: [{ id: 'retain-notice', kind: 'notice', description: 'Preserve fixture notice bytes.' }],
    }],
  });
  return { admission, assessments: [assessment], operation: 'incorporate-project', authority: {
    principalId: 'principal-a', projectId: 'project-a', target: structuredClone(admission.target), visibility: 'private',
    acquisitionLicensee: { principalId: 'principal-a', connectorId: 'fixture-connector' },
    projectAuthorization: { visibility: 'private', principalId: 'principal-a', projectId: 'project-a', target: structuredClone(admission.target), evidenceRefs: ['project-proof'] },
    currentAdmission: structuredClone(admission), currentTerms: { version: 'fixture-terms-v1', sha256: 'e'.repeat(64), evidenceRefs: ['terms-proof'] },
    authorizedAssessments: [structuredClone(assessment)], verifiedEvidenceRefs: ['acquisition-proof', 'terms-proof', 'grant-proof', 'notice-proof', 'project-proof'],
    requiredObligations: [], projectUse: 'own', clientCoverage: null,
    obligationReceipts: [{ assessmentId: 'fixture-assessment', assessmentRevision: 1, operation: 'incorporate-project',
      sourceSha256: 'a'.repeat(64), termsSha256: 'e'.repeat(64), principalId: 'principal-a', projectId: 'project-a',
      targetProfileId: 'fixture-react18', visibility: 'private', obligation: structuredClone(assessment.operationRights[0]!.obligations[0]!),
      noticeFiles: [structuredClone(admission.closure.files[1]!)], evidenceRefs: ['notice-proof'],
    }],
  } };
}

function trustAssessments(input: EvaluateSourceOperationInput) {
  input.authority.authorizedAssessments = structuredClone(input.assessments);
}
function expectDecision(input: EvaluateSourceOperationInput, decision: 'allowed' | 'blocked' | 'unknown', reason?: string) {
  const result = evaluateSourceOperation(input);
  expect(result.decision).toBe(decision);
  if (reason) expect(result.reasons).toEqual(expect.arrayContaining([expect.objectContaining({ code: reason })]));
  return result;
}

describe('inactive source-operation policy', () => {
  it('allows only exact current source, human assessment, target and fulfilled notice evidence', () => {
    const input = fixture(); const before = structuredClone(input);
    expect(expectDecision(input, 'allowed').evidenceRefs).toEqual(expect.arrayContaining(['acquisition-proof', 'terms-proof', 'grant-proof', 'notice-proof', 'project-proof']));
    expect(input).toEqual(before);
  });
  it('blocks a cross-principal caller despite an allowed assessment', () => {
    const input = fixture(); input.authority.principalId = 'principal-b';
    expectDecision(input, 'blocked', 'principal-mismatch');
  });
  it('does not trust schema-valid assessment provenance or altered decisions under the same id', () => {
    const input = fixture(); input.assessments[0]!.evaluatedAt = '2026-10-03T00:00:01.000Z';
    expectDecision(input, 'unknown', 'authority-unverified');
  });
  it.each(['item', 'revision', 'registry', 'closure', 'file', 'role', 'acquisition'] as const)('reports caller-record %s divergence from the current server admission', field => {
    const input = fixture(); const a = input.admission;
    if (field === 'item') a.resourceRef.itemId = 'other-item';
    if (field === 'revision') a.resourceRef.revisionOrDigest = 'fixture-v2';
    if (field === 'registry') a.acquiredContent!.sha256 = 'f'.repeat(64);
    if (field === 'closure') a.closure.digest = 'f'.repeat(64);
    if (field === 'file') a.closure.files[0]!.sha256 = 'f'.repeat(64);
    if (field === 'role') a.closure.files[0]!.role = 'asset';
    if (field === 'acquisition') a.acquisition.mode = 'project-fetch';
    expectDecision(input, 'unknown', 'source-mismatch');
  });
  it.each(['version', 'sha256'] as const)('requires current terms %s', field => {
    const input = fixture(); input.authority.currentTerms![field] = field === 'version' ? 'fixture-terms-v2' : 'f'.repeat(64);
    expectDecision(input, 'unknown', 'terms-mismatch');
  });
  it('requires source/file bindings even for an authorized human record', () => {
    const input = fixture(); input.assessments[0]!.source.contentSha256 = 'c'.repeat(64); trustAssessments(input);
    expectDecision(input, 'unknown', 'source-mismatch');
  });
  it.each(['profileId', 'nativeFormat', 'styleRuntime'] as const)('requires the exact target %s', field => {
    const input = fixture();
    if (field === 'profileId') input.authority.target.profileId = 'other-target';
    if (field === 'nativeFormat') input.authority.target.nativeFormat = 'html';
    if (field === 'styleRuntime') input.authority.target.styleRuntime = 'css';
    input.authority.projectAuthorization!.target = structuredClone(input.authority.target);
    expectDecision(input, 'unknown', 'target-mismatch');
  });
  it('does not widen an assessment to an unrelated project', () => {
    const input = fixture(); input.authority.projectId = 'project-b'; input.authority.projectAuthorization!.projectId = 'project-b';
    expectDecision(input, 'unknown', 'scope-mismatch');
  });
  it('requires current acquisition and rights evidence, rather than evidence ids alone', () => {
    const input = fixture(); input.authority.verifiedEvidenceRefs = ['acquisition-proof', 'notice-proof', 'project-proof'];
    expectDecision(input, 'unknown', 'evidence-unverified');
  });
  it('requires every source/notice file, not just a permitted component file', () => {
    const input = fixture(); input.assessments[0]!.source.filePaths = ['component.tsx']; trustAssessments(input);
    expectDecision(input, 'unknown', 'file-right-missing');
  });
  it('lets a notice-file denial override another permitted file and unresolved closure', () => {
    const input = fixture(); const blocked = structuredClone(input.assessments[0]!);
    input.assessments[0]!.source.filePaths = ['component.tsx']; blocked.id = 'notice-denial'; blocked.source.filePaths = ['NOTICE'];
    blocked.operationRights[0]!.decision = 'blocked'; blocked.operationRights[0]!.reason = 'Fixture notice restriction.';
    input.assessments = [...input.assessments, blocked]; trustAssessments(input);
    input.admission.closure.unresolved = [{ kind: 'asset', id: 'unknown-asset', reason: 'Unresolved fixture asset.' }];
    input.authority.currentAdmission = structuredClone(input.admission);
    expectDecision(input, 'blocked', 'right-blocked');
  });
  it('lets file denial dominate an unknown assessment regardless of order', () => {
    const input = fixture(); const deny = structuredClone(input.assessments[0]!); const unknown = structuredClone(deny);
    deny.operationRights[0]!.decision = 'blocked'; deny.operationRights[0]!.reason = 'Denied.';
    unknown.id = 'unknown-assessment'; unknown.operationRights[0]!.decision = 'unknown'; unknown.operationRights[0]!.reason = 'Pending.';
    input.assessments = [unknown, deny]; trustAssessments(input); expectDecision(input, 'blocked');
    input.assessments = [deny, unknown]; expectDecision(input, 'blocked');
  });
  it('does not let a permitted assessment override an applicable unknown', () => {
    const input = fixture(); const unknown = structuredClone(input.assessments[0]!); unknown.id = 'unknown-assessment';
    unknown.operationRights[0]!.decision = 'unknown'; unknown.operationRights[0]!.reason = 'Pending.';
    input.assessments = [...input.assessments, unknown]; trustAssessments(input);
    expectDecision(input, 'unknown', 'right-unknown');
  });
  it.each(['missing', 'bytes', 'kind', 'source', 'terms', 'principal', 'project', 'target', 'operation', 'evidence'] as const)('refuses %s notice-obligation proof', fault => {
    const input = fixture(); const proof = input.authority.obligationReceipts[0]!;
    if (fault === 'missing') input.authority.obligationReceipts = [];
    if (fault === 'bytes') proof.noticeFiles = [{ ...proof.noticeFiles[0]!, sha256: 'f'.repeat(64) }];
    if (fault === 'kind') proof.obligation.kind = 'other';
    if (fault === 'source') proof.sourceSha256 = 'f'.repeat(64);
    if (fault === 'terms') proof.termsSha256 = 'f'.repeat(64);
    if (fault === 'principal') proof.principalId = 'principal-b';
    if (fault === 'project') proof.projectId = 'project-b';
    if (fault === 'target') proof.targetProfileId = 'other-target';
    if (fault === 'operation') proof.operation = 'export-application';
    if (fault === 'evidence') proof.evidenceRefs = ['unverified-notice-proof'];
    expectDecision(input, 'unknown', 'obligation-unmet');
  });
  it('requires additional obligations imposed by the server target policy', () => {
    const input = fixture(); input.authority.requiredObligations = [{ id: 'target-policy', kind: 'target', description: 'Fixture target condition.' }];
    expectDecision(input, 'unknown', 'obligation-unmet');
  });
  it('requires explicit current covered-client project evidence', () => {
    const input = fixture(); input.authority.projectUse = 'covered-client';
    expectDecision(input, 'unknown', 'client-coverage-unverified');
    input.authority.clientCoverage = { visibility: 'private', target: structuredClone(input.authority.target), sourceSha256: 'a'.repeat(64), closureDigest: 'b'.repeat(64), termsSha256: 'e'.repeat(64), termsVersion: 'fixture-terms-v1', principalId: 'principal-a', projectId: 'project-a', evidenceRefs: ['client-proof'] };
    expectDecision(input, 'unknown', 'client-coverage-unverified');
    input.authority.verifiedEvidenceRefs = [...input.authority.verifiedEvidenceRefs, 'client-proof'];
    expectDecision(input, 'allowed');
  });
  it('keeps preview visibility principal scoped', () => {
    const input = fixture(); input.operation = 'host-preview'; input.assessments[0]!.operationRights[0]!.operation = 'host-preview';
    input.assessments[0]!.operationRights[0]!.scope.visibility = 'finished-application';
    input.assessments[0]!.operationRights[0]!.obligations = [];
    input.authority.visibility = 'finished-application'; input.authority.projectAuthorization!.visibility = 'finished-application';
    trustAssessments(input); expectDecision(input, 'unknown', 'scope-mismatch');
  });
  it('does not reuse finished-application export for reusable-unit distribution', () => {
    const input = fixture(); input.operation = 'redistribute-unit';
    input.assessments[0]!.operationRights[0]!.operation = mapLegacyWorkbenchOperation('export');
    input.assessments[0]!.operationRights[0]!.scope.visibility = 'finished-application'; trustAssessments(input);
    input.authority.visibility = 'reusable-distribution'; input.authority.projectAuthorization!.visibility = 'reusable-distribution';
    expectDecision(input, 'unknown', 'file-right-missing');
  });
  it('enforces an explicit reusable-distribution restriction without invalidating incorporation', () => {
    const input = fixture(); const blocked = structuredClone(input.assessments[0]!.operationRights[0]!);
    blocked.operation = 'redistribute-unit'; blocked.scope.visibility = 'reusable-distribution';
    blocked.decision = 'blocked'; blocked.reason = 'Fixture reusable-distribution restriction.';
    input.assessments[0]!.operationRights.push(blocked); trustAssessments(input);
    expectDecision(input, 'allowed'); input.operation = 'redistribute-unit'; input.authority.visibility = 'reusable-distribution'; input.authority.projectAuthorization!.visibility = 'reusable-distribution';
    expectDecision(input, 'blocked', 'right-blocked');
  });
  it('blocks revoked server project authority even when source rights are allowed', () => {
    const input = fixture(); input.authority.projectAuthorization = null;
    expectDecision(input, 'blocked', 'project-authority-unverified');
  });
  it('matches the assessment closure digest separately from the acquired registry body', () => {
    const input = fixture(); input.assessments[0]!.source.closureDigest = 'f'.repeat(64); trustAssessments(input);
    expectDecision(input, 'unknown', 'source-mismatch');
  });
  it('supports explicit all-file assessment scope without an implicit empty-list wildcard', () => {
    const input = fixture(); input.assessments[0]!.source.fileScope = 'all'; input.assessments[0]!.source.filePaths = [];
    trustAssessments(input); expectDecision(input, 'allowed');
  });
  it('intersects broad allowed and narrow denied/unknown project scopes', () => {
    const input = fixture(); const right = input.assessments[0]!.operationRights[0]!; const restriction = structuredClone(right);
    right.scope.projectScope = 'any-authorized'; right.scope.projectIds = [];
    restriction.decision = 'blocked'; restriction.reason = 'Narrow project restriction.';
    input.assessments[0]!.operationRights.push(restriction); trustAssessments(input);
    expectDecision(input, 'blocked', 'right-blocked');
    restriction.decision = 'unknown'; restriction.reason = 'Pending scoped grant.'; trustAssessments(input);
    expectDecision(input, 'unknown', 'right-unknown');
  });
  it('does not apply an unrelated narrow restriction to an authorized broader grant', () => {
    const input = fixture(); const right = input.assessments[0]!.operationRights[0]!; const restriction = structuredClone(right);
    right.scope.projectScope = 'any-authorized'; right.scope.projectIds = [];
    restriction.scope.projectIds = ['project-b']; restriction.decision = 'blocked'; restriction.reason = 'Other project only.';
    input.assessments[0]!.operationRights.push(restriction); trustAssessments(input); expectDecision(input, 'allowed');
  });
  it('requires incorporation as well as private reuse permission', () => {
    const input = fixture(); input.operation = 'reuse-private-project';
    input.assessments[0]!.operationRights[0]!.operation = 'reuse-private-project'; trustAssessments(input);
    expectDecision(input, 'unknown', 'file-right-missing');
  });
  it('requires redistribution when incorporation targets reusable-distribution visibility', () => {
    const input = fixture(); input.authority.visibility = 'reusable-distribution'; input.authority.projectAuthorization!.visibility = 'reusable-distribution';
    input.assessments[0]!.operationRights[0]!.scope.visibility = 'reusable-distribution'; trustAssessments(input);
    expectDecision(input, 'unknown', 'file-right-missing');
  });
  it('reports only the exact obligation receipt that fulfilled the current scope', () => {
    const input = fixture(); const foreign = structuredClone(input.authority.obligationReceipts[0]!);
    foreign.projectId = 'project-b'; foreign.evidenceRefs = ['foreign-notice-proof'];
    input.authority.verifiedEvidenceRefs = [...input.authority.verifiedEvidenceRefs, 'foreign-notice-proof'];
    input.authority.obligationReceipts = [...input.authority.obligationReceipts, foreign];
    expect(expectDecision(input, 'allowed').evidenceRefs).not.toContain('foreign-notice-proof');
  });

  it('cannot omit an authorized server-held denial from the selected assessments', () => {
    const input = fixture(); const denied = structuredClone(input.assessments[0]!); denied.id = 'server-denial';
    denied.operationRights[0]!.decision = 'blocked'; denied.operationRights[0]!.reason = 'Server-held restriction.';
    input.authority.authorizedAssessments = [...input.authority.authorizedAssessments, denied];
    expectDecision(input, 'blocked', 'right-blocked');
  });
  it('cannot select an older allow while the server also holds a newer restriction', () => {
    const input = fixture(); const newer = structuredClone(input.assessments[0]!); newer.revision = 2;
    newer.operationRights[0]!.decision = 'blocked'; newer.operationRights[0]!.reason = 'Newer restriction.';
    input.authority.authorizedAssessments = [...input.authority.authorizedAssessments, newer];
    expectDecision(input, 'blocked', 'right-blocked');
  });
  it('requires reconciliation of ambiguous authoritative revisions even if both allow', () => {
    const input = fixture(); const newer = structuredClone(input.assessments[0]!); newer.revision = 2;
    input.authority.authorizedAssessments = [...input.authority.authorizedAssessments, newer];
    expectDecision(input, 'unknown', 'authority-unverified');
  });
  it('ignores another principal or project human assessment without granting their scope', () => {
    const input = fixture(); const foreign = structuredClone(input.assessments[0]!); foreign.id = 'foreign-principal';
    foreign.authorityScope.principalId = 'principal-b'; foreign.operationRights[0]!.scope.principalId = 'principal-b';
    const otherProject = structuredClone(input.assessments[0]!); otherProject.id = 'foreign-project';
    otherProject.evaluator.role = 'project-owner'; otherProject.authorityScope = { kind: 'project', principalId: 'principal-a', projectId: 'project-b' };
    otherProject.operationRights[0]!.scope.projectIds = ['project-b'];
    input.assessments = [...input.assessments, foreign, otherProject]; trustAssessments(input); expectDecision(input, 'allowed');
  });
  it('preserves a current-terms server restriction while other evidence is unavailable', () => {
    const input = fixture(); const denied = input.assessments[0]!;
    denied.evidenceRefs.push('unavailable-proof'); denied.operationRights[0]!.evidenceRefs.push('unavailable-proof');
    denied.operationRights[0]!.decision = 'blocked'; denied.operationRights[0]!.reason = 'Current-terms restriction.';
    trustAssessments(input); expectDecision(input, 'blocked', 'right-blocked');
  });
  it('requires reassessment of an old-term denial instead of claiming it applies to new terms', () => {
    const input = fixture(); input.assessments[0]!.operationRights[0]!.decision = 'blocked';
    input.assessments[0]!.operationRights[0]!.reason = 'Old-term restriction.'; trustAssessments(input);
    input.authority.currentTerms!.sha256 = 'f'.repeat(64);
    expectDecision(input, 'unknown', 'terms-mismatch');
  });
  it('does not fulfill a notice obligation with zero preserved notice bytes', () => {
    const input = fixture(); input.admission.closure.files = [input.admission.closure.files[0]!];
    input.authority.currentAdmission = structuredClone(input.admission); input.assessments[0]!.source.filePaths = ['component.tsx'];
    input.authority.obligationReceipts[0]!.noticeFiles = []; trustAssessments(input);
    expectDecision(input, 'unknown', 'obligation-unmet');
  });
  it('requires current notice bytes for attribution receipts too', () => {
    const input = fixture(); input.assessments[0]!.operationRights[0]!.obligations[0]!.kind = 'attribution'; trustAssessments(input);
    input.authority.obligationReceipts[0]!.obligation.kind = 'attribution';
    input.authority.obligationReceipts[0]!.noticeFiles = [{ ...input.admission.closure.files[1]!, sha256: 'f'.repeat(64) }];
    expectDecision(input, 'unknown', 'obligation-unmet');
  });
  it('binds licensed acquisition to the current licence principal and connector', () => {
    const input = fixture(); input.authority.acquisitionLicensee!.principalId = 'principal-b';
    expectDecision(input, 'blocked', 'principal-mismatch');
    input.authority.acquisitionLicensee!.principalId = 'principal-a'; input.authority.acquisitionLicensee!.connectorId = 'other-connector';
    expectDecision(input, 'unknown', 'acquisition-unverified');
  });
  it('does not widen private project authority into reusable-distribution authority', () => {
    const input = fixture(); input.operation = 'redistribute-unit'; input.authority.visibility = 'reusable-distribution';
    const right = input.assessments[0]!.operationRights[0]!; right.operation = 'redistribute-unit'; right.scope.visibility = 'reusable-distribution';
    trustAssessments(input); expectDecision(input, 'blocked', 'project-authority-unverified');
  });
  it('does not borrow covered-client evidence for another source or terms', () => {
    const input = fixture(); input.authority.projectUse = 'covered-client';
    input.authority.clientCoverage = { principalId: 'principal-a', projectId: 'project-a', visibility: 'private', target: structuredClone(input.authority.target),
      sourceSha256: 'f'.repeat(64), closureDigest: 'b'.repeat(64), termsSha256: 'e'.repeat(64), termsVersion: 'fixture-terms-v1', evidenceRefs: ['grant-proof'] };
    expectDecision(input, 'unknown', 'client-coverage-unverified');
  });
  it('gates unresolved dependency versions and integrity even without an explicit unresolved row', () => {
    const input = fixture(); input.admission.closure.dependencies = [{ name: 'fixture-package', version: null, integrity: null, contentSha256: null }];
    input.authority.currentAdmission = structuredClone(input.admission);
    expectDecision(input, 'unknown', 'closure-unresolved');
  });
  it('does not report evidence from an unrelated project grant', () => {
    const input = fixture(); const unrelated = structuredClone(input.assessments[0]!); unrelated.id = 'unrelated-project';
    unrelated.evidenceRefs.push('unrelated-proof'); unrelated.operationRights[0]!.scope.projectIds = ['project-b'];
    unrelated.operationRights[0]!.evidenceRefs = ['unrelated-proof'];
    input.assessments = [...input.assessments, unrelated]; trustAssessments(input); input.authority.verifiedEvidenceRefs = [...input.authority.verifiedEvidenceRefs, 'unrelated-proof'];
    expect(expectDecision(input, 'allowed').evidenceRefs).not.toContain('unrelated-proof');
  });
  it('does not treat licence holding or official acquisition as owned-source evidence', () => {
    const input = fixture(); input.assessments[0]!.evaluator.basis = 'owned-source-evidence';
    input.assessments[0]!.terms = null; input.authority.currentTerms = null; trustAssessments(input);
    expectDecision(input, 'unknown', 'authority-unverified');
  });

  it.each(['ref', 'acquisition', 'file-path'] as const)('matches authoritative assessment %s, independently of admission-record equality', field => {
    const input = fixture(); const assessment = input.assessments[0]!;
    if (field === 'ref') assessment.source.ref = { ...assessment.source.ref, itemId: 'other-resource' };
    if (field === 'acquisition') assessment.acquisitionMode = 'project-fetch';
    if (field === 'file-path') assessment.source.filePaths = ['other-file.tsx'];
    trustAssessments(input);
    expectDecision(input, 'unknown', field === 'file-path' ? 'source-mismatch' : 'file-right-missing');
  });
  it('allows actual private preview with matching action-bound evidence', () => {
    const input = fixture(); input.operation = 'host-preview'; input.assessments[0]!.operationRights[0]!.operation = 'host-preview';
    input.authority.obligationReceipts[0]!.operation = 'host-preview'; trustAssessments(input);
    expectDecision(input, 'allowed');
  });
  it('allows private reuse only with both reuse and target incorporation evidence', () => {
    const input = fixture(); const reuse = structuredClone(input.assessments[0]!.operationRights[0]!); reuse.operation = 'reuse-private-project';
    input.assessments[0]!.operationRights.push(reuse); trustAssessments(input);
    const proof = structuredClone(input.authority.obligationReceipts[0]!); proof.operation = 'reuse-private-project';
    input.authority.obligationReceipts = [...input.authority.obligationReceipts, proof]; input.operation = 'reuse-private-project';
    expectDecision(input, 'allowed');
  });

  it('supports explicit any-target allowance without bypassing current project-target authority', () => {
    const input = fixture(); const right = input.assessments[0]!.operationRights[0]!;
    right.scope.targetScope = 'any'; right.scope.targetProfileIds = []; trustAssessments(input);
    expectDecision(input, 'allowed'); input.authority.projectAuthorization!.target.profileId = 'other-target';
    expectDecision(input, 'blocked', 'project-authority-unverified');
  });
  it('applies an explicit any-target restriction over a listed-target allowance', () => {
    const input = fixture(); const restriction = structuredClone(input.assessments[0]!.operationRights[0]!);
    restriction.scope.targetScope = 'any'; restriction.scope.targetProfileIds = [];
    restriction.decision = 'blocked'; restriction.reason = 'Any-target restriction.';
    input.assessments[0]!.operationRights.push(restriction); trustAssessments(input);
    expectDecision(input, 'blocked', 'right-blocked');
  });
  it('does not treat project-unbound preview permission as a wildcard for this project', () => {
    const input = fixture(); input.operation = 'host-preview'; const right = input.assessments[0]!.operationRights[0]!;
    right.operation = 'host-preview'; right.scope.projectScope = 'unbound'; right.scope.projectIds = [];
    right.obligations = []; trustAssessments(input); expectDecision(input, 'unknown', 'scope-mismatch');
  });
  it('accepts dependency byte pins while refusing SHA1-only integrity', () => {
    const input = fixture(); input.admission.closure.dependencies = [{ name: 'fixture-package', version: '1.0.0', integrity: null, contentSha256: 'f'.repeat(64) }];
    input.authority.currentAdmission = structuredClone(input.admission); expectDecision(input, 'allowed');
    input.admission.closure.dependencies[0]!.contentSha256 = null; input.admission.closure.dependencies[0]!.integrity = 'sha1-YWJj';
    input.authority.currentAdmission = structuredClone(input.admission); expectDecision(input, 'unknown', 'closure-unresolved');
  });

  it.each(['channel', 'target'] as const)('ignores a sibling admission assessment for another %s', binding => {
    const input = fixture(); const sibling = structuredClone(input.assessments[0]!); sibling.id = 'sibling-assessment';
    sibling.source.closureDigest = 'f'.repeat(64);
    if (binding === 'channel') { sibling.acquisitionMode = 'reference-link'; sibling.operationRights[0]!.operation = 'derive-from-reference'; }
    if (binding === 'target') sibling.operationRights[0]!.scope.targetProfileIds = ['fixture-vue'];
    input.authority.authorizedAssessments = [...input.authority.authorizedAssessments, sibling];
    expectDecision(input, 'allowed');
  });
  it('preserves current server denial when the caller supplies a mismatched admission', () => {
    const input = fixture(); const denied = structuredClone(input.assessments[0]!); denied.id = 'server-denial';
    denied.operationRights[0]!.decision = 'blocked'; denied.operationRights[0]!.reason = 'Current restriction.';
    input.authority.authorizedAssessments = [...input.authority.authorizedAssessments, denied];
    input.admission.closure.digest = 'f'.repeat(64);
    const result = expectDecision(input, 'blocked', 'right-blocked');
    expect(result.reasons).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'source-mismatch' })]));
  });
  it('does not return unverified current terms as decision evidence', () => {
    const input = fixture(); input.authority.currentTerms!.evidenceRefs = ['unverified-current-terms'];
    expect(expectDecision(input, 'unknown', 'evidence-unverified').evidenceRefs).not.toContain('unverified-current-terms');
  });
  it.each(['target', 'channel', 'principal', 'ref'] as const)('requires reconciliation when a same-id revision changes %s scope', binding => {
    const input = fixture(); const newer = structuredClone(input.assessments[0]!); newer.revision = 2;
    if (binding === 'target') newer.operationRights[0]!.scope.targetProfileIds = ['fixture-vue'];
    if (binding === 'channel') newer.acquisitionMode = 'project-fetch';
    if (binding === 'principal') { newer.authorityScope.principalId = 'principal-b'; newer.operationRights[0]!.scope.principalId = 'principal-b'; }
    if (binding === 'ref') newer.source.ref = { ...newer.source.ref, itemId: 'other-resource' };
    input.authority.authorizedAssessments = [...input.authority.authorizedAssessments, newer];
    expectDecision(input, 'unknown', 'authority-unverified');
    input.authority.authorizedAssessments = [...input.authority.authorizedAssessments].reverse();
    expectDecision(input, 'unknown', 'authority-unverified');
  });
  it('keeps a stale assessment relevant when any of its rights reaches the current target', () => {
    const input = fixture(); const mixed = structuredClone(input.assessments[0]!); mixed.id = 'mixed-targets'; mixed.source.closureDigest = 'f'.repeat(64);
    const other = structuredClone(mixed.operationRights[0]!); other.scope.targetProfileIds = ['fixture-vue'];
    mixed.operationRights.push(other); input.authority.authorizedAssessments = [...input.authority.authorizedAssessments, mixed];
    expectDecision(input, 'unknown', 'source-mismatch');
  });

});
