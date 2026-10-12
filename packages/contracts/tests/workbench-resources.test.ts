import { describe, expect, it } from 'vitest';
import { parseResourceSearchRequest, parseResourceSearchResponse, parseResourceDetailResponse } from '../src/api/workbench.js';

const resource = {
  ref: { sourceType: 'genui', sourceId: 'genui', itemId: 'same-title', revisionOrDigest: 'sha256:abc' },
  refKey: 'opaque', title: 'Card', category: 'component', readiness: 'unverified',
  compatibility: { nativeFormat: 'html', targets: ['html'], state: 'unverified', reason: 'Target proof pending' },
  rightsStatus: 'unknown', fitReasons: [],
  previewCapability: { available: true, kind: 'html', url: '/api/genui/catalog/card/preview', reason: null },
  adoptionCapability: { available: false, reason: 'adapter-missing' },
  sourceAttribution: { title: 'Owned catalogue' }, operationGrants: [],
  admissionStage: 'discovered', needDecision: 'not-assessed', needReason: 'Project need is not assessed in W1',
};
const status = { sourceId: 'genui', state: 'searched', reason: null, itemCount: 1, listingDigest: 'abc' };
const selectionMetadata = { projectId: 'project', preferenceRevision: 1, observedContextRevision: 3, selection: 'saved', rankingVersion: 'local-context/1', resultMode: 'lexical' };
const response = { results: [resource], sourceStatuses: [status], context: { requested: true, applied: false, reason: 'context-not-implemented' }, contextRevision: null, nextCursor: null, indexDigest: 'abc', degradedReason: null };
describe('W1 resource boundaries', () => {
  it('preserves omitted preference and validates page/facet bounds', () => {
    expect(parseResourceSearchRequest({})).toEqual({ query: '', facets: {}, limit: 20 });
    for (const input of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { useProjectContext: 'yes' }, { facets: { category: 'banana' } }, { facets: { sourceIds: ['invented'] } }, { principalId: 'forged' }]) {
      expect(() => parseResourceSearchRequest(input)).toThrow();
    }
  });
  it('retains explicit unverified readiness and permitted existing preview without adoption', () => {
    expect(parseResourceSearchResponse(response)).toEqual(response);
    expect(parseResourceDetailResponse({ resource, sourceStatus: status }).resource.readiness).toBe('unverified');
  });
  it('rejects missing digest, malformed enums and forged usable/adoption assertions', () => {
    for (const patch of [{ ref: { ...resource.ref, revisionOrDigest: '' } }, { category: 'banana' }, { readiness: 'usable' }, { adoptionCapability: { available: true, reason: null } }, { rightsStatus: 'cleared-by-client' }]) {
      expect(() => parseResourceSearchResponse({ ...response, results: [{ ...resource, ...patch }] })).toThrow();
    }
  });
  it('rejects invalid coverage and a silently applied W1 context', () => {
    expect(() => parseResourceSearchResponse({ ...response, sourceStatuses: [{ ...status, state: 'empty' }] })).toThrow();
    expect(() => parseResourceSearchResponse({ ...response, context: { requested: true, applied: true, reason: 'context-not-implemented' } })).toThrow();
  });
});

it('uses the shared typed error envelope for W1 refusals', async () => {
  const { API_ERROR_CODES, createApiError } = await import('../src/errors.js');
  for (const code of ['resource-ref-unknown','resource-ref-stale','resource-cursor-stale','project-forbidden'] as const) {
    expect(API_ERROR_CODES).toContain(code);
    expect(createApiError(code,'Refused',{details:{nextSteps:['Search again']}})).toEqual({code,message:'Refused',details:{nextSteps:['Search again']}});
  }
});

it('rejects executable URLs and inconsistent usable rights at the wire boundary', () => {
  for (const patch of [{previewCapability:{available:true,kind:'html',url:'javascript:alert(1)',reason:null}}, {sourceAttribution:{title:'source',url:'data:text/html,unsafe'}}, {readiness:'usable',acceptanceEvidence:{sourceDigest:resource.ref.revisionOrDigest,receiptId:'passed',passed:true}}]) expect(() => parseResourceDetailResponse({resource:{...resource,...patch},sourceStatus:status})).toThrow();
});

it('covers the separate 21st.dev inventory and rejects backslash URL origin escapes', async () => {
  const { RESOURCE_SOURCE_IDS } = await import('../src/api/workbench.js');
  expect(RESOURCE_SOURCE_IDS).toContain('21st-dev');

});

it('rejects a backslash path which browsers resolve across origins', () => {
  expect(() => parseResourceDetailResponse({resource:{...resource,previewCapability:{available:true,kind:'html',url:'/\\evil.example/p',reason:null}},sourceStatus:status})).toThrow();
});


