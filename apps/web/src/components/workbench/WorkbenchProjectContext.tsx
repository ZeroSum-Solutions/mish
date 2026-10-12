import { useEffect, useRef, useState } from 'react';
import { Button } from '@open-design/components';
import {
  parseProjectDesignContextDraft, parseProjectRubricDraft, WORKBENCH_MOTION_DEFAULT_VIEWPORTS,
  type WorkspaceCollabContext, type ProjectDesignContextSnapshot, type ProjectRubricSnapshot,
  type ProjectDesignContextDraft, type ProjectRubricDraft,
} from '@open-design/contracts';
import { getProjectDesignContext, getProjectRubric, putProjectDesignContext, putProjectRubric, WorkbenchRequestError } from '../../providers/workbench';
import { workspaceAccountScopedCacheKey, currentWorkspaceAccountGeneration } from '../../collab/workspace-identity';
import { useT } from '../../i18n';
import { WorkbenchReviewPanel } from './WorkbenchReviewPanel';
import styles from './workbench.module.css';

type Check = ProjectRubricDraft['checks'][number];
const emptyContext = (unknowns: string): ProjectDesignContextDraft => ({ purpose: null, audience: [], conversions: [], brandDirection: null, constraints: [], assumptions: [unknowns], factSources: [] });
function editable<T extends { schema: string; projectId: string; revision: number; updatedAt: string }>(record: T) {
  const { schema: _schema, projectId: _projectId, revision: _revision, updatedAt: _updatedAt, ...value } = record;
  return value;
}
/** Preserve untouched provenance. Only an explicit edit creates a confirmed declaration. */
function withSources(draft: ProjectDesignContextDraft, rationale: string): ProjectDesignContextDraft {
  draft = { ...draft, audience: draft.audience.map(v => v.trim()).filter(Boolean), assumptions: draft.assumptions.map(v => v.trim()).filter(Boolean) };
  const leaves = new Map<string, string>();
  const add = (path: string, value?: string | null) => { if (value?.trim()) leaves.set(path, value.trim()); };
  add('/purpose', draft.purpose); add('/brandDirection', draft.brandDirection); add('/styleDirection', draft.styleDirection); add('/spineCode', draft.spineCode);
  draft.audience.forEach((value, i) => add(`/audience/${i}`, value));
  draft.conversions.forEach((item, i) => { add(`/conversions/${i}/kind`, item.kind); add(`/conversions/${i}/role`, item.role); add(`/conversions/${i}/label`, item.label); add(`/conversions/${i}/target`, item.target); });
  draft.constraints.forEach((item, i) => add(`/constraints/${i}/value`, item.value));
  if (draft.designSystemRef) { add('/designSystemRef/id', draft.designSystemRef.id); add('/designSystemRef/revisionOrDigest', draft.designSystemRef.revisionOrDigest); }
  return { ...draft, factSources: [...leaves].map(([fieldPath, value]) => {
    const prior = draft.factSources.find(fact => fact.fieldPath === fieldPath && fact.value === value)
      ?? (fieldPath.startsWith('/audience/') ? draft.factSources.find(fact => fact.fieldPath.startsWith('/audience/') && fact.value === value) : undefined);
    return prior ? { ...prior, fieldPath } : { fieldPath, value, origin: 'user-confirmed', source: null, confidence: null, rationale };
  }) };
}
function nextId(prefix: string, used: string[]) { let n = 1; while (used.includes(`${prefix}-${n}`)) n++; return `${prefix}-${n}`; }
function removeGoalItem(draft: ProjectDesignContextDraft, family: 'conversions' | 'constraints', index: number): ProjectDesignContextDraft {
  const factSources = draft.factSources.flatMap(fact => {
    const match = fact.fieldPath.match(new RegExp(`^/${family}/(\\d+)(/.*)$`));
    if (!match) return [fact];
    const oldIndex = Number(match[1]);
    return oldIndex === index ? [] : [{ ...fact, fieldPath: `/${family}/${oldIndex > index ? oldIndex - 1 : oldIndex}${match[2]}` }];
  });
  if (family === 'constraints') return { ...draft, constraints: draft.constraints.filter((_, i) => i !== index), factSources };
  return { ...draft, conversions: draft.conversions.filter((_, i) => i !== index), factSources };
}
function newCheck(type: string, checkId: string, rationale: string, conversionId?: string): Check {
  const common = { checkId, required: false, severity: 'medium' as const, requiredBasis: null, provenance: { origin: 'user-confirmed' as const, derivation: 'project-input' as const, source: null, rationale }, sourceCriteria: [] };
  if (type === 'manual') return { ...common, kind: 'manual', evidenceTypes: ['manual-observation'], parameters: { type: 'manual-procedure', procedure: '', environment: '' } };
  if (type === 'judgment') return { ...common, kind: 'judgment', evidenceTypes: ['judgment-rationale'], parameters: { type: 'criterion', criterion: '' } };
  const base = { ...common, kind: 'mechanical' as const, evidenceTypes: ['probe' as const] };
  const viewports = [320, 375, 768, 1440];
  switch (type) {
    case 'cta': return { ...base, parameters: { type, actionType: 'conversion', targets: conversionId ? [{ type: 'conversion', id: conversionId }] : [], viewports } };
    case 'contrast': return { ...base, parameters: { type, normalTextMinRatio: 4.5, largeTextMinRatio: 3, viewports } };
    case 'console-resources': return { ...base, parameters: { type, failOnConsoleError: true, failOnBrokenResource: true, viewports } };
    case 'overflow': return { ...base, parameters: { type, toleranceCssPixels: 0, checkClippedContent: true, viewports } };
    case 'keyboard-focus': return { ...base, parameters: { type, requireVisibleFocus: true, requireFocusReturn: true, viewports } };
    case 'motion': return { ...base, parameters: { type, requirePauseControl: true, requireReducedMotionFallback: true, requireLivePreferenceChange: true, viewports: [...WORKBENCH_MOTION_DEFAULT_VIEWPORTS] } };
    default: return { ...base, parameters: { type: 'document-semantics', requireNamedControls: true, requireHeadingStructure: true, viewports } };
  }
}
type MotionParameters = Extract<Check['parameters'], { type: 'motion' }>;
const MOTION_REQUIREMENTS = [['requirePauseControl', 'workbench.motionCheck.pauseControl'], ['requireReducedMotionFallback', 'workbench.motionCheck.reducedFallback'], ['requireLivePreferenceChange', 'workbench.motionCheck.liveChange']] as const;
/** The opt-in motion check's requirements; the last one left on cannot be switched off (the contract refuses a check that requires nothing). */
function MotionRequirements({ parameters, onChange }: { parameters: MotionParameters; onChange: (parameters: MotionParameters) => void }) {
  const t = useT();
  const enabled = MOTION_REQUIREMENTS.filter(([key]) => parameters[key]).length;
  return <>{MOTION_REQUIREMENTS.map(([key, label]) => <label key={key}><input type="checkbox" checked={parameters[key]} disabled={parameters[key] && enabled === 1} onChange={e => onChange({ ...parameters, [key]: e.target.checked })} />{t(label)}</label>)}</>;
}
export function WorkbenchProjectContext({ projectId, workspaceContext, onClose, onContextSaved }: {
  projectId: string; workspaceContext?: WorkspaceCollabContext | null; onClose: () => void; onContextSaved: (value: ProjectDesignContextSnapshot) => void;
}) {
  const t = useT();
  const account = currentWorkspaceAccountGeneration();
  const scope = `${projectId}:${workspaceAccountScopedCacheKey(workspaceContext, account)}`;
  const live = useRef(scope); live.current = scope;
  const generation = useRef(0);
  const [loaded, setLoaded] = useState('');
  const [context, setContext] = useState<ProjectDesignContextSnapshot | null>(null);
  const [rubric, setRubric] = useState<ProjectRubricSnapshot | null>(null);
  const [goals, setGoals] = useState<ProjectDesignContextDraft>(() => emptyContext(t('workbench.unknownGoals')));
  const [checks, setChecks] = useState<ProjectRubricDraft>({ contextRevision: 1, checks: [] });
  const preAcceptance = useRef(new Map<string, Check['provenance']>());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState<'goals' | 'rubric' | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [checkType, setCheckType] = useState('judgment');
  const current = (n: number) => generation.current === n && live.current === scope && account === currentWorkspaceAccountGeneration();
  useEffect(() => {
    const n = ++generation.current;
    preAcceptance.current.clear();
    setLoaded(''); setBusy(false); setError(''); setConflict(null);
    void Promise.all([getProjectDesignContext(projectId, workspaceContext), getProjectRubric(projectId, workspaceContext)]).then(([c, r]) => {
      if (!current(n)) return;
      setContext(c); setRubric(r); setGoals(c.context ? editable(c.context) : emptyContext(t('workbench.unknownGoals')));
      setChecks(r.rubric ? editable(r.rubric) : { contextRevision: c.revision || 1, checks: [] }); setLoaded(scope);
    }).catch(() => { if (current(n)) setError(t('workbench.settingsError')); });
    return () => { generation.current++; };
  }, [scope, refresh]);
  async function save(family: 'goals' | 'rubric') {
    if (busy || !context || !rubric || loaded !== scope) return;
    const n = generation.current; setBusy(true); setError('');
    try {
      if (family === 'goals') {
        const draft = parseProjectDesignContextDraft(withSources(goals, t('workbench.explicitInput')));
        const saved = await putProjectDesignContext(projectId, { expectedRevision: context.revision, draft }, workspaceContext);
        if (!current(n)) return;
        setContext(saved); setGoals(saved.context ? editable(saved.context) : goals); onContextSaved(saved);
      } else {
        const saved = await putProjectRubric(projectId, { expectedRevision: rubric.revision, draft: parseProjectRubricDraft(checks) }, workspaceContext);
        if (!current(n)) return;
        setRubric(saved); if (saved.rubric) { preAcceptance.current.clear(); setChecks(editable(saved.rubric)); }
      }
      setConflict(null);
    } catch (failure) {
      if (!current(n)) return;
      if (failure instanceof WorkbenchRequestError && failure.status === 409 && failure.current) {
        if (family === 'goals') setContext(failure.current as ProjectDesignContextSnapshot); else setRubric(failure.current as ProjectRubricSnapshot);
        setConflict(family);
      } else setError(family === 'rubric' && context.revision === 0 && failure instanceof WorkbenchRequestError && failure.status === 422 ? t('workbench.saveGoalsFirst') : t('workbench.invalidDraft'));
    } finally { if (current(n)) setBusy(false); }
  }
  function reloadSaved(family: 'goals' | 'rubric') {
    // Conflict current is a strict authorized snapshot; reload affects only the chosen draft.
    if (family === 'goals' && context) setGoals(context.context ? editable(context.context) : emptyContext(t('workbench.unknownGoals')));
    if (family === 'rubric' && rubric) { preAcceptance.current.clear(); setChecks(rubric.rubric ? editable(rubric.rubric) : { contextRevision: context?.revision || 1, checks: [] }); }
    setConflict(null); setError('');
  }
  function changeCheck(index: number, update: (check: Check) => Check) {
    setChecks(prior => ({ ...prior, checks: prior.checks.map((check, i) => i !== index ? check : update(check)) }));
  }
  function changeAcceptance(index: number, required: boolean) {
    const row = checks.checks[index];
    if (!row) return;
    // This belongs to the draft row, even when a 409 replaces the saved snapshot.
    if (required && !row.required) preAcceptance.current.set(row.checkId, row.provenance);
    const optionalProvenance = preAcceptance.current.get(row.checkId);
    if (!required) preAcceptance.current.delete(row.checkId);
    changeCheck(index, check => {
      return {
        ...check,
        required,
        requiredBasis: required ? { type: 'project-acceptance', requirementId: check.checkId, rationale: t('workbench.explicitAcceptance') } : null,
        provenance: required
          ? { ...check.provenance, origin: 'user-confirmed', rationale: t('workbench.explicitAcceptance') }
          : optionalProvenance ?? { ...check.provenance, origin: 'user-confirmed', rationale: t('workbench.explicitInput') },
      };
    });
  }
  function removeCheck(checkId: string) {
    preAcceptance.current.delete(checkId);
    setChecks(prior => ({ ...prior, checks: prior.checks.filter(check => check.checkId !== checkId) }));
  }
  const lines = (text: string) => text ? text.split('\n') : [];
  return <section className={styles.editor} aria-label={t('workbench.projectGoals')}>
    <div className={styles.actions}><h3>{t('workbench.projectGoals')}</h3><Button size="sm" onClick={onClose}>{t('workbench.closeDetails')}</Button></div>
    {error ? <p role="alert">{error}</p> : null}
    {loaded !== scope ? <><p role="status">{t('workbench.previewLoading')}</p>{error ? <Button size="sm" onClick={() => setRefresh(n => n + 1)}>{t('preview.retry')}</Button> : null}</> : <fieldset disabled={busy} className={styles.fields}>
      <legend>{t('workbench.projectGoals')}</legend>
      <label>{t('workbench.purpose')}<textarea value={goals.purpose ?? ''} onChange={e => setGoals({ ...goals, purpose: e.target.value || null })} /></label>
      <label>{t('workbench.audience')}<textarea value={goals.audience.join('\n')} onChange={e => setGoals({ ...goals, audience: lines(e.target.value) })} /></label>
      <label>{t('workbench.brandDirection')}<textarea value={goals.brandDirection ?? ''} onChange={e => setGoals({ ...goals, brandDirection: e.target.value || null })} /></label>
      <label>{t('workbench.styleDirection')}<input value={goals.styleDirection ?? ''} onChange={e => { const { styleDirection: _old, ...rest } = goals; setGoals(e.target.value ? { ...rest, styleDirection: e.target.value } : rest); }} /></label>
      <label>{t('workbench.spine')}<select value={goals.spineCode ?? ''} onChange={e => { const { spineCode: _old, ...rest } = goals; setGoals(e.target.value ? { ...rest, spineCode: e.target.value as ProjectDesignContextDraft['spineCode'] } as ProjectDesignContextDraft : rest); }}><option value="">{t('workbench.unknown')}</option>{['TL','PA','CO','SM','CS','LM','BA','TU','MI'].map(code => <option key={code}>{code}</option>)}</select></label>
      <label>{t('workbench.assumptions')}<textarea value={goals.assumptions.join('\n')} onChange={e => setGoals({ ...goals, assumptions: lines(e.target.value) })} /></label>
      {goals.conversions.map((item, i) => <div className={styles.card} key={item.id}>
        <label>{t('workbench.conversionLabel')}<input value={item.label} onChange={e => setGoals({ ...goals, conversions: goals.conversions.map((v, n) => n === i ? { ...v, label: e.target.value } : v) })} /></label>
        <label>{t('workbench.conversionKind')}<select value={item.kind} onChange={e => setGoals({ ...goals, conversions: goals.conversions.map((v, n) => n === i ? { ...v, kind: e.target.value as typeof v.kind } : v) })}>{['signup','call','purchase','booking','contact','download','subscribe','other'].map(kind => <option key={kind} value={kind}>{t(`workbench.conversion.${kind}` as 'workbench.conversion.signup')}</option>)}</select></label>
        <label><input type="radio" name={`primary-${projectId}`} checked={item.role === 'primary'} onChange={() => setGoals({ ...goals, conversions: goals.conversions.map((v, n) => ({ ...v, role: n === i ? 'primary' : 'secondary' })) })} />{t('workbench.primary')}</label>
        <label>{t('workbench.conversionTarget')}<input value={item.target ?? ''} onChange={e => setGoals({ ...goals, conversions: goals.conversions.map((v, n) => { if (n !== i) return v; const { target: _target, ...rest } = v; return e.target.value ? { ...rest, target: e.target.value } : rest; }) })} /></label>
        <Button size="sm" onClick={() => setGoals(removeGoalItem(goals, 'conversions', i))}>{t('workbench.remove')}</Button>
      </div>)}
      <Button size="sm" disabled={goals.conversions.length >= 20} onClick={() => setGoals({ ...goals, conversions: [...goals.conversions, { id: nextId('conversion', goals.conversions.map(v => v.id)), kind: 'other', role: goals.conversions.length ? 'secondary' : 'primary', label: '' }] })}>{t('workbench.addConversion')}</Button>
      {goals.constraints.map((item, i) => <label key={item.id}>{t('workbench.constraint')} · {item.kind === 'motion' ? t('workbench.motion') : t(`workbench.constraint.${item.kind}`)}{item.kind === 'motion' ? <select value={item.value} onChange={e => setGoals({ ...goals, constraints: goals.constraints.map((v, n) => n === i ? { ...item, value: e.target.value as 'none' | 'reduced' | 'allowed' } : v) })}>{['none','reduced','allowed'].map(value => <option key={value} value={value}>{t(`workbench.motion.${value}` as 'workbench.motion.none')}</option>)}</select> : <input value={item.value} onChange={e => setGoals({ ...goals, constraints: goals.constraints.map((v, n) => n === i ? { ...item, value: e.target.value } : v) })} />}<Button size="sm" onClick={() => setGoals(removeGoalItem(goals, 'constraints', i))}>{t('workbench.remove')}</Button></label>)}
      <div className={styles.actions}><Button size="sm" disabled={goals.constraints.length >= 40 || goals.constraints.some(v => v.kind === 'motion')} onClick={() => setGoals({ ...goals, constraints: [...goals.constraints, { id: nextId('motion', goals.constraints.map(v => v.id)), kind: 'motion', value: 'none' }] })}>{t('workbench.addMotion')}</Button>{(['runtime','accessibility','other'] as const).map(kind => <Button size="sm" key={kind} disabled={goals.constraints.length >= 40} onClick={() => setGoals({ ...goals, constraints: [...goals.constraints, { id: nextId(kind, goals.constraints.map(v => v.id)), kind, value: '' }] })}>{t(`workbench.constraint.${kind}`)}</Button>)}</div>
      {goals.designSystemRef ? <p>{t('workbench.designSystem')}: {goals.designSystemRef.id} · {goals.designSystemRef.revisionOrDigest}</p> : null}
      <details><summary>{t('workbench.factOrigins')}</summary><ul>{withSources(goals, t('workbench.explicitInput')).factSources.map(fact => <li key={fact.fieldPath}>{fact.value} · {t(`workbench.origin.${fact.origin}`)} · {fact.rationale}{fact.source ? ` · ${'assetId' in fact.source ? fact.source.assetId : `${fact.source.resourceRef.sourceId}/${fact.source.resourceRef.itemId}@${fact.source.resourceRef.revisionOrDigest}`}` : ''}</li>)}</ul></details>
      {conflict === 'goals' ? <div role="alert">{t('workbench.unsavedGoals')} {t('workbench.savedRevision')}: {context?.revision}<div className={styles.actions}><Button size="sm" onClick={() => reloadSaved('goals')}>{t('workbench.reloadGoals')}</Button><Button size="sm" onClick={() => void save('goals')}>{t('workbench.retryGoals')}</Button></div></div> : null}
      <Button size="sm" onClick={() => void save('goals')}>{t('workbench.saveGoals')}</Button>
      <h3>{t('workbench.rubric')}</h3><p>{t('workbench.declarationsPending')}</p>
      <ul>{['declaredActions','textContrast','consoleResources','responsiveOverflow','keyboardFocus','documentSemantics'].map(subject => <li key={subject}>{t(`workbench.mandatory.${subject}` as 'workbench.mandatory.textContrast')} — {t('workbench.verificationPending')}</li>)}</ul>
      {checks.contextRevision !== context?.revision && context?.revision ? <p role="status">{t('workbench.staleRubric')} {checks.contextRevision} → {context.revision} <Button size="sm" onClick={() => setChecks({ ...checks, contextRevision: context.revision })}>{t('workbench.linkCurrent')}</Button></p> : null}
      {checks.checks.map((check, i) => <div key={check.checkId} className={styles.card}>
        <p>{t(`workbench.check.${check.kind}`)} · {t('workbench.verificationPending')} · {t(`workbench.origin.${check.provenance.origin}`)}</p>
        {check.applicability?.status === 'not-applicable' ? <p>{t('workbench.proposedNA')} · {check.applicability.rationale}</p> : null}
        {check.kind === 'judgment' ? <label>{t('workbench.criterion')}<textarea value={check.parameters.criterion} onChange={e => changeCheck(i, c => c.kind === 'judgment' ? { ...c, parameters: { ...c.parameters, criterion: e.target.value } } : c)} /></label> : check.kind === 'manual' ? <><label>{t('workbench.procedure')}<textarea value={check.parameters.procedure} onChange={e => changeCheck(i, c => c.kind === 'manual' ? { ...c, parameters: { ...c.parameters, procedure: e.target.value } } : c)} /></label><label>{t('workbench.environment')}<input value={check.parameters.environment} onChange={e => changeCheck(i, c => c.kind === 'manual' ? { ...c, parameters: { ...c.parameters, environment: e.target.value } } : c)} /></label></> : <><p>{t(`workbench.parameter.${check.parameters.type}`)} · {check.parameters.viewports.join(', ')} px</p>{check.parameters.type === 'motion' ? <MotionRequirements parameters={check.parameters} onChange={parameters => changeCheck(i, c => c.kind === 'mechanical' && c.parameters.type === 'motion' ? { ...c, parameters } : c)} /> : null}</>}
        <label>{t('workbench.checkIntent')}<textarea value={check.intent ?? ''} onChange={e => changeCheck(i, c => { const { intent: _intent, ...rest } = c; return e.target.value ? { ...rest, intent: e.target.value } : rest; })} /></label>
        <label>{t('workbench.severity')}<select value={check.severity} onChange={e => changeCheck(i, c => ({ ...c, severity: e.target.value as Check['severity'] }))}>{['low','medium','high','critical'].map(value => <option value={value} key={value}>{t(`workbench.severity.${value}` as 'workbench.severity.low')}</option>)}</select></label>
        {check.requiredBasis?.type !== 'mandatory' ? <label><input type="checkbox" checked={check.required} onChange={e => changeAcceptance(i, e.target.checked)} />{t('workbench.requiredAcceptance')}</label> : <p>{t('workbench.mandatoryDeclaration')}</p>}
        <p>{check.provenance.rationale}</p>{check.sourceCriteria.length ? <ul>{check.sourceCriteria.map(source => <li key={`${source.sourceId}:${source.revisionOrDigest}:${source.criterionId}:${source.canonicalUrl}`}><a href={source.canonicalUrl} target="_blank" rel="noreferrer">{source.sourceId} · {source.criterionId} · {source.revisionOrDigest}</a></li>)}</ul> : null}<Button size="sm" onClick={() => removeCheck(check.checkId)}>{t('workbench.remove')}</Button>
      </div>)}
      <div className={styles.actions}><label>{t('workbench.checkType')}<select value={checkType} onChange={e => setCheckType(e.target.value)}>{['judgment','manual','cta','contrast','console-resources','overflow','keyboard-focus','document-semantics','motion'].map(type => <option value={type} key={type}>{type === 'judgment' || type === 'manual' ? t(`workbench.check.${type}`) : t(`workbench.parameter.${type}` as 'workbench.parameter.cta')}</option>)}</select></label><Button size="sm" disabled={checks.checks.length >= 100 || (checkType === 'cta' && !goals.conversions.length)} onClick={() => setChecks({ ...checks, checks: [...checks.checks, newCheck(checkType, nextId('check', checks.checks.map(c => c.checkId)), t('workbench.explicitInput'), goals.conversions[0]?.id)] })}>{t('workbench.addCheck')}</Button></div>
      {conflict === 'rubric' ? <div role="alert">{t('workbench.unsavedRubric')} {t('workbench.savedRevision')}: {rubric?.revision}<div className={styles.actions}><Button size="sm" onClick={() => reloadSaved('rubric')}>{t('workbench.reloadRubric')}</Button><Button size="sm" onClick={() => void save('rubric')}>{t('workbench.retryRubric')}</Button></div></div> : null}
      <Button size="sm" onClick={() => void save('rubric')}>{t('workbench.saveRubric')}</Button>
    </fieldset>}
    <WorkbenchReviewPanel projectId={projectId} workspaceContext={workspaceContext} />
  </section>;
}
