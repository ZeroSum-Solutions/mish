// @vitest-environment jsdom

// Compact catalog cards open a dialog with the saved demo, source and rights details.
// Reference-only rows retain their rights and never offer upstream installation actions.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Twenty1stItem, Twenty1stListResponse, CultCatalogListResponse } from '@mish/contracts';

import { Twenty1stPanel } from '../../src/components/Twenty1stPanel';
import { CatalogView } from '../../src/components/CatalogView';
import catalogStyles from '../../src/components/CatalogView.module.css';
import twentyFirstStyles from '../../src/components/Twenty1stPanel.module.css';
import * as copyToClipboardModule from '../../src/lib/copy-to-clipboard';

const catalogCss = readFileSync(resolve(process.cwd(), 'src/components/CatalogView.module.css'), 'utf8');
const twentyFirstCss = readFileSync(resolve(process.cwd(), 'src/components/Twenty1stPanel.module.css'), 'utf8');

function declarations(css: string, className: string): string {
  return css.match(new RegExp(`\\.${className}\\s*\\{([^{}]*)\\}`))?.[1] ?? '';
}

function item(overrides: Partial<Twenty1stItem>): Twenty1stItem {
  return {
    id: '21st:example',
    slug: 'example',
    name: 'Example',
    author: 'someone',
    authorProfileUrl: 'https://21st.dev/@someone',
    itemUrl: 'https://21st.dev/@someone/components/example',
    rights: 'reference-only',
    licenseLabel: null,
    licenseUrl: null,
    licenseNotice: null,
    copyable: false,
    preview: { kind: 'none' },
    ...overrides,
  };
}

const REFERENCE_ONLY = item({ id: '21st:ref', slug: 'ref', name: 'Reference Item', tags: ['card'] });
const MIT = item({
  id: '21st:mit-item',
  slug: 'mit-item',
  name: 'MIT Item',
  tags: ['app'],
  rights: 'mit',
  licenseLabel: 'MIT © someone-org',
  licenseUrl: 'https://github.com/someone-org/someone/blob/main/LICENSE.md',
  licenseNotice: 'MIT License\n\nCopyright (c) 2026 someone-org\n\nPermission is hereby granted...',
  copyable: true,
});

const TWENTY_FIRST: Twenty1stListResponse = {
  catalog: { profile: 'https://21st.dev/@example', items: [REFERENCE_ONLY, MIT] },
};
const CULT: CultCatalogListResponse = { catalog: { schema: 'cult-catalog/1', snapshot: { id: 'cult-ui-pro@abc', expectedItems: 0, fetchedItems: 0, pendingItems: 0 }, items: [] } };

function stubFetch() {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/api/genui/catalog') return new Response(JSON.stringify({ catalog: { schema: 'genui-catalog/1', components: [] } }), { status: 200 });
    if (url === '/api/cult/catalog') return new Response(JSON.stringify(CULT), { status: 200 });
    if (url === '/api/21st') return new Response(JSON.stringify(TWENTY_FIRST), { status: 200 });
    throw new Error(`unexpected fetch ${url}`);
  }));
}

beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: vi.fn(function (this: HTMLDialogElement) { this.open = true; }) });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: vi.fn(function (this: HTMLDialogElement) { this.open = false; this.dispatchEvent(new Event('close')); }) });
});

function openCard(id: string) {
  fireEvent.click(within(screen.getByTestId(`catalog-21st-card-${id}`)).getByRole('button'));
}

