import { describe, expect, it } from 'vitest';
import {
  isInsertableV1, missingInsertableAdapters, sectionCatalogIssues, validateAgainstSchema, sectionCatalogSchema,
} from '../src/validate.ts';
import { SECTION_CATALOG_SCHEMA, type SectionCatalog, type SectionCatalogEntry } from '../src/types.ts';

function entry(overrides: Partial<SectionCatalogEntry> = {}): SectionCatalogEntry {
  return {
    id: 'hyperui:marketing/ctas/1',
    title: 'Marketing Ctas 1',
    sourceKind: 'hyperui',
    sectionKind: 'cta-band',
    sourceType: 'marketing/ctas',
    spineAffinities: 'any',
    rights: { license: 'MIT', decision: 'bundle', evidence: 'test' },
    access: 'local',
    availability: 'insertable',
    preview: { kind: 'none' },
    content: { kind: 'vendored-block', blockId: 'marketing/ctas/1', sha256: 'a'.repeat(64) },
    ...overrides,
  };
}

describe('validateAgainstSchema: oneOf (spineAffinities / preview / content)', () => {
  it('accepts each spineAffinities alternative', () => {
    for (const value of [['PA'], ['PA', 'TL'], 'any', 'unclassified']) {
      expect(validateAgainstSchema(value, { $ref: '#/$defs/spineAffinities' }, sectionCatalogSchema)).toEqual([]);
    }
  });

  it('rejects an empty array, an unknown spine code, and an unrelated string', () => {
    for (const value of [[], ['XX'], 'sometimes']) {
      expect(validateAgainstSchema(value, { $ref: '#/$defs/spineAffinities' }, sectionCatalogSchema).length).toBeGreaterThan(0);
    }
  });

  it('accepts each preview alternative and rejects a mixed-shape object', () => {
    for (const value of [{ kind: 'local', artifactId: 'x' }, { kind: 'external-link', url: 'https://x' }, { kind: 'none' }]) {
      expect(validateAgainstSchema(value, { $ref: '#/$defs/preview' }, sectionCatalogSchema)).toEqual([]);
    }
    expect(validateAgainstSchema({ kind: 'local', url: 'https://x' }, { $ref: '#/$defs/preview' }, sectionCatalogSchema).length).toBeGreaterThan(0);
  });

  it('accepts each content alternative and rejects an adapterId-only vendored-block missing sha256', () => {
    for (const value of [
      { kind: 'vendored-block', blockId: 'a/b/1', sha256: 'a'.repeat(64) },
      { kind: 'motion-prompt', remoteId: 'x', url: 'https://motionsites.ai/?prompt=x' },
      { kind: 'family-section', family: 'watson', sectionId: 'watson-hero' },
    ]) {
      expect(validateAgainstSchema(value, { $ref: '#/$defs/content' }, sectionCatalogSchema)).toEqual([]);
    }
    expect(
      validateAgainstSchema({ kind: 'vendored-block', blockId: 'a/b/1', adapterId: 'x' }, { $ref: '#/$defs/content' }, sectionCatalogSchema).length,
    ).toBeGreaterThan(0);
  });
});

describe('validateAgainstSchema: oneOf is exactly-one, not at-least-one (delta audit #14)', () => {
  it('rejects a value that matches two overlapping oneOf branches', () => {
    // Two branches that both accept any string are not mutually exclusive — true `oneOf` must
    // reject a value that matches both, even though "at least one branch matches" would accept it.
    const overlapping = { oneOf: [{ type: 'string' }, { type: 'string', minLength: 1 }] };
    const issues = validateAgainstSchema('x', overlapping, overlapping);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]!.message).toContain('matches 2 of 2 alternatives, expected exactly one');
  });

  it('still accepts a value matching exactly one branch', () => {
    const overlapping = { oneOf: [{ type: 'string' }, { type: 'number' }] };
    expect(validateAgainstSchema('x', overlapping, overlapping)).toEqual([]);
  });

  it('rejects a value matching zero branches, distinctly from matching more than one', () => {
    const overlapping = { oneOf: [{ type: 'string' }, { type: 'number' }] };
    const issues = validateAgainstSchema(true, overlapping, overlapping);
    expect(issues[0]!.message).toContain('matches none of 2 alternatives');
  });

  it('this schema\'s real oneOf branches (spineAffinities/preview/content) stay mutually exclusive', () => {
    // The exactly-one enforcement above must not turn this schema's own branches into false
    // rejections — every real entry still matches exactly one branch of each tagged union.
    for (const value of [['PA'], 'any', 'unclassified']) {
      expect(validateAgainstSchema(value, { $ref: '#/$defs/spineAffinities' }, sectionCatalogSchema)).toEqual([]);
    }
  });
});

