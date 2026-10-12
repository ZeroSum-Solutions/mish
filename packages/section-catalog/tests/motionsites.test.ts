import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeMotionSitesPrompt, normalizeMotionSitesPrompts, type MotionSitesListPromptsResponse } from '../src/motionsites.ts';
import { sectionCatalogPolicyIssues } from '../src/validate.ts';
import { SECTION_CATALOG_SCHEMA } from '../src/types.ts';

const fixtureDir = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(path.join(fixtureDir, 'fixtures/motionsites-list-prompts.json'), 'utf8'),
) as MotionSitesListPromptsResponse;

// The fixture's shape mirrors the real mcp__motionsites__list_prompts/search_prompts result
// (verified live against the tool while building this normalizer — see the MotionSites vendoring
// research inventory, an internal research artifact not part of this repository, for the
// documented table/field shapes this MCP surface draws on). Every title and id here is invented
// for the test; none of it is a real MotionSites prompt body or title.

describe('normalizeMotionSitesPrompts', () => {
  const entries = normalizeMotionSitesPrompts(fixture);

  it('produces one entry per result, all sourceKind motionsites-prompt', () => {
    expect(entries).toHaveLength(fixture.results.length);
    for (const entry of entries) expect(entry.sourceKind).toBe('motionsites-prompt');
  });

  it('never reads or forwards preview_url — preview is always the source deep link', () => {
    for (const entry of entries) {
      expect(entry.preview).toEqual({ kind: 'external-link', url: expect.stringContaining('https://motionsites.ai/') });
      expect(JSON.stringify(entry)).not.toContain('example.invalid');
    }
  });

  it('produces a byte-identical entry whether preview_url is absent, present, or a motionsites.ai URL — the normalizer never branches on it', () => {
    // fixture-footer-01/fixture-unclear-01/fixture-mobile-01 carry no preview_url at all;
    // fixture-cta-01 carries a real motionsites.ai preview_url; fixture-hero-01 carries one at
    // example.invalid. If normalizeMotionSitesPrompt ever started reading preview_url — even to
    // rewrite or drop it conditionally — this would fail, unlike a test that only checks the
    // string is absent from the output (which would also pass a normalizer that silently read and
    // discarded a *different* field).
    for (const result of fixture.results) {
      const withoutPreviewUrl = { ...result };
      delete withoutPreviewUrl.preview_url;
      const withMotionSitesPreviewUrl = { ...result, preview_url: 'https://motionsites.ai/preview/x.webp' };
      const base = normalizeMotionSitesPrompt(result);
      expect(normalizeMotionSitesPrompt(withoutPreviewUrl)).toEqual(base);
      expect(normalizeMotionSitesPrompt(withMotionSitesPreviewUrl)).toEqual(base);
    }
  });

  it('never carries upgrade_cta — the response-level field never reaches any entry', () => {
    // The fixture's upgrade_cta value ("Access ALL prompts...") is distinctive enough that a leak
    // (e.g. into evidence, title, or sourceType) would show up in a plain substring search of the
    // whole batch. rights.evidence legitimately cites the motionsites.ai/unlimited *URL* as its
    // pricing-page source (see MOTIONSITES_RIGHTS_EVIDENCE), which is a different string from the
    // upgrade_cta marketing copy asserted against here.
    expect(fixture.upgrade_cta).toBeTruthy();
    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain(fixture.upgrade_cta);
    expect(serialized).not.toContain('Access ALL prompts');
    for (const entry of entries) expect(Object.keys(entry)).not.toContain('upgrade_cta');
  });

  it('never carries a prompt body: content is only a remoteId and the deep link', () => {
    for (const entry of entries) {
      expect(entry.content).toEqual({ kind: 'motion-prompt', remoteId: expect.any(String), url: expect.any(String) });
      expect(Object.keys(entry.content)).toEqual(['kind', 'remoteId', 'url']);
    }
  });

  it('maps access free/premium to free-account/paid-account', () => {
    const free = entries.find((entry) => entry.id === 'motionsites-prompt:fixture-hero-01')!;
    const premium = entries.find((entry) => entry.id === 'motionsites-prompt:fixture-saas-landing-01')!;
    expect(free.access).toBe('free-account');
    expect(premium.access).toBe('paid-account');
  });

  it('maps a UI-kind category directly to that sectionKind, with spineAffinities "any"', () => {
    const hero = entries.find((entry) => entry.id === 'motionsites-prompt:fixture-hero-01')!;
    const cta = entries.find((entry) => entry.id === 'motionsites-prompt:fixture-cta-01')!;
    const footer = entries.find((entry) => entry.id === 'motionsites-prompt:fixture-footer-01')!;
    expect(hero.sectionKind).toBe('hero');
    expect(hero.spineAffinities).toBe('any');
    expect(cta.sectionKind).toBe('cta-band');
    expect(footer.sectionKind).toBe('footer');
  });

  it('maps an industry category to page-composition + the repo atlas spine, not the inventory\'s reversed proposal', () => {
    const saas = entries.find((entry) => entry.id === 'motionsites-prompt:fixture-saas-landing-01')!;
    const agency = entries.find((entry) => entry.id === 'motionsites-prompt:fixture-agency-landing-01')!;
    expect(saas.sectionKind).toBe('page-composition');
    expect(saas.spineAffinities).toEqual(['PA']);
    expect(agency.sectionKind).toBe('page-composition');
    expect(agency.spineAffinities).toEqual(['TL']);
  });

  it('never guesses a spine for an unclear category, and never defaults to MI', () => {
    const unclear = entries.find((entry) => entry.id === 'motionsites-prompt:fixture-unclear-01')!;
    expect(unclear.sectionKind).toBe('unclassified');
    expect(unclear.spineAffinities).toBe('unclassified');
    expect(unclear.spineAffinities).not.toBe('MI');
  });

  it('keeps a non-section category (e.g. Mobile) out of the section-kind axis', () => {
    const mobile = entries.find((entry) => entry.id === 'motionsites-prompt:fixture-mobile-01')!;
    expect(mobile.sectionKind).toBe('unclassified');
    expect(mobile.sourceType).toBe('Mobile');
  });

  it('carries rights.decision "metadata-only" and rights.license "proprietary" for every entry', () => {
    for (const entry of entries) {
      expect(entry.rights.decision).toBe('metadata-only');
      expect(entry.rights.license).toBe('proprietary');
    }
  });

  it('passes the same policy checks the build-time catalog runs', () => {
    expect(sectionCatalogPolicyIssues({ schema: SECTION_CATALOG_SCHEMA, entries })).toEqual([]);
  });
});

