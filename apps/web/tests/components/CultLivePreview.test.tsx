// @vitest-environment jsdom

// Live preview modal on Blocks and Components cards: an accessible dialog (labelled, focus trap,
// Esc returns focus to the Preview button), arrow-key navigation through the view, the width and
// theme toggles, the sandboxed frame loaded only once the modal is open, the skeleton, and the
// "Can't preview live" reason panel with the thumbnail.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CultCatalogItem, CultCatalogListResponse, CultPreviewInfo } from '@mish/contracts';

import { CatalogView } from '../../src/components/CatalogView';
import { CultLivePreviewModal, FRAME_SETTLE_TIMEOUT_MS, prefetchCultPreview } from '../../src/components/CultLivePreview';
import { I18nProvider } from '../../src/i18n';

function item(id: string, overrides: Partial<CultCatalogItem> = {}): CultCatalogItem {
  return {
    id,
    slug: id.replace(/^cult:/, ''),
    displayTitle: id,
    summary: '',
    assetKind: 'section',
    sourceCategory: 'marketing',
    tags: [],
    sectionKind: 'hero',
    spineAffinities: [],
    state: 'insertable',
    dependencies: { motion: false, canvas: false, webgl: false, server: false, packages: 0 },
    bytes: 1,
    preview: { kind: 'none' },
    provenance: { snapshotId: 'cult-ui-pro@abc' },
    ...overrides,
  };
}

const HERO = item('cult:hero-glow', { displayTitle: 'Hero (series G)', summary: 'A luminous hero section.', tags: ['hero', 'glow'], spineAffinities: ['TL'] });
const BADGE = item('cult:glow-badge', { displayTitle: 'Glow Badge', assetKind: 'primitive', state: 'needs-adaptation', sectionKind: 'unclassified' });
const CHAT = item('cult:chat-app', { displayTitle: 'Chat App', assetKind: 'app', state: 'app-only', sectionKind: 'unclassified', preview: { kind: 'image', source: 'source-render' } });
const ITEMS = [HERO, BADGE, CHAT];

const INFO: Record<string, CultPreviewInfo> = {
  [HERO.id]: { live: true, mode: 'converted', supportsDark: true, mockNote: null },
  [BADGE.id]: { live: true, mode: 'harness', supportsDark: false, mockNote: null },
  [CHAT.id]: { live: true, mode: 'harness', supportsDark: true, mockNote: 'it needs server keys (2 key-bound server SDKs) and a running API' },
};

function stubFetch(catalog?: CultCatalogListResponse) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const match = /^\/api\/cult\/preview\/([^/?]+)$/.exec(url);
    if (match) return new Response(JSON.stringify({ preview: INFO[decodeURIComponent(match[1]!)] }), { status: 200 });
    if (url === '/api/cult/catalog' && catalog) return new Response(JSON.stringify(catalog), { status: 200 });
    if (url === '/api/genui/catalog') return new Response(JSON.stringify({ catalog: { schema: 'genui-catalog/1', components: [] } }), { status: 200 });
    throw new Error(`unexpected fetch ${url}`);
  }));
  return { calls };
}

/** An opener button plus the modal, the way the Catalog panel wires them. */
function Harness({ start = HERO.id, items = ITEMS }: { start?: string; items?: CultCatalogItem[] }) {
  const [active, setActive] = useState<string | null>(null);
  return (
    <I18nProvider>
      <button type="button" data-testid="opener" onClick={() => setActive(start)}>open</button>
      {active !== null ? (
        <CultLivePreviewModal items={items} activeId={active} onNavigate={setActive} onClose={() => setActive(null)} />
      ) : null}
    </I18nProvider>
  );
}

async function openModal(start?: string, items?: CultCatalogItem[]) {
  render(<Harness start={start} items={items} />);
  const opener = screen.getByTestId('opener');
  opener.focus();
  fireEvent.click(opener);
  return { opener, dialog: await screen.findByRole('dialog') };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  cleanup();
});

