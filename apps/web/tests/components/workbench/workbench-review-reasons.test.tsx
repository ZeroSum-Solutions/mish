// @vitest-environment jsdom
// R03 web surface: a skipped, failed or cancelled reviewer shows its closed
// reason code as a localized label beside its reason and recovery, and an
// abstaining reviewer's finding says it had insufficient evidence for the
// visual style instead of showing a score.
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { WORKBENCH_REVIEW_ABSTAIN_REASONS, WORKBENCH_REVIEWER_REASON_CODES, type ReviewRunView } from '@open-design/contracts';
import { I18nProvider } from '../../../src/i18n';
import { en } from '../../../src/i18n/locales/en';

import { WorkbenchReviewRun } from '../../../src/components/workbench/WorkbenchReviewRun';

afterEach(() => { cleanup(); });

const at = '2026-10-08T10:00:00.000Z';
const digest = 'a'.repeat(64);
function view(): ReviewRunView {
  return {
    run: {
      schema: 'workbench-review-run/1', id: 'rr_1', projectId: 'p',
      operation: { id: 'op_1', kind: 'collect-review', status: 'done', stage: 'finished', interruptReason: null, attempt: 1, idempotencyKey: 'k', inputDigest: digest, cancelRequested: false, error: null, createdAt: at, updatedAt: at },
      frozen: { snapshot: { entry: 'index.html', versionId: 'v2', contentDigest: digest }, scope: { kind: 'all' }, rubricRevision: 2, contextRevision: 1, sourceHashes: [{ path: 'index.html', sha256: digest }], plan: { mechanicalCheckIds: [], judgmentCheckIds: ['win95-style'], reviewers: [{ role: 'jev-text', required: true }, { role: 'claude-visual', required: true }] }, reviewerModelIds: [{ role: 'jev-text', modelId: 'jev-latest' }, { role: 'claude-visual', modelId: 'claude-opus-5-5' }] },
      bundleId: 'rv_1', screenshotEvidenceIds: ['screenshot-320'],
      reviewers: [
        { role: 'jev-text', required: true, provider: 'typesafe-jev', modelId: 'jev-latest', adapterVersion: 'jev-review/2', billingLane: 'typesafe-system-one', inputMode: 'text', status: 'completed', reason: null, recovery: null, inputDigest: digest, assignedCheckIds: ['win95-style'], unansweredCheckIds: [], rawOutput: '', startedAt: at, endedAt: at },
        { role: 'claude-visual', required: true, provider: 'claude-max', modelId: 'claude-opus-5-5', adapterVersion: 'claude-visual/3', billingLane: 'max-subscription', inputMode: 'text-only-fallback', status: 'skipped', reasonCode: 'screenshot-read-denied', reason: 'The visual critic could not see the page screenshots: Claude Code denied it read access, so it did not review the visual checks', recovery: 'The screenshots are stored inside a .claude folder', inputDigest: digest, assignedCheckIds: ['win95-style'], unansweredCheckIds: [], rawOutput: '{}', startedAt: at, endedAt: at },
      ],
      findings: [
        { id: 'jev-text-win95-style', reviewerRole: 'jev-text', checkId: 'win95-style', verdict: 'uncertain', kind: 'judgment', evidenceRefs: [], rationale: 'Insufficient evidence for visual style: no measured visual facts reached Jev', probability: null, abstainReason: 'insufficient-visual-evidence' },
        { id: 'jev-text-judgment.specificity', reviewerRole: 'jev-text', checkId: 'judgment.specificity', verdict: 'uncertain', kind: 'judgment', evidenceRefs: [], rationale: '', probability: null, abstainReason: 'insufficient-text-evidence' },
      ],
      completedIndependentReviewers: 1, outcome: 'inconclusive', reasons: [], incompleteCheckIds: ['win95-style'], createdAt: at, endedAt: at,
    },
    freshness: { state: 'current', reasons: [] },
  };
}

describe('review run reason codes and abstentions', () => {
  it('labels the reviewer cause and the abstention', () => {
    render(<I18nProvider><WorkbenchReviewRun view={view()} /></I18nProvider>);
    const critic = document.querySelector('[data-reviewer="claude-visual"]')!;
    expect(critic.querySelector('[data-reason-code="screenshot-read-denied"]')?.textContent).toBe('Screenshot read denied');
    expect(critic.textContent).toMatch(/denied it read access/u);
    const finding = document.querySelector('[data-abstain="insufficient-visual-evidence"]')!;
    expect(finding.textContent).toMatch(/Insufficient evidence for visual style/u);
    expect(screen.queryByText(/\(0\.\d\d\)/u)).toBeNull();
    expect(document.querySelector('[data-abstain="insufficient-text-evidence"]')?.textContent).toMatch(/Insufficient evidence for copy/u);
  });

  it.each(['en'] as const)('uses agy labels for Gemini CLI failures in %s and preserves Claude labels', locale => {
    const dict = locale === 'en' ? en : en;
    for (const code of ['cli-missing', 'cli-auth-missing', 'cli-outdated', 'cli-failed'] as const) {
      const data = view();
      data.run.reviewers = [
        { ...data.run.reviewers[1]!, reasonCode: code },
        { ...data.run.reviewers[1]!, role: 'gemini-second-family', provider: 'gemini', billingLane: 'gemini-subscription', reasonCode: code, reason: null, recovery: null },
      ];
      render(<I18nProvider initial={locale}><WorkbenchReviewRun view={data} /></I18nProvider>);
      const agy = document.querySelector('[data-reviewer="gemini-second-family"] [data-reason-code]')!;
      expect(agy.textContent).toBe(dict[`workbench.review.agyReasonCode.${code}`]);
      expect(agy.textContent).toContain('agy');
      expect(agy.textContent).not.toContain('Claude');
      expect(document.querySelector('[data-reviewer="claude-visual"] [data-reason-code]')?.textContent).toBe(dict[`workbench.review.reasonCode.${code}`]);
      cleanup();
    }
  });

  it('every reason code has an English label', () => {
    for (const code of WORKBENCH_REVIEWER_REASON_CODES) {
      expect(en[`workbench.review.reasonCode.${code}`], code).toBeTruthy();

    }
    for (const reason of WORKBENCH_REVIEW_ABSTAIN_REASONS) {
      expect(en[`workbench.review.abstain.${reason}`], reason).toBeTruthy();

    }
  });
});
