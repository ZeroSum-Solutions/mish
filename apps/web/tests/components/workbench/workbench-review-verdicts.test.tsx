// @vitest-environment jsdom
// B5-1 web surface: the review run shows the per-check verdicts the daemon
// computed (AC-R06.3–R06.5) with their applicability, reviewer answers and
// source anchors, the frozen rubric-content versions, and the two-reviewer
// rule (AC-R03.2) both on the run and before a run starts.
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReviewCheckVerdict, ReviewRunView } from '@mish/contracts';
import { I18nProvider } from '../../../src/i18n';
import { WorkbenchReviewRun } from '../../../src/components/workbench/WorkbenchReviewRun';
import { WorkbenchReviewPanel } from '../../../src/components/workbench/WorkbenchReviewPanel';
import { getProjectRubric } from '../../../src/providers/workbench';

vi.mock('../../../src/providers/workbench', async (original) => ({
  ...await original<typeof import('../../../src/providers/workbench')>(),
  getProjectRubric: vi.fn(),
}));
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

const at = '2026-10-08T10:00:00.000Z';
const digest = 'a'.repeat(64);
const PIN = '28f06a284d010ddb4dc1f68e7c92720ce734310a';
const verdict = (patch: Partial<ReviewCheckVerdict>): ReviewCheckVerdict => ({
  checkId: 'core.text-contrast', kind: 'mechanical', origin: 'mandatory-default', required: true, status: 'pass', reason: { template: 'contrast.samples', params: [{ kind: 'number', value: 12 }] },
  applicability: { status: 'applicable', basis: 'always', evaluator: 'check-verdicts/1', behaviors: [] }, mechanicalCheckId: 'core.text-contrast', sourceCriteria: [],
  reviewerAnswers: { supports: 2, disputes: 0, uncertain: 0 }, evidenceIds: [], ...patch,
});

function view(): ReviewRunView {
  const reviewer = (role: 'jev-text' | 'deepseek-adversarial') => ({
    role, required: true, provider: role === 'jev-text' ? 'typesafe-jev' as const : 'deepseek' as const, modelId: 'm', adapterVersion: 'a',
    billingLane: role === 'jev-text' ? 'typesafe-system-one' as const : 'deepseek-metered' as const, inputMode: 'text' as const, status: 'completed' as const, reason: null, recovery: null,
    inputDigest: digest, assignedCheckIds: [], unansweredCheckIds: [], rawOutput: '{}', startedAt: at, endedAt: at,
  });
  return {
    run: {
      schema: 'workbench-review-run/1', id: 'rr_1', projectId: 'p',
      operation: { id: 'op_1', kind: 'collect-review', status: 'done', stage: 'finished', interruptReason: null, attempt: 1, idempotencyKey: 'k', inputDigest: digest, cancelRequested: false, error: null, createdAt: at, updatedAt: at },
      frozen: {
        snapshot: { entry: 'index.html', versionId: null, contentDigest: digest }, scope: { kind: 'all' }, rubricRevision: 4, contextRevision: 1, sourceHashes: [],
        plan: { mechanicalCheckIds: ['core.text-contrast'], judgmentCheckIds: ['judgment.hierarchy'], reviewers: [{ role: 'jev-text', required: true }, { role: 'deepseek-adversarial', required: true }], manualCheckIds: ['dsc.modal-keyboard'] },
        reviewerModelIds: [{ role: 'jev-text', modelId: 'm' }, { role: 'deepseek-adversarial', modelId: 'm' }],
        rubricContent: { judgmentSeeds: 'judgment-seeds/1', checklistCriteria: 'checklist-criteria/1', checklistSource: { sourceId: 'design-system-checklist', revisionOrDigest: PIN } },
      },
      bundleId: 'rv_1', screenshotEvidenceIds: [], reviewers: [reviewer('jev-text'), reviewer('deepseek-adversarial')], findings: [],
      completedIndependentReviewers: 2, outcome: 'failed',
      reasons: [{ code: 'mandatory-check-failed', message: 'Required check failed: dsc.modal-keyboard' }], incompleteCheckIds: [], createdAt: at, endedAt: at,
      checkVerdicts: [
        verdict({}),
        verdict({ checkId: 'judgment.hierarchy', kind: 'judgment', origin: 'judgment-seed', required: false, status: 'judged', reason: { template: 'verdict.judged', params: [{ kind: 'number', value: 2 }] }, mechanicalCheckId: null, reviewerAnswers: { supports: 1, disputes: 1, uncertain: 0 } }),
        verdict({
          checkId: 'dsc.modal-keyboard', kind: 'manual', origin: 'rubric', status: 'fail',
          reason: { template: 'verdict.withNote', params: [
            { kind: 'message', template: 'verdict.note.observedDespiteDeclared', params: [{ kind: 'list', items: [{ kind: 'vocab', vocabulary: 'behavior', value: 'dialog' }] }, { kind: 'list', items: [{ kind: 'selector', parts: [{ tag: 'body', index: null }, { tag: 'dialog', index: null }] }] }] },
            { kind: 'message', template: 'verdict.mismatch', params: [] },
          ] }, mechanicalCheckId: null,
          applicability: { status: 'applicable', basis: 'mismatch', evaluator: 'observed-behavior/1', behaviors: ['dialog'] },
          sourceCriteria: [{ sourceId: 'design-system-checklist', revisionOrDigest: PIN, criterionId: 'c-modal-close', canonicalUrl: `https://github.com/ardakaracizmeli/design-system-checklist/blob/${PIN}/src/data/components.js` }],
          reviewerAnswers: { supports: 0, disputes: 0, uncertain: 0 },
        }),
      ],
    },
    freshness: { state: 'current', reasons: [] },
  };
}