describe('the live preview modal', () => {
  it('is a labelled modal dialog with the brand-free title and the state badge', async () => {
    stubFetch();
    const { dialog } = await openModal();
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const title = document.getElementById(dialog.getAttribute('aria-labelledby')!);
    expect(title?.textContent).toBe('Hero (series G)');
    expect(screen.getByTestId('cult-live-preview-state').textContent).toBe('Insertable');
    expect(document.getElementById(dialog.getAttribute('aria-describedby')!)?.textContent).toMatch(/Esc closes/);
    const details = screen.getByTestId('cult-live-preview-details');
    expect(details.textContent).toContain('A luminous hero section.');
    expect(details.textContent).toContain('marketing');
    expect(details.textContent).toContain('#hero #glow');
    expect(details.textContent).toContain('TL');
    // The expanded view carries the copy actions.
    expect(within(dialog).getByTestId(`catalog-cult-copy-install-${HERO.id}`)).toBeTruthy();
  });

  it('loads the frame only after the modal opens, sandboxed, behind a skeleton until it loads', async () => {
    const { calls } = stubFetch();
    render(<Harness />);
    expect(calls).toEqual([]);
    expect(document.querySelector('iframe')).toBeNull();
    fireEvent.click(screen.getByTestId('opener'));
    const frame = await screen.findByTestId('cult-live-preview-frame');
    expect(calls).toEqual([`/api/cult/preview/${encodeURIComponent(HERO.id)}`]);
    expect(frame.getAttribute('src')).toBe(`/api/cult/preview/${encodeURIComponent(HERO.id)}/frame?theme=light`);
    // A converted page runs no script at all.
    expect(frame.getAttribute('sandbox')).toBe('');
    expect(frame.getAttribute('title')).toBe('Live preview of Hero (series G)');
    expect(screen.getByTestId('cult-live-preview-skeleton')).toBeTruthy();
    fireEvent.load(frame);
    expect(screen.queryByTestId('cult-live-preview-skeleton')).toBeNull();
  });

  it('keeps Tab inside the modal, both ways', async () => {
    stubFetch();
    const { dialog } = await openModal();
    await screen.findByTestId('cult-live-preview-frame');
    expect(document.activeElement).toBe(screen.getByTestId('cult-live-preview-close'));
    const focusable = [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]), iframe')];
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it('closes on Esc and returns focus to the button that opened it', async () => {
    stubFetch();
    const { opener } = await openModal();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(opener);
  });

  it('moves to the next and previous item with the arrow keys and the buttons, wrapping around', async () => {
    const { calls } = stubFetch();
    const { dialog } = await openModal();
    const title = () => document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent;
    fireEvent.keyDown(screen.getByTestId('cult-live-preview-close'), { key: 'ArrowRight' });
    await waitFor(() => expect(title()).toBe('Glow Badge'));
    expect(screen.getByText('2 of 3')).toBeTruthy();
    fireEvent.click(screen.getByTestId('cult-live-preview-next'));
    await waitFor(() => expect(title()).toBe('Chat App'));
    fireEvent.keyDown(screen.getByTestId('cult-live-preview-close'), { key: 'ArrowRight' });
    await waitFor(() => expect(title()).toBe('Hero (series G)'));
    fireEvent.keyDown(screen.getByTestId('cult-live-preview-close'), { key: 'ArrowLeft' });
    await waitFor(() => expect(title()).toBe('Chat App'));
    expect(calls).toContain(`/api/cult/preview/${encodeURIComponent(BADGE.id)}`);
  });

  it('draws the frame at 390, 768 or 1280 pixels', async () => {
    stubFetch();
    await openModal();
    const frame = await screen.findByTestId('cult-live-preview-frame');
    expect(screen.getByTestId('cult-live-preview-width-fit').getAttribute('aria-pressed')).toBe('true');
    expect(frame.getAttribute('width')).toBe('1280');
    fireEvent.click(screen.getByTestId('cult-live-preview-width-390'));
    expect(screen.getByTestId('cult-live-preview-width-390').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('cult-live-preview-frame').getAttribute('width')).toBe('390');
    fireEvent.click(screen.getByTestId('cult-live-preview-width-768'));
    expect(screen.getByTestId('cult-live-preview-frame').getAttribute('width')).toBe('768');
  });

  it('offers light and dark only when the item supports a dark theme', async () => {
    stubFetch();
    await openModal();
    await screen.findByTestId('cult-live-preview-frame');
    fireEvent.click(screen.getByTestId('cult-live-preview-theme-dark'));
    expect(screen.getByTestId('cult-live-preview-frame').getAttribute('src')).toBe(`/api/cult/preview/${encodeURIComponent(HERO.id)}/frame?theme=dark`);
    fireEvent.click(screen.getByTestId('cult-live-preview-next'));
    await waitFor(() => expect(screen.getByTestId('cult-live-preview-frame').getAttribute('data-mode')).toBe('harness'));
    expect(screen.queryByTestId('cult-live-preview-theme-dark')).toBeNull();
  });

  it('lets a harness demo run script only in an opaque origin, and settles on its ready message', async () => {
    stubFetch();
    await openModal(BADGE.id);
    const frame = await screen.findByTestId('cult-live-preview-frame') as HTMLIFrameElement;
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    fireEvent.load(frame);
    // A message from any other window is ignored.
    act(() => { window.dispatchEvent(new MessageEvent('message', { origin: 'null', data: { source: 'cult-live-preview', type: 'error', reason: 'spoof' } })); });
    expect(screen.getByTestId('cult-live-preview-skeleton')).toBeTruthy();
    act(() => { window.dispatchEvent(new MessageEvent('message', { origin: 'null', data: { source: 'cult-live-preview', type: 'ready' }, source: frame.contentWindow })); });
    expect(screen.queryByTestId('cult-live-preview-skeleton')).toBeNull();
  });

  it('rejects a same-window message from a non-opaque origin', async () => {
    stubFetch();
    await openModal(BADGE.id);
    const frame = await screen.findByTestId('cult-live-preview-frame') as HTMLIFrameElement;
    act(() => { window.dispatchEvent(new MessageEvent('message', { origin: 'http://localhost', data: { source: 'cult-live-preview', type: 'ready' }, source: frame.contentWindow })); });
    expect(screen.getByTestId('cult-live-preview-skeleton')).toBeTruthy();
  });

  it('shows the current frame its reported content height without resizing the frame viewport', async () => {
    stubFetch();
    await openModal(BADGE.id);
    const oldFrame = await screen.findByTestId('cult-live-preview-frame') as HTMLIFrameElement;
    const oldWindow = oldFrame.contentWindow;
    const box = () => screen.getByTestId('cult-live-preview-frame').parentElement!;
    const layoutHeight = oldFrame.style.height;
    const size = (source: Window | null, width: number, height: number) => act(() => {
      window.dispatchEvent(new MessageEvent('message', { origin: 'null', source, data: { source: 'cult-live-preview', type: 'size', width, height } }));
    });
    size(oldWindow, 1280, 320);
    expect(box().style.height).toBe('320px');
    // Measurement never changes the frame's own viewport, so a vh-based document cannot loop.
    expect(oldFrame.style.height).toBe(layoutHeight);
    size(oldWindow, 390, 260); // measured at another width
    size(window, 1280, 250); // not the frame
    act(() => { window.dispatchEvent(new MessageEvent('message', { origin: 'https://evil.example', source: oldWindow, data: { source: 'cult-live-preview', type: 'size', width: 1280, height: 240 } })); });
    expect(box().style.height).toBe('320px');
    fireEvent.click(screen.getByTestId('cult-live-preview-next'));
    const nextFrame = await screen.findByTestId('cult-live-preview-frame') as HTMLIFrameElement;
    expect(nextFrame).not.toBe(oldFrame);
    expect(box().style.height).toBe(layoutHeight);
    size(oldWindow, 1280, 210);
    expect(box().style.height).toBe(layoutHeight);
    size(nextFrame.contentWindow, 1280, 300);
    expect(box().style.height).toBe('300px');
  });

  it('closes on Esc forwarded from inside a harness demo, and only from its own frame', async () => {
    stubFetch();
    const { opener } = await openModal(BADGE.id);
    const frame = await screen.findByTestId('cult-live-preview-frame') as HTMLIFrameElement;
    act(() => { window.dispatchEvent(new MessageEvent('message', { origin: 'null', data: { source: 'cult-live-preview', type: 'escape' } })); });
    expect(screen.getByRole('dialog')).toBeTruthy();
    act(() => { window.dispatchEvent(new MessageEvent('message', { origin: 'null', data: { source: 'cult-live-preview', type: 'escape' }, source: frame.contentWindow })); });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(opener);
  });

  it('clears the settle fallback timer when the frame goes away', async () => {
    stubFetch();
    const set = vi.spyOn(window, 'setTimeout');
    const clear = vi.spyOn(window, 'clearTimeout');
    await openModal(BADGE.id);
    const frame = await screen.findByTestId('cult-live-preview-frame');
    fireEvent.load(frame);
    const timer = set.mock.results.find((_r, i) => set.mock.calls[i]?.[1] === FRAME_SETTLE_TIMEOUT_MS)?.value;
    expect(timer).toBeDefined();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(clear).toHaveBeenCalledWith(timer);
    set.mockRestore();
    clear.mockRestore();
  });

  it('ends a stalled frame request even when the iframe never fires load', async () => {
    vi.useFakeTimers();
    stubFetch();
    render(<Harness start={BADGE.id} />);
    await act(async () => { fireEvent.click(screen.getByTestId('opener')); });
    expect(screen.getByTestId('cult-live-preview-frame')).toBeTruthy();
    await act(async () => { vi.advanceTimersByTime(FRAME_SETTLE_TIMEOUT_MS); });
    expect(screen.queryByTestId('cult-live-preview-skeleton')).toBeNull();
    expect(screen.getByTestId('cult-live-preview-frame')).toBeTruthy();
    expect(screen.getByTestId('cult-live-preview-timeout').textContent).toMatch(/did not finish loading/);
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('allows a slow authentic frame to recover after the opening deadline', async () => {
    vi.useFakeTimers();
    stubFetch();
    render(<Harness start={BADGE.id} />);
    await act(async () => { fireEvent.click(screen.getByTestId('opener')); });
    const frame = screen.getByTestId('cult-live-preview-frame') as HTMLIFrameElement;
    await act(async () => { vi.advanceTimersByTime(FRAME_SETTLE_TIMEOUT_MS); });
    expect(screen.getByTestId('cult-live-preview-timeout')).toBeTruthy();
    act(() => { window.dispatchEvent(new MessageEvent('message', { origin: 'null', data: { source: 'cult-live-preview', type: 'ready' }, source: frame.contentWindow })); });
    expect(screen.queryByTestId('cult-live-preview-timeout')).toBeNull();
    expect(screen.getByTestId('cult-live-preview-frame')).toBe(frame);
  });

  it('shows Retry immediately when the frame reports a native loading error', async () => {
    stubFetch();
    await openModal(BADGE.id);
    const frame = await screen.findByTestId('cult-live-preview-frame');
    fireEvent.error(frame);
    expect(screen.queryByTestId('cult-live-preview-frame')).toBeNull();
    expect(screen.getByTestId('cult-live-preview-unavailable')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('reports an error from its own frame even after that frame reported ready', async () => {
    stubFetch();
    await openModal(BADGE.id);
    const frame = await screen.findByTestId('cult-live-preview-frame') as HTMLIFrameElement;
    act(() => { window.dispatchEvent(new MessageEvent('message', { origin: 'null', data: { source: 'cult-live-preview', type: 'ready' }, source: frame.contentWindow })); });
    act(() => { window.dispatchEvent(new MessageEvent('message', { origin: 'null', data: { source: 'cult-live-preview', type: 'error', reason: 'late render failure' }, source: frame.contentWindow })); });
    expect(screen.getByTestId('cult-live-preview-unavailable').textContent).toContain('late render failure');
    expect(screen.queryByTestId('cult-live-preview-frame')).toBeNull();
  });

  it('shows the reason and the thumbnail when a harness demo throws', async () => {
    stubFetch();
    await openModal(BADGE.id);
    const frame = await screen.findByTestId('cult-live-preview-frame') as HTMLIFrameElement;
    act(() => { window.dispatchEvent(new MessageEvent('message', { origin: 'null', data: { source: 'cult-live-preview', type: 'error', reason: 'threw: boom' }, source: frame.contentWindow })); });
    const panel = await screen.findByTestId('cult-live-preview-unavailable');
    expect(panel.textContent).toContain("Can't preview live: threw: boom");
    expect(screen.queryByTestId('cult-live-preview-frame')).toBeNull();
    fireEvent.click(within(panel).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByTestId('cult-live-preview-frame')).toBeTruthy();
  });

  it('shows a live frame and a small demo-data note for a row the harness mocks, never a reason panel', async () => {
    stubFetch();
    await openModal(CHAT.id);
    const note = await screen.findByTestId('cult-live-preview-mock-note');
    expect(note.textContent).toContain('it needs server keys (2 key-bound server SDKs) and a running API');
    expect(await screen.findByTestId('cult-live-preview-frame')).toBeTruthy();
    expect(screen.queryByTestId('cult-live-preview-unavailable')).toBeNull();
  });
});

describe('the Preview action on catalog cards', () => {
  it('opens the modal from a Blocks card and walks the rows the view shows', async () => {
    stubFetch({ catalog: { schema: 'cult-catalog/1', snapshot: { id: 's', expectedItems: 3, fetchedItems: 3, pendingItems: 0 }, items: ITEMS } });
    render(<CatalogView isActive />);
    fireEvent.click(screen.getByTestId('catalog-segment-blocks'));
    const button = await screen.findByTestId(`catalog-cult-live-preview-${HERO.id}`);
    expect(button.tagName).toBe('BUTTON');
    expect(button.textContent).toContain('Hero (series G)');
    expect(button.querySelector('button')).toBeNull();
    expect(button.getAttribute('aria-label')).toBe('Preview Hero (series G) live');
    fireEvent.click(button);
    const dialog = await screen.findByRole('dialog');
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent).toBe('Hero (series G)');
    // Blocks holds one row here, so there is nowhere else to go.
    expect(screen.getByTestId('cult-live-preview-next').hasAttribute('disabled')).toBe(true);
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});


describe('preview metadata prefetch', () => {
  it('shares an in-flight prefetch with opening and reopening the modal without loading a frame early', async () => {
    let resolve!: (value: Response) => void;
    const request = vi.fn(() => new Promise<Response>((done) => { resolve = done; }));
    vi.stubGlobal('fetch', request);
    prefetchCultPreview(HERO.id);
    prefetchCultPreview(HERO.id);
    expect(document.querySelector('iframe')).toBeNull();
    await openModal();
    expect(request).toHaveBeenCalledTimes(1);
    await act(async () => { resolve(new Response(JSON.stringify({ preview: INFO[HERO.id] }))); });
    await screen.findByTestId('cult-live-preview-frame');
    fireEvent.click(screen.getByTestId('cult-live-preview-close'));
    fireEvent.click(screen.getByTestId('opener'));
    await screen.findByTestId('cult-live-preview-frame');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('limits speculative requests to four while they are pending', async () => {
    const resolvers: Array<(value: Response) => void> = [];
    const request = vi.fn(() => new Promise<Response>((done) => { resolvers.push(done); }));
    vi.stubGlobal('fetch', request);
    for (let index = 0; index < 10; index++) prefetchCultPreview(`cult:bounded-${index}`);
    expect(request).toHaveBeenCalledTimes(4);
    await act(async () => {
      for (const resolve of resolvers) resolve(new Response(JSON.stringify({ preview: INFO[HERO.id] })));
    });
  });

  it('evicts old metadata after 32 previews and expires cached entries after five minutes', async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ preview: INFO[HERO.id] })));
    vi.stubGlobal('fetch', request);
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
    try {
      for (let index = 0; index < 33; index++) {
        await act(async () => { prefetchCultPreview(`cult:cached-${index}`); });
      }
      expect(request).toHaveBeenCalledTimes(33);
      await act(async () => { prefetchCultPreview('cult:cached-0'); });
      expect(request).toHaveBeenCalledTimes(34);
      await act(async () => { prefetchCultPreview('cult:cached-32'); });
      expect(request).toHaveBeenCalledTimes(34);
      now.mockReturnValue(1000 + 5 * 60_000);
      await act(async () => { prefetchCultPreview('cult:cached-32'); });
      expect(request).toHaveBeenCalledTimes(35);
    } finally { now.mockRestore(); }
  });

  it('retries a failed metadata request from the expanded view', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ preview: INFO[HERO.id] })));
    vi.stubGlobal('fetch', request);
    await openModal();
    const unavailable = await screen.findByTestId('cult-live-preview-unavailable');
    fireEvent.click(within(unavailable).getByRole('button', { name: 'Retry' }));
    await screen.findByTestId('cult-live-preview-frame');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('prefetches from the card on hover and focus, without mounting the live demo', async () => {
    const { calls } = stubFetch({ catalog: { schema: 'cult-catalog/1', snapshot: { id: 's', expectedItems: 3, fetchedItems: 3, pendingItems: 0 }, items: ITEMS } });
    render(<CatalogView isActive />);
    fireEvent.click(screen.getByTestId('catalog-segment-blocks'));
    const card = await screen.findByTestId(`catalog-cult-live-preview-${HERO.id}`);
    fireEvent.mouseEnter(card);
    fireEvent.focus(card);
    await waitFor(() => expect(calls.filter((url) => url === `/api/cult/preview/${encodeURIComponent(HERO.id)}`)).toHaveLength(1));
    expect(document.querySelector('iframe')).toBeNull();
  });
});


describe('attached examples and page sections', () => {
  const example = item('cult:hero-example', { displayTitle: 'Hero Example', assetKind: 'primitive' });
  const section = item('cult:hero-section', { displayTitle: 'Page Hero Section' });
  const parent = { ...HERO, relatedItems: [
    { id: example.id, title: example.displayTitle, relationship: 'example' as const },
    { id: section.id, title: section.displayTitle, relationship: 'section' as const },
  ] };

  function relatedFetch(failFirst = false) {
    let failed = false;
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/cult/catalog/')) {
        if (failFirst && !failed) { failed = true; return new Response('{}', { status: 503 }); }
        const found = [example, section].find((item) => url.endsWith(encodeURIComponent(item.id)));
        return new Response(JSON.stringify({ item: found }));
      }
      return new Response(JSON.stringify({ preview: { live: true, mode: 'converted', supportsDark: false, mockNote: null } }));
    });
    vi.stubGlobal('fetch', request);
    return request;
  }

  it('opens hidden examples and sections by exact ID from one labeled parts selector that keeps focus', async () => {
    const request = relatedFetch();
    const { opener } = await openModal(HERO.id, [parent, BADGE]);
    const parts = screen.getByRole('group', { name: 'Parts' });
    expect(within(parts).getAllByRole('button').map((button) => button.textContent)).toEqual([
      'Whole Hero (series G)', 'Example Hero Example', 'Page section Page Hero Section',
    ]);
    expect(within(parts).getByRole('button', { name: 'Whole Hero (series G)' }).getAttribute('aria-pressed')).toBe('true');
    for (const child of [example, section]) {
      const part = screen.getByTestId(`cult-live-preview-part-${child.id}`);
      part.focus();
      fireEvent.click(part);
      await waitFor(() => expect(screen.getByTestId('cult-live-preview-frame').getAttribute('title')).toBe(`Live preview of ${child.displayTitle}`));
      expect(request.mock.calls.map(([url]) => String(url))).toContain(`/api/cult/catalog/${encodeURIComponent(child.id)}`);
      // Copy actions and the selected-part label bind the selected child, not the parent.
      expect(screen.getByTestId(`catalog-cult-copy-cli-${child.id}`)).toBeTruthy();
      expect(screen.queryByTestId(`catalog-cult-copy-cli-${HERO.id}`)).toBeNull();
      expect(screen.getByTestId('cult-live-preview-selected-part').textContent).toContain(child.displayTitle);
      expect(part.getAttribute('aria-pressed')).toBe('true');
      expect(document.activeElement).toBe(part);
      fireEvent.click(screen.getByTestId(`cult-live-preview-part-${HERO.id}`));
      await screen.findByTestId(`catalog-cult-copy-cli-${HERO.id}`);
    }
    expect(screen.getByRole('group', { name: 'Parts' })).toBe(parts);
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(opener);
  });

  it('keeps the toolbar, parts selector and device width mounted while selected IDs change, with a new frame per part', async () => {
    relatedFetch();
    await openModal(HERO.id, [parent]);
    const parts = screen.getByRole('group', { name: 'Parts' });
    const widths = screen.getByRole('group', { name: 'Width' });
    fireEvent.click(screen.getByTestId('cult-live-preview-width-390'));
    const parentFrame = await screen.findByTestId('cult-live-preview-frame');
    fireEvent.click(within(parts).getByRole('button', { name: /Hero Example/ }));
    expect(screen.getByRole('group', { name: 'Width' })).toBe(widths);
    await screen.findByTestId(`catalog-cult-copy-cli-${example.id}`);
    const exampleFrame = screen.getByTestId('cult-live-preview-frame');
    expect(exampleFrame).not.toBe(parentFrame);
    expect(exampleFrame.getAttribute('width')).toBe('390');
    expect(screen.getByTestId('cult-live-preview-width-390').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('group', { name: 'Parts' })).toBe(parts);
    expect(screen.getByRole('group', { name: 'Width' })).toBe(widths);
    expect(screen.getByRole('dialog').getAttribute('aria-labelledby')).toBe('cult-live-preview-title');
    expect(document.getElementById('cult-live-preview-title')?.textContent).toBe(parent.displayTitle);
    fireEvent.click(screen.getByTestId('cult-live-preview-width-768'));
    expect(screen.getByTestId('cult-live-preview-frame')).toBe(exampleFrame);
    fireEvent.click(within(parts).getByRole('button', { name: /Page Hero Section/ }));
    await screen.findByTestId(`catalog-cult-copy-cli-${section.id}`);
    expect(screen.getByTestId('cult-live-preview-width-768').getAttribute('aria-pressed')).toBe('true');
  });

  it('surfaces a declared child match as its parent family and opens the matching part', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/cult/catalog') return new Response(JSON.stringify({ catalog: { schema: 'cult-catalog/1', snapshot: { id: 's', expectedItems: 1, fetchedItems: 1, pendingItems: 0 }, items: [parent] } }));
      if (url === `/api/cult/catalog/${encodeURIComponent(example.id)}`) return new Response(JSON.stringify({ item: example }));
      if (url.startsWith('/api/cult/preview/')) return new Response(JSON.stringify({ preview: INFO[HERO.id] }));
      if (url === '/api/genui/catalog') return new Response(JSON.stringify({ catalog: { schema: 'genui-catalog/1', components: [] } }));
      throw new Error(`unexpected fetch ${url}`);
    }));
    render(<CatalogView isActive />);
    fireEvent.click(screen.getByTestId('catalog-segment-blocks'));
    const search = await screen.findByTestId('catalog-blocks-search');
    fireEvent.change(search, { target: { value: 'Hero Example' } });
    expect((await screen.findByTestId(`catalog-cult-matched-part-${example.id}`)).textContent).toBe('Example · Hero Example');
    fireEvent.click(await screen.findByTestId(`catalog-cult-live-preview-${parent.id}`));
    expect(await screen.findByTestId(`catalog-cult-copy-cli-${example.id}`)).toBeTruthy();
    expect(document.getElementById('cult-live-preview-title')?.textContent).toBe(parent.displayTitle);
  });

  it('keeps browse arrows on parent rows while viewing a hidden child', async () => {
    relatedFetch();
    await openModal(HERO.id, [parent, BADGE]);
    fireEvent.click(screen.getByTestId(`cult-live-preview-part-${example.id}`));
    await screen.findByTestId(`catalog-cult-copy-cli-${example.id}`);
    fireEvent.keyDown(screen.getByTestId('cult-live-preview-close'), { key: 'ArrowRight' });
    await screen.findByTestId(`catalog-cult-copy-cli-${BADGE.id}`);
    expect(screen.queryByRole('group', { name: 'Parts' })).toBeNull();
    expect(screen.getByText('2 of 2')).toBeTruthy();
  });

  it('shows retry for a failed child lookup inside the stable workspace and keeps the whole part available', async () => {
    relatedFetch(true);
    await openModal(HERO.id, [parent]);
    const widths = screen.getByRole('group', { name: 'Width' });
    fireEvent.click(screen.getByTestId(`cult-live-preview-part-${section.id}`));
    const error = await screen.findByTestId('cult-live-preview-part-error');
    expect(screen.getByRole('group', { name: 'Width' })).toBe(widths);
    expect(screen.getByTestId(`cult-live-preview-part-${HERO.id}`)).toBeTruthy();
    expect(screen.queryByTestId('cult-live-preview-state')).toBeNull();
    fireEvent.click(within(error).getByRole('button', { name: 'Retry' }));
    await screen.findByTestId(`catalog-cult-copy-cli-${section.id}`);
  });

  it('ignores a late child lookup after returning to its parent', async () => {
    let resolveChild!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input).startsWith('/api/cult/catalog/')
      ? new Promise<Response>((resolve) => { resolveChild = resolve; })
      : new Response(JSON.stringify({ preview: INFO[HERO.id] }))));
    await openModal(HERO.id, [parent]);
    fireEvent.click(screen.getByTestId(`cult-live-preview-part-${section.id}`));
    fireEvent.click(screen.getByTestId(`cult-live-preview-part-${HERO.id}`));
    await act(async () => { resolveChild(new Response(JSON.stringify({ item: section }))); });
    expect(screen.getByTestId(`catalog-cult-copy-cli-${HERO.id}`)).toBeTruthy();
    expect(screen.queryByTestId(`catalog-cult-copy-cli-${section.id}`)).toBeNull();
  });
});
