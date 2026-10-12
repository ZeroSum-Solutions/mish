import { describe, expect, it } from 'vitest';
import type { ResourceCandidate, ResourceRequestContext } from '@mish/contracts';
import { parseResourceSearchRequest, parseResourceSearchResponse } from '@mish/contracts';
import { searchResources, inspectResource, createLocalResourceSources, type ResourceSourceAdapter } from '../src/workbench/resources.js';
const context = { principalId: 'local-daemon', projectId: 'p1' };
const candidate = (id: string, digest = 'sha256:one'): ResourceCandidate => ({
  ref: { sourceType: 'genui', sourceId: 'genui', itemId: id, revisionOrDigest: digest },
  title: 'Duplicate title', category: 'component', readiness: 'unverified',
  compatibility: { nativeFormat: 'html', targets: ['html'], state: 'unverified', reason: 'Pending evidence' },
  rightsStatus: 'unknown', fitReasons: [], previewCapability: { available: false, kind: 'none', reason: 'adapter-missing' },
  adoptionCapability: { available: false, reason: 'adapter-missing' }, sourceAttribution: { title: 'Owned catalogue' },
  operationGrants: [], admissionStage: 'discovered', needDecision: 'not-assessed', needReason: 'Pending project need',
});
function adapter(items: ResourceCandidate[]): ResourceSourceAdapter {
  return { sourceId: 'genui', async list(ctx) {
    if (ctx.projectId === 'forbidden') throw Object.assign(new Error('Denied'), { status: 403, code: 'project-forbidden' });
    return { items, status: { sourceId: 'genui', state: 'searched', reason: null, itemCount: items.length, listingDigest: null } };
  } };
}
describe('resource federation', () => {
  it('preserves distinct duplicate-title identities and refs across service instances', async () => {
    const sources = [adapter([candidate('b'), candidate('a')])];
    const page = await searchResources(parseResourceSearchRequest({}), context, sources);
    expect(page.results).toHaveLength(2);
    expect(new Set(page.results.map(r => r.refKey)).size).toBe(2);
    const again = await inspectResource(page.results[0]!.refKey, context, [adapter([candidate('a'), candidate('b')])]);
    expect(again.resource).toEqual(page.results[0]);
    expect(page.context).toEqual({ requested: true, applied: false, reason: 'context-absent', projectId: 'p1', preferenceRevision: 0, observedContextRevision: 0, selection: 'saved', rankingVersion: 'local-context/1', resultMode: 'lexical' });
    expect(page.excluded).toEqual([]);
    expect(page.sourceStatuses.find(s => s.sourceId === 'react-bits')).toMatchObject({ state: 'not-federated', itemCount: null });
    expect(parseResourceSearchResponse(page)).toEqual(page);
  });
  it('rejects malformed and unknown refs and rechecks authority before stale recovery', async () => {
    const page = await searchResources(parseResourceSearchRequest({ projectId: 'p1' }), context, [adapter([candidate('a')])]);
    const key = page.results[0]!.refKey;
    for (const bad of ['bad', key + '=']) await expect(inspectResource(bad, context, [adapter([])])).rejects.toMatchObject({ status: 404, code: 'resource-ref-unknown' });
    await expect(inspectResource(key, context, [adapter([])])).rejects.toMatchObject({ status: 404, code: 'resource-ref-unknown' });
    await expect(inspectResource(key, context, [adapter([candidate('a','sha256:two')])])).rejects.toMatchObject({ status: 409, code: 'resource-ref-stale', nextSteps: expect.any(Array) });
    await expect(inspectResource(key, { ...context, projectId: 'forbidden' }, [adapter([candidate('a','sha256:two')])])).rejects.toMatchObject({ status: 403, code: 'project-forbidden' });
  });
  it('binds opaque cursors to query, scope, context, facets and the current index', async () => {
    const sources = [adapter([candidate('a'),candidate('b'),candidate('c')])];
    const request = parseResourceSearchRequest({ query: 'duplicate', limit: 1, useProjectContext: false });
    const first = await searchResources(request, context, sources);
    const second = await searchResources({ ...request, cursor: first.nextCursor! }, context, sources);
    expect(second.results[0]!.ref.itemId).not.toBe(first.results[0]!.ref.itemId);
    for (const changed of [{ query: 'other' }, { useProjectContext: true }, { facets: { category: 'section' as const } }]) await expect(searchResources({ ...request, ...changed, cursor: first.nextCursor! }, context, sources)).rejects.toMatchObject({ status: 409, code: 'resource-cursor-stale' });
    await expect(searchResources({ ...request, cursor: first.nextCursor! }, { ...context, projectId: 'p2' }, sources)).rejects.toMatchObject({ code: 'resource-cursor-stale' });
    await expect(searchResources({ ...request, cursor: first.nextCursor! }, context, [adapter([candidate('a','changed'),candidate('b')])])).rejects.toMatchObject({ code: 'resource-cursor-stale' });
  });
  it('rejects mismatched project context and preserves unavailable cohorts', async () => {
    await expect(searchResources(parseResourceSearchRequest({ projectId: 'p2' }), context, [])).rejects.toMatchObject({ status: 403, code: 'project-forbidden' });
    const source: ResourceSourceAdapter = { sourceId: 'plugins', async list() { return { items: [], status: { sourceId: 'plugins', state: 'unavailable', reason: 'connector-offline', itemCount: null, listingDigest: null } }; } };
    const result = await searchResources(parseResourceSearchRequest({}), context, [source]);
    expect(result.degradedReason).toBeTruthy();
    expect(result.sourceStatuses.find(s => s.sourceId === 'plugins')?.state).toBe('unavailable');
  });
  it('projects local cohorts without promoting ported/insertable metadata or leaking Cult internal names', async () => {
    const page = await searchResources(parseResourceSearchRequest({ limit: 100 }), { principalId: 'local-daemon' }, createLocalResourceSources({ listPlugins: async () => [] }));
    expect(page.results.length).toBeGreaterThan(0);
    expect(page.results.every(r => r.readiness !== 'usable' && !r.adoptionCapability.available)).toBe(true);
    const all = [...page.results]; let cursor = page.nextCursor;
    while (cursor) { const next = await searchResources(parseResourceSearchRequest({ limit: 100, cursor }), { principalId: 'local-daemon' }, createLocalResourceSources({ listPlugins: async () => [] })); all.push(...next.results); cursor = next.nextCursor; }
    const cult = all.filter(r => r.ref.itemId.startsWith('cult:'));
    expect(cult.length).toBeGreaterThan(0);
    expect(JSON.stringify(cult)).not.toMatch(/cult:.*(?:linear|stripe|apple)/);
    expect(all.some(r => r.ref.sourceType === 'genui' && r.previewCapability.available)).toBe(true);
  });
});

