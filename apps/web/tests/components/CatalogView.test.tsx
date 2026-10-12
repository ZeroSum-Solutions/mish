// @vitest-environment jsdom

// GenUI catalog view (catalog-design.md §E): cards from GET /api/genui/catalog, a planned card
// without a demo, a ported card whose sandboxed srcdoc carries the component and the CSP, the
// filters, and no fetch while the view is inactive.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GenuiCatalogEntry, GenuiCatalogResponse } from '@mish/contracts';

import { CatalogView } from '../../src/components/CatalogView';

function entry(id: string, status: 'planned' | 'ported', category: GenuiCatalogEntry['category']): GenuiCatalogEntry {
  return {
    id,
    name: id.replace(/-/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase()),
    category,
    source: { name: 'react-bits', component: id, license: 'MIT + Commons Clause', category: 'Animations', description: '', dependencies: '' },
    sourceUrl: `https://example.test/${id}`,
    licenceDecision: 'clean-room',
    verdict: 'keep',
    rationale: 'keep',
    tier: 1,
    tierNote: 'Tier 1',
    portDifficulty: 'Easy',
    status,
    ...(status === 'ported' ? { demo: `components/${id}/demo.html` } : {}),
  };
}

// glare-hover and shiny-text are real ported components, so demoDocument() has their assets.
const CATALOG: GenuiCatalogResponse = {
  catalog: {
    schema: 'genui-catalog/1',
    components: [entry('glare-hover', 'ported', 'hover'), entry('shiny-text', 'ported', 'text'), entry('fluid-glass', 'planned', 'surface')],
  },
};

// The Blocks and Components views (CatalogView.cult.test.tsx) load GET /api/cult/catalog on the
// same activation; these Effects cases answer it with an empty inventory.
const EMPTY_CULT = { catalog: { schema: 'cult-catalog/1', snapshot: { id: 's', expectedItems: 0, fetchedItems: 0, pendingItems: 0 }, items: [] } };

function stubFetch(ok = true) {
  const calls: string[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url === '/api/genui/catalog') {
      return new Response(ok ? JSON.stringify(CATALOG) : '{}', { status: ok ? 200 : 500, headers: { 'content-type': 'application/json' } });
    }
    if (url === '/api/cult/catalog') return new Response(JSON.stringify(EMPTY_CULT), { status: 200 });
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls };
}

function stubFetchWithBody(body: unknown) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/api/genui/catalog') {
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url === '/api/cult/catalog') return new Response(JSON.stringify(EMPTY_CULT), { status: 200 });
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
}

