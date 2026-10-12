// @vitest-environment jsdom
// AC-R08.5 in the canvas: a GSAP recipe's isolated preview loads through the
// existing sandboxed HTML adapter, and Apply targets the recipe's own format —
// an HTML artifact goes next to the project's HTML entry, a React unit next to
// `src/App.tsx` — with the entry editable before prepare. `od workbench
// recipe preview` and `od workbench adoption catalogue-prepare --entry` drive
// the same endpoints.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { approvedComponentFits } from '../../helpers/approved-component-fits';
import type { CatalogueAdoptionResponse, PreparedAdoptionPlan, ResourceResult } from '@mish/contracts';
import { I18nProvider } from '../../../src/i18n';
import { WorkbenchApplyAction } from '../../../src/components/workbench/WorkbenchApplyAction';
import { WorkbenchHtmlPreview } from '../../../src/components/workbench/WorkbenchHtmlPreview';
import { AdoptionRequestError, applyAdoptionPlan, deleteSavedCatalogueUnit, listSavedCatalogueUnits, prepareCatalogueAdoption, saveCatalogueUnit } from '../../../src/providers/workbench-adoption';

vi.mock('../../../src/providers/workbench-adoption', async (original) => ({
  ...await original<typeof import('../../../src/providers/workbench-adoption')>(),
  prepareCatalogueAdoption: vi.fn(), applyAdoptionPlan: vi.fn(), undoAdoptionOperation: vi.fn(),
  saveCatalogueUnit: vi.fn(), deleteSavedCatalogueUnit: vi.fn(), listSavedCatalogueUnits: vi.fn().mockResolvedValue([]),
}));
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); vi.mocked(listSavedCatalogueUnits).mockResolvedValue([]); });

let fixtures: Awaited<ReturnType<typeof approvedComponentFits>>;
beforeAll(async () => {
  fixtures = await approvedComponentFits('gsap');
  for (const target of ['html', 'react']) {
    expect(fixtures.fits.get(`section-entrance-${target}`)?.apply).toEqual({ allowed: true, blockers: [] });
  }
}, 120_000);
afterAll(async () => { await fixtures?.stop(); });

const recipe = (target: 'html' | 'react'): ResourceResult => ({
  ref: { sourceType: 'library', sourceId: 'gsap', itemId: `section-entrance-${target}`, revisionOrDigest: 'sha256:1' }, refKey: `ref-${target}`,
  title: 'Section entrance', category: 'motion', readiness: 'unverified',
  compatibility: { nativeFormat: target === 'html' ? 'html' : 'tsx', targets: [target], state: 'unverified', reason: target === 'html' ? 'html-artifact/v1' : 'react-source/v1' },
  rightsStatus: 'permitted', fitReasons: [],
  previewCapability: target === 'html' ? { available: true, kind: 'html', url: '/api/workbench/recipes/gsap/section-entrance-html/preview', reason: null } : { available: false, kind: 'none', reason: 'react-preview-adapter-pending' },
  adoptionCapability: { available: false, reason: 'acceptance-receipt-pending' }, sourceAttribution: { title: 'GSAP 3.15.0 · Section entrance' },
  operationGrants: [{ operation: 'incorporation', state: 'permitted', reason: null }], admissionStage: 'admitted',
  needDecision: 'required', needReason: 'Owner-confirmed recurring need',
  componentFit: fixtures.fits.get(`section-entrance-${target}`),
});
const prepared = (entry: string): CatalogueAdoptionResponse => ({ plan: { id: 'plan-1', digest: 'd'.repeat(64), projectId: 'p1' } as PreparedAdoptionPlan, catalogue: {
  refKey: 'ref-html', identity: { sourceId: 'gsap', itemId: 'section-entrance-html', title: 'Section entrance', packageName: 'gsap@3.15.0', sourceUrl: 'https://github.com/greensock/GSAP', licence: "GSAP Standard 'no charge' License" },
  files: [{ path: 'gsap-section-entrance.html', role: 'source' }, { path: 'NOTICE.gsap-section-entrance-html.md', role: 'notice' }, { path: entry, role: 'entry' }],
  notices: ['NOTICE.gsap-section-entrance-html.md'], dependencies: { satisfied: [] }, target: { adapter: 'html-artifact/v1', framework: 'none', reactMajor: null, typescript: false, styleRuntime: 'unknown', dependencyDigest: 'e'.repeat(64) },
} });
const view = (r: ResourceResult) => render(<I18nProvider initial="en"><WorkbenchApplyAction resource={r} projectId="p1" /></I18nProvider>);

