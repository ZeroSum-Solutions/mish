// Live preview of one Blocks or Components row, in a modal over the Catalog tab.
//
// The modal first asks GET /api/cult/preview/:id whether the row can preview live, then loads
// GET /api/cult/preview/:id/frame in a sandboxed iframe — only while the modal is open, with a
// inline progress until it settles:
// - a section or page (`mode: 'converted'`) is the converter's static page under the build CSP;
//   its frame gets no sandbox permission at all and settles on load.
// - a primitive or app (`mode: 'harness'`) is the item's own demo from the local preview harness;
//   its frame may run script (an opaque origin, never same-origin) and settles when it posts
//   `ready`, or `error` with the reason it threw.
// A row that cannot preview live shows "Can't preview live: <reason>" with its thumbnail.
//
// The frame fits the canvas by default; explicit 390, 768 and 1280 widths scale down (the shared
// CatalogPreviewViewer workspace). A harness demo reports its content height after ready, and the
// visible frame box follows it within the stage; a converted page runs no script and keeps the
// full stage. A row with declared examples or page sections is one family: a parts selector under
// the toolbar switches between the whole row and each declared child by its exact source ID, and
// the details, state and copy actions follow the selected part. Width persists across parts.
// Light/dark shows only when the selected item supports a dark theme. Keyboard: Tab
// stays inside the modal, Esc closes it (focus returns to the card button), and the arrow keys
// move to the previous or next row of the current view. Keys typed inside the frame belong to the
// frame's own document: a harness demo forwards Esc with an `escape` message (arrow keys stay
// with the demo, which may use them), and a static page runs no script, so the hint line tells
// the person to click outside the preview first.

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Button, Dialog, DialogTitle } from '@mish/components';
import {
  cultCatalogPreviewUrl,
  cultPreviewFrameUrl,
  cultPreviewInfoUrl,
  parseCultPreviewFrameMessage,
  parseCultCatalogItemResponse,
  parseCultPreviewInfoResponse,
  type CultCatalogItem,
  type CultCatalogRelatedItem,
  type CultPreviewInfo,
  type CultPreviewTheme,
} from '@mish/contracts';

import { useT } from '../i18n';
import type { Dict } from '../i18n/types';
import { CultCopyActions } from './CultCopyActions';
import {
  CatalogPreviewStage,
  CatalogPreviewWorkspace,
  PreviewPartsSelector,
  PreviewViewportControls,
  catalogPreviewFrameProps,
  useCatalogPreviewStage,
  type CatalogPreviewWidth,
} from './CatalogPreviewViewer';
import catalogStyles from './CatalogView.module.css';
import styles from './CultLivePreview.module.css';

type InfoLoad = { kind: 'loading' } | { kind: 'failed' } | { kind: 'ready'; info: CultPreviewInfo };
type FrameState = { kind: 'loading' } | { kind: 'ready' } | { kind: 'timed-out' } | { kind: 'failed'; reason: string };

/** Every frame gets a bounded deadline, including requests that never fire load. */
export const FRAME_SETTLE_TIMEOUT_MS = 8_000;

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), iframe, [tabindex]:not([tabindex="-1"])';

const PREVIEW_CACHE_LIMIT = 32;
const PREVIEW_CACHE_TTL_MS = 5 * 60_000;
const PREFETCH_CONCURRENCY = 4;
type CachedPreview = { promise: Promise<CultPreviewInfo>; info?: CultPreviewInfo; expires: number };
// A bounded metadata cache shares hover/focus requests with the modal. Frames still load only
// inside the open dialog; no demo scripts execute during prefetch.
const previewCaches = new WeakMap<typeof fetch, Map<string, CachedPreview>>();

function previewCache(): Map<string, CachedPreview> {
  let cache = previewCaches.get(fetch);
  if (!cache) {
    cache = new Map();
    previewCaches.set(fetch, cache);
  }
  for (const [id, entry] of cache) if (entry.expires <= Date.now()) cache.delete(id);
  return cache;
}