it('invalidates refs and cursors when authorized plugin preview bytes change', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { InstalledPluginRecordSchema } = await import('@mish/contracts');
  const root = await mkdtemp(join(tmpdir(),'workbench-plugin-'));
  try {
    await writeFile(join(root,'index.html'),'<button>Before</button>');
    const plugin = InstalledPluginRecordSchema.parse({id:'test-plugin',title:'A plugin',version:'1.0.0',sourceKind:'local',source:'local:test',trust:'restricted',capabilitiesGranted:[],fsPath:root,installedAt:0,updatedAt:0,manifest:{name:'test-plugin',version:'1.0.0',title:'A plugin',description:'Test',od:{preview:{entry:'index.html'}}}});
    const sources = createLocalResourceSources({listPlugins:async () => [plugin,{...plugin,id:'test-plugin-b',title:'B plugin'}]});
    const request = parseResourceSearchRequest({limit:1,facets:{sourceIds:['plugins']}});
    const first = await searchResources(request,context,sources);
    expect(first.results[0]!.ref.sourceId).toBe('plugins');
    const key = first.results[0]!.refKey;
    await writeFile(join(root,'index.html'),'<button>After</button>');
    await expect(inspectResource(key,context,sources)).rejects.toMatchObject({status:409,code:'resource-ref-stale'});
    await expect(searchResources({...request,cursor:first.nextCursor!},context,sources)).rejects.toMatchObject({status:409,code:'resource-cursor-stale'});
  } finally { await rm(root,{recursive:true,force:true}); }
});

