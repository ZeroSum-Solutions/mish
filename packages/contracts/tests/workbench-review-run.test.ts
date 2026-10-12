import { describe, expect, it } from 'vitest';
import { resolveDefaultReviewEntry, reviewFindingSchema, reviewRunSchema, reviewRunViewSchema, reviewRunListSchema, startReviewRunRequestSchema, type ReviewerRecord, type ReviewRun } from '../src/api/workbench-review.js';

const at = '2026-10-07T10:00:00.000Z';
const digest = 'a'.repeat(64);

function reviewer(role: 'jev-text' | 'claude-visual' | 'deepseek-adversarial', status: 'completed' | 'skipped' = 'completed') {
  return {
    role, required: true, provider: role === 'jev-text' ? 'typesafe-jev' : role === 'claude-visual' ? 'claude-max' : 'deepseek',
    modelId: 'model-x', adapterVersion: 'review/1', billingLane: role === 'jev-text' ? 'typesafe-system-one' : role === 'claude-visual' ? 'max-subscription' : 'deepseek-metered',
    inputMode: status === 'completed' ? 'text' : null, status, reason: status === 'completed' ? null : 'No key', recovery: status === 'completed' ? null : 'Add the key in Settings',
    inputDigest: digest, assignedCheckIds: ['cta'], unansweredCheckIds: [], rawOutput: status === 'completed' ? '{}' : null, startedAt: at, endedAt: at,
  } as ReviewerRecord;
}

function run(overrides: Partial<ReviewRun> = {}): unknown {
  return {
    schema: 'workbench-review-run/1', id: 'rr_1', projectId: 'p',
    operation: { id: 'op_1', kind: 'collect-review', status: 'done', stage: 'finished', interruptReason: null, attempt: 1, idempotencyKey: 'k', inputDigest: digest, cancelRequested: false, error: null, createdAt: at, updatedAt: at },
    frozen: {
      snapshot: { entry: 'index.html', versionId: null, contentDigest: digest }, scope: { kind: 'all' }, rubricRevision: 2, contextRevision: 1,
      sourceHashes: [{ path: 'index.html', sha256: digest }],
      plan: { mechanicalCheckIds: ['cta'], judgmentCheckIds: [], reviewers: [{ role: 'jev-text', required: true }, { role: 'deepseek-adversarial', required: true }] },
      reviewerModelIds: [{ role: 'jev-text', modelId: 'model-x' }, { role: 'deepseek-adversarial', modelId: 'model-x' }],
    },
    bundleId: 'rv_1', screenshotEvidenceIds: [], reviewers: [reviewer('jev-text'), reviewer('deepseek-adversarial')], findings: [],
    completedIndependentReviewers: 2, outcome: 'passed', reasons: [], incompleteCheckIds: [], createdAt: at, endedAt: at,
    ...overrides,
  };
}

