import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button, Input, Select } from '@open-design/components';
import {
  WORKBENCH_UNIT_KINDS, type ReusableUnitManifest, type UnitSavePlan, type UnitSaveRequest, type WorkspaceCollabContext,
} from '@open-design/contracts';
import { useT } from '../../i18n';
import { fetchProjectFiles } from '../../providers/registry';
import { unitApi } from '../../providers/workbench-capture';
import { captureDraftUnitApi } from '../../providers/workbench-capture-drafts';
import { EMPTY_RIGHTS, rightsDeclarationFor, WorkbenchRightsFields, type RightsDraft } from './WorkbenchRightsFields';
import { WorkbenchUnitInsert } from './WorkbenchUnitInsert';
import styles from './WorkbenchCapture.module.css';

type Kind = (typeof WORKBENCH_UNIT_KINDS)[number];
const MAX_CLOSURE_ROUNDS = 4;
/** Blockers the form itself resolves: exclusions are acknowledged on save, rights come from the fields below. */
const FORM_RESOLVED = new Set(['exclusion-unacknowledged', 'rights-blocked']);

/**
 * AC-R14.3: pick the entry file and root, review files, captured exclusions,
 * dependencies and blockers from a daemon plan, declare rights, then save the
 * unit. The plan and save calls are `od workbench unit plan|save`.
 */
