import { describe, expect, it } from 'vitest';
import type { MechanicalCheckResult, ReviewerRecord } from '@open-design/contracts';
import { aggregateReviewRun } from '../../src/workbench/review/run-aggregate.js';
import { DEFAULT_REVIEWER_PLAN, planChecks, ReviewScopeError, resolveReviewerPlan } from '../../src/workbench/review/reviewer-plan.js';
import { rubric } from './review-run-fixture.js';

const result = (checkId: string, outcome: MechanicalCheckResult['outcome'], required = true): MechanicalCheckResult => ({
  checkId, criterionId: null, parameterType: 'contrast', synthesized: false, required, severity: 'high', outcome, reason: 'r', evidenceIds: [],
});
const reviewer = (role: ReviewerRecord['role'], status: ReviewerRecord['status'], required = true): ReviewerRecord => ({
  role, required, provider: 'deepseek', modelId: 'm', adapterVersion: 'a', billingLane: 'deepseek-metered', inputMode: status === 'completed' ? 'text' : null, status,
  reason: status === 'completed' ? null : 'x', recovery: status === 'completed' ? null : 'y', inputDigest: null, assignedCheckIds: [`${role}-check`], unansweredCheckIds: [], rawOutput: status === 'completed' ? '{}' : null, startedAt: null, endedAt: null,
});
const two = [reviewer('jev-text', 'completed'), reviewer('deepseek-adversarial', 'completed')];

describe('aggregateReviewRun (technical-spec overall rule)', () => {
  it.each([
    ['confirmed mandatory failure → failed even with every reviewer agreeing', { mechanical: { results: [result('a', 'fail'), result('b', 'pass')], unresolvedRequiredChecks: [] }, reviewers: two, interrupted: false }, 'failed', ['mandatory-check-failed']],
    ['missing mandatory evidence → inconclusive', { mechanical: { results: [result('a', 'inconclusive')], unresolvedRequiredChecks: [] }, reviewers: two, interrupted: false }, 'inconclusive', ['mandatory-evidence-missing']],
    ['no mechanical bundle → inconclusive', { mechanical: null, reviewers: two, interrupted: false }, 'inconclusive', ['mandatory-evidence-missing']],
    ['unresolved required judgment checks → inconclusive', { mechanical: { results: [result('a', 'pass')], unresolvedRequiredChecks: ['style'] }, reviewers: two, interrupted: false }, 'inconclusive', ['required-checks-unresolved']],
    ['one reviewer → inconclusive', { mechanical: { results: [result('a', 'pass')], unresolvedRequiredChecks: [] }, reviewers: [reviewer('jev-text', 'completed'), reviewer('deepseek-adversarial', 'skipped', false)], interrupted: false }, 'inconclusive', ['fewer-than-two-independent-reviewers']],
    ['skipped optional reviewer changes nothing', { mechanical: { results: [result('a', 'pass'), result('b', 'not-applicable')], unresolvedRequiredChecks: [] }, reviewers: [...two, reviewer('claude-visual', 'skipped', false)], interrupted: false }, 'passed', []],
    ['failed required reviewer → its checks incomplete', { mechanical: { results: [result('a', 'pass')], unresolvedRequiredChecks: [] }, reviewers: [...two, reviewer('claude-visual', 'failed')], interrupted: false }, 'inconclusive', ['required-reviewer-incomplete']],
    ['interrupted → partial', { mechanical: { results: [result('a', 'pass')], unresolvedRequiredChecks: [] }, reviewers: two, interrupted: true }, 'inconclusive', ['run-interrupted']],
  ] as const)('%s', (_name, input, outcome, codes) => {
    const aggregate = aggregateReviewRun(input);
    expect(aggregate.outcome).toBe(outcome);
    expect(aggregate.reasons.map(reason => reason.code)).toEqual(codes);
  });

  it('reports the completed count and the incomplete checks of a missing required reviewer', () => {
    const aggregate = aggregateReviewRun({ mechanical: { results: [result('a', 'pass')], unresolvedRequiredChecks: [] }, reviewers: [reviewer('jev-text', 'completed'), reviewer('claude-visual', 'cancelled'), reviewer('deepseek-adversarial', 'skipped', false)], interrupted: false });
    expect(aggregate.completedIndependentReviewers).toBe(1);
    expect(aggregate.incompleteCheckIds).toEqual(['claude-visual-check']);
  });

  it('a reviewer that leaves assigned checks unanswered is not an independent completion and leaves those checks incomplete', () => {
    const partial: ReviewerRecord = { ...reviewer('deepseek-adversarial', 'completed'), assignedCheckIds: ['a', 'b', 'c'], unansweredCheckIds: ['b', 'c'] };
    const aggregate = aggregateReviewRun({ mechanical: { results: [result('a', 'pass')], unresolvedRequiredChecks: [] }, reviewers: [reviewer('jev-text', 'completed'), partial], interrupted: false });
    expect(aggregate.outcome).toBe('inconclusive');
    expect(aggregate.completedIndependentReviewers).toBe(1);
    expect(aggregate.incompleteCheckIds).toEqual(['b', 'c']);
    expect(aggregate.reasons.map(reason => reason.code)).toEqual(['fewer-than-two-independent-reviewers', 'required-reviewer-incomplete']);
  });

  it('evidence collected after the inputs changed never fails or passes the frozen revision', () => {
    const aggregate = aggregateReviewRun({ mechanical: { results: [result('a', 'fail')], unresolvedRequiredChecks: [] }, reviewers: two, interrupted: true, inputsChanged: 'index.html changed after the review started' });
    expect(aggregate.outcome).toBe('inconclusive');
    expect(aggregate.reasons.map(reason => reason.code)).toEqual(['mandatory-check-failed', 'inputs-changed', 'run-interrupted']);
  });
});

describe('reviewer plan', () => {
  it('defaults to Jev, the Claude visual critic and DeepSeek Flash required, and Gemini as an optional second family', () => {
    expect(resolveReviewerPlan(undefined)).toEqual([{ role: 'jev-text', required: true }, { role: 'claude-visual', required: true }, { role: 'deepseek-adversarial', required: true }, { role: 'gemini-second-family', required: false }]);
    expect(DEFAULT_REVIEWER_PLAN.map(entry => entry.role)).not.toContain('grok');
    expect(resolveReviewerPlan({ reviewers: [{ role: 'jev-text', required: false }] })).toEqual([{ role: 'jev-text', required: false }]);
  });

  it('keeps mandatory mechanical checks in any scope and refuses checks outside the rubric', () => {
    const scoped = planChecks(rubric(), null, { kind: 'checks', checkIds: ['win95-style'] });
    expect(scoped.reviewedCheckIds).toEqual(['win95-style']);
    expect(scoped.mechanicalCheckIds).toHaveLength(6);
    expect(() => planChecks(rubric(), null, { kind: 'checks', checkIds: ['nope'] })).toThrow(ReviewScopeError);
  });
});
