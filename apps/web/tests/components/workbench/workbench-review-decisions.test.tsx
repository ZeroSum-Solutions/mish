// @vitest-environment jsdom
// AC-R03.1–R03.4 web surface: the review panel starts a frozen run through
// POST /api/workbench/reviews (the same endpoint `od workbench review start`
// uses), shows partial status, reviewer reasons/recovery, evidence-vs-judgment
// labels and the outdated marker, and runs U1's mechanical-only check.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReviewRunView } from '@mish/contracts';
import { I18nProvider } from '../../../src/i18n';
import { WorkbenchReviewRun } from '../../../src/components/workbench/WorkbenchReviewRun';
import { WorkbenchReviewPanel } from '../../../src/components/workbench/WorkbenchReviewPanel';
import buttonStyles from '../../../../../packages/components/src/button.module.css';
import { getProjectRubric } from '../../../src/providers/workbench';

vi.mock('../../../src/providers/workbench', async (original) => ({
  ...await original<typeof import('../../../src/providers/workbench')>(),
  getProjectRubric: vi.fn(),
}));
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

const at = '2026-10-07T10:00:00.000Z';
const digest = 'a'.repeat(64);
function view(): ReviewRunView {
  return {
    run: {
      schema: 'workbench-review-run/1', id: 'rr_1', projectId: 'p',
      operation: { id: 'op_1', kind: 'collect-review', status: 'interrupted', stage: 'finished', interruptReason: 'user-cancelled', attempt: 1, idempotencyKey: 'k', inputDigest: digest, cancelRequested: true, error: null, createdAt: at, updatedAt: at },
      frozen: { snapshot: { entry: 'index.html', versionId: 'v2', contentDigest: digest }, scope: { kind: 'all' }, rubricRevision: 2, contextRevision: 1, sourceHashes: [{ path: 'index.html', sha256: digest }], plan: { mechanicalCheckIds: ['core.text-contrast'], judgmentCheckIds: ['win95-style'], reviewers: [{ role: 'jev-text', required: true }, { role: 'claude-visual', required: true }] }, reviewerModelIds: [{ role: 'jev-text', modelId: 'jev-latest' }, { role: 'claude-visual', modelId: 'claude-opus-5-5' }] },
      bundleId: 'rv_1', screenshotEvidenceIds: ['screenshot-320'],
      reviewers: [
        { role: 'jev-text', required: true, provider: 'typesafe-jev', modelId: 'jev-latest', adapterVersion: 'jev-review/1', billingLane: 'typesafe-system-one', inputMode: 'text', status: 'completed', reason: null, recovery: null, inputDigest: digest, assignedCheckIds: ['win95-style'], unansweredCheckIds: [], rawOutput: '{}', startedAt: at, endedAt: at },
        { role: 'claude-visual', required: true, provider: 'claude-max', modelId: 'claude-opus-5-5', adapterVersion: 'claude-visual/1', billingLane: 'max-subscription', inputMode: null, status: 'cancelled', reason: 'The run stopped before this reviewer finished', recovery: 'Start a new review run; completed evidence is kept.', inputDigest: null, assignedCheckIds: ['win95-style'], unansweredCheckIds: [], rawOutput: null, startedAt: at, endedAt: at },
      ],
      findings: [
        { id: 'f1', reviewerRole: 'jev-text', checkId: 'win95-style', verdict: 'supports', kind: 'judgment', evidenceRefs: [], rationale: 'TypeSafe Jev probability 0.910', probability: 0.91 },
        { id: 'f2', reviewerRole: 'jev-text', checkId: 'core.text-contrast', verdict: 'disputes', kind: 'evidence-linked', evidenceRefs: ['contrast-320'], rationale: 'Grey on grey', probability: null },
      ],
      completedIndependentReviewers: 1, outcome: 'inconclusive',
      reasons: [{ code: 'run-interrupted', message: 'The run was interrupted; completed evidence is kept and the result is partial' }],
      incompleteCheckIds: ['win95-style'], createdAt: at, endedAt: at,
    },
    freshness: { state: 'outdated', reasons: ['index.html changed since the review'] },
  };
}

