import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Badge, Button, Dialog, DialogBody, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Spinner, Textarea } from '@mish/components';
import {
  DESIGN_BRIEF_TEXT_PATHS, parseDesignBriefPreview,
  type DesignBriefPreview, type DesignBrief, type DesignBriefEditablePath, type DesignBriefField, type DesignBriefRecordView, type DesignBriefTextPath,
  type PatchDesignBriefRequest, type ReferenceFanoutRequest, type ResourceRef, type RunDesignBriefBinding, type WorkspaceCollabContext,
} from '@mish/contracts';
import { useT } from '../../i18n';
import type { Dict } from '../../i18n/types';
import { previewDesignBrief, cancelDesignBrief, createDesignBrief, getDesignBrief, patchDesignBrief, WorkbenchRequestError } from '../../providers/workbench';
import { workspaceAccountScopedCacheKey } from '../../collab/workspace-identity';
import { WorkbenchReferences } from './WorkbenchReferences';
import styles from './WorkbenchImprovePrompt.module.css';

export interface WorkbenchImprovePromptProps {
  projectId?: string;
  /** The composer draft. It is never rewritten: Use prompt binds a brief beside it. */
  draft: string;
  workspaceContext?: WorkspaceCollabContext | null;
  selectedReferenceRefs?: ResourceRef[];
  spineCode?: ReferenceFanoutRequest['spineCode'];
  onUse?: (binding: RunDesignBriefBinding) => void;
  onUsePreview?: (preview: DesignBriefPreview) => void;
  onClose: () => void;
  pollMs?: number;
}

const FIELD_KEY: Record<DesignBriefTextPath, keyof Dict> = {
  audience: 'workbench.improve.field.audience', purpose: 'workbench.improve.field.purpose', conversion: 'workbench.improve.field.conversion',
  'design.typography': 'workbench.improve.field.typography', 'design.color': 'workbench.improve.field.color', 'design.spacing': 'workbench.improve.field.spacing',
  'design.layout': 'workbench.improve.field.layout', 'design.motion': 'workbench.improve.field.motion', responsive: 'workbench.improve.field.responsive',
  accessibility: 'workbench.improve.field.accessibility',
};
const BASIS_KEY: Record<DesignBriefField['basis'], keyof Dict> = {
  stated: 'workbench.improve.basis.stated', context: 'workbench.improve.basis.context', assumed: 'workbench.improve.basis.assumed',
  user: 'workbench.improve.basis.user', reference: 'workbench.improve.basis.reference',
  unverified: 'workbench.improve.basis.unverified',
};

function fieldOf(brief: DesignBrief | DesignBriefPreview, path: DesignBriefTextPath): DesignBriefField {
  return path.startsWith('design.') ? brief.design[path.slice(7) as keyof DesignBrief['design']] : brief[path as 'audience'];
}
function sectionLines(brief: DesignBrief | DesignBriefPreview): string {
  return brief.sections.map(section => (section.purpose ? `${section.name}: ${section.purpose}` : section.name)).join('\n');
}

/**
 * R15 Improve prompt (AC-R15.2): original, assumptions, questions and the
 * editable transformed brief are visible before Use prompt; reference
 * proposals are a reviewable, attributed diff. Failure or cancel leaves the
 * original prompt untouched.
 */
