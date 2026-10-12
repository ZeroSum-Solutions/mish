import { readFile } from 'node:fs/promises';
import { expect, test } from 'vitest';
import { parseRubric } from '../../benchmarks/quality/judge.ts';
import { digest } from '../../benchmarks/quality/api.ts';

const ids = ['artDirection', 'imagery', 'typography', 'layout', 'briefFidelity', 'craft', 'responsive', 'accessibility'];
const markdown = () => readFile(new URL('../../../docs/quality/agency-bar.md', import.meta.url), 'utf8');
const source = () => import('../../benchmarks/quality/bar.ts');
const scores = (value = 5) => Object.fromEntries(ids.map(id => [id, value]));

test('publishes the approved eight-criterion release candidate', async () => {
  const rubric = parseRubric(await markdown());
  expect(rubric.version).toBe('agency-bar/2.0.0-rc1');
  expect(rubric.status).toBe('approved');
  expect(rubric.criteria.map(item => item.id)).toEqual(ids);
  const { AGENCY_BAR } = await source();
  expect(AGENCY_BAR.criteria.map(item => item.weight)).toEqual([2, 2, 1.5, 1.5, 1, 1, 1, 1]);
  expect(AGENCY_BAR.criteria.reduce((sum, item) => sum + item.weight, 0)).toBe(11);
  expect(new Set(ids).size).toBe(8);
  for (const criterion of rubric.criteria) {
    expect(Object.keys(criterion.anchors)).toEqual(['1', '2', '3', '4', '5']);
    expect(Object.values(criterion.anchors).every(anchor => anchor.trim().length > 0)).toBe(true);
  }
});

test('generated markdown and the judge block have no drift; version bumps change the digest', async () => {
  const { AGENCY_BAR, renderAgencyBarMarkdown } = await source();
  const text = await markdown();
  expect(text).toBe(renderAgencyBarMarkdown());
  expect(parseRubric(text)).toEqual(AGENCY_BAR);
  expect(digest(text)).not.toBe(digest(text.replace(AGENCY_BAR.version, 'agency-bar/2.0.0-rc2')));
  expect(text).toMatch(/freezes at the end of QT-4/);
  expect(text).toMatch(/No baseline is taken before then/);
});

test.each([[5, 'A'], [4.2, 'A'], [4.199, 'B'], [3.5, 'B'], [2.5, 'C'], [2.4, 'D'], [1.8, 'D'], [1.4, 'E'], [1.399, 'F']] as const)('bands a mean of %s as %s using section 2.5', async (mean, grade) => {
  expect((await source()).bandForMean(mean)).toBe(grade);
});

test('all 5s with complete eligibility evidence recommend A without accepting anything', async () => {
  const { AGENCY_BAR, rollUp } = await source();
  const eligibility = AGENCY_BAR.eligibility.map(item => ({ id: item.id, outcome: 'pass' as const, evidence: ['fixture:measured'] }));
  const result = rollUp(scores(), eligibility);
  expect(result).toMatchObject({ M: 5, band: 'A', cappedBand: 'A', recommendedGrade: 'A', eligibilityOutcome: 'pass', caps: [], reasons: [] });
  expect(result).not.toHaveProperty('accepted');
});

test.each([
  ['artDirection', 3, 'B', 'art-direction-minimum'],
  ['imagery', 3, 'B', 'imagery-minimum'],
  ['responsive', 2, 'B', 'criterion-minimum'],
  ['briefFidelity', 1, 'D', 'invented-fact'],
  ['imagery', 1, 'C', 'missing-imagery'],
] as const)('caps %s=%s at %s', async (id, value, grade, cap) => {
  const { AGENCY_BAR, rollUp } = await source();
  const result = rollUp({ ...scores(), [id]: value }, AGENCY_BAR.eligibility.map(item => ({ id: item.id, outcome: 'pass' as const, evidence: ['fixture:measured'] })));
  expect(result.band).toBe('A');
  expect(result.recommendedGrade).toBe(grade);
  expect(result.caps.map(item => item.id)).toContain(cap);
});

test('the lowest cap wins', async () => {
  const { AGENCY_BAR, rollUp } = await source();
  const result = rollUp({ ...scores(), imagery: 1, briefFidelity: 1 }, AGENCY_BAR.eligibility.map(item => ({ id: item.id, outcome: 'pass' as const, evidence: ['fixture:measured'] })));
  expect(result.cappedBand).toBe('D');
});

