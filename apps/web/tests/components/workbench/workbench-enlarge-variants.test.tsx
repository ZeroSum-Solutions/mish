// @vitest-environment jsdom
// AC-R07 preamble: "Variant changes preserve selection context and disclose actual target
// dependencies." Where an item has variants, the Enlarge shell offers a labelled variant choice.
// Switching keeps the dialog open, the search selection, the project scope and the chosen width,
// shows the previous variant until the next one arrives, and says what the shown variant brings
// into the project.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ResourceDetailResponse, ResourceResult } from '@open-design/contracts';
import { I18nProvider } from '../../../src/i18n';
import { WorkbenchResourceDetail } from '../../../src/components/workbench/WorkbenchResourceDetail';
import { getWorkbenchResource } from '../../../src/providers/workbench';

vi.mock('../../../src/providers/workbench', async (original) => ({
  ...await original<typeof import('../../../src/providers/workbench')>(),
  getWorkbenchResource: vi.fn(),
}));

afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

const status = { sourceId: 'gsap' as const, state: 'searched' as const, reason: null, itemCount: 2, listingDigest: 'digest' };
function item(refKey: string, overrides: Partial<ResourceResult>): ResourceResult {
  return {
    ref: { sourceType: 'library', sourceId: 'gsap', itemId: refKey, revisionOrDigest: `sha256:${refKey}` },
    refKey, title: refKey, category: 'motion', readiness: 'unverified',
    compatibility: { nativeFormat: 'html', targets: ['html'], state: 'unverified', reason: null },
    rightsStatus: 'permitted', fitReasons: [],
    previewCapability: { available: false, kind: 'none', reason: 'react-preview-adapter-pending' },
    adoptionCapability: { available: false, reason: 'acceptance-receipt-pending' },
    sourceAttribution: { title: 'GSAP' }, operationGrants: [], admissionStage: 'admitted', needDecision: 'required', needReason: 'Owner-confirmed',
    variantGroup: 'gsap/section-entrance', ...overrides,
  };
}
const html = item('html', { title: 'Section entrance (HTML)', variantLabel: 'HTML', previewCapability: { available: true, kind: 'html', url: '/api/workbench/recipes/gsap/section-entrance-html/preview', reason: null }, targetDependencies: [{ name: 'gsap', range: '3.15.0', scope: 'bundled' }] });
const react = item('react', { title: 'Section entrance (React)', variantLabel: 'React', compatibility: { nativeFormat: 'tsx', targets: ['react'], state: 'unverified', reason: null }, targetDependencies: [{ name: 'react', range: '>=17', scope: 'project' }, { name: '@gsap/react', range: '^2.1.2', scope: 'project' }] });
const variants = (current: string): ResourceDetailResponse['variants'] => [html, react].map((v) => ({ refKey: v.refKey, title: v.title, label: v.variantLabel!, current: v.refKey === current, previewAvailable: v.previewCapability.available, targetDependencies: v.targetDependencies! }));
const detailFor = (resource: ResourceResult): ResourceDetailResponse => ({ resource, sourceStatus: status, variants: variants(resource.refKey) });

async function setup(responses: Record<string, () => Promise<ResourceDetailResponse>>) {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('<!doctype html><html><head></head><body><button>Play</button></body></html>', { headers: { 'content-type': 'text/html' } }))));
  vi.mocked(getWorkbenchResource).mockImplementation((key) => responses[key]?.() ?? Promise.reject(new Error('unknown')));
  const onClose = vi.fn();
  render(<I18nProvider initial="en"><WorkbenchResourceDetail selected={html} projectId="p1" plugins={[]} onPickPlugin={vi.fn()} onClose={onClose} onRefresh={vi.fn()} /></I18nProvider>);
  await screen.findByRole('button', { name: 'Enlarge preview' });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  return { onClose };
}

