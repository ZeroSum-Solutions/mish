import { createContext } from 'react';
import { useT } from '../../i18n';
import { PreviewViewportControls } from '../CatalogPreviewViewer';

/** AC-R07.2: the Enlarge widths. 320–1440 covers the PRD's modal range; Fit fills the dialog. */
export const ENLARGE_VIEWPORT_WIDTHS = ['fit', 320, 375, 768, 1024, 1440] as const;
export type EnlargeViewportWidth = typeof ENLARGE_VIEWPORT_WIDTHS[number];

/** The width an enlarged HTML preview lays its document out at. Compact views always fit. */
export const WorkbenchViewportContext = createContext<EnlargeViewportWidth>('fit');

/** The catalog previews' width switch (same semantics: labelled group, pressed state, plain buttons). */
export function WorkbenchViewportControls({ value, onChange }: { value: EnlargeViewportWidth; onChange: (value: EnlargeViewportWidth) => void }) {
  const t = useT();
  return <PreviewViewportControls<EnlargeViewportWidth> value={value} onChange={onChange} widths={ENLARGE_VIEWPORT_WIDTHS}
    label={t('workbench.enlarge.viewport')} widthLabel={(width) => t('workbench.enlarge.viewportWidth', { width })} testIdPrefix="workbench-enlarge-viewport" />;
}