describe('CatalogView 21st.dev segment', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    cleanup();
  });

  it('searches through the shared route and filters the visible cards', async () => {
    const requested: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requested.push(url);
      if (url === '/api/genui/catalog') return new Response(JSON.stringify({ catalog: { schema: 'genui-catalog/1', components: [] } }));
      if (url === '/api/cult/catalog') return new Response(JSON.stringify(CULT));
      if (url.startsWith('/api/21st')) {
        const params = new URL(url, 'http://test').searchParams;
        const filtered = TWENTY_FIRST.catalog.items.filter(entry =>
          (!params.get('query') || entry.name.includes(params.get('query')!))
          && (!params.get('tag') || entry.tags?.includes(params.get('tag')!))
          && (!params.get('rights') || entry.rights === params.get('rights')));
        return new Response(JSON.stringify({ catalog: { ...TWENTY_FIRST.catalog, items: filtered } }));
      }
      throw new Error(`unexpected fetch ${url}`);
    }));
    render(<CatalogView isActive />);
    fireEvent.click(screen.getByTestId('catalog-segment-21st'));
    await screen.findByTestId('catalog-21st-card-21st:ref');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search 21st.dev components' }), { target: { value: 'MIT' } });
    await waitFor(() => expect(requested).toContain('/api/21st?query=MIT'));
    await waitFor(() => expect(screen.queryByTestId('catalog-21st-card-21st:ref')).toBeNull());
    expect(screen.getByTestId('catalog-21st-card-21st:mit-item')).toBeTruthy();
    fireEvent.click(screen.getByTestId('catalog-21st-tag-card'));
    await waitFor(() => expect(requested).toContain('/api/21st?query=MIT&tag=card'));
    await waitFor(() => expect(screen.queryByTestId('catalog-21st-card-21st:mit-item')).toBeNull());
    fireEvent.click(screen.getByTestId('catalog-21st-tag-app'));
    await waitFor(() => expect(requested).toContain('/api/21st?query=MIT&tag=app'));
    fireEvent.click(screen.getByTestId('catalog-21st-rights-mit'));
    await waitFor(() => expect(requested).toContain('/api/21st?query=MIT&tag=app&rights=mit'));
    await screen.findByTestId('catalog-21st-card-21st:mit-item');
  });

  it('constrains the card title and description to clean ellipsis inside narrow cards', () => {
    render(<Twenty1stPanel load={{ kind: 'ready', items: [REFERENCE_ONLY] }} onRetry={() => {}} />);
    const card = screen.getByTestId('catalog-21st-card-21st:ref');
    const title = within(card).getByText(REFERENCE_ONLY.name);
    const description = within(card).getByText('Author: someone');

    expect(title).toHaveClass(catalogStyles.name!);
    expect(description).toHaveClass(catalogStyles.detail!, twentyFirstStyles.summary!);
    for (const [css, className] of [[catalogCss, 'name'], [catalogCss, 'detail'], [twentyFirstCss, 'summary']] as const) {
      const rule = declarations(css, className);
      expect(rule).toMatch(/min-width:\s*0\s*;/);
    }
    for (const rule of [declarations(catalogCss, 'name'), declarations(twentyFirstCss, 'summary')]) {
      expect(rule).toMatch(/overflow:\s*hidden\s*;/);
      expect(rule).toMatch(/text-overflow:\s*ellipsis\s*;/);
      expect(rule).toMatch(/white-space:\s*nowrap\s*;/);
    }
  });

  it('keeps rights off the cards and shows the correct rights and MIT notice in details', async () => {
    stubFetch();
    render(<CatalogView isActive />);
    fireEvent.click(screen.getByTestId('catalog-segment-21st'));
    await screen.findByTestId('catalog-21st-card-21st:ref');

    expect(screen.queryByTestId('catalog-21st-rights-21st:ref')).toBeNull();
    expect(screen.queryByTestId('catalog-21st-rights-21st:mit-item')).toBeNull();
    openCard('21st:ref');
    expect(screen.getByTestId('catalog-21st-rights-21st:ref').textContent).toBe('Reference only');
    expect(screen.queryByTestId('catalog-21st-notice-21st:ref')).toBeNull();
    expect(screen.queryByTestId('catalog-21st-copy-notice-21st:ref')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    openCard('21st:mit-item');
    expect(screen.getByTestId('catalog-21st-rights-21st:mit-item').textContent).toBe(MIT.licenseLabel);
    expect(screen.getByTestId('catalog-21st-notice-21st:mit-item').textContent).toBe(MIT.licenseNotice);
    expect(screen.getByTestId('catalog-21st-copy-notice-21st:mit-item')).not.toBeNull();
  });

  it('opens every reference-only row through one card button with no inline controls', () => {
    const items = Array.from({ length: 22 }, (_, index) => item({ id: `21st:ref-${index}`, name: `Reference ${index}` }));
    render(<Twenty1stPanel load={{ kind: 'ready', items }} onRetry={() => {}} />);
    expect(screen.getAllByTestId(/^catalog-21st-card-/)).toHaveLength(22);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
    for (const row of items) {
      const card = screen.getByTestId(`catalog-21st-card-${row.id}`);
      const opener = within(card).getByRole('button');
      expect(opener.tagName).toBe('BUTTON');
      expect(opener).toHaveAttribute('aria-haspopup', 'dialog');
      fireEvent.click(opener);
      expect(screen.getByRole('dialog', { name: row.name })).toBeTruthy();
      expect(screen.getByTestId(`catalog-21st-rights-${row.id}`)).toHaveTextContent('Reference only');
      expect(screen.queryByRole('button', { name: 'View source' })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    }
  });

  it('no card offers an install command anywhere — mit or reference-only', async () => {
    stubFetch();
    render(<CatalogView isActive />);
    fireEvent.click(screen.getByTestId('catalog-segment-21st'));
    await screen.findByTestId('catalog-21st-card-21st:mit-item');
    for (const id of ['21st:ref', '21st:mit-item']) {
      expect(screen.queryByTestId(`catalog-21st-copy-${id}`)).toBeNull();
    }
    expect(screen.getByTestId('catalog-21st-view').textContent).not.toMatch(/npx shadcn/i);
    expect(screen.getByTestId('catalog-21st-view').textContent).not.toMatch(/api_key/i);
  });

  it('copies just the licence notice with the "Copy licence notice" action, never a Mishh-served URL', async () => {
    stubFetch();
    const copySpy = vi.spyOn(copyToClipboardModule, 'copyToClipboard').mockResolvedValue(true);
    render(<CatalogView isActive />);
    fireEvent.click(screen.getByTestId('catalog-segment-21st'));
    await screen.findByTestId('catalog-21st-card-21st:mit-item');
    openCard('21st:mit-item');
    fireEvent.click(screen.getByTestId('catalog-21st-copy-notice-21st:mit-item'));
    await waitFor(() => expect(copySpy).toHaveBeenCalledWith(MIT.licenseNotice));
    expect(String(copySpy.mock.calls[0]![0])).not.toMatch(/\/api\//);
    await waitFor(() => expect(screen.getByTestId('catalog-21st-copy-notice-21st:mit-item').textContent).toBe('Copied'));
  });

  it('shows the notice text inline when the clipboard copy fails, instead of only a toast', async () => {
    stubFetch();
    vi.spyOn(copyToClipboardModule, 'copyToClipboard').mockResolvedValue(false);
    render(<CatalogView isActive />);
    fireEvent.click(screen.getByTestId('catalog-segment-21st'));
    await screen.findByTestId('catalog-21st-card-21st:mit-item');
    openCard('21st:mit-item');
    fireEvent.click(screen.getByTestId('catalog-21st-copy-notice-21st:mit-item'));
    const failed = await screen.findByTestId('catalog-21st-copy-notice-failed-21st:mit-item');
    expect(failed.textContent).toContain(MIT.licenseNotice);
  });

  it('the segment count matches the row count once the tab is opened and loaded', async () => {
    stubFetch();
    render(<CatalogView isActive />);
    // The 21st list loads only once its own tab is opened (not eagerly with the other segments).
    expect(screen.getByTestId('catalog-segment-21st').textContent).toBe('21st.dev');
    fireEvent.click(screen.getByTestId('catalog-segment-21st'));
    await waitFor(() => expect(screen.getByTestId('catalog-segment-21st').textContent).toBe('21st.dev 2'));
  });
});


describe('owned alternatives are separate from upstream reference rights', () => {
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
  it('previews and downloads original source even when the upstream row remains reference-only', () => {
    const owned = item({ ownedAlternative: { title:'Orbital study',description:'Floating geometry',provenance:'independently-authored',sourceSha256:'a'.repeat(64),sourceUrl:'/api/21st/example/source',previewUrl:'/api/21st/example/preview' } });
    render(<Twenty1stPanel load={{kind:'ready',items:[owned]}} onRetry={()=>{}} />);
    expect(screen.queryByRole('link', { name: 'Download original ZIP' })).toBeNull();
    openCard(owned.id);
    expect(screen.getByTitle('Orbital study expanded demo').getAttribute('src')).toContain('/api/21st/example/preview');
    expect(screen.getByTitle('Orbital study expanded demo').getAttribute('sandbox')).toBe('allow-scripts');
    expect(screen.getByRole('link',{name:'Download original ZIP'}).getAttribute('href')).toBe('/api/21st/example/source?download=zip');
    expect(screen.getByTestId(`catalog-21st-rights-${owned.id}`)).toHaveTextContent('Reference only');
    fireEvent.click(screen.getByRole('button',{name:'Switch demo theme'}));
    expect(screen.getByTitle('Orbital study expanded demo').getAttribute('src')).toContain('theme=light');
    fireEvent.click(screen.getByRole('button',{name:'Less motion'}));
    expect(screen.getByTitle('Orbital study expanded demo').getAttribute('src')).toContain('motion=reduced');
  });
  it('uses document load for the static owned fallback and bounds a frame that never loads', async () => {
    vi.useFakeTimers();
    const owned = item({ ownedAlternative: { title:'Orbital study',description:'Floating geometry',provenance:'independently-authored',sourceSha256:'a'.repeat(64),sourceUrl:'/api/21st/example/source',previewUrl:'/api/21st/example/preview' } });
    render(<Twenty1stPanel load={{kind:'ready',items:[owned]}} onRetry={()=>{}} />);
    openCard(owned.id);
    await act(async () => { await vi.advanceTimersByTimeAsync(8000); });
    fireEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: 'Retry' }));
    fireEvent.load(screen.getByTitle('Orbital study expanded demo'));
    expect(screen.queryByText('Loading demo…')).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(8000); });
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it('does not claim copy success when the source endpoint fails', async () => {
    vi.stubGlobal('fetch',vi.fn(async()=>new Response('{}',{status:503})));
    const owned = item({ ownedAlternative: { title:'Orbital study',description:'Floating geometry',provenance:'independently-authored',sourceSha256:'a'.repeat(64),sourceUrl:'/api/21st/example/source',previewUrl:'/api/21st/example/preview' } });
    render(<Twenty1stPanel load={{kind:'ready',items:[owned]}} onRetry={()=>{}} />);
    openCard(owned.id);
    fireEvent.click(screen.getByRole('button',{name:'View source'}));
    expect(await screen.findByRole('alert')).toHaveTextContent('Source could not load. Try again.');
    expect(screen.queryByRole('button',{name:'Copy browser module'})).toBeNull();
  });
  it('closes an expanded demo only on an Escape message from that frame', () => {
    const showModal = vi.fn(function(this: HTMLDialogElement) { this.open = true; });
    const close = vi.fn(function(this: HTMLDialogElement) { this.open = false; this.dispatchEvent(new Event('close')); });
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: showModal });
    Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: close });
    const owned = item({ ownedAlternative: { title:'Orbital study',description:'Floating geometry',provenance:'independently-authored',sourceSha256:'a'.repeat(64),sourceUrl:'/api/21st/example/source',previewUrl:'/api/21st/example/preview' } });
    render(<Twenty1stPanel load={{kind:'ready',items:[owned]}} onRetry={()=>{}} />);
    openCard(owned.id);
    const frame = screen.getByTitle('Orbital study expanded demo') as HTMLIFrameElement;
    fireEvent(window, new MessageEvent('message', { origin: 'null', source: window, data: { type: 'mishh-original-preview-escape' } }));
    expect(close).not.toHaveBeenCalled();
    fireEvent(window, new MessageEvent('message', { origin: 'null', source: frame.contentWindow, data: { type: 'mishh-original-preview-escape' } }));
    expect(close).toHaveBeenCalledOnce();
    expect(screen.queryByTitle('Orbital study expanded demo')).toBeNull();
  });
});