describe('Enlarge variant control', () => {
  it('offers a labelled choice with the inspected variant selected and discloses its dependencies', async () => {
    await setup({ html: () => Promise.resolve(detailFor(html)) });
    const group = screen.getByRole('radiogroup', { name: 'Variant' });
    expect(within(group).getByRole('radio', { name: 'HTML' }).getAttribute('aria-checked')).toBe('true');
    expect(within(group).getByRole('radio', { name: 'React' }).getAttribute('aria-checked')).toBe('false');
    const dependencies = screen.getByTestId('workbench-target-dependencies');
    expect(dependencies).toHaveTextContent('Target dependencies');
    expect(dependencies).toHaveTextContent('gsap 3.15.0');
    expect(dependencies).toHaveTextContent('bundled with the unit');
  });

  it('switches inside the open dialog, keeping selection, project scope, focus and width, and shows the next variant only when it arrives', async () => {
    let arrive!: (value: ResourceDetailResponse) => void;
    const reactDetail = new Promise<ResourceDetailResponse>((resolve) => { arrive = resolve; });
    const { onClose } = await setup({ html: () => Promise.resolve(detailFor(html)), react: () => reactDetail });
    fireEvent.click(screen.getByRole('button', { name: 'Enlarge preview' }));
    fireEvent.click(within(screen.getByRole('group', { name: 'Viewport width' })).getByRole('button', { name: '375 px' }));
    const reactRadio = within(screen.getByRole('radiogroup', { name: 'Variant' })).getByRole('radio', { name: 'React' });
    reactRadio.focus();
    fireEvent.click(reactRadio);
    expect(getWorkbenchResource).toHaveBeenLastCalledWith('react', 'p1', undefined);
    // Still showing the HTML variant while React loads.
    expect(screen.getByRole('dialog', { name: 'Section entrance (HTML)' })).toBeTruthy();
    expect(document.querySelector('iframe')).toBeTruthy();
    expect(screen.getByText('Loading variant…')).toBeTruthy();
    await act(async () => { arrive(detailFor(react)); await Promise.resolve(); });
    const dialog = screen.getByRole('dialog', { name: 'Section entrance (React)' });
    expect(within(dialog).getByTestId('workbench-preview-unavailable')).toHaveTextContent('react-preview-adapter-pending');
    expect(within(dialog).getByRole('radio', { name: 'React' }).getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(within(dialog).getByRole('radio', { name: 'React' }));
    const dependencies = within(dialog).getByTestId('workbench-target-dependencies');
    expect(dependencies).toHaveTextContent('react >=17');
    expect(dependencies).toHaveTextContent('@gsap/react ^2.1.2');
    expect(dependencies).toHaveTextContent('project dependency');
    expect(onClose).not.toHaveBeenCalled();
    // Back to HTML: the chosen width is still in force.
    fireEvent.click(within(dialog).getByRole('radio', { name: 'HTML' }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(within(screen.getByRole('group', { name: 'Viewport width' })).getByRole('button', { name: '375 px' }).getAttribute('aria-pressed')).toBe('true');
    // Escape still restores focus to Enlarge.
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Enlarge preview' }));
  });

  it('keeps the shown variant and says so when the next one cannot load', async () => {
    await setup({ html: () => Promise.resolve(detailFor(html)), react: () => Promise.reject(new Error('gone')) });
    fireEvent.click(screen.getByRole('button', { name: 'Enlarge preview' }));
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Variant' })).getByRole('radio', { name: 'React' }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(screen.getByRole('dialog', { name: 'Section entrance (HTML)' })).toBeTruthy();
    expect(screen.getByText(/This variant could not load/)).toBeTruthy();
    expect(within(screen.getByRole('radiogroup', { name: 'Variant' })).getByRole('radio', { name: 'HTML' }).getAttribute('aria-checked')).toBe('true');
  });

  it('uses a labelled select when a group has more than five variants', async () => {
    const many = Array.from({ length: 7 }, (_, index) => item(`b${index + 1}`, { title: `Charts ${index + 1}`, variantLabel: String(index + 1), previewCapability: { available: true, kind: 'html', url: `/api/sections/b${index + 1}/preview`, reason: null, adapter: 'compiled-html-section' }, targetDependencies: [{ name: 'tailwindcss', range: '4.3.3', scope: 'compiled' }] }));
    const detail = (resource: ResourceResult): ResourceDetailResponse => ({ resource, sourceStatus: status, variants: many.map((v) => ({ refKey: v.refKey, title: v.title, label: v.variantLabel!, current: v.refKey === resource.refKey, previewAvailable: true, targetDependencies: v.targetDependencies! })) });
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('<p>Block</p>', { headers: { 'content-type': 'text/html' } }))));
    vi.mocked(getWorkbenchResource).mockImplementation((key) => Promise.resolve(detail(many.find((v) => v.refKey === key)!)));
    render(<I18nProvider initial="en"><WorkbenchResourceDetail selected={many[0]!} plugins={[]} onPickPlugin={vi.fn()} onClose={vi.fn()} onRefresh={vi.fn()} /></I18nProvider>);
    const select = await screen.findByRole('combobox', { name: 'Variant' });
    expect((select as HTMLSelectElement).value).toBe('b1');
    expect(screen.getByTestId('workbench-target-dependencies')).toHaveTextContent('compiled in');
    fireEvent.change(select, { target: { value: 'b4' } });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(getWorkbenchResource).toHaveBeenLastCalledWith('b4', undefined, undefined);
    expect((screen.getByRole('combobox', { name: 'Variant' }) as HTMLSelectElement).value).toBe('b4');
  });
});
