// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ComponentLedgerSection } from '../../src/components/ComponentLedgerSection';
import { I18nProvider } from '../../src/i18n';

const entry = (id: string, pack = false) => ({
  id: `genui:${id}`, sourceId: 'genui', itemId: id, title: id,
  source: pack ? 'pack' : 'public-core',
  rights: { license: pack ? 'licensed (pack-declared)' : 'MIT', decision: 'test', implementationOrigin: pack ? 'licensed' : 'clean-room', evidence: 'test' },
  licensed: pack, built: true, tracked: true, installed: pack ? true : null, packId: pack ? 'fixture-pack' : null,
  sourceVersion: { revision: 'test', digest: 'a'.repeat(64), pinned: true },
  disposition: 'repair-pending', verified: false, evidenceDate: null, evidence: [], errors: [],
});
function stub() {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ schema: 'component-ledger-report/1', frozenAt: '2026-10-09T00:00:00.000Z', components: {
    'genui:core': entry('core'), 'genui:private': entry('private', true),
    'genui:conflict': { ...entry('conflict'), errors: [{ code: 'duplicate-id', packId: 'fixture-pack' }] },
  } }), { status: 200 })));
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });
describe('read-only component ledger', () => {
  it('reads the report and filters by source, licence and status without writes', async () => {
    stub(); render(<ComponentLedgerSection />);
    expect(await screen.findByText('genui:private')).toBeInTheDocument();
    expect(screen.getAllByText('licensed (pack-declared)').length).toBeGreaterThan(0);
    fireEvent.change(screen.getByLabelText('Source'), { target: { value: 'pack' } });
    expect(screen.queryByText('genui:core')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Source'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Licence'), { target: { value: 'MIT' } });
    expect(screen.queryByText('genui:private')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'error' } });
    expect(screen.getByText('genui:conflict')).toBeInTheDocument();
    expect(screen.queryByText('genui:core')).not.toBeInTheDocument();
    expect(within(screen.getByRole('table')).getByText(/Duplicate component ID/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'verified' } });
    expect(screen.getByText('No matching components.')).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith('/api/components/ledger', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    for (const [, options] of vi.mocked(fetch).mock.calls) expect(options?.method ?? 'GET').toBe('GET');
  });
  it("renders in English and the qualified licensed claim", async () => {
    localStorage.setItem('open-design:locale', "en"); localStorage.setItem('open-design:locale-source', 'manual');
    stub(); render(<I18nProvider><ComponentLedgerSection /></I18nProvider>);
    expect(await screen.findByText('genui:private')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: "Component ledger" })).toBeInTheDocument();
    expect(screen.getAllByText("licensed (pack-declared)").length).toBeGreaterThan(0);
  });
  it('shows a localized load failure and allows retry', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('{}', { status: 503 })));
    render(<ComponentLedgerSection />);
    expect(await screen.findByRole('alert')).toHaveTextContent('The component ledger could not be read.');
    stub(); fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('genui:private')).toBeInTheDocument();
  });
});
