import { describe, expect, it } from 'vitest';
import {
  observedBehaviorRecordSchema, reviewCheckVerdictSchema, reviewRunSchema, startReviewRunRequestSchema,
  WORKBENCH_IMPLEMENTATION_REVIEW_ONLY, WORKBENCH_REVIEW_DAEMON_CHECK_ALLOWANCE, WORKBENCH_REVIEW_MAX_CHECK_IDS, WORKBENCH_REVIEWER_ROLES, type ReviewCheckVerdict,
} from '../src/api/workbench-review.js';

const at = '2026-10-08T10:00:00.000Z';
const digest = 'a'.repeat(64);

function verdict(overrides: Partial<ReviewCheckVerdict> = {}): ReviewCheckVerdict {
  return {
    checkId: 'core.text-contrast', kind: 'mechanical', origin: 'mandatory-default', required: true, status: 'pass', reason: { template: 'contrast.samples', params: [{ kind: 'number', value: 12 }] },
    applicability: { status: 'applicable', basis: 'always', evaluator: 'check-verdicts/1', behaviors: [] },
    mechanicalCheckId: 'core.text-contrast', sourceCriteria: [], reviewerAnswers: { supports: 0, disputes: 0, uncertain: 0 }, evidenceIds: [],
    ...overrides,
  };
}

function run(checkVerdicts: ReviewCheckVerdict[], outcome: 'passed' | 'failed' | 'inconclusive' = 'passed'): unknown {
  const reviewer = (role: 'jev-text' | 'deepseek-adversarial') => ({
    role, required: true, provider: role === 'jev-text' ? 'typesafe-jev' : 'deepseek', modelId: 'm', adapterVersion: 'a',
    billingLane: role === 'jev-text' ? 'typesafe-system-one' : 'deepseek-metered', inputMode: 'text', status: 'completed', reason: null, recovery: null,
    inputDigest: digest, assignedCheckIds: [], unansweredCheckIds: [], rawOutput: '{}', startedAt: at, endedAt: at,
  });
  return {
    schema: 'workbench-review-run/1', id: 'rr_1', projectId: 'p',
    operation: { id: 'op_1', kind: 'collect-review', status: 'done', stage: 'finished', interruptReason: null, attempt: 1, idempotencyKey: 'k', inputDigest: digest, cancelRequested: false, error: null, createdAt: at, updatedAt: at },
    frozen: {
      snapshot: { entry: 'index.html', versionId: null, contentDigest: digest }, scope: { kind: 'all' }, rubricRevision: 0, contextRevision: 0, sourceHashes: [],
      plan: { mechanicalCheckIds: ['core.text-contrast'], judgmentCheckIds: [], reviewers: [{ role: 'jev-text', required: true }, { role: 'deepseek-adversarial', required: true }], manualCheckIds: [] },
      reviewerModelIds: [{ role: 'jev-text', modelId: 'm' }, { role: 'deepseek-adversarial', modelId: 'm' }],
      rubricContent: { judgmentSeeds: 'judgment-seeds/1', checklistCriteria: 'checklist-criteria/1', checklistSource: { sourceId: 'design-system-checklist', revisionOrDigest: '28f06a284d010ddb4dc1f68e7c92720ce734310a' } },
    },
    bundleId: 'rv_1', screenshotEvidenceIds: [], reviewers: [reviewer('jev-text'), reviewer('deepseek-adversarial')], findings: [],
    completedIndependentReviewers: 2, outcome, reasons: [], incompleteCheckIds: [], createdAt: at, endedAt: at, checkVerdicts,
  };
}

