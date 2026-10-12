import { describe, expect, it } from 'vitest';
import {
  parseProjectRubricDraft, reviewCheckVerdictSchema, WORKBENCH_MANDATORY_CRITERION_IDS,
  type MechanicalCheckResult, type ObservedBehaviorRecord, type ProjectDesignContext, type ProjectRubric, type ReviewerRecord, type ReviewFinding,
} from '@mish/contracts';
import {
  CHECKLIST_ANCHORS, CHECKLIST_CRITERIA, CHECKLIST_CRITERIA_VERSION, CHECKLIST_SOURCE, checklistRubricCheck, ChecklistSelectionError, validateChecklistSelection,
} from '../../src/workbench/review/checklist-criteria.js';
import { computeCheckVerdicts, verdictBlockers } from '../../src/workbench/review/check-verdicts.js';
import { JUDGMENT_DIMENSIONS, JUDGMENT_SEEDS_VERSION, seedJudgmentChecks } from '../../src/workbench/review/judgment-seeds.js';
import { aggregateReviewRun } from '../../src/workbench/review/run-aggregate.js';
import { effectiveChecks, planChecks } from '../../src/workbench/review/reviewer-plan.js';
import { summarizeObservedBehaviors } from '../../src/workbench/review/observed-behaviors.js';
import { observedBehaviorRecordSchema, renderReviewEvidenceMessage } from '@mish/contracts';
import { PageText } from '../../src/workbench/review/evidence.js';
import { knownGoodCapture } from './review-capture-fixture.js';

type RubricCheck = ProjectRubric['checks'][number];
const at = '2026-10-08T09:00:00.000Z';
function rubricOf(checks: RubricCheck[], revision = 3): ProjectRubric {
  return { schema: 'workbench-rubric/1', projectId: 'p', revision, updatedAt: at, contextRevision: 1, checks };
}
function contextOf(styleDirection?: string): ProjectDesignContext {
  return {
    schema: 'workbench-context/1', projectId: 'p', revision: 1, updatedAt: at, purpose: null, audience: [], conversions: [], brandDirection: null,
    ...(styleDirection ? { styleDirection } : {}), constraints: [], factSources: styleDirection ? [{ fieldPath: '/styleDirection', value: styleDirection, origin: 'user-confirmed', source: null, confidence: null, rationale: 'Owner said so' }] : [],
    assumptions: ['Unknown purpose'],
  };
}
const manualCheck = (checkId: string, required: boolean): RubricCheck => ({
  checkId, kind: 'manual', required, severity: 'high', requiredBasis: required ? { type: 'project-acceptance', requirementId: 'target-device', rationale: 'Owner requires a device pass' } : null,
  provenance: { origin: 'user-confirmed', derivation: 'project-input', source: null, rationale: 'Owner asked' },
  evidenceTypes: ['manual-observation'], sourceCriteria: [],
  parameters: { type: 'manual-procedure', procedure: 'Book an appointment on an iPhone SE with VoiceOver', environment: 'iOS 19 Safari' },
});
const result = (checkId: string, outcome: MechanicalCheckResult['outcome'], criterionId: MechanicalCheckResult['criterionId'] = null): MechanicalCheckResult => ({
  checkId, criterionId, parameterType: 'contrast', synthesized: criterionId !== null, required: true, severity: 'high', outcome, reason: { template: 'result.outcome', params: [{ kind: 'vocab', vocabulary: 'outcome', value: outcome }] }, evidenceIds: [],
});
const allMandatory = (outcome: MechanicalCheckResult['outcome'] = 'pass') => WORKBENCH_MANDATORY_CRITERION_IDS.map(id => result(id, outcome, id));
const behaviors = (states: Partial<Record<ObservedBehaviorRecord['behavior'], number | 'unknown'>>): ObservedBehaviorRecord[] =>
  (['dialog', 'tabs', 'text-input', 'form', 'button', 'image', 'animation'] as const).map(behavior => {
    const value = states[behavior] ?? 0;
    return value === 'unknown' ? { behavior, state: 'unknown', count: 0, viewports: [], samples: [] }
      : { behavior, state: value > 0 ? 'observed' : 'not-observed', count: value, viewports: value > 0 ? [320] : [], samples: value > 0 ? [{ kind: 'selector', parts: [{ tag: 'body', index: null }, { tag: 'div', index: null }] }] : [] };
  });
