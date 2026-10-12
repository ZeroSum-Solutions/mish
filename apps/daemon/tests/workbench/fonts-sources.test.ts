import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseFontCheckRequest, parseFontCheckResponse, parseResourceSearchRequest, type ResourceCandidate, type ResourceResult } from '@mish/contracts';
import { checkFont } from '../../src/fonts/check.js';
import { bundledFontListings, validateFontListing } from '../../src/fonts/listings.js';
import { renderFontSpecimen } from '../../src/fonts/specimen.js';
import { resourceRefKey } from '../../src/workbench/context-ranking.js';
import { searchResources } from '../../src/workbench/resources.js';
import { createFontsResourceSource } from '../../src/workbench/resources-fonts.js';
import { REPO_BUNDLED_PLUGINS_ROOT, authority } from './fonts-fixture.js';

const GOOGLE_COMMIT = '2eb0b48d5f760f62e286216f0859a8c540dbc1bd';
const HEX64 = /^[a-f0-9]{64}$/u;
const fonts = () => createFontsResourceSource({ root: REPO_BUNDLED_PLUGINS_ROOT });
const search = (query: string, extra: Record<string, unknown> = {}) => parseResourceSearchRequest({ query, facets: { sourceIds: ['fonts'] }, limit: 100, ...extra });
const ids = (items: readonly { ref: { itemId: string } }[]) => items.map(item => item.ref.itemId);
const byId = (items: readonly ResourceCandidate[], id: string) => items.find(item => item.ref.itemId === id);
let listed: readonly ResourceCandidate[] | undefined;
const items = async () => (listed ??= (await fonts().list(authority)).items);
afterEach(() => { vi.unstubAllGlobals(); });

