import { describe, expect, it } from 'vitest';
import { parseResourceSearchRequest } from '@mish/contracts';
import { createLocalResourceSources, inspectResource, searchResources } from '../../src/workbench/resources.js';
import { createBriefTokensSource, deriveBriefTokens } from '../../src/workbench/resources-tokens.js';
import { CONTRAST_EVIDENCE_STYLE_TAG, eligibleTokenKind } from '../../src/workbench/context-ranking.js';
import { contrastRatio, parseCssColor } from '../../src/workbench/token-evidence.js';
import { booking, candidate, projectState, savedContext } from './context-ranking-fixture.js';
import { REPO_DESIGN_SYSTEMS_ROOT } from './resources-inventory-fixture.js';

const authority = { principalId: 'local-daemon', projectId: 'p' };
const dentistry = savedContext({
  purpose: 'Convert new dental patients into first appointments', audience: ['Adults looking for a new dentist'],
  brandDirection: 'Calm, premium dental care', spineCode: 'SM', conversions: [booking],
});
const dentistryQuery = 'Build a calm premium dentistry landing page where new patients book their first appointment and fill out an intake form';
function sources(context = dentistry) {
  return [
    ...createLocalResourceSources({ listPlugins: async () => [], designSystemsRoot: REPO_DESIGN_SYSTEMS_ROOT }),
    createBriefTokensSource({ readContext: projectId => projectId === 'p' ? context : null }),
  ];
}

