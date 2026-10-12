import { describe, expect, it } from 'vitest';
import { parseResourceDetailResponse, type ResourceResult } from '../src/api/workbench.js';
import {
  parseNativeFormatRefusalDetails, parseOperationRightsRefusalDetails, parseResourceSourceIdentity, type ResourceSourceIdentity,
} from '../src/api/workbench-reference-sources.js';
import { SOURCE_OPERATIONS } from '../src/api/workbench-source-admission.js';

/**
 * AC-R18.6/AC-R18.7/AC-R18.8 contract invariants. A reference-link identity can never be
 * dressed up as an installed, previewable or adoptable component, native Svelte material
 * always states the target mismatch, and an enlarged executable preview needs host-preview.
 */
const identity: ResourceSourceIdentity = {
  repositoryUrl: 'https://github.com/SikandarJODD/cnblocks',
  commit: '81c7209fc9696bd7823911a4b9d076f657202ef4',
  registryLocator: null,
  contentSha256: '4c152d5298fe2b9992983fcb484bd323c1f9b0b9955c1e0d96cac6b8a2f050b7',
  acquisitionMode: 'reference-link',
  documentedConnector: { name: 'jsrepo MCP', state: 'documented-unexecuted', evidenceRef: 'docs/plans/2026-10-02-design-workbench/evidence/cnblocks-trio/registry-and-mcp-observations.json' },
  operationRights: [],
  nextGate: 'G24: a named project need, scoped Svelte target support and per-item rights/build/adoption proof',
  evidenceRefs: ['docs/plans/2026-10-03-cnblocks-source-trio-evaluation.md'],
};
const reference: ResourceResult = {
  refKey: 'key',
  ref: { sourceType: 'reference', sourceId: 'cnblocks', itemId: 'veil/hero-one', revisionOrDigest: `${identity.commit}:sha256:${identity.contentSha256}` },
  title: 'Hero one (Veil)', category: 'section', readiness: 'reference-only',
  compatibility: { nativeFormat: 'svelte', targets: [], state: 'unsupported', reason: 'Native Svelte 5 source; accepted targets are HTML/CSS/JS and React.' },
  rightsStatus: 'unknown', fitReasons: [],
  previewCapability: { available: true, kind: 'reference', url: 'https://github.com/SikandarJODD/cnblocks/blob/81c7209fc9696bd7823911a4b9d076f657202ef4/src/lib/components/veil/hero/hero-one.svelte', reason: 'Pinned source link; no local preview' },
  adoptionCapability: { available: false, reason: 'unsupported-capability' },
  sourceAttribution: { title: 'SikandarJODD/cnblocks', url: 'https://github.com/SikandarJODD/cnblocks' },
  operationGrants: [], admissionStage: 'reference-only', needDecision: 'reference-only', needReason: 'Deferred under G24.',
  sourceIdentity: identity,
};
const status = { sourceId: 'cnblocks' as const, state: 'searched' as const, reason: null, itemCount: 1, listingDigest: 'd' };
const detail = (resource: ResourceResult) => parseResourceDetailResponse({ resource, sourceStatus: status });

describe('resource source identity (AC-R18.7, AC-R18.8)', () => {
  it('accepts a pinned reference-link identity with a documented, unexecuted connector', () => {
    expect(detail(reference).resource.sourceIdentity?.documentedConnector?.state).toBe('documented-unexecuted');
  });
  it('refuses an installed-connector claim, an unpinned commit or a non-HTTPS repository', () => {
    expect(() => parseResourceSourceIdentity({ ...identity, documentedConnector: { ...identity.documentedConnector, state: 'installed' } })).toThrow();
    expect(() => parseResourceSourceIdentity({ ...identity, commit: 'master' })).toThrow();
    expect(() => parseResourceSourceIdentity({ ...identity, repositoryUrl: 'http://github.com/x/y' })).toThrow();
    expect(() => parseResourceSourceIdentity({ ...identity, evidenceRefs: [] })).toThrow();
  });
  it('a reference-link source cannot be usable, admitted, adoptable or an executable preview', () => {
    expect(() => detail({ ...reference, readiness: 'unverified' })).toThrow(/reference-link/);
    expect(() => detail({ ...reference, admissionStage: 'admitted' })).toThrow(/reference-link/);
    expect(() => detail({ ...reference, previewCapability: { available: true, kind: 'html', url: '/api/x', reason: null } })).toThrow();
  });
  it('native Svelte material always states the unsupported target', () => {
    expect(() => detail({ ...reference, compatibility: { nativeFormat: 'svelte', targets: ['html'], state: 'unverified', reason: null } })).toThrow(/svelte/i);
  });
});

