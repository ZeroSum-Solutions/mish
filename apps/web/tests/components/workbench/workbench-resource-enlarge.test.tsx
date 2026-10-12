// @vitest-environment jsdom
// AC-R07.1/.2/.3 — every ResourceResult category offers Enlarge, either an
// interactive preview (component/HTML/video, image zoom, font specimen,
// skill/file/reference readable detail) or a truthful unavailable explanation
// naming the source and offering recovery. `od workbench inspect` already
// exercises the same resource metadata through the CLI surface; this covers
// the web Enlarge affordance the PRD requires alongside it.
import { act, useLayoutEffect } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RESOURCE_CATEGORIES, parseResourceSearchResponse, type ResourceResult } from '@mish/contracts';
import { I18nProvider } from '../../../src/i18n';
import { WorkbenchResourceDetail } from '../../../src/components/workbench/WorkbenchResourceDetail';
import { WorkbenchResourceSearch } from '../../../src/components/workbench/WorkbenchResourceSearch';
import { WorkbenchImageZoom } from '../../../src/components/workbench/WorkbenchImageZoom';
import { getWorkbenchResource, searchWorkbenchResources } from '../../../src/providers/workbench';

vi.mock('../../../src/providers/workbench', async (original) => ({
  ...await original<typeof import('../../../src/providers/workbench')>(),
  getWorkbenchResource: vi.fn(),
  searchWorkbenchResources: vi.fn(),
}));

afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

function base(overrides: Partial<ResourceResult> = {}): ResourceResult {
  return {
    ref: { sourceType: 'section', sourceId: 'sections', itemId: 'item', revisionOrDigest: 'digest' },
    refKey: 'key', title: 'Sample resource', category: 'component', readiness: 'unverified',
    compatibility: { nativeFormat: 'html', targets: ['html'], state: 'unverified', reason: null },
    rightsStatus: 'unknown', fitReasons: [],
    previewCapability: { available: false, kind: 'none', reason: 'adapter-missing' },
    adoptionCapability: { available: false, reason: 'adapter-missing' },
    sourceAttribution: { title: 'Source title' },
    operationGrants: [], admissionStage: 'discovered', needDecision: 'not-assessed', needReason: 'Not assessed',
    ...overrides,
  };
}

function setup(resource: ResourceResult) {
  vi.mocked(getWorkbenchResource).mockResolvedValue({ resource, sourceStatus: { sourceId: resource.ref.sourceId, state: 'searched', reason: null, itemCount: 1, listingDigest: 'digest' } });
  return render(<I18nProvider initial="en"><WorkbenchResourceDetail selected={resource} plugins={[]} onPickPlugin={vi.fn()} onClose={vi.fn()} onRefresh={vi.fn()} /></I18nProvider>);
}

describe('Workbench enlarge — interactive previews', () => {
  it('keeps a component preview interactive through an HTML adapter', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    const resource = base({ category: 'component', previewCapability: { available: true, kind: 'html', url: '/api/genui/catalog/x/preview', reason: null } });
    setup(resource);
    expect(await screen.findByRole('button', { name: 'Enlarge preview' })).toBeTruthy();
    expect(document.querySelector('iframe')).toBeTruthy();
  });
  it('keeps a video preview interactive whenever its adapter offers an executable HTML kind', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    const resource = base({ category: 'video', previewCapability: { available: true, kind: 'html', url: '/api/genui/catalog/clip/preview', reason: null } });
    setup(resource);
    expect(await screen.findByRole('button', { name: 'Enlarge preview' })).toBeTruthy();
    expect(document.querySelector('iframe')).toBeTruthy();
  });
  it('prefers an executable HTML preview over the skill text detail when both are possible', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    const resource = base({ category: 'skill', previewCapability: { available: true, kind: 'html', url: '/api/plugins/demo/preview', reason: null } });
    setup(resource);
    await screen.findByRole('button', { name: 'Enlarge preview' });
    expect(document.querySelector('iframe')).toBeTruthy();
    expect(screen.queryByTestId('workbench-text-detail')).toBeNull();
  });
});

