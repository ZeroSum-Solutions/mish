import { describe, expect, it } from 'vitest';
import { parseRightsAssessment, parseSourceAdmission } from '../src/api/workbench-source-admission.js';

const rawDigest = 'a'.repeat(64);
const fileDigest = 'b'.repeat(64);
const ref = { sourceType: 'genui', sourceId: 'react-bits', itemId: '@reactbits-pro/hero-16', revisionOrDigest: `sha256:${rawDigest}` };
const source = {
  schema: 'source-admission/1', id: 'source-1', revision: 1, resourceRef: ref,
  acquiredContent: { sha256: rawDigest, bytes: 4166 }, implementationOrigin: 'official',
  acquisition: { mode: 'licensed-mcp', connectorId: 'licensed-react-bits', evidenceRefs: ['acquisition-1'] },
  target: { profileId: 'react-source-v1', nativeFormat: 'react-tsx', styleRuntime: 'tailwind4' },
  closure: {
    digest: 'c'.repeat(64), files: [{ path: 'hero.tsx', sha256: fileDigest, bytes: 3690, role: 'source' }],
    dependencies: [{ name: 'motion', version: '12.40.0', integrity: null, contentSha256: null }], unresolved: [],
  },
  stages: [{ stage: 'inventoried', status: 'passed', sourceDigest: rawDigest, evidenceRefs: ['inventory-1'] }],
};
const scope = { projectScope: 'listed', targetScope: 'listed', principalId: 'licensed-owner', projectIds: ['project-a'], targetProfileIds: ['react-source-v1'], visibility: 'private' };
const assessment = {
  schema: 'rights-assessment/1', id: 'assessment-1', revision: 1,
  source: { ref, contentSha256: rawDigest, closureDigest: 'c'.repeat(64), fileScope: 'listed', filePaths: ['hero.tsx'] },
  terms: { version: '2.2', sha256: 'd'.repeat(64), canonicalUrl: 'https://example.com/license', clauseRefs: ['section-2.2'] },
  acquisitionMode: 'licensed-mcp', evaluator: { id: 'curator-1', role: 'source-curator', basis: 'specific-grant' },
  authorityScope: { kind: 'source-management', principalId: 'licensed-owner' },
  evidenceRefs: ['held-terms-1'], evaluatedAt: '2026-10-04T02:00:00Z',
  operationRights: [{ operation: 'incorporate-project', decision: 'allowed', scope, evidenceRefs: ['held-terms-1'], obligations: [{ id: 'notice-1', kind: 'notice', description: 'Retain the applicable notice' }], reason: null }],
};

describe('immutable source record boundary', () => {
  it('retains registry identity separately from original source-file bytes', () => {
    expect(parseSourceAdmission(source)).toMatchObject({ acquiredContent: { sha256: rawDigest }, closure: { files: [{ sha256: fileDigest }] } });
  });
  it.each([
    { acquiredContent: { sha256: 'unknown', bytes: 4166 } },
    { revision: 0 }, { revision: Number.MAX_SAFE_INTEGER + 1 },
    { apiKey: 'not-a-credential' }, { acquisition: { ...source.acquisition, url: 'https://example.com/?key=not-a-credential' } },
    { acquiredContent: { sha256: rawDigest, bytes: -1 } },
  ])('rejects malformed or credential-bearing record fields: %j', patch => {
    expect(() => parseSourceAdmission({ ...source, ...patch })).toThrow();
  });
  it.each(['../outside.tsx', '/absolute.tsx', 'C:/outside.tsx', 'a//b.tsx', './hero.tsx', 'a\\b.tsx', 'a/../b.tsx', 'bad\u0000.tsx'])('rejects unnormalized source path %s', path => {
    expect(() => parseSourceAdmission({ ...source, closure: { ...source.closure, files: [{ ...source.closure.files[0], path }] } })).toThrow();
  });
  it('rejects duplicate closure ownership and repeated stage entries', () => {
    expect(() => parseSourceAdmission({ ...source, closure: { ...source.closure, files: [...source.closure.files, ...source.closure.files] } })).toThrow();
    expect(() => parseSourceAdmission({ ...source, stages: [...source.stages, ...source.stages] })).toThrow();
  });
  it('rejects passed evidence for another acquired revision or with no evidence', () => {
    for (const patch of [{ sourceDigest: fileDigest }, { evidenceRefs: [] }, { sourceDigest: null }]) {
      expect(() => parseSourceAdmission({ ...source, stages: [{ ...source.stages[0], ...patch }] })).toThrow();
    }
  });
  it('keeps missing source content explicit while later proof remains pending', () => {
    expect(parseSourceAdmission({ ...source, acquiredContent: null, stages: [{ stage: 'preview-verified', status: 'pending', sourceDigest: null, evidenceRefs: [] }] })).toMatchObject({ acquiredContent: null });
    expect(() => parseSourceAdmission({ ...source, acquiredContent: null })).toThrow();
  });
});

