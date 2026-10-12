// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BriefTransformerStatus } from '@mish/contracts';

import { LabsImprovePromptRow } from '../../src/components/LabsImprovePromptRow';
import { I18nProvider } from '../../src/i18n';

const status = (overrides: Partial<BriefTransformerStatus> = {}): BriefTransformerStatus => ({
  lane: 'claude', terraModel: 'openai/gpt-5.6-terra', terraKeyAvailable: true, fallbackModel: 'claude-sonnet-5-5', ...overrides,
});

function stubFetch(sequence: Array<BriefTransformerStatus | 'fail'>) {
  const writes: unknown[] = [];
  let reads = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url === '/api/workbench/briefs/transformer') {
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

const renderRow = () => render(<I18nProvider initial="en"><LabsImprovePromptRow /></I18nProvider>);
const toggle = () => screen.getByTestId('labs-improve-prompt-switch') as HTMLButtonElement;

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('Settings → Labs Improve prompt writer row', () => {
  it('is off (Claude) by default and says prompts go through OpenRouter', async () => {
    stubFetch([status()]);
    renderRow();
    await waitFor(() => expect(toggle().getAttribute('aria-disabled')).toBe('false'));
    expect(toggle().getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText(/OpenRouter/)).toBeTruthy();
  });

  it('writes only improvePromptTransformer and shows the writer and fallback', async () => {
    const { writes } = stubFetch([status(), status({ lane: 'terra' })]);
    renderRow();
    await waitFor(() => expect(toggle().getAttribute('aria-disabled')).toBe('false'));
    fireEvent.click(toggle());
    await waitFor(() => expect(toggle().getAttribute('aria-checked')).toBe('true'));
    expect(writes).toEqual([{ improvePromptTransformer: 'terra' }]);
    expect(screen.getByTestId('labs-improve-prompt-model').textContent).toContain('openai/gpt-5.6-terra');
    expect(screen.getByTestId('labs-improve-prompt-model').textContent).toContain('claude-sonnet-5-5');
  });

  it('turning it off writes claude', async () => {
    const { writes } = stubFetch([status({ lane: 'terra' }), status()]);
    renderRow();
    await waitFor(() => expect(toggle().getAttribute('aria-checked')).toBe('true'));
    fireEvent.click(toggle());
    await waitFor(() => expect(toggle().getAttribute('aria-checked')).toBe('false'));
    expect(writes).toEqual([{ improvePromptTransformer: 'claude' }]);
  });

  it('says Claude writes briefs when no OpenRouter key is set', async () => {
    stubFetch([status({ lane: 'terra', terraKeyAvailable: false })]);
    renderRow();
    await waitFor(() => expect(screen.getByTestId('labs-improve-prompt-no-key')).toBeTruthy());
    expect(toggle().getAttribute('aria-describedby')).toBeTruthy();
  });

  it('locks the switch and offers a retry when the status cannot be read', async () => {
    const { writes } = stubFetch(['fail', status()]);
    renderRow();
    await waitFor(() => expect(screen.getByTestId('labs-improve-prompt-unreadable')).toBeTruthy());
    expect(toggle().getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(toggle());
    await waitFor(() => expect(toggle().getAttribute('aria-disabled')).toBe('false'));
    expect(writes).toEqual([]);
  });
});
