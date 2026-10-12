import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseResourceSearchRequest, parseResourceSearchResponse, parseResourceDetailResponse, type PreparedAdoptionPlan, type ResourceCandidate, type ResourceSourceSnapshot } from '@open-design/contracts';
import { registerWorkbenchRoutes } from '../../src/routes/workbench.js';
import { registerWorkbenchAdoptionRoutes } from '../../src/routes/workbench-adoption.js';
import { sendApiError } from '../../src/http/api-errors.js';
import { runComponentsSearchCli } from '../../src/components-cli.js';
import { createComponentGateForRequest } from '../../src/workbench/component-gate.js';
import type { PlacementAdoptionExecutor } from '../../src/workbench/placement/adoption-executor.js';
import { candidate, adapter, projectState, savedContext, booking } from './context-ranking-fixture.js';
import { searchResources, inspectResource } from '../../src/workbench/resources.js';
import { createBriefTokensSource } from '../../src/workbench/resources-tokens.js';
import { eligibleTokenKind } from '../../src/workbench/context-ranking.js';

let server: Server | undefined;
afterEach(async () => { if (server) await new Promise<void>(done => server!.close(() => done())); server = undefined; });
const projectFacts = { projectId: 'p', contextRevision: 1, rubricRevision: 1, rubricCurrent: true };
const target = { target: 'html' as const, verified: true, dependencyDigest: 'target-v1' };
const makeComponent = (id: string, overrides: Partial<ResourceCandidate> = {}) => candidate(id, {
  category: 'component', rightsStatus: 'permitted', admissionStage: 'admitted', needDecision: 'justified',
  operationGrants: [{ operation: 'incorporation', state: 'permitted', reason: null }],
  acceptanceEvidence: { sourceDigest: 'v1', receiptId: 'profile:clinic-v1', passed: true },
  compatibility: { nativeFormat: 'html', targets: ['html'], state: 'compatible', reason: null },
  componentAdmissionEvidence: { profileId: 'clinic-html', projectId: 'p', sourceRevisionOrDigest: 'v1', contextRevision: 1, rubricRevision: 1 },
  componentTokenEvidence: { sourceRevisionOrDigest: 'v1', evidenceRef: 'tokens:v1', color: 'adaptable', radius: 'adaptable', type: 'adaptable' }, ...overrides,
});
async function boot() {
  const app = express(); app.use(express.json());
  let currentTarget: typeof target | null = target, kitRevision = 'kit-v1';
  let approval: 'approved' | 'unapproved' | 'unverified' = 'approved';
  const context = savedContext({ conversions: [booking] });
  let items = [makeComponent('a'), makeComponent('b', { sectionKind: 'booking-availability', componentTokenEvidence: { sourceRevisionOrDigest: 'v1', evidenceRef: 'bindings', color: 'adaptable', radius: 'adaptable', type: 'adaptable', bindings: { color: ['--fg'], radius: ['--radius'], type: ['--font'] } } }), makeComponent('blocked', { admissionStage: 'discovered' })];
  const kit = () => candidate('clinic', { category: 'design-system', ref: { sourceType: 'library', sourceId: 'design-systems', itemId: 'clinic', revisionOrDigest: kitRevision }, kitTokenAxes: { color: true, radius: true, type: true }, kitTokenNames: ['--fg', '--radius', '--font'] });
  const authorize = vi.fn(async (_req, res, id) => { if (id === 'forbidden') { res.status(403).json({ error: { code: 'DENIED' } }); return false; } return true; });
  const kitList = vi.fn(async (): Promise<ResourceSourceSnapshot> => ({ items: [kit()], status: { sourceId: 'design-systems', state: 'searched', reason: null, itemCount: 1, listingDigest: null } }));
  registerWorkbenchRoutes(app, { http: { sendApiError }, authorizeProjectRequest: authorize,
    projectStateForRequest: () => projectState(context),
    componentContextForRequest: async () => ({ componentTarget: currentTarget, activeKitId: 'clinic', componentProjectFacts: projectFacts, kitApproval: async () => approval }),
    sourcesForRequest: () => [adapter(items), { sourceId: 'design-systems', list: kitList }],
  });
  const writes = vi.fn(async () => ({ id: 'operation-1' }));
  const prepares = vi.fn(async () => plan);
  const plan = { id: 'plan-1', projectId: 'p', adapter: { id: 'catalogue-files', version: '1' }, source: { resourceRef: items[0]!.ref } } as PreparedAdoptionPlan;
  registerWorkbenchAdoptionRoutes(app, { http: { sendApiError }, authorizeProjectRequest: authorize,
    placement: { adoption: { readPlan: () => plan, apply: writes, prepare: prepares } as unknown as PlacementAdoptionExecutor, status: () => { throw new Error('Not expected'); } },
    catalogue: null,
    componentGateForRequest: createComponentGateForRequest({
      sourcesForRequest: () => [adapter(items), { sourceId: 'design-systems', list: kitList }],
      factsForRequest: async () => ({ componentTarget: currentTarget, projectState: projectState(context), componentProjectFacts: projectFacts, activeKitId: 'clinic', kitApproval: async () => approval }),
    }),
  });
  server = app.listen(0, '127.0.0.1'); await new Promise<void>(done => server!.once('listening', done));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = async (body: unknown, path = 'components/rank', headers: Record<string, string> = {}) => fetch(`${url}/api/workbench/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { url, request, kitList, writes, prepares, revokeTarget: () => { currentTarget = null; }, setApproval: (value: typeof approval) => { approval = value; }, omitAcceptance: () => { items = [makeComponent('a', { acceptanceEvidence: undefined })]; }, changeSourceRevision: () => { items = [makeComponent('a', { ref: { ...items[0]!.ref, revisionOrDigest: 'v2' } })]; }, setTarget: () => { currentTarget = { ...target, dependencyDigest: 'changed' }; }, setKit: () => { kitRevision = 'kit-v2'; }, revokeAdmission: () => { items = [makeComponent('a', { admissionStage: 'discovered' })]; } };
}
describe('V06 HTTP / od parity and immutable Apply gate', () => {
  it('preserves eligible colour and sizing suggestions in the first group while ranking components', async () => {
    const context = savedContext({ purpose: 'Book dental appointments', brandDirection: 'Calm clinical care', conversions: [booking] });
    const sources = [adapter(Array.from({ length: 12 }, (_, index) => makeComponent(`dental-${index}`, { title: `Dental booking section ${index}`, sectionKind: 'booking-availability' }))), createBriefTokensSource({ readContext: () => context })];
    const request = parseResourceSearchRequest({ projectId: 'p', query: 'dental booking appointment', limit: 5 });
    const authority = { principalId: 'local-daemon', projectId: 'p' };
    const options = { projectState: projectState(context), componentTarget: target, componentProjectFacts: projectFacts, kitApproval: async () => 'approved' as const };
    const baseline = await searchResources(request, authority, sources, options);
    const picker = await searchResources(parseResourceSearchRequest({ ...request, componentPicker: { showAll: true } }), authority, sources, options);
    for (const kind of ['color', 'sizing']) {
      const before = baseline.results.findIndex(item => eligibleTokenKind(item) === kind);
      expect(before).toBeGreaterThanOrEqual(0);
      expect(picker.results.findIndex(item => eligibleTokenKind(item) === kind)).toBe(before);
    }
  });
  it('ranks/list the same eligible references on HTTP and od, and inspects rejected entries from Show all', async () => {
    const f = await boot();
    const http = parseResourceSearchResponse(await (await f.request({ projectId: 'p', componentPicker: { kitId: 'clinic' } })).json());
    expect(http.results.map(item => item.ref.itemId)).toEqual(['b', 'a']);
    const output: unknown[] = [];
    expect(await runComponentsSearchCli(['rank', '--kit', 'clinic', '--project', 'p', '--json'], { baseUrl: f.url, write: value => output.push(value) })).toBe(0);
    expect(output[0]).toEqual(http);
    const inspected = parseResourceDetailResponse(await (await fetch(`${f.url}/api/workbench/resources/${http.results[0]!.refKey}?projectId=p`)).json());
    expect(inspected.resource.componentFit).toEqual(http.results[0]!.componentFit);
    const listed: unknown[] = [];
    expect(await runComponentsSearchCli(['list', '--kit', 'clinic', '--project', 'p', '--show-all', '--json'], { baseUrl: f.url, write: value => listed.push(value) })).toBe(0);
    const all = parseResourceSearchResponse(listed[0]); expect(all.results).toHaveLength(3);
    const blocked = all.results.find(item => item.ref.itemId === 'blocked')!;
    expect(blocked.componentFit?.apply.allowed).toBe(false);
    const detail = await fetch(`${f.url}/api/workbench/resources/${blocked.refKey}?projectId=p`);
    expect(parseResourceDetailResponse(await detail.json()).resource.componentFit?.apply.allowed).toBe(false);
  });
  it('enforces project scope before listing, and rejects caller-supplied gate facts', async () => {
    const f = await boot();
    expect((await f.request({ projectId: 'forbidden' })).status).toBe(403); expect(f.kitList).not.toHaveBeenCalled();
    expect((await f.request({ projectId: 'p' }, 'components/rank', { 'x-od-project-id': 'other' })).status).toBe(400);
    expect((await f.request({ projectId: 'p', componentTarget: target })).status).toBe(400);
    expect((await f.request({ projectId: 'p', componentPicker: false })).status).toBe(400);
  });
  it('invalidates pagination when the target or kit changes', async () => {
    const f = await boot();
    const body = { projectId: 'p', limit: 1, componentPicker: { kitId: 'clinic' } };
    const first = parseResourceSearchResponse(await (await f.request(body)).json()); expect(first.nextCursor).toBeTruthy();
    f.setTarget(); expect((await f.request({ ...body, cursor: first.nextCursor })).status).toBe(409);
    const next = parseResourceSearchResponse(await (await f.request(body)).json()); f.setKit();
    expect((await f.request({ ...body, cursor: next.nextCursor })).status).toBe(409);
  });
  it('rechecks admission at Apply and refuses a previously prepared plan without writes', async () => {
    const f = await boot(); f.revokeAdmission();
    const response = await f.request({ planId: 'plan-1', planDigest: 'a'.repeat(64) }, 'adoption/apply');
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: { details: { reason: 'component-apply-blocked', blockers: ['admission-unverified'] } } });
    expect(f.writes).not.toHaveBeenCalled();
  });
  it('requires --kit and --json and never starts discovery for malformed CLI input', async () => {
    const output: unknown[] = [];
    expect(await runComponentsSearchCli(['rank', '--json'], { write: value => output.push(value) })).toBe(2);
    expect(await runComponentsSearchCli(['list', '--kit', 'clinic'], { write: value => output.push(value) })).toBe(2);
    expect(output).toHaveLength(2);
  });
  it('does not substitute a newer kit for the saved revision during ranking or inspection', async () => {
    const context = savedContext({ designSystemRef: { id: 'clinic', revisionOrDigest: 'kit-old' }, factSources: ['id', 'revisionOrDigest'].map(field => ({ fieldPath: `/designSystemRef/${field}`, value: field === 'id' ? 'clinic' : 'kit-old', origin: 'user-confirmed', source: null, confidence: null, rationale: 'Saved kit selection' })) });
    const item = makeComponent('component');
    const currentKit = candidate('clinic', { category: 'design-system', ref: { sourceType: 'library', sourceId: 'design-systems', itemId: 'clinic', revisionOrDigest: 'kit-new' }, kitTokenAxes: { color: true, radius: true, type: true } });
    const sources = [adapter([item]), { sourceId: 'design-systems' as const, list: async (): Promise<ResourceSourceSnapshot> => ({ items: [currentKit], status: { sourceId: 'design-systems', state: 'searched', reason: null, itemCount: 1, listingDigest: null } }) }];
    const authority = { principalId: 'local-daemon', projectId: 'p' };
    const options = { projectState: projectState(context), componentTarget: target, componentProjectFacts: projectFacts, kitApproval: async () => 'approved' as const };
    const response = await searchResources(parseResourceSearchRequest({ projectId: 'p', componentPicker: {} }), authority, sources, options);
    expect(response.componentRanking?.reason).toBe('kit-unavailable');
    expect(response.results.find(result => result.ref.itemId === 'component')?.componentFit?.status).toBe('unknown');
    const detail = await inspectResource(response.results.find(result => result.ref.itemId === 'component')!.refKey, authority, sources, options);
    expect(detail.resource.componentFit?.status).toBe('unknown');
  });
  it('preserves plain resource discovery for non-picker callers', async () => {
    const f = await boot();
    const response = parseResourceSearchResponse(await (await f.request({ projectId: 'p' }, 'resources/search')).json());
    expect(response.componentRanking).toBeUndefined();
    expect(response.results).toHaveLength(4); // Three components and the kit.
  });
});

it.each(['target', 'approval', 'revision'] as const)('real HTTP hook refuses revoked %s before Apply writes', async reason => {
  const f = await boot();
  if (reason === 'target') f.revokeTarget();
  if (reason === 'approval') f.setApproval('unapproved');
  if (reason === 'revision') f.changeSourceRevision();
  const response = await f.request({ planId: 'plan-1', planDigest: 'a'.repeat(64) }, 'adoption/apply');
  expect(response.status).toBe(reason === 'revision' ? 409 : 422);
  expect(f.writes).not.toHaveBeenCalled();
});
it('real HTTP hook permits admitted material with pending acceptance, then refuses Prepare after admission revocation', async () => {
  const f = await boot(); f.omitAcceptance();
  expect((await f.request({ planId: 'plan-1', planDigest: 'a'.repeat(64) }, 'adoption/apply')).status).toBe(200);
  expect(f.writes).toHaveBeenCalledOnce();
  f.revokeAdmission();
  const response = await f.request({ projectId: 'p', entryPath: 'index.html', source: { implementationOrigin: 'owned', resourceRef: { sourceType: 'section', sourceId: 'sections', itemId: 'a', revisionOrDigest: 'v1' } }, writes: [{ path: 'index.html', role: 'entry', contentBase64: Buffer.from('<p>New</p>').toString('base64') }] }, 'adoption/prepare');
  expect(response.status).toBe(422);
  expect(await response.json()).toMatchObject({ error: { details: { blockers: ['admission-unverified'] } } });
  expect(f.prepares).not.toHaveBeenCalled();
});
it('fails at registration if untyped callers omit the mandatory component hook', () => {
  const app = express();
  expect(() => registerWorkbenchAdoptionRoutes(app, { http: { sendApiError }, authorizeProjectRequest: async () => true, placement: { adoption: null, status: () => { throw new Error('unused'); } } } as unknown as Parameters<typeof registerWorkbenchAdoptionRoutes>[1])).toThrow('componentGateForRequest');
});

it('selects kits by source+ID for both rank and inspect, independent of listing order', async () => {
  const selected = candidate('clinic', { category: 'design-system', ref: { sourceType: 'library', sourceId: 'design-systems', itemId: 'clinic', revisionOrDigest: 'owned-v1' }, kitTokenAxes: { color: true, radius: true, type: true } });
  const collision = { ...selected, ref: { ...selected.ref, sourceId: 'plugins' as const, revisionOrDigest: 'plugin-v1' }, kitTokenAxes: { color: false, radius: false, type: false } };
  const context = savedContext({ designSystemRef: { sourceId: 'design-systems', id: 'clinic', revisionOrDigest: 'owned-v1' }, factSources: ['sourceId', 'id', 'revisionOrDigest'].map(field => ({ fieldPath: `/designSystemRef/${field}`, value: field === 'sourceId' ? 'design-systems' : field === 'id' ? 'clinic' : 'owned-v1', origin: 'user-confirmed', source: null, confidence: null, rationale: 'Saved kit' })) });
  const sources = [adapter([makeComponent('component')]), ...[collision, selected].map(item => ({ sourceId: item.ref.sourceId, list: async (): Promise<ResourceSourceSnapshot> => ({ items: [item], status: { sourceId: item.ref.sourceId, state: 'searched', reason: null, itemCount: 1, listingDigest: null } }) }))];
  const authority = { principalId: 'local-daemon', projectId: 'p' };
  const options = { projectState: projectState(context), componentTarget: target, kitApproval: async () => 'approved' as const };
  for (const ordered of [sources, [...sources].reverse()]) {
    const result = await searchResources(parseResourceSearchRequest({ projectId: 'p', componentPicker: { kitId: 'clinic', kitSourceId: 'design-systems' } }), authority, ordered, options);
    expect(result.componentRanking).toMatchObject({ kitSourceId: 'design-systems', kitRevisionOrDigest: 'owned-v1' });
    expect(result.results.find(item => item.ref.itemId === 'component')?.componentFit?.status).toBe('fits');
    const detail = await inspectResource(result.results.find(item => item.ref.itemId === 'component')!.refKey, authority, ordered, options);
    expect(detail.resource.componentFit).toMatchObject({ kitSourceId: 'design-systems', kitRevisionOrDigest: 'owned-v1', status: 'fits' });
  }
});
