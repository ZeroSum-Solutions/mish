// The shared enlarged-preview workspace of the catalog hosts (Cult Blocks/Components, Effects,
// 21st.dev): a fixed toolbar with the Fit/Phone/Tablet/Desktop viewport buttons, an optional
// sub-bar (a family's parts), the preview stage, and a details sidebar.
//
// Sizing never feeds back into the frame. The frame's layout box is the stage size for the chosen
// width (scaled down when the width exceeds the stage); only the visible frame box follows a
// content height the frame reported, clamped to the stage. The frame's own viewport therefore
// does not change when it reports, so a document measured in viewport units cannot loop.
// Changing the width resizes the same iframe element; hosts give a new content identity (item,
// part, theme, motion, retry) a new iframe through `key`.

import { useCallback, useLayoutEffect, useState, type CSSProperties, type ReactNode, type RefCallback } from 'react';
import { useT } from '../i18n';
import type { Dict } from '../i18n/types';
import styles from './CatalogPreviewViewer.module.css';

export type CatalogPreviewWidth = 'fit' | 390 | 768 | 1280;
/** Any preview width a host offers: the catalog's own set, or another surface's (Enlarge, AC-R07.2). */
export type PreviewViewportWidth = 'fit' | number;
const WIDTHS: readonly CatalogPreviewWidth[] = ['fit', 390, 768, 1280];

/** Largest content dimension a frame may report; a larger document uses the full stage. */
export const PREVIEW_CONTENT_LIMIT = 4096;
/** Smallest visible frame box for a reported content height. */
const MIN_DISPLAY_HEIGHT = 200;

/** The labelled, pressed-state width switch. Catalog hosts use its default widths and device
 * names; another host passes its own `widths` and a `widthLabel` for each numeric width. */
export function PreviewViewportControls<W extends PreviewViewportWidth = CatalogPreviewWidth>({ value, onChange, label, testIdPrefix, widths, widthLabel }: {
  value: W;
  onChange: (value: W) => void;
  label: string;
  testIdPrefix?: string;
  widths?: readonly W[];
  widthLabel?: (width: number) => string;
}) {
  const t = useT();
  return <div className={styles.segment} role="group" aria-label={label} data-preview-viewport-controls="">
    {(widths ?? (WIDTHS as readonly PreviewViewportWidth[] as readonly W[])).map(width => <button key={width} type="button" className={styles.control}
      aria-pressed={value === width} onClick={() => onChange(width)}
      data-testid={testIdPrefix ? `${testIdPrefix}-${width}` : undefined}>
      {width === 'fit' ? t('catalog.cult.live.fit') : widthLabel ? widthLabel(width) : <>{t(`catalog.cult.live.width.${width}` as keyof Dict)} <span className={styles.widthNumber}>{width}</span></>}
    </button>)}
  </div>;
}

export function CatalogPreviewWorkspace({ toolbar, subbar, preview, details, detailsLabel, testId }: {
  toolbar: ReactNode;
  /** Optional row under the toolbar; the toolbar keeps its position whether or not it renders. */
  subbar?: ReactNode;
  preview: ReactNode;
  details: ReactNode;
  detailsLabel?: string;
  testId?: string;
}) {
  return <div className={styles.workspace} data-testid={testId}>
    <div className={styles.previewPane}>
      <div className={styles.toolbar}>{toolbar}</div>
      {subbar}
      <div className={styles.previewContent}>{preview}</div>
    </div>
    <aside className={styles.details} aria-label={detailsLabel}>{details}</aside>
  </div>;
}

export interface CatalogPreviewPart {
  /** The exact source ID of the part; copy and source actions bind to it. */
  id: string;
  /** Localized relationship label: the whole parent, an example, or a page section. */
  kind: string;
  title: string;
}