describe('WorkbenchReviewRun check verdicts (AC-R06.3–R06.5)', () => {
  it('renders one row per verdict with status, requirement, origin, applicability, reviewer answers and source anchors', () => {
    render(<I18nProvider><WorkbenchReviewRun view={view()} /></I18nProvider>);
    const list = screen.getByTestId('workbench-review-verdicts');
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    const modal = rows.find(row => row.getAttribute('data-check-id') === 'dsc.modal-keyboard')!;
    expect(modal.getAttribute('data-status')).toBe('fail');
    expect(modal.textContent).toContain('Failed');
    expect(modal.textContent).toContain('Required');
    expect(modal.textContent).toContain('Declared and observed disagree');
    expect(modal.textContent).toContain('dialog');
    expect(modal.textContent).toContain('c-modal-close');
    expect(modal.textContent).toContain(PIN.slice(0, 12));
    // Evidence v2: the reason is rendered from the template table in the reader's locale.
    expect(modal.textContent).toContain('Declared not applicable, but the evidence observed dialog (body > dialog). The declared applicability contradicts the frozen evidence');
    const hierarchy = rows.find(row => row.getAttribute('data-check-id') === 'judgment.hierarchy')!;
    expect(hierarchy.textContent).toContain('Judged (never a pass)');
    expect(hierarchy.textContent).toContain('Seeded judgment');
    expect(hierarchy.textContent).toMatch(/1 supports · 1 disputes · 0 uncertain/u);
  });

  it('shows the frozen rubric-content versions and the two-reviewer rule on the run', () => {
    render(<I18nProvider><WorkbenchReviewRun view={view()} /></I18nProvider>);
    expect(screen.getByText(/judgment-seeds\/1 · checklist-criteria\/1/u)).toBeTruthy();
    expect(screen.getByTestId('workbench-review-independent').textContent).toMatch(/2 \/ 2/u);
  });
});

describe('captain decisions 2 and 3 on the run view', () => {
  it('labels an optional judgment fewer than two reviewers answered as unreviewed', () => {
    const value = view();
    value.run.checkVerdicts = [verdict({ checkId: 'judgment.layout', kind: 'judgment', origin: 'judgment-seed', required: false, status: 'unreviewed', reason: { template: 'verdict.unreviewed', params: [{ kind: 'number', value: 1 }] }, mechanicalCheckId: null, reviewerAnswers: { supports: 1, disputes: 0, uncertain: 0 } })];
    render(<I18nProvider><WorkbenchReviewRun view={value} /></I18nProvider>);
    const row = within(screen.getByTestId('workbench-review-verdicts')).getByRole('listitem');
    expect(row.getAttribute('data-status')).toBe('unreviewed');
    expect(row.textContent).toContain('Unreviewed (fewer than two reviewers answered)');
    expect(screen.queryByTestId('review-human-gate')).toBeNull();
  });

  it('says plainly that an open required judgment or manual check keeps the run from passing until the acceptance flow exists', () => {
    const value = view();
    value.run.outcome = 'inconclusive';
    value.run.checkVerdicts = [verdict({}), verdict({ checkId: 'device-pass', kind: 'manual', origin: 'rubric', required: true, status: 'awaiting-manual', reason: { template: 'verdict.manualRequired', params: [] }, mechanicalCheckId: null })];
    render(<I18nProvider><WorkbenchReviewRun view={value} /></I18nProvider>);
    const note = screen.getByTestId('review-human-gate');
    expect(note.textContent).toMatch(/cannot pass until a person accepts/iu);
    expect(note.textContent).toMatch(/no acceptance flow yet/iu);
    expect(note.textContent).toContain('device-pass');
  });
});

describe('WorkbenchReviewPanel reviewer choice (AC-R03.2)', () => {
  it('warns before a run starts when fewer than two reviewers are selected', async () => {
    vi.mocked(getProjectRubric).mockResolvedValue({ projectId: 'p', revision: 0, rubric: null, linkage: null } as never);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ projectId: 'p', runs: [] }))));
    render(<I18nProvider><WorkbenchReviewPanel projectId="p" /></I18nProvider>);
    expect(screen.queryByTestId('review-min-reviewers')).toBeNull();
    fireEvent.change(screen.getByLabelText('Gemini (second family, advisory)'), { target: { value: 'off' } });
    fireEvent.change(screen.getByLabelText('DeepSeek Flash (adversarial)'), { target: { value: 'off' } });
    expect(screen.queryByTestId('review-min-reviewers')).toBeNull();
    fireEvent.change(screen.getByLabelText('Claude visual critic (Max)'), { target: { value: 'off' } });
    expect(screen.getByTestId('review-min-reviewers').textContent).toMatch(/at least two/iu);
  });
});
