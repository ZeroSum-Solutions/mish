import { afterEach, describe, expect, it, vi } from 'vitest';
import { streamViaDaemon } from '../../src/providers/daemon';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks(); });
const stage = (stage: string, runId: string | null, status: string) => ({ stage, runId, status, agentId: 'claude', model: 'mock', startedAt: null, endedAt: null, durationMs: null });
const record = (status: string, nextId: string | null, fallback = false) => ({
  stages: [stage('draft', 'draft', fallback ? 'failed' : 'succeeded'), stage('finish', fallback ? null : nextId, fallback ? 'skipped' : status), ...(fallback ? [stage('single', nextId, status)] : [])],
  fallback: fallback ? { reason: 'draft_failed', message: 'fallback' } : null,
});
function events(text: string, end: unknown) {
  return new Response(`event: stdout\ndata: ${JSON.stringify({ chunk: text })}\n\nevent: end\ndata: ${JSON.stringify(end)}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
}

describe('staged successors through the existing daemon stream loop (V07 BLOCK 4)', () => {
  it('reports a deadline when allocation never produces a successor', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === '/api/runs') return Response.json({ runId: 'draft' }, { status: 202 });
      if (String(input).endsWith('/events')) return events('Draft.', { status: 'succeeded', code: 0, staged: record('pending', null) });
      return Response.json({ id: 'draft', status: 'succeeded', staged: record('pending', null) });
    }));
    const handlers = { onDelta: vi.fn(), onDone: vi.fn(), onError: vi.fn(), onAgentEvent: vi.fn() };
    const streaming = streamViaDaemon({ agentId: 'mock', history: [], signal: new AbortController().signal, handlers });
    await vi.advanceTimersByTimeAsync(30_200);
    expect(handlers.onError).toHaveBeenCalled();
    expect(String(handlers.onError.mock.calls[0]?.[0])).toMatch(/successor.*timed out/i);
    expect(handlers.onDone).not.toHaveBeenCalled();
    await streaming;
  });

  it('bounds a hanging status read without AbortSignal.any', async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, 'any').mockImplementation(() => { throw new Error('AbortSignal.any unavailable'); });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/runs') return Response.json({ runId: 'draft' }, { status: 202 });
      if (String(input).endsWith('/events')) return events('Draft.', { status: 'succeeded', code: 0, staged: record('pending', null) });
      return new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => reject(new Error('read aborted')), { once: true });
      });
    }));
    const handlers = { onDelta: vi.fn(), onDone: vi.fn(), onError: vi.fn(), onAgentEvent: vi.fn() };
    const streaming = streamViaDaemon({ agentId: 'mock', history: [], signal: new AbortController().signal, handlers });
    await vi.advanceTimersByTimeAsync(30_200);
    expect(String(handlers.onError.mock.calls[0]?.[0])).toMatch(/successor.*timed out/i);
    await streaming;
  });

  it.each([false, true])('waits for the successor allocation and streams the finishing answer (fallback=%s)', async fallback => {
    let reads = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/runs') return Response.json({ runId: 'draft' }, { status: 202 });
      if (url === '/api/runs/draft/events') return events('Draft.\n', { status: fallback ? 'failed' : 'succeeded', code: fallback ? 1 : 0, staged: record('pending', null, fallback) });
      if (url === '/api/runs/draft') return Response.json({ id: 'draft', status: fallback ? 'failed' : 'succeeded', staged: ++reads === 1 ? record('pending', null, fallback) : record('running', 'finish', fallback) });
      if (url === '/api/runs/finish/events') return events('Finishing answer.', { status: 'succeeded', code: 0, staged: record('succeeded', 'finish', fallback) });
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const handlers = { onDelta: vi.fn(), onDone: vi.fn(), onError: vi.fn(), onAgentEvent: vi.fn() };
    const onRunCreated = vi.fn();
    await streamViaDaemon({ agentId: 'mock', history: [{ id: 'u', role: 'user', content: 'Build it' }], signal: new AbortController().signal, handlers, onRunCreated });
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toContain('/api/runs/finish/events');
    expect(onRunCreated.mock.calls.map(([id]) => id)).toEqual(['draft', 'finish']);
    expect(handlers.onError).not.toHaveBeenCalled();
    expect(handlers.onDone).toHaveBeenCalledExactlyOnceWith('Draft.\nFinishing answer.');
  });
});
