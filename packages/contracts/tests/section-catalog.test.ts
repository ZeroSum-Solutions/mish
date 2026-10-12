import { describe, expect, it } from 'vitest';

import { parseSectionCatalogResponse, type SectionCatalogEntry, type SectionCatalogResponse } from '../src/api/section-catalog.js';

function validEntry(): SectionCatalogEntry {
  return {
    id: 'hyperui:marketing/ctas/1',
    title: 'Marketing Ctas 1',
    sourceKind: 'hyperui',
    sectionKind: 'cta-band',
    sourceType: 'marketing/ctas',
    spineAffinities: 'any',
    rights: { license: 'MIT', decision: 'bundle', evidence: 'HyperUI LICENSE' },
    access: 'local',
    availability: 'insertable',
    preview: { kind: 'none' },
    content: { kind: 'vendored-block', blockId: 'marketing/ctas/1', sha256: 'a'.repeat(64) },
  };
}

function validResponse(): SectionCatalogResponse {
  return { catalog: { schema: 'section-catalog/1', entries: [validEntry()] } };
}

function motionSitesEntry(): SectionCatalogEntry {
  return {
    id: 'motionsites-prompt:fixture-hero-01',
    title: 'Hero Prompt',
    sourceKind: 'motionsites-prompt',
    sectionKind: 'hero',
    sourceType: 'Hero',
    spineAffinities: 'any',
    rights: { license: 'proprietary', decision: 'metadata-only', evidence: 'motionsites.ai footer notice' },
    access: 'free-account',
    availability: 'reference-only',
    preview: { kind: 'external-link', url: 'https://motionsites.ai/?prompt=fixture-hero-01' },
    content: { kind: 'motion-prompt', remoteId: 'fixture-hero-01', url: 'https://motionsites.ai/?prompt=fixture-hero-01' },
  };
}

function localCorpusEntry(): SectionCatalogEntry {
  return {
    id: 'zerosum-kit:fixture-page',
    title: 'Fixture page',
    sourceKind: 'local-corpus',
    sectionKind: 'hero',
    sourceType: 'zerosum-kit',
    spineAffinities: 'unclassified',
    rights: { license: 'project-specific', decision: 'bundle', evidence: 'owner-authored' },
    access: 'local',
    availability: 'reference-only',
    preview: { kind: 'none' },
    content: { kind: 'local-prompt', corpusId: 'fixture-page' },
  };
}

function cultEntry(): SectionCatalogEntry {
  return {
    id: 'cult:marketing-pricing-vercel',
    title: 'Pricing (series V)',
    sourceKind: 'cult-pro',
    sectionKind: 'pricing',
    sourceType: 'marketing-pricing',
    spineAffinities: ['PA'],
    rights: { license: 'licensed', decision: 'bundle', evidence: 'docs/legal/cult-ui-pro-rights.md' },
    access: 'local',
    availability: 'adapter-needed',
    preview: { kind: 'none' },
    content: {
      kind: 'cult-item',
      summary: 'Pricing section with a billing toggle.',
      sourceTitle: 'Marketing Pricing Vercel',
      provenance: { cultId: 'cult:marketing-pricing-vercel', snapshotId: 'cult-ui-pro@6b9560102fcd5ae5' },
    },
  };
}

function familySectionEntry(): SectionCatalogEntry {
  return {
    id: 'family-section:watson:watson-hero',
    title: 'Watson — Hero',
    sourceKind: 'family-section',
    sectionKind: 'hero',
    sourceType: 'hero',
    spineAffinities: ['TL'],
    rights: { license: 'project-specific', decision: 'same-family-only', evidence: 'family README#rights' },
    access: 'local',
    availability: 'reference-only',
    preview: { kind: 'none' },
    content: { kind: 'family-section', family: 'watson', sectionId: 'watson-hero' },
  };
}

