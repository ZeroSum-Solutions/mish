import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Badge, Button, DisclosureRow, Input, Select } from '@mish/components';
import {
  SOURCE_OPERATIONS, integrationTestability, parseLicenceRecordSnapshot,
  type IntegrationRoster, type IntegrationRosterEntry, type LicenceDraft, type LicenceRecord, type LicenceRecordSnapshot,
} from '@mish/contracts';
import { useT } from '../../i18n';
import { getIntegrationRoster, putLicenceRecord, testIntegration } from '../../providers/workbench-integrations';
import { WorkbenchRequestError } from '../../providers/workbench';
import styles from './WorkbenchIntegrationRoster.module.css';

type Operation = (typeof SOURCE_OPERATIONS)[number];
type TermsKind = NonNullable<LicenceDraft['termsEvidence']>['kind'];
type ScopeRow = { decision: 'pending' | 'allowed' | 'blocked'; clauses: string; reassessed: boolean };
type FormFields = { holder: string; termsVersion: string; termsKind: TermsKind; digest: string; citation: string; cited: string; scope: Record<Operation, ScopeRow> };
type Change = { field: string; mine: string; saved: string };
const TERMS_KINDS: TermsKind[] = ['terms-version', 'agreement', 'vendor-account-record'];
const clauses = (value: string) => value.split(',').map(item => item.trim()).filter(Boolean);
const readinessTone = (readiness: IntegrationRosterEntry['readiness']) => readiness === 'usable' ? 'success' : readiness === 'needs-repair' ? 'danger' : readiness === 'unavailable' ? 'warning' : 'neutral';

/** One display status: installation evidence stays distinct from connection and dated workflow use. */
function rowStatus(entry: IntegrationRosterEntry) {
  const capability = integrationTestability(entry);
  const runtime = capability.testable ? entry.runtime : undefined;
  const recorded = entry.lastVerifiedUse;
  const checked = runtime?.workflow.lastSuccess;
  const use = checked && (!recorded || Date.parse(checked.at) > Date.parse(recorded.at))
    ? { ...checked, surfaces: null } : recorded;
  const connection = runtime?.connection === 'missing' && runtime.installed === 'installed' && runtime.workflow.lastTest?.outcome !== 'failed'
    ? 'not-checked' as const : runtime?.connection;
  return { capability, runtime, use, connection, installState: entry.installState,
    readiness: !runtime && !use ? entry.readiness : null,
    availability: (!runtime && !use) || entry.availability.state === 'deferred' || entry.availability.state === 'unavailable' ? entry.availability : null,
    fix: runtime && connection !== 'connected' ? runtime.fix : null };
}

function fieldsFrom(record: LicenceRecord | null): FormFields {
  return {
    holder: record?.holder ?? '', termsVersion: record?.termsVersion ?? '', termsKind: record?.termsEvidence?.kind ?? 'terms-version',
    digest: record?.termsEvidence?.sha256 ?? '', citation: record?.termsEvidence?.citationUrl ?? '', cited: record?.termsEvidence?.clauseRefs.join(', ') ?? '',
    scope: Object.fromEntries(SOURCE_OPERATIONS.map(operation => {
      const found = record?.operationScope.find(item => item.operation === operation);
      return [operation, { decision: found?.decision ?? 'pending', clauses: found?.clauseRefs.join(', ') ?? '', reassessed: false }];
    })) as Record<Operation, ScopeRow>,
  };
}
function draftFrom(fields: FormFields): LicenceDraft {
  return {
    holder: fields.holder.trim(), termsVersion: fields.termsVersion.trim() || null,
    termsEvidence: fields.digest.trim() ? { kind: fields.termsKind, sha256: fields.digest.trim(), citationUrl: fields.citation.trim() || null, clauseRefs: clauses(fields.cited) } : null,
    operationScope: SOURCE_OPERATIONS.flatMap(operation => {
      const row = fields.scope[operation];
      if (row.decision === 'pending') return [];
      return [{ operation, decision: row.decision, clauseRefs: clauses(row.clauses), ...(row.decision === 'allowed' && row.reassessed ? { reassessed: true as const } : {}) }];
    }),
  };
}

