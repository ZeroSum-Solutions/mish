import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@open-design/components';
import {
  parseReviewRunList, parseReviewRunView, parseRunMechanicalReviewRequest, parseStartReviewRunRequest, parseVerificationBundle, parseVerificationBundleList, renderReviewEvidenceText, resolveDefaultReviewEntry, reviewEgressHostProblem,
  WORKBENCH_DEFAULT_REQUIRED_ROLES, WORKBENCH_MIN_INDEPENDENT_REVIEWERS, WORKBENCH_REVIEW_EGRESS_LIMITS, WORKBENCH_REVIEWER_ROLES, type ReviewFindingDecisionAction, type ReviewerRole, type ReviewRunSummary, type ReviewScope, type ReviewRunView, type VerificationBundle, type VerificationBundleSummary, type WorkspaceCollabContext,
} from '@open-design/contracts';
import { useI18n } from '../../i18n';
import { workspaceProjectHeaders } from '../../collab/workspace-identity';
import { getProjectRubric } from '../../providers/workbench';
import { useReviewStrings, WorkbenchReviewBundle, WorkbenchReviewRun } from './WorkbenchReviewRun';
import styles from './workbench.module.css';

type Choice = 'required' | 'optional' | 'off';
const POLL_MS = 1500;

function headers(projectId: string, workspaceContext?: WorkspaceCollabContext | null, extra: Record<string, string> = {}): Record<string, string> {
  return { ...(workspaceContext ? workspaceProjectHeaders(workspaceContext) as Record<string, string> : {}), 'x-od-project-id': projectId, ...extra };
}
async function json(response: Response): Promise<unknown> {
  const body: unknown = await response.json();
  if (!response.ok) {
    const error = body && typeof body === 'object' && 'error' in body ? (body as { error: { message?: unknown } }).error : null;
    throw new Error(typeof error?.message === 'string' ? error.message : `HTTP ${response.status}`);
  }
  return body;
}

/** The per-run allow-list field; omitted when empty, so a default request stays byte-identical (default-deny). */
const egressField = (allowHosts: string[] | undefined) => (allowHosts?.length ? { egress: { allowHosts } } : {});