describe('project-fetch operation rights (AC-R18.6)', () => {
  const rights = SOURCE_OPERATIONS.map(operation => ({ operation, decision: 'unknown' as const, reason: 'No RightsAssessment recorded (G38)' }));
  const fetchIdentity: ResourceSourceIdentity = { ...identity, repositoryUrl: 'https://ui.aceternity.com', commit: null, registryLocator: 'https://ui.aceternity.com/registry/tabs.json', acquisitionMode: 'project-fetch', documentedConnector: null, operationRights: rights };
  const fetched: ResourceResult = {
    ...reference, ref: { sourceType: 'reference', sourceId: 'aceternity', itemId: 'tabs', revisionOrDigest: 'sha256:a0f2' }, readiness: 'needs-repair',
    compatibility: { nativeFormat: 'react-tsx', targets: ['react'], state: 'unverified', reason: 'react-source/v1 adoption pending' }, admissionStage: 'needs-repair', needDecision: 'required', sourceIdentity: fetchIdentity,
    previewCapability: { available: false, kind: 'none', reason: 'host-preview grant unknown (G38)' },
  };
  it('records every operation and refuses an executable preview without a host-preview grant', () => {
    expect(detail(fetched).resource.sourceIdentity?.operationRights).toHaveLength(SOURCE_OPERATIONS.length);
    expect(() => detail({ ...fetched, previewCapability: { available: true, kind: 'html', url: '/api/preview', reason: null } })).toThrow(/host-preview/);
    expect(() => parseResourceSourceIdentity({ ...fetchIdentity, operationRights: rights.slice(1) })).toThrow(/every operation/);
    expect(() => parseResourceSourceIdentity({ ...fetchIdentity, operationRights: [...rights.slice(1), { operation: 'host-preview', decision: 'unknown', reason: null }] })).toThrow();
  });
});

describe('cited RightsAssessment summary (AC-R18.6, G38)', () => {
  const assessment = {
    id: 'aceternity-free-rights:tabs', revision: 1, evaluatorRole: 'source-curator' as const, basis: 'published-license' as const,
    termsUrl: 'https://ui.aceternity.com/licence', termsSha256: 'd0f63e88cade96e1619944762903c465813f23da0a851de088e85c3e33276088',
    clauseRefs: ['licence#permitted.create-end-products'], evaluatedAt: '2026-10-09T02:00:00.000Z',
  };
  const allowed = SOURCE_OPERATIONS.map(operation => ({ operation, decision: operation === 'incorporate-project' ? 'allowed' as const : 'unknown' as const, reason: 'cited' }));
  const base: ResourceSourceIdentity = { ...identity, repositoryUrl: 'https://ui.aceternity.com', commit: null, registryLocator: 'https://ui.aceternity.com/registry/tabs.json', acquisitionMode: 'project-fetch', documentedConnector: null, operationRights: allowed };
  it('an allowed operation right must cite the assessment it comes from', () => {
    expect(() => parseResourceSourceIdentity(base)).toThrow(/RightsAssessment/);
    expect(parseResourceSourceIdentity({ ...base, rightsAssessment: assessment }).rightsAssessment?.basis).toBe('published-license');
  });
  it('summarises an owner-accepted private-use basis with its dated owner decision', () => {
    const owner = { ...assessment, basis: 'owner-accepted-private-use' as const, ownerDecision: { decidedAt: '2026-10-08', decidedBy: 'owner', citation: 'Private repository; licences ignored for now' } };
    expect(parseResourceSourceIdentity({ ...base, rightsAssessment: owner }).rightsAssessment?.ownerDecision?.decidedAt).toBe('2026-10-08');
    expect(() => parseResourceSourceIdentity({ ...base, rightsAssessment: { ...owner, ownerDecision: undefined } })).toThrow(/owner decision/i);
  });
  it('refuses an unknown evaluator role, a non-HTTPS terms locator or an empty clause list', () => {
    expect(() => parseResourceSourceIdentity({ ...base, rightsAssessment: { ...assessment, evaluatorRole: 'model' } })).toThrow();
    expect(() => parseResourceSourceIdentity({ ...base, rightsAssessment: { ...assessment, termsUrl: 'http://ui.aceternity.com/licence' } })).toThrow();
    expect(() => parseResourceSourceIdentity({ ...base, rightsAssessment: { ...assessment, clauseRefs: [] } })).toThrow();
  });
});

describe('typed adoption refusals', () => {
  it('native-format refusal carries the need decision and reason', () => {
    expect(parseNativeFormatRefusalDetails({ kind: 'adoption', reason: 'unsupported-capability', nativeFormat: 'svelte', supportedTargets: ['html', 'react'], needDecision: 'reference-only', needReason: 'Deferred under G24.', nextGate: 'G24' }).needDecision).toBe('reference-only');
    expect(() => parseNativeFormatRefusalDetails({ kind: 'adoption', reason: 'unsupported-capability', nativeFormat: 'svelte', supportedTargets: [], nextGate: 'G24' })).toThrow();
  });
  it('rights refusal names each operation that is not allowed', () => {
    expect(parseOperationRightsRefusalDetails({ kind: 'adoption', reason: 'operation-rights-unknown', operations: [{ operation: 'incorporate-project', decision: 'unknown', reason: 'G38' }], nextGate: 'G38' }).operations).toHaveLength(1);
    expect(() => parseOperationRightsRefusalDetails({ kind: 'adoption', reason: 'operation-rights-unknown', operations: [], nextGate: 'G38' })).toThrow();
  });
});