const completed = (role: ReviewerRecord['role'], assigned: string[]): ReviewerRecord => ({
  role, required: true, provider: 'deepseek', modelId: 'm', adapterVersion: 'a', billingLane: 'deepseek-metered', inputMode: 'text', status: 'completed', reason: null, recovery: null,
  inputDigest: null, assignedCheckIds: assigned, unansweredCheckIds: [], rawOutput: '{}', startedAt: null, endedAt: null,
});
const finding = (role: ReviewerRecord['role'], checkId: string, verdict: ReviewFinding['verdict'] = 'supports'): ReviewFinding => ({
  id: `${role}-${checkId}`, reviewerRole: role, checkId, verdict, kind: 'judgment', evidenceRefs: [], rationale: 'x', probability: null,
});

describe('AC-R06.3 seeded judgment criteria', () => {
  it('AC-R06.3: seeds seven distinct judgment checkIds for hierarchy, specificity, repetition, typography, layout, motion and goal fit', () => {
    expect([...JUDGMENT_DIMENSIONS]).toEqual(['hierarchy', 'specificity', 'repetition', 'typography', 'layout', 'motion', 'goal-fit']);
    const seeds = seedJudgmentChecks(null);
    expect(seeds.map(seed => seed.dimension)).toEqual([...JUDGMENT_DIMENSIONS]);
    expect(new Set(seeds.map(seed => seed.checkId)).size).toBe(7);
    expect(JUDGMENT_SEEDS_VERSION).toBe('judgment-seeds/1');
  });

  it('AC-R06.3: every seed carries a prompt/evidence contract, asks for rationale with observable examples, and enforces no style, above-fold CTA or slop score', () => {
    for (const seed of seedJudgmentChecks(null)) {
      expect(seed.required).toBe(false);
      expect(seed.contract.lookFor.length).toBeGreaterThanOrEqual(2);
      expect(seed.contract.evidence.length).toBeGreaterThanOrEqual(1);
      expect(seed.contract.rationale).toMatch(/observable example/iu);
      const rules = seed.contract.notARule.join(' ');
      expect(rules).toMatch(/one style/iu);
      expect(rules).toMatch(/above the fold/iu);
      expect(rules).toMatch(/slop score/iu);
    }
  });

  it('AC-R06 retro exception: a declared style direction frames every seed and a declared retro look is not a defect, while functionality and accessibility stay required', () => {
    const seeds = seedJudgmentChecks(contextOf('Windows 95 desktop, bevelled grey chrome, pixel fonts'));
    for (const seed of seeds) {
      expect(seed.criterion).toContain('Windows 95 desktop, bevelled grey chrome, pixel fonts');
      expect(seed.criterion).toMatch(/not a defect/iu);
      expect(seed.criterion).toMatch(/accessib/iu);
    }
    // AC-R03 preamble: a frozen style direction becomes its own judgment check.
    const style = seeds.find(seed => seed.checkId === 'judgment.style-direction');
    expect(style?.criterion).toMatch(/intentional/iu);
    expect(seedJudgmentChecks(null).some(seed => seed.checkId === 'judgment.style-direction')).toBe(false);
  });

  it('AC-R06.3: a rubric check with a seed checkId replaces the seed (accepted project criteria keep user authority)', () => {
    const own: RubricCheck = {
      checkId: 'judgment.typography', kind: 'judgment', required: false, severity: 'low', requiredBasis: null,
      provenance: { origin: 'user-confirmed', derivation: 'project-input', source: null, rationale: 'Owner wording' }, evidenceTypes: ['judgment-rationale'], sourceCriteria: [],
      parameters: { type: 'criterion', criterion: 'Only one display face appears' },
    };
    const checks = effectiveChecks(rubricOf([own]), null);
    const typography = checks.filter(check => check.checkId === 'judgment.typography');
    expect(typography).toHaveLength(1);
    expect(typography[0]).toMatchObject({ origin: 'rubric', criterion: 'Only one display face appears' });
    // The seed's evidence contract still guides the reviewers.
    expect(typography[0]!.contract?.lookFor.length).toBeGreaterThan(0);
  });

  it('AC-R06.3: seeded judgment checks join the reviewed scope next to the rubric checks', () => {
    const plan = planChecks(rubricOf([]), contextOf('Calm clinical'), { kind: 'all' });
    expect(plan.judgmentCheckIds).toEqual(expect.arrayContaining(['judgment.hierarchy', 'judgment.goal-fit', 'judgment.style-direction']));
  });
});

