import { afterEach, expect, it, vi } from 'vitest';
import * as api from '../../src/providers/workbench';
afterEach(() => vi.unstubAllGlobals());
const absent = { projectId: 'p', revision: 0, context: null };
const draft = { purpose: null, audience: [], conversions: [], brandDirection: null, constraints: [], factSources: [], assumptions: ['Goals are unknown'] };
it('gets strict current/history snapshots with explicit project scope', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(absent))); vi.stubGlobal('fetch', fetcher);
  expect(await api.getProjectDesignContext('p')).toEqual(absent);
  expect(fetcher.mock.calls[0]![0]).toBe('/api/workbench/projects/p/context');
  expect(fetcher.mock.calls[0]![1].headers['x-od-project-id']).toBe('p');
  fetcher.mockResolvedValue(new Response(JSON.stringify({ ...absent, projectId: 'foreign' })));
  await expect(api.getProjectDesignContext('p')).rejects.toThrow('scope');
  await expect(api.getProjectDesignContext('p', undefined, 0)).rejects.toThrow();
});
it('sends complete CAS drafts and omits search preference overrides', async () => {
 const response = { projectId: 'p', revision: 0, preferences: null, effective: { useProjectContext: true } };
 const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(response))); vi.stubGlobal('fetch', fetcher);
 expect(await api.putWorkbenchPreferences('p', { expectedRevision: 0, useProjectContext: false })).toEqual(response);
 expect(JSON.parse(fetcher.mock.calls[0]![1].body)).toEqual({ expectedRevision: 0, useProjectContext: false });
 fetcher.mockResolvedValue(new Response(JSON.stringify(absent)));
 await api.putProjectDesignContext('p', { expectedRevision: 0, draft });
 expect(JSON.parse(fetcher.mock.calls[1]![1].body)).toEqual({ expectedRevision: 0, draft });
 fetcher.mockResolvedValue(new Response(JSON.stringify({ results: [], sourceStatuses: [], context: { requested: true, applied: false, reason: 'context-not-implemented' }, contextRevision: null, nextCursor: null, indexDigest: 'd', degradedReason: null })));
 await api.searchWorkbenchResources({ projectId: 'p', query: 'keep query', facets: {}, limit: 20 });
 expect(JSON.parse(fetcher.mock.calls[2]![1].body)).not.toHaveProperty('useProjectContext');
});
it('validates authorized conflict current before preserving it in the typed error', async () => {
 const current = { projectId: 'p', revision: 0, preferences: null, effective: { useProjectContext: true } };
 const fetcher = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ error: { code: 'CONFLICT', message: 'Changed', details: { current } } }), { status: 409 }))); vi.stubGlobal('fetch', fetcher);
 await expect(api.putWorkbenchPreferences('p', { expectedRevision: 0, useProjectContext: false })).rejects.toMatchObject({ status: 409, current });
 current.projectId = 'foreign';
 await expect(api.putWorkbenchPreferences('p', { expectedRevision: 0, useProjectContext: false })).rejects.toThrow('scope');
});
it('reads rubric and rejects malformed/history-mismatched successful DTOs', async () => {
 const fetcher = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ projectId: 'p', revision: 0, rubric: null, linkage: null })))); vi.stubGlobal('fetch', fetcher);
 expect(await api.getProjectRubric('p')).toMatchObject({ rubric: null, linkage: null });
 await expect(api.getProjectRubric('p', undefined, 1)).rejects.toThrow('scope');
 fetcher.mockImplementation(() => Promise.resolve(new Response('{}')));
 await expect(api.getWorkbenchPreferences('p')).rejects.toThrow();
});
it('preserves an explicit search override without writing the project preference', async () => {
 const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ results: [], sourceStatuses: [], excluded: [], context: { requested: false, applied: false, reason: 'context-disabled', projectId: 'p', preferenceRevision: 0, observedContextRevision: 0, selection: 'request-override', rankingVersion: 'local-context/1', resultMode: 'lexical' }, contextRevision: null, nextCursor: null, indexDigest: 'd', degradedReason: null }))); vi.stubGlobal('fetch', fetcher);
 await api.searchWorkbenchResources({ projectId: 'p', query: 'keep query', facets: {}, limit: 20, useProjectContext: false });
 expect(fetcher).toHaveBeenCalledTimes(1); expect(fetcher.mock.calls[0]![0]).toBe('/api/workbench/resources/search'); expect(JSON.parse(fetcher.mock.calls[0]![1].body).useProjectContext).toBe(false);
});
