import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Dialog, DialogTitle } from '@open-design/components';
import { genuiCatalogPreviewUrl, type GenuiCatalogEntry } from '@open-design/contracts';
import { useT } from '../i18n';
import type { Dict } from '../i18n/types';
import styles from './CultLivePreview.module.css';
import catalogStyles from './CatalogView.module.css';
import {
  CatalogPreviewStage,
  CatalogPreviewWorkspace,
  PreviewViewportControls,
  catalogPreviewFrameProps,
  readPreviewContentSize,
  useCatalogPreviewStage,
  usePreviewContentHeight,
  type CatalogPreviewWidth,
} from './CatalogPreviewViewer';

/** The served effect document's size bridge (apps/daemon/src/routes/effect-preview-document.ts). */
const EFFECT_PREVIEW_SIZE_MESSAGE = 'mishh-effect-preview-size';

/** Fit a real viewport into the available catalog stage without changing its layout. */
export function usePreviewScale(width: number, maxScale = 1) {
  const ref = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState(width);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => setAvailable(node.clientWidth || width);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [width]);
  return { ref, scale: Math.min(maxScale, available / width) };
}

export function EffectPreview({ entry, initialReducedMotion, onClose }: {
  entry: GenuiCatalogEntry; initialReducedMotion: boolean; onClose: () => void;
}) {
  const t = useT();
  const [width, setWidth] = useState<CatalogPreviewWidth>('fit');
  const [reducedMotion, setReducedMotion] = useState(initialReducedMotion);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const motionRef = useRef<HTMLInputElement>(null);
  // The reduced-motion choice reloads a new document; each document is its own frame and height.
  const src = genuiCatalogPreviewUrl(entry.id, reducedMotion);
  const [contentHeight, reportHeight] = usePreviewContentHeight(src);
  const layout = useCatalogPreviewStage(width, contentHeight);
  const { frameWidth } = layout;

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const onFocus = (event: FocusEvent) => {
      if (event.target instanceof Node && !dialogRef.current?.contains(event.target)) closeRef.current?.focus();
    };
    document.addEventListener('focusin', onFocus);
    return () => {
      document.removeEventListener('focusin', onFocus);
      opener?.focus();
    };
  }, []);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow || event.origin !== 'null') return;
      const height = readPreviewContentSize(event.data, EFFECT_PREVIEW_SIZE_MESSAGE, frameWidth);
      if (height !== null) reportHeight(height);
      else if (event.data?.type === 'mishh-effect-preview-escape') onClose();
      else if (event.data?.type === 'mishh-effect-preview-tab' && typeof event.data.backward === 'boolean') {
        if (event.data.backward) motionRef.current?.focus();
        else closeRef.current?.focus();
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [onClose, frameWidth, reportHeight]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab') return;
    const nodes = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button, input, iframe') ?? [])];
    const first = nodes[0];
    const last = nodes.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  };

  // Same overlay placement as the Cult viewer: outside shell stacking contexts, above app chrome.
  return createPortal(
    <Dialog onClose={onClose} closeOnEscape ariaLabelledBy="effect-preview-title" ariaDescribedBy="effect-preview-hint" className={styles.dialog}>
      <div className={styles.inner} ref={dialogRef} onKeyDown={onKeyDown}>
        <div className={styles.header}>
          <div className={styles.heading}>
            <DialogTitle id="effect-preview-title" className={styles.title}>{entry.name}</DialogTitle>
          </div>
          <div className={styles.nav}>
            <button ref={closeRef} type="button" className={styles.close} aria-label={t('catalog.cult.live.close')} onClick={onClose}>×</button>
          </div>
        </div>
        <CatalogPreviewWorkspace
          toolbar={<>
            <PreviewViewportControls value={width} onChange={setWidth} label={t('catalog.cult.live.width')} />
            <label className={catalogStyles.toggle}>
              <input ref={motionRef} type="checkbox" checked={reducedMotion} onChange={(event) => setReducedMotion(event.target.checked)} data-testid="effect-preview-reduced-motion" />
              {t('catalog.reducedMotion')}
            </label>
          </>}
          preview={<CatalogPreviewStage layout={layout} testId="effect-preview-stage">
            <iframe key={src} ref={frameRef} {...catalogPreviewFrameProps(layout)} title={t('catalog.demoTitle', { name: entry.name })}
              sandbox="allow-scripts" referrerPolicy="no-referrer" src={src} data-testid="effect-preview-frame" />
          </CatalogPreviewStage>}
          details={<div className={styles.detailContents} data-testid="effect-preview-details">
            <h3 className={styles.detailTitle}>{t('catalog.cult.live.details')}</h3>
            <p id="effect-preview-hint">{t('catalog.effect.previewHint')}</p>
            <p>{t(`catalog.category.${entry.category}` as keyof Dict)} · {t(entry.status === 'ported' ? 'catalog.status.ported' : 'catalog.status.planned')}{entry.tier ? ` · ${t('catalog.tier', { tier: entry.tier })}` : ''}</p>
            <p>{t('catalog.source', { source: `${entry.source.name} ${entry.source.component}` })}</p>
            <p>{t('catalog.licence', { licence: t(`catalog.licence.${entry.licenceDecision}` as keyof Dict) })}{entry.source.license ? ` (${entry.source.license})` : ''}</p>
          </div>}
        />
      </div>
    </Dialog>, document.body,
  );
}