export function WorkbenchImprovePrompt({ projectId, draft, workspaceContext, selectedReferenceRefs, spineCode, onUse, onUsePreview, onClose, pollMs = 750 }: WorkbenchImprovePromptProps) {
  const t = useT();
  const [record, setRecord] = useState<DesignBriefRecordView | null>(null);
  const [preview, setPreview] = useState<DesignBriefPreview | null>(null);
  const [error, setError] = useState('');
  const [previewBusy, setPreviewBusy] = useState<'retrying' | 'busy' | null>(null);
  const previewController = useRef<AbortController | null>(null);
  const retryPreview = useRef<(() => void) | null>(null);
  const [busy, setBusy] = useState(false);
  const [edits, setEdits] = useState<Partial<Record<DesignBriefEditablePath, string>>>({});
  const started = useRef(false);
  const alive = useRef(true);
  const dismissed = useRef(false);
  const previewWorkspaceKey = workspaceAccountScopedCacheKey(workspaceContext);
  const previewWorkspaceRef = useRef(workspaceContext);
  previewWorkspaceRef.current = workspaceContext;
  // Set on every mount, not only at first render: StrictMode remounts once in development, and a
  // flag left false by that simulated unmount would stop the pending brief from ever showing.
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  useEffect(() => {
    if (projectId) return;
    const controller = new AbortController();
    previewController.current = controller;
    let inFlight = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    controller.signal.addEventListener('abort', () => clearTimeout(retryTimer), { once: true });
    setPreview(null); setEdits({}); setError('');
    setPreviewBusy(null);
    async function generate(retried = false) {
      if (controller.signal.aborted || inFlight) return;
      inFlight = true;
      setPreviewBusy(null);
      setError('');
      try {
        const next = await previewDesignBrief({ originalText: draft }, previewWorkspaceRef.current, { signal: controller.signal });
        if (!controller.signal.aborted) { setPreview(next); setPreviewBusy(null); }
      } catch (err) {
        if (controller.signal.aborted) return;
        if (err instanceof WorkbenchRequestError && err.status === 503 && err.code === 'transformer-busy') {
          setPreviewBusy(retried ? 'busy' : 'retrying');
          if (!retried) retryTimer = setTimeout(() => void generate(true), 2_000);
        } else setError(err instanceof Error ? err.message : String(err));
      } finally { inFlight = false; }
    }
    // The aborted predecessor may still be unwinding after our one automatic retry.
    // Let the user try again when its server-side slot becomes available.
    retryPreview.current = () => { void generate(true); };
    // Let StrictMode finish its simulated unmount before starting a model turn.
    void Promise.resolve().then(() => generate());
    return () => { controller.abort(); clearTimeout(retryTimer); retryPreview.current = null; };
  }, [projectId, draft, previewWorkspaceKey]);

  useEffect(() => {
    if (!projectId || started.current) return;
    started.current = true;
    (async () => {
      try {
        let next = await createDesignBrief({ projectId, originalText: draft, ...(selectedReferenceRefs?.length ? { selectedReferenceRefs } : {}) }, workspaceContext);
        if (!alive.current || dismissed.current) {
          // Closed before the daemon answered: cancel() had no id to cancel, so the model turn would run on unseen.
          if (next.status === 'pending') await cancelDesignBrief(projectId, next.id, workspaceContext).catch(() => undefined);
          return;
        }
        setRecord(next);
        while (next.status === 'pending' && alive.current) {
          await new Promise(resolve => setTimeout(resolve, pollMs));
          if (!alive.current) return;
          next = await getDesignBrief(projectId, next.id, workspaceContext);
          if (alive.current) setRecord(next);
        }
      } catch (err) {
        if (alive.current) setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [projectId, draft, workspaceContext, selectedReferenceRefs, pollMs]);

  const brief = preview ?? (record?.status === 'ready' ? record.brief : null);
  const dirty = Object.keys(edits).length > 0;
  const titleOf = useMemo(() => new Map((brief?.references ?? []).map(item => [`${item.ref.sourceId}:${item.ref.itemId}`, item.title])), [brief]);

  async function send(patch: Omit<PatchDesignBriefRequest, 'expectedRevision'>): Promise<DesignBriefRecordView | null> {
    const storedBrief = record?.brief;
    if (!storedBrief || !projectId) return null;
    setBusy(true); setError('');
    try {
      const next = await patchDesignBrief(projectId, storedBrief.id, { expectedRevision: storedBrief.revision, ...patch }, workspaceContext);
      setRecord(next); setEdits({});
      return next;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally { setBusy(false); }
  }
  function editsPayload(): PatchDesignBriefRequest['edits'] {
    const payload: NonNullable<PatchDesignBriefRequest['edits']> = {};
    for (const [path, value] of Object.entries(edits) as Array<[DesignBriefEditablePath, string]>) {
      if ((DESIGN_BRIEF_TEXT_PATHS as readonly string[]).includes(path)) { if (value.trim()) payload[path] = value.trim(); }
      else payload[path] = value.split('\n').map(line => line.trim()).filter(Boolean);
    }
    return payload;
  }
  function editPreview(): DesignBriefPreview {
    if (!preview) throw new Error('No preview to edit');
    let next = { ...preview, design: { ...preview.design } };
    const payload = editsPayload();
    for (const [path, value] of Object.entries(payload ?? {}) as Array<[DesignBriefEditablePath, string | string[]]>) {
      if (path.startsWith('design.')) next.design[path.slice(7) as keyof DesignBrief['design']] = { value: value as string, basis: 'user' };
      else if ((DESIGN_BRIEF_TEXT_PATHS as readonly string[]).includes(path)) next = { ...next, [path]: { value, basis: 'user' } };
      else if (path === 'sections') next.sections = (value as string[]).map(entry => {
        const [name, ...rest] = entry.split(':'); return { name: name!.trim().slice(0, 200) || 'Section', purpose: rest.join(':').trim() || null, basis: 'user' };
      });
    }
    next.userEditedPaths = [...new Set([...next.userEditedPaths, ...Object.keys(payload ?? {}) as DesignBriefEditablePath[]])];
    return parseDesignBriefPreview(next);
  }
  function savePreview(use: boolean) {
    try {
      const next = editPreview(); setPreview(next); setEdits({}); setError('');
      if (use) onUsePreview?.(next);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  }
  async function usePrompt() {
    if (preview) { savePreview(true); return; }
    const next = await send({ ...(dirty ? { edits: editsPayload() } : {}), accept: true });
    const accepted = next?.brief;
    if (accepted && accepted.state === 'accepted') onUse?.({ id: accepted.id, revision: accepted.revision, hash: accepted.hash });
  }
  async function cancel() {
    dismissed.current = true;
    previewController.current?.abort();
    if (projectId && record?.status === 'pending') await cancelDesignBrief(projectId, record.id, workspaceContext).catch(() => undefined);
    onClose();
  }

  // Portaled so a glass/transformed composer ancestor cannot clip the fixed dialog.
  return createPortal(
    <Dialog onClose={() => void cancel()} closeOnEscape ariaLabelledBy="improve-prompt-title" className={styles.dialog} data-testid="improve-prompt">
      <DialogHeader>
        <DialogTitle id="improve-prompt-title">{t('workbench.improve.title')}</DialogTitle>
        <DialogDescription>{t('workbench.improve.description')}</DialogDescription>
      </DialogHeader>
      <DialogBody className={styles.body}>
        <section className={styles.section} aria-labelledby="improve-prompt-original-label">
          <h3 id="improve-prompt-original-label">{t('workbench.improve.original')}</h3>
          <p className={styles.original} data-testid="improve-prompt-original">{record?.originalText ?? draft}</p>
        </section>
        {error ? <p role="alert" className={styles.error}>{error}</p> : null}
        {(!record && !preview && !error) || record?.status === 'pending' ? (
          <p className={styles.working} role="status">{previewBusy !== 'busy' ? <Spinner size="sm" /> : null} {t(previewBusy ? 'workbench.improve.stillFinishing' : 'workbench.improve.working')}</p>
        ) : null}
        {record?.status === 'failed' && record.failure ? (
          <div role="alert" className={styles.error}>
            <strong>{t('workbench.improve.failed')}</strong>
            <p>{record.failure.message}</p>
            <p>{record.failure.recovery}</p>
          </div>
        ) : null}
        {record?.status === 'cancelled' ? <p role="status">{t('workbench.improve.cancelled')}</p> : null}
        {brief ? (
          <>
            <section className={styles.section} data-testid="improve-prompt-style">
              <p><strong>{t('workbench.improve.style')}:</strong> {brief.intent.styleDirections.join(', ') || t('workbench.improve.none')}</p>
              <p><strong>{t('workbench.improve.runtime')}:</strong> {brief.intent.targetRuntime ?? t('workbench.improve.none')}</p>
            </section>
            <section className={styles.section} aria-labelledby="improve-prompt-fields">
              <h3 id="improve-prompt-fields">{t('workbench.improve.fields')}</h3>
              <div className={styles.fields}>
                {DESIGN_BRIEF_TEXT_PATHS.map(path => {
                  const field = fieldOf(brief, path);
                  const id = `improve-prompt-field-${path.replace('.', '-')}`;
                  return (
                    <div key={path} className={styles.field}>
                      <label htmlFor={id}>{t(FIELD_KEY[path])}</label>
                      <Badge tone={field.basis === 'assumed' || field.basis === 'unverified' ? 'warning' : 'neutral'}>{t(BASIS_KEY[field.basis])}</Badge>
                      <Textarea id={id} rows={2} value={edits[path] ?? field.value ?? ''} onChange={event => setEdits(current => ({ ...current, [path]: event.target.value }))} />
                      {field.groundingReason && !(path in edits) ? <p className={styles.grounding}>{field.groundingReason}</p> : null}
                    </div>
                  );
                })}
                <div className={styles.field}>
                  <label htmlFor="improve-prompt-field-sections">{t('workbench.improve.field.sections')}</label>
                  <Textarea id="improve-prompt-field-sections" rows={4} value={edits.sections ?? sectionLines(brief)} onChange={event => setEdits(current => ({ ...current, sections: event.target.value }))} />
                  {!('sections' in edits) ? brief.sections.filter(section => section.groundingReason).map((section, index) => (
                    <p key={index}><strong>{section.name}</strong> <Badge tone="warning">{t(BASIS_KEY[section.basis])}</Badge> {section.groundingReason}</p>
                  )) : null}
                </div>
              </div>
            </section>
            <WorkbenchReferences
              brief={[draft, ...DESIGN_BRIEF_TEXT_PATHS.map(path => `${path}: ${edits[path] ?? fieldOf(brief, path).value ?? ''}`)].join('\n')}
              spineCode={spineCode}
              contextKey={JSON.stringify({ brief, edits })}
              sections={(edits.sections === undefined ? brief.sections : edits.sections.split('\n').map(line => line.trim()).filter(Boolean).map(line => {
                const colon = line.indexOf(':');
                return { name: colon < 0 ? line : line.slice(0, colon).trim(), purpose: colon < 0 ? null : line.slice(colon + 1).trim() || null };
              })).map((section, index) => ({ id: `section-${index + 1}`, name: section.name, purpose: section.purpose }))}
            />
            {brief.assumptions.length ? (
              <section className={styles.section}><h3>{t('workbench.improve.assumptions')}</h3><ul>{brief.assumptions.map(item => <li key={item}>{item}</li>)}</ul></section>
            ) : null}
            {brief.questions.length ? (
              <section className={styles.section}><h3>{t('workbench.improve.questions')}</h3><ul>{brief.questions.map(item => <li key={item}>{item}</li>)}</ul></section>
            ) : null}
            {brief.referenceChanges.length ? (
              <section className={styles.section} aria-labelledby="improve-prompt-changes">
                <h3 id="improve-prompt-changes">{t('workbench.improve.changes')}</h3>
                <ul className={styles.changes}>
                  {brief.referenceChanges.map(change => (
                    <li key={change.id} className={styles.change} data-testid={`improve-prompt-change-${change.id}`}>
                      <p><strong>{t(FIELD_KEY[change.path])}</strong>{change.conflict ? <> <Badge tone="warning">{t('workbench.improve.conflict')}</Badge></> : null}{change.status !== 'proposed' ? <> <Badge tone={change.status === 'accepted' ? 'success' : 'neutral'}>{t(change.status === 'accepted' ? 'workbench.improve.status.accepted' : 'workbench.improve.status.rejected')}</Badge></> : null}</p>
                      <dl>
                        <dt>{t('workbench.improve.changeFrom')}</dt><dd>{change.oldValue ?? t('workbench.improve.none')}</dd>
                        <dt>{t('workbench.improve.changeTo')}</dt><dd>{change.proposedValue}</dd>
                        <dt>{t('workbench.improve.sources')}</dt><dd>{change.refs.map(ref => titleOf.get(`${ref.sourceId}:${ref.itemId}`) ?? ref.itemId).join(', ')}</dd>
                      </dl>
                      <p className={styles.muted}>{change.rationale}</p>
                      {change.contrast?.map(pair => (
                        <p key={`${pair.foreground}-${pair.background}`} className={pair.passesAA ? styles.muted : styles.error}>
                          {t(pair.passesAA ? 'workbench.improve.contrastPass' : 'workbench.improve.contrastFail', { ratio: pair.ratio, foreground: pair.foreground, background: pair.background })}
                        </p>
                      ))}
                      {change.tokenGaps?.map(gap => <p key={gap} className={styles.error}>{gap}</p>)}
                      {change.fonts?.filter(font => font.gap).map(font => <p key={font.family} className={styles.error}>{t('workbench.improve.fontGap', { family: font.family })}</p>)}
                      {change.status === 'proposed' ? (
                        <div className={styles.actions}>
                          <Button size="sm" data-decision="accepted" disabled={busy} onClick={() => void send({ referenceDecisions: [{ id: change.id, status: 'accepted' }] })}>{t('workbench.improve.accept')}</Button>
                          <Button size="sm" variant="ghost" data-decision="rejected" disabled={busy} onClick={() => void send({ referenceDecisions: [{ id: change.id, status: 'rejected' }] })}>{t('workbench.improve.reject')}</Button>
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </>
        ) : null}
      </DialogBody>
      <DialogFooter className={styles.actions}>
        {previewBusy === 'busy' ? (
          <Button variant="secondary" onClick={() => retryPreview.current?.()}>{t('preview.retry')}</Button>
        ) : null}
        {record?.status === 'pending' || (!record && !preview && !error) ? (
          <Button variant="ghost" onClick={() => void cancel()}>{t('workbench.improve.cancel')}</Button>
        ) : (
          <Button variant="ghost" onClick={() => void cancel()}>{t('workbench.improve.keepOriginal')}</Button>
        )}
        {brief ? (
          <>
            <Button variant="secondary" disabled={!dirty || busy} onClick={() => preview ? savePreview(false) : void send({ edits: editsPayload() })}>{t('workbench.improve.saveEdits')}</Button>
            <Button variant="primary" disabled={busy} onClick={() => void usePrompt()}>{t('workbench.improve.use')}</Button>
          </>
        ) : null}
      </DialogFooter>
    </Dialog>,
    document.body,
  );
}
