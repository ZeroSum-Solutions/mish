// @vitest-environment jsdom
// AC-R03.1–R03.4 web surface: the review panel starts a frozen run through
// POST /api/workbench/reviews (the same endpoint `od workbench review start`
// uses), shows partial status, reviewer reasons/recovery, evidence-vs-judgment
// labels and the outdated marker, and runs U1's mechanical-only check.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReviewRunView, VerificationBundle } from '@open-design/contracts';
import { I18nProvider } from '../../../src/i18n';
import { WorkbenchReviewPanel } from '../../../src/components/workbench/WorkbenchReviewPanel';
import { getProjectRubric } from '../../../src/providers/workbench';

vi.mock('../../../src/providers/workbench', async (original) => ({
  ...await original<typeof import('../../../src/providers/workbench')>(),
  getProjectRubric: vi.fn(),
}));
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

const at = '2026-10-07T10:00:00.000Z';
const digest = 'a'.repeat(64);
function mechanicalBundle(): VerificationBundle {
  const checks = [
    ['core.declared-actions', 'cta'], ['core.text-contrast', 'contrast'], ['core.console-resources', 'console-resources'],
    ['core.responsive-overflow', 'overflow'], ['core.keyboard-focus', 'keyboard-focus'], ['core.document-semantics', 'document-semantics'],
  ] as const;
  return {
    schema: 'workbench-verification-bundle/1', id: 'rv_saved', projectId: 'p', entry: 'index.html',
    sourceHashes: [{ path: 'index.html', sha256: digest }], contextRevision: 1, rubricRevision: 2,
    previewOrigin: 'http://project.od-review.localhost', environment: { worker: 'cdp-chromium', browserVersion: 'Chrome/test', runnerVersion: 'mechanical/1' },
    viewports: [320], startedAt: at, endedAt: at,
    results: checks.map(([checkId, parameterType]) => ({ checkId, criterionId: checkId, parameterType, synthesized: true, required: true, severity: 'high', outcome: 'pass', reason: 'Recorded check passed', evidenceIds: ['probe-320'] })),
    evidence: [{ id: 'probe-320', viewport: 320, type: 'probe', summary: 'Recorded 320px probe', observations: ['The document fits the viewport'], detail: ['Document width: 320px'] }],
    unresolvedRequiredChecks: [], outcome: 'passed', conformanceNote: 'Automation does not establish full WCAG conformance.',
  };
}

function savedMechanicalServer(withFullReview = false, options: { list?: (stored: boolean) => Response | Promise<Response>; post?: VerificationBundle | Promise<VerificationBundle> } = {}) {
  const saved = mechanicalBundle();
  let stored = false;
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.mocked(getProjectRubric).mockResolvedValue({ projectId: 'p', revision: 2, rubric: null, linkage: null } as never);
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url === '/api/workbench/projects/p/review/mechanical') { stored = true; return Response.json(await (options.post ?? saved)); }
    if (url === '/api/workbench/projects/p/review/bundles') return options.list?.(stored) ?? Response.json({ projectId: 'p', bundles: stored ? [{ id: saved.id, entry: saved.entry, outcome: saved.outcome, startedAt: at, endedAt: at }] : [] });
    if (url === '/api/workbench/projects/p/review/bundles/rv_saved') return Response.json(saved);
    if (url === '/api/workbench/projects/other/review/bundles') return Response.json({ projectId: 'other', bundles: [] });
    if (url === '/api/workbench/projects/other/reviews') return Response.json({ projectId: 'other', runs: [] });
    if (url === '/api/projects/other/files') return Response.json({ files: [] });
    if (url === '/api/workbench/projects/p/reviews') return Response.json({ projectId: 'p', runs: withFullReview ? [{ id: 'rr_1', entry: 'index.html', status: 'interrupted', outcome: 'inconclusive', createdAt: at, endedAt: at }] : [] });
    if (url === '/api/workbench/reviews/rr_1') return Response.json(view());
    if (url === '/api/active') return Response.json({ active: false });
    if (url === '/api/projects/p/files') return Response.json({ files: [{ name: 'index.html', type: 'file' }] });
    throw new Error(`unexpected fetch: ${url}`);
  }));
  return calls;
}

function emptyBundleHistory(url: string): Response | null {
  const match = /^\/api\/workbench\/projects\/([^/]+)\/review\/bundles$/u.exec(url);
  return match ? Response.json({ projectId: decodeURIComponent(match[1]!), bundles: [] }) : null;
}

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

