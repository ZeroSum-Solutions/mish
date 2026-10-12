import { useEffect, useId, useState } from 'react';
import { Button, Input } from '@open-design/components';
import type { AdoptionOperationView, CatalogueAdoptionResponse, CatalogueSavedUnit, ResourceResult, WorkspaceCollabContext } from '@open-design/contracts';
import { useT } from '../../i18n';
import { AdoptionRequestError, applyAdoptionPlan, copyWorkbenchCode, deleteSavedCatalogueUnit, getAdoptionStatus, listSavedCatalogueUnits, prepareCatalogueAdoption, saveCatalogueUnit, undoAdoptionOperation } from '../../providers/workbench-adoption';
import { copyToClipboard } from '../../lib/copy-to-clipboard';
import styles from './WorkbenchApplyAction.module.css';

type Step =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'prepared'; prepared: CatalogueAdoptionResponse }
  | { kind: 'applied'; prepared: CatalogueAdoptionResponse; operation: AdoptionOperationView }
  | { kind: 'recovery'; operation: AdoptionOperationView }
  | { kind: 'undone' }
  | { kind: 'off'; reasons: string[] }
  | { kind: 'refused'; error: AdoptionRequestError | Error };

function applyOff(error: Error): string[] | null {
  if (!(error instanceof AdoptionRequestError) || error.status !== 422) return null;
  const reasons = [error.reason, ...(Array.isArray(error.details.gates) ? error.details.gates.filter((value): value is string => typeof value === 'string') : [])].filter((value): value is string => Boolean(value));
  return reasons.includes('adoption-executor-unprovisioned') ? reasons : null;
}

/** Only a permitted source with an incorporation grant offers Apply; the daemon re-checks every gate. */
export function canOfferApply(resource: ResourceResult): boolean {
  if (['component', 'block', 'section', 'layout', 'cta-pattern', 'ui-kit', 'template', 'motion'].includes(resource.category) && resource.componentFit?.apply.allowed !== true) return false;
  return resource.rightsStatus === 'permitted' && resource.operationGrants.some(grant => grant.operation === 'incorporation' && grant.state === 'permitted');
}
/**
 * What Apply's capability is, said the same way wherever it is shown: an
 * closed executor overrides admission status; an open executor may offer an
 * unverified item while its acceptance receipt is pending.
 */
export function adoptionCapabilityText(resource: ResourceResult, t: ReturnType<typeof useT>, applyOff = false): string {
  if (applyOff) return t('workbench.apply.offTitle');
  const reason = resource.adoptionCapability.reason;
  const readable = reason === 'acceptance-receipt-pending' ? t('workbench.apply.receiptPending') : reason;
  if (resource.componentFit?.apply.allowed) return `${t('workbench.components.applyVerified')}${!resource.adoptionCapability.available && readable ? ` · ${readable}` : ''}`;
  if (resource.adoptionCapability.available) return readable ?? '';
  return readable ? `${t('workbench.apply.unverified')} · ${readable}` : t('workbench.apply.unverified');
}
/** Only a completed apply is an applied result with Undo; any other recorded state needs recovery. */
const appliedStep = (prepared: CatalogueAdoptionResponse, operation: AdoptionOperationView): Step => operation.state === 'done'
  ? { kind: 'applied', prepared, operation }
  : { kind: 'recovery', operation };
/**
 * The default entry the marker goes into, by the item's own target format: a
 * standalone HTML artifact sits next to the project's HTML entry, everything
 * else next to `src/App.tsx`. The user can change it before prepare; the
 * daemon refuses a missing entry or an incompatible target with a typed reason.
 */
export function defaultEntryFor(resource: ResourceResult): string {
  const targets = resource.compatibility.targets;
  return targets.includes('html') && !targets.includes('react') ? 'index.html' : 'src/App.tsx';
}

/**
 * AC-R04.3/AC-R04.4: apply a catalogue item to the open project, review what
 * it writes (files, licence notice, satisfied packages), and undo it. Missing
 * or incompatible packages, a reference-only source and a pending replacement
 * diff are shown as the daemon reports them; nothing is written until Confirm.
 */
