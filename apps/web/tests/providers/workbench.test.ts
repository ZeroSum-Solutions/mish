import { afterEach, describe, expect, it, vi } from 'vitest';
import { searchWorkbenchResources, getWorkbenchResource, postModelPreflight, WorkbenchRequestError } from '../../src/providers/workbench';
afterEach(() => vi.unstubAllGlobals());

describe('Workbench HTTP boundary', () => {
  it('validates input and preserves context requested=true and project scope', async () => {
    const response = { results: [], sourceStatuses: [], context: { requested: true, applied: false, reason: 'context-not-implemented' }, contextRevision: null, nextCursor: null, indexDigest: 'digest', degradedReason: null };
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(response)));
    vi.stubGlobal('fetch', fetcher);
    expect(await searchWorkbenchResources({ query: '', projectId: 'project-a', useProjectContext: true, facets: {}, limit: 20 })).toEqual(response);
    expect(fetcher.mock.calls[0]![0]).toBe('/api/workbench/resources/search');
    expect(fetcher.mock.calls[0]![1].headers['x-od-project-id']).toBe('project-a');
    expect(JSON.parse(fetcher.mock.calls[0]![1].body).useProjectContext).toBe(true);
  });
  it('rejects malformed responses rather than casting readiness', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"results":[]}')));
    await expect(searchWorkbenchResources({ query: '', useProjectContext: true, facets: {}, limit: 20 })).rejects.toThrow();
  });
  it('keeps typed stale/forbidden recovery and encoded ref without leaking a new current key', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: 'resource-ref-stale', message: 'Changed', details: { nextSteps: ['Refresh search'] } } }), { status: 409 }));
    vi.stubGlobal('fetch', fetcher);
    await expect(getWorkbenchResource('opaque/key', 'p')).rejects.toMatchObject({ status: 409, code: 'resource-ref-stale', nextSteps: ['Refresh search'] });
    expect(fetcher.mock.calls[0]![0]).toBe('/api/workbench/resources/opaque%2Fkey?projectId=p');
    expect(WorkbenchRequestError).toBeTruthy();
  });

  // AC-R02.3: the model/attachment preflight check's HTTP boundary (BLOCK
  // finding — until this call site existed, nothing in the web app ever
  // called POST /api/workbench/sessions/:id/model/preflight).
  it('posts the candidate choice/attachments to the preflight endpoint and returns the typed result', async () => {
    const result = { agentId: 'hermes', modelId: 'default', ok: false, mismatches: [
      { code: 'image-attachments-unsupported' as const, message: 'Hermes does not forward image attachments to its model', attachmentNames: ['brief.png'] },
    ] };
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(result)));
    vi.stubGlobal('fetch', fetcher);
    const request = { agentId: 'hermes', modelId: 'default', attachments: [{ name: 'brief.png', kind: 'image' as const, size: 10 }] };
    expect(await postModelPreflight('session-1', 'project-a', request)).toEqual(result);
    expect(fetcher.mock.calls[0]![0]).toBe('/api/workbench/sessions/session-1/model/preflight');
    expect(fetcher.mock.calls[0]![1].method).toBe('POST');
    expect(fetcher.mock.calls[0]![1].headers['x-od-project-id']).toBe('project-a');
    expect(JSON.parse(fetcher.mock.calls[0]![1].body)).toEqual(request);
  });
  it('rejects an unsafe preflight request before it reaches the network', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    await expect(postModelPreflight('session-1', 'project-a', { agentId: 'hermes', modelId: 'default', attachments: [{ name: '../escape', kind: 'file' } as never] })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
