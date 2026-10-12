// @vitest-environment jsdom
// Sol r07 BLOCK, web half: a kit item that inspect classifies as `styled-components` reaches the
// Enlarge shell with that adapter, so the open dialog reports ready only after the runtime has
// injected styles — a document that merely loads stays "Loading", and a styles-missing report
// fails closed. The daemon half is `apps/daemon/tests/workbench/resources-styled-components.test.ts`.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ResourceResult } from '@mish/contracts';
import { I18nProvider } from '../../../src/i18n';
import { WorkbenchResourceDetail } from '../../../src/components/workbench/WorkbenchResourceDetail';
import { getWorkbenchResource } from '../../../src/providers/workbench';

vi.mock('../../../src/providers/workbench', async (original) => ({
  ...await original<typeof import('../../../src/providers/workbench')>(),
  getWorkbenchResource: vi.fn(),
}));
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

const kit: ResourceResult = {
  ref: { sourceType: 'library', sourceId: 'react95', itemId: 'window', revisionOrDigest: 'sha256:window' },
  refKey: 'window', title: 'Kit window', category: 'component', readiness: 'unverified',
  compatibility: { nativeFormat: 'tsx', targets: ['react'], state: 'unverified', reason: null },
  rightsStatus: 'permitted', fitReasons: [],
  previewCapability: { available: true, kind: 'html', url: '/api/workbench/resources/window/preview', reason: null, adapter: 'styled-components' },
  adoptionCapability: { available: false, reason: 'acceptance-receipt-pending' },
  sourceAttribution: { title: 'Fixture kit' }, operationGrants: [], admissionStage: 'discovered', needDecision: 'not-assessed', needReason: 'Fixture',
  targetDependencies: [{ name: 'styled-components', range: '^6.1.0', scope: 'project' }],
};

describe('a styled-components kit item in Enlarge', () => {
  it('stays loading on load alone, becomes ready on the runtime report, and discloses the dependency', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('<!doctype html><html><head></head><body><div id="root"></div></body></html>', { headers: { 'content-type': 'text/html' } }))));
    vi.mocked(getWorkbenchResource).mockResolvedValue({ resource: kit, sourceStatus: { sourceId: 'react95', state: 'searched', reason: null, itemCount: 1, listingDigest: 'd' } });
    render(<I18nProvider initial="en"><WorkbenchResourceDetail selected={kit} plugins={[]} onPickPlugin={vi.fn()} onClose={vi.fn()} onRefresh={vi.fn()} /></I18nProvider>);
    fireEvent.click(await screen.findByRole('button', { name: 'Enlarge preview' }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const dialog = screen.getByRole('dialog', { name: 'Kit window' });
    const frame = dialog.querySelector('iframe')!;
    const root = dialog.querySelector('[data-preview-adapter]')!;
    expect(root.getAttribute('data-preview-adapter')).toBe('styled-components');
    expect(frame.getAttribute('srcdoc')).toContain('data-od-workbench-adapter="styled-components"');
    fireEvent.load(frame);
    expect(root.getAttribute('data-preview-state')).toBe('loading');
    fireEvent(window, new MessageEvent('message', { data: { type: 'od:workbench-adapter', adapter: 'styled-components', state: 'ready' }, source: frame.contentWindow }));
    expect(root.getAttribute('data-preview-state')).toBe('ready');
    expect(within(dialog).getByTestId('workbench-target-dependencies')).toHaveTextContent('styled-components ^6.1.0');
  });
});