it('keeps repair/reference/unavailable reasons and rejects unsupported usable assertions', async () => {
  const repair = { ...candidate('repair'), readiness:'needs-repair' as const, admissionStage:'needs-repair' as const, adoptionCapability:{available:false,reason:'Known keyboard defect'} };
  const reference = { ...candidate('reference'), readiness:'reference-only' as const, admissionStage:'reference-only' as const };
  const unavailable = { ...candidate('unavailable'), readiness:'unavailable' as const, availabilityReason:'connector-offline' as const };
  const result = await searchResources(parseResourceSearchRequest({}),context,[adapter([repair,reference,unavailable])]);
  expect(result.results.map(r => r.readiness).sort()).toEqual(['needs-repair','reference-only','unavailable']);
  expect(result.results.find(r => r.ref.itemId === 'repair')?.adoptionCapability.reason).toBe('Known keyboard defect');
  const forged = await searchResources(parseResourceSearchRequest({}),context,[adapter([candidate('valid'),{...candidate('forged'),readiness:'usable'},{...candidate('forged-adoption'),adoptionCapability:{available:true,reason:null}}])]);
  expect(forged.results.map(r => r.ref.itemId)).toEqual(['valid']);
  expect(forged.sourceStatuses.find(s => s.sourceId === 'genui')).toMatchObject({state:'degraded',reason:'invalid-resource-metadata:2 excluded',itemCount:1,listingDigest:expect.any(String)});
});


it('isolates invalid candidate metadata without hiding authorized valid resources', async () => {
  const invalid = {...candidate('invalid'),title:''};
  const wrongSource = {...candidate('wrong-source'),ref:{...candidate('wrong-source').ref,sourceId:'plugins' as const}};
  const source = adapter([candidate('valid'),invalid,wrongSource]);
  const page = await searchResources(parseResourceSearchRequest({}),context,[source]);
  expect(page.results.map(r => r.ref.itemId)).toEqual(['valid']);
  expect(page.sourceStatuses.find(s => s.sourceId === 'genui')).toMatchObject({state:'degraded',reason:'invalid-resource-metadata:2 excluded',itemCount:1,listingDigest:expect.any(String)});
  expect((await inspectResource(page.results[0]!.refKey,context,[source])).resource).toEqual(page.results[0]);
});

it('normalizes plugin tags permitted by the manifest without degrading the cohort', async () => {
  const {InstalledPluginRecordSchema} = await import('@mish/contracts');
  const plugin = InstalledPluginRecordSchema.parse({id:'tags-plugin',title:'Tagged plugin',version:'1.0.0',sourceKind:'local',source:'local:test',trust:'restricted',capabilitiesGranted:[],fsPath:'/missing-workbench-plugin-fixture',installedAt:0,updatedAt:0,manifest:{name:'tags-plugin',version:'1.0.0',title:'Tagged plugin',description:'Test',tags:['','  ',' motion ','motion','layout']}});
  const page = await searchResources(parseResourceSearchRequest({facets:{sourceIds:['plugins']}}),context,createLocalResourceSources({listPlugins:async () => [plugin,{...plugin,id:'valid-plugin',manifest:{...plugin.manifest,tags:['valid']}}]}));
  expect(page.results).toHaveLength(2);
  expect(page.results.find(r => r.ref.itemId === plugin.id)?.styleTags).toEqual(['motion','layout']);
  expect(page.sourceStatuses.find(s => s.sourceId === 'plugins')).toMatchObject({state:'searched',reason:null,itemCount:2});
});