describe('AC-R06.5 checklist anchors as independently written local criteria', () => {
  it('AC-R06.5: at most 24 pinned anchors, each mapped to a local criterion with source id, revision, scope, kind, required and evidence types', () => {
    expect(CHECKLIST_ANCHORS.length).toBeLessThanOrEqual(24);
    expect(new Set(CHECKLIST_ANCHORS.map(anchor => anchor.criterionId)).size).toBe(CHECKLIST_ANCHORS.length);
    expect(CHECKLIST_SOURCE).toMatchObject({ sourceId: 'design-system-checklist', revisionOrDigest: '28f06a284d010ddb4dc1f68e7c92720ce734310a' });
    expect(CHECKLIST_CRITERIA_VERSION).toBe('checklist-criteria/1');
    const mapped = new Set(CHECKLIST_CRITERIA.flatMap(criterion => criterion.anchors));
    for (const anchor of CHECKLIST_ANCHORS) expect(mapped.has(anchor.criterionId)).toBe(true);
    expect(new Set(CHECKLIST_CRITERIA.map(criterion => criterion.checkId)).size).toBe(CHECKLIST_CRITERIA.length);
    for (const criterion of CHECKLIST_CRITERIA) {
      expect(criterion.checkId).toMatch(/^dsc\./u);
      expect(['mechanical', 'judgment', 'manual']).toContain(criterion.kind);
      expect(criterion.targetScope.length).toBeGreaterThan(0);
      expect(criterion.evidenceTypes.length).toBeGreaterThan(0);
      // Anchor-only criteria default optional; only a mapped mandatory check is required.
      expect(criterion.required).toBe(criterion.mapsTo !== null);
      if (criterion.mapsTo) expect(criterion.kind).toBe('mechanical');
      for (const anchor of criterion.anchors) expect(CHECKLIST_ANCHORS.some(item => item.criterionId === anchor)).toBe(true);
    }
  });

  it('AC-R06.5: licence and provenance are recorded per source; no checklist prose is imported', () => {
    expect(CHECKLIST_SOURCE.licence).toMatchObject({ declared: null, redistribution: 'not-granted' });
    expect(CHECKLIST_SOURCE.provenance).toMatch(/independently written/iu);
    for (const criterion of CHECKLIST_CRITERIA) expect(criterion.intent.length).toBeLessThanOrEqual(400);
  });

  it('AC-R06.5: an explicitly adopted criterion is a valid rubric check citing the pinned anchor; unknown and duplicate anchors are refused', () => {
    for (const criterion of CHECKLIST_CRITERIA) {
      const check = checklistRubricCheck(criterion.checkId);
      expect(() => parseProjectRubricDraft({ contextRevision: 1, checks: [check] })).not.toThrow();
      expect(check.sourceCriteria.map(source => source.criterionId).sort()).toEqual([...criterion.anchors].sort());
      expect(check.sourceCriteria.every(source => source.revisionOrDigest === CHECKLIST_SOURCE.revisionOrDigest && source.canonicalUrl.startsWith('https://'))).toBe(true);
    }
    expect(() => validateChecklistSelection(['c-modal-close', 'c-modal-close'])).toThrow(ChecklistSelectionError);
    expect(() => validateChecklistSelection(['c-not-a-real-anchor'])).toThrow(ChecklistSelectionError);
    expect(validateChecklistSelection(['c-modal-close', 'df-color-a11y'])).toEqual(['dsc.modal-keyboard', 'dsc.color-contrast']);
  });
});

