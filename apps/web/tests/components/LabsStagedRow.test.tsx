// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StagedDraftingStatus } from '@open-design/contracts';

import { LabsStagedRow } from '../../src/components/LabsStagedRow';
import { I18nProvider } from '../../src/i18n';

const status = (overrides: Partial<StagedDraftingStatus> = {}): StagedDraftingStatus => ({
  enabled: false,
  draft: { agentId: 'claude', model: 'claude-haiku-5-5', source: 'claude' },
  unavailableReason: null,
  ...overrides,
});

function stubFetch(sequence: Array<StagedDraftingStatus | 'fail'>) {
  const writes: unknown[] = [];
  let reads = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url === '/api/agents/staged') {
      const next = sequence[Math.min(reads++, sequence.length - 1)]!;
      if (next === 'fail') return new Response('{}', { status: 500 });
      return new Response(JSON.stringify({ status: next }), { status: 200 });
    }
    if (url === '/api/app-config' && init?.method === 'PUT') {
      writes.push(JSON.parse(String(init.body)));
      return new Response('{"config":{}}', { status: 200 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }));
  return { writes };
}

const renderRow = () => render(<I18nProvider initial="en"><LabsStagedRow /></I18nProvider>);
const toggle = () => screen.getByTestId('labs-staged-switch') as HTMLButtonElement;

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('Settings → Labs staged drafting row', () => {
  it('is off by default and names the fast model it would use', async () => {
    stubFetch([status()]);
    renderRow();
    await waitFor(() => expect(toggle().getAttribute('aria-disabled')).toBe('false'));
    expect(toggle().getAttribute('aria-checked')).toBe('false');
    expect(screen.getByTestId('labs-staged-draft').textContent).toContain('claude-haiku-5-5');
  });

  it('writes only stagedDrafting and shows the daemon answer', async () => {
    const { writes } = stubFetch([status(), status({ enabled: true })]);
    renderRow();
    await waitFor(() => expect(toggle().getAttribute('aria-disabled')).toBe('false'));
    fireEvent.click(toggle());
    await waitFor(() => expect(toggle().getAttribute('aria-checked')).toBe('true'));
    expect(writes).toEqual([{ stagedDrafting: true }]);
  });

  it('says so when no fast model is reachable', async () => {
    stubFetch([status({ draft: null, unavailableReason: 'draft_unavailable' })]);
    renderRow();
    await waitFor(() => expect(screen.getByTestId('labs-staged-unavailable')).toBeTruthy());
  });

  it('an unreadable status locks the switch; a click retries the read', async () => {
    stubFetch(['fail', status()]);
    renderRow();
    await waitFor(() => expect(screen.getByTestId('labs-staged-unreadable')).toBeTruthy());
    fireEvent.click(toggle());
    await waitFor(() => expect(toggle().getAttribute('aria-disabled')).toBe('false'));
  });
});