describe('dependency-byte and restriction target counterexamples', () => {
  it('allows a deliberately assessed any-target grant without granting another operation', () => {
    const right = { ...assessment.operationRights[0], operation: 'cache-source-content', scope: { ...scope, targetScope: 'any', targetProfileIds: [] } };
    expect(parseRightsAssessment({ ...assessment, operationRights: [right] })).toMatchObject({ operationRights: [{ operation: 'cache-source-content', scope: { targetScope: 'any' } }] });
  });
  it('distinguishes any target restriction from an invalid empty listed target', () => {
    const right = { ...assessment.operationRights[0], decision: 'blocked', reason: 'Restriction applies' };
    expect(() => parseRightsAssessment({ ...assessment, operationRights: [{ ...right, scope: { ...scope, targetProfileIds: [] } }] })).toThrow();
    expect(parseRightsAssessment({ ...assessment, operationRights: [{ ...right, scope: { ...scope, targetScope: 'any', targetProfileIds: [] } }] })).toMatchObject({ operationRights: [{ scope: { targetScope: 'any' } }] });
    expect(() => parseRightsAssessment({ ...assessment, operationRights: [{ ...right, scope: { ...scope, targetScope: 'any' } }] })).toThrow();
  });
  it.each([null, 'sha1-' + 'A'.repeat(27) + '=', 'sha512-A'])('cannot qualify a technical pass with an unpinned or malformed dependency: %s', integrity => {
    const dependency = { ...source.closure.dependencies[0], integrity };
    expect(() => parseSourceAdmission({ ...source, closure: { ...source.closure, dependencies: [dependency] }, stages: [{ ...source.stages[0], stage: 'source-compatible' }] })).toThrow();
  });
  it('can qualify complete technical evidence using captured bytes or valid strong registry integrity', () => {
    for (const patch of [
      { contentSha256: fileDigest }, { integrity: 'sha256-' + 'A'.repeat(43) + '=' },
      { integrity: 'sha384-' + 'A'.repeat(64) }, { integrity: 'sha512-' + 'A'.repeat(86) + '==' },
      { integrity: 'sha1-' + 'A'.repeat(27) + '= sha256-' + 'A'.repeat(43) + '=' },
    ]) {
      expect(parseSourceAdmission({ ...source, closure: { ...source.closure, dependencies: [{ ...source.closure.dependencies[0], ...patch }] }, stages: [{ ...source.stages[0], stage: 'source-compatible' }] })).toMatchObject({ stages: [{ status: 'passed' }] });
    }
  });
  it('rejects noncanonical final base64 padding bits even at the correct encoded length', () => {
    for (const integrity of ['sha256-' + 'A'.repeat(42) + 'B=', 'sha512-' + 'A'.repeat(85) + 'B==']) {
      expect(() => parseSourceAdmission({ ...source, closure: { ...source.closure, dependencies: [{ ...source.closure.dependencies[0], integrity }] } })).toThrow();
    }
  });
  it.each(['git+https://not-a-credential@example.com/repo', 'react\u200B', 'react/react'])('rejects non-package dependency name %s', name => {
    expect(() => parseSourceAdmission({ ...source, closure: { ...source.closure, dependencies: [{ ...source.closure.dependencies[0], name }] } })).toThrow();
  });
  it('rejects hidden format characters in authoritative version/clause identity', () => {
    expect(() => parseRightsAssessment({ ...assessment, terms: { ...assessment.terms, version: '2.2\u200B' } })).toThrow();
    expect(() => parseRightsAssessment({ ...assessment, terms: { ...assessment.terms, clauseRefs: ['section-2.2\u200B'] } })).toThrow();
  });
});

