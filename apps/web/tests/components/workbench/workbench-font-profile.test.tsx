// @vitest-environment jsdom
// AC-R11.1–R11.3 in the canvas: the Enlarge shell's font view loads the admitted
// local files with their real descriptors, checks the user's own text through
// the same endpoint `od workbench font-check` uses, and shows per-spine fit,
// counter-fit and rights without inventing a preview for metadata-only fonts.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FontCheckResponse, FontProfile, ResourceResult } from '@open-design/contracts';
import { I18nProvider } from '../../../src/i18n';
import { WorkbenchResourceDetail } from '../../../src/components/workbench/WorkbenchResourceDetail';
import { getWorkbenchResource, postWorkbenchFontCheck } from '../../../src/providers/workbench';

vi.mock('../../../src/providers/workbench', async (original) => ({
  ...await original<typeof import('../../../src/providers/workbench')>(),
  getWorkbenchResource: vi.fn(),
  postWorkbenchFontCheck: vi.fn(),
}));
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

const sha = (n: number) => String(n).repeat(64).slice(0, 64);
const licence: FontProfile['licence'] = { type: 'OFL-1.1', recognised: true, attribution: 'Copyright 2020 The Fraunces Project Authors', url: 'https://openfontlicense.org', upstreamLicenceSha256: sha(9), reservedFontNames: [], commercialUse: 'permitted', webEmbedding: 'permitted', redistribution: 'permitted', modification: 'Use upstream-provided subsets.' };
function profile(overrides: Partial<FontProfile> = {}): FontProfile {
  return {
    schema: 'font-profile/1', family: 'Fraunces', category: 'serif', weights: [400, 900], styles: ['normal', 'italic'], subsets: ['latin', 'latin-ext'], defaultSubset: 'latin',
    axes: [{ tag: 'wght', min: 100, max: 900, default: 400 }], licence,
    source: { metadata: 'fontsource/font-files', commit: 'c3f4e3e5a664d2c3002e800050ce809a790d7281', packageName: '@fontsource/fraunces', packageVersion: '5.3.0', upstreamVersion: 'v38', lastModified: '2026-01-01', metadataSha256: sha(8) },
    spineFit: [
      { spine: 'CS', fit: 'Soft old-style display gives newsletters a recognisable masthead.', counterFit: 'Its quirks distract at body sizes.' },
      { spine: 'LM', fit: 'Warm headlines suit community courses.', counterFit: 'Heavy weights crowd small quiz labels.' },
    ],
    localFiles: [
      { sha256: sha(1), bytes: 100, format: 'woff2', subset: 'latin', unicodeRange: 'U+0000-00FF', style: 'normal', weight: { min: 900, max: 900 }, axes: [], state: 'available', reason: null, url: `/api/workbench/fonts/files/${sha(1)}`, notice: { sha256: sha(3), state: 'available', url: `/api/workbench/fonts/notices/${sha(3)}` }, provenance: 'p' },
      { sha256: sha(2), bytes: 100, format: 'woff2', subset: 'latin', unicodeRange: 'U+0000-00FF', style: 'italic', weight: { min: 900, max: 900 }, axes: [], state: 'available', reason: null, url: `/api/workbench/fonts/files/${sha(2)}`, notice: { sha256: sha(3), state: 'available', url: `/api/workbench/fonts/notices/${sha(3)}` }, provenance: 'p' },
    ],
    ...overrides,
  };
}
function font(overrides: Partial<ResourceResult> = {}, fontProfile = profile()): ResourceResult {
  const firstUrl = fontProfile.localFiles.find(file => file.state === 'available')?.url;
  return {
    ref: { sourceType: 'font', sourceId: 'fonts', itemId: 'fraunces', revisionOrDigest: 'sha256:x' }, refKey: 'font-key', title: 'Fraunces', category: 'font',
    readiness: 'unverified', compatibility: { nativeFormat: 'woff2', targets: ['html', 'css'], state: 'unverified', reason: null }, rightsStatus: 'permitted', fitReasons: [],
    previewCapability: firstUrl ? { available: true, kind: 'reference', url: firstUrl, reason: null } : { available: false, kind: 'none', reason: 'no-local-font-file' },
    adoptionCapability: { available: false, reason: 'adapter-missing' }, sourceAttribution: { title: 'Fraunces · @fontsource/fraunces@5.3.0' },
    operationGrants: [], admissionStage: 'discovered', needDecision: 'not-assessed', needReason: 'Not assessed', spineAffinities: ['CS', 'LM'], fontProfile, ...overrides,
  };
}
function stubFontFace(behavior: 'resolve' | 'reject' = 'resolve') {
  const created: { family: string; source: string; descriptors?: FontFaceDescriptors }[] = [];
  class MockFontFace {
    constructor(public family: string, public source: string, public descriptors?: FontFaceDescriptors) { created.push({ family, source, descriptors }); }
    load() { return behavior === 'reject' ? Promise.reject(new Error('tampered')) : Promise.resolve(this); }
  }
  vi.stubGlobal('FontFace', MockFontFace);
  Object.defineProperty(document, 'fonts', { value: { add: vi.fn(), delete: vi.fn() }, configurable: true });
  return created;
}
function checkResult(overrides: Partial<FontCheckResponse> = {}): FontCheckResponse {
  return {
    schema: 'font-check/1', ref: { sourceType: 'font', sourceId: 'fonts', itemId: 'fraunces', revisionOrDigest: 'sha256:x' }, refKey: 'font-key', family: 'Fraunces',
    glyphs: { checked: 2, declared: { missing: [{ char: 'Ж', codepoint: 'U+0416' }], missingCount: 1 }, local: { state: 'checked', missing: [{ char: 'Ж', codepoint: 'U+0416' }], missingCount: 1 } },
    weights: [{ weight: 900, declared: true, local: 'available' }], styles: [{ style: 'normal', declared: true, local: 'available' }], subsets: [],
    fallback: { stack: "'Fraunces', Georgia, serif", glyphsRenderedByFallback: 1 }, licence, specimenUrl: '/api/workbench/fonts/specimen?ref=font-key', passed: false, notes: [], ...overrides,
  };
}
function setup(resource: ResourceResult, locale: 'en' = 'en') {
  vi.mocked(getWorkbenchResource).mockResolvedValue({ resource, sourceStatus: { sourceId: 'fonts', state: 'searched', reason: null, itemCount: 1, listingDigest: 'd' } });
  return render(<I18nProvider initial={locale}><WorkbenchResourceDetail selected={resource} projectId="p" plugins={[]} onPickPlugin={vi.fn()} onClose={vi.fn()} onRefresh={vi.fn()} /></I18nProvider>);
}

