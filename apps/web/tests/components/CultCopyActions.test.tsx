// @vitest-environment jsdom

// Remix into project: the three copy buttons on Blocks and Components cards. Install command and
// code come from GET /api/cult/copy/:id; the CLI line needs no request; the card stays brand-free.

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CultCatalogItem, CultCatalogListResponse, CultCopyResponse } from '@mish/contracts';

import { CatalogView } from '../../src/components/CatalogView';
import { CultCopyActions } from '../../src/components/CultCopyActions';
import { I18nProvider } from '../../src/i18n';

const ITEM: CultCatalogItem = {
  id: 'cult:pricing-series-v',
  slug: 'pricing-series-v',
  displayTitle: 'Pricing (series V)',
  summary: '',
  assetKind: 'section',
  sourceCategory: 'marketing',
  tags: [],
  sectionKind: 'pricing',
  spineAffinities: [],
  state: 'needs-adaptation',
  dependencies: { motion: true, canvas: false, webgl: false, server: false, packages: 1 },
  bytes: 10,
  preview: { kind: 'none' },
  provenance: { snapshotId: 'cult-ui-pro@abc' },
};

const COPY: CultCopyResponse = {
  copy: {
    id: ITEM.id,
    name: 'pricing-series-v',
    registryUrl: 'http://127.0.0.1:7456/api/cult/r/pricing-series-v.json',
    dependencies: ['motion'],
    registryDependencies: [],
    mainFile: { path: 'registry/x.tsx', type: 'registry:component', target: 'components/x.tsx', content: 'export const Pricing = 1;\n' },
    files: [{ path: 'registry/x.tsx', target: 'components/x.tsx' }],
  },
};

let clipboard: string[];
let calls: string[];

function stubFetch(copyStatus = 200) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url === `/api/cult/copy/${encodeURIComponent(ITEM.id)}`) {
      return new Response(JSON.stringify(copyStatus === 200 ? COPY : { error: { code: 'KIT_UNAVAILABLE', message: 'x' } }), { status: copyStatus });
    }
    if (url === '/api/genui/catalog') return new Response(JSON.stringify({ catalog: { schema: 'genui-catalog/1', components: [] } }), { status: 200 });
    if (url === '/api/cult/catalog') {
      const body: CultCatalogListResponse = {
        catalog: {
          schema: 'cult-catalog/1',
          snapshot: { id: 'cult-ui-pro@abc', expectedItems: 2, fetchedItems: 2, pendingItems: 0 },
          items: [ITEM, { ...ITEM, id: 'cult:ai-chat', displayTitle: 'AI Chat', assetKind: 'app', sectionKind: 'unclassified', state: 'app-only' }],
        },
      };
      return new Response(JSON.stringify(body), { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  }));
}

beforeEach(() => {
  clipboard = [];
  calls = [];
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn(async (text: string) => { clipboard.push(text); }) },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

function renderActions() {
  render(<I18nProvider><CultCopyActions item={ITEM} /></I18nProvider>);
  return screen.getByRole('group', { name: 'Remix Pricing (series V) into a project' });
}

describe('CultCopyActions', () => {
  it('offers three labelled buttons in a named group', () => {
    stubFetch();
    const group = renderActions();
    expect(within(group).getAllByRole('button').map((button) => button.textContent)).toEqual(['Copy code', 'Copy install command', 'Copy CLI']);
  });

  it('copies the install command for the loopback registry URL', async () => {
    stubFetch();
    const group = renderActions();
    fireEvent.click(within(group).getByRole('button', { name: 'Copy install command' }));
    await waitFor(() => expect(clipboard).toEqual(['npx shadcn@latest add http://127.0.0.1:7456/api/cult/r/pricing-series-v.json']));
    expect(screen.getByRole('status').textContent).toBe('Install command copied. Run it in your project.');
  });

  it('copies the main file, fetching the copy info once', async () => {
    stubFetch();
    const group = renderActions();
    fireEvent.click(within(group).getByRole('button', { name: 'Copy code' }));
    await waitFor(() => expect(clipboard).toEqual(['export const Pricing = 1;\n']));
    fireEvent.click(within(group).getByRole('button', { name: 'Copy install command' }));
    await waitFor(() => expect(clipboard).toHaveLength(2));
    expect(calls.filter((url) => url.startsWith('/api/cult/copy/'))).toHaveLength(1);
    expect(screen.getByRole('status').textContent).not.toMatch(/vercel|shadcn/i);
  });

  it('copies the od line without any request', async () => {
    stubFetch();
    const group = renderActions();
    fireEvent.click(within(group).getByRole('button', { name: 'Copy CLI' }));
    await waitFor(() => expect(clipboard).toEqual(['od cult add pricing-series-v --into .']));
    expect(calls).toEqual([]);
    expect(screen.getByRole('status').textContent).toBe('CLI command copied. Run it in your project.');
  });

  it('says so when the source is not available here', async () => {
    stubFetch(503);
    const group = renderActions();
    fireEvent.click(within(group).getByRole('button', { name: 'Copy code' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Could not copy'));
    expect(clipboard).toEqual([]);
  });

  it("keeps actions off cards and puts them in the expanded view, in English", async () => {
    stubFetch();
    render(<I18nProvider initial="en"><CatalogView isActive /></I18nProvider>);
    await screen.findByTestId('catalog-cult-card-cult:ai-chat');
    for (const id of [ITEM.id, 'cult:ai-chat']) {
      const card = screen.getByTestId(`catalog-cult-card-${id}`);
      expect(within(card).getAllByRole('button', { hidden: true })).toHaveLength(1);
      expect(card.textContent).not.toContain("Copy");
    }
    expect(screen.getByTestId(`catalog-cult-card-${ITEM.id}`).textContent).not.toMatch(/vercel|shadcn/i);
    fireEvent.click(screen.getByTestId('catalog-segment-blocks'));
    fireEvent.click(screen.getByTestId(`catalog-cult-live-preview-${ITEM.id}`));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByTestId(`catalog-cult-copy-install-${ITEM.id}`).textContent).toBe("Copy install command");
    expect(within(dialog).getByTestId(`catalog-cult-copy-code-${ITEM.id}`).textContent).toBe("Copy code");
    expect(within(dialog).getByTestId(`catalog-cult-copy-cli-${ITEM.id}`).textContent).toBe("Copy CLI");
  });
});