describe('AC-R04.1 brief-derived-tokens inventory', () => {
  it('AC-R04.1: brief-derived-tokens leaves not-federated with a truthful count and digest for a project with a saved brief', async () => {
    const response = await searchResources(parseResourceSearchRequest({ projectId: 'p', useProjectContext: false, facets: { sourceIds: ['brief-derived-tokens'] }, limit: 100 }), authority, sources());
    const status = response.sourceStatuses.find(entry => entry.sourceId === 'brief-derived-tokens');
    expect(status).toMatchObject({ state: 'searched', reason: null, itemCount: 3 });
    expect(status!.listingDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(response.results.map(item => item.category).sort()).toEqual(['color-palette', 'spacing-scale', 'type-scale']);
    for (const item of response.results) {
      // AC-R04.1: no per-item acceptance receipt exists, so nothing is usable or adoptable.
      expect(item).toMatchObject({ readiness: 'unverified', rightsStatus: 'permitted', adoptionCapability: { available: false } });
      expect(item.acceptanceEvidence).toBeUndefined();
      expect(item.ref.itemId.startsWith('p/')).toBe(true);
      expect(item.previewCapability).toMatchObject({ available: true, kind: 'html' });
      expect(item.previewCapability.url).toMatch(/^\/api\/workbench\/resources\/[A-Za-z0-9_-]+\/preview\?projectId=p$/);
    }
  });

  it('AC-R04.1: without a project scope or a saved brief the source is searched with a named reason and no items', async () => {
    const noProject = await searchResources(parseResourceSearchRequest({ facets: { sourceIds: ['brief-derived-tokens'] } }), { principalId: 'local-daemon' }, sources());
    expect(noProject.sourceStatuses.find(entry => entry.sourceId === 'brief-derived-tokens')).toMatchObject({ state: 'searched', reason: 'project-scope-required', itemCount: 0 });
    const noBrief = await searchResources(parseResourceSearchRequest({ projectId: 'q', facets: { sourceIds: ['brief-derived-tokens'] } }), { principalId: 'local-daemon', projectId: 'q' }, sources());
    expect(noBrief.sourceStatuses.find(entry => entry.sourceId === 'brief-derived-tokens')).toMatchObject({ state: 'searched', reason: 'no-saved-brief', itemCount: 0 });
  });

  it('AC-R04.1 frozen evidence: a brief edit that changes the derived tokens makes the old reference stale', async () => {
    const before = await searchResources(parseResourceSearchRequest({ projectId: 'p', useProjectContext: false, facets: { category: 'color-palette', sourceIds: ['brief-derived-tokens'] } }), authority, sources());
    const palette = before.results[0]!;
    const changed = savedContext({ ...dentistry, brandDirection: 'Bold playful toy shop', factSources: [] }, 2);
    await expect(inspectResource(palette.refKey, authority, sources(changed))).rejects.toMatchObject({ status: 409, code: 'resource-ref-stale' });
    // Another project never resolves this project's reference.
    await expect(inspectResource(palette.refKey, { principalId: 'local-daemon', projectId: 'q' }, sources())).rejects.toMatchObject({ status: 404 });
  });
});

describe('AC-R05.2 contrast evidence for derived suggestions', () => {
  it('AC-R05.2: every derived text pair meets 4.5:1 and every UI pair meets 3:1, recomputed from the served hex values', () => {
    for (const brand of ['Calm, premium dental care', 'Bold playful toy shop', 'Natural organic garden centre', null]) {
      const derived = deriveBriefTokens(savedContext({ brandDirection: brand, spineCode: 'TL' }));
      const values = new Map(derived.palette.map(token => [token.name, token.value]));
      expect(derived.contrast.length).toBeGreaterThanOrEqual(5);
      for (const pair of derived.contrast) {
        const ratio = contrastRatio(parseCssColor(values.get(pair.foreground)!)!, parseCssColor(values.get(pair.background)!)!);
        expect(ratio, `${brand} ${pair.foreground}/${pair.background}`).toBe(pair.ratio);
        expect(ratio).toBeGreaterThanOrEqual(pair.minimum);
      }
    }
  });

  it('AC-R05.2: the derived palette is grounded in the saved brief and carries the contrast tag', async () => {
    const response = await searchResources(parseResourceSearchRequest({ projectId: 'p', useProjectContext: false, facets: { category: 'color-palette', sourceIds: ['brief-derived-tokens'] } }), authority, sources());
    const palette = response.results[0]!;
    expect(palette.styleTags).toContain(CONTRAST_EVIDENCE_STYLE_TAG);
    expect(palette.fitReasons.join('\n')).toMatch(/saved brief revision 1/);
    expect(palette.fitReasons.join('\n')).toMatch(/“(dental|calm)”/iu);
    expect(palette.fitReasons.some(reason => /--color-text on --color-surface: \d+(\.\d+)?:1 \(minimum 4.5:1\) passed/.test(reason))).toBe(true);
  });
});

describe('AC-R05.2 dentistry contextual query', () => {
  it('AC-R05.2: the first result page holds CTA/layout suggestions plus at least one eligible colour and one eligible sizing resource', async () => {
    const response = await searchResources(parseResourceSearchRequest({ projectId: 'p', query: dentistryQuery, limit: 20 }), authority, sources(), { projectState: projectState(dentistry) });
    expect(response.context).toMatchObject({ applied: true, resultMode: 'ranked' });
    const first = response.results;
    expect(first.some(item => ['cta-band', 'booking-availability'].includes(item.sectionKind ?? '') || item.category === 'layout')).toBe(true);
    const colour = first.filter(item => eligibleTokenKind(item) === 'color');
    const sizing = first.filter(item => eligibleTokenKind(item) === 'sizing');
    expect(colour.length).toBeGreaterThanOrEqual(1);
    expect(sizing.length).toBeGreaterThanOrEqual(1);
    // Grounded in the saved brief, not merely present.
    expect(colour[0]!.fitReasons.join('\n')).toMatch(/saved brief/);
    // The token slots follow the top five component results rather than displacing them.
    expect(first.slice(0, 5).every(item => eligibleTokenKind(item) === null)).toBe(true);
  });

  it('AC-R05.2: token slots respect a small page limit, so even a three-result first page carries colour and sizing', async () => {
    for (const limit of [2, 3, 4]) {
      const response = await searchResources(parseResourceSearchRequest({ projectId: 'p', query: dentistryQuery, limit }), authority, sources(), { projectState: projectState(dentistry) });
      expect(response.results.some(item => eligibleTokenKind(item) === 'color'), `limit ${limit}`).toBe(true);
      expect(response.results.some(item => eligibleTokenKind(item) === 'sizing'), `limit ${limit}`).toBe(true);
      if (limit > 2) expect(eligibleTokenKind(response.results[0]!), `limit ${limit}`).toBeNull();
    }
  });

  it('AC-R05.2: turning project context off omits the contextual token slots and does not change the search words', async () => {
    const response = await searchResources(parseResourceSearchRequest({ projectId: 'p', query: dentistryQuery, useProjectContext: false, limit: 20 }), authority, sources(), { projectState: projectState(dentistry) });
    expect(response.context).toMatchObject({ applied: false, reason: 'context-disabled' });
    expect(response.results.some(item => eligibleTokenKind(item) !== null)).toBe(false);
  });

  it('AC-R05.2: reference-only DESIGN.md swatches and bundled design-system palettes never count as eligible colour', () => {
    const designMd = candidate('neutral-product/DESIGN.md', { ref: { sourceType: 'reference', sourceId: 'design-md', itemId: 'neutral-product', revisionOrDigest: 'v1' }, category: 'color-palette', readiness: 'reference-only', styleTags: ['color-palette', CONTRAST_EVIDENCE_STYLE_TAG] });
    const bundled = candidate('neutral-product/color-palette', { ref: { sourceType: 'library', sourceId: 'design-systems', itemId: 'neutral-product/color-palette', revisionOrDigest: 'v1' }, category: 'color-palette', readiness: 'unverified', rightsStatus: 'permitted', admissionStage: 'discovered', styleTags: ['color-palette', CONTRAST_EVIDENCE_STYLE_TAG] });
    const referenceOnlyProjectPalette = candidate('p/color-palette', { ref: { sourceType: 'library', sourceId: 'project-tokens', itemId: 'p/color-palette', revisionOrDigest: 'v1' }, category: 'color-palette', readiness: 'reference-only', styleTags: [CONTRAST_EVIDENCE_STYLE_TAG] });
    const uncheckedProjectPalette = candidate('p/color-palette', { ref: { sourceType: 'library', sourceId: 'project-tokens', itemId: 'p/color-palette', revisionOrDigest: 'v1' }, category: 'color-palette', readiness: 'unverified', rightsStatus: 'unknown', admissionStage: 'discovered', styleTags: ['color-palette'] });
    for (const item of [designMd, bundled, referenceOnlyProjectPalette, uncheckedProjectPalette]) expect(eligibleTokenKind(item), item.ref.sourceId).toBeNull();
  });
});
