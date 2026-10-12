import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { Button, Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle, Select, Textarea } from '@open-design/components';
import type { CaptureDraftRevision, CaptureView, WorkspaceCollabContext } from '@open-design/contracts';
import { useT } from '../../i18n';
import { workspaceResourceUrl } from '../../collab/workspace-identity';
import { captureDraftApi, captureDraftPreviewDocument, CaptureDraftRequestError } from '../../providers/workbench-capture-drafts';
import { WorkbenchUnitSave } from './WorkbenchUnitSave';
import styles from './WorkbenchCapture.module.css';

const revisionKey = (draft: Pick<CaptureDraftRevision, 'draftId' | 'revision'>) => `${draft.draftId}:${draft.revision}`;
const sortRevisions = (drafts: CaptureDraftRevision[]) => [...drafts].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.revision - a.revision);
const errorMessage = (failure: unknown) => failure instanceof CaptureDraftRequestError ? `${failure.message}${failure.recovery ? ` ${failure.recovery}` : ''}` : failure instanceof Error ? failure.message : String(failure);
const newKey = () => typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `draft-${Date.now()}-${Math.random().toString(36).slice(2)}`;

interface Scope { projectId: string; workspaceContext?: WorkspaceCollabContext | null }
interface DraftPanelProps extends Scope { captureId: string; initialDraft?: Pick<CaptureDraftRevision, 'draftId' | 'revision'>; onClose(): void }

/** Persisted all-revision entry point remains available after the app or daemon restarts. */
export function WorkbenchCaptureDraftLibrary({ projectId, workspaceContext, onOpen }: Scope & { onOpen(draft: CaptureDraftRevision): void }) {
  const t = useT();
  const [drafts, setDrafts] = useState<CaptureDraftRevision[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController(); setDrafts([]); setLoading(true); setError(null);
    captureDraftApi.list(projectId, workspaceContext, controller.signal).then(list => {
      if (!controller.signal.aborted) { setDrafts(sortRevisions(list)); setLoading(false); }
    }).catch(failure => { if (!controller.signal.aborted) { setError(errorMessage(failure)); setLoading(false); } });
    return () => controller.abort();
  }, [projectId, workspaceContext, reload]);
  return <section className={styles.panel} aria-label={t('workbench.captureHub.drafts')} data-testid="workbench-draft-library">
    {loading ? <p role="status" className={styles.hint}>{t('workbench.draft.loading')}</p> : null}
    {error ? <p role="alert" className={styles.error}>{error} <Button size="sm" onClick={() => setReload(value => value + 1)}>{t('workbench.capture.retry')}</Button></p> : null}
    {!loading && !error && !drafts.length ? <p className={styles.hint}>{t('workbench.draft.empty')}</p> : null}
    <ul className={styles.list}>{drafts.map(draft => <li className={styles.item} key={revisionKey(draft)}>
      <div className={styles.meta}><strong>{t('workbench.draft.revisionLabel', { revision: draft.revision })} · {t(`workbench.draft.status.${draft.status}`)}</strong><span>{draft.prompt}</span><time dateTime={draft.createdAt}>{new Date(draft.createdAt).toLocaleString()}</time>
        <Button size="sm" onClick={() => onOpen(draft)}>{t('workbench.draft.resume', { revision: draft.revision })}</Button>
      </div>
    </li>)}</ul>
  </section>;
}

