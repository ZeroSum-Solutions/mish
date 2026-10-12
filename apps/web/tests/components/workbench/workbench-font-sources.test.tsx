// @vitest-environment jsdom
// AC-R11 preamble in the canvas: a font's every pinned source (Fontsource, Google
// Fonts, Fontshare) with its licence and notice digests and whether a local file is
// admitted, the kits that declare the family, and the search-level kit inventory —
// the same DTOs `od workbench search --json` prints.
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseResourceSearchResponse, type FontKitDeclaration, type FontProfile, type ResourceResult } from '@mish/contracts';
import { I18nProvider } from '../../../src/i18n';
import { WorkbenchResourceDetail } from '../../../src/components/workbench/WorkbenchResourceDetail';
import { WorkbenchResourceSearch } from '../../../src/components/workbench/WorkbenchResourceSearch';
import { getProjectDesignContext, getWorkbenchPreferences, getWorkbenchResource, postWorkbenchFontCheck, searchWorkbenchResources } from '../../../src/providers/workbench';

vi.mock('../../../src/providers/workbench', async (original) => ({
  ...await original<typeof import('../../../src/providers/workbench')>(),
  getWorkbenchResource: vi.fn(), postWorkbenchFontCheck: vi.fn(), searchWorkbenchResources: vi.fn(), getWorkbenchPreferences: vi.fn(), getProjectDesignContext: vi.fn(),
}));
beforeEach(() => {
  vi.mocked(getWorkbenchPreferences).mockImplementation(async projectId => ({ projectId, revision: 0, preferences: null, effective: { useProjectContext: true } }));
  vi.mocked(getProjectDesignContext).mockImplementation(async projectId => ({ projectId, revision: 0, context: null }));
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const sha = (digit: string) => digit.repeat(64);
const COMMIT = '2eb0b48d5f760f62e286216f0859a8c540dbc1bd';
const declaration = (overrides: Partial<FontKitDeclaration>): FontKitDeclaration => ({
  root: 'bundled-plugins', kit: 'examples/acreage-farming', family: 'Manrope', files: ['examples/acreage-farming/example.html'], fileCount: 1, loading: ['google-fonts-css'], remoteHosts: ['fonts.googleapis.com'],
  state: 'undeclared', reason: 'no-admitted-local-file', message: 'Manrope has no admitted local file; the kit loads it from Google Fonts CSS.', catalogueItemId: 'manrope', admittedFiles: [], kitBytesAdmitted: null, ...overrides,
});
const profile: FontProfile = {
  schema: 'font-profile/1', family: 'Manrope', category: 'sans-serif', weights: [200, 800], styles: ['normal'], subsets: ['latin'], defaultSubset: 'latin', axes: [],
  licence: { type: 'OFL-1.1', recognised: true, attribution: 'Copyright 2018 The Manrope Project Authors', url: null, upstreamLicenceSha256: sha('a'), noticeSha256: sha('b'), reservedFontNames: [], commercialUse: 'permitted', webEmbedding: 'permitted', redistribution: 'permitted', modification: 'Use upstream-provided subsets.' },
  source: { metadata: 'google/fonts', commit: COMMIT, path: 'ofl/manrope', metadataSha256: sha('c') },
  spineFit: [], localFiles: [],
  sources: [
    { source: 'google-fonts', identity: 'ofl/manrope', revision: COMMIT, url: 'https://fonts.google.com/specimen/Manrope', licenceType: 'OFL-1.1', licenceSha256: sha('a'), noticeSha256: sha('b'), reason: null, localFile: 'none' },
    { source: 'fontshare', identity: 'manrope', revision: '2026-10-08', url: 'https://www.fontshare.com/fonts/manrope', licenceType: 'OFL-1.1', licenceSha256: sha('d'), noticeSha256: null, reason: 'The licence file names no copyright line', localFile: 'none' },
  ],
  kitDeclarations: [declaration({})],
};
const manrope: ResourceResult = {
  ref: { sourceType: 'font', sourceId: 'fonts', itemId: 'manrope', revisionOrDigest: 'sha256:x' }, refKey: 'manrope-key', title: 'Manrope', category: 'font', readiness: 'unverified',
  compatibility: { nativeFormat: 'google-fonts-metadata', targets: [], state: 'unverified', reason: 'No local file admitted' }, rightsStatus: 'permitted', fitReasons: [],
  previewCapability: { available: false, kind: 'none', reason: 'no-local-font-file' }, adoptionCapability: { available: false, reason: 'adapter-missing' },
  sourceAttribution: { title: 'Manrope · google/fonts', url: 'https://fonts.google.com/specimen/Manrope' }, operationGrants: [], admissionStage: 'discovered', needDecision: 'not-assessed', needReason: 'Not assessed',
  spineAffinities: 'unclassified', fontProfile: profile,
};

describe('AC-R11 preamble: font sources and kit declarations in the font detail', () => {
  it('names every pinned source with its digests, and says no local file is admitted', async () => {
    vi.mocked(postWorkbenchFontCheck).mockResolvedValue({
      schema: 'font-check/1', ref: manrope.ref, refKey: manrope.refKey, family: 'Manrope',
      glyphs: { checked: 0, declared: { missing: [], missingCount: 0, state: 'no-declared-ranges' }, local: { state: 'no-local-file', missing: [], missingCount: 0 } },
      weights: [], styles: [], subsets: [], fallback: { stack: "'Manrope', system-ui, sans-serif", glyphsRenderedByFallback: 0 }, licence: profile.licence, specimenUrl: null, passed: false, notes: [],
    });
    vi.mocked(getWorkbenchResource).mockResolvedValue({ resource: manrope, sourceStatus: { sourceId: 'fonts', state: 'searched', reason: null, itemCount: 1, listingDigest: 'd' } });
    render(<I18nProvider initial="en"><WorkbenchResourceDetail selected={manrope} projectId="p" plugins={[]} onPickPlugin={vi.fn()} onClose={vi.fn()} onRefresh={vi.fn()} /></I18nProvider>);
    const detail = await screen.findByTestId('workbench-font-profile');
    expect(within(detail).getByText(`ofl/manrope · google/fonts@${COMMIT.slice(0, 7)}`)).toBeTruthy();
    const sources = within(detail).getByTestId('workbench-font-sources');
    expect(within(sources).getByText(/Google Fonts/)).toBeTruthy();
    expect(within(sources).getByText(/Fontshare/)).toBeTruthy();
    expect(within(sources).getAllByText(/No local file admitted/)).toHaveLength(2);
    expect(sources.textContent).toContain(sha('a').slice(0, 12));
    expect(sources.textContent).toContain('The licence file names no copyright line');
    const kits = within(detail).getByTestId('workbench-font-kits');
    expect(within(kits).getByText(/examples\/acreage-farming/)).toBeTruthy();
    expect(within(kits).getByText(/No admitted local file/)).toBeTruthy();
    expect(await screen.findByTestId('workbench-font-check')).toBeTruthy();
  });

  it("shows the source and kit states in English", async () => {
    vi.mocked(postWorkbenchFontCheck).mockRejectedValue(new Error('offline'));
    vi.mocked(getWorkbenchResource).mockResolvedValue({ resource: manrope, sourceStatus: { sourceId: 'fonts', state: 'searched', reason: null, itemCount: 1, listingDigest: 'd' } });
    render(<I18nProvider initial="en"><WorkbenchResourceDetail selected={manrope} projectId="p" plugins={[]} onPickPlugin={vi.fn()} onClose={vi.fn()} onRefresh={vi.fn()} /></I18nProvider>);
    const detail = await screen.findByTestId('workbench-font-profile');
    expect(within(within(detail).getByTestId('workbench-font-sources')).getAllByText(/No local file admitted/)).toHaveLength(2);
    expect(within(within(detail).getByTestId('workbench-font-kits')).getByText(/No admitted local file/)).toBeTruthy();
  });
});

const plainResponse = () => parseResourceSearchResponse({
  results: [manrope], sourceStatuses: [], contextRevision: null, nextCursor: null, indexDigest: 'digest', degradedReason: null,
  context: { requested: true, applied: false, reason: 'context-not-implemented' },
});
describe('AC-R11 preamble: kit and example font inventory in the Resources flyout', () => {
  it('loads the inventory on request through a font-category search, the same call od makes', async () => {
    vi.mocked(searchWorkbenchResources).mockImplementation(async request => request.facets?.category === 'font'
      ? parseResourceSearchResponse({ ...plainResponse(), fontKits: { schema: 'font-kit-inventory/1', scanned: { roots: ['bundled-plugins'], kits: 1, files: 1, truncated: false }, declarations: [declaration({})], counts: { mapped: 0, undeclared: 1, byReason: { 'no-admitted-local-file': 1, 'rights-restricted': 0, 'licence-unknown': 0, 'kit-bytes-not-admitted': 0, 'system-font': 0, 'not-in-catalogue': 0 } } } })
      : plainResponse());
    render(<I18nProvider initial="en"><WorkbenchResourceSearch plugins={[]} onPickPlugin={vi.fn()} /></I18nProvider>);
    fireEvent.click(await screen.findByRole('button', { name: 'Show kit and example fonts' }));
    const report = await screen.findByRole('region', { name: 'Kit and example fonts' });
    expect(within(report).getByText('0 mapped to admitted files · 1 undeclared')).toBeTruthy();
    expect(searchWorkbenchResources).toHaveBeenLastCalledWith(expect.objectContaining({ query: '', facets: { category: 'font' }, limit: 1 }), undefined);
  });

  it('shows mapped and undeclared kit fonts with their named reasons', async () => {
    vi.mocked(searchWorkbenchResources).mockResolvedValue(parseResourceSearchResponse({
      results: [manrope], sourceStatuses: [], contextRevision: null, nextCursor: null, indexDigest: 'digest', degradedReason: null,
      context: { requested: true, applied: false, reason: 'context-not-implemented' },
      fontKits: {
        schema: 'font-kit-inventory/1', scanned: { roots: ['bundled-plugins'], kits: 2, files: 3, truncated: false },
        declarations: [
          declaration({}),
          declaration({ kit: 'examples/agency-watson', family: 'WatsonBody', files: ['examples/agency-watson/preview/watson-r1.html'], loading: ['local-font-face'], remoteHosts: [], state: 'mapped', reason: null, message: 'WatsonBody self-hosts admitted Kumbh Sans bytes.', catalogueItemId: 'kumbh-sans', admittedFiles: [sha('e')], kitBytesAdmitted: true }),
          declaration({ kit: 'examples/agency-watson', family: 'Helvetica Neue', loading: ['none'], remoteHosts: [], reason: 'system-font', message: 'Helvetica Neue is a platform font; it is never admitted.', catalogueItemId: null }),
        ],
        counts: { mapped: 1, undeclared: 2, byReason: { 'no-admitted-local-file': 1, 'rights-restricted': 0, 'licence-unknown': 0, 'kit-bytes-not-admitted': 0, 'system-font': 1, 'not-in-catalogue': 0 } },
      },
    }));
    render(<I18nProvider initial="en"><WorkbenchResourceSearch plugins={[]} onPickPlugin={vi.fn()} /></I18nProvider>);
    const report = await screen.findByRole('region', { name: 'Kit and example fonts' });
    expect(within(report).getByText('1 mapped to admitted files · 2 undeclared')).toBeTruthy();
    expect(within(report).getByText(/WatsonBody/)).toBeTruthy();
    expect(within(report).getByText(/Mapped to admitted file/)).toBeTruthy();
    expect(within(report).getByText(/Platform font/)).toBeTruthy();
    expect(within(report).getByText(/No admitted local file/)).toBeTruthy();
  });
});