describe('normalizeMotionSitesPrompt (single result)', () => {
  it('round-trips id -> "motionsites-prompt:<id>"', () => {
    const entry = normalizeMotionSitesPrompt(fixture.results[0]!);
    expect(entry.id).toBe(`motionsites-prompt:${fixture.results[0]!.id}`);
    expect(entry.content).toMatchObject({ kind: 'motion-prompt', remoteId: fixture.results[0]!.id });
  });

  // delta audit #9: a bare 'landing page'/'landing' category names a whole-page prompt with no
  // industry/vertical signal of its own — 'any' would be a confident-looking "fits every spine"
  // for something that in fact fits none specifically, so this must land on 'unclassified', not
  // 'any' (the general "generic UI kind -> any" rule other categories like Hero/CTA get).
  for (const category of ['Landing Page', 'landing', 'LANDING PAGE']) {
    it(`maps category "${category}" to page-composition + spineAffinities "unclassified", never "any"`, () => {
      const entry = normalizeMotionSitesPrompt({
        id: 'fixture-bare-landing-01', title: 'Fixture Bare Landing', category, kind: 'website', access: 'free',
        url: 'https://motionsites.ai/?prompt=fixture-bare-landing-01',
      });
      expect(entry.sectionKind).toBe('page-composition');
      expect(entry.spineAffinities).toBe('unclassified');
      expect(entry.spineAffinities).not.toBe('any');
    });
  }

  it('still derives a spine for a landing prompt whose category names an industry (SaaS/Agency), not "unclassified"', () => {
    // Contrast with the bare-category case above: when the category itself is a vertical (handled
    // via SPINE_CATEGORIES, not SECTION_KIND_CATEGORIES), the spine is still derived, not dropped.
    const saas = normalizeMotionSitesPrompt({
      id: 'fixture-saas-01', title: 'Fixture SaaS', category: 'SaaS', kind: 'website', access: 'free',
      url: 'https://motionsites.ai/?prompt=fixture-saas-01',
    });
    expect(saas.sectionKind).toBe('page-composition');
    expect(saas.spineAffinities).toEqual(['PA']);
  });
});