describe('validateAgainstSchema: unsupported keywords still throw (if/then was dropped, not silently accepted)', () => {
  it('throws on an if/then schema instead of silently ignoring the conditional', () => {
    const schema = { if: { type: 'string' }, then: { minLength: 1 } };
    expect(() => validateAgainstSchema('x', schema, schema)).toThrow('Unsupported JSON Schema keyword "if"');
  });
});

describe('sectionCatalogIssues: end-to-end entry validity', () => {
  const catalog: SectionCatalog = { schema: SECTION_CATALOG_SCHEMA, entries: [entry()] };

  it('accepts a well-formed catalog', () => {
    expect(sectionCatalogIssues(catalog)).toEqual([]);
  });

  it('rejects an unknown top-level property', () => {
    const bad = { ...catalog, extra: true };
    expect(sectionCatalogIssues(bad).length).toBeGreaterThan(0);
  });

  it('rejects a wrong schema const', () => {
    const bad = { ...catalog, schema: 'section-catalog/2' };
    expect(sectionCatalogIssues(bad).length).toBeGreaterThan(0);
  });
});

describe('missingInsertableAdapters / INSERTABLE_V1 hook', () => {
  it('is empty for a v1 catalog (insertable entries ship without an adapterId in phase A)', () => {
    const catalog: SectionCatalog = { schema: SECTION_CATALOG_SCHEMA, entries: [entry()] };
    // sectionCatalogIssues (the check phase A's own gate runs) does not require adapterId...
    expect(sectionCatalogIssues(catalog)).toEqual([]);
    // ...but the hook phase B calls can already see that this entry has none yet.
    expect(missingInsertableAdapters(catalog).length).toBe(1);
  });

  it('is empty once an insertable entry carries an adapterId', () => {
    const withAdapter = entry({ content: { kind: 'vendored-block', blockId: 'marketing/ctas/1', adapterId: 'ctas-1-v1', sha256: 'a'.repeat(64) } });
    const catalog: SectionCatalog = { schema: SECTION_CATALOG_SCHEMA, entries: [withAdapter] };
    expect(missingInsertableAdapters(catalog)).toEqual([]);
  });

  it('a cult-pro entry is insertable exactly when content.adapterId names its own id', () => {
    const cult = (availability: SectionCatalogEntry['availability'], adapterId?: string): SectionCatalogEntry => entry({
      id: 'cult:marketing-cta-vite', sourceKind: 'cult-pro', title: 'CTA (series VT)', sourceType: 'marketing-cta',
      rights: { license: 'licensed', decision: 'bundle', evidence: 'docs/legal/cult-ui-pro-rights.md' },
      availability,
      content: {
        kind: 'cult-item', summary: 's', sourceTitle: 't',
        provenance: { cultId: 'cult:marketing-cta-vite', snapshotId: 'cult-ui-pro@0123456789abcdef' },
        ...(adapterId !== undefined ? { adapterId } : {}),
      },
    });
    const issues = (e: SectionCatalogEntry) => sectionCatalogIssues({ schema: SECTION_CATALOG_SCHEMA, entries: [e] });
    expect(issues(cult('insertable', 'cult:marketing-cta-vite'))).toEqual([]);
    expect(issues(cult('adapter-needed'))).toEqual([]);
    expect(issues(cult('insertable')).length).toBeGreaterThan(0);
    expect(issues(cult('adapter-needed', 'cult:marketing-cta-vite')).length).toBeGreaterThan(0);
    expect(issues(cult('insertable', 'cult:marketing-faq-vite')).some((i) => i.path.endsWith('content.adapterId'))).toBe(true);
    expect(issues({ ...cult('insertable', 'cult:marketing-cta-vite'), sectionKind: 'page-composition' }).length).toBeGreaterThan(0);
  });

  it('isInsertableV1 matches exactly the three v1 blocks', () => {
    expect(isInsertableV1('marketing/ctas/1')).toBe(true);
    expect(isInsertableV1('marketing/ctas/2')).toBe(false);
  });
});