/**
 * AC-R08.1 roster and AC-R12.1 named-site decisions in Settings, plus the R16 licence
 * record the owner enters once. Shows recorded facts and missing receipts as served;
 * it never upgrades a row's readiness or a licence operation on the client.
 */
export function WorkbenchIntegrationRoster() {
  const t = useT();
  const [roster, setRoster] = useState<IntegrationRoster | null>(null);
  const [failed, setFailed] = useState(false);
  const live = useRef(true);
  const load = useCallback(() => {
    getIntegrationRoster().then(value => { if (live.current) { setRoster(value); setFailed(false); } }).catch(() => { if (live.current) setFailed(true); });
  }, []);
  useEffect(() => { live.current = true; load(); return () => { live.current = false; }; }, [load]);
  const licence = roster?.licences.find(item => item.sourceId === 'react-bits') ?? null;
  return (
    <section className={styles.root} aria-labelledby="workbench-integrations-title">
      <h3 id="workbench-integrations-title" className={styles.title}>{t('workbenchIntegrations.title')}</h3>
      <p className={styles.intro}>{t('workbenchIntegrations.intro')}</p>
      {failed ? <p role="alert" className={styles.error}>{t('workbenchIntegrations.loadError')}</p> : null}
      {!roster && !failed ? <p className={styles.intro}>{t('workbenchIntegrations.loading')}</p> : null}
      {licence ? <LicenceForm initial={licence} onSaved={load} /> : null}
      {roster && (roster.knownGaps.length || roster.exclusions.length) ? (
        <div className={styles.notes}>
          {roster.knownGaps.length ? <><h4 className={styles.subtitle}>{t('workbenchIntegrations.knownGaps')}</h4><ul>{roster.knownGaps.map(gap => <li key={gap}>{gap}</li>)}</ul></> : null}
          {roster.exclusions.length ? <><h4 className={styles.subtitle}>{t('workbenchIntegrations.exclusions')}</h4><ul>{roster.exclusions.map(item => <li key={item.name}><strong>{item.name}</strong>: {item.reason}</li>)}</ul></> : null}
        </div>
      ) : null}
      {roster ? <div className={styles.list}>{roster.entries.map(entry => <RosterRow key={entry.id} entry={entry} onUpdated={updated => setRoster(prior => prior ? { ...prior, entries: prior.entries.map(row => row.id === updated.id ? updated : row) } : prior)} />)}</div> : null}
    </section>
  );
}