describe('AC-R06.4 runtime verdict engine', () => {
  const twoReviewers = (ids: string[]) => [completed('jev-text', ids), completed('deepseek-adversarial', ids)];

  it('AC-R06.4: an open required manual check blocks passed', () => {
    const checks = effectiveChecks(rubricOf([manualCheck('device-pass', true)]), null);
    const verdicts = computeCheckVerdicts({ checks, mechanical: { results: allMandatory(), observedBehaviors: behaviors({}) }, reviewers: twoReviewers([]), findings: [] });
    expect(verdicts.find(verdict => verdict.checkId === 'device-pass')).toMatchObject({ status: 'awaiting-manual', required: true });
    const aggregate = aggregateReviewRun({ mechanical: { results: allMandatory(), unresolvedRequiredChecks: [] }, reviewers: twoReviewers([]), interrupted: false, verdicts });
    expect(aggregate.outcome).toBe('inconclusive');
    expect(aggregate.reasons.map(reason => reason.code)).toContain('required-checks-unresolved');
  });

  it('AC-R06.4: an optional manual check stays an explicit, visible gate without blocking', () => {
    const verdicts = computeCheckVerdicts({ checks: effectiveChecks(rubricOf([manualCheck('device-pass', false)]), null), mechanical: { results: allMandatory(), observedBehaviors: behaviors({}) }, reviewers: twoReviewers([]), findings: [] });
    expect(verdicts.find(verdict => verdict.checkId === 'device-pass')).toMatchObject({ status: 'awaiting-manual', required: false });
    expect(verdictBlockers(verdicts).open).toEqual([]);
  });

  it('AC-R06.4: mandatory mechanical inconclusive is not passed, and a missing mandatory result is missing evidence', () => {
    const results = allMandatory().map(item => item.checkId === 'core.keyboard-focus' ? { ...item, outcome: 'inconclusive' as const } : item).filter(item => item.checkId !== 'core.document-semantics');
    const verdicts = computeCheckVerdicts({ checks: effectiveChecks(null, null), mechanical: { results, observedBehaviors: behaviors({}) }, reviewers: twoReviewers([]), findings: [] });
    expect(verdicts.find(verdict => verdict.checkId === 'core.keyboard-focus')?.status).toBe('inconclusive');
    expect(verdicts.find(verdict => verdict.checkId === 'core.document-semantics')).toMatchObject({ status: 'inconclusive', reason: { template: 'verdict.noResult' } });
    expect(renderReviewEvidenceMessage(verdicts.find(verdict => verdict.checkId === 'core.document-semantics')!.reason)).toMatch(/no mechanical result/iu);
    expect(verdictBlockers(verdicts).open).toEqual(expect.arrayContaining(['core.keyboard-focus', 'core.document-semantics']));
    const aggregate = aggregateReviewRun({ mechanical: { results, unresolvedRequiredChecks: [] }, reviewers: twoReviewers([]), interrupted: false, verdicts });
    expect(aggregate.outcome).toBe('inconclusive');
  });

  it('AC-R06.4: no mechanical bundle at all leaves every required check open', () => {
    const verdicts = computeCheckVerdicts({ checks: effectiveChecks(null, null), mechanical: null, reviewers: [], findings: [] });
    for (const id of WORKBENCH_MANDATORY_CRITERION_IDS) expect(verdicts.find(verdict => verdict.checkId === id)?.status).toBe('inconclusive');
  });

  it('AC-R06.3: judgment results never change a mechanical outcome', () => {
    const results = allMandatory().map(item => item.checkId === 'core.text-contrast' ? { ...item, outcome: 'fail' as const } : item);
    const findings = [finding('jev-text', 'core.text-contrast', 'supports'), finding('deepseek-adversarial', 'core.text-contrast', 'supports'), finding('jev-text', 'core.keyboard-focus', 'disputes'), finding('deepseek-adversarial', 'core.keyboard-focus', 'disputes')];
    const reviewers = twoReviewers(['core.text-contrast', 'core.keyboard-focus']);
    const verdicts = computeCheckVerdicts({ checks: effectiveChecks(null, null), mechanical: { results, observedBehaviors: behaviors({}) }, reviewers, findings, scopeCheckIds: ['core.text-contrast', 'core.keyboard-focus'] });
    expect(verdicts.find(verdict => verdict.checkId === 'core.text-contrast')).toMatchObject({ status: 'fail', reviewerAnswers: { supports: 2, disputes: 0, uncertain: 0 } });
    expect(verdicts.find(verdict => verdict.checkId === 'core.keyboard-focus')).toMatchObject({ status: 'pass', reviewerAnswers: { supports: 0, disputes: 2, uncertain: 0 } });
    const aggregate = aggregateReviewRun({ mechanical: { results, unresolvedRequiredChecks: [] }, reviewers, interrupted: false, verdicts });
    expect(aggregate.outcome).toBe('failed');
  });

  it('AC-R06.3: an optional seeded judgment answered by two independent reviewers is judged, never passed', () => {
    const checks = effectiveChecks(null, null);
    const ids = ['judgment.hierarchy'];
    const verdicts = computeCheckVerdicts({ checks, mechanical: { results: allMandatory(), observedBehaviors: behaviors({}) }, reviewers: twoReviewers(ids), findings: [finding('jev-text', ids[0]!), finding('deepseek-adversarial', ids[0]!, 'disputes')], scopeCheckIds: ids });
    const hierarchy = verdicts.find(verdict => verdict.checkId === 'judgment.hierarchy')!;
    expect(hierarchy).toMatchObject({ status: 'judged', origin: 'judgment-seed', reviewerAnswers: { supports: 1, disputes: 1, uncertain: 0 } });
    for (const verdict of verdicts) expect(reviewCheckVerdictSchema.safeParse(verdict).success).toBe(true);
  });

  it('captain decision 2: an optional judgment fewer than two independent reviewers answered is unreviewed and does not make the run inconclusive', () => {
    const checks = effectiveChecks(null, null);
    const ids = ['judgment.hierarchy'];
    // Three independent completions overall, but only one of them answered this check.
    const reviewers = [completed('jev-text', ids), completed('claude-visual', []), completed('deepseek-adversarial', [])];
    const verdicts = computeCheckVerdicts({ checks, mechanical: { results: allMandatory(), observedBehaviors: behaviors({}) }, reviewers, findings: [finding('jev-text', ids[0]!)], scopeCheckIds: ids });
    expect(verdicts.find(verdict => verdict.checkId === 'judgment.hierarchy')).toMatchObject({ status: 'unreviewed', reviewerAnswers: { supports: 1, disputes: 0, uncertain: 0 } });
    expect(verdictBlockers(verdicts)).toEqual({ failed: [], open: [], undercovered: [] });
    const aggregate = aggregateReviewRun({ mechanical: { results: allMandatory(), unresolvedRequiredChecks: [] }, reviewers, interrupted: false, verdicts });
    expect(aggregate.outcome).toBe('passed');
    expect(aggregate.incompleteCheckIds).toEqual([]);
  });

  it('captain decision 2: a REQUIRED judgment fewer than two independent reviewers answered still blocks', () => {
    const required: RubricCheck = {
      checkId: 'judgment.hierarchy', kind: 'judgment', required: true, severity: 'high', requiredBasis: { type: 'project-acceptance', requirementId: 'clear-hierarchy', rationale: 'Owner requires it' },
      provenance: { origin: 'user-confirmed', derivation: 'project-input', source: null, rationale: 'Owner asked' }, evidenceTypes: ['judgment-rationale'], sourceCriteria: [],
      parameters: { type: 'criterion', criterion: 'The booking action is the most prominent element' },
    };
    const ids = ['judgment.hierarchy'];
    const reviewers = [completed('jev-text', ids), completed('claude-visual', []), completed('deepseek-adversarial', [])];
    const verdicts = computeCheckVerdicts({ checks: effectiveChecks(rubricOf([required]), null), mechanical: { results: allMandatory(), observedBehaviors: behaviors({}) }, reviewers, findings: [finding('jev-text', ids[0]!)], scopeCheckIds: ids });
    expect(verdicts.find(verdict => verdict.checkId === 'judgment.hierarchy')).toMatchObject({ status: 'awaiting-acceptance', required: true });
    expect(verdictBlockers(verdicts).undercovered).toEqual(['judgment.hierarchy']);
    const aggregate = aggregateReviewRun({ mechanical: { results: allMandatory(), unresolvedRequiredChecks: ['judgment.hierarchy'] }, reviewers, interrupted: false, verdicts });
    expect(aggregate.outcome).toBe('inconclusive');
    expect(aggregate.incompleteCheckIds).toContain('judgment.hierarchy');
  });

  it('captain decision 3: the reason states plainly that an open required judgment or manual check cannot pass until the acceptance flow exists', () => {
    const verdicts = computeCheckVerdicts({ checks: effectiveChecks(rubricOf([manualCheck('device-pass', true)]), null), mechanical: { results: allMandatory(), observedBehaviors: behaviors({}) }, reviewers: twoReviewers([]), findings: [] });
    const aggregate = aggregateReviewRun({ mechanical: { results: allMandatory(), unresolvedRequiredChecks: ['device-pass'] }, reviewers: twoReviewers([]), interrupted: false, verdicts });
    const reason = aggregate.reasons.find(item => item.code === 'required-checks-unresolved')!;
    expect(reason.message).toContain('device-pass');
    expect(reason.message).toMatch(/cannot pass until a person accepts/iu);
    expect(reason.message).toMatch(/no acceptance flow yet/iu);
  });
});

