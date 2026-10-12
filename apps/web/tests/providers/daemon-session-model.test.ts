import { afterEach, describe, expect, it, vi } from 'vitest';
import { admission } from '../fixtures/session-admission';
import { streamViaDaemon } from '../../src/providers/daemon';
const binding = { protocol: 'openai' as const, baseUrl: 'https://gateway.example/v1', requiresApiKey: true };
afterEach(() => vi.unstubAllGlobals());
describe('daemon session model caller transport', () => {
  it.each(['valid', 'foreign', 'absent'])('projects only scoped host admission from the accepted response (%s)', async mode => {
    const onRunCreated = vi.fn(); const onModelAdmission = vi.fn(); const onError = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url === '/api/runs'
      ? new Response(JSON.stringify({ runId: admission.runId, ...(mode === 'absent' ? {} : { modelAdmission: mode === 'foreign' ? { ...admission, sessionId: 'another-session' } : admission }) }), { status: 202 })
      : new Response('event: end\ndata: {"status":"succeeded","artifactCount":0}\n\n')));
    await streamViaDaemon({ agentId: 'codex', model: 'default', expectedModelRevision: 3, projectId: admission.projectId, conversationId: admission.sessionId, signal: new AbortController().signal, history: [{ id: 'user', role: 'user', content: 'input', createdAt: 0 }], onRunCreated, onModelAdmission, handlers: { onDelta() {}, onDone() {}, onAgentEvent() {}, onError } });
    expect(onRunCreated).toHaveBeenCalledWith(admission.runId);
    if (mode === 'valid') expect(onModelAdmission).toHaveBeenCalledWith(admission);
    else expect(onModelAdmission).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });
  it.each([{ agentId: 'codex', model: 'default', expectedModelRevision: 0 }, { agentId: 'byok-opencode', model: 'raw-custom', expectedModelRevision: 7, byokBinding: binding }])('serializes the complete raw requested pair and revision for $agentId', async choice => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ error: { code: 'VALIDATION_FAILED', message: 'fixture stops before execution' } }), { status: 400 }));
    vi.stubGlobal('fetch', fetch);
    const onError = vi.fn();
    await streamViaDaemon({ ...choice, signal: new AbortController().signal, history: [{ id: 'user', role: 'user', content: 'input', createdAt: 0 }], projectId: 'project', conversationId: 'actual-seed', clientRequestId: 'logical-request', reasoning: 'high', serviceTier: 'fast', handlers: { onDelta() {}, onDone() {}, onAgentEvent() {}, onError } });
    const [url, options] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/runs');
    expect(JSON.parse(options.body as string)).toMatchObject({ ...choice, projectId: 'project', conversationId: 'actual-seed', clientRequestId: 'logical-request', reasoning: 'high', serviceTier: 'fast' });
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
