// @vitest-environment jsdom

// Blocks and Components views of the Catalog tab: the segmented control with counts, cards from
// GET /api/cult/catalog grouped by kind, the chip and search filters, the honest state labels,

import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CultCatalogItem, CultCatalogListResponse } from '@open-design/contracts';

import { CatalogView } from '../../src/components/CatalogView';
import { useCultCatalog } from '../../src/components/CultCatalogPanel';
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
    state: 'needs-adaptation',
    dependencies: { motion: false, canvas: false, webgl: false, server: false, packages: 0 },
    bytes: null,
    preview: { kind: 'none' },
    provenance: { snapshotId: 'cult-ui-pro@abc' },
    ...overrides,
  };
}

const ITEMS: CultCatalogItem[] = [
  item('cult:pricing-series-v', { displayTitle: 'Pricing (series V)', sectionKind: 'pricing', sourceCategory: 'marketing-pricing', spineAffinities: ['TL', 'PA'], tags: ['pricing', 'toggle'], summary: 'Series V pricing section.' }),
  item('cult:marketing-hero-simple', { displayTitle: 'Hero Simple', sectionKind: 'hero', state: 'pending', preview: { kind: 'image', source: 'source-render', revision: 'a'.repeat(64) } }),
  item('cult:hero-series-a', { displayTitle: 'Hero (series A)', sectionKind: 'hero', state: 'not-converted' }),
  item('cult:landing-page', { displayTitle: 'Landing Page', assetKind: 'page', sectionKind: 'page-composition' }),
  item('cult:organic-button', { displayTitle: 'Organic Button', assetKind: 'primitive', sectionKind: 'unclassified', sourceCategory: 'ui', state: 'pending' }),
  item('cult:ai-chat', { displayTitle: 'AI Chat', assetKind: 'app', sectionKind: 'unclassified', sourceCategory: 'ai', state: 'app-only' }),
];

const CULT: CultCatalogListResponse = {
  catalog: { schema: 'cult-catalog/1', snapshot: { id: 'cult-ui-pro@abc', expectedItems: 6, fetchedItems: 3, pendingItems: 3 }, items: ITEMS },
};

function stubFetch(cult: { status: number; body: unknown } = { status: 200, body: CULT }) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url === '/api/genui/catalog') {
      return new Response(JSON.stringify({ catalog: { schema: 'genui-catalog/1', components: [] } }), { status: 200 });
    }
    if (url === '/api/cult/catalog') return new Response(JSON.stringify(cult.body), { status: cult.status });
    if (url === '/api/21st') {
      return new Response(JSON.stringify({ catalog: { profile: 'https://21st.dev/@example', items: [] } }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  }));
  return { calls };
}

async function openSegment(name: 'blocks' | 'components') {
  const tab = screen.getByTestId(`catalog-segment-${name}`);
  fireEvent.click(tab);
  expect(tab.getAttribute('aria-selected')).toBe('true');
}

