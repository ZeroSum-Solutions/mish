// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkbenchAdoptionStatus } from '@mish/contracts';

import { LabsAdoptionRow } from '../../src/components/LabsAdoptionRow';
import { I18nProvider } from '../../src/i18n';

function adoptionStatus(overrides: Partial<WorkbenchAdoptionStatus> = {}): WorkbenchAdoptionStatus {
  return {
    executor: 'closed', placementMode: 'coordinated-open',
    optIn: { env: true, labs: false },
    host: { platform: 'darwin', arch: 'arm64', supported: true },
    gates: ['hero-proof-missing', 'adoption-executor-unprovisioned', 'adoption-opt-in-labs-off'],
    ...overrides,
  };
}

function stubFetch(sequence: Array<WorkbenchAdoptionStatus | 'fail'>) {
  const writes: unknown[] = [];
  let reads = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url === '/api/workbench/adoption/status') {
      const next = sequence[Math.min(reads++, sequence.length - 1)]!;
      if (next === 'fail') return new Response('{}', { status: 500 });
      return new Response(JSON.stringify({ status: next }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url === '/api/app-config' && init?.method === 'PUT') {
      writes.push(JSON.parse(String(init.body)));
      return new Response('{"config":{}}', { status: 200 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }));
  return { writes };
}
const renderRow = () => render(<I18nProvider initial="en"><LabsAdoptionRow /></I18nProvider>);
const toggle = () => screen.getByTestId('labs-adoption-switch') as HTMLButtonElement;

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('Settings → Labs adoption executor row', () => {
  it('shows the switch off and the named gates while the executor is closed', async () => {
    stubFetch([adoptionStatus()]);
    renderRow();
    await waitFor(() => expect(toggle().getAttribute('aria-disabled')).toBe('false'));
    expect(toggle().getAttribute('aria-checked')).toBe('false');
    expect(screen.getByTestId('labs-adoption-status').textContent).toContain('adoption-opt-in-labs-off');
  });

  it('writes only placementAdoptionExecutor and shows the provisioned state from the daemon', async () => {
    const { writes } = stubFetch([adoptionStatus(), adoptionStatus({ executor: 'provisioned', optIn: { env: true, labs: true }, gates: ['hero-proof-missing'] })]);
    renderRow();
    await waitFor(() => expect(toggle().getAttribute('aria-disabled')).toBe('false'));
    fireEvent.click(toggle());
    await waitFor(() => expect(screen.getByTestId('labs-adoption-status').getAttribute('data-executor')).toBe('provisioned'));
    expect(writes).toEqual([{ placementAdoptionExecutor: true }]);
    expect(toggle().getAttribute('aria-checked')).toBe('true');
  });

  it('[BLOCK 2] turning the switch back on after it closed the executor says it waits for a restart', async () => {
    const latched = adoptionStatus({ optIn: { env: true, labs: false }, gates: ['adoption-executor-unprovisioned', 'adoption-opt-in-labs-off'] });
    const { writes } = stubFetch([latched, latched]);
    renderRow();
    await waitFor(() => expect(toggle().getAttribute('aria-disabled')).toBe('false'));
    fireEvent.click(toggle());
    await waitFor(() => expect(screen.getByTestId('labs-adoption-restart')).toBeTruthy());
    expect(writes).toEqual([{ placementAdoptionExecutor: true }]);
    expect(toggle().getAttribute('aria-checked')).toBe('false');
  });

  it('says when the daemon process has no opt-in, so the switch alone cannot open the executor', async () => {
    stubFetch([adoptionStatus({ optIn: { env: false, labs: false }, gates: ['adoption-executor-unprovisioned', 'adoption-opt-in-env-off'] })]);
    renderRow();
    await waitFor(() => expect(screen.getByTestId('labs-adoption-env-off')).toBeTruthy());
  });

  it('an unreadable status locks the switch; a click retries the read', async () => {
    stubFetch(['fail', adoptionStatus()]);
    renderRow();
    await waitFor(() => expect(toggle().getAttribute('aria-disabled')).toBe('true'));
    fireEvent.click(toggle());
    await waitFor(() => expect(toggle().getAttribute('aria-disabled')).toBe('false'));
  });
});