describe('P2 context selection and metadata', () => {
  it.each([true, false])('keeps an explicit %s override distinct from omission', value => {
    expect(parseResourceSearchRequest({ useProjectContext: value }).useProjectContext).toBe(value);
    expect(parseResourceSearchRequest({})).not.toHaveProperty('useProjectContext');
  });
  it('accepts applied saved context only with project and a positive safe revision', () => {
    const applied = { ...response, context: { requested: true, applied: true, reason: null, ...selectionMetadata, resultMode: 'ranked' }, contextRevision: 3, excluded: [] };
    expect(parseResourceSearchResponse(applied).contextRevision).toBe(3);
    for (const revision of [null, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => parseResourceSearchResponse({ ...applied, contextRevision: revision })).toThrow();
    }
    expect(() => parseResourceSearchResponse({ ...applied, context: { requested: true, applied: true, reason: null } })).toThrow();
    expect(() => parseResourceSearchResponse({ ...applied, context: { ...applied.context, requested: false } })).toThrow();
  });
  it.each(['no-project', 'context-absent', 'context-not-rankable', 'context-not-implemented'])('retains requested context on %s fallback', reason => {
    const common = reason === 'no-project' ? { ...selectionMetadata, projectId: null, preferenceRevision: 0, observedContextRevision: 0 } : { ...selectionMetadata, observedContextRevision: reason === 'context-absent' ? 0 : 3 };
    const fallback = reason === 'context-not-implemented' ? response : { ...response, context: { requested: true, applied: false, reason, ...common }, excluded: [] };
    expect(parseResourceSearchResponse(fallback).context).toEqual(fallback.context);
    expect(() => parseResourceSearchResponse({ ...fallback, contextRevision: 1 })).toThrow();
    expect(() => parseResourceSearchResponse({ ...fallback, context: { ...fallback.context, requested: false } })).toThrow();
  });
  it('keeps disabled searches explicit without claiming context use', () => {
    const disabled = { ...response, context: { requested: false, applied: false, reason: 'context-disabled', ...selectionMetadata }, excluded: [] };
    expect(parseResourceSearchResponse(disabled).context.applied).toBe(false);
    expect(() => parseResourceSearchResponse({ ...disabled, contextRevision: 1 })).toThrow();
  });
  it.each([['TL', 'MI'], 'any', 'unclassified'])('accepts actual section metadata %j without upgrading grants', spineAffinities => {
    const detailed = { ...resource, spineAffinities, sectionKind: 'booking-availability' };
    const parsed = parseResourceDetailResponse({ resource: detailed, sourceStatus: status }).resource;
    expect(parsed).toMatchObject({ spineAffinities, sectionKind: 'booking-availability', rightsStatus: 'unknown', readiness: 'unverified', adoptionCapability: { available: false } });
  });
  it.each([{ spineAffinities: ['premium'] }, { spineAffinities: [] }, { spineAffinities: ['TL', 'TL'] }, { sectionKind: 'dental-cta' }])('refuses invented metadata %j', patch => {
    expect(() => parseResourceDetailResponse({ resource: { ...resource, ...patch }, sourceStatus: status })).toThrow();
  });
  it('retains declared motion as advisory and binds observed evidence to the exact source', () => {
    const motionMetadata = { state: 'reduced-compatible', basis: 'declared', sourceRevisionOrDigest: 'sha256:abc', field: 'manifest.reducedMotion' };
    expect(parseResourceDetailResponse({ resource: { ...resource, motionMetadata }, sourceStatus: status }).resource).toMatchObject({ motionMetadata, rightsStatus: 'unknown' });
    const observed = { ...motionMetadata, basis: 'observed', evidenceRef: 'receipt-1' };
    expect(parseResourceDetailResponse({ resource: { ...resource, motionMetadata: observed }, sourceStatus: status }).resource).toMatchObject({ motionMetadata: observed });
    for (const patch of [{ sourceRevisionOrDigest: 'other' }, { basis: 'observed' }, { state: 'safe' }, { field: '' }, { permissions: 'granted' }]) {
      expect(() => parseResourceDetailResponse({ resource: { ...resource, motionMetadata: { ...motionMetadata, ...patch } }, sourceStatus: status })).toThrow();
    }
  });
});