export function WorkbenchApplyAction({ resource, projectId, workspaceContext, onApplyOffChange }: {
  resource: ResourceResult; projectId?: string; workspaceContext?: WorkspaceCollabContext | null; onApplyOffChange?: (off: boolean) => void;
}) {
  const t = useT();
  const [step, setStep] = useState<Step>({ kind: 'idle' });
  useEffect(() => { onApplyOffChange?.(step.kind === 'off'); }, [step.kind, onApplyOffChange]);
  const [entryPath, setEntryPath] = useState(() => defaultEntryFor(resource));
  const entryId = useId();
  // W4: the caller's saved units of this item (saved after apply, possibly edited), reusable here.
  const [savedUnits, setSavedUnits] = useState<CatalogueSavedUnit[]>([]);
  const [savedVersion, setSavedVersion] = useState(0);
  const [saveState, setSaveState] = useState<{ kind: 'idle' | 'busy' | 'failed' } | { kind: 'saved'; unit: CatalogueSavedUnit }>({ kind: 'idle' });
  const [reuse, setReuse] = useState<string | null>(null);
  const [removeFailed, setRemoveFailed] = useState(false);
  const offered = canOfferApply(resource) && !!projectId;
  useEffect(() => {
    if (!offered) return;
    let cancelled = false;
    listSavedCatalogueUnits(resource.refKey, workspaceContext)
      .then((units) => { if (!cancelled) setSavedUnits(units); })
      .catch(() => { if (!cancelled) setSavedUnits([]); });
    return () => { cancelled = true; };
  }, [offered, resource.refKey, workspaceContext, savedVersion]);
  const [copyState, setCopyState] = useState<'idle' | 'done' | 'failed'>('idle');
  useEffect(() => {
    if (!projectId || !canOfferApply(resource)) return;
    let current = true;
    void getAdoptionStatus().then(({ status }) => {
      if (current && status.executor === 'closed') setStep(previous => previous.kind === 'idle' ? { kind: 'off', reasons: status.gates } : previous);
    }).catch(() => { /* The prepare response still reports a typed refusal. */ });
    return () => { current = false; };
  }, [projectId, resource.refKey]);
  if (!canOfferApply(resource)) return null;
  if (!projectId) return <p className={styles.hint}>{t('workbench.apply.needsProject')}</p>;

  async function run(work: () => Promise<Step>) {
    setStep({ kind: 'busy' });
    try { setStep(await work()); }
    catch (error) {
      const failure = error instanceof Error ? error : new Error('adoption-failed');
      const reasons = applyOff(failure);
      setStep(reasons ? { kind: 'off', reasons } : { kind: 'refused', error: failure });
    }
  }
  const prepare = (acceptReplacement?: string, savedUnitId: string | null = reuse) => {
    setReuse(savedUnitId);
    setSaveState({ kind: 'idle' });
    return run(async () => ({ kind: 'prepared', prepared: await prepareCatalogueAdoption({
      projectId, refKey: resource.refKey, entryPath: entryPath.trim(), ...(acceptReplacement ? { acceptReplacement } : {}),
      ...(savedUnitId ? { savedUnitId } : {}),
    }, workspaceContext) }));
  };
  const save = async (operation: AdoptionOperationView) => {
    setSaveState({ kind: 'busy' });
    try {
      const unit = await saveCatalogueUnit({ projectId: operation.projectId, operationId: operation.operationId }, workspaceContext);
      setSaveState({ kind: 'saved', unit });
      setSavedVersion((n) => n + 1);
    } catch { setSaveState({ kind: 'failed' }); }
  };
  // Sol B5/6: the saved-unit cap is recoverable here (and with `od workbench adoption catalogue-saved delete <id>`).
  const removeSaved = async (id: string) => {
    setRemoveFailed(false);
    try {
      await deleteSavedCatalogueUnit(id, workspaceContext);
      if (reuse === id) setReuse(null);
      setSavedVersion((n) => n + 1);
    } catch { setRemoveFailed(true); }
  };

  return <div className={styles.root} data-testid="workbench-apply-action" data-step={step.kind}>
    {step.kind === 'idle' || step.kind === 'undone' ? <>
      {step.kind === 'undone' ? <p role="status">{t('workbench.apply.undone')}</p> : null}
      <label className={styles.entry} htmlFor={entryId}>{t('workbench.apply.entry')}</label>
      <Input id={entryId} value={entryPath} spellCheck={false} onChange={event => setEntryPath(event.target.value)} />
      <Button size="sm" disabled={!entryPath.trim()} onClick={() => prepare(undefined, null)}>{t('workbench.apply.action')}</Button>
      <p className={styles.hint} data-testid="workbench-apply-capability">{t('workbench.apply.capability')}: {adoptionCapabilityText(resource, t)}</p>
      {savedUnits.length ? <section aria-label={t('workbench.apply.savedUnits')} data-testid="workbench-apply-saved-units">
        <p className={styles.hint}>{t('workbench.apply.savedUnits')}</p>
        <ul className={styles.saved}>{savedUnits.map(unit => <li key={unit.id}>
          <code title={unit.id}>{unit.id.slice(0, 12)}</code> · {unit.sourceProjectId}
          <Button size="sm" disabled={!entryPath.trim()} onClick={() => prepare(undefined, unit.id)}>{t('workbench.apply.applySaved')}</Button>
          <Button size="sm" variant="ghost" onClick={() => void removeSaved(unit.id)}>{t('workbench.apply.removeSaved')}</Button>
        </li>)}</ul>
        {removeFailed ? <p role="alert">{t('workbench.apply.removeSavedFailed')}</p> : null}
      </section> : null}
    </> : null}
    {step.kind === 'busy' ? <p role="status">{t('workbench.apply.preparing')}</p> : null}
    {step.kind === 'prepared' ? <>
      <PlanSummary prepared={step.prepared} />
      <Button size="sm" onClick={() => run(async () => appliedStep(step.prepared, await applyAdoptionPlan(step.prepared.plan, workspaceContext)))}>{t('workbench.apply.confirm')}</Button>
    </> : null}
    {step.kind === 'applied' ? <>
      <p role="status">{t('workbench.apply.applied')} · {step.operation.writes.length}</p>
      <PlanSummary prepared={step.prepared} />
      <Button size="sm" onClick={() => run(async () => { await undoAdoptionOperation(step.operation, workspaceContext); return { kind: 'undone' }; })}>{t('workbench.apply.undo')}</Button>
      {saveState.kind === 'saved'
        ? <p role="status">{t('workbench.apply.savedForReuse')} · <code title={saveState.unit.id}>{saveState.unit.id.slice(0, 12)}</code></p>
        : <Button size="sm" disabled={saveState.kind === 'busy'} onClick={() => void save(step.operation)}>{t('workbench.apply.saveUnit')}</Button>}
      {saveState.kind === 'failed' ? <p role="alert">{t('workbench.apply.saveFailed')}</p> : null}
    </> : null}
    {step.kind === 'recovery' ? <p role="alert">{t('workbench.apply.recovery')} · {step.operation.state} · {step.operation.stage}</p> : null}
    {step.kind === 'off' ? <div role="alert" className={styles.refusal}>
      <h4>{t('workbench.apply.offTitle')}</h4>
      <p>{t('workbench.apply.offBody')}</p>
      <Button variant="primary" size="sm" onClick={() => void (async () => {
        try { setCopyState(await copyToClipboard(await copyWorkbenchCode(resource.refKey)) ? 'done' : 'failed'); }
        catch { setCopyState('failed'); }
      })()}>{t('workbench.apply.copyCode')}</Button>
      {copyState !== 'idle' ? <p role="status">{t(copyState === 'done' ? 'workbench.apply.codeCopied' : 'workbench.apply.copyFailed')}</p> : null}
      {step.reasons.length ? <details><summary>{t('workbench.apply.details')}</summary><code>{step.reasons.join(', ')}</code></details> : null}
    </div> : null}
    {step.kind === 'refused' ? <Refusal error={step.error} onAccept={digest => prepare(digest)} onRetry={() => prepare()} /> : null}
  </div>;
}