function RosterRow({ entry, onUpdated }: { entry: IntegrationRosterEntry; onUpdated: (entry: IntegrationRosterEntry) => void }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [testError, setTestError] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const status = rowStatus(entry);
  const { runtime, capability, use } = status;
  const test = async () => {
    setBusy(true); setTestError(false); setDetailsOpen(true);
    try { const updated = await testIntegration(entry.id); if (mounted.current) onUpdated(updated); }
    catch { if (mounted.current) setTestError(true); }
    finally { if (mounted.current) setBusy(false); }
  };
  const workflow = use ? t('workbenchIntegrations.workflowAt', { date: use.at }) : t('workbenchIntegrations.workflowUnverified');
  return (
    <article aria-label={entry.name}>
      <DisclosureRow open={detailsOpen} onOpenChange={setDetailsOpen} title={entry.name} description={!capability.testable ? <span id={`integration-test-${entry.id}`}>{t('workbenchIntegrations.referenceOnly')}{use ? ` · ${workflow}` : ''}</span> : workflow}
        detailsLabel={t('workbenchIntegrations.details', { name: entry.name })}
        status={<Badge tone={status.connection === 'connected' || (!runtime && use) ? 'success' : status.readiness ? readinessTone(status.readiness) : 'neutral'}>{status.connection ? t(`workbenchIntegrations.connection.${status.connection}`) : status.readiness ? t(`workbenchIntegrations.readiness.${status.readiness}`) : t('workbenchIntegrations.workflowVerified')}</Badge>}
        actions={<Button size="sm" variant="secondary" loading={busy} disabled={busy || !capability.testable} aria-describedby={!capability.testable ? `integration-test-${entry.id}` : undefined} aria-label={t('workbenchIntegrations.testName', { name: entry.name })} onClick={() => void test()}>{t('workbenchIntegrations.test')}</Button>}>
      {!capability.testable ? <p className={styles.meta}>{t('workbenchIntegrations.referenceOnly')}</p> : null}
      <p className={styles.meta}>{t(`workbenchIntegrations.role.${entry.role}` as const)} · {t(`workbenchIntegrations.scope.${entry.dependencyScope}` as const)} · {entry.requirementIds.join(', ')}</p>
      <p className={styles.purpose}>{entry.purpose}</p>
      <dl className={styles.facts}>
        <dt>{t('workbenchIntegrations.version')}</dt><dd>{runtime?.version ?? entry.version.value ?? t('workbenchIntegrations.unpinned')}</dd>
        <dt>{t('workbenchIntegrations.rights')}</dt><dd>{entry.rights.summary}</dd>
        <dt>{t('workbenchIntegrations.account')}</dt>
        <dd>{entry.account.summary}{entry.account.principal ? ` ${t('workbenchIntegrations.principal', { principal: entry.account.principal })}` : ''}</dd>
        <dt>{t('workbenchIntegrations.install')}</dt><dd>{t(`workbenchIntegrations.install.${status.installState.state}` as const)} · {status.installState.reason}</dd>
        <dt>{t('workbenchIntegrations.daemonBinding')}</dt><dd>{t(`workbenchIntegrations.binding.${entry.daemonBinding}` as const)}</dd>
        {status.availability ? <><dt>{t('workbenchIntegrations.availability')}</dt><dd>{t(`workbenchIntegrations.availability.${status.availability.state}` as const)} · {status.availability.reason}</dd></> : null}
        {entry.siteEvaluation ? <><dt>{t('workbenchIntegrations.decision')}</dt><dd>{t(`workbenchIntegrations.decision.${entry.siteEvaluation.decision}` as const)} · {entry.siteEvaluation.decisionReason}</dd></> : null}
        <dt>{t('workbenchIntegrations.lastUse')}</dt>
        <dd>{use ? use.surfaces ? t('workbenchIntegrations.useAt', { operation: use.operation, date: use.at.slice(0, 10), surfaces: use.surfaces.join(', ') }) : t('workbenchIntegrations.checkedUseAt', { operation: use.operation, date: use.at }) : t('workbenchIntegrations.noUse', { missing: entry.pendingReceipts.join('; ') })}</dd>
        {use && entry.pendingReceipts.length ? <><dt>{t('workbenchIntegrations.pendingAdoption')}</dt><dd>{entry.pendingReceipts.join('; ')}</dd></> : null}
        <dt>{t('workbenchIntegrations.inputs')}</dt><dd>{entry.inputs.join(', ')}</dd>
        <dt>{t('workbenchIntegrations.outputs')}</dt><dd>{entry.outputs.join(', ')}</dd>
        {runtime ? <>
          <dt>{t('workbenchIntegrations.connection')}</dt><dd>{t(`workbenchIntegrations.connection.${status.connection!}`)} · {runtime.reason}</dd>
          {entry.account.required !== 'none' || runtime.accountLabel ? <><dt>{t('workbenchIntegrations.accountLabel')}</dt><dd>{runtime.accountLabel ?? t('workbenchIntegrations.unknown')}</dd></> : null}
          <dt>{t('workbenchIntegrations.workflow')}</dt><dd>{workflow}</dd>
          <dt>{t('workbenchIntegrations.lastTest')}</dt><dd role="status">{runtime.workflow.lastTest ? `${t(`workbenchIntegrations.outcome.${runtime.workflow.lastTest.outcome}`)} · ${runtime.workflow.lastTest.at} · ${runtime.workflow.lastTest.message}` : t('workbenchIntegrations.notTested')}</dd>
        </> : null}
      </dl>
      {status.fix?.url ? <a href={status.fix.url} target="_blank" rel="noreferrer">{t('workbenchIntegrations.fix')} · {status.fix.label}</a> : null}
      {status.fix?.command ? <p className={styles.meta}>{t('workbenchIntegrations.fix')}: <code>{status.fix.command}</code></p> : null}
      {testError ? <p role="alert" className={styles.error}>{t('workbenchIntegrations.testError')}</p> : null}
      </DisclosureRow>
    </article>
  );
}

