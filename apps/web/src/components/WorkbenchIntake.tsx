import { formatBytes } from './LibraryAssetMeta';
import { beginGuestDropMode, hasGuestSurfaces } from '../runtime/intake/guest-drop-mode';
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react';
import type { AttachIntakeResponse, IntakeFileOutcome } from '@open-design/contracts';
import { IconButton } from '@open-design/components';
import { Icon } from './Icon';
import { createDropCoordinator, type ExternalFilesDrop } from '../runtime/intake/drop-coordinator';
import { collectNativeDrop } from '../runtime/intake/native-drop-intake';
import { createOptionDropMode } from '../runtime/intake/option-drop-mode';
import { getOpenDesignHost } from '@open-design/host';
import { workbenchIntakeStore, type IntakeTarget, type IntakeStore } from '../runtime/intake/intake-store';
import { applyLibraryAsset, fetchProjectFiles, invalidateProjectFilesCache } from '../providers/registry';
import { intakeFileDownloadUrl } from '../providers/intake';
import { workspaceAccountScopedCacheKey } from '../collab/workspace-identity';
import { useI18n } from '../i18n';
import styles from './WorkbenchIntake.module.css';

export const INTAKE_ATTACHED_EVENT = 'workbench:intake-attached';
export const INTAKE_PROJECT_FILE_ADDED_EVENT = 'workbench:intake-project-file-added';
export interface IntakeProjectFileAddedDetail { projectId: string; relPath: string; target: IntakeTarget }
export interface IntakeAttachedDetail { result: AttachIntakeResponse; target: IntakeTarget; sequence?: number }
type Coordinator = ReturnType<typeof createDropCoordinator<IntakeTarget>>;
type Accepted = ReturnType<IntakeStore['accept']> | undefined;
interface AddOptions { toMessage?: boolean }
interface IntakeUi {
 target: IntakeTarget;
 add: (files: readonly File[], target?: IntakeTarget, options?: AddOptions) => Accepted;
 acceptDrop: (drop: ExternalFilesDrop, target: IntakeTarget, options?: AddOptions) => Promise<Accepted>;
 coordinator: Coordinator;
 pendingIds: string[];
 pendingMessageFiles: { batchId: string; clientFileId: string; filename: string; size: number }[];
 removePending: (batchId: string, fileId: string) => void;
 finishHomeSend: (files: readonly { batchId: string; clientFileId: string }[]) => void;
 handoffPending: boolean;
 attached: IntakeAttachedDetail[];
 startDropMode: () => void;
}
const Context = createContext<IntakeUi | null>(null);
export const useWorkbenchIntake = () => useContext(Context);

/** The workspace reserves toolbar space for this control, keeping the composer clear. */
export function WorkbenchDropModeButton({ className, children }: { className?: string; children?: ReactNode }) {
 const intake = useWorkbenchIntake(); const { t } = useI18n();
 if (intake?.target.destination.kind !== 'project') return null;
 const label = t('intake.dropMode');
 return <button type="button" className={className} data-testid="workbench-drop-mode" title={label} aria-label={label} data-tooltip={label} data-tooltip-placement="bottom" aria-haspopup="dialog" onClick={intake.startDropMode}>{children ?? label}</button>;
}

/** Scope a specialized composer without mounting another global coordinator. */
export function WorkbenchIntakeTarget({ target, children }: { target: IntakeTarget | null; children: ReactNode }) {
 const intake = useWorkbenchIntake();
 return <Context.Provider value={intake && target ? { ...intake, target, add: (files, frozen = target, options) => intake.add(files, frozen, options), acceptDrop: (drop, frozen = target, options) => intake.acceptDrop(drop, frozen, options) } : null}>{children}</Context.Provider>;
}

/** A declared local region wins over the shell's default destination. */
export function useIntakeDropTarget(target: IntakeTarget, onSettled?: () => void) {
 const intake = useWorkbenchIntake(); const [element, setElement] = useState<HTMLElement | null>(null);
 const latest = useRef({ target, onSettled }); latest.current = { target, onSettled };
 useEffect(() => {
  if (!intake || !element) return;
  return intake.coordinator.registerTarget(element, { getSnapshot: () => latest.current.target, onDrop: (drop, frozen) => intake.acceptDrop(drop, frozen).then(accepted => { if (accepted) void accepted.settled.then(() => latest.current.onSettled?.()); }) });
 }, [intake?.coordinator, element]);
 return setElement;
}