describe('reviewed source and scope counterexamples', () => {
  it('rejects ambiguous empty project scopes, but preserves explicit unbound preview scope', () => {
    const right = assessment.operationRights[0];
    expect(() => parseRightsAssessment({ ...assessment, operationRights: [{ ...right, scope: { ...scope, projectIds: [] } }] })).toThrow();
    expect(parseRightsAssessment({ ...assessment, operationRights: [{ ...right, operation: 'host-preview', scope: { ...scope, projectScope: 'unbound', projectIds: [] } }] })).toMatchObject({ operationRights: [{ scope: { projectScope: 'unbound' } }] });
    expect(() => parseRightsAssessment({ ...assessment, operationRights: [{ ...right, scope: { ...scope, projectScope: 'unbound', projectIds: [] } }] })).toThrow();
  });
  it('rejects vacuous allowed target scope and contradictory file selection', () => {
    expect(() => parseRightsAssessment({ ...assessment, operationRights: [{ ...assessment.operationRights[0], scope: { ...scope, targetProfileIds: [] } }] })).toThrow();
    expect(() => parseRightsAssessment({ ...assessment, source: { ...assessment.source, filePaths: [] } })).toThrow();
    expect(() => parseRightsAssessment({ ...assessment, source: { ...assessment.source, fileScope: 'all' } })).toThrow();
    expect(parseRightsAssessment({ ...assessment, source: { ...assessment.source, fileScope: 'all', filePaths: [] } })).toMatchObject({ source: { fileScope: 'all' } });
  });
  it('rejects an assessment with no immutable closure binding', () => {
    const { closureDigest: _digest, ...unbound } = assessment.source;
    expect(() => parseRightsAssessment({ ...assessment, source: unbound })).toThrow();
  });
  it('rejects equivalent duplicate scopes regardless of set ordering', () => {
    const right = assessment.operationRights[0];
    expect(() => parseRightsAssessment({ ...assessment, operationRights: [
      { ...right, scope: { ...scope, projectIds: ['project-a', 'project-b'] } },
      { ...right, scope: { ...scope, projectIds: ['project-b', 'project-a'] } },
    ] })).toThrow();
  });
  it('retains overlapping restriction evidence for daemon deny precedence', () => {
    const right = assessment.operationRights[0];
    expect(parseRightsAssessment({ ...assessment, operationRights: [
      { ...right, scope: { ...scope, projectIds: ['project-a', 'project-b'] } },
      { ...right, decision: 'blocked', reason: 'Narrower restriction applies' },
    ] })).toMatchObject({ operationRights: [{ decision: 'allowed' }, { decision: 'blocked' }] });
  });
  it.each(['https://example.com/a\u0000b', 'https://example.com:99999/license'])('rejects invalid citation URL %s', canonicalUrl => {
    expect(() => parseRightsAssessment({ ...assessment, terms: { ...assessment.terms, canonicalUrl } })).toThrow();
  });
  it('requires licensed acquisition binding and real acquisition evidence', () => {
    for (const patch of [{ connectorId: null }, { evidenceRefs: [] }]) {
      expect(() => parseSourceAdmission({ ...source, acquisition: { ...source.acquisition, ...patch } })).toThrow();
    }
  });
  it('rejects credentials in dependency locators and impossible closure paths', () => {
    expect(() => parseSourceAdmission({ ...source, closure: { ...source.closure, dependencies: [{ name: 'pkg', version: 'git+https://not-a-credential@example.com/repo', integrity: null, contentSha256: null }] } })).toThrow();
    expect(() => parseSourceAdmission({ ...source, closure: { ...source.closure, files: [
      { ...source.closure.files[0], path: 'a' }, { ...source.closure.files[0], path: 'a/b.tsx' },
    ] } })).toThrow();
  });
  it('rejects current compatibility evidence with unresolved inputs and dangling rights evidence', () => {
    expect(() => parseSourceAdmission({ ...source, closure: { ...source.closure, unresolved: [{ kind: 'dependency', id: 'missing', reason: 'Not acquired' }] }, stages: [{ ...source.stages[0], stage: 'source-compatible' }] })).toThrow();
    expect(() => parseRightsAssessment({ ...assessment, operationRights: [{ ...assessment.operationRights[0], evidenceRefs: ['not-in-assessment'] }] })).toThrow();
  });
});