describe('AC-R11.2 real local specimen in the Enlarge shell', () => {
  it('loads every admitted local face with its own weight, style and unicode-range', async () => {
    const created = stubFontFace();
    vi.mocked(postWorkbenchFontCheck).mockResolvedValue(checkResult());
    setup(font());
    await screen.findByTestId('workbench-font-specimen-text');
    expect(created.map(face => face.source)).toEqual([`url("/api/workbench/fonts/files/${sha(1)}")`, `url("/api/workbench/fonts/files/${sha(2)}")`]);
    expect(created[1]!.descriptors).toMatchObject({ weight: '900 900', style: 'italic', unicodeRange: 'U+0000-00FF' });
    // Only locally available weights are offered, so the selector never fakes a weight.
    const weight = screen.getByLabelText('Weight') as HTMLSelectElement;
    expect([...weight.options].map(option => option.value)).toEqual(['900']);
  });

  it('checks the user text through the shared font-check endpoint and flags the missing glyph', async () => {
    stubFontFace();
    vi.mocked(postWorkbenchFontCheck).mockResolvedValue(checkResult());
    setup(font());
    const text = await screen.findByLabelText('Specimen text');
    fireEvent.change(text, { target: { value: 'aЖ' } });
    const panel = await screen.findByTestId('workbench-font-check');
    await waitFor(() => expect(within(panel).getByTestId('workbench-font-check-missing-local')).toHaveTextContent('Ж U+0416'));
    expect(postWorkbenchFontCheck).toHaveBeenLastCalledWith(expect.objectContaining({ refKey: 'font-key', projectId: 'p', text: 'aЖ', weights: [900], styles: ['normal'] }), undefined);
    expect(within(panel).getByText(/Georgia, serif/)).toBeTruthy();
  });
});

