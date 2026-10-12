import { AGENCY_BAR, type CriterionId } from './bar.ts';
import { digest, safePath } from './api.ts';
import { CALIBRATION_LIMITATION, type CalibrationSet } from './calibration-sheet.ts';
import type { Grade, Judgment, Reviewer } from './types.ts';
const letters: Grade[] = ['A', 'B', 'C', 'D', 'E', 'F'];
const ids = AGENCY_BAR.criteria.map(c => c.id);
const validDate = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value) && Number.isFinite(Date.parse(value));
const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
const exactKeys = (value: object, allowed: string[]) => Object.keys(value).length === allowed.length && Object.keys(value).every(key => allowed.includes(key));
const keys = (value: unknown) => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === ids.length && ids.every(id => Object.hasOwn(value, id));
export interface CalibrationHuman {
  schema: 'quality-calibration-human/1'; setId: string; setDigest: string; rubricDigest: string; protocolDigest: string;
  rater: string; submittedAt: string;
  cases: Array<{ caseId: string; grade: Grade; criteria: Record<string, number | null>; evidence: Record<string, string>; note: string }>;
}
export interface CalibrationModel {
  schema: 'quality-calibration-model/1'; setDigest: string; humanDigests: string[]; rubricDigest: string; protocolDigest: string; judgeProtocolDigest: string;
  reviewers: Reviewer[]; startedAt: string; completedAt: string; mode: 'live' | 'stub';
  cases: Array<{ caseId: string; samples: Array<Judgment & { reviewer: string; index: number }> }>;
}
export function validateCalibrationSet(input: unknown): CalibrationSet {
  const set = input as CalibrationSet;
  if (!set || set.schema !== 'quality-calibration-set/1' || !text(set.setId) || !text(set.rubricDigest) || !text(set.protocolDigest) || !Array.isArray(set.items) || set.items.length < 8 || set.items.length > 12) throw new Error('Calibration needs a frozen set of 8 to 12 pages');
  if (!exactKeys(set, ['schema', 'setId', 'rubricDigest', 'protocolDigest', 'items'])) throw new Error('Private source fields are forbidden in the blind manifest');
  const seen = new Set<string>();
  const imageHashes = new Set<string>();
  for (const item of set.items) {
    if (!item || !/^P\d{2}$/u.test(item.id) || seen.has(item.id) || item.limitation !== CALIBRATION_LIMITATION || !exactKeys(item, ['id', 'screenshots', 'unavailable', 'limitation']) || !Array.isArray(item.unavailable) || new Set(item.unavailable).size !== item.unavailable.length || item.unavailable.some(id => !ids.includes(id)) || !Array.isArray(item.screenshots) || item.screenshots.length !== 2) throw new Error('Invalid or duplicate blind page');
    if (item.unavailable.length !== 3 || ['briefFidelity', 'craft', 'accessibility'].some(id => !item.unavailable.includes(id as CriterionId))) throw new Error('Screenshot-only criteria must remain not assessable');
    seen.add(item.id);
    for (const width of [1440, 390]) {
      const images = item.screenshots.filter(i => i.width === width);
      if (images.length !== 1) throw new Error('Every page needs 1440 and 390 full-page screenshots');
      const image = images[0]!;
      if (!Number.isSafeInteger(image.height) || image.height < (width === 1440 ? 900 : 844) || !/^[a-f0-9]{64}$/u.test(image.sha256) || typeof image.file !== 'string' || !image.file.endsWith('.png')) throw new Error('Invalid screenshot evidence');
      safePath(image.file);
      if (image.file !== `${item.id}-${width}.png` || !exactKeys(image, ['width', 'height', 'file', 'sha256']) || imageHashes.has(image.sha256)) throw new Error('Use unique blind screenshot filenames and bytes');
      imageHashes.add(image.sha256);
    }
  }
  return set;
}
export function validateSubmission(input: unknown, set: CalibrationSet, before: string): CalibrationHuman {
  const human = input as CalibrationHuman;
  if (!human || human.schema !== 'quality-calibration-human/1' || human.setId !== set.setId || human.setDigest !== digest(JSON.stringify(set)) || human.rubricDigest !== set.rubricDigest || human.protocolDigest !== set.protocolDigest) throw new Error('Human calibration identity differs');
  if (!text(human.rater) || human.rater.length > 100 || /[\x00-\x1f/|\[\]<>]/u.test(human.rater) || !validDate(human.submittedAt) || !validDate(before) || Date.parse(human.submittedAt) >= Date.parse(before)) throw new Error('Explicit blind submission must precede model judging');
  if (!Array.isArray(human.cases) || human.cases.length !== set.items.length) throw new Error('Incomplete submitted ratings');
  const seen = new Set<string>();
  for (const rating of human.cases) {
    const item = set.items.find(i => i.id === rating?.caseId);
    if (!item || seen.has(rating.caseId) || !letters.includes(rating.grade) || !keys(rating.criteria) || !keys(rating.evidence) || typeof rating.note !== 'string') throw new Error('Invalid or duplicate submitted page rating');
    seen.add(rating.caseId);
    for (const id of ids) {
      const value = rating.criteria[id];
      if (value !== null && (!Number.isInteger(value) || value! < 1 || value! > 5) || item.unavailable.includes(id) && value !== null || !text(rating.evidence[id])) throw new Error('Rate assessable criteria 1 to 5 with evidence; unsupported criteria must be null');
    }
  }
  return human;
}
const median = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); const n = sorted.length; return n ? (sorted[Math.floor((n - 1) / 2)]! + sorted[Math.floor(n / 2)]!) / 2 : null; };
const summary = (values: Array<number | null>) => {
  const scored = values.filter((v): v is number => v !== null);
  return { median: scored.length === values.length ? median(scored) : null, min: scored.length ? Math.min(...scored) : null, max: scored.length ? Math.max(...scored) : null, spread: scored.length > 1 ? Math.max(...scored) - Math.min(...scored) : null, count: scored.length, samples: values.length };
};
interface LetterDisagreement { id: string; caseId: string; rater: string; reviewer: string; humanGrade: Grade; modelGrade: Grade | null; gap: number | null; investigation: boolean }
export function validateCalibrationSample(sample: Judgment, item: CalibrationSet['items'][number]) {
  if (sample.grade !== null && !letters.includes(sample.grade) || !keys(sample.criteria) || !keys(sample.evidence) || !text(sample.note)) throw new Error('Invalid judge sample');
  for (const id of ids) {
    const score = sample.criteria[id];
    if (score !== null && (!Number.isInteger(score) || score! < 1 || score! > 5) || item.unavailable.includes(id) && score !== null || !text(sample.evidence?.[id])) throw new Error('Model must cite evidence and leave unsupported criteria null');
  }
}
export function calibrationAgreement(set: CalibrationSet, inputs: unknown[], input: unknown) {
  validateCalibrationSet(set);
  const model = input as CalibrationModel;
  if (!model || model.schema !== 'quality-calibration-model/1' || model.setDigest !== digest(JSON.stringify(set)) || model.rubricDigest !== set.rubricDigest || model.protocolDigest !== set.protocolDigest || !text(model.judgeProtocolDigest) || !validDate(model.startedAt) || !validDate(model.completedAt) || Date.parse(model.completedAt) < Date.parse(model.startedAt) || !['live', 'stub'].includes(model.mode) || !Array.isArray(model.reviewers) || model.reviewers.length !== 2 || model.reviewers[0]?.id !== 'claude' || model.reviewers[1]?.id !== 'codex' || !Array.isArray(model.cases) || model.cases.length !== set.items.length) throw new Error('Invalid or stale model calibration packet');
  const humans = inputs.map(h => validateSubmission(h, set, model.startedAt));
  if (!humans.length || new Set(humans.map(h => h.rater.trim().toLowerCase())).size !== humans.length) throw new Error('Missing or duplicate human raters');
  if (JSON.stringify(model.humanDigests) !== JSON.stringify(humans.map(h => digest(JSON.stringify(h))))) throw new Error('Submitted rating receipts differ');
  const seen = new Set<string>();
  const pages = model.cases.map(page => {
    const item = set.items.find(i => i.id === page?.caseId);
    if (!item || seen.has(page.caseId) || !Array.isArray(page.samples) || page.samples.length !== 6) throw new Error('Incomplete or duplicate model page/sample set');
    seen.add(page.caseId);
    const samples = new Set<string>();
    for (const sample of page.samples) {
      const key = `${sample.reviewer}/${sample.index}`;
      if (!model.reviewers.some(r => r.id === sample.reviewer) || ![0, 1, 2].includes(sample.index) || samples.has(key)) throw new Error('Invalid judge sample');
      samples.add(key);
      validateCalibrationSample(sample, item);
    }
    const criteria = Object.fromEntries(ids.map(id => [id, summary(page.samples.map(s => s.criteria[id]!))]));
    const reviewers = model.reviewers.map(r => {
      const values = page.samples.filter(s => s.reviewer === r.id);
      const ordinal = median(values.map(s => s.grade === null ? -1 : letters.indexOf(s.grade)));
      const grade = values.some(s => s.grade === null) ? null : letters[ordinal!]!;
      return { ...r, grade, sampleGrades: values.map(s => s.grade), criteria: Object.fromEntries(ids.map(id => [id, summary(values.map(s => s.criteria[id]!))])) };
    });
    return { caseId: page.caseId, criteria, reviewers, reviewerDisagreement: Object.fromEntries(ids.map(id => {
      const a = reviewers[0]!.criteria[id]!.median, b = reviewers[1]!.criteria[id]!.median;
      return [id, a === null || b === null ? null : Math.abs(a - b)];
    })) };
  });
  const assessabilityDisagreements: Array<{ id: string; caseId: string; rater: string; criterion: string; human: number | null; model: number | null }> = [];
  const disagreements: Array<{ id: string; caseId: string; rater: string; criterion: CriterionId; human: number; model: number; delta: number; evidence: string[] }> = [];
  const comparisons = humans.flatMap(h => h.cases.map(rating => {
    const page = pages.find(p => p.caseId === rating.caseId)!;
    const criteria = Object.fromEntries(ids.map(id => {
      const human = rating.criteria[id]!, m = page.criteria[id]!.median, delta = human === null || m === null ? null : m - human;
      if ((human === null) !== (m === null) || m === null && !set.items.find(i => i.id === rating.caseId)!.unavailable.includes(id)) assessabilityDisagreements.push({ id: `${h.rater}/${rating.caseId}/${id}/assessability`, caseId: rating.caseId, rater: h.rater, criterion: id, human, model: m });
      if (delta !== null && delta !== 0) disagreements.push({ id: `${h.rater}/${rating.caseId}/${id}`, caseId: rating.caseId, rater: h.rater, criterion: id, human: human!, model: m!, delta, evidence: model.cases.find(p => p.caseId === rating.caseId)!.samples.map(s => s.evidence![id]!) });
      return [id, { human, model: m, delta }];
    }));
    return { caseId: rating.caseId, rater: h.rater, humanGrade: rating.grade, criteria, note: rating.note };
  }));
  const letterDisagreements = humans.flatMap(h => h.cases.flatMap(rating => pages.find(p => p.caseId === rating.caseId)!.reviewers.flatMap<LetterDisagreement>(r => {
    if (r.grade === null) return [{ id: `${h.rater}/${rating.caseId}/${r.id}/letter`, caseId: rating.caseId, rater: h.rater, reviewer: r.id, humanGrade: rating.grade, modelGrade: null, gap: null, investigation: true }];
    const gap = Math.abs(letters.indexOf(rating.grade) - letters.indexOf(r.grade));
    return gap ? [{ id: `${h.rater}/${rating.caseId}/${r.id}/letter`, caseId: rating.caseId, rater: h.rater, reviewer: r.id, humanGrade: rating.grade, modelGrade: r.grade, gap, investigation: gap >= 2 }] : [];
  })));
  const criterionAgreement = Object.fromEntries(ids.map(id => {
    const values = comparisons.map(c => c.criteria[id]!).filter(c => c.delta !== null);
    return [id, { assessable: values.length, notAssessable: comparisons.length - values.length, exact: values.filter(v => v.delta === 0).length, withinOne: values.filter(v => Math.abs(v.delta!) <= 1).length, meanAbsoluteError: values.length ? values.reduce((n, v) => n + Math.abs(v.delta!), 0) / values.length : null }];
  }));
  const reviewerCriterionAgreement = Object.fromEntries(model.reviewers.map(reviewer => [reviewer.id, Object.fromEntries(ids.map(id => {
    const values = humans.flatMap(h => h.cases.flatMap(r => { const m = pages.find(p => p.caseId === r.caseId)!.reviewers.find(p => p.id === reviewer.id)!.criteria[id]!.median, human = r.criteria[id]!; return human === null || m === null ? [] : [m - human]; }));
    return [id, { assessable: values.length, exact: values.filter(v => v === 0).length, withinOne: values.filter(v => Math.abs(v) <= 1).length, meanAbsoluteError: values.length ? values.reduce((n, v) => n + Math.abs(v), 0) / values.length : null }];
  }))]));
  const reviewerDisagreements = pages.flatMap(page => Object.entries(page.reviewerDisagreement).filter(([, gap]) => gap !== null && gap >= 2).map(([criterion, gap]) => ({ id: `${page.caseId}/${criterion}/reviewers`, caseId: page.caseId, criterion, gap })));
  return { schema: 'quality-calibration-agreement/1', setId: set.setId, setDigest: model.setDigest, modelDigest: digest(JSON.stringify(model)), raterCount: humans.length, prdAcceptanceClaim: false, investigationRequired: letterDisagreements.some(d => d.investigation) || assessabilityDisagreements.length > 0 || reviewerDisagreements.length > 0, criterionAgreement, reviewerCriterionAgreement, assessabilityDisagreements, reviewerDisagreements, disagreements, letterDisagreements, comparisons, pages, uncertainty: 'Three samples per reviewer estimate judge spread only. One rater cannot establish AC-R15.4. Screenshot-only scores do not establish functional or factual quality. No expected grades were supplied.' };
}
export interface CalibrationResolution { reviewedBy: string; reviewedAt: string; agreementDigest: string; modelDigest: string; dispositions: Record<string, string> }
export function freezeCalibration(set: CalibrationSet, model: CalibrationModel, report: ReturnType<typeof calibrationAgreement>, review: CalibrationResolution) {
  if (model.mode !== 'live') throw new Error('Freeze requires live subscription evidence, never stub scores');
  if (report.modelDigest !== digest(JSON.stringify(model)) || report.setDigest !== digest(JSON.stringify(set))) throw new Error('Freeze report is stale');
  if (report.pages.some(page => ids.some(id => !set.items.find(i => i.id === page.caseId)!.unavailable.includes(id) && page.criteria[id]!.median === null)) || ids.some(id => !set.items.every(item => item.unavailable.includes(id)) && report.criterionAgreement[id]!.assessable === 0)) throw new Error('Cannot freeze inconclusive or unassessed model coverage');
  if (review?.agreementDigest !== digest(JSON.stringify(report)) || review?.modelDigest !== report.modelDigest) throw new Error('Human review is not bound to this agreement report');
  if (!text(review?.reviewedBy) || !validDate(review.reviewedAt) || Date.parse(review.reviewedAt) < Date.parse(model.completedAt) || !review.dispositions || typeof review.dispositions !== 'object') throw new Error('Explicit human review of calibration is required');
  for (const gap of [...report.disagreements, ...report.letterDisagreements, ...report.assessabilityDisagreements, ...report.reviewerDisagreements]) if (!text(review.dispositions[gap.id])) throw new Error(`Investigate and record disposition: ${gap.id}`);
  return { schema: 'quality-calibration-freeze/1', frozenAt: review.reviewedAt, reviewedBy: review.reviewedBy, rubricVersion: AGENCY_BAR.version, rubricDigest: set.rubricDigest, captureProtocolDigest: set.protocolDigest, judgeProtocolDigest: model.judgeProtocolDigest, reviewers: model.reviewers, sampleCount: 3, setDigest: report.setDigest, humanDigests: model.humanDigests, modelDigest: report.modelDigest, agreementDigest: digest(JSON.stringify(report)), resolution: review, prdAcceptanceClaim: false, changePolicy: 'Any change to anchors, weights, bands or caps requires a version bump, re-calibration and a new baseline. Capture or judge changes require a new calibration freeze.' };
}
