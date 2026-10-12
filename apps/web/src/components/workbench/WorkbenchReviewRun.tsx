import { reviewFindingDecisionProblem, renderReviewEvidenceText, type ReviewFindingDecisionAction, WORKBENCH_MIN_INDEPENDENT_REVIEWERS, type ReviewAbstainReason, type ReviewCheckVerdict, type ReviewEgressHostProblem, type ReviewerReasonCode, type ReviewerRole, type ReviewRunView, type VerificationBundle } from '@open-design/contracts';
import { Button } from '@open-design/components';
import { useI18n, useT } from '../../i18n';
import styles from './workbench.module.css';

/** Every review string lives in the typed i18n Dict under `workbench.review.*`. */
export type ReviewStringKey = 'title' | 'start' | 'mechanicalOnly' | 'cancel' | 'entry' | 'version' | 'reviewers' | 'required' | 'optional' | 'off' | 'scope' | 'scopeAll' | 'scopeChecks' | 'scopeMandatory' | 'running' | 'runs' | 'outcome' | 'passed' | 'failed' | 'inconclusive' | 'pending' | 'outdated' | 'current' | 'interrupted' | 'evidence' | 'judgment' | 'frozen' | 'recovery' | 'independent' | 'incomplete' | 'findings' | 'noFindings' | 'error' | 'mechanical' | 'noAutoApply' | 'supports' | 'disputes' | 'uncertain' | 'jev-text' | 'claude-visual' | 'deepseek-adversarial' | 'gemini-second-family' | 'modelUnverified' | 'rubricContext' | 'sources'
  | 'egress' | 'egressHelp' | 'egressHost' | 'egressAdd' | 'egressRemove' | 'egressNone' | 'egressDuplicate' | 'egressTooMany' | `egressProblem.${ReviewEgressHostProblem}` | 'egressFetched' | 'consoleErrors' | 'legacyEvidence'
  | 'verdicts' | `verdict.${ReviewCheckVerdict['status']}` | `origin.${ReviewCheckVerdict['origin']}` | `basis.${ReviewCheckVerdict['applicability']['basis']}`
  | 'answers' | 'supportsCount' | 'disputesCount' | 'uncertainCount' | 'sourceAnchors' | 'rubricContent' | 'minReviewers' | 'humanGate'
  | 'advisory' | 'accept' | 'dismiss' | 'accepted' | 'dismissed' | 'localUser' | 'cannotDismissRequired' | 'cannotDecideUnverified' | 'cannotDecideMechanical' | 'waitForReview'
  | `reasonCode.${ReviewerReasonCode}` | `agyReasonCode.${'cli-missing' | 'cli-auth-missing' | 'cli-outdated' | 'cli-failed'}` | `abstain.${ReviewAbstainReason}`;

export function useReviewStrings(): (key: ReviewStringKey) => string {
  const t = useT();
  return key => t(`workbench.review.${key}`);
}

export const roleLabel = (s: (key: ReviewStringKey) => string, role: ReviewerRole) => s(role);

// The daemon serves legacy (v1) fetch URLs already reduced to origin + digest,
// and a console source whose origin it could not vouch for only as a digest.
const sourceOrigin = (source: { origin: string | null; originSha256?: string | null }) =>
  source.origin ?? `~origin:${(source.originSha256 ?? '').slice(0, 12)}`;