describe('D7 finding decisions', () => {
  it('offers explicit advisory Accept / Dismiss and explains mandatory refusal', () => {
    const current = view();
    current.run.checkVerdicts = [
      { checkId: 'win95-style', kind: 'judgment', origin: 'rubric', required: false, status: 'unreviewed', reason: { template: 'verdict.unreviewed', params: [{ kind: 'number', value: 1 }] }, applicability: { status: 'applicable', basis: 'always', evaluator: 'check-verdicts/1', behaviors: [] }, mechanicalCheckId: null, evidenceIds: [], sourceCriteria: [], reviewerAnswers: { supports: 1, disputes: 0, uncertain: 0 } },
      { checkId: 'core.text-contrast', kind: 'mechanical', origin: 'mandatory-default', required: true, status: 'fail', reason: { template: 'verdict.noResult', params: [] }, applicability: { status: 'applicable', basis: 'always', evaluator: 'check-verdicts/1', behaviors: [] }, mechanicalCheckId: 'core.text-contrast', evidenceIds: [], sourceCriteria: [], reviewerAnswers: { supports: 0, disputes: 1, uncertain: 0 } },
    ];
    const onDecision = vi.fn();
    render(<I18nProvider><WorkbenchReviewRun view={current} {...{ onDecision }} /></I18nProvider>);
    expect(screen.getByText('Advisory — awaiting your decision')).toBeTruthy();
    const accept = screen.getByRole('button', { name: 'Accept' });
    const dismiss = screen.getByRole('button', { name: 'Dismiss' });
    expect(accept.classList.contains(buttonStyles.secondary!)).toBe(true);
    expect(dismiss.classList.contains(buttonStyles.ghost!)).toBe(true);
    expect(accept.closest('[role="group"]')?.getAttribute('aria-label')).toBe('win95-style');
    fireEvent.click(accept);
    expect(onDecision).toHaveBeenCalledWith('f1', 'accept');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDecision).toHaveBeenCalledWith('f1', 'dismiss');
    expect(screen.getAllByText('Required checks cannot be dismissed. Failures and missing required evidence remain blocking.').length).toBeGreaterThan(0);
    expect(document.querySelector('[data-kind="evidence-linked"]')?.querySelector('button')).toBeNull();
  });

  it('persists through the panel endpoint with project authority and displays the audit record', async () => {
    vi.mocked(getProjectRubric).mockResolvedValue({ projectId: 'p', revision: 2, rubric: null, linkage: null } as never);
    const current = view();
    current.run.checkVerdicts = [{ checkId: 'win95-style', kind: 'judgment', origin: 'rubric', required: false, status: 'unreviewed', reason: { template: 'verdict.unreviewed', params: [{ kind: 'number', value: 1 }] }, applicability: { status: 'applicable', basis: 'always', evaluator: 'check-verdicts/1', behaviors: [] }, mechanicalCheckId: null, evidenceIds: [], sourceCriteria: [], reviewerAnswers: { supports: 1, disputes: 0, uncertain: 0 } }];
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url === '/api/workbench/projects/p/review/bundles') return Response.json({ projectId: 'p', bundles: [] });
      if (url.endsWith('/decision')) {
        const result = structuredClone(current);
        Object.assign(result.run.findings[0]!, { decisions: [{ action: 'accept', actor: { kind: 'local-user' }, at }] });
        return new Response(JSON.stringify(result));
      }
      if (url === '/api/workbench/reviews') return new Response(JSON.stringify(current), { status: 202 });
      return new Response(JSON.stringify({ projectId: 'p', runs: [] }));
    }));
    render(<I18nProvider><WorkbenchReviewPanel projectId="p" /></I18nProvider>);
    fireEvent.click(screen.getByText('Start review'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Accept' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(screen.getByText(/Accepted · Local user/u)).toBeTruthy());
    const call = calls.find(call => call.url.endsWith('/decision'))!;
    expect(call.url).toBe('/api/workbench/reviews/rr_1/findings/f1/decision');
    expect(new Headers(call.init?.headers).get('x-od-project-id')).toBe('p');
    expect(JSON.parse(String(call.init?.body))).toEqual({ action: 'accept' });
  });
  it('does not restore a previous project after a delayed decision response', async () => {
    vi.mocked(getProjectRubric).mockResolvedValue({ projectId: 'p', revision: 2, rubric: null, linkage: null } as never);
    const current = view();
    current.run.checkVerdicts = [{ checkId: 'win95-style', kind: 'judgment', origin: 'rubric', required: false, status: 'unreviewed', reason: { template: 'verdict.unreviewed', params: [{ kind: 'number', value: 1 }] }, applicability: { status: 'applicable', basis: 'always', evaluator: 'check-verdicts/1', behaviors: [] }, mechanicalCheckId: null, evidenceIds: [], sourceCriteria: [], reviewerAnswers: { supports: 1, disputes: 0, uncertain: 0 } }];
    let complete!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const history = /^\/api\/workbench\/projects\/([^/]+)\/review\/bundles$/u.exec(url);
      if (history) return Response.json({ projectId: decodeURIComponent(history[1]!), bundles: [] });
      if (url.endsWith('/decision')) return new Promise<Response>(resolve => { complete = resolve; });
      if (url === '/api/workbench/reviews') return new Response(JSON.stringify(current), { status: 202 });
      return new Response(JSON.stringify({ projectId: url.includes('/other/') ? 'other' : 'p', runs: [] }));
    }));
    const rendered = render(<I18nProvider><WorkbenchReviewPanel projectId="p" /></I18nProvider>);
    fireEvent.click(screen.getByText('Start review'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Accept' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
    expect((screen.getByRole('button', { name: 'Dismiss' }) as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() => expect(complete).toBeTypeOf('function'));
    rendered.rerender(<I18nProvider><WorkbenchReviewPanel projectId="other" /></I18nProvider>);
    complete(new Response(JSON.stringify(current)));
    await waitFor(() => expect((screen.getByText('Start review').closest('button') as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByTestId('workbench-review-run')).toBeNull();
  });

});
