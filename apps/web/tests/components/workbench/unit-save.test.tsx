// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseUnitSaveRequest, type ReusableUnitManifest, type UnitSavePlan } from '@mish/contracts';
import { I18nProvider } from '../../../src/i18n';
import { WorkbenchUnitSave } from '../../../src/components/workbench/WorkbenchUnitSave';

// AC-R14.3 UI: the user picks the entry and root, reviews files, the excluded
// captured asset and declared dependencies, declares rights, then saves
// through POST /api/workbench/units (the endpoint `od workbench unit save`
// uses). The UI never claims an install and never hides an exclusion.

const H = (c: string) => c.repeat(64);
function plan(paths: string[], overrides: Partial<UnitSavePlan> = {}): UnitSavePlan {
  const all = [
    { path: 'index.html', sha256: H('1'), bytes: 400, mediaType: 'text/html', role: 'entry' as const, included: true },
    { path: 'styles.css', sha256: H('2'), bytes: 100, mediaType: 'text/css', role: 'style' as const, included: true },
    { path: 'assets/shot.png', sha256: H('3'), bytes: 900, mediaType: 'image/png', role: 'asset' as const, included: false },
  ];
  const listed = all.filter(file => paths.includes(file.path));
  return {
    schema: 'reusable-unit-plan/1', format: 'html-css-js', entry: 'index.html', rootSelector: '#hero', rootFound: true,
    rootCandidates: ['body', '#hero', '#top'],
    files: listed,
    excludedFiles: listed.some(file => file.path === 'assets/shot.png') ? [{ path: 'assets/shot.png', sha256: H('3'), reason: 'captured-third-party' }] : [],
    missingReferences: all.map(file => file.path).filter(path => !paths.includes(path)),
    dependencies: [{ name: 'gsap', version: '3.12.5', license: 'unknown', required: true, source: 'remote-url', url: 'https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/gsap.min.js', referencedFrom: 'index.html' }],
    capabilities: ['script', 'animation'],
    rights: { status: 'unknown', basis: null, evidenceRefs: [], notices: [], files: [], declaredBy: 'none', declaredVia: null },
    operationRights: [],
    blockers: [],
    warnings: [],
    ...overrides,
  };
}
const unit = {
  schema: 'reusable-unit/1', unitId: 'unit_AAAAAAAAAAAAAAAAAAAA', revision: 1, name: 'Hero', kind: 'section', format: 'html-css-js', entry: 'index.html', rootSelector: '#hero',
  files: [{ path: 'index.html', assetId: 'obj', sha256: H('1'), mediaType: 'text/html', role: 'entry' }], assets: [], excludedFiles: [{ path: 'assets/shot.png', sha256: H('3'), reason: 'captured-third-party' }],
  dependencies: [], tokens: [], capabilities: [], compatibility: { targetKinds: ['prototype'], adapterVersion: 'html-artifact/v1', inlineAdapters: [] }, actions: [],
  provenance: { projectId: 'p1', projectSourceHashes: { 'index.html': H('1') }, sources: [] }, operationRights: [],
  rights: { status: 'redistributable', basis: 'user-owned', evidenceRefs: ['owner'], notices: [], files: [], declaredBy: 'user-request', declaredVia: 'web' },
  thumbnail: { source: 'rendered', assetId: 'thumb', sha256: H('4'), width: 640, height: 400 }, previewArtifactId: null, verificationBundleId: null, principalId: 'local-daemon', createdAt: '2026-10-08T10:00:00.000Z',
} as ReusableUnitManifest;

