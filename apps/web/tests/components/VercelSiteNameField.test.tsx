// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { VercelSiteNameField } from '../../src/components/VercelSiteNameField';
import { useState } from 'react';

function Field() {
  const [name, setName] = useState('bobs-bakery');
  return <VercelSiteNameField value={name} onChange={setName} enabled projectId="bakery" />;
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe('advisory Vercel availability hint', () => {
  it('debounces checks and lets a person accept the taken-name suggestion', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ name: 'bobs-bakery', valid: true, available: false, advisory: true, reason: 'taken', suggestion: 'bobs-bakery-2' })));
    vi.stubGlobal('fetch', fetcher); render(<Field />);
    expect(fetcher).not.toHaveBeenCalled();
    await screen.findByRole('button', { name: 'Use bobs-bakery-2' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe('/api/deploy/vercel/name-check?name=bobs-bakery&projectId=bakery');
    fireEvent.click(screen.getByRole('button', { name: 'Use bobs-bakery-2' }));
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('bobs-bakery-2');
  });
  it('ignores a late old-name response after the input changes', async () => {
    let answer!: (value: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { answer = resolve; })));
    render(<Field />);
    await waitFor(() => expect(answer).toBeDefined());
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'new-bakery' } });
    answer(new Response(JSON.stringify({ name: 'bobs-bakery', valid: true, available: false, advisory: true, suggestion: 'bobs-bakery-2' })));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Use bobs-bakery-2' })).toBeNull());
  });
  it('labels a free name as unreserved and keeps transport errors advisory', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ name: 'bobs-bakery', valid: true, available: true, advisory: true }))));
    const view = render(<Field />);
    await screen.findByText(/This does not reserve the address/);
    expect(screen.getByText('Publishing a different entry file replaces the site at this address.')).toBeTruthy();
    view.unmount(); vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
    render(<Field />); await screen.findByText(/Could not check the name/);
  });
});