describe('review run contract (AC-R03.1–R03.3 draft)', () => {
  it('round-trips degraded status in both client read shapes', () => {
    const reconciliation = { state: 'degraded', failedRunIds: ['rr_bad'] };
    const view = { run: run(), freshness: { state: 'current', reasons: [] }, reconciliation };
    expect(reviewRunViewSchema.parse(view)).toEqual(view);
    const list = { projectId: 'p', runs: [], reconciliation };
    expect(reviewRunListSchema.parse(list)).toEqual(list);
    expect(reviewRunListSchema.safeParse({ ...list, reconciliation: { state: 'unknown', failedRunIds: [] } }).success).toBe(false);
  });

  it('round-trips a frozen run record', () => {
    expect(reviewRunSchema.parse(run())).toEqual(run());
  });

  it('AC-R03.2: a finding cites evidence or is labeled a judgment; neither is rejected', () => {
    const base = { id: 'f1', reviewerRole: 'jev-text', checkId: 'cta', verdict: 'supports', rationale: 'x', probability: 0.9 };
    expect(reviewFindingSchema.safeParse({ ...base, kind: 'judgment', evidenceRefs: [] }).success).toBe(true);
    expect(reviewFindingSchema.safeParse({ ...base, kind: 'evidence-linked', evidenceRefs: ['cta-320'] }).success).toBe(true);
    expect(reviewFindingSchema.safeParse({ ...base, kind: 'evidence-linked', evidenceRefs: [] }).success).toBe(false);
    expect(reviewFindingSchema.safeParse({ ...base, evidenceRefs: [] }).success).toBe(false);
  });

  it('AC-R03.2: Grok is implementation review only; unknown roles are refused', () => {
    const request = (role: string) => startReviewRunRequestSchema.safeParse({ projectId: 'p', snapshot: { entry: 'index.html' }, rubricRevision: 0, reviewerPlan: { reviewers: [{ role, required: true }] } });
    const grok = request('grok-architecture');
    expect(grok.success).toBe(false);
    expect(grok.error?.issues[0]?.message).toMatch(/implementation review only/u);
    expect(request('gpt').success).toBe(false);
    expect(request('claude-visual').success).toBe(true);
  });

  it('AC-R03.2: fewer than two completed reviewers can never pass, and the count must match the records', () => {
    expect(reviewRunSchema.safeParse(run({ reviewers: [reviewer('jev-text'), reviewer('deepseek-adversarial', 'skipped')], completedIndependentReviewers: 1 })).success).toBe(false);
    expect(reviewRunSchema.safeParse(run({ completedIndependentReviewers: 1 })).success).toBe(false);
  });

  it('AC-R03.2: a reviewer that left assigned checks unanswered is not an independent completion', () => {
    const partial = { ...reviewer('deepseek-adversarial'), assignedCheckIds: ['cta', 'nav'], unansweredCheckIds: ['nav'] };
    expect(reviewRunSchema.safeParse(run({ reviewers: [reviewer('jev-text'), partial] })).success).toBe(false);
    expect(reviewRunSchema.safeParse(run({ reviewers: [reviewer('jev-text'), partial], completedIndependentReviewers: 1, outcome: 'inconclusive' })).success).toBe(true);
    expect(reviewRunSchema.safeParse(run({ reviewers: [reviewer('jev-text'), { ...partial, unansweredCheckIds: ['other'] }], completedIndependentReviewers: 1, outcome: 'inconclusive' })).success).toBe(false);
  });

  it('AC-R03.3: an unavailable reviewer shows its reason and recovery', () => {
    const skipped = { ...reviewer('jev-text', 'skipped'), recovery: null };
    expect(reviewRunSchema.safeParse(run({ outcome: 'inconclusive', reviewers: [skipped, reviewer('deepseek-adversarial')] as never, completedIndependentReviewers: 1 })).success).toBe(false);
  });

  it('defaults the scope to the whole rubric and the snapshot to the current revision', () => {
    expect(startReviewRunRequestSchema.parse({ projectId: 'p', snapshot: {}, rubricRevision: 0 })).toEqual({ projectId: 'p', snapshot: { entry: 'index.html', versionId: null }, scope: { kind: 'all' }, rubricRevision: 0 });
  });
  it('D7: audit records round-trip only on verified optional judgments', () => {
    const check = { checkId: 'style', kind: 'judgment' as const, origin: 'rubric' as const, required: false, status: 'judged' as const, reason: { template: 'verdict.judged' as const, params: [{ kind: 'number' as const, value: 2 }] }, applicability: { status: 'applicable' as const, basis: 'always' as const, evaluator: 'v', behaviors: [] }, mechanicalCheckId: null, evidenceIds: [], sourceCriteria: [], reviewerAnswers: { supports: 2, disputes: 0, uncertain: 0 } };
    const finding = { id: 'f1', reviewerRole: 'jev-text' as const, checkId: 'style', verdict: 'supports' as const, kind: 'judgment' as const, evidenceRefs: [], rationale: 'x', probability: null, decisions: [{ action: 'dismiss' as const, actor: { kind: 'local-user' as const }, at }] };
    const value = run({ findings: [finding], checkVerdicts: [check] });
    expect(reviewRunSchema.parse(value)).toEqual(value);
    expect(reviewRunSchema.safeParse(run({ findings: [finding], checkVerdicts: [{ ...check, required: true, status: 'awaiting-acceptance' }] })).success).toBe(false);
    expect(reviewRunSchema.safeParse(run({ findings: [finding] })).success).toBe(false);
    expect(reviewRunSchema.safeParse(run({ findings: [finding, finding], checkVerdicts: [check] })).success).toBe(false);
    expect(reviewFindingSchema.safeParse({ ...finding, decisions: [{ ...finding.decisions[0], at: 'yesterday' }] }).success).toBe(false);
    expect(reviewFindingSchema.safeParse({ ...finding, decisions: [{ ...finding.decisions[0], actor: { kind: 'workspace-member' } }] }).success).toBe(false);
  });

});

describe('J4-01: resolveDefaultReviewEntry', () => {
  it('prefers the currently open file when it is HTML', () => {
    expect(resolveDefaultReviewEntry({ activeFileName: 'harbor-bakery.html', projectFileNames: ['index.html'], lastRunEntry: 'other.html' })).toBe('harbor-bakery.html');
  });

  it('ignores a non-HTML open file and falls back to the first HTML project file', () => {
    expect(resolveDefaultReviewEntry({ activeFileName: 'notes.txt', projectFileNames: ['readme.md', 'harbor-bakery.html', 'index.html'], lastRunEntry: 'other.html' })).toBe('harbor-bakery.html');
  });

  it('falls back to the last review run entry when nothing open and no HTML file exists', () => {
    expect(resolveDefaultReviewEntry({ activeFileName: null, projectFileNames: ['readme.md'], lastRunEntry: 'harbor-bakery.html' })).toBe('harbor-bakery.html');
  });

  it('returns null when no tier resolves anything, leaving the final fallback to the caller', () => {
    expect(resolveDefaultReviewEntry({ activeFileName: null, projectFileNames: [], lastRunEntry: null })).toBeNull();
    expect(resolveDefaultReviewEntry({})).toBeNull();
  });
});