describe('CatalogView', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it('fetches nothing while inactive', async () => {
    const { calls } = stubFetch();
    render(<CatalogView isActive={false} />);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toEqual([]);
  });

  it('renders a card per entry, with a sandboxed demo only for ported ones', async () => {
    const { calls } = stubFetch();
    render(<CatalogView isActive />);

    await screen.findByTestId('catalog-card-glare-hover');
    expect([...calls].sort()).toEqual(['/api/cult/catalog', '/api/genui/catalog']);
    expect(screen.getByTestId('catalog-card-fluid-glass').querySelector('iframe')).toBeNull();

    const frame = (await screen.findByTestId('catalog-demo-glare-hover')) as HTMLIFrameElement;
    expect(screen.getByTestId('catalog-demo-loading-glare-hover')).toBeTruthy();
    fireEvent.load(frame);
    expect(screen.queryByTestId('catalog-demo-loading-glare-hover')).toBeNull();
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    const srcdoc = frame.getAttribute('srcdoc') ?? '';
    expect(srcdoc).toContain('data-genui="glare-hover"');
    expect(srcdoc).toContain("Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'\"");
    expect(screen.getByTestId('catalog-count').textContent).toBe('3 of 3 components shown, 2 ported');
  });

  it('filters by status and by category', async () => {
    stubFetch();
    render(<CatalogView isActive />);
    await screen.findByTestId('catalog-card-glare-hover');

    fireEvent.change(screen.getByTestId('catalog-filter-status'), { target: { value: 'planned' } });
    expect(screen.queryByTestId('catalog-card-glare-hover')).toBeNull();
    expect(screen.getByTestId('catalog-card-fluid-glass')).toBeTruthy();

    fireEvent.change(screen.getByTestId('catalog-filter-status'), { target: { value: 'all' } });
    fireEvent.change(screen.getByTestId('catalog-filter-category'), { target: { value: 'text' } });
    expect(screen.getByTestId('catalog-card-shiny-text')).toBeTruthy();
    expect(screen.queryByTestId('catalog-card-glare-hover')).toBeNull();
  });

  it('re-renders the demo in reduced motion when the toggle is on', async () => {
    stubFetch();
    render(<CatalogView isActive />);
    await screen.findByTestId('catalog-demo-glare-hover');
    fireEvent.click(screen.getByTestId('catalog-reduced-motion'));
    await waitFor(() => {
      expect(screen.getByTestId('catalog-demo-glare-hover').getAttribute('srcdoc')).toContain('genui-reduced-motion');
    });
  });

  it('opens a full viewport preview and returns focus after closing', async () => {
    stubFetch();
    render(<CatalogView isActive />);
    const opener = await screen.findByRole('button', { name: 'Preview Glare Hover' });
    fireEvent.load(screen.getByTestId('catalog-demo-glare-hover'));
    expect(screen.getByTestId('catalog-card-glare-hover').querySelector('h2')?.textContent).toBe('Glare Hover');
    expect(screen.getByTestId('catalog-demo-glare-hover').getAttribute('tabindex')).toBe('-1');
    opener.focus();
    fireEvent.click(opener);
    const dialog = await screen.findByRole('dialog', { name: 'Glare Hover' });
    expect(dialog.textContent).toContain('react-bits glare-hover');
    expect(dialog.textContent).toContain('MIT + Commons Clause');
    const frame = screen.getByTestId('effect-preview-frame');
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.getAttribute('src')).toBe('/api/genui/catalog/glare-hover/preview?reducedMotion=false');
    expect(frame.getAttribute('width')).toBe('1280');
    fireEvent.click(screen.getByRole('button', { name: 'Phone 390' }));
    expect(frame.getAttribute('width')).toBe('390');
    fireEvent.click(screen.getByTestId('effect-preview-reduced-motion'));
    // The reduced-motion document is new content, so it gets a new frame at the same width.
    const reloaded = screen.getByTestId('effect-preview-frame');
    expect(reloaded).not.toBe(frame);
    expect(reloaded.getAttribute('src')).toContain('reducedMotion=true');
    expect(reloaded.getAttribute('width')).toBe('390');
    expect(dialog.querySelector('aside')?.textContent).toContain('Interact with the full demo');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(opener);
  });

  it('adapts the visible effect box only from its current opaque frame and keeps width changes interactive', async () => {
    stubFetch();
    render(<CatalogView isActive />);
    fireEvent.click(await screen.findByRole('button', { name: 'Preview Glare Hover' }));
    const frame = screen.getByTestId('effect-preview-frame') as HTMLIFrameElement;
    const box = () => screen.getByTestId('effect-preview-frame').parentElement!;
    const layoutHeight = frame.style.height;
    const size = (origin: string, source: Window | null, width: number, height: number) =>
      fireEvent(window, new MessageEvent('message', { origin, source, data: { type: 'mishh-effect-preview-size', width, height } }));
    size('https://wrong.example', frame.contentWindow, 1280, 280);
    size('null', frame.contentWindow, 1280, 1.5);
    expect(box().style.height).toBe(layoutHeight);
    size('null', frame.contentWindow, 1280, 280);
    expect(box().style.height).toBe('280px');
    expect(frame.style.height).toBe(layoutHeight);
    fireEvent.click(screen.getByRole('button', { name: 'Phone 390' }));
    expect(screen.getByTestId('effect-preview-frame')).toBe(frame);
    expect(frame.style.width).toBe('390px');
    // A height measured at 1280 does not describe the 390 layout; the frame re-reports.
    size('null', frame.contentWindow, 1280, 300);
    expect(box().style.height).toBe('280px');
    size('null', frame.contentWindow, 390, 340);
    expect(box().style.height).toBe('340px');
    const oldWindow = frame.contentWindow;
    fireEvent.click(screen.getByTestId('effect-preview-reduced-motion'));
    expect(screen.getByTestId('effect-preview-frame')).not.toBe(frame);
    expect(box().style.height).toBe(layoutHeight);
    size('null', oldWindow, 390, 220);
    expect(box().style.height).toBe(layoutHeight);
  });

  it('shows an error with a retry when the route fails', async () => {
    stubFetch(false);
    render(<CatalogView isActive />);
    expect(await screen.findByRole('alert')).toBeTruthy();
  });

  it('accepts keyboard boundary messages only from its own preview frame', async () => {
    stubFetch();
    render(<CatalogView isActive />);
    fireEvent.click(await screen.findByRole('button', { name: 'Preview Glare Hover' }));
    const frame = screen.getByTestId('effect-preview-frame') as HTMLIFrameElement;
    const motion = screen.getByTestId('effect-preview-reduced-motion');
    const close = screen.getByRole('button', { name: 'Close preview' });
    close.focus();
    fireEvent(window, new MessageEvent('message', { source: window, data: { type: 'mishh-effect-preview-tab', backward: true } }));
    expect(document.activeElement).toBe(close);
    fireEvent(window, new MessageEvent('message', { origin: 'null', source: frame.contentWindow, data: { type: 'mishh-effect-preview-tab', backward: true } }));
    expect(document.activeElement).toBe(motion);
    fireEvent(window, new MessageEvent('message', { origin: 'null', source: frame.contentWindow, data: { type: 'mishh-effect-preview-tab', backward: false } }));
    expect(document.activeElement).toBe(close);
  });

  it.each([
    ['components is not an array', { catalog: { components: 'x' } }],
    ['an empty object entirely', {}],
  ])('shows the error state (not empty, no cards) for a malformed 200 body: %s', async (_label, body) => {
    stubFetchWithBody(body);
    render(<CatalogView isActive />);

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByTestId('catalog-count')).toBeNull();
    expect(screen.queryByText('No component matches these filters.')).toBeNull();
    expect(document.querySelectorAll('[data-testid^="catalog-card-"]').length).toBe(0);
  });
});