function PlanSummary({ prepared }: { prepared: CatalogueAdoptionResponse }) {
  const t = useT();
  const { catalogue } = prepared;
  return <dl className={styles.summary}>
    <dt>{t('workbench.apply.files')}</dt>
    <dd><ul>{catalogue.files.map(file => <li key={file.path}><code>{file.path}</code> · {file.role}</li>)}</ul></dd>
    <dt>{t('workbench.apply.licence')}</dt>
    <dd>{catalogue.identity.packageName} · {catalogue.identity.licence} · <code>{catalogue.notices.join(', ')}</code></dd>
    {catalogue.target ? <><dt>{t('workbench.apply.target')}</dt>
      <dd><code>{catalogue.target.adapter}</code> · {catalogue.target.framework}{catalogue.target.reactMajor !== null ? ` · React ${catalogue.target.reactMajor}` : ''}</dd></> : null}
  </dl>;
}

/**
 * One labelled list per refusal kind; every row says the package, the range
 * the item requires and what the project has, as one text so it reads the
 * same to sighted users, screen readers and the browser witness.
 */
function PackageList({ label, rows }: { label: string; rows: { name: string; required: string; found: string | null }[] }) {
  const t = useT();
  if (!rows.length) return null;
  const range = (value: string) => (value === '*' ? t('workbench.apply.anyVersion') : value);
  return <>
    <p className={styles.packageLabel}>{label}</p>
    <ul aria-label={label}>
      {rows.map(row => <li key={row.name} data-testid="workbench-apply-package" data-package={row.name}>
        {`${row.name} · ${t('workbench.apply.requires')} ${range(row.required)} · ${t('workbench.apply.found')} ${row.found ?? t('workbench.apply.notInstalled')}`}
      </li>)}
    </ul>
  </>;
}