describe('AC-R11 preamble: Google Fonts discovery from the pinned google/fonts metadata', () => {
  it('lists Google-only families with the pinned commit, licence and notice digests, and no local file admitted', async () => {
    const roboto = byId(await items(), 'roboto')!;
    expect(roboto).toBeDefined();
    expect(roboto.fontProfile!.source).toEqual({ metadata: 'google/fonts', commit: GOOGLE_COMMIT, path: 'ofl/roboto', metadataSha256: expect.stringMatching(HEX64) });
    expect(roboto.fontProfile!.licence).toMatchObject({ type: 'OFL-1.1', recognised: true, upstreamLicenceSha256: expect.stringMatching(HEX64), noticeSha256: expect.stringMatching(HEX64) });
    expect(roboto.fontProfile!.sources).toEqual([expect.objectContaining({ source: 'google-fonts', identity: 'ofl/roboto', revision: GOOGLE_COMMIT, licenceType: 'OFL-1.1', licenceSha256: expect.stringMatching(HEX64), noticeSha256: expect.stringMatching(HEX64), localFile: 'none' })]);
    expect(roboto.fontProfile!.localFiles).toEqual([]);
    expect(roboto.compatibility.reason).toMatch(/no local file admitted/i);
    expect(roboto.previewCapability).toEqual({ available: false, kind: 'none', reason: 'no-local-font-file' });
    expect(roboto).toMatchObject({ readiness: 'unverified', rightsStatus: 'permitted', adoptionCapability: { available: false } });
    expect(roboto.sourceAttribution.url).toBe('https://fonts.google.com/specimen/Roboto');
  });

  it('covers the whole pinned repository and names why any family was left out', () => {
    const google = bundledFontListings().find(listing => listing.source.kind === 'google-fonts')!;
    expect(google.source.commit).toBe(GOOGLE_COMMIT);
    expect(google.families.length).toBeGreaterThan(1800);
    for (const skipped of google.skipped) expect(skipped.reason.length).toBeGreaterThan(10);
    for (const family of google.families) {
      // Every family records its licence digest and notice digest, or says why one is missing.
      if (family.licence.sha256 === null) expect(family.licence.reason, family.id).toBeTruthy();
      if (family.notice.sha256 === null) expect(family.notice.reason, family.id).toBeTruthy();
    }
  });

  it('deduplicates a family Fontsource and Google both list into one item that keeps both sources', async () => {
    const all = await items();
    expect(all.filter(item => item.title === 'Inter')).toHaveLength(1);
    const inter = byId(all, 'inter')!.fontProfile!;
    expect(inter.source.metadata).toBe('fontsource/font-files');
    expect(inter.sources?.map(record => record.source)).toEqual(['fontsource', 'google-fonts']);
    const google = inter.sources!.find(record => record.source === 'google-fonts')!;
    expect(google).toMatchObject({ identity: 'ofl/inter', revision: GOOGLE_COMMIT, licenceSha256: expect.stringMatching(HEX64), noticeSha256: expect.stringMatching(HEX64), localFile: 'none' });
    // A curated family with admitted bytes says so on its Fontsource record.
    expect(byId(all, 'archivo')!.fontProfile!.sources!.find(record => record.source === 'fontsource')).toMatchObject({ localFile: 'admitted' });
  });

  it('keeps unrecognised licences reference-only: UFL, OFL 1.0 and a missing licence file', async () => {
    const all = await items();
    for (const id of ['ubuntu', 'jomolhari', 'tinos']) {
      const item = byId(all, id)!;
      expect(item, id).toBeDefined();
      expect(item).toMatchObject({ rightsStatus: 'unknown', readiness: 'reference-only' });
      expect(item.fontProfile!.licence.redistribution).toBe('blocked');
    }
    expect(byId(all, 'ubuntu')!.fontProfile!.licence.type).toBe('UFL-1.0');
    expect(byId(all, 'jomolhari')!.fontProfile!.licence.type).toBe('OFL-1.0');
    expect(byId(all, 'tinos')!.fontProfile!.sources![0]).toMatchObject({ licenceSha256: null, reason: expect.stringMatching(/OFL\.txt/) });
  });

  it('finds a discovery family by name and script, but keeps discovery-only families out of an empty query', async () => {
    const sources = [fonts()];
    expect(ids((await searchResources(search('Noto Sans JP'), authority, sources)).results)).toContain('noto-sans-jp');
    expect(ids((await searchResources(search('script:japanese'), authority, sources)).results)).toContain('noto-sans-jp');
    const empty = ids((await searchResources(search(''), authority, sources)).results);
    expect(empty).toContain('fraunces');
    expect(empty).not.toContain('roboto');
  });

  it('reads only committed snapshots: listing and search make no network request', async () => {
    const fetchSpy = vi.fn(() => { throw new Error('network access is not allowed'); });
    vi.stubGlobal('fetch', fetchSpy);
    await searchResources(search('Roboto'), authority, [fonts()]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects a listing whose notice text does not match its notice digest', () => {
    const google = structuredClone(bundledFontListings().find(listing => listing.source.kind === 'google-fonts')!);
    const family = google.families.find(entry => entry.notice.text)!;
    family.notice.text = `${family.notice.text} (edited)`;
    expect(() => validateFontListing(google)).toThrow(/notice/);
  });
});

describe('AC-R11 preamble: Fontshare OFL families admitted, FFL originals restricted', () => {
  it('admits a Fontshare family as OFL only from its own OFL licence file, with both digests', async () => {
    const roundo = byId(await items(), 'fontshare-roundo')!;
    expect(roundo.fontProfile!.source).toMatchObject({ metadata: 'fontshare', slug: 'roundo', listingSha256: expect.stringMatching(HEX64) });
    expect(roundo).toMatchObject({ rightsStatus: 'permitted', readiness: 'unverified' });
    expect(roundo.fontProfile!.sources).toEqual([expect.objectContaining({ source: 'fontshare', licenceType: 'OFL-1.1', licenceSha256: expect.stringMatching(HEX64), noticeSha256: expect.stringMatching(HEX64), localFile: 'none' })]);
    expect(roundo.sourceAttribution.url).toBe('https://www.fontshare.com/fonts/roundo');
  });

  it('merges a Fontshare OFL listing of a Google family into that family, keeping each source record', async () => {
    const all = await items();
    expect(byId(all, 'fontshare-poppins')).toBeUndefined();
    const poppins = byId(all, 'poppins')!.fontProfile!;
    expect(poppins.sources?.map(record => record.source)).toEqual(['google-fonts', 'fontshare']);
    const [google, fontshare] = poppins.sources!;
    expect(google!.licenceSha256).not.toBe(fontshare!.licenceSha256);
  });

  it('keeps ITF FFL originals restricted: discoverable by name, nothing served, every byte operation blocked', async () => {
    const all = await items();
    const satoshi = byId(all, 'fontshare-satoshi')!;
    expect(satoshi).toMatchObject({ rightsStatus: 'restricted', readiness: 'unavailable', availabilityReason: 'rights-blocked', previewCapability: { available: false, reason: 'rights-blocked' } });
    expect(satoshi.fontProfile!.licence.type).toBe('ITF-FFL');
    expect(satoshi.operationGrants.every(grant => grant.state === 'blocked')).toBe(true);
    const ffl = all.filter(item => item.fontProfile?.source.metadata === 'fontshare' && item.fontProfile.licence.type === 'ITF-FFL');
    expect(ffl.length).toBeGreaterThan(50);
    expect(ffl.every(item => item.rightsStatus === 'restricted')).toBe(true);
    expect(ids((await searchResources(search('Satoshi'), authority, [fonts()])).results)).toContain('fontshare-satoshi');
  });
});

describe('AC-R11.2 checks on a metadata-only discovery family', () => {
  it('reports no declared ranges and no local file instead of inventing coverage', async () => {
    const source = fonts();
    const item = byId((await source.list(authority)).items, 'roboto')!;
    const resource: ResourceResult = { ...item, refKey: resourceRefKey(item.ref) };
    const result = parseFontCheckResponse(checkFont(resource, source.family('roboto')!, parseFontCheckRequest({ refKey: resource.refKey, text: 'Hello', weights: [700] })));
    expect(result.glyphs.declared).toEqual({ missing: [], missingCount: 0, state: 'no-declared-ranges' });
    expect(result.glyphs.local.state).toBe('no-local-file');
    expect(result.weights).toEqual([{ weight: 700, declared: true, local: 'no-local-file' }]);
    expect(result.passed).toBe(false);
    expect(result.specimenUrl).toBeNull();
    expect(result.notes.join(' ')).toMatch(/no local file admitted/i);
    const specimen = renderFontSpecimen(resource);
    expect(specimen.html).toContain('ofl/roboto');
    expect(specimen.html).not.toContain('@font-face');
  });
});
