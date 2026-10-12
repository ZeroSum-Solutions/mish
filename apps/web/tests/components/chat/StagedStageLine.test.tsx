// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StagedStageLine, resetStagedEnabledCache } from '../../../src/components/chat/StagedStageLine';

vi.mock('../../../src/i18n', () => ({ useT: () => (key: string) => key }));
const record = (status: string) => ({ stages: [
  { stage: 'draft', status: 'succeeded', model: 'claude-haiku-5-5' },
  { stage: 'finish', status, model: 'claude-opus-5-5' },
], fallback: null });
beforeEach(() => { vi.useFakeTimers(); resetStagedEnabledCache(); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('StagedStageLine recovery', () => {
  it('retries an initial switch read failure instead of caching it as disabled', async () => {
    let switchReads = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === '/api/agents/staged') {
        if (++switchReads === 1) throw new Error('temporary outage');
        return Response.json({ status: { enabled: true } });
      }
      return Response.json({ staged: record('succeeded') });
    }));
    await act(async () => { render(<StagedStageLine runId="draft" pollMs={100} />); });
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(screen.getByRole('status').getAttribute('data-state')).toBe('done');
  });

  it('stops polling a run that no longer exists', async () => {
    let reads = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === '/api/agents/staged') return Response.json({ status: { enabled: true } });
      reads++;
      return new Response('', { status: 404 });
    }));
    await act(async () => { render(<StagedStageLine runId="removed" pollMs={100} />); });
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(reads).toBe(1);
  });

  it.each(['network', 'http'] as const)('keeps the active line and retries a %s read with capped backoff', async failure => {
    let reads = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === '/api/agents/staged') return Response.json({ status: { enabled: true } });
      reads++;
      if (reads === 1) return Response.json({ staged: record('running') });
      if (reads <= 3) {
        if (failure === 'network') throw new Error('temporary outage');
        return new Response('', { status: 503 });
      }
      return Response.json({ staged: record('succeeded') });
    });
    vi.stubGlobal('fetch', fetchMock);
    await act(async () => { render(<StagedStageLine runId="draft" pollMs={100} />); });
    expect(screen.getByRole('status').getAttribute('data-state')).toBe('finishing');
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(screen.getByRole('status').getAttribute('data-state')).toBe('finishing');
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(reads).toBe(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(reads).toBe(3);
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    expect(screen.getByRole('status').getAttribute('data-state')).toBe('done');
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(reads).toBe(4);
  });
});