function Refusal({ error, onAccept, onRetry }: { error: Error; onAccept: (digest: string) => void; onRetry: () => void }) {
  const t = useT();
  const adoption = error instanceof AdoptionRequestError ? error : null;
  const dependencies = adoption?.dependencyReport ?? null;
  const review = adoption?.replacementReview ?? null;
  const target = adoption?.targetRefusal ?? null;
  return <div role="alert" className={styles.refusal}>
    <p>{adoption?.reason === 'reference-only' ? t('workbench.apply.referenceOnly') : target ? t('workbench.apply.targetIncompatible') : `${t('workbench.apply.failed')} · ${error.message}`}</p>
    {target ? <p><code>{target.adapter}</code> · {target.detected.framework}{target.detected.reactMajor !== null ? ` ${target.detected.reactMajor}` : ''} · {error.message}</p> : null}
    {dependencies ? <div className={styles.summary}>
      <PackageList label={t('workbench.apply.missing')} rows={dependencies.missing.map(d => ({ name: d.name, required: d.range, found: null }))} />
      <PackageList label={t('workbench.apply.incompatible')} rows={dependencies.incompatible.map(d => ({ name: d.name, required: d.required, found: d.installed }))} />
    </div> : null}
    {review ? <>
      <p>{t('workbench.apply.reviewTitle')}</p>
      {review.files.map(file => <figure key={file.path} className={styles.diff}>
        <figcaption><code>{file.path}</code></figcaption>
        <pre data-testid="workbench-apply-diff">{file.diff}</pre>
      </figure>)}
      <Button size="sm" onClick={() => onAccept(review.replacementDigest)}>{t('workbench.apply.acceptReplacement')}</Button>
    </> : <Button size="sm" onClick={onRetry}>{t('preview.retry')}</Button>}
  </div>;
}