describe('parseSectionCatalogResponse', () => {
  it('returns the value unchanged for a valid response', () => {
    const response = validResponse();
    expect(parseSectionCatalogResponse(response)).toBe(response);
  });

  it('accepts every spineAffinities alternative', () => {
    for (const value of [['PA'], ['PA', 'TL'], 'any', 'unclassified']) {
      const response = validResponse();
      (response.catalog.entries[0] as { spineAffinities: unknown }).spineAffinities = value;
      expect(() => parseSectionCatalogResponse(response)).not.toThrow();
    }
  });

  it('accepts every preview alternative', () => {
    for (const value of [{ kind: 'local', artifactId: 'x' }, { kind: 'external-link', url: 'https://x' }, { kind: 'none' }]) {
      const response = validResponse();
      (response.catalog.entries[0] as { preview: unknown }).preview = value;
      expect(() => parseSectionCatalogResponse(response)).not.toThrow();
    }
  });

  it('accepts every content alternative on an entry whose sourceKind/rights/availability actually match it', () => {
    // Unlike spineAffinities/preview above, a content variant is not freely swappable on any
    // entry — sourceKind "hyperui" requires "vendored-block", "motionsites-prompt" requires
    // "motion-prompt", and "family-section" requires "family-section" (assertEntryPolicy mirrors
    // sectionCatalogPolicyIssues). Each fixture below is a fully self-consistent entry for its own
    // sourceKind, not the shared `validEntry()` base with only `content` swapped.
    for (const entry of [validEntry(), motionSitesEntry(), familySectionEntry()]) {
      const response: SectionCatalogResponse = { catalog: { schema: 'section-catalog/1', entries: [entry] } };
      expect(() => parseSectionCatalogResponse(response)).not.toThrow();
    }
  });

  it('throws naming the top-level path when the value is not an object', () => {
    expect(() => parseSectionCatalogResponse(null)).toThrow('section catalog response must be an object');
  });

  it('throws naming the right path when catalog is not an object', () => {
    expect(() => parseSectionCatalogResponse({ catalog: null })).toThrow('catalog must be an object');
    expect(() => parseSectionCatalogResponse({ catalog: null })).not.toThrow('catalog.catalog');
  });

  it('throws when catalog.schema is wrong', () => {
    const response = validResponse();
    (response.catalog as { schema: string }).schema = 'section-catalog/2';
    expect(() => parseSectionCatalogResponse(response)).toThrow('catalog.schema must be "section-catalog/1"');
  });

  it('throws when catalog.entries is not an array', () => {
    expect(() => parseSectionCatalogResponse({ catalog: { schema: 'section-catalog/1', entries: 'x' } })).toThrow(
      'catalog.entries must be an array',
    );
  });

  it('throws naming the failing entry field for an invalid sectionKind', () => {
    const response = validResponse();
    (response.catalog.entries[0] as { sectionKind: unknown }).sectionKind = 'not-a-kind';
    expect(() => parseSectionCatalogResponse(response)).toThrow('catalog.entries[0].sectionKind is invalid');
  });

  it('throws naming the failing entry index for an invalid sourceKind', () => {
    const response = validResponse();
    response.catalog.entries.push(validEntry());
    (response.catalog.entries[1] as { sourceKind: unknown }).sourceKind = 'nope';
    expect(() => parseSectionCatalogResponse(response)).toThrow('catalog.entries[1].sourceKind is invalid');
  });

  it('rejects an empty-array spineAffinities', () => {
    const response = validResponse();
    (response.catalog.entries[0] as { spineAffinities: unknown }).spineAffinities = [];
    expect(() => parseSectionCatalogResponse(response)).toThrow('spineAffinities must be');
  });

  it('rejects a spineAffinities array with an unknown spine code', () => {
    const response = validResponse();
    (response.catalog.entries[0] as { spineAffinities: unknown }).spineAffinities = ['ZZ'];
    expect(() => parseSectionCatalogResponse(response)).toThrow('spineAffinities must be');
  });

  it('throws naming the failing rights sub-field', () => {
    const response = validResponse();
    (response.catalog.entries[0] as { rights: { license: unknown } }).rights.license = 'GPL';
    expect(() => parseSectionCatalogResponse(response)).toThrow('catalog.entries[0].rights.license is invalid');
  });

  it('throws when preview kind "local" has no artifactId', () => {
    const response = validResponse();
    (response.catalog.entries[0] as { preview: unknown }).preview = { kind: 'local' };
    expect(() => parseSectionCatalogResponse(response)).toThrow('catalog.entries[0].preview.artifactId must be a string');
  });

  it('throws when content kind "family-section" is missing sectionId', () => {
    const response = validResponse();
    (response.catalog.entries[0] as { content: unknown }).content = { kind: 'family-section', family: 'watson' };
    expect(() => parseSectionCatalogResponse(response)).toThrow('catalog.entries[0].content.sectionId must be a string');
  });

  it('rejects an unknown key on rights (mirrors the schema\'s additionalProperties: false)', () => {
    const response = validResponse();
    (response.catalog.entries[0] as { rights: unknown }).rights = {
      license: 'MIT', decision: 'bundle', evidence: 'x', extra: 1,
    };
    expect(() => parseSectionCatalogResponse(response)).toThrow('catalog.entries[0].rights.extra is not a known property');
  });

  it('rejects an unknown key on preview', () => {
    const response = validResponse();
    (response.catalog.entries[0] as { preview: unknown }).preview = { kind: 'none', extra: 1 };
    expect(() => parseSectionCatalogResponse(response)).toThrow('catalog.entries[0].preview.extra is not a known property');
  });

  it('rejects an unknown key on content', () => {
    const response = validResponse();
    (response.catalog.entries[0] as { content: unknown }).content = {
      kind: 'vendored-block', blockId: 'a/b/1', sha256: 'a'.repeat(64), extra: 1,
    };
    expect(() => parseSectionCatalogResponse(response)).toThrow('catalog.entries[0].content.extra is not a known property');
  });

  it('rejects an unknown key on the entry itself', () => {
    const response = validResponse();
    (response.catalog.entries[0] as unknown as Record<string, unknown>).extra = 1;
    expect(() => parseSectionCatalogResponse(response)).toThrow('catalog.entries[0].extra is not a known property');
  });

  it('rejects an unknown key on catalog', () => {
    const response = validResponse();
    (response.catalog as unknown as Record<string, unknown>).extra = 1;
    expect(() => parseSectionCatalogResponse(response)).toThrow('catalog.extra is not a known property');
  });

  it('rejects a vendored-block sha256 that is not 64 lowercase hex characters', () => {
    for (const sha256 of ['a'.repeat(63), 'A'.repeat(64), 'g'.repeat(64)]) {
      const response = validResponse();
      (response.catalog.entries[0] as { content: unknown }).content = { kind: 'vendored-block', blockId: 'a/b/1', sha256 };
      expect(() => parseSectionCatalogResponse(response)).toThrow('sha256 must be a 64-character lowercase hex string');
    }
  });

  it('accepts a vendored-block content with an adapterId', () => {
    const response = validResponse();
    (response.catalog.entries[0] as { content: unknown }).content = {
      kind: 'vendored-block', blockId: 'a/b/1', adapterId: 'ctas-1-v1', sha256: 'a'.repeat(64),
    };
    expect(() => parseSectionCatalogResponse(response)).not.toThrow();
  });

  describe('policy invariants (delta audit #3: shape-valid is not enough)', () => {
    it('rejects a "motionsites-prompt" entry that claims rights.decision "bundle" (a compromised/buggy daemon handing the web a bundleable proprietary prompt)', () => {
      const bad = { ...motionSitesEntry(), rights: { ...motionSitesEntry().rights, decision: 'bundle' as const } };
      const response: SectionCatalogResponse = { catalog: { schema: 'section-catalog/1', entries: [bad] } };
      expect(() => parseSectionCatalogResponse(response)).toThrow('requires rights.decision "metadata-only"');
    });

    it('rejects a "motionsites-prompt" entry with preview.kind "local" (never a locally hosted copy of the source preview)', () => {
      const bad = { ...motionSitesEntry(), preview: { kind: 'local' as const, artifactId: 'x' } };
      const response: SectionCatalogResponse = { catalog: { schema: 'section-catalog/1', entries: [bad] } };
      expect(() => parseSectionCatalogResponse(response)).toThrow('requires preview.kind "external-link"');
    });

    it('rejects a "hyperui" entry whose content is not a vendored-block', () => {
      const bad = { ...validEntry(), content: { kind: 'family-section' as const, family: 'watson', sectionId: 'watson-hero' } };
      const response: SectionCatalogResponse = { catalog: { schema: 'section-catalog/1', entries: [bad] } };
      expect(() => parseSectionCatalogResponse(response)).toThrow('requires content.kind "vendored-block"');
    });

    it('rejects a "family-section" entry with spineAffinities "any" (never a cross-family candidate)', () => {
      const bad = { ...familySectionEntry(), spineAffinities: 'any' as const };
      const response: SectionCatalogResponse = { catalog: { schema: 'section-catalog/1', entries: [bad] } };
      expect(() => parseSectionCatalogResponse(response)).toThrow('may not carry spineAffinities "any"');
    });

    it('rejects a "family-section" entry with availability other than "reference-only"', () => {
      const bad = { ...familySectionEntry(), availability: 'insertable' as const };
      const response: SectionCatalogResponse = { catalog: { schema: 'section-catalog/1', entries: [bad] } };
      expect(() => parseSectionCatalogResponse(response)).toThrow('requires availability "reference-only"');
    });

    it('rejects sectionKind "page-composition" on a HyperUI or family-section entry', () => {
      for (const entry of [validEntry(), familySectionEntry()]) {
        const bad = { ...entry, sectionKind: 'page-composition' as const };
        const response: SectionCatalogResponse = { catalog: { schema: 'section-catalog/1', entries: [bad] } };
        expect(() => parseSectionCatalogResponse(response)).toThrow('only describes a whole landing page');
      }
    });

    it('accepts sectionKind "page-composition" on a local-corpus full-page row and a Cult page (same rule as the server)', () => {
      const entries = [{ ...localCorpusEntry(), sectionKind: 'page-composition' as const }, { ...cultEntry(), sectionKind: 'page-composition' as const }];
      expect(() => parseSectionCatalogResponse({ catalog: { schema: 'section-catalog/1', entries } })).not.toThrow();
    });

    it('rejects availability "insertable" on a non-vendored-block entry (motionsites-prompt has no per-sourceKind availability rule of its own)', () => {
      const bad = { ...motionSitesEntry(), availability: 'insertable' as const };
      const response: SectionCatalogResponse = { catalog: { schema: 'section-catalog/1', entries: [bad] } };
      expect(() => parseSectionCatalogResponse(response)).toThrow('availability "insertable" requires content.kind "vendored-block"');
    });
  });

  describe('cult-pro entries', () => {
    const one = (entry: unknown): SectionCatalogResponse => ({ catalog: { schema: 'section-catalog/1', entries: [entry as SectionCatalogEntry] } });

    it('accepts a catalogued Cult section', () => {
      expect(() => parseSectionCatalogResponse(one(cultEntry()))).not.toThrow();
    });

    it('rejects a Cult entry whose rights are not the recorded licence', () => {
      expect(() => parseSectionCatalogResponse(one({ ...cultEntry(), rights: { license: 'licensed', decision: 'metadata-only', evidence: 'docs/legal/cult-ui-pro-rights.md' } })))
        .toThrow('sourceKind "cult-pro" requires rights');
      expect(() => parseSectionCatalogResponse(one({ ...cultEntry(), rights: { license: 'licensed', decision: 'bundle', evidence: 'elsewhere.md' } })))
        .toThrow('sourceKind "cult-pro" requires rights');
    });

    it('rejects rights.license "licensed" on a non-Cult entry', () => {
      expect(() => parseSectionCatalogResponse(one({ ...validEntry(), rights: { license: 'licensed', decision: 'bundle', evidence: 'x' } })))
        .toThrow('reserved for sourceKind "cult-pro"');
    });

    it('accepts an insertable Cult section that names its own checked adapter', () => {
      const content = cultEntry().content as Extract<SectionCatalogEntry['content'], { kind: 'cult-item' }>;
      const insertable = { ...cultEntry(), availability: 'insertable', content: { ...content, adapterId: 'cult:marketing-pricing-vercel' } };
      expect(() => parseSectionCatalogResponse(one(insertable))).not.toThrow();
      expect(() => parseSectionCatalogResponse(one({ ...insertable, content: { ...content, adapterId: 'cult:other' } }))).toThrow('must equal the entry id');
      expect(() => parseSectionCatalogResponse(one({ ...insertable, content: { ...content, adapterId: 'hyperui:x' } }))).toThrow('adapterId must match');
      expect(() => parseSectionCatalogResponse(one({ ...insertable, availability: 'adapter-needed' }))).toThrow('exactly when content.adapterId');
      expect(() => parseSectionCatalogResponse(one({ ...insertable, sectionKind: 'page-composition' }))).toThrow('never insertable');
    });

    it('rejects a Cult entry marked insertable without an adapter, or with a non-local access tier', () => {
      expect(() => parseSectionCatalogResponse(one({ ...cultEntry(), availability: 'insertable' }))).toThrow('exactly when content.adapterId');
      expect(() => parseSectionCatalogResponse(one({ ...cultEntry(), access: 'paid-account' }))).toThrow('requires access "local"');
    });

    it('rejects cult-item content on another source, and other content on a Cult entry', () => {
      expect(() => parseSectionCatalogResponse(one({ ...validEntry(), availability: 'adapter-needed', content: cultEntry().content })))
        .toThrow('requires content.kind "vendored-block"');
      expect(() => parseSectionCatalogResponse(one({ ...cultEntry(), content: validEntry().content }))).toThrow('requires content.kind "cult-item"');
    });

    it('rejects a malformed or mismatched provenance, and unknown content keys', () => {
      const content = cultEntry().content as Extract<SectionCatalogEntry['content'], { kind: 'cult-item' }>;
      expect(() => parseSectionCatalogResponse(one({ ...cultEntry(), content: { ...content, provenance: { ...content.provenance, snapshotId: 'latest' } } })))
        .toThrow('provenance.snapshotId');
      expect(() => parseSectionCatalogResponse(one({ ...cultEntry(), content: { ...content, provenance: { ...content.provenance, cultId: 'cult:other' } } })))
        .toThrow('must equal the entry id');
      expect(() => parseSectionCatalogResponse(one({ ...cultEntry(), content: { ...content, html: '<p>' } }))).toThrow('is not a known property');
      expect(() => parseSectionCatalogResponse(one({ ...cultEntry(), content: { ...content, summary: '' } }))).toThrow('summary must be a non-empty string');
    });
  });

  describe('untrusted-input boundary must be at least as strict as the schema (delta audit #4/#5/#6)', () => {
    it('rejects a preview.external-link url that is not "https://" (e.g. a javascript: scheme)', () => {
      const bad = { ...validEntry(), preview: { kind: 'external-link' as const, url: 'javascript:alert(1)' } };
      const response: SectionCatalogResponse = { catalog: { schema: 'section-catalog/1', entries: [bad] } };
      expect(() => parseSectionCatalogResponse(response)).toThrow('must be an "https://" URL');
    });

    it('rejects a motion-prompt content url that is not "https://"', () => {
      const bad = { ...motionSitesEntry(), content: { kind: 'motion-prompt' as const, remoteId: 'x', url: 'javascript:alert(1)' } };
      const response: SectionCatalogResponse = { catalog: { schema: 'section-catalog/1', entries: [bad] } };
      expect(() => parseSectionCatalogResponse(response)).toThrow('must be an "https://" URL');
    });

    it('rejects a family-section content.family that does not match the schema\'s id pattern (e.g. a path traversal segment)', () => {
      const bad = { ...familySectionEntry(), content: { kind: 'family-section' as const, family: '../../etc', sectionId: 'watson-hero' } };
      const response: SectionCatalogResponse = { catalog: { schema: 'section-catalog/1', entries: [bad] } };
      expect(() => parseSectionCatalogResponse(response)).toThrow('.content.family must match');
    });

    it('rejects an empty rights.evidence', () => {
      const bad = { ...validEntry(), rights: { ...validEntry().rights, evidence: '' } };
      const response: SectionCatalogResponse = { catalog: { schema: 'section-catalog/1', entries: [bad] } };
      expect(() => parseSectionCatalogResponse(response)).toThrow('.rights.evidence must be a non-empty string');
    });
  });
});
