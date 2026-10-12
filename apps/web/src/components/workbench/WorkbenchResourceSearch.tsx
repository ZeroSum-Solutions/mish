import { localizeMotionRecipe } from './motion-recipe-labels';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@mish/components';
import type { FontKitInventory, ResourceSearchResponse, ResourceResult, InstalledPluginRecord, WorkspaceCollabContext, WorkbenchPreferencesSnapshot, ProjectDesignContextSnapshot } from '@mish/contracts';
import { searchWorkbenchResources, getWorkbenchPreferences, putWorkbenchPreferences, getProjectDesignContext, WorkbenchRequestError } from '../../providers/workbench';
import { useT } from '../../i18n';
import { WorkbenchProjectContext } from './WorkbenchProjectContext';
import { WorkbenchComponentFit, componentFitLabel } from './WorkbenchComponentFit';
import { WorkbenchResourceDetail } from './WorkbenchResourceDetail';
import { WorkbenchFontKitInventory } from './WorkbenchFontKits';
import { groupResourcesBySource } from './resource-groups';
import { currentWorkspaceAccountGeneration, workspaceAccountScopedCacheKey } from '../../collab/workspace-identity';
import styles from './workbench.module.css';

export function WorkbenchResourceSearch({ projectId, workspaceContext, plugins, onPickPlugin }: {
  projectId?: string; workspaceContext?: WorkspaceCollabContext | null;
  plugins: InstalledPluginRecord[]; onPickPlugin: (record: InstalledPluginRecord) => void;
}) {
  const t = useT();
  const account = currentWorkspaceAccountGeneration();
  const scope = `${projectId ?? ''}:${workspaceAccountScopedCacheKey(workspaceContext, account)}`;
  const liveScope = useRef(scope); liveScope.current = scope;
  const current = (captured: string, capturedAccount: number) => captured === liveScope.current && capturedAccount === currentWorkspaceAccountGeneration();
  const [records, setRecords] = useState<{ scope: string; preference: WorkbenchPreferencesSnapshot; context: ProjectDesignContextSnapshot } | null>(null);
  const [desired, setDesired] = useState(true);
  const [settingsError, setSettingsError] = useState(false);
  const [savingPreference, setSavingPreference] = useState(false);
  const [unsaved, setUnsaved] = useState(false);
  const [settingsRefresh, setSettingsRefresh] = useState(0);
  const mutation = useRef(0);
  const active = records?.scope === scope ? records : null;
  const [editing, setEditing] = useState(false);
  const [query, setQuery] = useState('');
  const [picker, setPicker] = useState({ scope, showAll: false });
  const showAll = picker.scope === scope && picker.showAll;
  const [responseScope, setResponseScope] = useState('');
  const [response, setResponse] = useState<ResourceSearchResponse | null>(null);
  const [selected, setSelected] = useState<ResourceResult | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);
  const [kitFonts, setKitFonts] = useState<{ scope: string; state: 'loading' | 'ready' | 'error'; inventory: FontKitInventory | null } | null>(null);
  /** AC-R11 preamble: the kit/example font inventory comes with a font-category search on the
   * same endpoint `od workbench search --category font` uses; it is fetched only when asked for. */
  async function loadKitFonts() {
    const capturedScope = scope, capturedAccount = account;
    setKitFonts({ scope: capturedScope, state: 'loading', inventory: null });
    try {
      const value = await searchWorkbenchResources({ query: '', ...(projectId ? { projectId } : {}), facets: { category: 'font' }, limit: 1 }, workspaceContext);
      if (current(capturedScope, capturedAccount)) setKitFonts({ scope: capturedScope, state: 'ready', inventory: value.fontKits ?? null });
    } catch { if (current(capturedScope, capturedAccount)) setKitFonts({ scope: capturedScope, state: 'error', inventory: null }); }
  }
  async function search(cursor?: string, expected = generation.current) {
    setLoading(true); setError(false);
    try {
      const capturedScope = scope, capturedAccount = account, preferenceRevision = active?.preference.revision, contextRevision = active?.context.revision;
      const value = await searchWorkbenchResources({ query, componentPicker: { showAll, mode: 'rank' }, ...(projectId ? { projectId } : {}), facets: {}, limit: 20, ...(cursor ? { cursor } : {}) }, workspaceContext);
      if (!current(capturedScope, capturedAccount) || expected !== generation.current) return;
      if (value.context.reason !== 'context-not-implemented' && (value.context.projectId !== (projectId ?? null) || value.context.selection !== 'saved' || (projectId && (value.context.preferenceRevision !== preferenceRevision || value.context.observedContextRevision !== contextRevision)))) { setSettingsError(true); return; }
      setResponseScope(capturedScope);
      if (expected === generation.current) setResponse((prior) => cursor && prior ? { ...value, results: [...prior.results, ...value.results] } : value);
    } catch { if (current(scope, account) && expected === generation.current) setError(true); }
    finally { if (current(scope, account) && expected === generation.current) setLoading(false); }
  }
  useEffect(() => {
    const operation = ++mutation.current; generation.current++;
    setEditing(false); setRecords(null); setResponse(null); setSelected(null); setSettingsError(false); setUnsaved(false); setSavingPreference(false);
    if (!projectId) return;
    void Promise.all([getWorkbenchPreferences(projectId, workspaceContext), getProjectDesignContext(projectId, workspaceContext)]).then(([preference, context]) => {
      if (!current(scope, account) || mutation.current !== operation) return;
      setRecords({ scope, preference, context }); setDesired(preference.effective.useProjectContext);
    }).catch(() => { if (current(scope, account) && mutation.current === operation) { setSettingsError(true); setLoading(false); } });
    return () => { mutation.current++; generation.current++; };
  }, [scope, settingsRefresh]);
  useEffect(() => {
    const expected = ++generation.current;
    setResponse(null); setSelected(null);
    if ((projectId && !active) || savingPreference || unsaved || settingsError) { setLoading(false); return; }
    setLoading(true);
    const timer = window.setTimeout(() => void search(undefined, expected), query ? 200 : 0);
    return () => { window.clearTimeout(timer); generation.current++; };
  }, [query, scope, showAll, revision, active?.preference.revision, active?.context.revision, savingPreference, unsaved, settingsError]);
  async function savePreference(value: boolean) {
    if (!projectId || !active || savingPreference) return;
    const operation = ++mutation.current; generation.current++;
    setDesired(value); setSavingPreference(true); setUnsaved(false); setResponse(null); setSelected(null);
    try {
      const preference = await putWorkbenchPreferences(projectId, { expectedRevision: active.preference.revision, useProjectContext: value }, workspaceContext);
      if (!current(scope, account) || mutation.current !== operation) return;
      setRecords(prior => prior?.scope === scope ? { ...prior, preference } : prior); setDesired(preference.effective.useProjectContext);
    } catch (failure) {
      if (!current(scope, account) || mutation.current !== operation) return;
      if (failure instanceof WorkbenchRequestError && failure.status === 409 && failure.current) {
        const preference = failure.current as WorkbenchPreferencesSnapshot;
        setRecords(prior => prior?.scope === scope ? { ...prior, preference } : prior);
      }
      setUnsaved(true);
    } finally { if (current(scope, account) && mutation.current === operation) setSavingPreference(false); }
  }
  const visibleResponse = responseScope === scope ? response : null;
  const visibleKitFonts = kitFonts?.scope === scope ? kitFonts : null;
  const kitInventory = visibleResponse?.fontKits ?? visibleKitFonts?.inventory ?? null;
  return <div className={styles.root} data-testid="workbench-resource-search">
    <div className={styles.search}><input aria-label={t('workbench.search')} placeholder={t('workbench.search')} value={query} onChange={(event) => setQuery(event.target.value)} />{projectId ? <label className={styles.contextToggle}><input type="checkbox" checked={active ? desired : true} disabled={!active || savingPreference || settingsError} onChange={event => void savePreference(event.target.checked)} />{t('workbench.useContext')}</label> : null}</div>
    <label className={styles.contextToggle}><input type="checkbox" checked={showAll} onChange={event => setPicker({ scope, showAll: event.target.checked })} />{t('workbench.components.showAll')}</label>
    {projectId ? <Button size="sm" disabled={!active || savingPreference} onClick={() => setEditing(true)}>{t('workbench.editGoals')}</Button> : null}
    {savingPreference ? <p role="status" className={styles.notice}>{t('workbench.savingPreference')}</p> : null}
    {unsaved && active ? <div role="alert" className={styles.notice}>{t('workbench.unsavedPreference')} {t('workbench.savedChoice')}: {active?.preference.effective.useProjectContext ? t('workbench.on') : t('workbench.off')} <Button size="sm" onClick={() => setSettingsRefresh(n => n + 1)}>{t('workbench.reloadSaved')}</Button><Button size="sm" onClick={() => void savePreference(desired)}>{t('workbench.retryChange')}</Button></div> : null}
    {settingsError ? <div role="alert" className={styles.notice}>{t('workbench.settingsError')} <Button size="sm" onClick={() => setSettingsRefresh(n => n + 1)}>{t('workbench.reloadSaved')}</Button></div> : null}
    <p className={styles.notice} data-context-requested={visibleResponse?.context.requested ?? true} data-context-applied={visibleResponse?.context.applied ?? false} data-context-reason={visibleResponse?.context.reason ?? 'context-not-implemented'}>{visibleResponse?.context.applied ? t('workbench.contextApplied') : visibleResponse?.context.reason === 'context-disabled' ? t('workbench.contextDisabled') : visibleResponse?.context.reason === 'context-absent' ? t('workbench.contextAbsent') : visibleResponse?.context.reason === 'context-not-rankable' ? t('workbench.contextNotRankable') : visibleResponse?.context.reason === 'ranking-timeout' ? t('workbench.contextTimeout') : !projectId ? t('workbench.chooseProject') : t('workbench.contextUnavailable')}</p>
    {loading ? <p role="status" className={styles.notice}>{t('workbench.previewLoading')}</p> : null}
    {error ? <div role="alert" className={styles.notice}>{t('workbench.searchError')} <Button size="sm" onClick={() => setRevision((n) => n + 1)}>{t('preview.retry')}</Button></div> : null}
    {visibleResponse && (!projectId || active) ? <>
      {visibleResponse.componentRanking ? <p role="status" className={styles.notice}>{visibleResponse.componentRanking.reason ? t(`workbench.components.fallback.${visibleResponse.componentRanking.reason}`) : t('workbench.components.activeKit', { kit: visibleResponse.componentRanking.kitId ?? '' })}</p> : null}
      {visibleResponse.degradedReason ? <p role="status" className={styles.notice}>{visibleResponse.degradedReason}</p> : null}
      {/* AC-R11.3: the saved constraints that rerank fonts, including ones no font meets and
          constraints that are not font requirements; the same report od prints. */}
      {visibleResponse.fontConstraints ? <section className={styles.coverage} aria-label={t('workbench.fontConstraints.title')} data-testid="workbench-font-constraints">
        <h3>{t('workbench.fontConstraints.title')}</h3>
        <p>{t('workbench.fontConstraints.summary', { met: String(visibleResponse.fontConstraints.fontsMeetingAllRequired), total: String(visibleResponse.fontConstraints.fontsConsidered) })}</p>
        <ul>
          {visibleResponse.fontConstraints.requirements.map((requirement) => <li key={requirement.id} data-satisfied={requirement.satisfiedCount > 0}>{requirement.message}</li>)}
          {visibleResponse.fontConstraints.uninterpreted.map((entry) => <li key={entry.source}>{entry.message}</li>)}
        </ul>
      </section> : null}
      {kitInventory ? <WorkbenchFontKitInventory inventory={kitInventory} />
        : visibleKitFonts?.state === 'loading' ? <p role="status" className={styles.notice}>{t('workbench.fontKits.loading')}</p>
          : visibleKitFonts?.state === 'ready' ? null
            : <div className={styles.notice}>
              {visibleKitFonts?.state === 'error' ? <span role="alert">{t('workbench.fontKits.error')} </span> : null}
              <Button size="sm" onClick={() => void loadKitFonts()}>{t('workbench.fontKits.show')}</Button>
            </div>}
      {groupResourcesBySource(visibleResponse.results.map(resource => localizeMotionRecipe(resource, t))).map(({ sourceId, named, results }) => {
        const heading = named ? t(`workbench.${named}`) : t('workbench.sourceGroup', { source: sourceId });
        return <section className={styles.group} key={sourceId} aria-label={heading}><h3>{heading}</h3>{results.map((resource) => <Button key={resource.refKey} className={styles.result} size="sm" aria-label={`${resource.title} · ${resource.readiness}${resource.componentFit ? ` · ${componentFitLabel(resource.componentFit, t)}` : ''}`} aria-pressed={selected?.refKey === resource.refKey} onClick={() => setSelected(resource)}><span>{resource.title}</span><span>{resource.readiness}</span>{resource.componentFit ? <WorkbenchComponentFit fit={resource.componentFit} compact /> : null}{resource.fitReasons.length ? <span className={styles.fit}>{resource.fitReasons.join(' · ')}</span> : null}</Button>)}</section>;
      })}
      {!loading && visibleResponse.results.length === 0 ? <p className={styles.notice}>{t('workbench.noResults')}</p> : null}
      {visibleResponse.nextCursor ? <Button size="sm" disabled={loading} onClick={() => void search(visibleResponse.nextCursor ?? undefined)}>{t('workbench.loadMore')}</Button> : null}
      <details className={styles.coverage}><summary>{t('workbench.coverage')}</summary><ul>{visibleResponse.sourceStatuses.map((source) => <li key={source.sourceId}>{source.sourceId}: {source.state}{source.itemCount !== null ? ` · ${source.itemCount}` : ''}{source.reason ? ` · ${source.reason}` : ''}</li>)}</ul></details>
    </> : null}
    {editing && projectId && active ? <WorkbenchProjectContext key={scope} projectId={projectId} workspaceContext={workspaceContext} onClose={() => setEditing(false)} onContextSaved={context => { if (current(scope, account)) setRecords(prior => prior?.scope === scope ? { ...prior, context } : prior); }} /> : null}
    {selected && visibleResponse && (!projectId || active) ? <WorkbenchResourceDetail key={selected.refKey} selected={selected} projectId={projectId} workspaceContext={workspaceContext} plugins={plugins} onPickPlugin={onPickPlugin} onClose={() => setSelected(null)} onRefresh={() => setRevision((n) => n + 1)} /> : null}
  </div>;
}
