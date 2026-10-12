import { afterEach, expect, it, vi } from 'vitest';
import { streamRunEvents } from '../src/run-watch-cli.js';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks(); });
it('bounds the successor allocation wait after a completed physical run', async () => {
  vi.useFakeTimers();
  const staged = { stages: [{ stage: 'draft', status: 'succeeded', runId: 'draft' }, { stage: 'finish', status: 'pending', runId: null }], fallback: null };
  const start = Date.now();
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    if (input.endsWith('/events')) return new Response(`event: end\ndata: ${JSON.stringify({ status: 'succeeded', staged })}\n\n`);
    return Response.json({ staged: Date.now() - start < 30_100 ? staged : { ...staged, stopped: { reason: 'superseded' } } });
  }));
  const outcome = streamRunEvents('http://fixture', 'draft').then(() => null, error => error as Error);
  await vi.advanceTimersByTimeAsync(30_200);
  expect(String(await outcome)).toMatch(/successor.*timed out/i);
});

it('reports its deadline when a status request hangs', async () => {
  vi.useFakeTimers();
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException('timed out', 'TimeoutError')), ms);
    return controller.signal;
  });
  const staged = { stages: [{ stage: 'draft', status: 'succeeded', runId: 'draft' }, { stage: 'finish', status: 'pending', runId: null }], fallback: null };
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    if (input.endsWith('/events')) return new Response(`event: end\ndata: ${JSON.stringify({ status: 'succeeded', staged })}\n\n`);
    return new Promise<Response>((_resolve, reject) => { init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true }); });
  }));
  const outcome = streamRunEvents('http://fixture', 'draft').then(() => null, error => error as Error);
  await vi.advanceTimersByTimeAsync(30_200);
  expect(String(await outcome)).toMatch(/successor.*timed out/i);
});