describe('AC-R06.4 verdict contract: a page cannot pass with a required check unresolved', () => {
  it('round-trips a passed run whose required verdicts resolved, with optional open gates beside them', () => {
    const value = run([verdict(), verdict({ checkId: 'dsc.modal-keyboard', kind: 'manual', origin: 'checklist', required: false, status: 'awaiting-manual', mechanicalCheckId: null })]);
    expect(reviewRunSchema.parse(value)).toEqual(value);
  });

  it('captain decision 2: an optional judgment fewer than two reviewers answered is unreviewed and does not block a pass; a required one cannot be unreviewed', () => {
    const unreviewed = verdict({ checkId: 'judgment.layout', kind: 'judgment', origin: 'judgment-seed', required: false, status: 'unreviewed', mechanicalCheckId: null, reviewerAnswers: { supports: 1, disputes: 0, uncertain: 0 } });
    expect(reviewRunSchema.safeParse(run([verdict(), unreviewed])).success).toBe(true);
    expect(reviewCheckVerdictSchema.safeParse({ ...unreviewed, required: true }).success).toBe(false);
    expect(reviewCheckVerdictSchema.safeParse({ ...unreviewed, kind: 'mechanical', mechanicalCheckId: 'judgment.layout' }).success).toBe(false);
  });

  it.each([
    ['a required mechanical failure', verdict({ status: 'fail' })],
    ['a required mechanical check without evidence', verdict({ status: 'inconclusive' })],
    ['an open required manual check', verdict({ checkId: 'm', kind: 'manual', origin: 'rubric', status: 'awaiting-manual', mechanicalCheckId: null })],
    ['a required judgment awaiting acceptance', verdict({ checkId: 'j', kind: 'judgment', origin: 'rubric', status: 'awaiting-acceptance', mechanicalCheckId: null })],
  ])('refuses passed with %s', (_name, blocking) => {
    expect(reviewRunSchema.safeParse(run([blocking])).success).toBe(false);
    expect(reviewRunSchema.safeParse(run([blocking], 'inconclusive')).success).toBe(true);
  });

  it('W3: per-run check-id caps leave room for a full rubric plus the checks the daemon adds', () => {
    expect(WORKBENCH_REVIEW_MAX_CHECK_IDS).toBe(100 + WORKBENCH_REVIEW_DAEMON_CHECK_ALLOWANCE);
    const ids = Array.from({ length: WORKBENCH_REVIEW_MAX_CHECK_IDS }, (_, index) => `j${index}`);
    const value = run([verdict()]) as { frozen: { plan: Record<string, unknown> }; reviewers: { assignedCheckIds: string[] }[]; incompleteCheckIds: string[] };
    value.frozen.plan.judgmentCheckIds = ids;
    value.reviewers[0]!.assignedCheckIds = ids;
    value.incompleteCheckIds = ids;
    expect(reviewRunSchema.safeParse({ ...value, outcome: 'inconclusive' }).success).toBe(true);
    value.frozen.plan.judgmentCheckIds = [...ids, 'one-more'];
    expect(reviewRunSchema.safeParse({ ...value, outcome: 'inconclusive' }).success).toBe(false);
  });

  it('evidence v2: a verdict reason is a structured message from the template table, never free text', () => {
    expect(reviewCheckVerdictSchema.safeParse(verdict({ reason: { template: 'verdict.judged', params: [{ kind: 'number', value: 2 }] } })).success).toBe(true);
    expect(reviewCheckVerdictSchema.safeParse({ ...verdict(), reason: 'All sampled text meets 4.5:1' }).success).toBe(false);
    expect(reviewCheckVerdictSchema.safeParse(verdict({ reason: { template: 'verdict.judged', params: [] } })).success).toBe(false);
  });

  it('refuses duplicate verdicts', () => {
    expect(reviewRunSchema.safeParse(run([verdict(), verdict()])).success).toBe(false);
  });
});