describe('Workbench enlarge — image zoom', () => {
  it('shows loading, then zooms a ready image, preserving zoom across enlarge/restore', async () => {
    const resource = base({ category: 'image', previewCapability: { available: true, kind: 'reference', url: '/api/library/photo.png', reason: null } });
    setup(resource);
    await screen.findByTestId('workbench-image-zoom');
    expect(screen.getByRole('status')).toHaveTextContent('Loading preview');
    const image = document.querySelector('img')!;
    fireEvent.load(image);
    expect(screen.queryByRole('status')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(image.style.transform).toBe('scale(1.5)');
    fireEvent.click(screen.getByRole('button', { name: 'Enlarge preview' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(document.querySelector('img')!.style.transform).toBe('scale(1.5)');
    fireEvent.click(screen.getByRole('button', { name: 'Back to preview' }));
    expect(document.querySelector('img')!.style.transform).toBe('scale(1.5)');
  });
  // A cached image can fire `load` before React has run the mount's passive
  // effects (in a browser both are queued tasks, and a busy scheduler yields
  // between commit and effects). The mount effect used to reset state to
  // 'loading' unconditionally, clobbering that early 'ready': the preview sat
  // on "Loading preview…" and the 8-second timeout then reported a loaded
  // image as failed. A sibling's layout effect fires the load inside the same
  // commit, i.e. deterministically before any passive effect runs.
  it('keeps a load that lands before the mount effect runs instead of reverting to loading', () => {
    function LoadDuringCommit() {
      useLayoutEffect(() => { document.querySelector('img')!.dispatchEvent(new Event('load')); }, []);
      return null;
    }
    render(<I18nProvider initial="en"><WorkbenchImageZoom title="Cached" url="/api/library/cached.png" /><LoadDuringCommit /></I18nProvider>);
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByTestId('workbench-image-zoom').getAttribute('data-preview-state')).toBe('ready');
    expect(screen.getByRole('button', { name: 'Zoom in' })).toBeTruthy();
  });
  it('reports a failed image load with a working retry', async () => {
    const resource = base({ category: 'image', previewCapability: { available: true, kind: 'reference', url: '/api/library/broken.png', reason: null } });
    setup(resource);
    const image = await screen.findByAltText('Sample resource');
    fireEvent.error(image);
    expect(await screen.findByRole('alert')).toHaveTextContent('Image could not load');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(screen.getByRole('status')).toHaveTextContent('Loading preview');
    fireEvent.load(document.querySelector('img')!);
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it('recovers from a stalled load after the 8-second mount timeout, via Retry', async () => {
    vi.useFakeTimers();
    const resource = base({ category: 'image', previewCapability: { available: true, kind: 'reference', url: '/api/library/slow.png', reason: null } });
    setup(resource);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(screen.getByRole('status')).toHaveTextContent('Loading preview');
    act(() => vi.advanceTimersByTime(8000));
    expect(screen.getByRole('alert')).toHaveTextContent('Image could not load');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(screen.getByRole('status')).toHaveTextContent('Loading preview');
    fireEvent.load(document.querySelector('img')!);
    expect(screen.queryByRole('alert')).toBeNull();
  });
  // WARN: once zoomed past the viewport, the image overflows the zoom
  // surface's scroll bounds. A mouse drag on the scrollbar was the only way
  // to pan it; arrow keys had no effect because the surface was never
  // focusable. It must be a focusable, labelled region so a keyboard user can
  // reach and pan it like any other scrollable viewport.
  it('exposes the zoom surface as a focusable, labelled region that arrow keys pan', async () => {
    const resource = base({ category: 'image', previewCapability: { available: true, kind: 'reference', url: '/api/library/photo.png', reason: null } });
    setup(resource);
    await screen.findByTestId('workbench-image-zoom');
    const region = screen.getByRole('region', { name: 'Zoom level' });
    expect(region.getAttribute('tabindex')).toBe('0');
    fireEvent.keyDown(region, { key: 'ArrowRight' });
    expect(region.scrollLeft).toBe(40);
    fireEvent.keyDown(region, { key: 'ArrowDown' });
    expect(region.scrollTop).toBe(40);
    fireEvent.keyDown(region, { key: 'ArrowLeft' });
    expect(region.scrollLeft).toBe(0);
    fireEvent.keyDown(region, { key: 'ArrowUp' });
    expect(region.scrollTop).toBe(0);
  });
});

describe('Workbench enlarge — font specimen', () => {
  function stubFontFace(behavior: 'resolve' | 'reject' | 'pending') {
    const created: { family: string; source: string; descriptors?: FontFaceDescriptors }[] = [];
    class MockFontFace {
      family: string; source: string; descriptors?: FontFaceDescriptors;
      constructor(family: string, source: string, descriptors?: FontFaceDescriptors) {
        this.family = family; this.source = source; this.descriptors = descriptors;
        created.push({ family, source, descriptors });
      }
      load(): Promise<this> {
        if (behavior === 'resolve') return Promise.resolve(this);
        if (behavior === 'reject') return Promise.reject(new Error('bad font'));
        return new Promise(() => {}); // never settles — simulates a stalled connection
      }
    }
    vi.stubGlobal('FontFace', MockFontFace);
    Object.defineProperty(document, 'fonts', { value: { add: vi.fn(), delete: vi.fn() }, configurable: true });
    return created;
  }
  it('shows an editable, weighted specimen once the font resolves', async () => {
    stubFontFace('resolve');
    const resource = base({ category: 'font', previewCapability: { available: true, kind: 'reference', url: '/api/library/brand.woff2', reason: null } });
    setup(resource);
    await screen.findByTestId('workbench-font-specimen');
    const specimen = await screen.findByLabelText('Specimen text');
    fireEvent.change(specimen, { target: { value: 'Hello type' } });
    fireEvent.change(screen.getByLabelText('Weight'), { target: { value: '700' } });
    expect(screen.getByTestId('workbench-font-specimen-text')).toHaveStyle({ fontWeight: '700' });
    expect(screen.getByTestId('workbench-font-specimen-text')).toHaveTextContent('Hello type');
  });
  it('reports a failed font load with a working retry', async () => {
    stubFontFace('reject');
    const resource = base({ category: 'font', previewCapability: { available: true, kind: 'reference', url: '/api/library/broken.woff2', reason: null } });
    setup(resource);
    expect(await screen.findByRole('alert')).toHaveTextContent('Font could not load');
    stubFontFace('resolve');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByTestId('workbench-font-specimen');
    await screen.findByLabelText('Specimen text');
  });
  it('is a truthful unavailable panel, not a broken specimen, when the font preview is unavailable', async () => {
    const resource = base({ category: 'font', previewCapability: { available: false, kind: 'none', reason: 'connector-offline' } });
    setup(resource);
    const panel = await screen.findByTestId('workbench-preview-unavailable');
    expect(panel).toHaveTextContent('connector-offline');
    expect(screen.queryByTestId('workbench-font-specimen')).toBeNull();
  });
  it('declares the offered weight range on the loaded face instead of defaulting to a single static weight', async () => {
    const created = stubFontFace('resolve');
    const resource = base({ category: 'font', previewCapability: { available: true, kind: 'reference', url: '/api/library/brand.woff2', reason: null } });
    setup(resource);
    await screen.findByTestId('workbench-font-specimen');
    expect(created).toHaveLength(1);
    expect(created[0]!.descriptors).toEqual({ weight: '300 800' });
  });
  it('recovers from a stalled load after the 8-second mount timeout, via Retry', async () => {
    vi.useFakeTimers();
    stubFontFace('pending');
    const resource = base({ category: 'font', previewCapability: { available: true, kind: 'reference', url: '/api/library/slow.woff2', reason: null } });
    setup(resource);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(screen.getByRole('status')).toHaveTextContent('Loading preview');
    act(() => vi.advanceTimersByTime(8000));
    expect(screen.getByRole('alert')).toHaveTextContent('Font could not load');
    stubFontFace('resolve');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByTestId('workbench-font-specimen')).toBeTruthy();
  });
});

describe('Workbench enlarge — reference preview kind safety', () => {
  // The only real producer of `kind: 'reference'` today (sections' external-link
  // case) always pairs it with a non-null reason because it is a link to an
  // external page, not fetchable media bytes. A future image/font producer that
  // reused that exact shape for real media would set a null reason, like every
  // other available adapter (html, or this one's own no-link case) already does.
  it('falls back to the truthful unavailable panel for an image category reference that carries a no-adapter reason', async () => {
    const resource = base({ category: 'image', previewCapability: { available: true, kind: 'reference', url: 'https://example.com/photo-page', reason: 'Reference link; no local executable preview adapter' } });
    setup(resource);
    const panel = await screen.findByTestId('workbench-preview-unavailable');
    expect(panel).toHaveTextContent('Reference link; no local executable preview adapter');
    expect(screen.queryByTestId('workbench-image-zoom')).toBeNull();
  });
  it('falls back to the truthful unavailable panel for a font category reference that carries a no-adapter reason', async () => {
    const resource = base({ category: 'font', previewCapability: { available: true, kind: 'reference', url: 'https://example.com/font-page', reason: 'Reference link; no local executable preview adapter' } });
    setup(resource);
    const panel = await screen.findByTestId('workbench-preview-unavailable');
    expect(panel).toHaveTextContent('Reference link; no local executable preview adapter');
    expect(screen.queryByTestId('workbench-font-specimen')).toBeNull();
  });
});

describe('Workbench enlarge — skill/text full detail', () => {
  it.each(['skill', 'file', 'reference'] as const)('shows readable full details for category %s regardless of preview availability', async (category) => {
    const resource = base({
      category, fitReasons: ['Matches the booking conversion spine'],
      operationGrants: [{ operation: 'host-preview', state: 'permitted', reason: null }],
      styleTags: ['booking'],
    });
    setup(resource);
    const detail = await screen.findByTestId('workbench-text-detail');
    expect(detail).toHaveTextContent('Matches the booking conversion spine');
    expect(detail).toHaveTextContent('host-preview: permitted');
    expect(detail).toHaveTextContent('booking');
    expect(await screen.findByRole('button', { name: 'Enlarge preview' })).toBeTruthy();
  });
  // BLOCK: WorkbenchPreviewShell's expand effect sets `inert` on every DOM
  // sibling of the dialog root at each ancestor level. WorkbenchResourceDetail's
  // outer <dl> (readiness/rights/compatibility/need/adoption) and its Close
  // button are such siblings, so enlarging a skill/file/reference entry used to
  // make those decision-relevant fields unreachable — showing LESS than the
  // compact view. They must be rendered again inside the dialog itself.
  it('keeps decision-relevant fields reachable and non-inert once enlarged, for a blocked-rights/unverified-readiness skill', async () => {
    const resource = base({
      category: 'skill', readiness: 'unverified', rightsStatus: 'restricted',
      compatibility: { nativeFormat: 'html', targets: ['html'], state: 'unsupported', reason: 'Target runtime mismatch' },
      needDecision: 'required', needReason: 'Pending maintainer review',
      adoptionCapability: { available: false, reason: 'rights-blocked' },
      operationGrants: [{ operation: 'incorporation', state: 'blocked', reason: 'Rights restricted' }],
    });
    setup(resource);
    await screen.findByTestId('workbench-text-detail');
    // Sanity check that this scenario actually exercises the bug: the outer
    // Close button is a real sibling of the dialog root and does go inert.
    fireEvent.click(screen.getByRole('button', { name: 'Enlarge preview' }));
    expect(screen.getByRole('button', { name: 'Close details' })).toHaveAttribute('inert', '');
    const dialog = screen.getByRole('dialog');
    const decision = screen.getByTestId('workbench-text-detail-decision');
    expect(dialog.contains(decision)).toBe(true);
    expect(decision.closest('[inert]')).toBeNull();
    expect(decision).toHaveTextContent('unverified');
    expect(decision).toHaveTextContent('restricted');
    expect(decision).toHaveTextContent('unsupported');
    expect(decision).toHaveTextContent('Target runtime mismatch');
    expect(decision).toHaveTextContent('required');
    expect(decision).toHaveTextContent('Pending maintainer review');
    expect(decision).toHaveTextContent('rights-blocked');
    expect(decision).toHaveTextContent('Adoption unavailable');
    // The operation grant header is also truthful to its actual state now,
    // not a blanket "Permitted operations" regardless of what it describes.
    expect(screen.getByText('Blocked operations')).toBeTruthy();
    expect(screen.getByText('incorporation: blocked · Rights restricted')).toBeTruthy();
    expect(screen.queryByText('Permitted operations')).toBeNull();
  });
  // The enlarged decision section states Apply's capability the same way the
  // compact detail does: an offered Apply on an item without an acceptance
  // receipt is "unverified, apply allowed", never "Adoption unavailable".
  it('labels an offered Apply as unverified-but-allowed in the enlarged decision section, as the compact view does', async () => {
    const resource = base({
      category: 'skill', rightsStatus: 'permitted',
      adoptionCapability: { available: false, reason: 'acceptance-receipt-pending' },
      operationGrants: [{ operation: 'incorporation', state: 'permitted', reason: null }],
    });
    setup(resource);
    await screen.findByTestId('workbench-text-detail');
    fireEvent.click(screen.getByRole('button', { name: 'Enlarge preview' }));
    const decision = screen.getByTestId('workbench-text-detail-decision');
    expect(screen.getByRole('dialog').contains(decision)).toBe(true);
    expect(decision).toHaveTextContent('Adoption');
    expect(decision).toHaveTextContent('Unverified, apply allowed · acceptance receipt pending');
    expect(decision).not.toHaveTextContent('Adoption unavailable');
  });
});

describe('Workbench enlarge — decision details reachable for every preview kind', () => {
  // WARN: WorkbenchPreviewShell's expand effect inerts every DOM sibling of
  // the dialog root at each ancestor level. U1 previously fixed this only for
  // skill/file/reference, via WorkbenchTextDetail's own decision section —
  // html/component, image, and font previews still lost readiness/rights/
  // compatibility/need/adoption once enlarged. WorkbenchResourceDetail must
  // place the shared WorkbenchDecisionDetails inside the dialog for every kind.
  function decisionOverrides() {
    return {
      readiness: 'unverified' as const, rightsStatus: 'restricted' as const,
      compatibility: { nativeFormat: 'html', targets: ['html'], state: 'unsupported' as const, reason: 'Target runtime mismatch' },
      needDecision: 'required' as const, needReason: 'Pending maintainer review',
      adoptionCapability: { available: false as const, reason: 'rights-blocked' },
    };
  }
  function assertDecisionReachable(dialog: HTMLElement) {
    const decision = screen.getByTestId('workbench-text-detail-decision');
    expect(dialog.contains(decision)).toBe(true);
    expect(decision.closest('[inert]')).toBeNull();
    expect(decision).toHaveTextContent('unverified');
    expect(decision).toHaveTextContent('restricted');
    expect(decision).toHaveTextContent('unsupported');
    expect(decision).toHaveTextContent('Target runtime mismatch');
    expect(decision).toHaveTextContent('required');
    expect(decision).toHaveTextContent('Pending maintainer review');
    expect(decision).toHaveTextContent('rights-blocked');
  }
  it('keeps decision-relevant fields reachable and non-inert for an html/component preview once enlarged', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    const resource = base({
      category: 'component', ...decisionOverrides(),
      previewCapability: { available: true, kind: 'html', url: '/api/genui/catalog/x/preview', reason: null },
    });
    setup(resource);
    await screen.findByRole('button', { name: 'Enlarge preview' });
    fireEvent.click(screen.getByRole('button', { name: 'Enlarge preview' }));
    assertDecisionReachable(screen.getByRole('dialog'));
    expect(document.querySelector('iframe')).toBeTruthy();
  });
  it('keeps decision-relevant fields reachable and non-inert for an image preview once enlarged', async () => {
    const resource = base({
      category: 'image', ...decisionOverrides(),
      previewCapability: { available: true, kind: 'reference', url: '/api/library/photo.png', reason: null },
    });
    setup(resource);
    await screen.findByTestId('workbench-image-zoom');
    fireEvent.click(screen.getByRole('button', { name: 'Enlarge preview' }));
    assertDecisionReachable(screen.getByRole('dialog'));
    expect(document.querySelector('img')).toBeTruthy();
  });
  it('keeps decision-relevant fields reachable and non-inert for a font preview once enlarged', async () => {
    class MockFontFace {
      family: string; source: string;
      constructor(family: string, source: string) { this.family = family; this.source = source; }
      load(): Promise<this> { return Promise.resolve(this); }
    }
    vi.stubGlobal('FontFace', MockFontFace);
    Object.defineProperty(document, 'fonts', { value: { add: vi.fn(), delete: vi.fn() }, configurable: true });
    const resource = base({
      category: 'font', ...decisionOverrides(),
      previewCapability: { available: true, kind: 'reference', url: '/api/library/brand.woff2', reason: null },
    });
    setup(resource);
    await screen.findByTestId('workbench-font-specimen');
    fireEvent.click(screen.getByRole('button', { name: 'Enlarge preview' }));
    assertDecisionReachable(screen.getByRole('dialog'));
  });
});

describe('Workbench enlarge — truthful unavailable fallback', () => {
  const dedicated = new Set<string>(['image', 'font', 'skill', 'file', 'reference']);
  const fallbackCategories = RESOURCE_CATEGORIES.filter((category) => !dedicated.has(category));
  it('covers every remaining declared category', () => {
    expect(fallbackCategories.length).toBe(RESOURCE_CATEGORIES.length - dedicated.size);
  });
  it.each(fallbackCategories)('offers Enlarge with a truthful unavailable explanation for category %s', async (category) => {
    const resource = base({ category, previewCapability: { available: false, kind: 'none', reason: 'adapter-missing' } });
    setup(resource);
    expect(await screen.findByRole('button', { name: 'Enlarge preview' })).toBeTruthy();
    const panel = screen.getByTestId('workbench-preview-unavailable');
    expect(panel).toHaveTextContent('adapter-missing');
    expect(panel).toHaveTextContent('Source title');
    expect(panel.querySelector('[role="alert"]')).toBeTruthy();
  });
  // WARN: the caller's `onRefresh` (WorkbenchResourceSearch's shared `revision`
  // bump) nulls its whole `selected`/`response` state, which unmounts this very
  // detail panel. A per-resource preview retry must not do that: it refetches
  // just this resource and leaves the panel (and the caller's selection) alone.
  it('retries just this resource locally, keeping the panel open, instead of calling the caller-supplied refresh', async () => {
    const resource = base({ category: 'layout', previewCapability: { available: false, kind: 'none', reason: 'rights-blocked' } });
    const onRefresh = vi.fn();
    vi.mocked(getWorkbenchResource).mockResolvedValue({ resource, sourceStatus: { sourceId: resource.ref.sourceId, state: 'searched', reason: null, itemCount: 1, listingDigest: 'digest' } });
    render(<I18nProvider initial="en"><WorkbenchResourceDetail selected={resource} plugins={[]} onPickPlugin={vi.fn()} onClose={vi.fn()} onRefresh={onRefresh} /></I18nProvider>);
    await screen.findByTestId('workbench-preview-unavailable');
    expect(getWorkbenchResource).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRefresh).not.toHaveBeenCalled();
    await waitFor(() => expect(getWorkbenchResource).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId('workbench-resource-detail')).toBeTruthy();
    expect(screen.getByTestId('workbench-preview-unavailable')).toBeTruthy();
  });
});

describe('Workbench enlarge — retry through the real search parent', () => {
  function searchResponse(items: ResourceResult[]) {
    return parseResourceSearchResponse({
      results: items,
      sourceStatuses: [{ sourceId: 'sections', state: 'searched', reason: null, itemCount: items.length, listingDigest: 'digest' }],
      context: { requested: true, applied: false, reason: 'context-not-implemented' },
      contextRevision: null, nextCursor: null, indexDigest: 'digest', degradedReason: null,
    });
  }
  // The regression finding 4 describes: WorkbenchResourceSearch wires
  // WorkbenchResourceDetail's `onRefresh` to `() => setRevision(n => n + 1)`,
  // and the effect keyed on `revision` runs `setSelected(null)` before
  // re-searching — so clicking Retry on an unavailable preview used to close
  // the whole detail view and drop the user back to the bare result list.
  it('keeps the same resource selected and open after Retry, instead of closing back to the result list', async () => {
    const resource = base({ category: 'layout', refKey: 'layout-1', previewCapability: { available: false, kind: 'none', reason: 'rights-blocked' } });
    vi.mocked(searchWorkbenchResources).mockResolvedValue(searchResponse([resource]));
    vi.mocked(getWorkbenchResource).mockResolvedValue({ resource, sourceStatus: { sourceId: resource.ref.sourceId, state: 'searched', reason: null, itemCount: 1, listingDigest: 'digest' } });
    render(<I18nProvider initial="en"><WorkbenchResourceSearch plugins={[]} onPickPlugin={vi.fn()} /></I18nProvider>);
    fireEvent.click(await screen.findByRole('button', { name: /Sample resource/ }));
    await screen.findByTestId('workbench-preview-unavailable');
    expect(getWorkbenchResource).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    // The detail panel must never unmount — not even while the retried fetch
    // for this one resource is in flight (it is fine for its inner content to
    // briefly show its own loading state while refetching).
    expect(screen.getByTestId('workbench-resource-detail')).toBeTruthy();
    await waitFor(() => expect(getWorkbenchResource).toHaveBeenCalledTimes(2));
    expect(await screen.findByTestId('workbench-preview-unavailable')).toBeTruthy();
    expect(screen.getByTestId('workbench-resource-detail')).toBeTruthy();
  });
});

describe('V09 localized catalog journey', () => {
  it('English search, inspect and variant switching keep the original HTTP keys even with custom display labels', async () => {
    const html = base({ ref: { sourceType: 'library', sourceId: 'gsap', itemId: 'hero-lines-html', revisionOrDigest: 'sha256:1' }, refKey: 'hero-html', title: 'Hero line reveal (HTML)', category: 'motion' });
    const react = { ...html, ref: { ...html.ref, itemId: 'hero-lines-react' }, refKey: 'hero-react', title: 'Hero line reveal (React)' };
    const sourceStatus = { sourceId: 'gsap' as const, state: 'searched' as const, reason: null, itemCount: 2, listingDigest: 'digest' };
    const variants = [
      { refKey: html.refKey, title: html.title, label: 'Web document', current: true, previewAvailable: false, targetDependencies: [] },
      { refKey: react.refKey, title: react.title, label: 'React component', current: false, previewAvailable: false, targetDependencies: [] },
    ];
    vi.mocked(searchWorkbenchResources).mockResolvedValue(parseResourceSearchResponse({
      results: [html], nextCursor: null, degradedReason: null, contextRevision: null, indexDigest: 'digest',
      sourceStatuses: [sourceStatus], context: { requested: true, applied: false, reason: 'context-not-implemented' },
    }));
    vi.mocked(getWorkbenchResource).mockImplementation(async key => ({ resource: key === html.refKey ? html : react, sourceStatus, variants: variants.map(v => ({ ...v, current: v.refKey === key })) }));
    render(<I18nProvider initial="en"><WorkbenchResourceSearch plugins={[]} onPickPlugin={vi.fn()} /></I18nProvider>);
    fireEvent.click(await screen.findByRole('button', { name: 'Hero line reveal (HTML) · unverified' }));
    await screen.findByRole('heading', { name: 'Hero line reveal (HTML)' });
    expect(screen.getByTestId('workbench-resource-detail').getAttribute('aria-label')).toBe('Hero line reveal (HTML)');
    expect(getWorkbenchResource).toHaveBeenCalledWith('hero-html', undefined, undefined);
    const variant = screen.getByRole('radio', { name: 'React component' });
    expect(variant.getAttribute('title')).toBe('Hero line reveal (React)');
    fireEvent.click(variant);
    await screen.findByRole('heading', { name: 'Hero line reveal (React)' });
    expect(getWorkbenchResource).toHaveBeenLastCalledWith('hero-react', undefined, undefined);
  });
});