describe('CatalogView Blocks and Components', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it('shows the four segments with counts, Effects selected first', async () => {
    const { calls } = stubFetch();
    render(<CatalogView isActive />);
    await screen.findByTestId('catalog-cult-card-cult:landing-page');
    expect(calls).toContain('/api/cult/catalog');
    expect(screen.getByTestId('catalog-segment-effects').getAttribute('aria-selected')).toBe('true');
    await waitFor(() => expect(screen.getByTestId('catalog-segment-effects').textContent).toBe('Effects 0'));
    expect(screen.getByTestId('catalog-segment-blocks').textContent).toBe('Blocks 4');
    expect(screen.getByTestId('catalog-segment-components').textContent).toBe('Components 2');
    expect(screen.getByTestId('catalog-blocks-view').closest('[role="tabpanel"]')?.hasAttribute('hidden')).toBe(true);
  });

  it('moves between segments with the arrow keys', async () => {
    stubFetch();
    render(<CatalogView isActive />);
    const effects = screen.getByTestId('catalog-segment-effects');
    fireEvent.keyDown(effects, { key: 'ArrowRight' });
    expect(screen.getByTestId('catalog-segment-blocks').getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(screen.getByTestId('catalog-segment-blocks'));
    fireEvent.keyDown(screen.getByTestId('catalog-segment-blocks'), { key: 'ArrowRight' });
    expect(screen.getByTestId('catalog-segment-components').getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(screen.getByTestId('catalog-segment-components'), { key: 'End' });
    expect(screen.getByTestId('catalog-segment-21st').getAttribute('aria-selected')).toBe('true');
  });

  it('lists clean Blocks cards with one button, title and category; state filters stay available', async () => {
    stubFetch();
    render(<CatalogView isActive />);
    await screen.findByTestId('catalog-cult-card-cult:landing-page');
    await openSegment('blocks');

    const view = screen.getByTestId('catalog-blocks-view');
    expect(within(view).queryByTestId('catalog-cult-card-cult:organic-button')).toBeNull();
    expect(within(view).getByTestId('catalog-blocks-group-section-hero').textContent).toContain('Hero');
    expect(within(view).getByTestId('catalog-blocks-group-section-page-composition').textContent).toContain('Whole page');

    const pricing = within(view).getByTestId('catalog-cult-card-cult:pricing-series-v');
    expect(within(pricing).getByRole('heading').textContent).toBe('Pricing (series V)');
    expect(pricing.textContent).not.toMatch(/vercel/i);
    expect(pricing.textContent).toContain('No preview image yet');
    expect(pricing.querySelector('img, iframe')).toBeNull();
    expect(pricing.getAttribute('data-state')).toBe('needs-adaptation');
    expect(within(pricing).getAllByRole('button')).toHaveLength(1);
    const opener = within(pricing).getByRole('button');
    expect(opener.getAttribute('aria-haspopup')).toBe('dialog');
    expect(opener.querySelector('button')).toBeNull();
    expect(pricing.textContent).not.toContain('Needs adaptation');
    expect(pricing.textContent).not.toContain('Series V pricing section.');
    expect(pricing.textContent).not.toContain('TL');
    expect(pricing.textContent).not.toContain('#toggle');
    expect(pricing.textContent).not.toContain('Copy');
    expect(within(view).getByTestId('catalog-blocks-state-not-converted').textContent).toBe('Not converted yet 1');
    expect(within(view).getByTestId('catalog-blocks-state-needs-adaptation').textContent).toBe('Needs adaptation 2');
    expect(within(view).getByTestId('catalog-blocks-count').textContent).toBe('4 of 4 shown');
  });

  it('filters Blocks by kind chip, state chip and search', async () => {
    stubFetch();
    render(<CatalogView isActive />);
    await screen.findByTestId('catalog-cult-card-cult:landing-page');
    await openSegment('blocks');
    const view = screen.getByTestId('catalog-blocks-view');

    const heroChip = within(view).getByTestId('catalog-blocks-group-hero');
    fireEvent.click(heroChip);
    expect(heroChip.getAttribute('aria-pressed')).toBe('true');
    expect(within(view).queryByTestId('catalog-cult-card-cult:pricing-series-v')).toBeNull();
    expect(within(view).getByTestId('catalog-blocks-count').textContent).toBe('2 of 4 shown');

    // Faceted counts: with the hero chip on, the state chips count hero rows only, and each row's
    // All chip is the sum of its chips.
    expect(within(view).getByTestId('catalog-blocks-state-all').textContent).toBe('All 2');
    expect(within(view).getByTestId('catalog-blocks-state-pending').textContent).toBe('Pending 1');
    expect(within(view).getByTestId('catalog-blocks-state-needs-adaptation').textContent).toBe('Needs adaptation 0');

    fireEvent.click(within(view).getByTestId('catalog-blocks-state-pending'));
    expect(within(view).getByTestId('catalog-cult-card-cult:marketing-hero-simple')).toBeTruthy();
    expect(within(view).queryByTestId('catalog-cult-card-cult:hero-series-a')).toBeNull();
    expect(within(view).getByTestId('catalog-blocks-group-all').textContent).toBe('All 1');
    expect(within(view).getByTestId('catalog-blocks-group-pricing').textContent).toBe('Pricing 0');

    fireEvent.click(within(view).getByTestId('catalog-blocks-group-all'));
    fireEvent.click(within(view).getByTestId('catalog-blocks-state-all'));
    fireEvent.change(within(view).getByTestId('catalog-blocks-search'), { target: { value: 'toggle' } });
    expect(within(view).getByTestId('catalog-blocks-count').textContent).toBe('1 of 4 shown');

    fireEvent.change(within(view).getByTestId('catalog-blocks-search'), { target: { value: 'nothing-like-this' } });
    expect(within(view).getByText('Nothing matches these filters.')).toBeTruthy();
    // State chips only offer states present in the view: no App only chip among blocks.
    expect(within(view).queryByTestId('catalog-blocks-state-app-only')).toBeNull();
  });

  it('lists primitive and app rows in Components with the App only label', async () => {
    stubFetch();
    render(<CatalogView isActive />);
    await screen.findByTestId('catalog-cult-card-cult:ai-chat');
    await openSegment('components');
    const view = screen.getByTestId('catalog-components-view');
    expect(within(view).queryByTestId('catalog-cult-card-cult:landing-page')).toBeNull();
    expect(within(view).getByTestId('catalog-cult-card-cult:ai-chat').getAttribute('data-state')).toBe('app-only');
    expect(within(view).getByTestId('catalog-cult-card-cult:organic-button').getAttribute('data-state')).toBe('pending');
    fireEvent.click(within(view).getByTestId('catalog-components-group-ai'));
    expect(within(view).queryByTestId('catalog-cult-card-cult:organic-button')).toBeNull();
  });

  it('shows an error with a retry, and the empty state for an empty inventory', async () => {
    stubFetch({ status: 500, body: {} });
    render(<CatalogView isActive />);
    await openSegment('blocks');
    const view = screen.getByTestId('catalog-blocks-view');
    expect(await within(view).findByRole('alert')).toBeTruthy();
    expect(within(view).getByText('The inventory could not be loaded.')).toBeTruthy();
    cleanup();

    stubFetch({ status: 200, body: { catalog: { ...CULT.catalog, items: [] } } });
    render(<CatalogView isActive />);
    await openSegment('components');
    expect(await within(screen.getByTestId('catalog-components-view')).findByText('Nothing is catalogued here yet.')).toBeTruthy();
  });

  it('keeps only the latest response when reloads overlap', async () => {
    const pending: Array<(response: Response) => void> = [];
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { pending.push(resolve); })));
    const { result } = renderHook(() => useCultCatalog(false));
    act(() => {
      result.current.reload();
      result.current.reload();
    });
    await waitFor(() => expect(pending).toHaveLength(2));
    // The later request answers first with the inventory; the earlier one then fails late.
    await act(async () => { pending[1]!(new Response(JSON.stringify(CULT), { status: 200 })); });
    await waitFor(() => expect(result.current.load.kind).toBe('ready'));
    await act(async () => { pending[0]!(new Response('{}', { status: 500 })); });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(result.current.load.kind).toBe('ready');
  });

  it('treats a malformed 200 as an error, not an empty inventory', async () => {
    stubFetch({ status: 200, body: { catalog: { schema: 'cult-catalog/1', items: 'x' } } });
    render(<CatalogView isActive />);
    await openSegment('blocks');
    expect(await within(screen.getByTestId('catalog-blocks-view')).findByRole('alert')).toBeTruthy();
  });

  it('shows a row\'s preview image, lazily, with the brand-free title as alt text', async () => {
    stubFetch();
    render(<CatalogView isActive />);
    await screen.findByTestId('catalog-cult-card-cult:landing-page');
    await openSegment('blocks');
    const view = screen.getByTestId('catalog-blocks-view');

    const preview = within(view).getByTestId('catalog-cult-preview-cult:marketing-hero-simple');
    expect(preview.getAttribute('data-preview')).toBe('image');
    const img = within(preview).getByRole('img', { name: 'Preview of Hero Simple' }) as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('/api/cult/catalog/cult%3Amarketing-hero-simple/preview?v=' + 'a'.repeat(64));
    expect(img.getAttribute('loading')).toBe('lazy');
    expect(img.getAttribute('width')).toBe('480');
    expect(img.getAttribute('height')).toBe('300');
    expect(preview.textContent).not.toContain('No preview image yet');

    // A row without an image keeps the placeholder in the same frame, and no <img>.
    const none = within(view).getByTestId('catalog-cult-preview-cult:hero-series-a');
    expect(none.getAttribute('data-preview')).toBe('none');
    expect(none.querySelector('img')).toBeNull();
    expect(none.textContent).toContain('No preview image yet');
  });

  it('falls back to the placeholder when a preview image fails to load', async () => {
    stubFetch();
    render(<CatalogView isActive />);
    await screen.findByTestId('catalog-cult-card-cult:landing-page');
    await openSegment('blocks');
    const preview = within(screen.getByTestId('catalog-blocks-view')).getByTestId('catalog-cult-preview-cult:marketing-hero-simple');
    fireEvent.error(within(preview).getByRole('img'));
    const after = within(screen.getByTestId('catalog-blocks-view')).getByTestId('catalog-cult-preview-cult:marketing-hero-simple');
    expect(after.getAttribute('data-preview')).toBe('none');
    expect(after.querySelector('img')).toBeNull();
    expect(after.textContent).toContain('No preview image yet');
  });

  it("renders the English labels", async () => {
    stubFetch();
    render(<I18nProvider initial="en"><CatalogView isActive /></I18nProvider>);
    await screen.findByTestId('catalog-cult-card-cult:landing-page');
    await waitFor(() => expect(screen.getByTestId('catalog-segment-effects').textContent).toBe('Effects 0'));
    expect(screen.getByTestId('catalog-segment-blocks').textContent).toBe('Blocks 4');
    expect(screen.getByTestId('catalog-segment-components').textContent).toBe('Components 2');
    await openSegment('blocks');
    const view = screen.getByTestId('catalog-blocks-view');
    expect(within(view).getByTestId('catalog-blocks-state-needs-adaptation').textContent).toBe('Needs adaptation 2');
    expect(within(view).getByTestId('catalog-blocks-state-pending').textContent).toBe('Pending 1');
    expect(within(view).getByTestId('catalog-blocks-state-not-converted').textContent).toBe('Not converted yet 1');
    expect(view.textContent).toContain("No preview image yet");
    expect(within(view).getByRole('img', { name: "Preview of Hero Simple" })).toBeTruthy();
    expect(within(view).getByTestId('catalog-blocks-group-section-page-composition').textContent).toContain("Whole page");
    await openSegment('components');
    expect(within(screen.getByTestId('catalog-components-view')).getByTestId('catalog-components-state-app-only').textContent).toBe('App only 1');
  });
});