describe('actual private upstream implementations', () => {
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
  const privateItem = () => item({
    preview: { kind: 'image', source: 'twenty-first-dev-cdn' },
    privateImplementation: { title: 'Saved upstream Orbit', description: 'The actual saved React demo', provenance: 'upstream-private',
      sourceVerified: true, localImportClosure: { status: 'resolved' }, sourceSha256: 'b'.repeat(64), sourceUrl: '/api/21st/example/source', previewUrl: '/api/21st/example/preview' },
    ownedAlternative: { title: 'Generic orbit', description: 'Separate study', provenance: 'independently-authored',
      sourceSha256: 'a'.repeat(64), sourceUrl: '/api/21st/alternative/source', previewUrl: '/api/21st/alternative/preview' },
  });
  const sourceBundle = () => ({
    id: '21st:example', title: 'Saved upstream Orbit', provenance: 'upstream-private', sourceVerified: true, localImportClosure: { status: 'resolved' },
    referenceUrl: 'https://21st.dev/@someone/components/example', referenceAuthor: 'someone', sourceSha256: 'b'.repeat(64),
    files: [
      { path: 'components/orbit.tsx', content: 'export function Orbit() { return <main>Actual upstream source</main>; }', sha256: 'c'.repeat(64) },
      { path: 'demo.tsx', content: 'export default function Demo() { return <Orbit speed={2} />; }', sha256: 'd'.repeat(64) },
    ],
  });
  function dialogSupport() {
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: vi.fn(function (this: HTMLDialogElement) { this.open = true; }) });
    Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: vi.fn(function (this: HTMLDialogElement) { this.open = false; this.dispatchEvent(new Event('close')); }) });
  }

  it('explains a missing local file, retains source inspection and preview, and hides ZIP', async () => {
    const current = privateItem();
    current.privateImplementation!.localImportClosure = { status: 'missing', missing: [{ importer: 'gallery/components/dashboard/demo.tsx', specifier: '@/components/ui/separator', resolvedCandidate: 'gallery/components/ui/separator' }] };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ...sourceBundle(), localImportClosure: current.privateImplementation!.localImportClosure }), { status: 200 })));
    render(<Twenty1stPanel load={{ kind: 'ready', items: [current] }} onRetry={() => {}} />);
    openCard(current.id);
    expect(screen.getByTestId('catalog-21st-missing-import')).toHaveTextContent('gallery/components/ui/separator');
    expect(screen.getByTitle('Saved upstream Orbit expanded demo').getAttribute('src')).toContain('/preview');
    expect(screen.queryByRole('link', { name: 'Download source ZIP' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'View source' }));
    expect(await screen.findByText(/Actual upstream source/)).toBeTruthy();
  });
  it('keeps source inspection and preview but hides ZIP when local imports are unverified', async () => {
    const current = privateItem();
    current.privateImplementation!.localImportClosure = { status: 'unverified', reason: 'parse-error' };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ...sourceBundle(), localImportClosure: current.privateImplementation!.localImportClosure }), { status: 200 })));
    render(<Twenty1stPanel load={{ kind: 'ready', items: [current] }} onRetry={() => {}} />);
    openCard(current.id);
    expect(screen.getByText(/local imports could not be verified/)).toBeTruthy();
    expect(screen.getByTitle('Saved upstream Orbit expanded demo').getAttribute('src')).toContain('/preview');
    expect(screen.queryByRole('link', { name: 'Download source ZIP' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'View source' }));
    expect(await screen.findByText(/Actual upstream source/)).toBeTruthy();
  });

  it('inspects matching newer source from a cached catalog without closure while keeping ZIP hidden', async () => {
    const current = privateItem();
    delete current.privateImplementation!.localImportClosure;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(sourceBundle()), { status: 200 })));
    render(<Twenty1stPanel load={{ kind: 'ready', items: [current] }} onRetry={() => {}} />);
    openCard(current.id);
    expect(screen.getByTitle('Saved upstream Orbit expanded demo').getAttribute('src')).toContain('/preview');
    expect(screen.queryByRole('link', { name: 'Download source ZIP' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'View source' }));
    expect(await screen.findByText(/Actual upstream source/)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Download source ZIP' })).toBeNull();
  });

  it.each([
    { id: '21st:other' },
    { sourceSha256: 'e'.repeat(64) },
    { provenance: 'independently-authored', files: ['index.ts','runtime.ts','component.js','style.css','index.html','NOTICE.txt','README.md'].map(path => ({ path, content: 'wrong provenance', sha256: 'c'.repeat(64) })) },
  ])('rejects mismatched source %j even when cached catalog has no closure', async mismatch => {
    const current = privateItem();
    delete current.privateImplementation!.localImportClosure;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ...sourceBundle(), ...mismatch }), { status: 200 })));
    render(<Twenty1stPanel load={{ kind: 'ready', items: [current] }} onRetry={() => {}} />);
    openCard(current.id);
    fireEvent.click(screen.getByRole('button', { name: 'View source' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Source could not load');
    expect(screen.queryByTestId('catalog-21st-source-code')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Download source ZIP' })).toBeNull();
  });

  it('discloses reviewed copy in expanded details and checks source refinement identity', async () => {
    const current = privateItem(), refinement = { originalSourceSha256: 'e'.repeat(64), note: 'Reviewed copy refinement; original pinned source remains unchanged.' };
    current.privateImplementation!.refinement = refinement;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ...sourceBundle(), refinement: { ...refinement, originalSourceSha256: 'f'.repeat(64) } }), { status: 200 })));
    render(<Twenty1stPanel load={{ kind: 'ready', items: [current] }} onRetry={() => {}} />);
    expect(screen.queryByTestId('catalog-21st-copy-refinement')).toBeNull();
    openCard(current.id);
    expect(screen.getByTestId('catalog-21st-copy-refinement')).toHaveTextContent(refinement.note);
    expect(screen.getByTestId('catalog-21st-copy-refinement')).toHaveAttribute('title', refinement.originalSourceSha256);
    fireEvent.click(screen.getByRole('button', { name: 'View source' }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.queryByTestId('catalog-21st-source-code')).toBeNull();
  });

  it.each(['private', 'alternative'] as const)('delegates encrypted media only to the Listen App %s preview', kind => {
    dialogSupport();
    const listen = { ...privateItem(), id: '21st:moumensoliman-glassmorphism-listen-app' };
    const other = privateItem();
    if (kind === 'alternative') { delete listen.privateImplementation; delete other.privateImplementation; }
    render(<Twenty1stPanel load={{ kind: 'ready', items: [listen, other] }} onRetry={() => {}} />);
    const listenCard = screen.getByTestId(`catalog-21st-card-${listen.id}`);
    const otherCard = screen.getByTestId(`catalog-21st-card-${other.id}`);
    const title = kind === 'private' ? 'Saved upstream Orbit' : 'Generic orbit';
    fireEvent.click(within(listenCard).getByRole('button'));
    expect(within(listenCard).getByTitle(`${title} expanded demo`)).toHaveAttribute('allow', 'encrypted-media *');
    expect(within(listenCard).getByTitle(`${title} expanded demo`)).toHaveAttribute('sandbox', 'allow-scripts');
    fireEvent.click(within(listenCard).getByRole('button', { name: 'Close' }));
    fireEvent.click(within(otherCard).getByRole('button'));
    expect(within(otherCard).getByTitle(`${title} expanded demo`)).not.toHaveAttribute('allow');
    expect(within(otherCard).getByTitle(`${title} expanded demo`)).toHaveAttribute('sandbox', 'allow-scripts');
  });

  it('keeps an interactive demo mounted while fixed viewport buttons resize it', () => {
    dialogSupport();
    render(<Twenty1stPanel load={{ kind: 'ready', items: [privateItem()] }} onRetry={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open Saved upstream Orbit demo' }));
    const frame = screen.getByTitle('Saved upstream Orbit expanded demo');
    const width = screen.getByRole('group', { name: 'Demo width' });
    const fit = within(width).getByRole('button', { name: 'Fit' });
    expect(fit.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(within(width).getByRole('button', { name: /Phone 390/ }));
    expect(frame.style.width).toBe('390px');
    expect(screen.getByTitle('Saved upstream Orbit expanded demo')).toBe(frame);
    expect(screen.getByRole('group', { name: 'Demo width' })).toBe(width);
    fireEvent.click(fit);
    expect(screen.getByTitle('Saved upstream Orbit expanded demo')).toBe(frame);
  });

  it('sizes the visible demo box only from the current frame size bridge for this item', () => {
    dialogSupport();
    render(<Twenty1stPanel load={{ kind: 'ready', items: [privateItem()] }} onRetry={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open Saved upstream Orbit demo' }));
    const frame = screen.getByTitle('Saved upstream Orbit expanded demo') as HTMLIFrameElement;
    const box = () => screen.getByTitle('Saved upstream Orbit expanded demo').parentElement!;
    const layoutHeight = frame.style.height;
    const size = (source: Window | null, data: Record<string, unknown>) =>
      fireEvent(window, new MessageEvent('message', { origin: 'null', source, data: { source: 'twentyfirst-preview-size', type: 'size', width: 1280, ...data } }));
    size(frame.contentWindow, { id: '21st:other', height: 300 });
    size(window, { id: '21st:example', height: 300 });
    size(frame.contentWindow, { id: '21st:example', height: 5000 });
    expect(box().style.height).toBe(layoutHeight);
    size(frame.contentWindow, { id: '21st:example', height: 300 });
    expect(box().style.height).toBe('300px');
    expect(frame.style.height).toBe(layoutHeight);
    expect(screen.getByText('Loading demo…')).toBeTruthy(); // size never stands in for readiness
    const oldWindow = frame.contentWindow;
    fireEvent.click(screen.getByRole('button', { name: 'Switch demo theme' }));
    const reloaded = screen.getByTitle('Saved upstream Orbit expanded demo');
    expect(reloaded).not.toBe(frame);
    expect(box().style.height).toBe(layoutHeight);
    size(oldWindow, { id: '21st:example', height: 260 });
    expect(box().style.height).toBe(layoutHeight);
  });

  it('opens the actual upstream demo from its thumbnail and never defaults to the alternative', () => {
    dialogSupport();
    render(<Twenty1stPanel load={{ kind: 'ready', items: [privateItem()] }} onRetry={() => {}} />);
    expect(screen.queryByText('Private saved source')).toBeNull();
    expect(screen.queryByText('Generic orbit')).toBeNull();
    expect(document.querySelector('iframe')).toBeNull();
    expect(screen.getByRole('img').getAttribute('src')).toBe('/api/21st/21st%3Aexample/reference-preview');
    fireEvent.click(screen.getByRole('button', { name: 'Open Saved upstream Orbit demo' }));
    expect(screen.getByText('Private saved source')).toBeTruthy();
    const frame = screen.getByTitle('Saved upstream Orbit expanded demo');
    expect(frame.getAttribute('src')).toContain('/api/21st/example/preview');
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(screen.getByText('Loading demo…')).toBeTruthy();
    fireEvent(window, new MessageEvent('message', { origin: 'null', source: window, data: { source: 'twentyfirst-private-preview', id: '21st:example', status: 'ready' } }));
    expect(screen.getByText('Loading demo…')).toBeTruthy();
    fireEvent(window, new MessageEvent('message', { origin: 'null', source: (frame as HTMLIFrameElement).contentWindow, data: { source: 'twentyfirst-private-preview', id: '21st:other', status: 'ready' } }));
    expect(screen.getByText('Loading demo…')).toBeTruthy();
    fireEvent(window, new MessageEvent('message', { origin: 'null', source: (frame as HTMLIFrameElement).contentWindow, data: { source: 'twentyfirst-private-preview', id: '21st:example', status: 'ready' } }));
    expect(screen.queryByText('Loading demo…')).toBeNull();
    fireEvent.click(within(screen.getByRole('group', { name: 'Demo width' })).getByRole('button', { name: /Tablet 768/ }));
    expect(frame.style.width).toBe('768px');
    fireEvent(window, new MessageEvent('message', { origin: 'null', source: (frame as HTMLIFrameElement).contentWindow, data: { source: 'twentyfirst-private-preview', id: '21st:example', type: 'escape' } }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows and copies the chosen actual source file while preserving upstream rights', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(sourceBundle()), { status: 200 })));
    const copySpy = vi.spyOn(copyToClipboardModule, 'copyToClipboard').mockResolvedValue(true);
    render(<Twenty1stPanel load={{ kind: 'ready', items: [privateItem()] }} onRetry={() => {}} />);
    openCard('21st:example');
    fireEvent.click(screen.getByRole('button', { name: 'View source' }));
    const selector = await screen.findByRole('combobox', { name: 'Source file' });
    expect(within(selector).getAllByRole('option').map(option => option.textContent)).toEqual(['components/orbit.tsx', 'demo.tsx']);
    expect(screen.getByTestId('catalog-21st-source-code').textContent).toBe(sourceBundle().files[0]!.content);
    fireEvent.change(selector, { target: { value: 'demo.tsx' } });
    expect(screen.getByTestId('catalog-21st-source-code').textContent).toBe(sourceBundle().files[1]!.content);
    fireEvent.click(screen.getByRole('button', { name: 'Copy selected file' }));
    await waitFor(() => expect(copySpy).toHaveBeenCalledWith(sourceBundle().files[1]!.content));
    expect(screen.getByTestId('catalog-21st-rights-21st:example')).toHaveTextContent('Reference only');
    expect(screen.getByRole('complementary', { name: 'Saved upstream Orbit' })).toHaveTextContent('Upstream source saved privately');
    expect(screen.getByRole('link', { name: 'Download source ZIP' }).getAttribute('href')).toBe('/api/21st/example/source?download=zip');
  });

  it('selects the declared primary source file instead of guessing from file names', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ...sourceBundle(), primarySourcePath: 'demo.tsx' }), { status: 200 })));
    render(<Twenty1stPanel load={{ kind: 'ready', items: [privateItem()] }} onRetry={() => {}} />);
    openCard('21st:example');
    fireEvent.click(screen.getByRole('button', { name: 'View source' }));
    const selector = await screen.findByRole('combobox', { name: 'Source file' });
    expect(selector).toHaveValue('demo.tsx');
    expect(screen.getByTestId('catalog-21st-source-code')).toHaveTextContent(sourceBundle().files[1]!.content);
  });

  it('can retry failed source loading without exposing a copy action until success', async () => {
    let attempts = 0;
    vi.stubGlobal('fetch', vi.fn(async () => ++attempts === 1
      ? new Response('{}', { status: 503 }) : new Response(JSON.stringify(sourceBundle()), { status: 200 })));
    render(<Twenty1stPanel load={{ kind: 'ready', items: [privateItem()] }} onRetry={() => {}} />);
    openCard('21st:example');
    fireEvent.click(screen.getByRole('button', { name: 'View source' }));
    const alert = await screen.findByRole('alert');
    expect(screen.queryByRole('button', { name: 'Copy selected file' })).toBeNull();
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('combobox', { name: 'Source file' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('refuses source returned for a different saved item', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ...sourceBundle(), id: '21st:other' }), { status: 200 })));
    render(<Twenty1stPanel load={{ kind: 'ready', items: [privateItem()] }} onRetry={() => {}} />);
    openCard('21st:example');
    fireEvent.click(screen.getByRole('button', { name: 'View source' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Source could not load');
    expect(screen.queryByRole('button', { name: 'Copy selected file' })).toBeNull();
  });

  it('shows the selected local implementation thumbnail with its exact image cache revision', () => {
    const current = privateItem();
    current.privateImplementation!.thumbnail = { revision: 'd'.repeat(64) };
    render(<Twenty1stPanel load={{ kind: 'ready', items: [current] }} onRetry={() => {}} />);
    const preview = screen.getByRole('img');
    expect(preview).toHaveAttribute('src', `/api/21st/21st%3Aexample/implementation-thumbnail?revision=${'d'.repeat(64)}`);
    expect(preview).toHaveAttribute('alt', 'Preview of Example, rendered from its saved implementation');
    expect(document.querySelector('iframe')).toBeNull();
    fireEvent.error(preview);
    expect(screen.getByRole('img')).toHaveAttribute('src', '/api/21st/21st%3Aexample/reference-preview');
    expect(screen.getByRole('img')).toHaveAttribute('alt', 'Preview of Example, published by 21st.dev');
  });

  // generated/21st-live-thumbnails/ no longer ships a committed screenshot for a reference-only
  // (non-copyable) row (see packages/21st-catalog/generated/21st-items.json); the daemon
  // (apps/daemon/src/services/twenty1st-thumbnails.ts) then never attaches a `thumbnail` field to
  // privateImplementation/ownedAlternative, so the card's <img> points at `/reference-preview`
  // instead. That route is same-origin, served by apps/daemon/src/routes/twenty1st.ts from a file
  // under generated/21st-thumbnails/ — never a 21st.dev CDN URL handed to the browser — and it now
  // only has a committed copy for a `mit` row (twenty1stMayShipLocalImage, @mish/contracts);
  // a reference-only row's `/reference-preview` answers 404 (see
  // apps/daemon/tests/twenty1st-routes.test.ts). So if this row's preview state is ever stale
  // enough to still claim `preview.kind: "image"`, the resulting <img> 404s at runtime and must
  // end at the neutral placeholder, never a broken image.
  it('ends at the neutral placeholder when a reference-only row\'s saved preview image 404s (onError path)', () => {
    const current = privateItem();
    expect(current.rights).toBe('reference-only');
    expect(current.privateImplementation!.thumbnail).toBeUndefined();
    render(<Twenty1stPanel load={{ kind: 'ready', items: [current] }} onRetry={() => {}} />);
    const preview = screen.getByRole('img');
    expect(preview).toHaveAttribute('src', '/api/21st/21st%3Aexample/reference-preview');
    fireEvent.error(preview);
    expect(screen.queryByRole('img')).toBeNull();
    const card = screen.getByTestId('catalog-21st-preview-21st:example');
    expect(card).toHaveAttribute('data-preview', 'none');
    expect(card.textContent).toBe('No preview image on record');
  });

  // A reference-only row with neither a local implementation thumbnail nor a saved same-origin
  // preview (preview.kind "none", the real shape the daemon now sends for every reference-only
  // row) must render the existing neutral placeholder, never an <img> pointing at a missing or
  // removed file.
  it('shows the neutral placeholder, never a broken <img>, for a reference-only row with no saved preview at all', () => {
    const bare = item({ id: '21st:bare', slug: 'bare', name: 'Bare Reference' });
    render(<Twenty1stPanel load={{ kind: 'ready', items: [bare] }} onRetry={() => {}} />);
    expect(screen.queryByRole('img')).toBeNull();
    const preview = screen.getByTestId('catalog-21st-preview-21st:bare');
    expect(preview).toHaveAttribute('data-preview', 'none');
    expect(preview.textContent).toBe('No preview image on record');
  });

  it('caches validated source and restores focus to the card after Escape', async () => {
    const fetchSource = vi.fn(async () => new Response(JSON.stringify(sourceBundle()), { status: 200 }));
    vi.stubGlobal('fetch', fetchSource);
    render(<Twenty1stPanel load={{ kind: 'ready', items: [privateItem()] }} onRetry={() => {}} />);
    const opener = screen.getByRole('button', { name: 'Open Saved upstream Orbit demo' });
    fireEvent.click(opener);
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'View source' }));
    await screen.findByRole('combobox', { name: 'Source file' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Source file' }), { target: { value: 'demo.tsx' } });
    fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }));
    expect(opener).toHaveFocus();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.querySelector('iframe')).toBeNull();
    fireEvent.click(opener);
    expect(screen.getByRole('combobox', { name: 'Source file' })).toHaveValue('demo.tsx');
    expect(fetchSource).toHaveBeenCalledOnce();
  });

  it.each([
    { sourceSha256: 'e'.repeat(64) },
    { provenance: 'independently-authored', files: ['index.ts','runtime.ts','component.js','style.css','index.html','NOTICE.txt','README.md'].map(path => ({ path, content: 'wrong provenance', sha256: 'c'.repeat(64) })) },
  ])('refuses mismatched source metadata %j', async mismatch => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ...sourceBundle(), ...mismatch }), { status: 200 })));
    render(<Twenty1stPanel load={{ kind: 'ready', items: [privateItem()] }} onRetry={() => {}} />);
    openCard('21st:example');
    fireEvent.click(screen.getByRole('button', { name: 'View source' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Source could not load');
    expect(screen.queryByTestId('catalog-21st-source-code')).toBeNull();
  });

  it('invalidates the source cache when the advertised source hash changes', async () => {
    const fetchSource = vi.fn(async () => new Response(JSON.stringify(sourceBundle()), { status: 200 }));
    vi.stubGlobal('fetch', fetchSource);
    const current = privateItem();
    const view = render(<Twenty1stPanel load={{ kind: 'ready', items: [current] }} onRetry={() => {}} />);
    openCard('21st:example');
    fireEvent.click(screen.getByRole('button', { name: 'View source' }));
    await screen.findByTestId('catalog-21st-source-code');
    view.rerender(<Twenty1stPanel load={{ kind: 'ready', items: [{ ...current, privateImplementation: { ...current.privateImplementation!, sourceSha256: 'e'.repeat(64) } }] }} onRetry={() => {}} />);
    expect(screen.queryByTestId('catalog-21st-source-code')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'View source' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Source could not load');
    expect(fetchSource).toHaveBeenCalledTimes(2);
  });

  it('offers retry when the active demo does not report ready within its loading budget', async () => {
    vi.useFakeTimers();
    render(<Twenty1stPanel load={{ kind: 'ready', items: [privateItem()] }} onRetry={() => {}} />);
    openCard('21st:example');
    await act(async () => { await vi.advanceTimersByTimeAsync(7999); });
    expect(screen.queryByRole('alert')).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('The demo could not start. Try again.');
    const previousFrame = screen.getByTitle('Saved upstream Orbit expanded demo') as HTMLIFrameElement;
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(screen.getByTitle('Saved upstream Orbit expanded demo')).not.toBe(previousFrame);
    fireEvent(window, new MessageEvent('message', { origin: 'null', source: previousFrame.contentWindow, data: { source: 'twentyfirst-private-preview', id: '21st:example', status: 'ready' } }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('Loading demo…')).toBeTruthy();
  });

  it('does not mistake a private iframe load for readiness or restart the opening deadline', async () => {
    vi.useFakeTimers();
    render(<Twenty1stPanel load={{ kind: 'ready', items: [privateItem()] }} onRetry={() => {}} />);
    openCard('21st:example');
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    fireEvent.load(screen.getByTitle('Saved upstream Orbit expanded demo'));
    expect(screen.getByText('Loading demo…')).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(screen.getByRole('alert')).toHaveTextContent('The demo could not start. Try again.');
  });

  it('rejects spoofed origins, frames, IDs, and protocol sources while waiting for readiness', async () => {
    vi.useFakeTimers();
    render(<Twenty1stPanel load={{ kind: 'ready', items: [privateItem()] }} onRetry={() => {}} />);
    openCard('21st:example');
    const frame = screen.getByTitle('Saved upstream Orbit expanded demo') as HTMLIFrameElement;
    const data = { source: 'twentyfirst-private-preview', id: '21st:example', status: 'ready' };
    for (const event of [
      { origin: 'https://example.com', source: frame.contentWindow, data },
      { origin: window.location.origin, source: frame.contentWindow, data },
      { origin: 'null', source: window, data },
      { origin: 'null', source: frame.contentWindow, data: { ...data, id: '21st:other' } },
      { origin: 'null', source: frame.contentWindow, data: { ...data, source: 'other' } },
    ]) {
      fireEvent(window, new MessageEvent('message', event));
      expect(screen.getByText('Loading demo…')).toBeTruthy();
    }
    fireEvent(window, new MessageEvent('message', { origin: 'null', source: frame.contentWindow, data }));
    expect(screen.queryByText('Loading demo…')).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(8000); });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('accepts a late own-frame error after ready and retains it until retry', async () => {
    vi.useFakeTimers();
    render(<Twenty1stPanel load={{ kind: 'ready', items: [privateItem()] }} onRetry={() => {}} />);
    openCard('21st:example');
    const frame = screen.getByTitle('Saved upstream Orbit expanded demo') as HTMLIFrameElement;
    const signal = (status: string) => fireEvent(window, new MessageEvent('message', { origin: 'null', source: frame.contentWindow, data: { source: 'twentyfirst-private-preview', id: '21st:example', status } }));
    signal('ready');
    await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
    expect(screen.queryByRole('alert')).toBeNull();
    signal('error');
    expect(screen.getByRole('alert')).toHaveTextContent('The demo could not start. Try again.');
    signal('loading'); signal('ready');
    expect(screen.getByRole('alert')).toBeTruthy();
    fireEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: 'Retry' }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('Loading demo…')).toBeTruthy();
  });

  it('lets a slow demo recover a deadline failure only through its validated ready signal', async () => {
    vi.useFakeTimers();
    render(<Twenty1stPanel load={{ kind: 'ready', items: [privateItem()] }} onRetry={() => {}} />);
    openCard('21st:example');
    await act(async () => { await vi.advanceTimersByTimeAsync(8000); });
    expect(screen.getByRole('alert')).toBeTruthy();
    const frame = screen.getByTitle('Saved upstream Orbit expanded demo') as HTMLIFrameElement;
    fireEvent(window, new MessageEvent('message', { origin: 'null', source: frame.contentWindow, data: { source: 'twentyfirst-private-preview', id: '21st:example', status: 'ready' } }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText('Loading demo…')).toBeNull();
  });

  it('keeps repeated loading signals within the opening deadline', async () => {
    vi.useFakeTimers();
    render(<Twenty1stPanel load={{ kind: 'ready', items: [privateItem()] }} onRetry={() => {}} />);
    openCard('21st:example');
    const frame = screen.getByTitle('Saved upstream Orbit expanded demo') as HTMLIFrameElement;
    await act(async () => { await vi.advanceTimersByTimeAsync(7999); });
    fireEvent(window, new MessageEvent('message', { origin: 'null', source: frame.contentWindow, data: { source: 'twentyfirst-private-preview', id: '21st:example', status: 'loading' } }));
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(screen.getByRole('alert')).toBeTruthy();
  });

});
