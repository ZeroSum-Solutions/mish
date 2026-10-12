// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StagedRunRecord } from '@open-design/contracts';

import { StagedStageLine, resetStagedEnabledCache } from '../../src/components/chat/StagedStageLine';
import { I18nProvider } from '../../src/i18n';

const stage = (over: Record<string, unknown>) => ({
  stage: 'draft', runId: 'r', agentId: 'claude', model: 'claude-haiku-5-5',
  status: 'pending', startedAt: null, endedAt: null, durationMs: null, ...over,
});

function stubFetch(records: Array<StagedRunRecord | undefined>, enabled = true) {
  const posts: string[] = [];
  const runReads: string[] = [];
  let reads = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (init?.method === 'POST') { posts.push(url); return new Response('{"runId":"r2"}', { status: 202 }); }
    if (url === '/api/agents/staged') return new Response(JSON.stringify({ status: { enabled } }), { status: 200 });
    runReads.push(url);
    const staged = records[Math.min(reads++, records.length - 1)];
    return new Response(JSON.stringify({ id: 'r', ...(staged ? { staged } : {}) }), { status: 200 });
  }));
  return { posts, runReads };
}
const renderLine = () => render(<I18nProvider initial="en"><StagedStageLine runId="r" pollMs={20} /></I18nProvider>);
afterEach(() => { cleanup(); vi.unstubAllGlobals(); resetStagedEnabledCache(); });

describe('StagedStageLine', () => {
  it('asks the daemon about the run only while staged drafting is on', async () => {
    const { runReads } = stubFetch([undefined], false);
    renderLine();
    await new Promise((r) => setTimeout(r, 60));
    expect(runReads).toEqual([]);
  });

  it('renders nothing for an unstaged run', async () => {
    stubFetch([undefined]);
    const { container } = renderLine();
    await new Promise((r) => setTimeout(r, 60));
    expect(container.textContent).toBe('');
  });

  it('shows Drafting with X, then Finishing with Y as the record advances', async () => {
    stubFetch([
      { stages: [stage({ status: 'running' }), stage({ stage: 'finish', model: 'claude-opus-5-5' })], fallback: null } as StagedRunRecord,
      { stages: [stage({ status: 'succeeded' }), stage({ stage: 'finish', model: 'claude-opus-5-5', status: 'running' })], fallback: null } as StagedRunRecord,
    ]);
    renderLine();
    await waitFor(() => expect(screen.getByTestId('staged-line').textContent).toContain('Drafting with Haiku 5.5'));
    await waitFor(() => expect(screen.getByTestId('staged-line').textContent).toContain('Finishing with Opus 5.5'));
  });

  it('offers Finish now when the finishing pass was interrupted', async () => {
    const { posts } = stubFetch([
      { stages: [stage({ status: 'succeeded' }), stage({ stage: 'finish', model: 'claude-opus-5-5', status: 'interrupted' })], fallback: null, interrupted: { message: 'm' } } as StagedRunRecord,
    ]);
    renderLine();
    const button = await screen.findByRole('button', { name: 'Finish now' });
    expect(screen.getByTestId('staged-line').textContent).toContain('Draft only — finishing pass interrupted');
    fireEvent.click(button);
    await waitFor(() => expect(posts).toEqual(['/api/runs/r/staged/finish']));
  });

  it('re-arms polling after Finish now until the resumed finish reaches its terminal state (V07 WARN)', async () => {
    const record = (status: string) => ({ stages: [stage({ status: 'succeeded' }), stage({ stage: 'finish', model: 'claude-opus-5-5', status })], fallback: null, interrupted: status === 'interrupted' ? { message: 'm' } : null }) as StagedRunRecord;
    const { runReads } = stubFetch([record('interrupted'), record('running'), record('running'), record('succeeded')]);
    renderLine();
    fireEvent.click(await screen.findByRole('button', { name: 'Finish now' }));
    await waitFor(() => expect(screen.getByTestId('staged-line').getAttribute('data-state')).toBe('done'));
    const terminalReads = runReads.length;
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(runReads).toHaveLength(terminalReads);
  });
});
