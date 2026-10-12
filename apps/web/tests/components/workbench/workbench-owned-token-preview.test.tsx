// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ResourceResult } from '@open-design/contracts';
import { I18nProvider } from '../../../src/i18n';
import { en } from '../../../src/i18n/locales/en';

import { WorkbenchHtmlPreview } from '../../../src/components/workbench/WorkbenchHtmlPreview';
import { WorkbenchResourceDetail } from '../../../src/components/workbench/WorkbenchResourceDetail';
import { groupResourcesBySource } from '../../../src/components/workbench/resource-groups';
import { getWorkbenchResource } from '../../../src/providers/workbench';

vi.mock('../../../src/providers/workbench', async (original) => ({ ...await original<typeof import('../../../src/providers/workbench')>(), getWorkbenchResource: vi.fn() }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); vi.useRealTimers(); });

type Family = { sourceId: ResourceResult['ref']['sourceId']; itemId: string };
/** Every owned adapter family B5-2 adds that serves a preview document. */
const FAMILIES: Family[] = [
  { sourceId: 'project-tokens', itemId: 'p/color-palette' },
  { sourceId: 'brief-derived-tokens', itemId: 'p/type-scale' },
  { sourceId: 'design-systems', itemId: 'user:alpha/spacing-scale' },
];
const specimenUrl = (family: Family) => `/api/workbench/resources/${Buffer.from(family.itemId).toString('base64url')}/preview?projectId=p`;
function ownedItem(family: Family, overrides: Partial<ResourceResult> = {}): ResourceResult {
  return {
    ref: { sourceType: 'library', sourceId: family.sourceId, itemId: family.itemId, revisionOrDigest: 'sha256:digest' }, refKey: `ref-${family.sourceId}`,
    title: `${family.sourceId} cohort`, category: 'color-palette', readiness: 'unverified',
    compatibility: { nativeFormat: 'css-custom-properties', targets: [], state: 'unverified', reason: 'Per-item acceptance evidence is pending' },
    rightsStatus: 'unknown', fitReasons: ['Grounded in saved brief revision 1'],
    previewCapability: { available: true, kind: 'html', url: specimenUrl(family), reason: null },
    adoptionCapability: { available: false, reason: 'adapter-missing' }, sourceAttribution: { title: 'This project' },
    operationGrants: [], admissionStage: 'discovered', needDecision: 'not-assessed', needReason: 'Not assessed', ...overrides,
  };
}
function renderDetail(resource: ResourceResult) {
  vi.mocked(getWorkbenchResource).mockResolvedValue({ resource, sourceStatus: { sourceId: resource.ref.sourceId, state: 'searched', reason: null, itemCount: 1, listingDigest: 'digest' } });
  return render(<I18nProvider initial="en"><WorkbenchResourceDetail selected={resource} projectId="p" plugins={[]} onPickPlugin={vi.fn()} onClose={vi.fn()} onRefresh={vi.fn()} /></I18nProvider>);
}
const html = (body: string) => new Response(body, { headers: { 'content-type': 'text/html' } });

