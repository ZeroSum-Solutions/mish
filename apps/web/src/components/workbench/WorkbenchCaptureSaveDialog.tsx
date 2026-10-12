import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { Button, Dialog, DialogBody, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input } from '@mish/components';
import type { CaptureImportMetadata, CaptureView, WorkbenchCaptureMode, WorkspaceCollabContext } from '@mish/contracts';
import { useT } from '../../i18n';
import { captureApi } from '../../providers/workbench-capture';
import { cropImage, regionInside, type CaptureRegion } from './capture-image';
import { EMPTY_RIGHTS, rightsDeclarationFor, WorkbenchRightsFields, type RightsDraft } from './WorkbenchRightsFields';
import styles from './WorkbenchCapture.module.css';

export interface PendingCapture {
  image: Blob;
  /** Pixel size of the whole frame. */
  frame: { width: number; height: number };
  /** Mode of the whole frame; a desktop page becomes a desktop region when cropped. */
  mode: Extract<WorkbenchCaptureMode, 'native-page' | 'upload' | 'paste' | 'screen-share'>;
  viewport: CaptureImportMetadata['viewport'] | null;
  sourceUrl?: string | null;
  sourceTitle?: string | null;
}

/**
 * Review one captured image before it is stored: optional region, source URL
 * and rights declaration. Saving sends the image bytes to the same endpoint as
 * `od workbench capture import`; the record is then immutable.
 */
export function WorkbenchCaptureSaveDialog({ projectId, workspaceContext, pending, onClose, onSaved }: {
  projectId: string; workspaceContext?: WorkspaceCollabContext | null; pending: PendingCapture;
  onClose: () => void; onSaved: (view: CaptureView) => void;
}) {
  const t = useT();
  const previewUrl = useMemo(() => (typeof URL.createObjectURL === 'function' ? URL.createObjectURL(pending.image) : null), [pending.image]);
  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);
  const native = pending.mode === 'native-page';
  const [sourceUrl, setSourceUrl] = useState(pending.sourceUrl ?? '');
  const [useRegion, setUseRegion] = useState(false);
  const [region, setRegion] = useState<CaptureRegion>({ x: 0, y: 0, width: pending.frame.width, height: pending.frame.height });
  const [rights, setRights] = useState<RightsDraft>(EMPTY_RIGHTS);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // One key per reviewed capture, so a retry after a lost response cannot store it twice.
  const [idempotencyKey] = useState(() => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `web-${Date.now()}`));

  // The dialog renders over the page, outside any menu that opened it. Escape
  // closes only this dialog: the capture-phase listener keeps the key from
  // also dismissing the menu underneath.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      event.stopPropagation(); event.preventDefault();
      onClose();
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const setEdge = (key: keyof CaptureRegion) => (value: string) => setRegion(current => ({ ...current, [key]: Number.parseInt(value, 10) || 0 }));

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (saving) return;
    if (useRegion && !regionInside(region, pending.frame)) { setError(t('workbench.capture.regionInvalid', { width: pending.frame.width, height: pending.frame.height })); return; }
    setSaving(true); setError(null);
    try {
      const image = useRegion ? await cropImage(pending.image, region) : pending.image;
      const declaration = rightsDeclarationFor(rights);
      const metadata: CaptureImportMetadata = {
        projectId,
        captureMode: useRegion && native ? 'native-region' : pending.mode,
        frame: pending.frame,
        ...(sourceUrl.trim() ? { sourceUrl: sourceUrl.trim() } : {}),
        ...(pending.sourceTitle ? { sourceTitle: pending.sourceTitle.slice(0, 300) } : {}),
        viewport: pending.viewport ?? null,
        region: useRegion ? region : null,
        ...(declaration ? { rightsDeclaration: declaration } : {}),
      };
      onSaved(await captureApi.save(image, metadata, workspaceContext, `${idempotencyKey}-${useRegion ? `${region.x}.${region.y}.${region.width}.${region.height}` : 'frame'}`));
    } catch (failure) {
      setError(t('workbench.capture.saveFailed', { message: failure instanceof Error ? failure.message : String(failure) }));
    } finally { setSaving(false); }
  }

  const dialog = <Dialog as="form" onSubmit={submit} onClose={onClose} closeOnBackdrop={false} ariaLabel={t('workbench.capture.saveTitle')} layout="sectioned" className={styles.dialog} data-testid="workbench-capture-save">
    <DialogHeader><DialogTitle>{t('workbench.capture.saveTitle')}</DialogTitle><DialogDescription>{t('workbench.capture.saveDescription')}</DialogDescription></DialogHeader>
    <DialogBody className={styles.dialogBody}>
      {previewUrl ? <img className={styles.previewImage} src={previewUrl} alt={t('workbench.capture.preview')} /> : null}
      <p className={styles.hint}>{pending.frame.width} × {pending.frame.height}{pending.viewport ? ` · ${t('workbench.capture.viewport', { width: pending.viewport.width, height: pending.viewport.height, scale: pending.viewport.deviceScaleFactor })}` : ''}</p>
      <label className={styles.field}>{t('workbench.capture.sourceUrl')}<Input type="url" inputMode="url" value={sourceUrl} onChange={event => setSourceUrl(event.target.value)} /></label>
      <p className={styles.hint}>{t('workbench.capture.sourceUrlNote')}</p>
      <label className={styles.inline}><input type="checkbox" checked={useRegion} onChange={event => setUseRegion(event.target.checked)} />{t('workbench.capture.region')}</label>
      {useRegion ? <div className={styles.regionGrid}>
        <label className={styles.field}>{t('workbench.capture.regionLeft')}<Input type="number" min={0} value={region.x} onChange={event => setEdge('x')(event.target.value)} /></label>
        <label className={styles.field}>{t('workbench.capture.regionTop')}<Input type="number" min={0} value={region.y} onChange={event => setEdge('y')(event.target.value)} /></label>
        <label className={styles.field}>{t('workbench.capture.regionWidth')}<Input type="number" min={1} value={region.width} onChange={event => setEdge('width')(event.target.value)} /></label>
        <label className={styles.field}>{t('workbench.capture.regionHeight')}<Input type="number" min={1} value={region.height} onChange={event => setEdge('height')(event.target.value)} /></label>
      </div> : null}
      <WorkbenchRightsFields value={rights} onChange={setRights} disabled={saving} />
      {error ? <p role="alert" className={styles.error}>{error}</p> : null}
    </DialogBody>
    <DialogFooter>
      <Button type="button" variant="ghost" onClick={onClose}>{t('workbench.capture.cancel')}</Button>
      <Button type="submit" disabled={saving} aria-busy={saving}>{saving ? t('workbench.capture.saving') : t('workbench.capture.save')}</Button>
    </DialogFooter>
  </Dialog>;
  // Menus that host the opener keep themselves open while this wrapper exists.
  const retained = <div data-workbench-retained="true" data-workbench-expanded="true">{dialog}</div>;
  return typeof document === 'undefined' ? retained : createPortal(retained, document.body);
}
