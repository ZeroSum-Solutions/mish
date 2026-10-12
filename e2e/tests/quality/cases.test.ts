import { expect, test } from 'vitest';
import { CASES, selectCases } from '../../benchmarks/quality/cases.ts';
import { digest } from '../../benchmarks/quality/api.ts';
import { BRIGHTWATER_SOURCE_BRIEF, FROZEN_BRIEF_HASHES } from '../../resources/quality-fixtures.ts';

test('keeps development cases structured and retains the exact Brightwater source', async () => {
  expect(CASES.slice(0, 5).map(item => item.id)).toEqual(['dental', 'restaurant', 'law', 'saas', 'fitness']);
  for (const item of selectCases()) {
    expect(item.split).toBe('dev');
    expect(Object.keys(item.suppliedFacts).length).toBeGreaterThan(0);
    expect(item.omittedFacts.length).toBeGreaterThan(0);
    expect(item.conversion.action).toBeTruthy();
    expect(item.conversion.labels.length).toBeGreaterThan(0);
  }
  const brightwater = selectCases('brightwater')[0]!;
  expect(brightwater.sourcePath).toContain('atlas-ui/evidence.json');
  expect(brightwater.brief).toBe(BRIGHTWATER_SOURCE_BRIEF);
});

test('facts, omitted facts and conversion changes invalidate the fixture digest', () => {
  const original = selectCases('dental');
  for (const field of ['brief', 'suppliedFacts', 'omittedFacts', 'conversion'] as const) {
    const changed = structuredClone(original) as unknown as Array<Record<string, unknown>>;
    changed[0]![field] = 'changed';
    expect(digest(JSON.stringify(changed))).not.toBe(digest(JSON.stringify(original)));
  }
});

test('preserves each original frozen brief byte for byte and selects development by default', async () => {
  expect(CASES.slice(0, 5).map(item => digest(item.brief))).toEqual(FROZEN_BRIEF_HASHES);
  expect(selectCases().every(item => item.split === 'dev')).toBe(true);
  expect(() => selectCases(undefined, undefined, 'unseen')).toThrow(/unknown case/i);
});