describe('AC-R11.1 and AC-R11.3 font decision detail', () => {
  it('shows each spine fit and counter-fit by spine name, with licence and pinned source', async () => {
    stubFontFace();
    vi.mocked(postWorkbenchFontCheck).mockResolvedValue(checkResult());
    setup(font());
    const detail = await screen.findByTestId('workbench-font-profile');
    expect(within(detail).getByText('Learning membership')).toBeTruthy();
    expect(within(detail).getByText('Warm headlines suit community courses.')).toBeTruthy();
    expect(within(detail).getByText('Heavy weights crowd small quiz labels.')).toBeTruthy();
    expect(within(detail).getByText(/OFL-1\.1/)).toBeTruthy();
    expect(within(detail).getByText(/@fontsource\/fraunces@5\.3\.0/)).toBeTruthy();
  });

  it('a metadata-only font states that no local file exists and still checks declared coverage', async () => {
    stubFontFace();
    vi.mocked(postWorkbenchFontCheck).mockResolvedValue(checkResult({ glyphs: { checked: 1, declared: { missing: [], missingCount: 0 }, local: { state: 'no-local-file', missing: [], missingCount: 0 } }, specimenUrl: null }));
    setup(font({}, profile({ localFiles: [] })));
    expect(await screen.findByText(/No admitted local font file/)).toBeTruthy();
    expect(screen.queryByTestId('workbench-font-specimen-text')).toBeNull();
    expect(await screen.findByTestId('workbench-font-check')).toBeTruthy();
  });

  it('unknown rights read as reference-only with redistribution blocked', async () => {
    stubFontFace();
    vi.mocked(postWorkbenchFontCheck).mockResolvedValue(checkResult());
    const unknown = profile({ licence: { ...licence, type: 'unknown', recognised: false, commercialUse: 'unknown', webEmbedding: 'unknown', redistribution: 'blocked', modification: 'Licence unknown: view for reference only.' } });
    setup(font({ rightsStatus: 'unknown', readiness: 'reference-only' }, unknown));
    const detail = await screen.findByTestId('workbench-font-profile');
    expect(within(detail).getByText(/Redistribution: blocked/)).toBeTruthy();
  });
});

describe('AC-R11.2 font view resilience and language', () => {
  it('a font load failure keeps the check, licence and spine-fit panels beside the retry', async () => {
    stubFontFace('reject');
    vi.mocked(postWorkbenchFontCheck).mockResolvedValue(checkResult());
    setup(font());
    expect(await screen.findByRole('alert')).toHaveTextContent('Font could not load');
    expect(screen.getByTestId('workbench-font-profile')).toBeTruthy();
    expect(await screen.findByTestId('workbench-font-check')).toBeTruthy();
    expect(screen.queryByTestId('workbench-font-specimen-text')).toBeNull();
  });

  it('shows rights and local-file states in the reader\'s language, not raw enum values', async () => {
    stubFontFace();
    vi.mocked(postWorkbenchFontCheck).mockResolvedValue(checkResult({ weights: [{ weight: 900, declared: true, local: 'missing' }] }));
    const unknown = profile({ licence: { ...licence, type: 'unknown', recognised: false, commercialUse: 'unknown', webEmbedding: 'unknown', redistribution: 'blocked', modification: 'x' } });
    setup(font({ rightsStatus: 'unknown', readiness: 'reference-only' }, unknown), "en");
    const detail = await screen.findByTestId('workbench-font-profile');
    expect(within(detail).getByText(/Redistribution: blocked/)).toBeTruthy();
    expect(within(detail).getByText(/Commercial use: unknown/)).toBeTruthy();
    const panel = await screen.findByTestId('workbench-font-check');
    await waitFor(() => expect(within(panel).getByText(/Local files: missing/)).toBeTruthy());
    expect(panel.textContent).not.toMatch(/\b(no-local-file)\b/);
  });
});
