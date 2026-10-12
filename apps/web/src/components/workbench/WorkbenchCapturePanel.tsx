import { useCallback, useEffect, useRef, useState, type ClipboardEvent } from 'react';
import { Button } from '@mish/components';
import { WORKBENCH_CAPTURE_MEDIA_TYPES, type CaptureView, type WorkbenchCaptureMode, type WorkspaceCollabContext } from '@mish/contracts';
import { useT } from '../../i18n';
import { workspaceResourceUrl } from '../../collab/workspace-identity';
import { captureApi } from '../../providers/workbench-capture';
import { displayCaptureSupported, grabDisplayFrame, readImageFrame } from './capture-image';
import { WorkbenchCaptureSaveDialog, type PendingCapture } from './WorkbenchCaptureSaveDialog';
import styles from './WorkbenchCapture.module.css';

const ACCEPT = WORKBENCH_CAPTURE_MEDIA_TYPES.join(',');

/**
 * AC-R14.1 web canvas: upload, paste or permission-granted screen capture,
 * saved as immutable captures; saved captures are listed again after a reload
 * or daemon restart so work resumes from them.
 */
export function WorkbenchCapturePanel({ projectId, workspaceContext, onOpenDraft }: { projectId: string; workspaceContext?: WorkspaceCollabContext | null; onOpenDraft?: (capture: CaptureView) => void }) {
  const t = useT();
  const modeLabel: Record<WorkbenchCaptureMode, string> = {
    'native-page': t('workbench.capture.mode.native-page'), 'native-region': t('workbench.capture.mode.native-region'),
    upload: t('workbench.capture.mode.upload'), paste: t('workbench.capture.mode.paste'), 'screen-share': t('workbench.capture.mode.screen-share'),
  };
  const [captures, setCaptures] = useState<CaptureView[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [reload, setReload] = useState(0);
  const [pending, setPending] = useState<PendingCapture | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [alert, setAlert] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const scope = useRef(projectId); scope.current = projectId;
  const screenSupported = displayCaptureSupported();

  useEffect(() => {
    let live = true;
    setLoadState('loading');
    captureApi.list(projectId, workspaceContext).then(list => {
      if (!live) return;
      setCaptures(list.captures); setNextCursor(list.nextCursor); setLoadState('ready');
    }).catch(() => { if (live) setLoadState('error'); });
    return () => { live = false; };
  }, [projectId, workspaceContext, reload]);

  const stage = useCallback(async (image: Blob, mode: PendingCapture['mode']) => {
    setAlert(null); setNotice(null);
    if (/^image\/hei[cf](?:-sequence)?$/iu.test(image.type) || (image instanceof File && /\.(?:heic|heif)$/iu.test(image.name))) {
      setAlert(t('workbench.capture.heifUnsupported')); return;
    }
    if (!(WORKBENCH_CAPTURE_MEDIA_TYPES as readonly string[]).includes(image.type)) { setAlert(t('workbench.capture.readFailed')); return; }
    try {
      const frame = await readImageFrame(image);
      setPending({ image, frame, mode, viewport: null });
    } catch { setAlert(t('workbench.capture.readFailed')); }
  }, [t]);

  async function captureScreen() {
    setAlert(null); setNotice(null); setBusy(true);
    try {
      const frame = await grabDisplayFrame();
      setPending({ image: frame.blob, frame: { width: frame.width, height: frame.height }, mode: 'screen-share', viewport: { width: frame.width, height: frame.height, deviceScaleFactor: 1 } });
    } catch (failure) {
      const name = failure instanceof Error ? failure.name : '';
      setAlert(name === 'NotAllowedError' || name === 'AbortError' ? t('workbench.capture.screenDenied') : t('workbench.capture.screenFailed', { message: failure instanceof Error ? failure.message : String(failure) }));
    } finally { setBusy(false); }
  }

  function onPaste(event: ClipboardEvent<HTMLElement>) {
    const file = Array.from(event.clipboardData?.files ?? []).find(item => item.type.startsWith('image/'))
      ?? Array.from(event.clipboardData?.items ?? []).find(item => item.kind === 'file' && item.type.startsWith('image/'))?.getAsFile();
    if (!file) return;
    event.preventDefault();
    void stage(file, 'paste');
  }

  async function loadMore() {
    if (!nextCursor) return;
    try {
      const page = await captureApi.list(projectId, workspaceContext, nextCursor);
      setCaptures(current => [...current, ...page.captures]); setNextCursor(page.nextCursor);
    } catch { setLoadState('error'); }
  }

  return <section className={styles.panel} aria-label={t('workbench.captureHub.captures')} data-testid="workbench-capture-panel">
    <p className={styles.hint}>{t('workbench.capture.crossOrigin')}</p>
    <p className={styles.hint}>{t('workbench.capture.metadataPrivacy')}</p>
    <div className={styles.sources}>
      <label className={styles.upload}>
        <span>{t('workbench.capture.upload')}</span>
        <input type="file" accept={ACCEPT} aria-label={t('workbench.capture.upload')} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void stage(file, 'upload'); }} />
      </label>
      <Button type="button" size="sm" disabled={!screenSupported || busy} onClick={() => void captureScreen()}>{t('workbench.capture.screen')}</Button>
    </div>
    {!screenSupported ? <p className={styles.hint}>{t('workbench.capture.screenUnsupported')}</p> : null}
    <div className={styles.pasteZone} tabIndex={0} role="textbox" aria-label={t('workbench.capture.pasteZone')} aria-multiline="false" onPaste={onPaste} data-testid="workbench-capture-paste">{t('workbench.capture.pasteZone')}</div>
    {alert ? <p role="alert" className={styles.error}>{alert}</p> : null}
    {notice ? <p role="status" className={styles.success}>{notice}</p> : null}
    {loadState === 'error' ? <div role="alert" className={styles.error}>{t('workbench.capture.loadError')} <Button size="sm" onClick={() => setReload(n => n + 1)}>{t('workbench.capture.retry')}</Button></div> : null}
    {loadState === 'ready' && captures.length === 0 ? <p className={styles.hint}>{t('workbench.capture.empty')}</p> : null}
    <ul className={styles.list}>
      {captures.map(view => <li key={view.capture.id} className={styles.item} data-testid="workbench-capture-item">
        {view.bytesAvailable ? <img className={styles.thumb} src={workspaceResourceUrl(view.imageUrl, workspaceContext)} alt={view.capture.sourceTitle ?? view.capture.sourceUrl ?? modeLabel[view.capture.captureMode]} loading="lazy" /> : <span className={styles.thumbMissing}>{t('workbench.capture.bytesRemoved')}</span>}
        <div className={styles.meta}>
          <strong>{view.capture.sourceTitle ?? modeLabel[view.capture.captureMode]}</strong>
          <span className={styles.url}>{view.capture.sourceUrl ?? t('workbench.capture.noSource')}</span>
          <span>{modeLabel[view.capture.captureMode]} · {view.capture.viewport ? t('workbench.capture.viewport', { width: view.capture.viewport.width, height: view.capture.viewport.height, scale: view.capture.viewport.deviceScaleFactor }) : t('workbench.capture.noViewport')}</span>
          <time dateTime={view.capture.createdAt}>{new Date(view.capture.createdAt).toLocaleString()}</time>
          {onOpenDraft ? <Button size="sm" onClick={() => onOpenDraft(view)}>{t('workbench.draft.openCapture')}</Button> : null}
        </div>
      </li>)}
    </ul>
    {nextCursor ? <Button size="sm" onClick={() => void loadMore()}>{t('workbench.capture.loadMore')}</Button> : null}
    {pending ? <WorkbenchCaptureSaveDialog projectId={projectId} workspaceContext={workspaceContext} pending={pending} onClose={() => setPending(null)} onSaved={view => {
      if (scope.current !== projectId) return;
      setPending(null); setNotice(t('workbench.capture.saved'));
      setCaptures(current => [view, ...current.filter(item => item.capture.id !== view.capture.id)]);
    }} /> : null}
  </section>;
}