let calls: { url: string; init: RequestInit }[] = [];
beforeEach(() => {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input); calls.push({ url, init });
    if (url.startsWith('/api/projects/p1/files')) return new Response(JSON.stringify({ files: [{ name: 'index.html', path: 'index.html', type: 'file', kind: 'html', size: 1, mtime: 1 }, { name: 'notes.md', path: 'notes.md', type: 'file', kind: 'text', size: 1, mtime: 1 }] }), { status: 200 });
    if (url === '/api/workbench/units/plan') return new Response(JSON.stringify(plan(JSON.parse(String(init.body)).source.paths)), { status: 200 });
    if (url === '/api/workbench/units' && init.method === 'POST') return new Response(JSON.stringify(unit), { status: 201 });
    if (url === '/api/workbench/units') return new Response(JSON.stringify({ units: [] }), { status: 200 });
    return new Response('{}', { status: 404 });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const view = () => <I18nProvider initial="en"><WorkbenchUnitSave projectId="p1" /></I18nProvider>;

describe('WorkbenchUnitSave', () => {
  it('reviews and saves a selected immutable draft root with rights and scope, without reading project files', async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input); calls.push({ url, init });
      if (url === '/api/workbench/units/plan') return new Response(JSON.stringify(plan(['index.html', 'styles.css', 'assets/shot.png'], { rootSelector: '#hero', missingReferences: [] })), { status: 200 });
      if (url === '/api/workbench/units' && init.method === 'POST') return new Response(JSON.stringify(unit), { status: 201 });
      return new Response(JSON.stringify({ units: [] }), { status: 200 });
    });
    render(<I18nProvider initial="en"><WorkbenchUnitSave projectId="p1" captureId="cap_AAAAAAAAAAAAAAAAAAAA" draftSource={{ draftId: 'draft_AAAAAAAAAAAAAAAAAAAA', revision: 2 }} /></I18nProvider>);
    fireEvent.change(screen.getByLabelText('Root element'), { target: { value: '#hero' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review unit' }));
    const review = await screen.findByTestId('workbench-unit-plan');
    expect(review.textContent).toContain('immutable draft revision 2');
    expect(review.textContent).toContain('gsap 3.12.5');
    expect(review.textContent).toMatch(/captured.*excluded/);
    expect(calls.some(call => call.url.startsWith('/api/projects/'))).toBe(false);
    fireEvent.change(screen.getByLabelText('Unit name'), { target: { value: 'Draft hero' } });
    fireEvent.click(screen.getByLabelText('Owned source'));
    fireEvent.change(screen.getByLabelText('Evidence references (one per line)'), { target: { value: 'owned demo' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save unit' }));
    await screen.findByTestId('workbench-unit-saved');
    const saved = calls.find(call => call.url === '/api/workbench/units' && call.init.method === 'POST')!;
    expect(parseUnitSaveRequest(JSON.parse(String(saved.init.body)))).toMatchObject({ source: { kind: 'draft', draftId: 'draft_AAAAAAAAAAAAAAAAAAAA', revision: 2, rootSelector: '#hero' }, captureId: 'cap_AAAAAAAAAAAAAAAAAAAA', rightsDeclaration: { basis: 'user-owned', evidenceRefs: ['owned demo'] }, excludePaths: ['assets/shot.png'] });
    expect((saved.init.headers as Record<string, string>)['x-od-project-id']).toBe('p1');
    expect((saved.init.headers as Record<string, string>)['idempotency-key']).toBeTruthy();
    expect(calls.filter(call => call.url === '/api/workbench/units/plan')).toHaveLength(1);
  });

  it('collects the referenced files, shows the captured exclusion and dependency, and saves with the reviewed hashes and rights', async () => {
    render(view());
    fireEvent.change(await screen.findByLabelText('Entry HTML file'), { target: { value: 'index.html' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review unit' }));
    const review = await screen.findByTestId('workbench-unit-plan');
    // Referenced files were added to the selection automatically, then planned again.
    await waitFor(() => expect(within(review).getByText('styles.css')).toBeTruthy());
    expect(within(review).getByText(/assets\/shot\.png/).closest('li')?.textContent).toMatch(/captured.*excluded/i);
    expect(within(review).getByText(/gsap 3\.12\.5/)).toBeTruthy();
    expect(within(review).getByText(/not installed/i)).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Root element'), { target: { value: '#hero' } });
    fireEvent.change(screen.getByLabelText('Unit name'), { target: { value: 'Hero' } });
    fireEvent.change(screen.getByLabelText('Unit kind'), { target: { value: 'section' } });
    fireEvent.click(screen.getByLabelText('Owned source'));
    fireEvent.change(screen.getByLabelText('Evidence references (one per line)'), { target: { value: 'owner statement 2026-10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save unit' }));

    await waitFor(() => expect(calls.some(call => call.url === '/api/workbench/units' && call.init.method === 'POST')).toBe(true));
    const save = calls.find(call => call.url === '/api/workbench/units' && call.init.method === 'POST')!;
    expect((save.init.headers as Record<string, string>)['idempotency-key']).toBeTruthy();
    const body = parseUnitSaveRequest(JSON.parse(String(save.init.body)));
    expect(body).toMatchObject({
      kind: 'section', name: 'Hero', excludePaths: ['assets/shot.png'],
      rightsDeclaration: { basis: 'user-owned', evidenceRefs: ['owner statement 2026-10'], notices: [] },
      source: { kind: 'project', projectId: 'p1', entry: 'index.html', rootSelector: '#hero', expectedHashes: { 'index.html': H('1'), 'styles.css': H('2'), 'assets/shot.png': H('3') } },
    });
    const saved = await screen.findByTestId('workbench-unit-saved');
    expect(saved.querySelector('img')?.getAttribute('src')).toBe('/api/workbench/units/unit_AAAAAAAAAAAAAAAAAAAA/thumbnail');
    expect(saved.textContent).toMatch(/redistributable/);
  });

  it('maps every rights choice to a declaration and never sends a status', async () => {
    render(view());
    fireEvent.change(await screen.findByLabelText('Entry HTML file'), { target: { value: 'index.html' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review unit' }));
    await screen.findByTestId('workbench-unit-plan');
    fireEvent.change(screen.getByLabelText('Unit name'), { target: { value: 'Hero' } });
    fireEvent.click(screen.getByLabelText('Private adaptation'));
    fireEvent.change(screen.getByLabelText('Private-use statement'), { target: { value: 'I may adapt this privately' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save unit' }));
    await waitFor(() => expect(calls.some(call => call.url === '/api/workbench/units' && call.init.method === 'POST')).toBe(true));
    const body = JSON.parse(String(calls.find(call => call.url === '/api/workbench/units' && call.init.method === 'POST')!.init.body));
    expect(body.rightsDeclaration).toEqual({ basis: 'model-authored', evidenceRefs: [], notices: [], privateUseAttestation: 'I may adapt this privately' });
    expect(JSON.stringify(body)).not.toContain('"status"');
  });

  it('shows a typed refusal and keeps the form when the daemon blocks the save', async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input); calls.push({ url, init });
      if (url.startsWith('/api/projects/p1/files')) return new Response(JSON.stringify({ files: [{ name: 'index.html', path: 'index.html', type: 'file', kind: 'html', size: 1, mtime: 1 }] }), { status: 200 });
      if (url === '/api/workbench/units/plan') return new Response(JSON.stringify(plan(['index.html', 'styles.css', 'assets/shot.png'], { blockers: [{ code: 'unpinned-dependency', message: 'https://cdn.tailwindcss.com is not pinned', paths: ['index.html'] }] })), { status: 200 });
      if (url === '/api/workbench/units' && init.method === 'POST') return new Response(JSON.stringify({ error: { code: 'VALIDATION_FAILED', message: 'https://cdn.tailwindcss.com is not pinned', details: { reason: 'unpinned-dependency', paths: ['index.html'] } } }), { status: 422 });
      return new Response(JSON.stringify({ units: [] }), { status: 200 });
    });
    render(view());
    fireEvent.change(await screen.findByLabelText('Entry HTML file'), { target: { value: 'index.html' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review unit' }));
    expect((await screen.findByTestId('workbench-unit-plan')).textContent).toContain('is not pinned');
    expect((screen.getByRole('button', { name: 'Save unit' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