function LicenceForm({ initial, onSaved }: { initial: LicenceRecordSnapshot; onSaved: () => void }) {
  const t = useT();
  const [snapshot, setSnapshot] = useState(initial);
  const record = snapshot.record;
  const [fields, setFields] = useState<FormFields>(() => fieldsFrom(record));
  const set = <K extends keyof FormFields>(key: K, value: FormFields[K]) => setFields(prior => ({ ...prior, [key]: value }));
  const setRow = (operation: Operation, patch: Partial<ScopeRow>) => setFields(prior => ({ ...prior, scope: { ...prior.scope, [operation]: { ...prior.scope[operation], ...patch } } }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  /** After a 409 the form shows the saved record; Save waits until the owner has reviewed the change list. */
  const [conflict, setConflict] = useState<Change[] | null>(null);
  function changesAgainst(mine: LicenceDraft, saved: LicenceRecord | null): Change[] {
    const show = (value: string | null | undefined) => value ?? '';
    const rows: Change[] = [
      { field: t('workbenchLicence.holder'), mine: mine.holder, saved: show(saved?.holder) },
      { field: t('workbenchLicence.termsVersion'), mine: show(mine.termsVersion), saved: show(saved?.termsVersion) },
      { field: t('workbenchLicence.termsDigest'), mine: show(mine.termsEvidence?.sha256), saved: show(saved?.termsEvidence?.sha256) },
      { field: t('workbenchLicence.clauses'), mine: show(mine.termsEvidence?.clauseRefs.join(', ')), saved: show(saved?.termsEvidence?.clauseRefs.join(', ')) },
      ...SOURCE_OPERATIONS.map(operation => ({
        field: operation,
        mine: show(mine.operationScope.find(item => item.operation === operation)?.decision ?? 'pending'),
        saved: show(saved?.operationScope.find(item => item.operation === operation)?.decision ?? 'pending'),
      })),
    ];
    return rows.filter(row => row.mine !== row.saved);
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || conflict) return;
    setBusy(true); setError('');
    const draft = draftFrom(fields);
    try {
      const saved = await putLicenceRecord('react-bits', { expectedRevision: snapshot.revision, draft });
      setSnapshot(saved); setFields(fieldsFrom(saved.record)); onSaved();
    } catch (failure) {
      if (!(failure instanceof WorkbenchRequestError)) setError(t('workbenchLicence.invalid'));
      else if (failure.status === 409) {
        let current: LicenceRecordSnapshot | null = null;
        try { current = failure.current === undefined ? null : parseLicenceRecordSnapshot(failure.current); } catch { current = null; }
        setError(t('workbenchLicence.conflict'));
        if (current) { setSnapshot(current); setFields(fieldsFrom(current.record)); setConflict(changesAgainst(draft, current.record)); }
        else setConflict([]);
      } else if (failure.status === 422) {
        const messages: Record<string, string> = {
          'licence-restriction-override': t('workbenchLicence.override'),
          'licence-terms-digest-conflict': t('workbenchLicence.digestConflict'),
          'licence-reassessment-required': t('workbenchLicence.reassessmentRequired'),
          'licence-history-unreadable': t('workbenchLicence.historyUnreadable'),
        };
        setError(messages[failure.code] ?? t('workbenchLicence.widening'));
      } else if (failure.status === 403) setError(t('workbenchLicence.forbidden'));
      else setError(t('workbenchLicence.invalid'));
    } finally { setBusy(false); }
  }
  const status = snapshot.recordState === 'unreadable' ? t('workbenchLicence.unreadable')
    : record ? t('workbenchLicence.recorded', { holder: record.holder, revision: snapshot.revision, surface: t(`workbenchLicence.surface.${record.recordedBy.surface}` as const) })
      : t('workbenchLicence.none');
  return (
    <form className={styles.licence} aria-label={t('workbenchLicence.formName')} onSubmit={event => { void submit(event); }}>
      <h4 className={styles.subtitle}>{t('workbenchLicence.heading')}</h4>
      <p className={styles.meta}>{status}</p>
      <p className={styles.intro}>{t('workbenchLicence.hint')}</p>
      <div className={styles.fields}>
        <label>{t('workbenchLicence.holder')}<Input value={fields.holder} onChange={event => set('holder', event.target.value)} required maxLength={200} autoComplete="off" /></label>
        <label>{t('workbenchLicence.termsVersion')}<Input value={fields.termsVersion} onChange={event => set('termsVersion', event.target.value)} maxLength={120} autoComplete="off" /></label>
        <label>{t('workbenchLicence.termsKind')}
          <Select value={fields.termsKind} onChange={event => set('termsKind', event.target.value as TermsKind)}>
            {TERMS_KINDS.map(kind => <option key={kind} value={kind}>{t(`workbenchLicence.termsKind.${kind}` as const)}</option>)}
          </Select>
        </label>
        <label>{t('workbenchLicence.termsDigest')}<Input value={fields.digest} onChange={event => set('digest', event.target.value)} pattern="[a-f0-9]{64}" autoComplete="off" spellCheck={false} /></label>
        <label>{t('workbenchLicence.citationUrl')}<Input value={fields.citation} onChange={event => set('citation', event.target.value)} type="url" autoComplete="off" /></label>
        <label>{t('workbenchLicence.clauses')}<Input value={fields.cited} onChange={event => set('cited', event.target.value)} autoComplete="off" /></label>
      </div>
      <table className={styles.operations}>
        <tbody>
          {snapshot.operations.map(item => {
            const row = fields.scope[item.operation];
            return (
              <tr key={item.operation}>
                <th scope="row">{item.operation}</th>
                <td>{t(`workbenchLicence.decision.${item.decision}` as const)} · {t(`workbenchLicence.reason.${item.reason}` as const)}</td>
                <td>
                  <Select aria-label={t('workbenchLicence.operationDecision', { operation: item.operation })} value={row.decision}
                    onChange={event => setRow(item.operation, { decision: event.target.value as ScopeRow['decision'] })}>
                    <option value="pending">{t('workbenchLicence.pending')}</option>
                    <option value="allowed">{t('workbenchLicence.allowed')}</option>
                    <option value="blocked">{t('workbenchLicence.blocked')}</option>
                  </Select>
                </td>
                <td>
                  <Input aria-label={t('workbenchLicence.operationClauses', { operation: item.operation })} value={row.clauses} autoComplete="off"
                    onChange={event => setRow(item.operation, { clauses: event.target.value })} />
                </td>
                <td>
                  <label className={styles.check}>
                    <input type="checkbox" checked={row.reassessed} disabled={row.decision !== 'allowed'} onChange={event => setRow(item.operation, { reassessed: event.target.checked })} />
                    {t('workbenchLicence.reassessed')}
                  </label>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {error ? (
        <div role="alert" className={styles.error}>
          <p>{error}</p>
          {conflict?.length ? <ul>{conflict.map(change => <li key={change.field}>{t('workbenchLicence.changedField', change)}</li>)}</ul> : null}
        </div>
      ) : null}
      {conflict ? <Button type="button" variant="secondary" onClick={() => { setConflict(null); setError(''); }}>{t('workbenchLicence.editFromSaved')}</Button> : null}
      <Button type="submit" disabled={busy || conflict !== null || !fields.holder.trim()}>{busy ? t('workbenchLicence.saving') : t('workbenchLicence.save')}</Button>
    </form>
  );
}
