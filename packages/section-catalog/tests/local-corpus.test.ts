import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { importLocalCorpus, resolveLocalCorpusText, type LocalCorpusRow } from '../src/local-corpus.ts';
import { sectionCatalogPolicyIssues } from '../src/validate.ts';
import { SECTION_CATALOG_SCHEMA } from '../src/types.ts';

const fixtureDir = path.dirname(fileURLToPath(import.meta.url));

function loadFixture(name: string): LocalCorpusRow[] {
  return JSON.parse(readFileSync(path.join(fixtureDir, 'fixtures', name), 'utf8')) as LocalCorpusRow[];
}

const sample = loadFixture('local-corpus-sample.json');

// The sample fixture is entirely invented for this test (see its own file); none of it is real
// ZeroSum kit text or real MotionSites prompt text.

describe('importLocalCorpus', () => {
  it('ships only the one zerosum/rewritten/non-empty-our_text row out of three', () => {
    const { entries, skipped } = importLocalCorpus(sample);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.id).toBe('zerosum-kit:zs-fixture-hero');
    expect(skipped).toHaveLength(2);
  });

  it('refuses a non-zerosum, non-approved, our_text-less row (a real "raw" harvested row)', () => {
    const { skipped } = importLocalCorpus(sample);
    const harvested = skipped.find((issue) => issue.row === 'harvested-fixture-01');
    expect(harvested).toBeDefined();
    // our_text is empty on this row, which is checked (and reported) before origin/status — see
    // the next test for the origin/status rule on its own, with our_text populated.
    expect(harvested!.reason).toMatch(/our_text/);
  });

  it('refuses a non-zerosum row with our_text, regardless of status — no approved carve-out', () => {
    const pending: LocalCorpusRow = {
      ...sample[1]!,
      id: 'harvested-fixture-pending',
      status: 'pending-review',
      our_text: 'Invented fixture-only pending rewrite text for this test.',
    };
    const { entries, skipped } = importLocalCorpus([pending]);
    expect(entries).toHaveLength(0);
    expect(skipped[0]!.reason).toMatch(/refused unconditionally/);
  });

  it('unconditionally refuses any row carrying an original_text key, even a zerosum row with our_text', () => {
    const { skipped, entries } = importLocalCorpus(sample);
    const tainted = skipped.find((issue) => issue.row === 'zs-fixture-tainted');
    expect(tainted).toBeDefined();
    expect(tainted!.reason).toMatch(/original_text/);
    expect(entries.some((entry) => entry.id.includes('tainted'))).toBe(false);
  });

  it('never puts our_text into the produced entry', () => {
    const { entries } = importLocalCorpus(sample);
    const serialized = JSON.stringify(entries);
    for (const row of sample) {
      if (row.our_text) expect(serialized).not.toContain(row.our_text);
    }
  });

  it('refuses a non-zerosum row even when status is "approved" and our_text is non-empty (no rewrite carve-out)', () => {
    // Regression for the delta-audit BLOCK finding: an earlier version of rejectReason accepted
    // this exact shape — origin !== 'zerosum', status: 'approved', our_text populated — as a
    // "human explicitly signed off this rewrite" carve-out. The design doc (§4) is explicit that
    // a same-content rewrite of scraped text does not clear rights and a purchase does not
    // authorize vendoring, so this shape must be refused unconditionally, full stop, with no
    // status/our_text combination that lets it through.
    const approved: LocalCorpusRow = {
      ...sample[1]!,
      id: 'harvested-fixture-approved',
      status: 'approved',
      our_text: 'Invented fixture-only approved rewrite text for this test.',
    };
    const { entries, skipped } = importLocalCorpus([approved]);
    expect(entries).toHaveLength(0);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.reason).toMatch(/refused unconditionally/);
  });

  it('accepts the zerosum shape: origin "zerosum", a reviewed status, non-empty our_text', () => {
    const { entries } = importLocalCorpus(sample);
    const shipped = entries.find((entry) => entry.id === 'zerosum-kit:zs-fixture-hero');
    expect(shipped).toBeDefined();
    expect(shipped!.rights.decision).toBe('bundle');
    expect(shipped!.rights.license).toBe('project-specific');
    // FIX 2 (delta audit): rights.evidence is specific per entry — carries the corpus id, origin,
    // and status, not a single shared string reused for every entry regardless of which row
    // produced it.
    expect(shipped!.rights.evidence).toContain('zs-fixture-hero');
    expect(shipped!.rights.evidence).toContain('origin: "zerosum"');
    expect(shipped!.rights.evidence).toContain('status: "rewritten"');
  });

  it('gives two different zerosum rows two different rights.evidence strings (not a shared constant)', () => {
    const second: LocalCorpusRow = { ...sample[0]!, id: 'zs-fixture-second', status: 'approved' };
    const { entries } = importLocalCorpus([...sample, second]);
    const first = entries.find((entry) => entry.id === 'zerosum-kit:zs-fixture-hero')!;
    const other = entries.find((entry) => entry.id === 'zerosum-kit:zs-fixture-second')!;
    expect(first.rights.evidence).not.toBe(other.rights.evidence);
    expect(other.rights.evidence).toContain('zs-fixture-second');
    expect(other.rights.evidence).toContain('status: "approved"');
  });

  it('rejects a zerosum row still in a non-reviewed status', () => {
    const draft: LocalCorpusRow = { ...sample[0]!, id: 'zs-fixture-draft', status: 'raw' };
    const { entries, skipped } = importLocalCorpus([draft]);
    expect(entries).toHaveLength(0);
    expect(skipped[0]!.reason).toMatch(/status "raw"/);
  });

  it('produces entries with sourceKind "local-corpus", sourceType "zerosum-kit", access "local", availability "reference-only"', () => {
    const { entries } = importLocalCorpus(sample);
    for (const entry of entries) {
      expect(entry.sourceKind).toBe('local-corpus');
      expect(entry.sourceType).toBe('zerosum-kit');
      expect(entry.access).toBe('local');
      expect(entry.availability).toBe('reference-only');
      expect(entry.content).toEqual({ kind: 'local-prompt', corpusId: expect.any(String) });
    }
  });

  it('maps slot to sectionKind per the coordination note', () => {
    const rows: LocalCorpusRow[] = [
      { ...sample[0]!, id: 'a', slot: 'proof' },
      { ...sample[0]!, id: 'b', slot: 'booking' },
      { ...sample[0]!, id: 'c', slot: 'full-page' },
      { ...sample[0]!, id: 'd', slot: 'component' },
      { ...sample[0]!, id: 'e', slot: 'unknown-future-slot' },
    ];
    const { entries } = importLocalCorpus(rows);
    const byId = Object.fromEntries(entries.map((entry) => [entry.id, entry]));
    expect(byId['zerosum-kit:a']!.sectionKind).toBe('stats-metrics');
    expect(byId['zerosum-kit:b']!.sectionKind).toBe('cta-band');
    expect(byId['zerosum-kit:c']!.sectionKind).toBe('page-composition');
    expect(byId['zerosum-kit:d']!.sectionKind).toBe('unclassified');
    expect(byId['zerosum-kit:e']!.sectionKind).toBe('unclassified');
  });

  it('classifies spine from use_case, falling back to vertical, then action "book", then unclassified', () => {
    const rows: LocalCorpusRow[] = [
      { ...sample[0]!, id: 'uc', use_case: 'saas-product', vertical: null, action: null },
      { ...sample[0]!, id: 'vert', use_case: null, vertical: 'commerce', action: null },
      { ...sample[0]!, id: 'book', use_case: null, vertical: null, action: 'book' },
      { ...sample[0]!, id: 'none', use_case: null, vertical: null, action: 'contact' },
    ];
    const { entries } = importLocalCorpus(rows);
    const byId = Object.fromEntries(entries.map((entry) => [entry.id, entry]));
    expect(byId['zerosum-kit:uc']!.spineAffinities).toEqual(['PA']);
    expect(byId['zerosum-kit:vert']!.spineAffinities).toEqual(['CO']);
    expect(byId['zerosum-kit:book']!.spineAffinities).toEqual(['BA']);
    expect(byId['zerosum-kit:none']!.spineAffinities).toBe('unclassified');
  });

  it('passes the same policy checks the build-time catalog runs', () => {
    const { entries } = importLocalCorpus(sample);
    expect(sectionCatalogPolicyIssues({ schema: SECTION_CATALOG_SCHEMA, entries })).toEqual([]);
  });
});