describe('AC-R06.3 verdict contract: judgment results never pass or fail a check', () => {
  it('a judgment or manual verdict cannot be pass or fail unless the fail is a declared-versus-observed mismatch', () => {
    const judgment = verdict({ checkId: 'judgment.hierarchy', kind: 'judgment', origin: 'judgment-seed', required: false, mechanicalCheckId: null });
    expect(reviewCheckVerdictSchema.safeParse({ ...judgment, status: 'pass' }).success).toBe(false);
    expect(reviewCheckVerdictSchema.safeParse({ ...judgment, status: 'fail' }).success).toBe(false);
    expect(reviewCheckVerdictSchema.safeParse({ ...judgment, status: 'judged' }).success).toBe(true);
    const mismatch = { ...judgment, required: true, status: 'fail' as const, applicability: { status: 'applicable' as const, basis: 'mismatch' as const, evaluator: 'observed-behavior/1', behaviors: ['dialog' as const] } };
    expect(reviewCheckVerdictSchema.safeParse(mismatch).success).toBe(true);
  });

  it('AC-R06.5: a required mismatch is a failure, never not-applicable', () => {
    const mismatch = verdict({ checkId: 'dsc.modal-keyboard', kind: 'manual', origin: 'checklist', status: 'not-applicable', mechanicalCheckId: null, applicability: { status: 'applicable', basis: 'mismatch', evaluator: 'observed-behavior/1', behaviors: ['dialog'] } });
    expect(reviewCheckVerdictSchema.safeParse(mismatch).success).toBe(false);
  });

  it('W2 (AC-R06.5): a required mechanical verdict cannot be not-applicable while its result failed or is inconclusive', () => {
    const na = verdict({ checkId: 'dsc.field-labels', origin: 'rubric', status: 'not-applicable', mechanicalCheckId: 'dsc.field-labels', applicability: { status: 'not-applicable', basis: 'not-observed', evaluator: 'observed-behavior/1', behaviors: ['text-input'] } });
    expect(reviewCheckVerdictSchema.safeParse({ ...na, mechanicalOutcome: 'fail' }).success).toBe(false);
    expect(reviewCheckVerdictSchema.safeParse({ ...na, mechanicalOutcome: 'inconclusive' }).success).toBe(false);
    expect(reviewCheckVerdictSchema.safeParse({ ...na, mechanicalOutcome: 'not-applicable' }).success).toBe(true);
    expect(reviewCheckVerdictSchema.safeParse({ ...na, required: false, mechanicalOutcome: 'fail' }).success).toBe(true);
  });

  it('AC-R06.5: an observed behavior has a count; other states have none', () => {
    const dialogSelector = { kind: 'selector', parts: [{ tag: 'body', index: null }, { tag: 'dialog', index: null }] };
    expect(observedBehaviorRecordSchema.safeParse({ behavior: 'dialog', state: 'observed', count: 1, viewports: [320], samples: [dialogSelector] }).success).toBe(true);
    // Evidence v2: a sample is a structural selector or a page-text token, never a free string.
    expect(observedBehaviorRecordSchema.safeParse({ behavior: 'dialog', state: 'observed', count: 1, viewports: [320], samples: ['dialog#book'] }).success).toBe(false);
    expect(observedBehaviorRecordSchema.safeParse({ behavior: 'dialog', state: 'observed', count: 0, viewports: [], samples: [] }).success).toBe(false);
    expect(observedBehaviorRecordSchema.safeParse({ behavior: 'dialog', state: 'unknown', count: 2, viewports: [], samples: [] }).success).toBe(false);
  });
});

describe('AC-R03.2 product reviewer allow-list', () => {
  it('product review accepts exactly Jev, the Claude visual critic and DeepSeek; every implementation-only lane is refused by name', () => {
    expect([...WORKBENCH_REVIEWER_ROLES]).toEqual(['jev-text', 'claude-visual', 'deepseek-adversarial', 'gemini-second-family']);
    for (const role of WORKBENCH_IMPLEMENTATION_REVIEW_ONLY) {
      const parsed = startReviewRunRequestSchema.safeParse({ projectId: 'p', snapshot: { entry: 'index.html' }, rubricRevision: 0, reviewerPlan: { reviewers: [{ role, required: false }] } });
      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues[0]?.message).toMatch(/implementation review only/u);
    }
  });
});
