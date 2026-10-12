import { expect, it } from 'vitest';
import { parseResourceSearchRequest, type ResourceSearchRequest } from '@mish/contracts';
import { searchResources, type ResourceSourceAdapter } from '../../src/workbench/resources.js';
import { candidate, savedContext, adapter, projectState } from './context-ranking-fixture.js';
const authority = { principalId: 'local-daemon', projectId: 'p' };
const request = (input: Partial<ResourceSearchRequest> = {}) => parseResourceSearchRequest({ query: 'needle', useProjectContext: true, ...input });

// AC-R05.4: empty index, absent project, an offline licensed connector, an unavailable
// remote source and a ranking timeout each yield a distinct, truthful message with
// lexical fallback. All five reuse the existing sourceStatuses/context/degradedReason
// response fields; none required a new field.
it('empty index: a genuinely empty, non-degraded index gets its own message, not the generic "some sources failed" text', async () => {
  const result = await searchResources(request(), authority, [adapter([])]);
  expect(result.results).toEqual([]);
  expect(result.degradedReason).toBe('The resource index currently has no items for this scope');
});
it('absent project: context.reason is context-absent, independent of whether the index itself is empty', async () => {
  const result = await searchResources(request({ useProjectContext: undefined }), authority, [adapter([candidate('a')])], { projectState: projectState(null) });
  expect(result.context).toMatchObject({ requested: true, reason: 'context-absent', projectId: 'p' });
  expect(result.degradedReason).toBeNull();
});
it('offline licensed connector: an unavailable source reports its own distinct reason text, not the previous generic string', async () => {
  const source: ResourceSourceAdapter = { sourceId: 'react-bits', async list() { return { items: [], status: { sourceId: 'react-bits', state: 'unavailable', reason: 'licensed connector offline', itemCount: null, listingDigest: null } }; } };
  const result = await searchResources(request(), authority, [source]);
  expect(result.sourceStatuses.find(status => status.sourceId === 'react-bits')).toMatchObject({ state: 'unavailable', reason: 'licensed connector offline' });
  expect(result.degradedReason).toContain('licensed connector offline');
  expect(result.degradedReason).not.toBe('Some local sources could not be searched');
});
it('unavailable remote source: a degraded source reports its own distinct reason text', async () => {
  const source: ResourceSourceAdapter = { sourceId: 'mobbin', async list() { return { items: [], status: { sourceId: 'mobbin', state: 'degraded', reason: 'remote source unavailable: timeout contacting connector', itemCount: null, listingDigest: null } }; } };
  const result = await searchResources(request(), authority, [source]);
  expect(result.sourceStatuses.find(status => status.sourceId === 'mobbin')).toMatchObject({ state: 'degraded' });
  expect(result.degradedReason).toContain('remote source unavailable: timeout contacting connector');
});
it('timeout: the ranking-timeout message stays distinct from the four source/index messages above', async () => {
  const context = savedContext({ spineCode: 'SM' });
  const ticks = [0, 0, 251]; let index = 0;
  const result = await searchResources(request(), authority, [adapter([candidate('needle-a')])], { projectState: projectState(context), ranking: { now: () => ticks[index++] ?? 251 } });
  expect(result.context).toMatchObject({ reason: 'ranking-timeout', resultMode: 'timeout-lexical' });
  expect(result.degradedReason).toContain('lexical');
  expect(result.degradedReason).not.toMatch(/unavailable|degraded|no items/iu);
});
it('keeps every one of the five messages textually distinct from each other', async () => {
  const emptyIndex = (await searchResources(request(), authority, [adapter([])])).degradedReason;
  const unavailable = (await searchResources(request(), authority, [{ sourceId: 'react-bits', async list() { return { items: [], status: { sourceId: 'react-bits', state: 'unavailable', reason: 'licensed connector offline', itemCount: null, listingDigest: null } }; } }])).degradedReason;
  const degraded = (await searchResources(request(), authority, [{ sourceId: 'mobbin', async list() { return { items: [], status: { sourceId: 'mobbin', state: 'degraded', reason: 'remote source unavailable', itemCount: null, listingDigest: null } }; } }])).degradedReason;
  const ticks = [0, 0, 251]; let index = 0;
  const timeout = (await searchResources(request(), authority, [adapter([candidate('needle-a')])], { projectState: projectState(savedContext({ spineCode: 'SM' })), ranking: { now: () => ticks[index++] ?? 251 } })).degradedReason;
  const absentProject = (await searchResources(request({ useProjectContext: undefined }), authority, [adapter([candidate('a')])], { projectState: projectState(null) })).degradedReason;
  expect(new Set([emptyIndex, unavailable, degraded, timeout, absentProject].filter((value): value is string => value !== null)).size).toBe(4); // absentProject has no degradedReason of its own (null); the other four are each unique
});
