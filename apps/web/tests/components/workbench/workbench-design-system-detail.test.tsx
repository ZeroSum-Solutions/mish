// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ResourceResult } from '@open-design/contracts';
import { I18nProvider } from '../../../src/i18n';
import { WorkbenchHtmlPreview } from '../../../src/components/workbench/WorkbenchHtmlPreview';
import { WorkbenchResourceDetail } from '../../../src/components/workbench/WorkbenchResourceDetail';
import { getWorkbenchResource } from '../../../src/providers/workbench';

vi.mock('../../../src/providers/workbench', async (original) => ({ ...await original<typeof import('../../../src/providers/workbench')>(), getWorkbenchResource: vi.fn() }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

function designSystemItem(category: ResourceResult['category'], previewCapability: ResourceResult['previewCapability']): ResourceResult {
  return {
    ref: { sourceType: 'library', sourceId: 'design-systems', itemId: `neutral-product/${category}`, revisionOrDigest: 'sha256:digest' }, refKey: `ref-${category}`,
    title: `Neutral Product ${category}`, category, readiness: 'unverified',
    compatibility: { nativeFormat: 'css-custom-properties', targets: [], state: 'unverified', reason: 'Per-item acceptance evidence is pending' },
    rightsStatus: 'permitted', fitReasons: [], previewCapability, adoptionCapability: { available: false, reason: 'adapter-missing' },
    sourceAttribution: { title: 'Neutral Product · bundled' }, operationGrants: [], admissionStage: 'discovered', needDecision: 'not-assessed', needReason: 'Not assessed',
  };
}
function renderDetail(resource: ResourceResult) {
  vi.mocked(getWorkbenchResource).mockResolvedValue({ resource, sourceStatus: { sourceId: 'design-systems', state: 'searched', reason: null, itemCount: 5, listingDigest: 'digest' } });
  return render(<I18nProvider initial="en"><WorkbenchResourceDetail selected={resource} plugins={[]} onPickPlugin={vi.fn()} onClose={vi.fn()} onRefresh={vi.fn()} /></I18nProvider>);
}

describe('Workbench design-system inspect', () => {
  it('renders a palette through its package preview page inside the shared Enlarge shell', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('<main>Palette swatches</main>', { headers: { 'content-type': 'text/html' } }));
    vi.stubGlobal('fetch', fetcher);
    const { container } = renderDetail(designSystemItem('color-palette', { available: true, kind: 'html', url: '/api/design-systems/neutral-product/static/preview/colors.html', reason: null }));
    expect(await screen.findByRole('button', { name: 'Enlarge preview' })).toBeTruthy();
    await waitFor(() => expect(container.querySelector('iframe')?.getAttribute('srcdoc')).toContain('Palette swatches'));
    expect(fetcher).toHaveBeenCalledWith('/api/design-systems/neutral-product/static/preview/colors.html', expect.objectContaining({ redirect: 'error' }));
  });

  it('renders the design system itself through its package preview route', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('<h1>Neutral Product</h1>', { headers: { 'content-type': 'text/html' } }));
    vi.stubGlobal('fetch', fetcher);
    const { container } = render(<I18nProvider initial="en"><WorkbenchHtmlPreview title="Neutral Product" url="/api/design-systems/neutral-product/preview" /></I18nProvider>);
    await waitFor(() => expect(container.querySelector('iframe')?.getAttribute('srcdoc')).toContain('Neutral Product'));
  });

  it('refuses other design-system routes as preview documents', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    for (const url of ['/api/design-systems/neutral-product/archive', '/api/design-systems/neutral-product/file?path=DESIGN.md', '/api/design-systems/a/b/preview', '/api/design-systems/neutral-product/static?path=preview%2Fcolors.html']) {
      const view = render(<I18nProvider initial="en"><WorkbenchHtmlPreview title="Refused" url={url} /></I18nProvider>);
      await waitFor(() => expect(view.container.querySelector('[data-preview-state]')).toHaveAttribute('data-preview-state', 'error'));
      view.unmount();
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('keeps motion without a declared preview page on the truthful unavailable panel', async () => {
    renderDetail(designSystemItem('motion', { available: false, kind: 'none', reason: 'no-declared-preview-page' }));
    expect(await screen.findByTestId('workbench-preview-unavailable')).toHaveTextContent('no-declared-preview-page');
    expect(screen.getByRole('button', { name: 'Enlarge preview' })).toBeTruthy();
  });
});