/** AC-R14.2: an immutable capture stays beside its persisted, prompt-driven draft revisions. */
export function WorkbenchCaptureDraftPanel({ projectId, captureId, workspaceContext, initialDraft, onClose }: DraftPanelProps) {
  const t = useT();
  const disclosureId = useId();
  const [capture, setCapture] = useState<CaptureView | null>(null);
  const [drafts, setDrafts] = useState<CaptureDraftRevision[]>([]);
  const [selectedKey, setSelectedKey] = useState('');
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [showSave, setShowSave] = useState(false);
  const requestKey = useRef<{ body: string; key: string } | null>(null);
  const scope = useRef(''); scope.current = `${projectId}:${captureId}:${JSON.stringify(workspaceContext ?? null)}`;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const initialKey = initialDraft ? revisionKey(initialDraft) : '';
  const selected = drafts.find(draft => revisionKey(draft) === selectedKey);
  const pending = drafts.filter(draft => draft.status === 'pending');
  const pendingKey = pending.map(revisionKey).join(',');

  useEffect(() => {
    setCapture(null); setDrafts([]); setSelectedKey(''); setPrompt(''); setSubmitting(false); setShowSave(false); requestKey.current = null;
  }, [projectId, captureId, workspaceContext]);

  useEffect(() => {
    if (selected?.status === 'failed') setPrompt(current => current || selected.prompt);
  }, [selectedKey, selected?.status, selected?.prompt]);

  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError(null);
    Promise.all([captureDraftApi.capture(projectId, captureId, workspaceContext, controller.signal), captureDraftApi.list(projectId, workspaceContext, controller.signal)]).then(([view, all]) => {
      if (controller.signal.aborted) return;
      const list = sortRevisions(all.filter(draft => draft.captureId === captureId));
      setCapture(view); setDrafts(list); setLoading(false);
      setSelectedKey(current => list.some(draft => revisionKey(draft) === current) ? current : list.some(draft => revisionKey(draft) === initialKey) ? initialKey : list[0] ? revisionKey(list[0]) : '');
    }).catch(failure => { if (!controller.signal.aborted) { setLoading(false); setError(errorMessage(failure)); } });
    return () => controller.abort();
  }, [projectId, captureId, workspaceContext, reload, initialKey]);

  useEffect(() => {
    if (!pendingKey) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const updates = await Promise.all(pending.map(draft => captureDraftApi.revision(projectId, draft.draftId, draft.revision, workspaceContext, controller.signal)));
        if (controller.signal.aborted) return;
        if (updates.some(draft => draft.captureId !== captureId)) throw new Error(t('workbench.draft.scopeError'));
        setDrafts(current => current.map(draft => updates.find(update => revisionKey(update) === revisionKey(draft)) ?? draft));
        if (updates.some(draft => draft.status === 'pending')) timer = setTimeout(() => void poll(), 1500);
      } catch (failure) { if (!controller.signal.aborted) setError(errorMessage(failure)); }
    };
    timer = setTimeout(() => void poll(), 1500);
    return () => { clearTimeout(timer); controller.abort(); };
    // The stable pending identity controls polling; ready history selection does not stop it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, captureId, workspaceContext, pendingKey, reload, t]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!capture?.bytesAvailable || !prompt.trim() || submitting || pending.length) return;
    const parent = selected?.status === 'ready' ? selected : selected?.status === 'failed' ? drafts.find(draft => draft.draftId === selected.draftId && draft.revision === selected.parentRevision && draft.status === 'ready') : undefined;
    const input = { projectId, captureId, prompt: prompt.trim(), ...(parent ? { parent: { draftId: parent.draftId, revision: parent.revision } } : {}) };
    const body = JSON.stringify(input);
    if (requestKey.current?.body !== body) requestKey.current = { body, key: newKey() };
    const activeScope = scope.current; setSubmitting(true); setError(null);
    try {
      const draft = await captureDraftApi.create(input, workspaceContext, requestKey.current.key);
      if (!mounted.current || scope.current !== activeScope) return;
      setDrafts(current => sortRevisions([draft, ...current.filter(item => revisionKey(item) !== revisionKey(draft))]));
      setSelectedKey(revisionKey(draft)); setPrompt(''); setShowSave(false); requestKey.current = null;
    } catch (failure) { if (mounted.current && scope.current === activeScope) setError(errorMessage(failure)); }
    finally { if (mounted.current && scope.current === activeScope) setSubmitting(false); }
  }

  const dialog = <Dialog onClose={onClose} closeOnBackdrop={false} ariaLabel={t('workbench.draft.title')} layout="sectioned" className={styles.draftDialog} data-testid="workbench-capture-draft">
    <DialogHeader><DialogTitle>{t('workbench.draft.title')}</DialogTitle></DialogHeader>
    <DialogBody className={styles.draftBody}>
      {loading ? <p className={styles.hint} role="status">{t('workbench.draft.loading')}</p> : null}
      {drafts.length ? <label className={styles.field}>{t('workbench.draft.revision')}<Select value={selectedKey} onChange={event => { setSelectedKey(event.target.value); setShowSave(false); }}>
        {drafts.map(draft => <option key={revisionKey(draft)} value={revisionKey(draft)}>{t('workbench.draft.revisionLabel', { revision: draft.revision })} · {t(`workbench.draft.status.${draft.status}`)} · {draft.prompt.slice(0, 60)}</option>)}
      </Select></label> : null}
      <div className={styles.comparison}>
        <figure className={styles.previewFigure}><figcaption>{t('workbench.draft.original')}</figcaption>
          {capture?.bytesAvailable ? <img className={styles.originalCapture} src={workspaceResourceUrl(capture.imageUrl, workspaceContext)} alt={t('workbench.draft.originalAlt')} width={capture.capture.image.width} height={capture.capture.image.height} /> : <p className={styles.hint}>{loading ? t('workbench.draft.loading') : t('workbench.capture.bytesRemoved')}</p>}
          {capture?.capture.sourceUrl ? <span className={styles.url}>{capture.capture.sourceUrl}</span> : null}
        </figure>
        <figure className={styles.previewFigure}><figcaption>{t('workbench.draft.output')}</figcaption>
          {selected?.status === 'ready' && selected.html ? <iframe className={styles.draftFrame} title={t('workbench.draft.preview')} sandbox="" referrerPolicy="no-referrer" srcDoc={captureDraftPreviewDocument(selected.html)} /> : <p className={styles.hint}>{selected?.status === 'pending' ? t('workbench.draft.generating') : t('workbench.draft.noOutput')}</p>}
          <p className={styles.hint}>{t('workbench.draft.staticPreview')}</p>
        </figure>
      </div>
      {selected?.failure ? <div role="alert" className={styles.error}><strong>{selected.failure.message}</strong><p>{selected.failure.recovery}</p></div> : null}
      {selected?.status === 'ready' ? <div className={styles.assumptions}><strong>{t('workbench.draft.assumptions')}</strong>{selected.assumptions.length ? <ul>{selected.assumptions.map((assumption, index) => <li key={index}>{assumption}</li>)}</ul> : <p className={styles.hint}>{t('workbench.draft.noAssumptions')}</p>}</div> : null}
      <p className={styles.hint}>{t('workbench.draft.hiddenBehavior')}</p>
      {error ? <div role="alert" className={styles.error}>{error} <Button size="sm" onClick={() => setReload(value => value + 1)}>{t('workbench.draft.checkStatus')}</Button></div> : null}
      <form className={styles.planForm} onSubmit={submit}>
        <p id={disclosureId} className={styles.hint}>{t('workbench.draft.providerDisclosure')}</p>
        <label className={styles.field}>{t('workbench.draft.instructions')}<Textarea aria-describedby={disclosureId} rows={3} value={prompt} maxLength={12000} disabled={submitting || pending.length > 0} onChange={event => setPrompt(event.target.value)} /></label>
        {pending.length ? <p role="status" className={styles.hint}>{t('workbench.draft.generating')}</p> : null}
        <Button variant="primary" type="submit" disabled={loading || !capture?.bytesAvailable || !prompt.trim() || submitting || pending.length > 0} loading={submitting}>{selected?.status === 'ready' ? t('workbench.draft.iterate') : selected?.status === 'failed' ? t('workbench.draft.retry') : t('workbench.draft.create')}</Button>
      </form>
      {selected?.status === 'ready' ? <>
        <Button size="sm" aria-expanded={showSave} onClick={() => setShowSave(value => !value)}>{t('workbench.draft.saveRegion')}</Button>
        {showSave ? <WorkbenchUnitSave key={selectedKey} projectId={projectId} captureId={captureId} draftSource={{ draftId: selected.draftId, revision: selected.revision }} workspaceContext={workspaceContext} /> : null}
      </> : null}
    </DialogBody>
    <DialogFooter><Button variant="ghost" onClick={onClose}>{t('workbench.capture.cancel')}</Button></DialogFooter>
  </Dialog>;
  const retained = <div data-workbench-retained="true" data-workbench-expanded="true">{dialog}</div>;
  return typeof document === 'undefined' ? retained : createPortal(retained, document.body);
}