export function WorkbenchUnitSave({ projectId, workspaceContext, captureId, draftSource }: { projectId: string; workspaceContext?: WorkspaceCollabContext | null; captureId?: string; draftSource?: { draftId: string; revision: number } }) {
  const t = useT();
  const kindLabel: Record<Kind, string> = { component: t('workbench.unit.kind.component'), block: t('workbench.unit.kind.block'), section: t('workbench.unit.kind.section'), page: t('workbench.unit.kind.page') };
  const [htmlFiles, setHtmlFiles] = useState<string[]>([]);
  const [filesError, setFilesError] = useState(false);
  const [entry, setEntry] = useState('');
  const [plan, setPlan] = useState<UnitSavePlan | null>(null);
  const [paths, setPaths] = useState<string[]>([]);
  const [rootSelector, setRootSelector] = useState('body');
  const [name, setName] = useState('');
  const [kind, setKind] = useState<Kind>('section');
  const [rights, setRights] = useState<RightsDraft>(EMPTY_RIGHTS);
  const [phase, setPhase] = useState<'idle' | 'planning' | 'saving'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<ReusableUnitManifest | null>(null);
  const [units, setUnits] = useState<ReusableUnitManifest[]>([]);
  const keyRef = useRef<string | null>(null);

  useEffect(() => {
    let live = true;
    setFilesError(false);
    if (!draftSource) fetchProjectFiles(projectId, { workspaceContext, fresh: true, requireAuthoritative: true }).then(files => {
      if (live) setHtmlFiles(files.filter(file => file.type !== 'dir' && /\.html?$/iu.test(file.path ?? file.name)).map(file => file.path ?? file.name));
    }).catch(() => { if (live) setFilesError(true); });
    unitApi.list(workspaceContext).then(list => { if (live) setUnits(list); }).catch(() => undefined);
    return () => { live = false; };
  }, [projectId, workspaceContext, draftSource?.draftId, draftSource?.revision]);

  const request = (selected: string[], withHashes: UnitSavePlan | null): UnitSaveRequest => {
    const declaration = rightsDeclarationFor(rights);
    return {
      source: draftSource ? { kind: 'draft', ...draftSource, rootSelector: rootSelector.trim() || 'body' }
        : { kind: 'project', projectId, entry, paths: selected, rootSelector: rootSelector.trim() || 'body', ...(withHashes ? { expectedHashes: Object.fromEntries(withHashes.files.map(file => [file.path, file.sha256])) } : {}) },
      kind, name: name.trim() || (draftSource ? `Draft ${draftSource.revision}` : entry), ...(declaration ? { rightsDeclaration: declaration } : {}),
      ...(withHashes ? { excludePaths: withHashes.excludedFiles.map(file => file.path) } : {}),
      ...(captureId ? { captureId } : {}),
    };
  };

  /** Plan, adding the local files the entry references until the selection is closed. */
  async function review() {
    if (!entry && !draftSource) return;
    setPhase('planning'); setError(null); setSaved(null); keyRef.current = null;
    try {
      let selected = draftSource ? [] : [entry];
      let next = draftSource ? await captureDraftUnitApi.plan(projectId, request(selected, null), workspaceContext) : await unitApi.plan(request(selected, null), workspaceContext);
      for (let round = 0; !draftSource && round < MAX_CLOSURE_ROUNDS && next.missingReferences.length; round++) {
        selected = [...new Set([...selected, ...next.missingReferences])];
        next = await unitApi.plan(request(selected, null), workspaceContext);
      }
      setPaths(selected); setPlan(next);
      if (!draftSource && next.rootCandidates.includes(rootSelector) === false && next.rootCandidates[0]) setRootSelector(next.rootFound ? rootSelector : next.rootCandidates[0]);
    } catch (failure) {
      setError(t('workbench.unit.planFailed', { message: failure instanceof Error ? failure.message : String(failure) }));
    } finally { setPhase('idle'); }
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!plan || phase !== 'idle') return;
    setPhase('saving'); setError(null);
    keyRef.current ??= typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `web-${Date.now()}`;
    try {
      const manifest = draftSource ? await captureDraftUnitApi.save(projectId, request(paths, plan), workspaceContext, keyRef.current) : await unitApi.save(request(paths, plan), workspaceContext, keyRef.current);
      setSaved(manifest); setUnits(current => [manifest, ...current.filter(unit => unit.unitId !== manifest.unitId)]);
    } catch (failure) {
      keyRef.current = null;
      setError(t('workbench.unit.saveFailed', { message: failure instanceof Error ? failure.message : String(failure) }));
    } finally { setPhase('idle'); }
  }

  const blocking = plan?.blockers.filter(blocker => !FORM_RESOLVED.has(blocker.code)) ?? [];
  return <section className={styles.panel} aria-label={t('workbench.captureHub.units')} data-testid="workbench-unit-save">
    <div className={styles.row}>
      {draftSource ? <label className={styles.field}>{t('workbench.unit.root')}<Input value={rootSelector} onChange={event => { setRootSelector(event.target.value); setPlan(null); setSaved(null); }} /></label> : <label className={styles.field}>{t('workbench.unit.entry')}
        <Select value={entry} onChange={event => { setEntry(event.target.value); setPlan(null); setSaved(null); }}>
          <option value="">{t('workbench.unit.chooseEntry')}</option>
          {htmlFiles.map(file => <option key={file} value={file}>{file}</option>)}
        </Select>
      </label>}
      <Button type="button" size="sm" disabled={(!entry && !draftSource) || phase !== 'idle'} onClick={() => void review()}>{phase === 'planning' ? t('workbench.unit.reviewing') : t('workbench.unit.review')}</Button>
    </div>
    {filesError ? <p role="alert" className={styles.error}>{t('workbench.unit.filesError')}</p> : null}
    {plan ? <form className={styles.planForm} onSubmit={save}>
      <div className={styles.plan} data-testid="workbench-unit-plan">
        {!draftSource ? <label className={styles.field}>{t('workbench.unit.root')}
          <Select value={rootSelector} onChange={event => setRootSelector(event.target.value)}>
            {[...new Set([rootSelector, ...plan.rootCandidates])].map(candidate => <option key={candidate} value={candidate}>{candidate}</option>)}
          </Select>
        </label> : <p className={styles.hint}>{t('workbench.draft.savedSource', { revision: draftSource.revision })} · {rootSelector}</p>}
        <h4>{t('workbench.unit.files')}</h4>
        <ul className={styles.fileList}>
          {plan.files.map(file => {
            const excluded = plan.excludedFiles.find(item => item.path === file.path);
            return <li key={file.path} data-included={file.included}><span>{file.path}</span>{excluded ? <em> — {excluded.reason === 'captured-third-party' ? t('workbench.unit.excludedCaptured') : t('workbench.unit.excludedUser')}</em> : null}</li>;
          })}
        </ul>
        <h4>{t('workbench.unit.dependencies')}</h4>
        {plan.dependencies.length ? <>
          <ul className={styles.fileList}>{plan.dependencies.map(dep => <li key={dep.url ?? dep.name}>{dep.name} {dep.version}</li>)}</ul>
          <p className={styles.hint}>{t('workbench.unit.notInstalled')}</p>
        </> : <p className={styles.hint}>{t('workbench.unit.noDependencies')}</p>}
        {blocking.length ? <div role="alert" className={styles.error}><strong>{t('workbench.unit.blockers')}</strong><ul>{blocking.map(blocker => <li key={`${blocker.code}:${blocker.message}`}>{blocker.message}</li>)}</ul></div> : null}
        {plan.warnings.length ? <details className={styles.hint}><summary>{t('workbench.unit.notes')}</summary><ul>{plan.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul></details> : null}
      </div>
      <label className={styles.field}>{t('workbench.unit.name')}<Input value={name} maxLength={120} onChange={event => setName(event.target.value)} /></label>
      <label className={styles.field}>{t('workbench.unit.kind')}
        <Select value={kind} onChange={event => setKind(event.target.value as Kind)}>{WORKBENCH_UNIT_KINDS.map(value => <option key={value} value={value}>{kindLabel[value]}</option>)}</Select>
      </label>
      <WorkbenchRightsFields value={rights} onChange={setRights} disabled={phase === 'saving'} />
      <Button type="submit" disabled={phase !== 'idle' || blocking.length > 0 || !name.trim()} aria-busy={phase === 'saving'}>{phase === 'saving' ? t('workbench.unit.saving') : t('workbench.unit.save')}</Button>
    </form> : null}
    {error ? <p role="alert" className={styles.error}>{error}</p> : null}
    {saved ? <div className={styles.saved} data-testid="workbench-unit-saved" role="status">
      <strong>{t('workbench.unit.saved')}</strong>
      {saved.thumbnail.source === 'rendered' ? <img className={styles.thumb} src={unitApi.thumbnailUrl(saved.unitId, workspaceContext)} alt={t('workbench.unit.thumbnailAlt', { name: saved.name })} /> : saved.thumbnail.source === 'unavailable' ? <span className={styles.hint}>{t('workbench.unit.thumbnailUnavailable', { reason: saved.thumbnail.reason })}</span> : null}
      <span>{saved.name} · {kindLabel[saved.kind]} · {t('workbench.unit.rightsStatus', { status: saved.rights.status })}</span>
    </div> : null}
    <h4>{t('workbench.unit.library')}</h4>
    {units.length ? <ul className={styles.list}>{units.map(unit => <li key={unit.unitId} className={styles.item}>
      {unit.thumbnail.source === 'rendered' ? <img className={styles.thumb} src={unitApi.thumbnailUrl(unit.unitId, workspaceContext)} alt={t('workbench.unit.thumbnailAlt', { name: unit.name })} loading="lazy" /> : null}
      <div className={styles.meta}><strong>{unit.name}</strong><span>{kindLabel[unit.kind]} · {t('workbench.unit.rightsStatus', { status: unit.rights.status })}</span><time dateTime={unit.createdAt}>{new Date(unit.createdAt).toLocaleString()}</time><WorkbenchUnitInsert unit={unit} workspaceContext={workspaceContext} /></div>
    </li>)}</ul> : <p className={styles.hint}>{t('workbench.unit.none')}</p>}
  </section>;
}