/** One labeled selector over a family's declared parts; the first part is the whole parent. */
export function PreviewPartsSelector({ label, parts, selectedId, onSelect, onPrepare, testIdPrefix }: {
  label: string;
  parts: readonly CatalogPreviewPart[];
  selectedId: string;
  onSelect: (id: string) => void;
  /** Hover/focus warm-up, such as a metadata prefetch; never loads a frame. */
  onPrepare?: (id: string) => void;
  testIdPrefix?: string;
}) {
  return <div className={styles.parts} role="group" aria-label={label}>
    <span className={styles.partsLabel} aria-hidden="true">{label}</span>
    {parts.map(part => <button key={part.id} type="button" className={styles.part}
      aria-pressed={part.id === selectedId} onClick={() => onSelect(part.id)}
      onMouseEnter={onPrepare ? () => onPrepare(part.id) : undefined} onFocus={onPrepare ? () => onPrepare(part.id) : undefined}
      title={`${part.kind} · ${part.title}`} data-part-id={part.id}
      data-testid={testIdPrefix ? `${testIdPrefix}-${part.id}` : undefined}>
      <span className={styles.partKind}>{part.kind}</span> <span className={styles.partTitle}>{part.title}</span>
    </button>)}
  </div>;
}

/**
 * The content height of a size message, or null. The caller has already checked that the message
 * came from its current frame Window with the opaque origin; this checks the shape, finite integer
 * bounds, and that the frame measured at the width it is shown at now.
 */
export function readPreviewContentSize(data: unknown, type: string, frameWidth: number): number | null {
  if (typeof data !== 'object' || data === null) return null;
  const message = data as { type?: unknown; width?: unknown; height?: unknown };
  const bounded = (value: unknown): value is number =>
    typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= PREVIEW_CONTENT_LIMIT;
  if (message.type !== type || !bounded(message.width) || !bounded(message.height)) return null;
  return message.width === frameWidth ? message.height : null;
}

/** A reported height belongs to one content identity; any other identity reads nothing. */
export function usePreviewContentHeight(contentKey: string): [number | undefined, (height: number) => void] {
  const [reported, setReported] = useState<{ key: string; height: number } | null>(null);
  const report = useCallback((height: number) => setReported({ key: contentKey, height }), [contentKey]);
  return [reported?.key === contentKey ? reported.height : undefined, report];
}

export interface CatalogPreviewStageLayout {
  stageRef: RefCallback<HTMLDivElement>;
  frameWidth: number;
  frameHeight: number;
  scale: number;
  displayHeight: number;
}

/**
 * Measure only the flexible stage. The frame box never grows past it, so the stage size does not
 * depend on the frame. The stage may mount after the hook (a dialog opened later), so measuring
 * starts whenever the stage element attaches.
 */
export function useCatalogPreviewStage(viewport: PreviewViewportWidth, contentHeight?: number): CatalogPreviewStageLayout {
  const [stage, stageRef] = useState<HTMLDivElement | null>(null);
  const [available, setAvailable] = useState({ width: 1280, height: 540 });
  useLayoutEffect(() => {
    if (!stage) return;
    const measure = () => setAvailable({ width: stage.clientWidth || 1280, height: stage.clientHeight || 540 });
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [stage]);
  const frameWidth = viewport === 'fit' ? available.width : viewport;
  const scale = Math.min(1, available.width / frameWidth);
  const frameHeight = Math.max(1, Math.round(available.height / scale));
  const measured = contentHeight !== undefined && Number.isFinite(contentHeight) && contentHeight > 0 && contentHeight <= PREVIEW_CONTENT_LIMIT
    ? contentHeight : undefined;
  const displayHeight = measured === undefined
    ? available.height
    : Math.min(available.height, Math.max(Math.min(MIN_DISPLAY_HEIGHT, available.height), Math.ceil(measured * scale)));
  return { stageRef, frameWidth, frameHeight, scale, displayHeight };
}

/** Layout attributes for the iframe inside `CatalogPreviewStage`. */
export function catalogPreviewFrameProps(layout: CatalogPreviewStageLayout): { className: string | undefined; width: number; height: number; style: CSSProperties } {
  return {
    className: styles.frame,
    width: layout.frameWidth,
    height: layout.frameHeight,
    style: { width: layout.frameWidth, height: layout.frameHeight, transform: `scale(${layout.scale})` },
  };
}

export function CatalogPreviewStage({ layout, testId, footer, children }: {
  layout: CatalogPreviewStageLayout;
  testId?: string;
  /** Status row under the stage, owned by the host (loading, timeout, retry). */
  footer?: ReactNode;
  children: ReactNode;
}) {
  return <div className={styles.canvas}>
    <div ref={layout.stageRef} className={styles.stage} data-testid={testId}>
      <div className={styles.frameBox} data-preview-frame-box=""
        style={{ width: Math.round(layout.frameWidth * layout.scale), height: layout.displayHeight }}>
        {children}
      </div>
    </div>
    {footer}
  </div>;
}