/** Same /api endpoints as `od workbench review start|show|cancel|runs|run`. */
export const reviewApi = {
  async start(projectId: string, input: { entry: string; versionId: string | null; scope: ReviewScope; rubricRevision: number; reviewers: { role: ReviewerRole; required: boolean }[]; allowHosts?: string[] }, workspaceContext?: WorkspaceCollabContext | null): Promise<ReviewRunView> {
    const body = parseStartReviewRunRequest({ projectId, snapshot: { entry: input.entry, versionId: input.versionId }, scope: input.scope, rubricRevision: input.rubricRevision, reviewerPlan: { reviewers: input.reviewers }, ...egressField(input.allowHosts) });
    const key = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `web-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return parseReviewRunView(await json(await fetch('/api/workbench/reviews', { method: 'POST', headers: headers(projectId, workspaceContext, { 'content-type': 'application/json', 'idempotency-key': key }), body: JSON.stringify(body) })));
  },
  async show(projectId: string, runId: string, workspaceContext?: WorkspaceCollabContext | null): Promise<ReviewRunView> {
    return parseReviewRunView(await json(await fetch(`/api/workbench/reviews/${encodeURIComponent(runId)}`, { headers: headers(projectId, workspaceContext) })));
  },
  async cancel(projectId: string, runId: string, workspaceContext?: WorkspaceCollabContext | null): Promise<ReviewRunView> {
    return parseReviewRunView(await json(await fetch(`/api/workbench/reviews/${encodeURIComponent(runId)}/cancel`, { method: 'POST', headers: headers(projectId, workspaceContext) })));
  },
  async decide(projectId: string, runId: string, findingId: string, action: ReviewFindingDecisionAction, workspaceContext?: WorkspaceCollabContext | null): Promise<ReviewRunView> {
    return parseReviewRunView(await json(await fetch(`/api/workbench/reviews/${encodeURIComponent(runId)}/findings/${encodeURIComponent(findingId)}/decision`, { method: 'POST', headers: headers(projectId, workspaceContext, { 'content-type': 'application/json' }), body: JSON.stringify({ action }) })));
  },
  async list(projectId: string, workspaceContext?: WorkspaceCollabContext | null): Promise<ReviewRunSummary[]> {
    return parseReviewRunList(await json(await fetch(`/api/workbench/projects/${encodeURIComponent(projectId)}/reviews`, { headers: headers(projectId, workspaceContext) }))).runs;
  },
  async mechanical(projectId: string, entry: string, workspaceContext?: WorkspaceCollabContext | null, allowHosts?: string[]): Promise<VerificationBundle> {
    const body = parseRunMechanicalReviewRequest({ entry, ...egressField(allowHosts) });
    const saved = parseVerificationBundle(await json(await fetch(`/api/workbench/projects/${encodeURIComponent(projectId)}/review/mechanical`, { method: 'POST', headers: headers(projectId, workspaceContext, { 'content-type': 'application/json' }), body: JSON.stringify(body) })));
    if (saved.projectId !== projectId) throw new Error('Review evidence does not match the project');
    return saved;
  },
  async bundles(projectId: string, workspaceContext?: WorkspaceCollabContext | null): Promise<VerificationBundleSummary[]> {
    const list = parseVerificationBundleList(await json(await fetch(`/api/workbench/projects/${encodeURIComponent(projectId)}/review/bundles`, { headers: headers(projectId, workspaceContext) })));
    if (list.projectId !== projectId) throw new Error('Review history does not match the project');
    return list.bundles;
  },
  async bundle(projectId: string, bundleId: string, workspaceContext?: WorkspaceCollabContext | null): Promise<VerificationBundle> {
    const saved = parseVerificationBundle(await json(await fetch(`/api/workbench/projects/${encodeURIComponent(projectId)}/review/bundles/${encodeURIComponent(bundleId)}`, { headers: headers(projectId, workspaceContext) })));
    if (saved.projectId !== projectId || saved.id !== bundleId) throw new Error('Review evidence does not match the requested bundle');
    return saved;
  },
};

/**
 * J4-01: the Start form's entry field defaulted to a hardcoded `index.html`
 * no matter which page the project serves, so reviewing a project whose page
 * is e.g. `harbor-bakery.html` ended "Inconclusive: the entry file could not
 * be served". This resolves the same default the `od workbench review start`
 * CLI path now computes (see `review-cli.ts`): the project's currently open
 * file (the daemon's soft `/api/active` channel) when it is HTML, else the
 * project's first HTML file, else the entry of the project's last review
 * run. Any fetch failure or unresolved tier falls back to the historical
 * `index.html` so the field is never left blank.
 */
export async function resolveReviewEntryDefault(projectId: string, lastRunEntry: string | null, workspaceContext?: WorkspaceCollabContext | null): Promise<string> {
  const activeFileName = await fetch('/api/active')
    .then(response => (response.ok ? response.json() as Promise<{ active?: boolean; projectId?: string; fileName?: string | null }> : null))
    .then(active => (active?.active && active.projectId === projectId && typeof active.fileName === 'string' ? active.fileName : null))
    .catch(() => null);
  const projectFileNames = await fetch(`/api/projects/${encodeURIComponent(projectId)}/files`, { headers: headers(projectId, workspaceContext) })
    .then(response => (response.ok ? response.json() as Promise<{ files?: { name: string; type?: string }[] }> : null))
    .then(body => (body?.files ?? []).filter(file => file.type !== 'dir').map(file => file.name))
    .catch(() => [] as string[]);
  return resolveDefaultReviewEntry({ activeFileName, projectFileNames, lastRunEntry }) ?? 'index.html';
}

/**
 * Review surface for one project (AC-R03.1–R03.4, AC-R06.2 UI): pick the saved
 * revision and reviewers, start a frozen multi-model review or a mechanical-only
 * check, watch partial status, cancel, and read earlier runs with their
 * outdated marker. It never edits or publishes the project.
 */
export function WorkbenchReviewPanel({ projectId, workspaceContext }: { projectId: string; workspaceContext?: WorkspaceCollabContext | null }) {
  const s = useReviewStrings();
  const { locale, t } = useI18n();
  const evidencePrefix = useId();
  const [entry, setEntry] = useState('index.html');
  const [versionId, setVersionId] = useState('');
  const [choices, setChoices] = useState<Record<ReviewerRole, Choice>>(() => Object.fromEntries(WORKBENCH_REVIEWER_ROLES.map(role => [role, (WORKBENCH_DEFAULT_REQUIRED_ROLES as readonly string[]).includes(role) ? 'required' : 'optional'])) as Record<ReviewerRole, Choice>);
  const [scopeKind, setScopeKind] = useState<'all' | 'checks'>('all');
  const [rubricChecks, setRubricChecks] = useState<{ checkId: string; label: string }[]>([]);
  const [chosen, setChosen] = useState<string[]>([]);
  const [runs, setRuns] = useState<ReviewRunSummary[]>([]);
  const [bundles, setBundles] = useState<VerificationBundleSummary[]>([]);
  const [historyFailed, setHistoryFailed] = useState(false);
  const [view, setView] = useState<ReviewRunView | null>(null);
  const [bundle, setBundle] = useState<VerificationBundle | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // B4-2: the run's egress allow-list. Empty by default; validated by the shared contract rules.
  const [hosts, setHosts] = useState<string[]>([]);
  const [hostDraft, setHostDraft] = useState('');
  const [hostError, setHostError] = useState('');
  const hostErrorId = useId();
  const live = useRef(projectId); live.current = projectId;
  const selected = useRef(view); selected.current = view;
  const liveWorkspace = useRef(workspaceContext); liveWorkspace.current = workspaceContext;
  const scopeEpoch = useRef(0);
  const historyRequest = useRef(0);
  // AC-R03.2: two or more independent reviewers close a review scope; say so before the run, not only after.
  const selectedReviewers = WORKBENCH_REVIEWER_ROLES.filter(role => choices[role] !== 'off').length;

  useEffect(() => {
    let cancelled = false;
    scopeEpoch.current += 1;
    setView(null); setBundle(null); setError(''); setBusy(false); setHistoryFailed(false);
    setRuns([]); setBundles([]);
    setScopeKind('all'); setChosen([]); setRubricChecks([]);
    setHosts([]); setHostDraft(''); setHostError('');
    void refreshBundles();
    // J4-01: resolve the entry default from the open file and project files even
    // when the review history is unavailable; history only adds the last-run fallback.
    reviewApi.list(projectId, workspaceContext).then(list => {
      if (cancelled || live.current !== projectId) return null;
      setRuns(list);
      return list[0]?.entry ?? null;
    }, () => null).then(lastRunEntry => {
      if (cancelled || live.current !== projectId) return;
      void resolveReviewEntryDefault(projectId, lastRunEntry, workspaceContext).then(next => { if (!cancelled && live.current === projectId) setEntry(next); });
    }).catch(() => undefined);
    // The scope picker offers the project's rubric checks (AC-R03.1 "selects ... review scope").
    Promise.resolve(getProjectRubric(projectId, workspaceContext)).then(record => {
      if (cancelled || live.current !== projectId) return;
      setRubricChecks((record?.rubric?.checks ?? []).map(check => ({ checkId: check.checkId, label: check.parameters.type === 'criterion' ? check.parameters.criterion : check.checkId })));
    }).catch(() => undefined);
    return () => { cancelled = true; scopeEpoch.current += 1; historyRequest.current += 1; };
  }, [projectId, workspaceContext]);

  // Poll the selected run until it reaches a terminal status (partial status stays visible meanwhile).
  useEffect(() => {
    if (!view || view.run.outcome !== null) return;
    const timer = setTimeout(() => {
      reviewApi.show(projectId, view.run.id, workspaceContext).then(next => { if (live.current === projectId) setView(next); }).catch(() => undefined);
    }, POLL_MS);
    return () => clearTimeout(timer);
  }, [view, projectId, workspaceContext]);

  function addHost() {
    const problem = reviewEgressHostProblem(hostDraft);
    const host = hostDraft.toLowerCase();
    const message = problem ? s(`egressProblem.${problem}`)
      : hosts.includes(host) ? s('egressDuplicate')
        : hosts.length >= WORKBENCH_REVIEW_EGRESS_LIMITS.maxHosts ? s('egressTooMany') : '';
    setHostError(message);
    if (message) return;
    setHosts([...hosts, host]); setHostDraft('');
  }

  async function act(work: () => Promise<void>) {
    const epoch = scopeEpoch.current;
    setBusy(true); setError('');
    try { await work(); }
    catch (failure) { if (scopeEpoch.current === epoch) setError(`${s('error')}: ${failure instanceof Error ? failure.message : ''}`); }
    finally { if (scopeEpoch.current === epoch) setBusy(false); }
  }
  async function refreshBundles() {
    const epoch = scopeEpoch.current;
    const request = ++historyRequest.current;
    const current = () => scopeEpoch.current === epoch && historyRequest.current === request && live.current === projectId && liveWorkspace.current === workspaceContext;
    try {
      const list = await reviewApi.bundles(projectId, workspaceContext);
      if (current()) { setBundles(list); setHistoryFailed(false); }
    } catch {
      if (current()) setHistoryFailed(true);
    }
  }
  const start = () => act(async () => {
    const rubric = await getProjectRubric(projectId, workspaceContext);
    const reviewers = WORKBENCH_REVIEWER_ROLES.filter(role => choices[role] !== 'off').map(role => ({ role, required: choices[role] === 'required' }));
    const scope: ReviewScope = scopeKind === 'checks' ? { kind: 'checks', checkIds: chosen } : { kind: 'all' };
    const next = await reviewApi.start(projectId, { entry, versionId: versionId.trim() || null, scope, rubricRevision: rubric.revision, reviewers, allowHosts: hosts }, workspaceContext);
    setView(next); setBundle(null);
    setRuns(await reviewApi.list(projectId, workspaceContext));
  });
  const mechanical = () => act(async () => {
    const epoch = scopeEpoch.current;
    const next = await reviewApi.mechanical(projectId, entry, workspaceContext, hosts);
    if (scopeEpoch.current !== epoch || live.current !== projectId || liveWorkspace.current !== workspaceContext) return;
    setBundle(next); setView(null);
    // The successful POST already persisted this terminal result. A history
    // refresh failure must not turn it into a failed check or hide its receipt.
    const summary: VerificationBundleSummary = { id: next.id, entry: next.entry, outcome: next.outcome, startedAt: next.startedAt, endedAt: next.endedAt, ...(next.legacy ? { legacy: true } : {}) };
    setBundles(previous => [summary, ...previous.filter(saved => saved.id !== next.id)].slice(0, 200));
    void refreshBundles();
  });
  const cancel = () => act(async () => { if (view) setView(await reviewApi.cancel(projectId, view.run.id, workspaceContext)); });
  const decide = (findingId: string, action: ReviewFindingDecisionAction) => act(async () => {
    if (!view) return;
    const currentProject = projectId;
    const runId = view.run.id;
    const next = await reviewApi.decide(projectId, runId, findingId, action, workspaceContext);
    if (live.current === currentProject && selected.current?.run.id === runId && liveWorkspace.current === workspaceContext) setView(next);
  });
  const open = (runId: string) => act(async () => { setView(await reviewApi.show(projectId, runId, workspaceContext)); setBundle(null); });
  const openBundle = (bundleId: string) => act(async () => {
    const epoch = scopeEpoch.current;
    const saved = await reviewApi.bundle(projectId, bundleId, workspaceContext);
    if (scopeEpoch.current === epoch && live.current === projectId && liveWorkspace.current === workspaceContext) { setBundle(saved); setView(null); }
  });
  const evidenceAnchor = (id: string) => `${evidencePrefix}-${bundle?.id}-${id}`;

  return <section className={styles.editor} aria-label={s('title')} data-testid="workbench-review-panel">
    <h3>{s('title')}</h3>
    <fieldset disabled={busy} className={styles.fields}>
      <label>{s('entry')}<input value={entry} onChange={event => setEntry(event.target.value)} /></label>
      <label>{s('version')}<input value={versionId} onChange={event => setVersionId(event.target.value)} /></label>
      <fieldset>
        <legend>{s('scope')}</legend>
        <label><input type="radio" name="review-scope" checked={scopeKind === 'all'} onChange={() => setScopeKind('all')} />{s('scopeAll')}</label>
        <label><input type="radio" name="review-scope" checked={scopeKind === 'checks'} disabled={!rubricChecks.length} onChange={() => setScopeKind('checks')} />{s('scopeChecks')}</label>
        {scopeKind === 'checks' ? rubricChecks.map(check => <label key={check.checkId}>
          <input type="checkbox" checked={chosen.includes(check.checkId)} onChange={event => setChosen(event.target.checked ? [...chosen, check.checkId] : chosen.filter(id => id !== check.checkId))} />
          {check.label} <code>{check.checkId}</code>
        </label>) : null}
        {scopeKind === 'checks' ? <p>{s('scopeMandatory')}</p> : null}
      </fieldset>
      <fieldset>
        <legend>{s('reviewers')}</legend>
        {WORKBENCH_REVIEWER_ROLES.map(role => <label key={role}>{s(role)}
          <select aria-label={s(role)} value={choices[role]} onChange={event => setChoices({ ...choices, [role]: event.target.value as Choice })}>
            <option value="required">{s('required')}</option><option value="optional">{s('optional')}</option><option value="off">{s('off')}</option>
          </select>
        </label>)}
        {selectedReviewers < WORKBENCH_MIN_INDEPENDENT_REVIEWERS ? <p role="status" data-testid="review-min-reviewers">{s('minReviewers')}</p> : null}
      </fieldset>
      <fieldset>
        <legend>{s('egress')}</legend>
        <p>{s('egressHelp')}</p>
        <label>{s('egressHost')}<input value={hostDraft} aria-invalid={hostError ? true : undefined} aria-describedby={hostError ? hostErrorId : undefined} autoCapitalize="none" spellCheck={false} placeholder="fonts.example.com"
          onChange={event => { setHostDraft(event.target.value); setHostError(''); }} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); addHost(); } }} /></label>
        <div className={styles.actions}><Button size="sm" onClick={addHost}>{s('egressAdd')}</Button></div>
        {hostError ? <p id={hostErrorId} role="alert">{hostError}</p> : null}
        {hosts.length ? <ul>{hosts.map(host => <li key={host} data-testid="review-egress-host"><code>{host}</code> <Button size="sm" aria-label={`${s('egressRemove')} ${host}`} onClick={() => setHosts(hosts.filter(item => item !== host))}>{s('egressRemove')}</Button></li>)}</ul>
          : <p>{s('egressNone')}</p>}
      </fieldset>
      <div className={styles.actions}>
        <Button size="sm" disabled={scopeKind === 'checks' && !chosen.length} onClick={() => void start()}>{s('start')}</Button>
        <Button size="sm" onClick={() => void mechanical()}>{s('mechanicalOnly')}</Button>
      </div>
    </fieldset>
    {error ? <p role="alert">{error}</p> : null}
    {historyFailed ? <p role="status">{t('workbench.review.historyLoadFailed')}</p> : null}
    {view ? <WorkbenchReviewRun view={view} onCancel={() => void cancel()} onDecision={(findingId, action) => void decide(findingId, action)} decisionBusy={busy} /> : null}
    {bundle ? <>
      <WorkbenchReviewBundle bundle={bundle} />
      {bundle.evidence.length ? <section className={`${styles.card} ${styles.reviewEvidence}`} aria-label={s('evidence')}>
        <h4>{s('evidence')}</h4>
        <ul>{bundle.results.filter(result => result.evidenceIds.length).map(result => <li key={result.checkId}>
          {result.evidenceIds.map(id => <a key={id} href={`#${encodeURIComponent(evidenceAnchor(id))}`}>{result.checkId} · {s('evidence')}: {id}</a>)}
        </li>)}</ul>
        <ul>{bundle.evidence.map(item => <li key={item.id} id={evidenceAnchor(item.id)} tabIndex={-1}>
          <strong>{item.id}</strong> · {item.type}{item.viewport === null ? '' : ` · ${item.viewport}px`}
          <p>{renderReviewEvidenceText(item.summary, locale)}</p>
          <ul>{[...item.observations, ...(item.detail ?? [])].map((text, index) => <li key={index}>{renderReviewEvidenceText(text, locale)}</li>)}</ul>
        </li>)}</ul>
      </section> : null}
    </> : null}
    {runs.length || bundles.length ? <details><summary>{s('runs')}</summary>
      {runs.length ? <ul className={styles.reviewHistory} aria-label={`${s('runs')} · ${s('title')}`}>{runs.map(run => <li key={run.id}>
        <Button size="sm" className={styles.reviewHistoryButton} disabled={busy} onClick={() => void open(run.id)}>{s('title')} · {run.createdAt} · {run.entry} · {run.outcome ? s(run.outcome) : s('pending')}</Button>
      </li>)}</ul> : null}
      {bundles.length ? <ul className={styles.reviewHistory} aria-label={`${s('runs')} · ${s('mechanical')}`}>{bundles.map(saved => <li key={saved.id}>
        <Button size="sm" className={styles.reviewHistoryButton} disabled={busy} onClick={() => void openBundle(saved.id)}>{s('mechanical')} · {saved.startedAt} · {saved.entry} · {s(saved.outcome)}</Button>
      </li>)}</ul> : null}
    </details> : null}
  </section>;
}
