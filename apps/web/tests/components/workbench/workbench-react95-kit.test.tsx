// @vitest-environment jsdom
// AC-R17.2/AC-R17.4 in the canvas: a React95 template's enlarged preview loads
// through the existing sandboxed srcDoc adapter from the kit route, keeping its
// no-network policy. The kit's theme switch and styled-components styles live
// inside that sandboxed document; the host document gains no style. Apply
// targets the template's React format through the same catalogue endpoint as
// `od workbench adoption catalogue-prepare`.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { approvedComponentFits } from '../../helpers/approved-component-fits';
import type { ResourceResult } from '@mish/contracts';
import { I18nProvider } from '../../../src/i18n';
import { WorkbenchApplyAction } from '../../../src/components/workbench/WorkbenchApplyAction';
import { WorkbenchHtmlPreview } from '../../../src/components/workbench/WorkbenchHtmlPreview';
import { AdoptionRequestError, listSavedCatalogueUnits, prepareCatalogueAdoption } from '../../../src/providers/workbench-adoption';

vi.mock('../../../src/providers/workbench-adoption', async (original) => ({
  ...await original<typeof import('../../../src/providers/workbench-adoption')>(),
  prepareCatalogueAdoption: vi.fn(), applyAdoptionPlan: vi.fn(), undoAdoptionOperation: vi.fn(),
  saveCatalogueUnit: vi.fn(), deleteSavedCatalogueUnit: vi.fn(), listSavedCatalogueUnits: vi.fn().mockResolvedValue([]),
}));
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); vi.mocked(listSavedCatalogueUnits).mockResolvedValue([]); });

let fixtures: Awaited<ReturnType<typeof approvedComponentFits>>;
beforeAll(async () => {
  fixtures = await approvedComponentFits('react95');
  template.componentFit = fixtures.fits.get('template-window-app');
  expect(template.componentFit?.apply).toEqual({ allowed: true, blockers: [] });
}, 120_000);
afterAll(async () => { await fixtures?.stop(); });

const URL_PATH = '/api/workbench/kits/react95/template-window-app/preview';
const template: ResourceResult = {
  ref: { sourceType: 'library', sourceId: 'react95', itemId: 'template-window-app', revisionOrDigest: 'sha256:1' }, refKey: 'ref-r95',
  title: 'React95 · Windows95 application window', category: 'template', readiness: 'usable',
  acceptanceEvidence: { sourceDigest: 'sha256:1', receiptId: 'g02-react95-receipt:x', passed: true },
  compatibility: { nativeFormat: 'tsx', targets: ['react'], state: 'compatible', reason: 'react-source/v1' },
  rightsStatus: 'permitted', fitReasons: [], styleClass: 'retro', styleTags: ['windows95'],
  previewCapability: { available: true, kind: 'html', url: URL_PATH, reason: null },
  adoptionCapability: { available: true, reason: null }, sourceAttribution: { title: 'React95 (react95-io/React95@871d533)' },
  operationGrants: [{ operation: 'incorporation', state: 'permitted', reason: null }], admissionStage: 'admitted',
  needDecision: 'required', needReason: 'Owner-required opt-in Windows95 kit',
};

describe('React95 kit preview', () => {
  it('loads the kit preview route in the sandboxed srcDoc frame; its theme and styles stay inside the frame', async () => {
    const policy = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'";
    const body = '<!doctype html><html><head><style data-styled="active">.a{background:#008080}</style></head><body><fieldset class="od-preview-themes"></fieldset><div data-od-react95="window-app">Ready</div></body></html>';
    const fetcher = vi.fn().mockResolvedValue(new Response(body, { headers: { 'content-type': 'text/html', 'content-security-policy': policy } }));
    vi.stubGlobal('fetch', fetcher);
    const hostStyles = document.head.querySelectorAll('style').length;
    const { container } = render(<I18nProvider initial="en"><WorkbenchHtmlPreview title={template.title} url={URL_PATH} /></I18nProvider>);
    await act(async () => { await Promise.resolve(); });
    expect(fetcher).toHaveBeenCalledWith(URL_PATH, expect.objectContaining({ redirect: 'error' }));
    const frame = container.querySelector('iframe')!;
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    const srcDoc = frame.getAttribute('srcdoc')!;
    expect(srcDoc).toContain("connect-src 'none'");
    expect(srcDoc).toContain('od-preview-themes');
    // Host chrome is untouched: no styled-components or kit style reaches the host document.
    expect(document.head.querySelectorAll('style').length).toBe(hostStyles);
    expect(document.querySelector('style[data-styled]')).toBeNull();
  });

  it('refuses other kit routes as preview documents', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    render(<I18nProvider initial="en"><WorkbenchHtmlPreview title="Other" url="/api/workbench/kits/react95/template-window-app/files" /></I18nProvider>);
    expect(await screen.findByRole('alert')).toHaveTextContent('could not load');
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('React95 template Apply', () => {
  it('defaults to src/App.tsx, prepares through the catalogue endpoint and shows a receipt refusal for an uncovered React major', async () => {
    vi.mocked(prepareCatalogueAdoption).mockRejectedValue(new AdoptionRequestError(422, 'VALIDATION_FAILED', 'No validated production receipt covers React 19 yet (covered: React 18); nothing was written', 'target-receipt-pending', {
      kind: 'adoption', reason: 'target-receipt-pending', adapter: 'react-source/v1', receiptReason: 'react-major-uncovered', reactMajor: 19, coveredReactMajors: [18],
    }));
    render(<I18nProvider initial="en"><WorkbenchApplyAction resource={template} projectId="p1" /></I18nProvider>);
    expect((screen.getByLabelText('Entry file') as HTMLInputElement).value).toBe('src/App.tsx');
    fireEvent.click(screen.getByRole('button', { name: 'Apply to project' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('React 18');
    expect(prepareCatalogueAdoption).toHaveBeenCalledWith({ projectId: 'p1', refKey: 'ref-r95', entryPath: 'src/App.tsx' }, undefined);
  });
});
