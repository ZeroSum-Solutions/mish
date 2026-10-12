import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Button } from '@open-design/components';
import { useT } from '../../i18n';
import styles from './workbench.module.css';

const MIN_ZOOM = 1;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.5;
const PAN_STEP = 40;

/** Images are rendered directly as <img>. The referenced bytes carry no script
 * execution risk here, unlike the HTML adapter's srcDoc path, so no sandbox is needed. */
export function WorkbenchImageZoom({ title, url }: { title: string; url: string }) {
  const t = useT();
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [attempt, setAttempt] = useState(0);
  const [zoom, setZoom] = useState(MIN_ZOOM);
  const surfaceRef = useRef<HTMLDivElement>(null);
  // A new url or retry restarts the load. Reset during render, not in the
  // effect below: a cached image can fire onLoad before passive effects run,
  // and a reset there would overwrite that 'ready' with 'loading' (and the
  // timeout would then report a loaded image as failed).
  const loadKey = `${attempt}:${url}`;
  const [loadedKey, setLoadedKey] = useState(loadKey);
  if (loadedKey !== loadKey) {
    setLoadedKey(loadKey); setState('loading'); setZoom(MIN_ZOOM);
  }
  useEffect(() => {
    // A stalled connection never fires onLoad/onError; without this the panel
    // would show "Loading preview…" forever with no Retry affordance. Matches
    // WorkbenchHtmlPreview's existing 8-second mount timeout.
    const timeout = window.setTimeout(() => setState((current) => current === 'loading' ? 'error' : current), 8000);
    return () => window.clearTimeout(timeout);
  }, [url, attempt]);
  // Once zoomed past the viewport, the image overflows the surface's native
  // scroll bounds; a mouse drag on the scrollbar was the only way to pan it.
  // Arrow keys now pan the focused region directly, matching that same
  // native scroll affordance for anyone who cannot or does not use a mouse.
  function pan(event: KeyboardEvent<HTMLDivElement>) {
    const node = surfaceRef.current;
    if (!node) return;
    switch (event.key) {
      case 'ArrowDown': node.scrollTop += PAN_STEP; break;
      case 'ArrowUp': node.scrollTop -= PAN_STEP; break;
      case 'ArrowRight': node.scrollLeft += PAN_STEP; break;
      case 'ArrowLeft': node.scrollLeft -= PAN_STEP; break;
      default: return;
    }
    event.preventDefault();
  }
  return <div className={styles.media} data-preview-state={state} data-testid="workbench-image-zoom">
    <div ref={surfaceRef} className={styles.zoomSurface} tabIndex={0} role="region" aria-label={t('workbench.enlarge.zoomLevel')} onKeyDown={pan}>
      {/* key forces a fresh element so a prior error/onload does not linger across retries */}
      <img key={attempt} src={url} alt={title} className={styles.zoomImage} style={{ transform: `scale(${zoom})` }}
        onLoad={() => setState('ready')} onError={() => setState('error')} />
    </div>
    {state === 'ready' ? <div className={styles.zoomControls} role="group" aria-label={t('workbench.enlarge.zoomLevel')}>
      <Button size="sm" onClick={() => setZoom((value) => Math.max(MIN_ZOOM, value - ZOOM_STEP))} disabled={zoom <= MIN_ZOOM}>{t('workbench.enlarge.zoomOut')}</Button>
      <span aria-live="polite">{Math.round(zoom * 100)}%</span>
      <Button size="sm" onClick={() => setZoom((value) => Math.min(MAX_ZOOM, value + ZOOM_STEP))} disabled={zoom >= MAX_ZOOM}>{t('workbench.enlarge.zoomIn')}</Button>
    </div> : null}
    {state !== 'ready' ? <div className={styles.status} role={state === 'loading' ? 'status' : 'alert'}>
      <span>{t(state === 'loading' ? 'workbench.previewLoading' : 'workbench.enlarge.imageError')}</span>
      {state === 'error' ? <Button size="sm" onClick={() => setAttempt((n) => n + 1)}>{t('preview.retry')}</Button> : null}
    </div> : null}
  </div>;
}
