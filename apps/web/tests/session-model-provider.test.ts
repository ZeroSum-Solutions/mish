import { afterEach, describe, expect, it, vi } from 'vitest';
import { getSessionModel, putSessionModel, WorkbenchRequestError } from '../src/providers/workbench';
const snapshot = { sessionId: 'conversation', projectId: 'project', revision: 1, choice: { agentId: 'codex', modelId: 'default' }, updatedAt: 0 };
afterEach(() => vi.unstubAllGlobals());
describe('session model HTTP boundary', () => {
  it('sends the complete revisioned public choice to the existing conversation', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(snapshot), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    expect(await putSessionModel('conversation', 'project', { ...snapshot.choice, expectedRevision: 0 })).toEqual(snapshot);
    const [url, options] = fetch.mock.calls[0]!;
    expect(url).toBe('/api/workbench/sessions/conversation/model');
    expect(options.headers['x-od-project-id']).toBe('project');
    expect(JSON.parse(options.body)).toEqual({ ...snapshot.choice, expectedRevision: 0 });
  });
  it('refuses a snapshot for a different project or conversation', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ ...snapshot, projectId: 'other' }))));
    await expect(getSessionModel('conversation', 'project')).rejects.toThrow('session-model-scope-mismatch');
  });
  it('retains typed conflict status without trusting unknown error details', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: 'SESSION_MODEL_REVISION_CONFLICT', message: 'conflict', details: { current: { secret: 'not a snapshot' } } } }), { status: 409 })));
    await expect(putSessionModel('conversation', 'project', { ...snapshot.choice, expectedRevision: 0 })).rejects.toMatchObject({ status: 409, code: 'SESSION_MODEL_REVISION_CONFLICT' } satisfies Partial<WorkbenchRequestError>);
  });
  it('rejects secret-bearing or incomplete PUT input before any request', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await expect(putSessionModel('conversation', 'project', { agentId: 'byok-opencode', modelId: 'model', expectedRevision: 0 })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