test('each eligibility failure returns ineligible, its evidence and no A', async () => {
  const { AGENCY_BAR, rollUp } = await source();
  for (const failed of AGENCY_BAR.eligibility) {
    const result = rollUp(scores(), AGENCY_BAR.eligibility.map(item => ({ id: item.id, outcome: item.id === failed.id ? 'fail' as const : 'pass' as const, evidence: ['fixture:region'], reason: 'Confirmed defect' })));
    expect(result.recommendedGrade).toBe('ineligible');
    expect(result.cappedBand).toBe('B');
    expect(result.reasons).toContainEqual({ id: failed.id, outcome: failed.id === 'required-evidence' ? 'inconclusive' : 'fail', evidence: ['fixture:region'], reason: 'Confirmed defect' });
  }
});

test('missing, unread or uncited eligibility evidence stays inconclusive', async () => {
  const { AGENCY_BAR, rollUp } = await source();
  const complete = AGENCY_BAR.eligibility.map(item => ({ id: item.id, outcome: 'pass' as const, evidence: ['fixture:measured'] }));
  for (const eligibility of [[], complete.slice(1), complete.map(item => ({ ...item, evidence: [] })), complete.map(item => ({ ...item, outcome: 'inconclusive' as const }))]) {
    expect(rollUp(scores(), eligibility)).toMatchObject({ recommendedGrade: 'ineligible', eligibilityOutcome: 'inconclusive' });
  }
  const missingEvidence = complete.map(item => item.id === 'required-evidence' ? { ...item, outcome: 'fail' as const } : item);
  expect(rollUp(scores(), missingEvidence).eligibilityOutcome).toBe('inconclusive');
});

test('refuses invalid scores and unknown or duplicate eligibility ids', async () => {
  const { rollUp } = await source();
  for (const invalid of [{}, { ...scores(), craft: 2.5 }, { ...scores(), imagery: 6 }, { ...scores(), typography: NaN }, { ...scores(), extra: 3 }]) {
    expect(() => rollUp(invalid, [])).toThrow(/score/i);
  }
  expect(() => rollUp(scores(), [{ id: 'unknown', outcome: 'pass', evidence: ['fixture'] }] as never)).toThrow(/eligibility/i);
  expect(() => rollUp(scores(), [{ id: 'required-evidence', outcome: 'pass', evidence: ['fixture'] }, { id: 'required-evidence', outcome: 'pass', evidence: ['fixture'] }])).toThrow(/eligibility/i);
});

// Catch style mandates without banning conditional motion guidance or optionality.
const bannedPhrases = [/requires? (?:multiple|two|2|at least two) (?:font families|typefaces)/iu, /must (?:use|have) (?:multiple|two|2) (?:font families|typefaces)/iu, /(?:at least|minimum of|requires?) \d+ (?:layouts|sections|grids)/iu, /(?:requires?|must (?:use|have|include)) (?:animation|motion)/iu];
const lint = (anchor: string) => bannedPhrases.some(phrase => phrase.test(anchor));
test('anchor language never mandates font counts, layout counts or motion', async () => {
  const { AGENCY_BAR } = await source();
  for (const criterion of AGENCY_BAR.criteria) for (const anchor of Object.values(criterion.anchors)) expect(lint(anchor), anchor).toBe(false);
  for (const bad of ['Requires multiple font families', 'Must use two typefaces', 'At least 3 layouts', 'Minimum of 5 sections', 'Requires animation', 'Must include motion']) expect(lint(bad)).toBe(true);
});

test('a static single-family compact design can earn 5 for type, layout and craft', async () => {
  const { AGENCY_BAR, rollUp } = await source();
  const notes = AGENCY_BAR.criteria.filter(item => ['typography', 'layout', 'craft'].includes(item.id)).flatMap(item => item.notes).join(' ');
  expect(notes).toContain('One well-used family can score 5.');
  expect(notes).toContain('No fixed layout count');
  expect(notes).toContain('Motion is optional. A static design can earn A.');
  expect(rollUp(scores(), AGENCY_BAR.eligibility.map(item => ({ id: item.id, outcome: 'pass' as const, evidence: ['static single-family compact fixture'] }))).recommendedGrade).toBe('A');
});