/** One review run: outcome, freshness, reasons, reviewer records and every claim with its evidence or judgment label. */
export function WorkbenchReviewRun({ view, onCancel, onDecision, decisionBusy = false }: { view: ReviewRunView; onCancel?: () => void; onDecision?: (findingId: string, action: ReviewFindingDecisionAction) => void; decisionBusy?: boolean }) {
  const s = useReviewStrings();
  const { run, freshness } = view;
  const outcome = run.outcome ?? 'pending';
  return <section className={styles.card} aria-label={s('outcome')} data-testid="workbench-review-run">
    <div className={styles.actions}>
      <strong data-outcome={outcome}>{s('outcome')}: {s(outcome)}</strong>
      <span data-freshness={freshness.state}>{s(freshness.state)}</span>
      {run.operation.status === 'interrupted' ? <span>{s('interrupted')} ({run.operation.interruptReason})</span> : null}
      {run.outcome === null && onCancel ? <Button size="sm" onClick={onCancel}>{s('cancel')}</Button> : null}
    </div>
    {run.outcome === null ? <p role="status">{s('running')} ({run.operation.stage})</p> : null}
    {freshness.reasons.length ? <ul aria-label={s('outdated')}>{freshness.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul> : null}
    {run.reasons.length ? <ul>{run.reasons.map(reason => <li key={`${reason.code}:${reason.message}`} data-reason={reason.code}>{reason.message}</li>)}</ul> : null}
    <p data-testid="workbench-review-independent">{s('independent')}: {run.completedIndependentReviewers} / {WORKBENCH_MIN_INDEPENDENT_REVIEWERS}</p>
    {run.incompleteCheckIds.length ? <p>{s('incomplete')}: {run.incompleteCheckIds.join(', ')}</p> : null}
    <details>
      <summary>{s('frozen')}</summary>
      <dl>
        <dt>{s('entry')}</dt><dd>{run.frozen.snapshot.entry}{run.frozen.snapshot.versionId ? ` @ ${run.frozen.snapshot.versionId}` : ''}</dd>
        <dt>{s('rubricContext')}</dt><dd>{run.frozen.rubricRevision} / {run.frozen.contextRevision}</dd>
        <dt>{s('scope')}</dt><dd>{run.frozen.scope.kind === 'all' ? s('scopeAll') : run.frozen.scope.checkIds.join(', ')}</dd>
        <dt>{s('sources')}</dt><dd>{run.frozen.sourceHashes.length}</dd>
        <dt>{s('egress')}</dt><dd>{run.frozen.egress?.allowHosts.length ? run.frozen.egress.allowHosts.join(', ') : s('egressNone')}</dd>
        {run.frozen.rubricContent ? <><dt>{s('rubricContent')}</dt><dd>{run.frozen.rubricContent.judgmentSeeds} · {run.frozen.rubricContent.checklistCriteria} · {run.frozen.rubricContent.checklistSource.sourceId}@{run.frozen.rubricContent.checklistSource.revisionOrDigest.slice(0, 12)}</dd></> : null}
        <dt>{s('evidence')}</dt><dd>{run.bundleId ?? '—'}{run.screenshotEvidenceIds.length ? `, ${run.screenshotEvidenceIds.join(', ')}` : ''}</dd>
      </dl>
    </details>
    <h4>{s('reviewers')}</h4>
    <ul>{run.reviewers.map(reviewer => <li key={reviewer.role} data-reviewer={reviewer.role} data-status={reviewer.status}>
      {roleLabel(s, reviewer.role)} · {reviewer.modelId}{reviewer.provider === 'gemini' ? ` (${s('modelUnverified')})` : ''} · {reviewer.required ? s('required') : s('optional')} · {reviewer.status}{reviewer.inputMode ? ` · ${reviewer.inputMode}` : ''}
      {reviewer.reasonCode ? <> · <span data-reason-code={reviewer.reasonCode}>{s(reviewer.provider === 'gemini' && (reviewer.reasonCode === 'cli-missing' || reviewer.reasonCode === 'cli-auth-missing' || reviewer.reasonCode === 'cli-outdated' || reviewer.reasonCode === 'cli-failed') ? `agyReasonCode.${reviewer.reasonCode}` : `reasonCode.${reviewer.reasonCode}`)}</span></> : null}
      {reviewer.reason ? <div>{reviewer.reason}{reviewer.recovery ? <> — {s('recovery')}: {reviewer.recovery}</> : null}</div> : null}
    </li>)}</ul>
    {run.checkVerdicts?.length ? <WorkbenchReviewVerdicts verdicts={run.checkVerdicts} /> : null}
    <h4>{s('findings')}</h4>
    {run.findings.length ? <ul>{run.findings.map(finding => {
      const problem = reviewFindingDecisionProblem(run, finding);
      return <li key={finding.id} data-kind={finding.kind} data-abstain={finding.abstainReason}>
      <strong>{finding.checkId}</strong> · {roleLabel(s, finding.reviewerRole)} · {s(finding.verdict)}{finding.probability === null ? '' : ` (${finding.probability.toFixed(2)})`} · {finding.kind === 'evidence-linked' ? `${s('evidence')}: ${finding.evidenceRefs.join(', ')}` : s('judgment')}{finding.abstainReason ? ` · ${s(`abstain.${finding.abstainReason}`)}` : ''}
      {finding.rationale ? <div>{finding.rationale}</div> : null}
      {problem ? <p role="note">{s(problem === 'required-check' ? 'cannotDismissRequired' : problem === 'not-advisory' ? 'cannotDecideMechanical' : problem === 'run-active' ? 'waitForReview' : 'cannotDecideUnverified')}</p> : <>
        {!finding.decisions?.length ? <p>{s('advisory')}</p> : null}
        {onDecision ? <div className={styles.actions} role="group" aria-label={finding.checkId}>
          <Button variant="secondary" size="sm" disabled={decisionBusy} onClick={() => onDecision(finding.id, 'accept')}>{s('accept')}</Button>
          <Button variant="ghost" size="sm" disabled={decisionBusy} onClick={() => onDecision(finding.id, 'dismiss')}>{s('dismiss')}</Button>
        </div> : null}
      </>}
      {finding.decisions?.length ? <ul aria-label={s('judgment')}>{finding.decisions.map((decision, index) => <li key={index}>
        {s(decision.action === 'accept' ? 'accepted' : 'dismissed')} · {decision.actor.kind === 'local-user' ? s('localUser') : `${decision.actor.workspaceId} / ${decision.actor.workspaceMemberId}`} · <time dateTime={decision.at}>{decision.at}</time>
      </li>)}</ul> : null}
    </li>; })}</ul> : <p>{s('noFindings')}</p>}
    <p>{s('noAutoApply')}</p>
  </section>;
}

/**
 * B5-1: one row per check verdict (AC-R06.3–R06.5): status, whether it is
 * required, where the check came from, why it applies, how independent
 * reviewers answered and the source anchors it cites. `od workbench review
 * show` returns the same records.
 */
export function WorkbenchReviewVerdicts({ verdicts }: { verdicts: readonly ReviewCheckVerdict[] }) {
  const s = useReviewStrings();
  const { locale } = useI18n();
  // Human acceptance is the owner-gated U2 flow, not built yet: say so wherever a required gate is open.
  const gates = verdicts.filter(verdict => verdict.required && (verdict.status === 'awaiting-manual' || verdict.status === 'awaiting-acceptance'));
  return <>
    <h4>{s('verdicts')}</h4>
    {gates.length ? <p role="note" data-testid="review-human-gate">{s('humanGate')} {gates.map(verdict => verdict.checkId).join(', ')}</p> : null}
    <ul data-testid="workbench-review-verdicts">{verdicts.map(verdict => <li key={verdict.checkId} data-check-id={verdict.checkId} data-status={verdict.status} data-required={verdict.required}>
      <strong>{verdict.checkId}</strong> · {s(`verdict.${verdict.status}`)} · {verdict.required ? s('required') : s('optional')} · {s(`origin.${verdict.origin}`)}
      {' · '}{s(`basis.${verdict.applicability.basis}`)}{verdict.applicability.behaviors.length ? ` (${verdict.applicability.behaviors.join(', ')})` : ''}
      {verdict.required && ['fail', 'inconclusive', 'awaiting-manual', 'awaiting-acceptance'].includes(verdict.status) ? <p role="note">{s('cannotDismissRequired')}</p> : null}
      <div>{renderReviewEvidenceText(verdict.reason, locale)}</div>
      {verdict.kind !== 'manual' ? <div>{s('answers')}: {verdict.reviewerAnswers.supports} {s('supportsCount')} · {verdict.reviewerAnswers.disputes} {s('disputesCount')} · {verdict.reviewerAnswers.uncertain} {s('uncertainCount')}</div> : null}
      {verdict.sourceCriteria.length ? <div>{s('sourceAnchors')}: {verdict.sourceCriteria.map(source => <a key={source.criterionId} href={source.canonicalUrl} target="_blank" rel="noreferrer"><code>{source.criterionId}</code> @ {source.revisionOrDigest.slice(0, 12)}</a>)}</div> : null}
    </li>)}</ul>
  </>;
}

/**
 * U1's mechanical-only bundle, shown with its per-check outcomes and recovery.
 * Every reason, recovery, summary and observation is rendered from the
 * contract's evidence template table in the reader's locale; only legacy
 * bundles (marked by the daemon) can still carry a plain string.
 */
export function WorkbenchReviewBundle({ bundle }: { bundle: VerificationBundle }) {
  const s = useReviewStrings();
  const { locale } = useI18n();
  const text = (value: Parameters<typeof renderReviewEvidenceText>[0]) => renderReviewEvidenceText(value, locale);
  return <section className={styles.card} aria-label={s('mechanical')} data-testid="workbench-review-bundle">
    <strong data-outcome={bundle.outcome}>{s('mechanical')}: {s(bundle.outcome)}</strong>
    {bundle.legacy ? <p data-testid="workbench-review-legacy"><small>{s('legacyEvidence')}</small></p> : null}
    <ul>{bundle.results.map(result => <li key={result.checkId} data-outcome={result.outcome}>{result.checkId} · {result.outcome} · {text(result.reason)}{result.recovery ? ` — ${s('recovery')}: ${text(result.recovery)}` : ''}</li>)}</ul>
    {bundle.console?.entries.length ? <details data-testid="workbench-review-console">
      <summary>{s('consoleErrors')}: {bundle.console.entries.reduce((sum, entry) => sum + entry.count, 0)} ({bundle.console.entries.map(entry => entry.sha256.slice(0, 12)).join(', ')})</summary>
      <ul>{bundle.console.entries.map(entry => <li key={entry.id}>
        {entry.kind} · {entry.length} · {entry.sha256.slice(0, 12)} · {entry.source ? `${sourceOrigin(entry.source)}${entry.source.path ?? (entry.source.pathQuerySha256 ? `/~${entry.source.pathQuerySha256.slice(0, 12)}` : '')}:${entry.source.line}:${entry.source.column}` : '—'} · ×{entry.count}
      </li>)}</ul>
    </details> : null}
    {bundle.egress?.allowHosts.length ? <details data-testid="workbench-review-egress">
      <summary>{s('egressFetched')}: {bundle.egress.fetches.filter(fetch => fetch.outcome === 'fetched').length} / {bundle.egress.fetches.length}</summary>
      <ul>{bundle.egress.fetches.map((fetch, index) => <li key={`${fetch.host}:${index}`} data-outcome={fetch.outcome}>
        {/* Older (v1) records carry a url; only its origin is shown. */}
        {'origin' in fetch ? `${fetch.origin} · ${fetch.pathDepth} · ${fetch.pathQuerySha256.slice(0, 12)}` : fetch.url} · {fetch.outcome}{fetch.status ? ` · ${fetch.status}` : ''}{fetch.resolvedAddress ? ` · ${fetch.resolvedAddress}` : ''}{fetch.reason ? ` · ${text(fetch.reason)}` : ''}
      </li>)}</ul>
    </details> : null}
    <p>{bundle.conformanceNote}</p>
  </section>;
}