describe('GSAP recipe preview', () => {
  it('loads the recipe preview route through the sandboxed srcDoc adapter, keeping its no-network CSP', async () => {
    const policy = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'";
    const fetcher = vi.fn().mockResolvedValue(new Response('<!doctype html><html><head></head><body data-od-gsap="section-entrance">Ready</body></html>', { headers: { 'content-type': 'text/html', 'content-security-policy': policy } }));
    vi.stubGlobal('fetch', fetcher);
    const { container } = render(<I18nProvider initial="en"><WorkbenchHtmlPreview title="Section entrance" url="/api/workbench/recipes/gsap/section-entrance-html/preview" /></I18nProvider>);
    await act(async () => { await Promise.resolve(); });
    expect(fetcher).toHaveBeenCalledWith('/api/workbench/recipes/gsap/section-entrance-html/preview', expect.objectContaining({ redirect: 'error' }));
    const srcDoc = container.querySelector('iframe')!.getAttribute('srcdoc')!;
    expect(srcDoc).toContain("connect-src 'none'");
    expect(container.querySelector('iframe')!.getAttribute('sandbox')).toBe('allow-scripts');
  });

  it('still refuses other workbench routes as preview documents', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    render(<I18nProvider initial="en"><WorkbenchHtmlPreview title="Other" url="/api/workbench/adoption/plans/x" /></I18nProvider>);
    expect(await screen.findByRole('alert')).toHaveTextContent('could not load');
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('GSAP recipe Apply targets the recipe format', () => {
  it('an HTML artifact defaults to index.html, and the entry can be edited before prepare', async () => {
    vi.mocked(prepareCatalogueAdoption).mockResolvedValue(prepared('site/index.html'));
    view(recipe('html'));
    const entry = screen.getByLabelText('Entry file') as HTMLInputElement;
    expect(entry.value).toBe('index.html');
    fireEvent.change(entry, { target: { value: 'site/index.html' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply to project' }));
    expect(await screen.findByText('gsap-section-entrance.html')).toBeTruthy();
    expect(prepareCatalogueAdoption).toHaveBeenCalledWith({ projectId: 'p1', refKey: 'ref-html', entryPath: 'site/index.html' }, undefined);
    expect(screen.getByText(/html-artifact\/v1/u)).toBeTruthy();
  });

  it('a React unit defaults to src/App.tsx and shows a typed target refusal with what was detected', async () => {
    vi.mocked(prepareCatalogueAdoption).mockRejectedValue(new AdoptionRequestError(422, 'VALIDATION_FAILED', 'This unit needs a React 17+ project; nothing was written', 'target-incompatible', {
      kind: 'adoption', reason: 'target-incompatible', adapter: 'react-source/v1', targetReason: 'target-not-react', detected: { framework: 'vue', reactMajor: null },
    }));
    view(recipe('react'));
    expect((screen.getByLabelText('Entry file') as HTMLInputElement).value).toBe('src/App.tsx');
    fireEvent.click(screen.getByRole('button', { name: 'Apply to project' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('This project is not a compatible target');
    expect(alert).toHaveTextContent('react-source/v1');
    expect(alert).toHaveTextContent('vue');
  });
});

describe('target refusal validation and saved-unit reuse (W2, W4)', () => {
  it('an unknown target reason is not presented as a typed target refusal', () => {
    const known = new AdoptionRequestError(422, 'VALIDATION_FAILED', 'm', 'target-incompatible', { adapter: 'react-source/v1', targetReason: 'typescript-missing', detected: { framework: 'react', reactMajor: 18 } });
    expect(known.targetRefusal).toMatchObject({ targetReason: 'typescript-missing' });
    const forged = new AdoptionRequestError(422, 'VALIDATION_FAILED', 'm', 'target-incompatible', { adapter: 'react-source/v1', targetReason: 'anything', detected: { framework: 'react', reactMajor: 18 } });
    expect(forged.targetRefusal).toBeNull();
    const badAdapter = new AdoptionRequestError(422, 'VALIDATION_FAILED', 'm', 'target-incompatible', { adapter: 'svelte/v1', targetReason: 'target-not-react', detected: { framework: 'svelte', reactMajor: null } });
    expect(badAdapter.targetRefusal).toBeNull();
  });

  it('saves the applied unit for reuse, and another project applies the saved unit through the same prepare endpoint', async () => {
    const applied = { operationId: 'apply-1', kind: 'apply' as const, planId: 'plan-1', projectId: 'p1', state: 'done' as const, stage: 'complete' as const, undoOf: null, undoneBy: null, reason: null, writes: [] };
    const savedUnit = { id: 'a'.repeat(64), refKey: 'ref-html', title: 'Section entrance (HTML)', target: 'html-artifact/v1' as const, sourceProjectId: 'p1', sourceOperationId: 'apply-1', files: [{ path: 'gsap-section-entrance.html', role: 'source' as const, sha256: 'b'.repeat(64), bytes: 10 }] };
    vi.mocked(prepareCatalogueAdoption).mockResolvedValue(prepared('index.html'));
    vi.mocked(applyAdoptionPlan).mockResolvedValue(applied);
    vi.mocked(saveCatalogueUnit).mockResolvedValue(savedUnit);
    view(recipe('html'));
    fireEvent.click(screen.getByRole('button', { name: 'Apply to project' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm apply' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Save unit for reuse' }));
    expect(await screen.findByText(/Saved for reuse/u)).toBeTruthy();
    expect(saveCatalogueUnit).toHaveBeenCalledWith({ projectId: 'p1', operationId: 'apply-1' }, undefined);
    cleanup();

    vi.mocked(listSavedCatalogueUnits).mockResolvedValue([savedUnit]);
    render(<I18nProvider initial="en"><WorkbenchApplyAction resource={recipe('html')} projectId="p2" /></I18nProvider>);
    fireEvent.click(await screen.findByRole('button', { name: 'Apply saved unit' }));
    await screen.findByText('gsap-section-entrance.html');
    expect(listSavedCatalogueUnits).toHaveBeenCalledWith('ref-html', undefined);
    expect(prepareCatalogueAdoption).toHaveBeenLastCalledWith({ projectId: 'p2', refKey: 'ref-html', entryPath: 'index.html', savedUnitId: savedUnit.id }, undefined);
  });

  it('Sol B5/6 WARN: Remove deletes a saved unit through the same endpoint as od and refreshes the list', async () => {
    const savedUnit = { id: 'c'.repeat(64), refKey: 'ref-html', title: 'Section entrance (HTML)', target: 'html-artifact/v1' as const, sourceProjectId: 'p1', sourceOperationId: 'apply-1', files: [{ path: 'gsap-section-entrance.html', role: 'source' as const, sha256: 'b'.repeat(64), bytes: 10 }] };
    vi.mocked(listSavedCatalogueUnits).mockResolvedValueOnce([savedUnit]).mockResolvedValue([]);
    vi.mocked(deleteSavedCatalogueUnit).mockResolvedValue(undefined);
    render(<I18nProvider initial="en"><WorkbenchApplyAction resource={recipe('html')} projectId="p2" /></I18nProvider>);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove saved unit' }));
    await act(async () => { await Promise.resolve(); });
    expect(deleteSavedCatalogueUnit).toHaveBeenCalledWith(savedUnit.id, undefined);
    expect(await screen.findByText('Apply to project')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Remove saved unit' })).toBeNull();
  });
});


describe('V09 catalog locale presentation', () => {
  it.each(['en'] as const)('renders new recipe metadata in %s while retaining the HTTP adoption identity', async locale => {
    const { localizeMotionRecipe } = await import('../../../src/components/workbench/motion-recipe-labels');
    const { WorkbenchTextDetail } = await import('../../../src/components/workbench/WorkbenchTextDetail');
    const { useT } = await import('../../../src/i18n');
    const original: ResourceResult = {
      ...recipe('html'), title: 'Hero line reveal (HTML)',
      ref: { ...recipe('html').ref, itemId: 'hero-lines-html' },
      fitReasons: ['Purpose: Reveal lines', 'Trigger: mount', 'Reduced motion: final headline', 'Cleanup: scoped', 'Plugins: none (GSAP core only)', 'Adapter: html-artifact/v1'],
    };
    let presented: ResourceResult | undefined;
    function CatalogDetail() {
      presented = localizeMotionRecipe(original, useT());
      return <WorkbenchTextDetail resource={presented} />;
    }
    render(<I18nProvider initial={locale}><CatalogDetail /></I18nProvider>);
    expect(screen.getByRole('heading', { name: locale === 'en' ? 'Hero line reveal (HTML)' : 'Aparición del titular por líneas (HTML)' })).toBeTruthy();
    expect(screen.getByText(locale === 'en' ? /Complete headline at rest/u : /Titular completo en reposo/u)).toBeTruthy();
    expect(screen.getByText(locale === 'en' ? /none \(GSAP core only\)/u : /none \(GSAP core only\)/u)).toBeTruthy();
    expect(presented!.ref).toBe(original.ref);
    expect(presented!.refKey).toBe(original.refKey);
    expect(presented!.previewCapability).toBe(original.previewCapability);
    expect(original.title).toBe('Hero line reveal (HTML)');
  });
});