describe('WorkbenchReviewPanel', () => {
  it('keeps a successful mechanical result and fallback history when the history refresh fails', async () => {
    const calls = savedMechanicalServer(false, { list: stored => stored ? Response.json({ error: { message: 'history unavailable' } }, { status: 503 }) : Response.json({ projectId: 'p', bundles: [] }) });
    render(<I18nProvider><WorkbenchReviewPanel projectId="p" /></I18nProvider>);
    fireEvent.click(screen.getByText('Run mechanical checks only'));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Previous runs could not be loaded.'));
    expect(screen.getByRole('status').hasAttribute('aria-label')).toBe(false);
    expect(screen.getByTestId('workbench-review-bundle').textContent).toContain('Mechanical checks: Passed');
    expect(screen.queryByRole('alert')).toBeNull();
    expect((screen.getByText('Run mechanical checks only').closest('button') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByText('Previous runs', { selector: 'summary' }));
    fireEvent.click(screen.getByRole('button', { name: /Mechanical checks.*Passed/u }));
    await waitFor(() => expect(calls.some(call => call.url.endsWith('/review/bundles/rv_saved'))).toBe(true));
    expect(calls.filter(call => call.url.endsWith('/review/mechanical'))).toHaveLength(1);
  });

  it.each([
    ['HTTP failure', () => Response.json({ error: { message: 'unavailable' } }, { status: 503 })],
    ['malformed list', () => Response.json({ projectId: 'p', runs: [] })],
    ['wrong-project list', () => Response.json({ projectId: 'other', bundles: [] })],
  ] as const)('reports a nonblocking mechanical history failure on mount: %s', async (_label, response) => {
    savedMechanicalServer(false, { list: response });
    render(<I18nProvider><WorkbenchReviewPanel projectId="p" /></I18nProvider>);
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Previous runs could not be loaded.'));
    expect(screen.getByRole('status').hasAttribute('aria-label')).toBe(false);
    expect(screen.queryByRole('alert')).toBeNull();
    expect((screen.getByText('Run mechanical checks only').closest('button') as HTMLButtonElement).disabled).toBe(false);
  });

  it('releases mechanical controls after a successful check while its history refresh is still pending', async () => {
    let finishHistory!: (response: Response) => void;
    const pending = new Promise<Response>(resolve => { finishHistory = resolve; });
    savedMechanicalServer(false, { list: stored => stored ? pending : Response.json({ projectId: 'p', bundles: [] }) });
    render(<I18nProvider><WorkbenchReviewPanel projectId="p" /></I18nProvider>);
    fireEvent.click(screen.getByText('Run mechanical checks only'));
    await waitFor(() => expect(screen.getByTestId('workbench-review-bundle').textContent).toContain('Mechanical checks: Passed'));
    try {
      expect((screen.getByText('Run mechanical checks only').closest('fieldset') as HTMLFieldSetElement).disabled).toBe(false);
    } finally {
      await act(async () => { finishHistory(Response.json({ projectId: 'p', bundles: [] })); });
    }
  });

  it('does not let a delayed initial history list replace a newer mechanical result', async () => {
    let finishInitial!: (response: Response) => void;
    const initial = new Promise<Response>(resolve => { finishInitial = resolve; });
    savedMechanicalServer(false, { list: stored => stored ? Response.json({ projectId: 'p', bundles: [{ id: 'rv_saved', entry: 'index.html', outcome: 'passed', startedAt: at, endedAt: at }] }) : initial });
    render(<I18nProvider><WorkbenchReviewPanel projectId="p" /></I18nProvider>);
    fireEvent.click(screen.getByText('Run mechanical checks only'));
    await waitFor(() => expect(screen.getByText('Previous runs')).toBeTruthy());
    fireEvent.click(screen.getByText('Previous runs'));
    await waitFor(() => expect((screen.getByText('Run mechanical checks only').closest('button') as HTMLButtonElement).disabled).toBe(false));
    await act(async () => { finishInitial(Response.json({ projectId: 'p', bundles: [] })); });
    expect(screen.getByRole('button', { name: /Mechanical checks.*Passed/u })).toBeTruthy();
  });

  it('rejects a wrong-project mechanical POST bundle before displaying it or refreshing history', async () => {
    const calls = savedMechanicalServer(false, { post: { ...mechanicalBundle(), projectId: 'other' } });
    render(<I18nProvider><WorkbenchReviewPanel projectId="p" /></I18nProvider>);
    fireEvent.click(screen.getByText('Run mechanical checks only'));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/does not match the project/u));
    expect(screen.queryByTestId('workbench-review-bundle')).toBeNull();
    expect(calls.filter(call => call.url.endsWith('/review/bundles'))).toHaveLength(1);
  });

  it('clears mechanical busy state on project change and ignores the old project failure', async () => {
    let fail!: (error: Error) => void;
    const pending = new Promise<VerificationBundle>((_resolve, reject) => { fail = reject; });
    savedMechanicalServer(false, { post: pending });
    const rendered = render(<I18nProvider><WorkbenchReviewPanel projectId="p" /></I18nProvider>);
    fireEvent.click(screen.getByText('Run mechanical checks only'));
    rendered.rerender(<I18nProvider><WorkbenchReviewPanel projectId="other" /></I18nProvider>);
    expect((screen.getByText('Run mechanical checks only').closest('fieldset') as HTMLFieldSetElement).disabled).toBe(false);
    await act(async () => { fail(new Error('old project failure')); });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByTestId('workbench-review-bundle')).toBeNull();
  });

  it('keeps terminal mechanical checks in Previous runs after remount and reopens the saved bundle', async () => {
    const calls = savedMechanicalServer();
    render(<I18nProvider><WorkbenchReviewPanel projectId="p" /></I18nProvider>);
    fireEvent.click(screen.getByText('Run mechanical checks only'));
    await waitFor(() => expect(screen.getByTestId('workbench-review-bundle').textContent).toContain('Mechanical checks: Passed'));
    await waitFor(() => expect(screen.getByText('Previous runs')).toBeTruthy());
    fireEvent.click(screen.getByText('Previous runs'));
    expect(screen.getByRole('button', { name: /Mechanical checks.*index\.html.*Passed/u })).toBeTruthy();

    cleanup();
    render(<I18nProvider><WorkbenchReviewPanel projectId="p" /></I18nProvider>);
    await waitFor(() => expect(screen.getByText('Previous runs')).toBeTruthy());
    expect(screen.queryByTestId('workbench-review-bundle')).toBeNull();
    fireEvent.click(screen.getByText('Previous runs'));
    fireEvent.click(screen.getByRole('button', { name: /Mechanical checks.*index\.html.*Passed/u }));
    await waitFor(() => expect(screen.getByTestId('workbench-review-bundle').textContent).toContain('Mechanical checks: Passed'));
    expect(screen.getByRole('link', { name: /core\.responsive-overflow.*probe-320/u })).toBeTruthy();
    expect(calls.filter(call => call.url.endsWith('/review/mechanical'))).toHaveLength(1);
    const read = calls.find(call => call.url.endsWith('/review/bundles/rv_saved'));
    expect(new Headers(read?.init?.headers).get('x-od-project-id')).toBe('p');
    expect(calls.some(call => call.url.startsWith('/api/workbench/reviews/'))).toBe(false);
  });

  it('links mechanical check evidence to the recorded observations and detail', async () => {
    savedMechanicalServer();
    render(<I18nProvider><WorkbenchReviewPanel projectId="p" /></I18nProvider>);
    fireEvent.click(screen.getByText('Run mechanical checks only'));
    await waitFor(() => expect(screen.getByTestId('workbench-review-bundle')).toBeTruthy());
    const link = screen.getByRole('link', { name: /core\.responsive-overflow.*probe-320/u });
    const href = link.getAttribute('href');
    expect(href).toMatch(/^#/u);
    const target = document.getElementById(decodeURIComponent(href!.slice(1)));
    expect(target?.textContent).toContain('Recorded 320px probe');
    expect(target?.textContent).toContain('The document fits the viewport');
    expect(target?.textContent).toContain('Document width: 320px');
  });

  it('distinguishes saved mechanical bundles from full review runs and still opens the full review', async () => {
    savedMechanicalServer(true);
    render(<I18nProvider><WorkbenchReviewPanel projectId="p" /></I18nProvider>);
    fireEvent.click(screen.getByText('Run mechanical checks only'));
    await waitFor(() => expect(screen.getByTestId('workbench-review-bundle')).toBeTruthy());
    fireEvent.click(screen.getByText('Previous runs'));
    expect(screen.getByRole('button', { name: /Mechanical checks.*Passed/u })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Review ·.*Inconclusive/u }));
    await waitFor(() => expect(screen.getByTestId('workbench-review-run').textContent).toContain('Outcome: Inconclusive'));
    expect(screen.getByText('Outdated')).toBeTruthy();
    expect(screen.queryByTestId('workbench-review-bundle')).toBeNull();
  });

  it('starts a review with the chosen reviewers on the shared endpoint and renders the run truthfully', async () => {
    vi.mocked(getProjectRubric).mockResolvedValue({ projectId: 'p', revision: 2, rubric: null, linkage: null } as never);
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const history = emptyBundleHistory(url); if (history) return history;
      if (url === '/api/workbench/reviews') return new Response(JSON.stringify(view()), { status: 202 });
      return new Response(JSON.stringify({ projectId: 'p', runs: [] }));
    }));
    render(<I18nProvider><WorkbenchReviewPanel projectId="p" /></I18nProvider>);
    fireEvent.change(screen.getByLabelText('DeepSeek Flash (adversarial)'), { target: { value: 'off' } });
    fireEvent.change(screen.getByLabelText('Claude visual critic (Max)'), { target: { value: 'optional' } });
    fireEvent.click(screen.getByText('Start review'));
    await waitFor(() => expect(screen.getByTestId('workbench-review-run')).toBeTruthy());

    const start = calls.find(call => call.url === '/api/workbench/reviews')!;
    expect(new Headers(start.init?.headers).get('idempotency-key')).toBeTruthy();
    expect(JSON.parse(String(start.init?.body))).toMatchObject({ projectId: 'p', rubricRevision: 2, snapshot: { entry: 'index.html', versionId: null }, reviewerPlan: { reviewers: [{ role: 'jev-text', required: true }, { role: 'claude-visual', required: false }, { role: 'gemini-second-family', required: false }] } });

    expect(screen.getByText(/Outcome: Inconclusive/u)).toBeTruthy();
    expect(screen.getByText('Outdated')).toBeTruthy();
    expect(screen.getByText('index.html changed since the review')).toBeTruthy();
    expect(screen.getByText(/Start a new review run; completed evidence is kept/u)).toBeTruthy();
    expect(document.querySelector('[data-kind="judgment"]')?.textContent).toMatch(/Judgment/u);
    expect(document.querySelector('[data-kind="evidence-linked"]')?.textContent).toMatch(/Evidence: contrast-320/u);
    expect(screen.getByText('Review never edits or publishes the project.')).toBeTruthy();
  });

  it('AC-R03.1: lets the user pick a review scope from the rubric checks and sends it', async () => {
    const check = { checkId: 'win95-style', kind: 'judgment', required: false, severity: 'medium', requiredBasis: null, provenance: { origin: 'user-confirmed', derivation: 'project-input', source: null, rationale: 'r' }, evidenceTypes: ['judgment-rationale'], sourceCriteria: [], parameters: { type: 'criterion', criterion: 'Reads as Windows 95' } };
    vi.mocked(getProjectRubric).mockResolvedValue({ projectId: 'p', revision: 2, rubric: { checks: [check] }, linkage: null } as never);
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const history = emptyBundleHistory(url); if (history) return history;
      if (url === '/api/workbench/reviews') return new Response(JSON.stringify(view()), { status: 202 });
      return new Response(JSON.stringify({ projectId: 'p', runs: [] }));
    }));
    render(<I18nProvider><WorkbenchReviewPanel projectId="p" /></I18nProvider>);
    await waitFor(() => expect((screen.getByLabelText('Chosen checks') as HTMLInputElement).disabled).toBe(false));
    fireEvent.click(screen.getByLabelText('Chosen checks'));
    expect((screen.getByText('Start review').closest('button') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/Reads as Windows 95/u));
    fireEvent.click(screen.getByText('Start review'));
    await waitFor(() => expect(calls.some(call => call.url === '/api/workbench/reviews')).toBe(true));
    const body = JSON.parse(String(calls.find(call => call.url === '/api/workbench/reviews')!.init?.body));
    expect(body.scope).toEqual({ kind: 'checks', checkIds: ['win95-style'] });
  });

  it('J4-01: defaults the entry field to the project’s currently open HTML file, not a hardcoded index.html', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const history = emptyBundleHistory(url); if (history) return history;
      if (url === '/api/active') return new Response(JSON.stringify({ active: true, projectId: 'p', fileName: 'harbor-bakery.html', ts: 1 }));
      if (url === '/api/projects/p/files') return new Response(JSON.stringify({ files: [{ name: 'harbor-bakery.html', type: 'file' }, { name: 'index.html', type: 'file' }] }));
      if (url === '/api/workbench/projects/p/reviews') return new Response(JSON.stringify({ projectId: 'p', runs: [] }));
      throw new Error(`unexpected fetch: ${url}`);
    }));
    render(<I18nProvider><WorkbenchReviewPanel projectId="p" /></I18nProvider>);
    await waitFor(() => expect((screen.getByLabelText('Entry file') as HTMLInputElement).value).toBe('harbor-bakery.html'));
  });

  it('J4-01: still resolves the entry from project files when the review history request fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const history = emptyBundleHistory(url); if (history) return history;
      if (url === '/api/active') return new Response(JSON.stringify({ active: false }));
      if (url === '/api/projects/p/files') return new Response(JSON.stringify({ files: [{ name: 'landing.html', type: 'file' }] }));
      if (url === '/api/workbench/projects/p/reviews') return new Response('unavailable', { status: 503 });
      throw new Error(`unexpected fetch: ${url}`);
    }));
    render(<I18nProvider><WorkbenchReviewPanel projectId="p" /></I18nProvider>);
    await waitFor(() => expect((screen.getByLabelText('Entry file') as HTMLInputElement).value).toBe('landing.html'));
  });

  it('J4-01: falls back to the first HTML project file, then the last review run’s entry, then index.html', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const history = emptyBundleHistory(url); if (history) return history;
      if (url === '/api/active') return new Response(JSON.stringify({ active: false }));
      if (url === '/api/projects/p/files') return new Response(JSON.stringify({ files: [{ name: 'readme.md', type: 'file' }, { name: 'landing.html', type: 'file' }] }));
      if (url === '/api/workbench/projects/p/reviews') return new Response(JSON.stringify({ projectId: 'p', runs: [{ id: 'rr_1', entry: 'older.html', status: 'done', outcome: 'passed', createdAt: at, endedAt: at }] }));
      throw new Error(`unexpected fetch: ${url}`);
    }));
    render(<I18nProvider><WorkbenchReviewPanel projectId="p" /></I18nProvider>);
    await waitFor(() => expect((screen.getByLabelText('Entry file') as HTMLInputElement).value).toBe('landing.html'));

    cleanup();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const history = emptyBundleHistory(url); if (history) return history;
      if (url === '/api/active') return new Response(JSON.stringify({ active: false }));
      if (url === '/api/projects/p/files') return new Response(JSON.stringify({ files: [{ name: 'readme.md', type: 'file' }] }));
      if (url === '/api/workbench/projects/p/reviews') return new Response(JSON.stringify({ projectId: 'p', runs: [{ id: 'rr_1', entry: 'older.html', status: 'done', outcome: 'passed', createdAt: at, endedAt: at }] }));
      throw new Error(`unexpected fetch: ${url}`);
    }));
    render(<I18nProvider><WorkbenchReviewPanel projectId="p" /></I18nProvider>);
    await waitFor(() => expect((screen.getByLabelText('Entry file') as HTMLInputElement).value).toBe('older.html'));

    cleanup();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const history = emptyBundleHistory(url); if (history) return history;
      if (url === '/api/active') return new Response(JSON.stringify({ active: false }));
      if (url === '/api/projects/p/files') return new Response(JSON.stringify({ files: [] }));
      if (url === '/api/workbench/projects/p/reviews') return new Response(JSON.stringify({ projectId: 'p', runs: [] }));
      throw new Error(`unexpected fetch: ${url}`);
    }));
    render(<I18nProvider><WorkbenchReviewPanel projectId="p" /></I18nProvider>);
    await waitFor(() => expect((screen.getByLabelText('Entry file') as HTMLInputElement).value).toBe('index.html'));
  });

  it('runs the mechanical-only check on U1’s endpoint', async () => {
    const fetchMock = vi.fn(async (url: string) => emptyBundleHistory(url) ?? (url.endsWith('/review/mechanical')
      ? new Response(JSON.stringify({ error: { message: 'Another review is running; try again when it finishes' } }), { status: 409 })
      : new Response(JSON.stringify({ projectId: 'p', runs: [] }))));
    vi.stubGlobal('fetch', fetchMock);
    render(<I18nProvider><WorkbenchReviewPanel projectId="p" /></I18nProvider>);
    fireEvent.click(screen.getByText('Run mechanical checks only'));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/Another review is running/u));
    expect(fetchMock.mock.calls.some(([url]) => url === '/api/workbench/projects/p/review/mechanical')).toBe(true);
  });
});