describe('operation-specific rights record boundary', () => {
  it('retains exact terms, operation, principal, target and obligations', () => {
    expect(parseRightsAssessment(assessment)).toMatchObject({ source: { contentSha256: rawDigest }, terms: { sha256: 'd'.repeat(64) }, operationRights: [{ operation: 'incorporate-project', scope, obligations: [{ id: 'notice-1' }] }] });
  });
  it.each([
    { apiKey: 'not-a-credential' }, { evaluatedAt: 'yesterday' },
    { evaluator: { ...assessment.evaluator, role: 'model' } },
    { evaluator: { ...assessment.evaluator, basis: 'model-score' } },
    { source: { ...assessment.source, contentSha256: 'missing' } },
    { terms: { ...assessment.terms, canonicalUrl: 'https://user:password@example.com/license' } },
    { terms: { ...assessment.terms, canonicalUrl: 'https://example.com/license?key=not-a-credential' } },
    { terms: null },
  ])('rejects incomplete or invented permission evidence: %j', patch => {
    expect(() => parseRightsAssessment({ ...assessment, ...patch })).toThrow();
  });
  it('does not allow a project-owner role to claim global authority or another project', () => {
    const owner = { ...assessment, evaluator: { ...assessment.evaluator, role: 'project-owner' } };
    expect(() => parseRightsAssessment(owner)).toThrow();
    const limited = { ...owner, authorityScope: { kind: 'project', principalId: 'licensed-owner', projectId: 'project-a' } };
    expect(parseRightsAssessment(limited)).toMatchObject({ authorityScope: { projectId: 'project-a' } });
    for (const projectIds of [[], ['project-b'], ['project-a', 'project-b']]) {
      expect(() => parseRightsAssessment({ ...limited, operationRights: [{ ...assessment.operationRights[0], scope: { ...scope, projectIds } }] })).toThrow();
    }
  });
  it('rejects cross-principal rights and unknown operations', () => {
    for (const patch of [{ operation: 'all-uses' }, { scope: { ...scope, principalId: 'someone-else' } }, { evidenceRefs: [] }]) {
      expect(() => parseRightsAssessment({ ...assessment, operationRights: [{ ...assessment.operationRights[0], ...patch }] })).toThrow();
    }
  });
  it('requires application and reusable-source export scopes to remain distinct', () => {
    const right = assessment.operationRights[0];
    expect(() => parseRightsAssessment({ ...assessment, operationRights: [{ ...right, operation: 'export-application' }] })).toThrow();
    expect(parseRightsAssessment({ ...assessment, operationRights: [{ ...right, operation: 'export-application', scope: { ...scope, visibility: 'finished-application' } }] })).toMatchObject({ operationRights: [{ operation: 'export-application' }] });
    expect(() => parseRightsAssessment({ ...assessment, operationRights: [{ ...right, operation: 'redistribute-unit', scope: { ...scope, visibility: 'finished-application' } }] })).toThrow();
  });
  it('preserves explicit unknown and blocked decisions without turning them into allowed', () => {
    for (const decision of ['unknown', 'blocked']) {
      expect(parseRightsAssessment({ ...assessment, operationRights: [{ ...assessment.operationRights[0], decision, reason: 'Affected operation has no permission', evidenceRefs: [] }] })).toMatchObject({ operationRights: [{ decision }] });
    }
    expect(() => parseRightsAssessment({ ...assessment, operationRights: [{ ...assessment.operationRights[0], decision: 'unknown', reason: null }] })).toThrow();
  });
});

describe('owner-accepted private use basis (G38 owner decision 2026-10-08)', () => {
  const ownerDecision = { decidedAt: '2026-10-08', decidedBy: 'owner', citation: 'Owner decision: private repository, licences ignored for now' };
  const owned = { ...assessment, evaluator: { ...assessment.evaluator, basis: 'owner-accepted-private-use' }, terms: null, ownerDecision };
  it('records an owner-accepted basis only with a dated owner-decision citation', () => {
    expect(parseRightsAssessment(owned)).toMatchObject({ evaluator: { basis: 'owner-accepted-private-use' }, ownerDecision: { decidedAt: '2026-10-08' } });
    expect(() => parseRightsAssessment({ ...owned, ownerDecision: undefined })).toThrow(/owner decision/i);
    expect(() => parseRightsAssessment({ ...owned, ownerDecision: { ...ownerDecision, decidedAt: 'recently' } })).toThrow();
    expect(() => parseRightsAssessment({ ...assessment, ownerDecision })).toThrow(/owner decision/i);
  });
  it('stays private: no allowed redistribution and only source-management authority', () => {
    const redistribute = { ...assessment.operationRights[0], operation: 'redistribute-unit', scope: { ...scope, visibility: 'reusable-distribution' } };
    expect(() => parseRightsAssessment({ ...owned, operationRights: [redistribute] })).toThrow(/private use/i);
    expect(parseRightsAssessment({ ...owned, operationRights: [{ ...redistribute, decision: 'blocked', reason: 'Outside private use', evidenceRefs: [] }] }).operationRights[0]!.decision).toBe('blocked');
    expect(() => parseRightsAssessment({ ...owned, evaluator: { ...owned.evaluator, role: 'project-owner' }, authorityScope: { kind: 'project', principalId: 'licensed-owner', projectId: 'project-a' } })).toThrow();
  });
});
