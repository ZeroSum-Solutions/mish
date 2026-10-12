import { afterEach, expect, it, vi } from 'vitest';
import { parseResourceSearchRequest, type ResourceSearchRequest } from '@open-design/contracts';
import { searchResources, createLocalResourceSources } from '../../src/workbench/resources.js';
import { candidate, savedContext, booking, adapter, projectState } from './context-ranking-fixture.js';
const authority = { principalId: 'local-daemon', projectId: 'p' };
const request = (input: Partial<ResourceSearchRequest> = {}) => parseResourceSearchRequest({ query: 'needle', useProjectContext: true, ...input });
const resources = [candidate('needle-a'),candidate('needle-b'),candidate('needle-c')];
afterEach(() => vi.restoreAllMocks());
it('retrieves actual public section spine/section metadata for a long dentistry request with zero provider calls', async () => {
  const provider = vi.spyOn(globalThis, 'fetch'); const sources = createLocalResourceSources({ listPlugins: async () => [] });
  const result = await searchResources(request({ query: 'Build a calm premium dentistry page where new patients book their first appointment', facets: { sourceIds: ['sections'] }, limit: 100 }), authority, sources, { projectState: projectState(savedContext({ spineCode: 'SM', conversions: [booking] })) });
  expect(result.results.length).toBeGreaterThan(0); expect(result.context).toMatchObject({ requested: true, applied: true, reason: null, projectId: 'p', observedContextRevision: 1, resultMode: 'ranked' });
  expect(result.contextRevision).toBe(1); expect(result.results.some(item => item.fitReasons.some(reason => /spineAffinities|sectionKind/.test(reason)))).toBe(true);
  expect(result.results.every(item => Array.isArray(item.spineAffinities) && item.spineAffinities.includes('SM') || ['booking-availability','cta-band'].includes(item.sectionKind ?? ''))).toBe(true);
  expect(result.results.every(item => item.readiness !== 'usable' && !item.adoptionCapability.available)).toBe(true); expect(provider).not.toHaveBeenCalled();
});
it('resolves omitted context selection from saved preferences and leaves request overrides unsaved', async () => {
  const state = projectState(savedContext({ spineCode: 'SM', constraints: [{id:'none',kind:'motion',value:'none'}] }), false, 2); const unchanged = structuredClone(state);
  const sources = [adapter([...resources,candidate('needle-motion',{category:'motion'})])];
  const off = await searchResources(request({ useProjectContext: undefined }), authority, sources, { projectState: state });
  expect(off.context).toEqual({ requested:false,applied:false,reason:'context-disabled',projectId:'p',preferenceRevision:2,observedContextRevision:1,selection:'saved',rankingVersion:'local-context/1',resultMode:'lexical' });
  expect(off.excluded).toEqual([]); expect(off.results.some(item => item.category === 'motion')).toBe(true);
  const on = await searchResources(request(), authority, sources, { projectState: state });
  expect(on.context).toMatchObject({ requested:true,applied:true,preferenceRevision:2,selection:'request-override' }); expect(on.excluded).toEqual([{reason:'motion-constraint',constraintId:'none',count:1}]); expect(state).toEqual(unchanged);
});
it('uses default-on absence with explicit no-project/context-absent/unsupported lexical branches', async () => {
  const sources = [adapter(resources)];
  const absent = await searchResources(request({ useProjectContext: undefined }), authority, sources, { projectState: projectState(null) });
  expect(absent.context).toMatchObject({ requested:true,reason:'context-absent',projectId:'p',observedContextRevision:0,preferenceRevision:0,selection:'saved',resultMode:'lexical' }); expect(absent.results).toHaveLength(3);
  const noProject = await searchResources(request(), {principalId:'local-daemon'}, sources);
  expect(noProject.context).toMatchObject({ reason:'no-project',projectId:null,observedContextRevision:0,preferenceRevision:0 });
  for (const context of [savedContext(),savedContext({purpose:'Premium React dentistry',styleDirection:'windows95',conversions:[{...booking,kind:'other'}]})]) {
    const result = await searchResources(request(), authority, sources, {projectState:projectState(context)});
    expect(result.context).toMatchObject({reason:'context-not-rankable',observedContextRevision:1,resultMode:'lexical'}); expect(result.results).toHaveLength(3); expect(result.contextRevision).toBeNull();
  }
});
it('reports supported zero-fit context as applied and preserves duplicate identities and restrictions', async () => {
  const sources = [adapter([candidate('a',{title:'Same',spineAffinities:['SM']}),candidate('a',{title:'Same',spineAffinities:['SM']}),candidate('b',{title:'Same',spineAffinities:['SM']})])];
  const options = {projectState:projectState(savedContext({spineCode:'SM'}))};
  const result = await searchResources(request(),authority,sources,options); expect(result.results).toHaveLength(2); expect(new Set(result.results.map(item=>item.refKey)).size).toBe(2);
  expect(result.results.every(item=>item.rightsStatus==='restricted' && item.operationGrants[0]?.state==='blocked' && !item.adoptionCapability.available)).toBe(true);
  const zero = await searchResources(request(),authority,[adapter([candidate('unknown',{spineAffinities:'any',sectionKind:'unclassified'})])],options);
  expect(zero.context).toMatchObject({applied:true,resultMode:'ranked'}); expect(zero.contextRevision).toBe(1); expect(zero.results).toEqual([]);
});
it('binds cursors to observed revisions even when disabled or explicitly overridden', async () => {
  const sources = [adapter(resources)]; const initial = projectState(savedContext({spineCode:'SM'}),false,2);
  const query = request({limit:1,useProjectContext:false}); const first = await searchResources(query,authority,sources,{projectState:initial}); expect(first.nextCursor).toBeTruthy();
  for (const changed of [projectState(savedContext({spineCode:'SM'},2),false,2),projectState(initial.context.context,false,3)]) await expect(searchResources({...query,cursor:first.nextCursor!},authority,sources,{projectState:changed})).rejects.toMatchObject({status:409,code:'resource-cursor-stale'});
  const second = await searchResources({...query,cursor:first.nextCursor!},authority,sources,{projectState:initial}); expect(second.results[0]?.refKey).not.toBe(first.results[0]?.refKey);
});
it('binds query, facets, authority, selection, index, limit and ordering environment to cursors', async () => {
  const sources = [adapter(resources)]; const options = {projectState:projectState(savedContext({spineCode:'SM'})),orderingEnvironmentDigest:'environment-a'};
  const query = request({limit:1}); const first = await searchResources(query,authority,sources,options);
  for (const changed of [{query:'other'},{limit:2},{facets:{category:'section' as const}},{useProjectContext:undefined}]) await expect(searchResources({...query,...changed,cursor:first.nextCursor!},authority,sources,options)).rejects.toMatchObject({code:'resource-cursor-stale'});
  await expect(searchResources({...query,cursor:first.nextCursor!},{...authority,principalId:'workspace:other:member'},sources,options)).rejects.toMatchObject({code:'resource-cursor-stale'});
  await expect(searchResources({...query,cursor:first.nextCursor!},authority,[adapter([candidate('needle-a',{ref:{...resources[0]!.ref,revisionOrDigest:'v2'}}),...resources.slice(1)])],options)).rejects.toMatchObject({code:'resource-cursor-stale'});
  await expect(searchResources({...query,cursor:first.nextCursor!},authority,sources,{...options,orderingEnvironmentDigest:'environment-b'})).rejects.toMatchObject({code:'resource-cursor-stale'});
});
it('returns timed lexical fallback with observed revisions and exclusions and pins subsequent pages to that order', async () => {
  const context = savedContext({spineCode:'SM',constraints:[{id:'none',kind:'motion',value:'none'}]}); const state = projectState(context,true,1);
  const sources = [adapter([...resources,candidate('context-only',{spineAffinities:['SM']}),candidate('needle-animation',{category:'motion'})])];
  const ticks = [0,0,0,251]; let index=0;
  const query = request({limit:1}); const first = await searchResources(query,authority,sources,{projectState:state,ranking:{now:()=>ticks[index++]??251}});
  expect(first.context).toMatchObject({requested:true,applied:false,reason:'ranking-timeout',observedContextRevision:1,preferenceRevision:1,resultMode:'timeout-lexical'}); expect(first.contextRevision).toBeNull(); expect(first.degradedReason?.toLowerCase()).toContain('lexical');
  expect(first.excluded).toEqual([{reason:'motion-constraint',constraintId:'none',count:1}]); expect(first.results.map(item=>item.ref.itemId)).toEqual(['needle-a']);
  const second = await searchResources({...query,cursor:first.nextCursor!},authority,sources,{projectState:state,ranking:{now:()=>0}});
  expect(second.context).toMatchObject({resultMode:'timeout-lexical'}); expect(second.results.map(item=>item.ref.itemId)).toEqual(['needle-b']); expect(second.excluded).toEqual(first.excluded);
  const third = await searchResources({...query,cursor:second.nextCursor!},authority,sources,{projectState:state,ranking:{now:()=>0}});
  expect(third.results.map(item=>item.ref.itemId)).toEqual(['needle-c']); expect(third.nextCursor).toBeNull();
  const forged = JSON.parse(Buffer.from(first.nextCursor!,'base64url').toString('utf8')); forged[3]='ranked';
  await expect(searchResources({...query,cursor:Buffer.from(JSON.stringify(forged)).toString('base64url')},authority,sources,{projectState:state,ranking:{now:()=>0}})).rejects.toMatchObject({status:409,code:'resource-cursor-stale'});
});
it('counts motion exclusions over the matching facet cohort before pagination and preserves unknown state', async () => {
  const sources=[adapter([...resources,candidate('needle-animated',{motionMetadata:{state:'animated',basis:'declared',sourceRevisionOrDigest:'v1',field:'manifest.motion'}}),candidate('irrelevant-animated',{category:'motion'})])];
  const result=await searchResources(request({limit:1}),authority,sources,{projectState:projectState(savedContext({constraints:[{id:'none',kind:'motion',value:'none'}]}))});
  expect(result.excluded).toEqual([{reason:'motion-constraint',constraintId:'none',count:1}]); expect(result.results).toHaveLength(1); expect(result.results[0]?.motionMetadata).toBeUndefined(); expect(result.results[0]?.fitReasons.join(' ').toLowerCase()).toContain('unknown');
});
it('denies foreign saved snapshots before source listing and filters invalid motion metadata without promoting neighbors', async () => {
  const source = adapter(resources); const list = vi.spyOn(source,'list'); const state=projectState(savedContext({spineCode:'SM'}));
  const foreign = {...state,context:{...state.context,projectId:'q',context:{...state.context.context!,projectId:'q'}}};
  await expect(searchResources(request(),authority,[source],{projectState:foreign})).rejects.toMatchObject({status:403,code:'project-forbidden'}); expect(list).not.toHaveBeenCalled();
  const invalid=candidate('needle-invalid',{motionMetadata:{state:'static',basis:'declared',sourceRevisionOrDigest:'old',field:'manifest.motion'}});
  const result=await searchResources(request(),authority,[adapter([resources[0]!,invalid])],{projectState:state});
  expect(result.results.map(item=>item.ref.itemId)).toEqual(['needle-a']); expect(result.sourceStatuses.find(status=>status.sourceId==='sections')).toMatchObject({state:'degraded',itemCount:1});
});
