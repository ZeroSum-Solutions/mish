// @vitest-environment jsdom
// B4-2 / AC-R06.2 web surface: the review panel's per-run egress allow-list.
// Empty by default; each host is validated by the same contract rules the
// daemon and `od workbench review run --allow-host` apply, and the list goes
// to the same endpoints in the same field.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../../src/i18n';
import { WorkbenchReviewPanel } from '../../../src/components/workbench/WorkbenchReviewPanel';
import { getProjectRubric } from '../../../src/providers/workbench';

vi.mock('../../../src/providers/workbench', async (original) => ({
  ...await original<typeof import('../../../src/providers/workbench')>(),
  getProjectRubric: vi.fn(),
}));
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

function stub() {
  const calls: { url: string; body: unknown }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url === '/api/workbench/projects/p/review/bundles') return Response.json({ projectId: 'p', bundles: [] });
    if (url.endsWith('/review/mechanical')) return new Response(JSON.stringify({ error: { message: 'stop here' } }), { status: 409 });
    if (url === '/api/workbench/reviews') return new Response(JSON.stringify({ error: { message: 'stop here' } }), { status: 409 });
    return new Response(JSON.stringify({ projectId: 'p', runs: [] }));
  }));
  return calls;
}

const add = (host: string) => {
  fireEvent.change(screen.getByLabelText('Allowed hostname'), { target: { value: host } });
  fireEvent.click(screen.getByText('Allow host'));
};

describe('WorkbenchReviewPanel egress allow-list', () => {
  it('is empty by default and sends no allow-list', async () => {
    vi.mocked(getProjectRubric).mockResolvedValue({ projectId: 'p', revision: 0, rubric: null, linkage: null } as never);
    const calls = stub();
    render(<I18nProvider><WorkbenchReviewPanel projectId="p" /></I18nProvider>);
    expect(screen.getByText(/No external hosts are allowed/u)).toBeTruthy();
    fireEvent.click(screen.getByText('Run mechanical checks only'));
    await waitFor(() => expect(calls.some(call => call.url.endsWith('/review/mechanical'))).toBe(true));
    expect(calls.find(call => call.url.endsWith('/review/mechanical'))!.body).toEqual({ entry: 'index.html' });
  });

  it('refuses wildcards, IP addresses, local names and duplicates with a reason, and sends the valid hosts on both run kinds', async () => {
    vi.mocked(getProjectRubric).mockResolvedValue({ projectId: 'p', revision: 2, rubric: null, linkage: null } as never);
    const calls = stub();
    render(<I18nProvider><WorkbenchReviewPanel projectId="p" /></I18nProvider>);
    for (const [host, message] of [['*.example-cdn.com', /Wildcards are not allowed/u], ['10.0.0.1', /IP addresses are not allowed/u], ['localhost', /Local, private and special-use names/u], ['https://cdn.example-cdn.com', /without a scheme/u]] as const) {
      add(host);
      expect(screen.getByRole('alert').textContent, host).toMatch(message);
    }
    add('Fonts.Example-CDN.com');
    add('fonts.example-cdn.com');
    expect(screen.getByRole('alert').textContent).toMatch(/already listed/u);
    add('cdn.example-cdn.com:8443');
    expect(screen.getAllByTestId('review-egress-host').map(item => item.textContent)).toEqual([expect.stringContaining('fonts.example-cdn.com'), expect.stringContaining('cdn.example-cdn.com:8443')]);

    fireEvent.click(screen.getByText('Run mechanical checks only'));
    await waitFor(() => expect(calls.some(call => call.url.endsWith('/review/mechanical'))).toBe(true));
    expect(calls.find(call => call.url.endsWith('/review/mechanical'))!.body).toEqual({ entry: 'index.html', egress: { allowHosts: ['fonts.example-cdn.com', 'cdn.example-cdn.com:8443'] } });

    fireEvent.click(screen.getAllByText('Remove')[1]!);
    fireEvent.click(screen.getByText('Start review'));
    await waitFor(() => expect(calls.some(call => call.url === '/api/workbench/reviews')).toBe(true));
    expect((calls.find(call => call.url === '/api/workbench/reviews')!.body as { egress?: unknown }).egress).toEqual({ allowHosts: ['fonts.example-cdn.com'] });
  });
});