describe('AC-R06.5 applicability against the frozen evidence', () => {
  const adopt = (checkId: string, patch: Partial<RubricCheck> = {}): RubricCheck => ({ ...checklistRubricCheck(checkId), ...patch } as RubricCheck);
  const run = (rubric: ProjectRubric | null, observed: ObservedBehaviorRecord[]) => computeCheckVerdicts({ checks: effectiveChecks(rubric, null), mechanical: { results: allMandatory(), observedBehaviors: observed }, reviewers: [], findings: [] });

  it('AC-R06.5: an observed dialog, tab or input role makes its checks applicable', () => {
    const seen = run(null, behaviors({ dialog: 1, tabs: 2, 'text-input': 1 }));
    expect(seen.find(verdict => verdict.checkId === 'dsc.modal-keyboard')).toMatchObject({ status: 'awaiting-manual', applicability: { status: 'applicable', basis: 'observed', behaviors: ['dialog'] } });
    expect(seen.find(verdict => verdict.checkId === 'dsc.tabs-keyboard')).toMatchObject({ applicability: { status: 'applicable', basis: 'observed' } });
    expect(seen.find(verdict => verdict.checkId === 'dsc.field-labels')).toMatchObject({ status: 'pass', mechanicalCheckId: 'core.document-semantics', applicability: { basis: 'observed' } });
  });

  it('captain decision 1: a checklist criterion the rubric did not adopt applies only where the evidence observed its behavior', () => {
    for (const observed of [behaviors({}), behaviors({ dialog: 'unknown', tabs: 'unknown', image: 'unknown', animation: 'unknown' })]) {
      const verdicts = run(null, observed);
      for (const id of ['dsc.modal-keyboard', 'dsc.tabs-keyboard', 'dsc.image-alt', 'dsc.motion-reduced', 'dsc.overlay-order']) expect(verdicts.find(verdict => verdict.checkId === id)).toBeUndefined();
    }
    // Criteria with no behavior trigger apply only when the rubric adopts them.
    const plain = run(null, behaviors({ dialog: 1 }));
    for (const id of ['dsc.color-contrast', 'dsc.color-semantics', 'dsc.spacing-rhythm', 'dsc.unit-demo']) expect(plain.find(verdict => verdict.checkId === id)).toBeUndefined();
    expect(effectiveChecks(null, null).some(check => check.checkId === 'dsc.color-semantics')).toBe(false);
    const adopted = run(rubricOf([adopt('dsc.color-semantics')]), behaviors({}));
    expect(adopted.find(verdict => verdict.checkId === 'dsc.color-semantics')).toMatchObject({ origin: 'rubric', applicability: { basis: 'always' } });
  });

  it('AC-R06.5: an adopted criterion whose behavior is absent is not-applicable with an evaluator', () => {
    const absent = run(rubricOf([adopt('dsc.modal-keyboard')]), behaviors({}));
    expect(absent.find(verdict => verdict.checkId === 'dsc.modal-keyboard')).toMatchObject({ status: 'not-applicable', applicability: { status: 'not-applicable', basis: 'not-observed', evaluator: expect.stringMatching(/observed-behavior/u) } });
  });

  it('AC-R06.5: unknown observation for an adopted criterion is inconclusive, never not-applicable', () => {
    const verdicts = run(rubricOf([adopt('dsc.modal-keyboard')]), behaviors({ dialog: 'unknown' }));
    expect(verdicts.find(verdict => verdict.checkId === 'dsc.modal-keyboard')).toMatchObject({ status: 'inconclusive', applicability: { status: 'undetermined', basis: 'unknown' } });
  });

  it('AC-R06.5: an animation observed in the frozen evidence makes the motion checks applicable', () => {
    const verdicts = run(null, behaviors({ animation: 2 }));
    expect(verdicts.find(verdict => verdict.checkId === 'dsc.motion-reduced')).toMatchObject({ status: 'awaiting-manual', applicability: { basis: 'observed', behaviors: ['animation'] } });
    expect(verdicts.find(verdict => verdict.checkId === 'judgment.motion')?.applicability.status).toBe('applicable');
  });

  it('AC-R06.5: a declared not-applicable dialog that the evidence observed is a failure for a required check, never N/A', () => {
    const declared = adopt('dsc.modal-keyboard', {
      required: true, requiredBasis: { type: 'project-acceptance', requirementId: 'booking-dialog', rationale: 'Owner requires keyboard dialogs' },
      provenance: { origin: 'user-confirmed', derivation: 'source-criterion', source: null, rationale: 'Adopted from the checklist' },
      applicability: { status: 'not-applicable', targetScope: 'index.html', rationale: 'No dialogs on this page', evaluator: 'owner' },
    });
    const verdicts = run(rubricOf([declared]), behaviors({ dialog: 1 }));
    const modal = verdicts.find(verdict => verdict.checkId === 'dsc.modal-keyboard')!;
    expect(modal).toMatchObject({ status: 'fail', required: true, applicability: { basis: 'mismatch' } });
    expect(verdictBlockers(verdicts).failed).toContain('dsc.modal-keyboard');
    expect(aggregateReviewRun({ mechanical: { results: allMandatory(), unresolvedRequiredChecks: [] }, reviewers: [completed('jev-text', []), completed('deepseek-adversarial', [])], interrupted: false, verdicts }).outcome).toBe('failed');
  });

  it('AC-R06.5: a declared-applicable required behavior that the evidence did not observe is a failure, not N/A', () => {
    const declared = adopt('dsc.tabs-keyboard', {
      required: true, requiredBasis: { type: 'project-acceptance', requirementId: 'tabs', rationale: 'Spec has tabs' },
      provenance: { origin: 'user-confirmed', derivation: 'source-criterion', source: null, rationale: 'Adopted' },
      applicability: { status: 'applicable', targetScope: 'index.html', rationale: 'Pricing tabs', evaluator: 'owner' },
    });
    const tabs = run(rubricOf([declared]), behaviors({})).find(verdict => verdict.checkId === 'dsc.tabs-keyboard')!;
    expect(tabs).toMatchObject({ status: 'fail', applicability: { basis: 'mismatch' } });
  });

  it('AC-R06.5: N/A cannot skip an always-applicable required check', () => {
    const declared = adopt('dsc.color-contrast', { applicability: { status: 'not-applicable', targetScope: 'index.html', rationale: 'Skip', evaluator: 'owner' } });
    const verdict = run(rubricOf([declared]), behaviors({})).find(item => item.checkId === 'dsc.color-contrast')!;
    expect(verdict.status).toBe('pass');
    expect(verdict.applicability).toMatchObject({ status: 'applicable', basis: 'always' });
    expect(renderReviewEvidenceMessage(verdict.reason)).toMatch(/not-applicable was refused/iu);
  });

  it('AC-R06.5: refresh never silently changes an accepted rubric: an adopted criterion keeps its own pin and wording', () => {
    const old = adopt('dsc.field-errors');
    const pinned: RubricCheck = { ...old, intent: 'Our older wording', sourceCriteria: old.sourceCriteria.map(source => ({ ...source, revisionOrDigest: '0000000000000000000000000000000000000000' })) } as RubricCheck;
    const rubric = rubricOf([pinned]);
    const frozen = structuredClone(rubric);
    const verdict = run(rubric, behaviors({ 'text-input': 1 })).find(item => item.checkId === 'dsc.field-errors')!;
    expect(verdict.origin).toBe('rubric');
    expect(verdict.sourceCriteria.every(source => source.revisionOrDigest === '0000000000000000000000000000000000000000')).toBe(true);
    expect(rubric).toEqual(frozen);
  });

  it('W2 (AC-R06.5): an adopted criterion that maps to a mandatory check always applies, so its verdict follows the mechanical result', () => {
    const adopted = rubricOf([adopt('dsc.field-labels')]);
    expect(effectiveChecks(adopted, null).find(check => check.checkId === 'dsc.field-labels')?.appliesWhen).toBe('always');
    const results = allMandatory().filter(item => item.checkId !== 'core.document-semantics');
    results.push({ ...result('dsc.field-labels', 'fail', 'core.document-semantics'), synthesized: false });
    const verdict = computeCheckVerdicts({ checks: effectiveChecks(adopted, null), mechanical: { results, observedBehaviors: behaviors({}) }, reviewers: [], findings: [] }).find(item => item.checkId === 'dsc.field-labels')!;
    expect(verdict).toMatchObject({ status: 'fail', applicability: { status: 'applicable', basis: 'always' }, mechanicalOutcome: 'fail' });
    expect(reviewCheckVerdictSchema.safeParse(verdict).success).toBe(true);
  });

  it('NIT: a verified not-applicable required manual check is not listed as an open gate and does not block', () => {
    const required = adopt('dsc.modal-keyboard', {
      required: true, requiredBasis: { type: 'project-acceptance', requirementId: 'dialogs', rationale: 'Dialogs must work by keyboard' },
      provenance: { origin: 'user-confirmed', derivation: 'source-criterion', source: null, rationale: 'Adopted' },
    });
    const verdicts = run(rubricOf([required]), behaviors({}));
    expect(verdicts.find(item => item.checkId === 'dsc.modal-keyboard')?.status).toBe('not-applicable');
    const aggregate = aggregateReviewRun({ mechanical: { results: allMandatory(), unresolvedRequiredChecks: ['dsc.modal-keyboard'] }, reviewers: [completed('jev-text', []), completed('deepseek-adversarial', [])], interrupted: false, verdicts });
    expect(aggregate.reasons.map(reason => reason.message).join(' ')).not.toContain('dsc.modal-keyboard');
    expect(aggregate.outcome).toBe('passed');
  });
});