describe('resolveLocalCorpusText', () => {
  it('returns the shippable row\'s text by corpus id', () => {
    const text = resolveLocalCorpusText(sample, 'zs-fixture-hero');
    expect(text).toBe(sample[0]!.our_text);
  });

  it('returns null for a row that would be refused (e.g. the tainted row)', () => {
    expect(resolveLocalCorpusText(sample, 'zs-fixture-tainted')).toBeNull();
  });

  it('returns null for an unknown id', () => {
    expect(resolveLocalCorpusText(sample, 'not-a-real-id')).toBeNull();
  });
});

describe('the real shipped corpus (data/zerosum-local-corpus.json)', () => {
  it('imports cleanly with zero skipped rows and never carries original_text', () => {
    const real = JSON.parse(
      readFileSync(path.join(fixtureDir, '../data/zerosum-local-corpus.json'), 'utf8'),
    ) as LocalCorpusRow[];
    expect(real.some((row) => 'original_text' in row)).toBe(false);
    expect(real.every((row) => row.origin === 'zerosum')).toBe(true);
    const { entries, skipped } = importLocalCorpus(real);
    expect(skipped).toEqual([]);
    expect(entries.length).toBe(real.length);
    expect(sectionCatalogPolicyIssues({ schema: SECTION_CATALOG_SCHEMA, entries })).toEqual([]);
  });
});