export function WorkbenchIntake({ target, children, store = workbenchIntakeStore, generationKey = '', homeComposerVisible = false, onUseOnHome, onOpenProjectFile }: { target: IntakeTarget; children: ReactNode; store?: IntakeStore; generationKey?: string; homeComposerVisible?: boolean; onUseOnHome?: () => void; onOpenProjectFile?: (projectId: string, relPath: string) => void }) {
 const { t } = useI18n(); const views = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
 const current = useRef(target); current.current = target;
 const generation = useRef(generationKey); generation.current = generationKey;
 const scopeKey = workspaceAccountScopedCacheKey(target.context);
 const [notice, setNotice] = useState<{ text: string; scopeKey: string } | null>(null);
 const actionRef = useRef<Record<string, 'working' | 'attached' | 'added'>>({});
 const [actions, setActions] = useState(actionRef.current);
 const setAction = (key: string, value?: 'working' | 'attached' | 'added') => {
  const next = { ...actionRef.current };
  if (value) next[key] = value; else delete next[key];
  actionRef.current = next; setActions(next);
 };
 const [dropMode, setDropMode] = useState(false);
 const dropModeRef = useRef(false); dropModeRef.current = dropMode;
 const overlayRef = useRef<HTMLDivElement>(null);
 const restoreGuestRef = useRef<((restoreFocus?: boolean) => void) | null>(null);
 const optionModeRef = useRef<ReturnType<typeof createOptionDropMode> | null>(null);
 const exitDropMode = (restoreFocus = true) => { optionModeRef.current?.closed(); restoreGuestRef.current?.(restoreFocus); restoreGuestRef.current = null; dropModeRef.current = false; setDropMode(false); };
 const exitDropModeRef = useRef(exitDropMode); exitDropModeRef.current = exitDropMode;
 // AC-R01.1: an external file drag holding Option selects app intake over guests.
 optionModeRef.current ??= createOptionDropMode({
  isActive: () => dropModeRef.current,
  hasGuests: () => current.current.destination.kind === 'project' && hasGuestSurfaces(document),
  enter: () => { dropModeRef.current = true; setDropMode(true); },
  exit: () => exitDropModeRef.current(false),
 });
 useLayoutEffect(() => {
  exitDropMode(false); setClosed(false);
 }, [generationKey, workspaceAccountScopedCacheKey(target.context), JSON.stringify(target.destination)]);
 useLayoutEffect(() => {
  if (!dropMode) return;
  restoreGuestRef.current = beginGuestDropMode(document); overlayRef.current?.focus();
  const escape = (event: KeyboardEvent) => { if (event.key === 'Tab') { event.preventDefault(); event.stopPropagation(); overlayRef.current?.querySelector('button')?.focus(); } if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); exitDropMode(); } };
  document.addEventListener('keydown', escape, true);
  return () => { document.removeEventListener('keydown', escape, true); restoreGuestRef.current?.(false); restoreGuestRef.current = null; };
 }, [dropMode]);
 const [expanded, setExpanded] = useState(true);
 // J4-06: the tray had no way to dismiss itself — only the heading's
 // expand/collapse toggle, which still left a fixed bar covering the
 // composer at 390px. `closed` hides the whole tray (the files themselves
 // are untouched); the next drop reopens it, since that is the user acting
 // on this scope again.
 const [closed, setClosed] = useState(false);
 // J4-06 round 2: at narrow widths the tray is anchored below the docked
 // chrome header instead of a fixed guess, so its close button is never
 // covered by (and never covers) `.app-chrome-header`. Measures the real
 // header live (same selector FileViewer.tsx's own chrome-height tracking
 // uses) so it tracks height changes (44px vs 52px variants, future
 // redesigns) instead of hardcoding one.
 const [chromeHeight, setChromeHeight] = useState<number | null>(null);
 useEffect(() => {
  const chrome = document.querySelector<HTMLElement>('.workspace-tabs-chrome.app-chrome-header');
  const measure = () => {
   const height = document.querySelector<HTMLElement>('.workspace-tabs-chrome.app-chrome-header')?.getBoundingClientRect().height ?? 0;
   setChromeHeight(height > 0 ? height : null);
  };
  measure();
  window.addEventListener('resize', measure);
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
  if (observer && chrome) observer.observe(chrome);
  return () => { window.removeEventListener('resize', measure); observer?.disconnect(); };
 }, []);
 const [remaining, setRemaining] = useState<{ files: File[]; target: IntakeTarget; scopeKey: string; options?: AddOptions }[]>([]);
 const fail = (error: unknown, issuedScope = scopeKey) => setNotice({ text: error instanceof Error ? error.message : String(error), scopeKey: issuedScope });
 const addRef = useRef<IntakeUi['add']>(() => undefined);
 const acceptDropRef = useRef<IntakeUi['acceptDrop']>(async () => undefined);
 addRef.current = (files, frozen = current.current, options) => {
  if (!files.length) return;
  setExpanded(true); setClosed(false);
  const acceptedScope = workspaceAccountScopedCacheKey(frozen.context);
  const accepted = store.accept(files, frozen);
  if (options?.toMessage && frozen.destination.kind === 'pending') {
   for (const file of store.getSnapshot().find(batch => batch.id === accepted.id)?.descriptors ?? []) store.stagePending(accepted.id, file.clientFileId);
  }
  if (dropModeRef.current) exitDropMode();
  if (accepted.remaining.length) setRemaining(items => [...items, { files: accepted.remaining, target: structuredClone(frozen), scopeKey: acceptedScope, options }]);
  void accepted.settled.then(async () => {
   const destination = frozen.destination;
   if (destination.kind === 'project' && destination.conversationId) {
    const result = await store.attach(accepted.id, { projectId: destination.projectId, conversationId: destination.conversationId });
    window.dispatchEvent(new CustomEvent<IntakeAttachedDetail>(INTAKE_ATTACHED_EVENT, { detail: { result, target: frozen } }));
   }
  }).catch(error => fail(error, acceptedScope));
  return accepted;
 };
 // Folders expand through the desktop host's confined listing (AC-R01.1).
 acceptDropRef.current = async (drop, frozen, options) => {
  try {
  if (!drop.directories.length) return addRef.current(drop.files, frozen, options);
  const { files, reports } = await collectNativeDrop(drop, getOpenDesignHost()?.intake ?? null, {
   unsupported: t('intake.directory'),
   refused: (folder, items) => t('intake.directoryRefused').replace('{folder}', folder).replace('{items}', items),
   truncated: folder => t('intake.directoryTruncated').replace('{folder}', folder),
   failed: (folder, reason) => t('intake.directoryFailed').replace('{folder}', folder).replace('{reason}', reason),
  });
  if (reports.length) setNotice({ text: reports.join(' '), scopeKey: workspaceAccountScopedCacheKey(frozen.context) });
  return addRef.current(files, frozen, options);
  } catch (error) { fail(error, workspaceAccountScopedCacheKey(frozen.context)); return undefined; }
 };
 const coordinator = useMemo(() => createDropCoordinator<IntakeTarget>({
  getSnapshot: () => current.current,
  onAcknowledge: () => { setExpanded(true); },
  onDrop: (drop, frozen) => acceptDropRef.current(drop, dropModeRef.current ? frozen : { ...frozen, destination: { kind: 'pending' } }).then(() => undefined),
  onError: error => fail(error),
  onDragModifier: optionHeld => optionModeRef.current?.dragOver(optionHeld),
  onDragLeaveWindow: () => optionModeRef.current?.leaveWindow(),
 }), [t]);
 useEffect(() => coordinator.mount(document), [coordinator]);
 useEffect(() => { let active = true; void store.hydrate(target.context).catch(error => { if (active) fail(error); }); return () => { active = false; }; }, [scopeKey]);
 const visible = views.filter(view => view.scopeKey === scopeKey);
 const pendingIds = store.messageBatchIds(target.context);
 const pendingMessageFiles = visible.flatMap(batch => {
  const selected = new Set(store.messageFileIds(batch.id));
  return batch.descriptors.filter(file => selected.has(file.clientFileId)).map(file => ({ batchId: batch.id, clientFileId: file.clientFileId, filename: file.filename, size: file.size }));
 });
 const value: IntakeUi = { target, finishHomeSend: files => store.finishHomeSend(files), add: (files, frozen, options) => addRef.current(files, frozen, options), acceptDrop: (drop, frozen, options) => acceptDropRef.current(drop, frozen, options), coordinator, pendingIds, pendingMessageFiles, removePending: (batchId, fileId) => store.stagePending(batchId, fileId, false), handoffPending: target.destination.kind === 'project' && views.some(view => view.homeHandoffProjectId === (target.destination.kind === 'project' ? target.destination.projectId : '')), attached: visible.flatMap(view => view.attached ? [{ result: view.attached, target: view.target, sequence: view.stageSequence }] : []), startDropMode: () => setDropMode(true) };
 const rows = visible.flatMap(batch => {
  const outcomes: IntakeFileOutcome[] = batch.receipt?.files ?? batch.descriptors.map(file => ({ clientFileId: file.clientFileId, order: file.order, descriptor: file, state: 'queued' as const, retryable: true, hasSuccessfulAttachment: false }));
  return outcomes.filter(file => !batch.homeSentFileIds?.includes(file.clientFileId) && (file.state !== 'cleared' || batch.errors[file.clientFileId])).map(file => ({ batch, file }));
 });
 return <Context.Provider value={value}>{children}
  {dropMode ? <div className={styles.dropMode} ref={overlayRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={t('intake.dropMode')} data-testid="workbench-drop-overlay">
    <div><h2>{t('intake.dropMode')}</h2><p>{t('intake.dropModeHint')}</p><button type="button" onClick={() => exitDropMode()}>{t('intake.cancel')}</button></div>
  </div> : null}
  {!closed && (rows.length || remaining.some(item => item.scopeKey === scopeKey) || notice?.scopeKey === scopeKey) ? <aside className={styles.tray} data-testid="workbench-intake-tray" aria-label={t('intake.title')} style={chromeHeight != null ? ({ '--intake-header-clearance': `${Math.round(chromeHeight)}px` } as CSSProperties) : undefined}>
   <div className={styles.headingRow}>
    <button type="button" className={styles.heading} aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{t('intake.title')} · {rows.length}</button>
    <IconButton label={t('intake.close')} size="sm" onClick={() => setClosed(true)}><Icon name="close" size={16} /></IconButton>
   </div>
   {expanded ? <div className={styles.content}>
    <p className={styles.note}>{t('intake.limit')}</p>
    <p role="status" aria-live="polite">{notice?.scopeKey === scopeKey ? notice.text : ''}</p>
    <ol className={styles.rows}>{rows.map(({ batch, file }) => {
     const descriptor = file.descriptor;
     const name = file.stored?.filename ?? descriptor?.filename ?? `${t('intake.file')} ${file.order + 1}`;
     const uploading = batch.uploading.includes(file.clientFileId); const error = batch.errors[file.clientFileId] ?? file.error?.message;
     const destination = batch.target.destination;
     const project = target.destination.kind === 'project' ? target.destination : null;
     const actionKey = `${batch.scopeKey}:${batch.id}:${file.clientFileId}:${project?.projectId ?? ''}:${project?.conversationId ?? 'files'}`;
     const completed = actions[actionKey] === 'attached' || actions[actionKey] === 'added'
      || (project?.conversationId
       ? batch.attached?.attachments.some(item => item.clientFileId === file.clientFileId && item.projectId === project.projectId && item.conversationId === project.conversationId)
       : !!project && file.stored?.projectFile?.projectId === project.projectId);
     const writing = actions[actionKey] === 'working';
     const writeToProject = async () => {
      const frozen = structuredClone(current.current);
      if (frozen.destination.kind !== 'project' || actionRef.current[actionKey] || completed || !file.stored) return;
      const selectedProject = frozen.destination; const issuedGeneration = generation.current;
      setAction(actionKey, 'working');
      try {
       if (selectedProject.conversationId) {
        const result = await store.attach(batch.id, { projectId: selectedProject.projectId, conversationId: selectedProject.conversationId, clientFileIds: [file.clientFileId] });
        if (!result.attachments.some(item => item.clientFileId === file.clientFileId)) throw new Error(t('intake.actionFailed'));
        setAction(actionKey, 'attached');
        setNotice({ text: t('intake.attachedNotice').replace('{name}', name), scopeKey: batch.scopeKey });
        window.dispatchEvent(new CustomEvent<IntakeAttachedDetail>(INTAKE_ATTACHED_EVENT, { detail: { result, target: { ...frozen, context: batch.target.context } } }));
       } else {
        // Library apply uses a deterministic hash name. Reuse an existing copy
        // after reload so a second click cannot overwrite the user's edits.
        const files = await fetchProjectFiles(selectedProject.projectId, { fresh: true, requireAuthoritative: true, workspaceContext: batch.target.context });
        const libraryName = new RegExp(`^library/${file.stored.contentHash.slice(0, 12)}\\.[^.]+$`);
        const existing = files.find(item => item.type !== 'dir' && libraryName.test(item.name));
        const result = existing ? { relPath: existing.name } : await applyLibraryAsset(file.stored.assetId, selectedProject.projectId, undefined, undefined, batch.target.context);
        if (!result) throw new Error(t('intake.actionFailed'));
        setAction(actionKey, 'added');
        invalidateProjectFilesCache(selectedProject.projectId, batch.target.context);
        setNotice({ text: t('intake.addedNotice').replace('{name}', name), scopeKey: batch.scopeKey });
        window.dispatchEvent(new CustomEvent<IntakeProjectFileAddedDetail>(INTAKE_PROJECT_FILE_ADDED_EVENT, { detail: { projectId: selectedProject.projectId, relPath: result.relPath, target: { ...frozen, context: batch.target.context } } }));
        if (generation.current === issuedGeneration
          && workspaceAccountScopedCacheKey(current.current.context) === batch.scopeKey
          && JSON.stringify(current.current.destination) === JSON.stringify(frozen.destination)) onOpenProjectFile?.(selectedProject.projectId, result.relPath);
       }
      } catch (error) { setAction(actionKey); fail(error, batch.scopeKey); }
     };
     return <li key={`${batch.id}:${file.clientFileId}`} data-intake-file-id={file.clientFileId}>
      <div className={styles.filename}>{name}</div>
      <small>{destination.kind === 'pending' ? t('intake.pending') : `${destination.projectId}${destination.dir ? ` / ${destination.dir}` : ''}`}</small>
      <small>{[formatBytes(descriptor.size), file.stored?.detectedMime ?? descriptor.declaredMime, descriptor.relativePath].filter(Boolean).join(' · ')}</small>
      <div role="status">{uploading ? t('intake.uploading') : t(`intake.${file.state}`)}{error ? ` · ${error}` : ''}</div>
      {file.state === 'stored' && file.stored?.kind === 'file' ? <p className={styles.note} data-testid="intake-opaque-note">{t('intake.opaqueNotice')}</p> : null}
      {uploading ? <progress max={1} value={batch.progress[file.clientFileId] ?? 0} aria-label={name} /> : null}
      <div className={styles.actions}>
       {uploading ? <button type="button" onClick={() => store.cancel(batch.id, file.clientFileId)}>{t('intake.cancel')}</button> : null}
       {!uploading && file.retryable && file.state !== 'stored' && file.state !== 'cleared' ? <>
        <button type="button" onClick={() => { void store.retry(batch.id, file.clientFileId).catch(fail); }}>{t('intake.retry')}</button>
        <label className={styles.reselect}>{t('intake.reselect')}<input type="file" onChange={event => { const selected = event.target.files?.[0]; event.target.value = ''; if (selected) void store.retry(batch.id, file.clientFileId, selected).catch(fail); }} /></label>
       </> : null}
       {file.state === 'stored' ? <a href={intakeFileDownloadUrl(batch.id, file.clientFileId, batch.target.context)} download>{t('intake.download')}</a> : null}
       {file.state === 'stored' && !project && destination.kind === 'pending' && (homeComposerVisible || onUseOnHome) ? <button type="button" disabled={homeComposerVisible && store.messageFileIds(batch.id).includes(file.clientFileId)} onClick={() => {
        store.stagePending(batch.id, file.clientFileId);
        setNotice({ text: t('intake.homeNotice').replace('{name}', name), scopeKey: batch.scopeKey });
        if (!homeComposerVisible) onUseOnHome?.();
       }}>{t(homeComposerVisible ? 'intake.attachToMessage' : 'intake.useOnHome')}</button> : null}
       {file.state === 'stored' && project ? <button type="button" disabled={writing || completed} onClick={() => { void writeToProject(); }}>{t(project.conversationId ? (completed ? 'intake.attached' : 'intake.attach') : (completed ? 'intake.addedToProject' : 'intake.addToProject'))}</button> : null}
       <button type="button" onClick={() => { void store.clear(batch.id, file.clientFileId).catch(fail); }}>{t('intake.clear')}</button>
      </div>
     </li>;
    })}</ol>
    {remaining.map((item, index) => item.scopeKey !== scopeKey ? null : <div key={index}><span>{t('intake.remaining').replace('{count}', String(item.files.length))}</span> <button type="button" onClick={() => { setRemaining(items => items.filter((_, i) => i !== index)); addRef.current(item.files, item.target, item.options); }}>{t('intake.continue')}</button> <button type="button" onClick={() => setRemaining(items => items.filter((_, i) => i !== index))}>{t('intake.dismiss')}</button></div>)}
   </div> : null}
  </aside> : null}
 </Context.Provider>;
}