describe('W1/W4 observed-behavior summary hardening', () => {
  it('W1: a tampered or root-level probe never yields an empty sample or a negative or fractional count', () => {
    const capture = knownGoodCapture(320, item => {
      item.behaviors = {
        animation: { count: 1, samples: [PageText.of(''), PageText.of('html')] }, dialog: { count: -3, samples: [] }, tabs: { count: 2.7, samples: [PageText.of('[role=tab]'), 7 as never] },
        image: { count: Number.NaN, samples: [] }, form: { count: 1, samples: [PageText.of('')] },
      };
    });
    const records = summarizeObservedBehaviors(new Map([[320, { capture }]]));
    for (const record of records) expect(observedBehaviorRecordSchema.safeParse(record).success, JSON.stringify(record)).toBe(true);
    const by = Object.fromEntries(records.map(record => [record.behavior, record]));
    // Evidence v2: a sample that is not a structural selector from <body> is stored only as its page-text token.
    expect(by.animation).toMatchObject({ state: 'observed', count: 1, samples: [PageText.of('html').token()] });
    expect(by.dialog!.state).toBe('not-observed');
    expect(by.tabs).toMatchObject({ state: 'observed', count: 2, samples: [PageText.of('[role=tab]').token()] });
    expect(by.image!.state).toBe('unknown');
    expect(by.form).toMatchObject({ state: 'observed', samples: [] });
  });

  it('W4: zero animations is unknown, never not-observed (script-driven motion is invisible to getAnimations)', () => {
    const capture = knownGoodCapture(320, item => { item.behaviors = { animation: { count: 0, samples: [] }, dialog: { count: 0, samples: [] } }; });
    const records = summarizeObservedBehaviors(new Map([[320, { capture }]]));
    expect(records.find(record => record.behavior === 'animation')!.state).toBe('unknown');
    expect(records.find(record => record.behavior === 'dialog')!.state).toBe('not-observed');
    const motion = computeCheckVerdicts({ checks: effectiveChecks(null, null), mechanical: { results: allMandatory(), observedBehaviors: records }, reviewers: [], findings: [] }).find(item => item.checkId === 'judgment.motion')!;
    expect(motion.status).not.toBe('not-applicable');
    expect(motion.applicability.basis).toBe('unknown');
  });
});