function requestPreviewInfo(id: string, cache = previewCache()): Promise<CultPreviewInfo> {
  const cached = cache.get(id);
  if (cached) {
    cache.delete(id);
    cache.set(id, cached);
    return cached.promise;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  const entry: CachedPreview = {
    expires: Date.now() + PREVIEW_CACHE_TTL_MS,
    promise: fetch(cultPreviewInfoUrl(id), { signal: controller.signal })
      .then(async (resp) => {
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const info = parseCultPreviewInfoResponse(await resp.json()).preview;
        entry.info = info;
        return info;
      })
      .catch((error: unknown) => {
        if (cache.get(id) === entry) cache.delete(id);
        throw error;
      })
      .finally(() => clearTimeout(timer)),
  };
  cache.set(id, entry);
  if (cache.size > PREVIEW_CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  return entry.promise;
}

export function prefetchCultPreview(id: string): void {
  const cache = previewCache();
  if (cache.has(id) || [...cache.values()].filter((entry) => !entry.info).length >= PREFETCH_CONCURRENCY) return;
  void requestPreviewInfo(id, cache).catch(() => { /* Opening the dialog retries a failed prefetch. */ });
}

function cachedInfoLoad(id: string | null): InfoLoad {
  const info = id ? previewCache().get(id)?.info : undefined;
  return info ? { kind: 'ready', info } : { kind: 'loading' };
}

/** Preview metadata of one item; a result recorded for another ID never reaches this one. */
function useCultPreviewInfo(id: string | null): { load: InfoLoad; retry: () => void } {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ id: string | null; load: InfoLoad }>(() => ({ id, load: cachedInfoLoad(id) }));
  useEffect(() => {
    if (!id) return;
    let active = true;
    setState({ id, load: cachedInfoLoad(id) });
    requestPreviewInfo(id)
      .then((next) => { if (active) setState({ id, load: { kind: 'ready', info: next } }); })
      .catch(() => { if (active) setState({ id, load: { kind: 'failed' } }); });
    return () => { active = false; };
  }, [id, attempt]);
  return {
    load: state.id === id ? state.load : cachedInfoLoad(id),
    retry: () => { if (id) previewCache().delete(id); setAttempt((value) => value + 1); },
  };
}

export interface CultLivePreviewModalProps {
  /** The rows of the current view, in display order; arrows move through them. */
  items: readonly CultCatalogItem[];
  activeId: string;
  onNavigate: (id: string) => void;
  onClose: () => void;
  /** A declared child of the active row to open first, from a search match on that child. */
  initialRelatedId?: string | null;
}

type RelatedSelection = {
  parentId: string;
  related: CultCatalogRelatedItem;
  load: { kind: 'loading' } | { kind: 'failed' } | { kind: 'ready'; item: CultCatalogItem };
  attempt: number;
};

export function CultLivePreviewModal({ items, activeId, onNavigate, onClose, initialRelatedId }: CultLivePreviewModalProps) {
  const t = useT();
  const index = items.findIndex((item) => item.id === activeId);
  const parent = index >= 0 ? items[index] : undefined;
  const [relatedSelection, setRelatedSelection] = useState<RelatedSelection | null>(() => {
    const related = parent?.relatedItems?.find((entry) => entry.id === initialRelatedId);
    return related ? { parentId: activeId, related, load: { kind: 'loading' }, attempt: 0 } : null;
  });
  const [width, setWidth] = useState<CatalogPreviewWidth>('fit');
  const selection = relatedSelection?.parentId === activeId ? relatedSelection : null;
  // The selected part: the row itself, a loaded child, or nothing while a child loads or failed.
  const item = selection ? (selection.load.kind === 'ready' ? selection.load.item : null) : parent ?? null;
  const relatedId = selection?.related.id;
  const relatedAttempt = selection?.attempt;
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  // Focus moves into the modal on open and back to whatever opened it on close.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    return () => opener?.focus();
  }, []);

  useEffect(() => {
    if (!relatedId) return;
    let active = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    fetch(`/api/cult/catalog/${encodeURIComponent(relatedId)}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const next = parseCultCatalogItemResponse(await response.json()).item;
        if (next.id !== relatedId) throw new Error('Unexpected related item');
        if (active) setRelatedSelection((current) => current?.related.id === relatedId
          ? { ...current, load: { kind: 'ready', item: next } } : current);
      })
      .catch(() => {
        if (active) setRelatedSelection((current) => current?.related.id === relatedId
          ? { ...current, load: { kind: 'failed' } } : current);
      })
      .finally(() => clearTimeout(timer));
    return () => { active = false; clearTimeout(timer); controller.abort(); };
  }, [relatedId, relatedAttempt]);

  // Only a declared child of the active row can be selected; the row's own ID returns to it.
  const selectPart = (id: string) => {
    if (!parent) return;
    if (id === parent.id) {
      setRelatedSelection(null);
      return;
    }
    const related = parent.relatedItems?.find((entry) => entry.id === id);
    if (!related || selection?.related.id === id) return;
    setRelatedSelection({ parentId: activeId, related, load: { kind: 'loading' }, attempt: 0 });
  };
  const retryRelated = () => setRelatedSelection((current) => current
    ? { ...current, load: { kind: 'loading' }, attempt: current.attempt + 1 } : current);

  // A row that left the view (a filter changed underneath) closes the modal.
  useEffect(() => {
    if (!parent) onClose();
  }, [parent, onClose]);

  const go = useCallback((step: -1 | 1) => {
    if (items.length === 0 || index < 0) return;
    const next = items[(index + step + items.length) % items.length];
    if (next) {
      setRelatedSelection(null);
      onNavigate(next.id);
    }
  }, [index, items, onNavigate]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const typing = target.closest('input, textarea, select, [contenteditable="true"]') !== null;
    if (!typing && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      event.preventDefault();
      go(event.key === 'ArrowLeft' ? -1 : 1);
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])]
      .filter((el) => !el.hasAttribute('disabled') && el.getAttribute('aria-hidden') !== 'true');
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !dialogRef.current?.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !dialogRef.current?.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  };

  if (!parent) return null;
  const titleId = `cult-live-preview-title`;
  const relationLabel = (related: CultCatalogRelatedItem) => t(`catalog.cult.live.related.${related.relationship}` as keyof Dict);
  const partsBar = parent.relatedItems?.length ? (
    <PreviewPartsSelector
      label={t('catalog.cult.live.parts')}
      parts={[
        { id: parent.id, kind: t('catalog.cult.live.whole'), title: parent.displayTitle },
        ...parent.relatedItems.map((related) => ({ id: related.id, kind: relationLabel(related), title: related.title })),
      ]}
      selectedId={selection?.related.id ?? parent.id}
      onSelect={selectPart}
      onPrepare={prefetchCultPreview}
      testIdPrefix="cult-live-preview-part"
    />
  ) : null;
  // Place the overlay outside shell stacking contexts so app chrome cannot intercept it.
  return createPortal(
    <Dialog
      onClose={onClose}
      closeOnEscape
      ariaLabelledBy={titleId}
      ariaDescribedBy="cult-live-preview-hint"
      className={styles.dialog}
      data-testid="cult-live-preview"
    >
      <div ref={dialogRef} className={styles.inner} onKeyDown={onKeyDown}>
        <div className={styles.header}>
          <div className={styles.heading}>
            <DialogTitle id={titleId} className={styles.title}>{parent.displayTitle}</DialogTitle>
            {item ? <span className={catalogStyles.badge} data-state={item.state} data-testid="cult-live-preview-state">
              {t(`catalog.cult.state.${item.state}` as keyof Dict)}
            </span> : null}
            <span className={styles.position} aria-live="polite">
              {t('catalog.cult.live.position', { index: index + 1, total: items.length })}
            </span>
          </div>
          <div className={styles.nav}>
            <Button variant="secondary" className={styles.navButton} onClick={() => go(-1)} disabled={items.length < 2} data-testid="cult-live-preview-prev">
              {t('catalog.cult.live.prev')}
            </Button>
            <Button variant="secondary" className={styles.navButton} onClick={() => go(1)} disabled={items.length < 2} data-testid="cult-live-preview-next">
              {t('catalog.cult.live.next')}
            </Button>
            <button
              ref={closeRef}
              type="button"
              className={styles.close}
              aria-label={t('catalog.cult.live.close')}
              onClick={onClose}
              data-testid="cult-live-preview-close"
            >
              ×
            </button>
          </div>
        </div>
        <p id="cult-live-preview-hint" className={styles.visuallyHidden}>{t('catalog.cult.live.hint')}</p>
        <CultLivePreviewBody
          item={item}
          part={selection ? { label: `${relationLabel(selection.related)} · ${selection.related.title}`, failed: selection.load.kind === 'failed' } : null}
          onRetryPart={retryRelated}
          width={width}
          onWidthChange={setWidth}
          subbar={partsBar}
          onEscape={onClose}
        />
      </div>
    </Dialog>, document.body,
  );
}

/**
 * One workspace for the whole family, so the toolbar and parts selector stay mounted while parts
 * change. `item` is null while a selected child loads or after it failed.
 */
function CultLivePreviewBody({ item, part, onRetryPart, width, onWidthChange, subbar, onEscape }: {
  item: CultCatalogItem | null;
  part: { label: string; failed: boolean } | null;
  onRetryPart: () => void;
  width: CatalogPreviewWidth;
  onWidthChange: (width: CatalogPreviewWidth) => void;
  subbar: ReactNode;
  onEscape: () => void;
}) {
  const t = useT();
  const id = item?.id ?? null;
  const { load, retry } = useCultPreviewInfo(id);
  // Theme and retry belong to one content identity; another part starts light, on its first load.
  const [themeChoice, setThemeChoice] = useState<{ id: string | null; theme: CultPreviewTheme }>({ id, theme: 'light' });
  const [frameAttempt, setFrameAttempt] = useState<{ id: string | null; attempt: number }>({ id, attempt: 0 });
  const theme = themeChoice.id === id ? themeChoice.theme : 'light';
  const attempt = frameAttempt.id === id ? frameAttempt.attempt : 0;
  const info = item && load.kind === 'ready' ? load.info : null;
  const supportsDark = info?.live === true && info.supportsDark;

  return (
    <CatalogPreviewWorkspace
      toolbar={<>
        <PreviewViewportControls value={width} onChange={onWidthChange} label={t('catalog.cult.live.width')} testIdPrefix="cult-live-preview-width" />
        {supportsDark ? (
          <div className={styles.segment} role="group" aria-label={t('catalog.cult.live.theme')}>
            {(['light', 'dark'] as const).map((value) => (
              <button
                key={value}
                type="button"
                className={styles.control}
                aria-pressed={theme === value}
                onClick={() => setThemeChoice({ id, theme: value })}
                data-testid={`cult-live-preview-theme-${value}`}
              >
                {t(`catalog.cult.live.theme.${value}` as keyof Dict)}
              </button>
            ))}
          </div>
        ) : null}
      </>}
      subbar={subbar}
      preview={!item ? (
        part?.failed ? (
          <div className={styles.relatedError} role="alert" data-testid="cult-live-preview-part-error">
            <p className={catalogStyles.detail}>{t('catalog.cult.live.error')}</p>
            <Button variant="secondary" size="sm" onClick={onRetryPart}>{t('catalog.retry')}</Button>
          </div>
        ) : <PreviewSkeleton label={t('catalog.cult.live.loading')} />
      ) : <>
        {load.kind === 'loading' ? <PreviewSkeleton label={t('catalog.cult.live.loading')} /> : null}
        {load.kind === 'failed' ? <Unavailable item={item} reason={t('catalog.cult.live.error')} onRetry={retry} /> : null}
        {info && !info.live ? <Unavailable item={item} reason={info.reason} onRetry={retry} /> : null}
        {info && info.live ? (
          <PreviewFrame key={`${item.id}:${theme}:${attempt}`} item={item} mode={info.mode} theme={theme} width={width}
            onEscape={onEscape} onRetry={() => setFrameAttempt({ id, attempt: attempt + 1 })} />
        ) : null}
      </>}
      details={<div data-testid="cult-live-preview-details" className={styles.detailContents}>
        <h3 className={styles.detailTitle}>{t('catalog.cult.live.details')}</h3>
        {part ? <p className={styles.selectedPart} data-testid="cult-live-preview-selected-part">{part.label}</p> : null}
        {item ? <>
          <p className={catalogStyles.detail}>
            {t(`catalog.cult.assetKind.${item.assetKind}` as keyof Dict)}
            {item.sourceCategory ? ` · ${item.sourceCategory}` : ''}
          </p>
          {item.summary ? <p className={styles.summary}>{item.summary}</p> : null}
          <div className={catalogStyles.chipLine} role="group" aria-label={t('catalog.cult.spines')}>
            {item.spineAffinities.length > 0
              ? item.spineAffinities.map((spine) => (
                <span key={spine} className={catalogStyles.spine} title={t(`homeHero.spine.${spine}` as keyof Dict)}>{spine}</span>
              ))
              : null}
          </div>
          {item.tags.length > 0 ? (
            <p className={catalogStyles.tags}>
              <span className={catalogStyles.visuallyHidden}>{t('catalog.cult.tags')}: </span>
              {item.tags.map((tag) => `#${tag}`).join(' ')}
            </p>
          ) : null}
          {info?.live && info.mockNote ? <details className={styles.demoNotes}><summary>{t('catalog.cult.live.demoNotes')}</summary><p className={styles.mockNote} data-testid="cult-live-preview-mock-note">{t('catalog.cult.live.mockNote', { reason: info.mockNote })}</p></details> : null}
          <h3 className={styles.detailTitle}>{t('catalog.cult.live.use')}</h3>
          <CultCopyActions item={item} />
        </> : null}
      </div>}
    />
  );
}