it('binds completed context metadata to the applied revision while retaining exact legacy reads', () => {
  const applied = { ...response, context: { requested: true, applied: true, reason: null, ...selectionMetadata, resultMode: 'ranked' }, contextRevision: 3, excluded: [] };
  expect(parseResourceSearchResponse(applied).context).toMatchObject({ preferenceRevision: 1, observedContextRevision: 3, rankingVersion: 'local-context/1' });
  expect(parseResourceSearchResponse(response)).toEqual(response);
  for (const patch of [{ observedContextRevision: 2 }, { preferenceRevision: -1 }, { preferenceRevision: Number.MAX_SAFE_INTEGER + 1 }, { rankingVersion: 'remote-ai/1' }, { selection: 'ambient' }, { projectId: null }]) expect(() => parseResourceSearchResponse({ ...applied, context: { ...applied.context, ...patch } })).toThrow();
  const absent = { ...response, context: { requested: true, applied: false, reason: 'context-absent', ...selectionMetadata, observedContextRevision: 0 }, excluded: [] };
  expect(parseResourceSearchResponse(absent).context.applied).toBe(false);
  expect(() => parseResourceSearchResponse({ ...absent, context: { ...absent.context, observedContextRevision: 3 } })).toThrow();
  const noProject = { ...response, context: { requested: true, applied: false, reason: 'no-project', ...selectionMetadata, projectId: null, preferenceRevision: 0, observedContextRevision: 0 }, excluded: [] };
  expect(parseResourceSearchResponse(noProject).context).toMatchObject({ projectId: null, observedContextRevision: 0 });
  expect(() => parseResourceSearchResponse({ ...noProject, context: { ...noProject.context, projectId: 'project' } })).toThrow();
});

it('keeps timeout and motion exclusions visible without pretending the full ranking applied', () => {
  const timedOut = { ...response, context: { requested: true, applied: false, reason: 'ranking-timeout', ...selectionMetadata, selection: 'request-override', resultMode: 'timeout-lexical' }, excluded: [{ reason: 'motion-constraint', constraintId: 'motion', count: 2 }] };
  const parsed = parseResourceSearchResponse(timedOut);
  expect(parsed.context.applied).toBe(false);
  expect(parsed.contextRevision).toBeNull();
  expect(parsed.context).toMatchObject({ observedContextRevision: 3, selection: 'request-override' });
  expect(parsed).toMatchObject({ excluded: [{ reason: 'motion-constraint', constraintId: 'motion', count: 2 }] });
  for (const excluded of [[{ ...timedOut.excluded[0], count: 0 }], [{ ...timedOut.excluded[0], count: 1.5 }], [timedOut.excluded[0], timedOut.excluded[0]], [{ ...timedOut.excluded[0], reason: 'hidden-rights-upgrade' }]]) expect(() => parseResourceSearchResponse({ ...timedOut, excluded })).toThrow();
  expect(() => parseResourceSearchResponse({ ...timedOut, context: { requested: false, applied: false, reason: 'context-disabled', ...selectionMetadata } })).toThrow();
  expect(() => parseResourceSearchResponse({ ...timedOut, contextRevision: 3 })).toThrow();
});


it('requires completed result mode to match its applied, disabled or timeout state', () => {
  const applied = { ...response, context: { requested: true, applied: true, reason: null, ...selectionMetadata, resultMode: 'ranked' }, contextRevision: 3, excluded: [] };
  for (const resultMode of [undefined, 'lexical', 'timeout-lexical']) expect(() => parseResourceSearchResponse({ ...applied, context: { ...applied.context, resultMode } })).toThrow();
  const disabled = { ...response, context: { requested: false, applied: false, reason: 'context-disabled', ...selectionMetadata }, excluded: [] };
  expect(parseResourceSearchResponse(disabled).context).toMatchObject({ resultMode: 'lexical' });
  expect(() => parseResourceSearchResponse({ ...disabled, context: { ...disabled.context, resultMode: 'ranked' } })).toThrow();
  for (const key of ['projectId', 'preferenceRevision', 'observedContextRevision', 'selection', 'rankingVersion', 'resultMode']) {
    const context: Record<string, unknown> = { ...disabled.context }; delete context[key];
    expect(() => parseResourceSearchResponse({ ...disabled, context })).toThrow();
  }
});

it.each([
  [null, true, 'ranked'], ['context-disabled', false, 'lexical'], ['no-project', true, 'lexical'],
  ['context-absent', true, 'lexical'], ['context-not-rankable', true, 'lexical'], ['ranking-timeout', true, 'timeout-lexical'],
] as const)('rejects every incorrect result mode for %s', (reason, requested, wantedMode) => {
  const metadata = reason === 'no-project' ? { ...selectionMetadata, projectId: null, preferenceRevision: 0, observedContextRevision: 0 } : { ...selectionMetadata, observedContextRevision: reason === 'context-absent' ? 0 : 3 };
  const context = { ...metadata, requested, applied: reason === null, reason, resultMode: wantedMode };
  const complete = { ...response, context, contextRevision: reason === null ? 3 : null, excluded: [] };
  expect(parseResourceSearchResponse(complete).context).toMatchObject({ resultMode: wantedMode });
  for (const mode of ['ranked', 'lexical', 'timeout-lexical']) if (mode !== wantedMode) expect(() => parseResourceSearchResponse({ ...complete, context: { ...context, resultMode: mode } })).toThrow();
});