describe('AC-R07.3 owned-resource preview matrix: ready, failed, unavailable and slow per adapter family', () => {
  for (const family of FAMILIES) {
    it(`AC-R07.3 ${family.sourceId}: ready loads the specimen through the shared Enlarge shell`, async () => {
      const fetcher = vi.fn().mockResolvedValue(new Response('<ul data-token-cohort="color-palette"><li>--color-text</li></ul>', { headers: { 'content-type': 'text/html', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" } }));
      vi.stubGlobal('fetch', fetcher);
      const { container } = renderDetail(ownedItem(family));
      expect(await screen.findByRole('button', { name: 'Enlarge preview' })).toBeTruthy();
      await waitFor(() => expect(container.querySelector('iframe')?.getAttribute('srcdoc')).toContain('--color-text'));
      fireEvent.load(container.querySelector('iframe')!);
      expect(container.querySelector('[data-preview-state]')).toHaveAttribute('data-preview-state', 'ready');
      expect(container.querySelector('iframe')).toHaveAttribute('sandbox', 'allow-scripts');
      // The header's `sandbox` guards direct navigation only; the harness keeps its own iframe sandbox instead.
      const meta = new DOMParser().parseFromString(container.querySelector('iframe')!.getAttribute('srcdoc')!, 'text/html').head.querySelector('meta[http-equiv="Content-Security-Policy"]');
      expect(meta?.getAttribute('content')).toContain("default-src 'none'");
      expect(meta?.getAttribute('content')).not.toMatch(/sandbox/);
      expect(fetcher).toHaveBeenCalledWith(specimenUrl(family), expect.objectContaining({ redirect: 'error' }));
    });

    it(`AC-R07.3 ${family.sourceId}: a failed specimen never reports success and offers retry`, async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 500 })));
      render(<I18nProvider initial="en"><WorkbenchHtmlPreview title="Failed" url={specimenUrl(family)} /></I18nProvider>);
      expect(await screen.findByRole('alert')).toHaveTextContent('could not load');
      expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    });

    it(`AC-R07.3 ${family.sourceId}: an outdated specimen (409) says to refresh results and offers no futile Retry`, async () => {
      vi.useFakeTimers();
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 409 })));
      const { container } = render(<I18nProvider initial="en"><WorkbenchHtmlPreview title="Outdated" url={specimenUrl(family)} /></I18nProvider>);
      await act(async () => { await Promise.resolve(); });
      expect(screen.getByRole('alert')).toHaveTextContent('outdated');
      expect(screen.getByRole('alert')).toHaveTextContent('refresh');
      expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
      act(() => vi.advanceTimersByTime(8000));
      expect(container.querySelector('[data-preview-state]')).toHaveAttribute('data-preview-state', 'outdated');
    });

    it(`AC-R07.3 ${family.sourceId}: a revoked specimen (404) stays unavailable past the deadline`, async () => {
      vi.useFakeTimers();
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 404 })));
      render(<I18nProvider initial="en"><WorkbenchHtmlPreview title="Unavailable" url={specimenUrl(family)} /></I18nProvider>);
      await act(async () => { await Promise.resolve(); });
      expect(screen.getByRole('alert')).toHaveTextContent('unavailable');
      act(() => vi.advanceTimersByTime(8000));
      expect(screen.getByRole('alert')).toHaveTextContent('unavailable');
    });

    it(`AC-R07.3 ${family.sourceId}: a slow specimen times out, then a late legitimate load recovers`, async () => {
      vi.useFakeTimers();
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(html('<p>Late specimen</p>')));
      const { container } = render(<I18nProvider initial="en"><WorkbenchHtmlPreview title="Slow" url={specimenUrl(family)} /></I18nProvider>);
      await act(async () => { await Promise.resolve(); });
      act(() => vi.advanceTimersByTime(8000));
      expect(screen.getByRole('alert')).toBeTruthy();
      fireEvent.load(container.querySelector('iframe')!);
      expect(screen.queryByRole('alert')).toBeNull();
      expect(container.querySelector('[data-preview-state]')).toHaveAttribute('data-preview-state', 'ready');
    });
  }

  it('AC-R07.3: only the specimen route is admitted; other workbench routes never load as documents', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    for (const url of ['/api/workbench/resources/abc', '/api/workbench/resources/search', '/api/workbench/resources/a/b/preview', '/api/workbench/resources/a.b/preview', '/api/workbench/projects/p/context']) {
      const view = render(<I18nProvider initial="en"><WorkbenchHtmlPreview title="Refused" url={url} /></I18nProvider>);
      await waitFor(() => expect(view.container.querySelector('[data-preview-state]')).toHaveAttribute('data-preview-state', 'error'));
      view.unmount();
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('AC-R07.3: a cohort without a preview document enlarges the truthful unavailable panel with its reason and source', async () => {
    renderDetail(ownedItem(FAMILIES[0]!, { previewCapability: { available: false, kind: 'none', reason: 'tokens-css-unreadable' } }));
    expect(await screen.findByTestId('workbench-preview-unavailable')).toHaveTextContent('tokens-css-unreadable');
    expect(screen.getByTestId('workbench-preview-unavailable')).toHaveTextContent('This project');
    expect(screen.getByRole('button', { name: 'Enlarge preview' })).toBeTruthy();
  });

  it('AC-R07.1/R07.3 design-md: a reference-only DESIGN.md enlarges as readable detail naming its swatches', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    renderDetail(ownedItem({ sourceId: 'design-md', itemId: 'neutral-product' }, {
      ref: { sourceType: 'reference', sourceId: 'design-md', itemId: 'neutral-product', revisionOrDigest: 'sha256:d' },
      category: 'reference', readiness: 'reference-only', admissionStage: 'reference-only', needDecision: 'reference-only',
      fitReasons: ['Swatches named in DESIGN.md: #0b5f66, #ffffff', 'Reference-only: these swatches are guidance and do not count as an eligible project colour'],
      previewCapability: { available: false, kind: 'none', reason: 'reference-only-document' },
    }));
    expect(await screen.findByTestId('workbench-text-detail')).toHaveTextContent('#0b5f66');
    expect(screen.getByTestId('workbench-text-detail')).toHaveTextContent('Reference-only');
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('AC-R04.2 owned groups in workbench search', () => {
  it("AC-R04.2: each owned source gets its own translated group heading in English", () => {
    const groups = groupResourcesBySource([ownedItem(FAMILIES[0]!), ownedItem(FAMILIES[1]!), ownedItem({ sourceId: 'design-md', itemId: 'x' })]);
    expect(groups.map(group => group.named)).toEqual(['project-tokens', 'brief-derived-tokens', 'design-md']);
    for (const key of ['workbench.project-tokens', 'workbench.brief-derived-tokens', 'workbench.design-md'] as const) {
      expect(en[key]).toBeTruthy();


    }
  });
});