function PreviewSkeleton({ label }: { label: string }) {
  return (
    <div className={styles.skeleton} role="status" aria-live="polite" data-testid="cult-live-preview-skeleton">
      <span>{label}</span>
    </div>
  );
}

function Unavailable({ item, reason, onRetry }: { item: CultCatalogItem; reason: string; onRetry?: () => void }) {
  const t = useT();
  const [imageFailed, setImageFailed] = useState(false);
  return (
    <div className={styles.unavailable} role="status" data-testid="cult-live-preview-unavailable">
      <p className={styles.reason}>{t('catalog.cult.live.unavailable', { reason })}</p>
      {onRetry ? <Button variant="secondary" className={styles.navButton} onClick={onRetry}>{t('catalog.retry')}</Button> : null}
      {item.preview.kind === 'image' && !imageFailed ? (
        <img
          className={styles.thumbnail}
          src={cultCatalogPreviewUrl(item.id, item.preview.revision)}
          alt={t('catalog.cult.previewAlt', { title: item.displayTitle })}
          width={480}
          height={300}
          onErrorCapture={() => setImageFailed(true)}
        />
      ) : null}
    </div>
  );
}

/** One content identity (item, theme, retry); the host keys it, so each identity is a new iframe. */
function PreviewFrame({ item, mode, theme, width, onEscape, onRetry }: {
  item: CultCatalogItem;
  mode: CultPreviewInfo['mode'];
  theme: CultPreviewTheme;
  width: CatalogPreviewWidth;
  onEscape: () => void;
  onRetry: () => void;
}) {
  const t = useT();
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [state, setState] = useState<FrameState>({ kind: 'loading' });
  const [contentHeight, setContentHeight] = useState<number | undefined>();
  const layout = useCatalogPreviewStage(width, contentHeight);
  const { frameWidth } = layout;
  const src = useMemo(() => cultPreviewFrameUrl(item.id, theme), [item.id, theme]);

  useEffect(() => {
    if (mode !== 'harness') return;
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow || event.origin !== 'null') return;
      const message = parseCultPreviewFrameMessage(event.data);
      if (!message) return;
      // A height measured at another width describes another layout; the frame re-reports on resize.
      if (message.type === 'size') {
        if (message.width === frameWidth) setContentHeight(message.height);
        return;
      }
      // Esc pressed inside the demo never reaches this document; the harness forwards it.
      if (message.type === 'escape') {
        onEscape();
        return;
      }
      setState((current) => current.kind === 'failed' ? current
        : message.type === 'ready' ? { kind: 'ready' } : { kind: 'failed', reason: message.reason });
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [mode, onEscape, frameWidth]);

  // Start before load: a stalled document request must not leave the UI pending forever.
  useEffect(() => {
    if (state.kind !== 'loading') return;
    const timer = window.setTimeout(() => {
      setState((current) => current.kind === 'loading'
        ? { kind: 'timed-out' } : current);
    }, FRAME_SETTLE_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [state.kind, t]);

  const onLoad = () => {
    if (mode === 'converted') setState((current) => current.kind === 'failed' ? current : { kind: 'ready' });
  };

  if (state.kind === 'failed') return <Unavailable item={item} reason={state.reason} onRetry={onRetry} />;
  return (
    <CatalogPreviewStage
      layout={layout}
      testId="cult-live-preview-stage"
      footer={<div className={styles.canvasStatus} role="status" aria-live="polite">{state.kind === 'loading' ? <span data-testid="cult-live-preview-skeleton">{t('catalog.cult.live.loading')}</span> : state.kind === 'timed-out' ? <><span data-testid="cult-live-preview-timeout">{t('catalog.cult.live.timeout')}</span><button type="button" className={styles.navButton} onClick={onRetry}>{t('catalog.retry')}</button></> : <span>{frameWidth} px · {t(`catalog.cult.live.theme.${theme}` as keyof Dict)}</span>}</div>}
    >
      <iframe
        ref={frameRef}
        {...catalogPreviewFrameProps(layout)}
        title={t('catalog.cult.live.frameTitle', { title: item.displayTitle })}
        src={src}
        // A converted page runs no script; a harness demo runs script in an opaque origin.
        sandbox={mode === 'harness' ? 'allow-scripts' : ''}
        referrerPolicy="no-referrer"
        loading="eager"
        onLoad={onLoad}
        onErrorCapture={() => setState({ kind: 'failed', reason: t('catalog.cult.live.error') })}
        data-testid="cult-live-preview-frame"
        data-mode={mode}
      />
    </CatalogPreviewStage>
  );
}
