import type { ReactNode } from 'react';
import { Button } from '@open-design/components';
import { Icon } from '../Icon';
import styles from './ResponsiveComposerToolbar.module.css';

/** Hosts supply the secondary tools, model picker and send action as children.
 * Home can adopt this row and the container class without changing chat state. */
export function ResponsiveComposerToolbar({ children }: { children: ReactNode }) {
  return <div className={`composer-row ${styles.toolbar}`} data-testid="composer-toolbar">{children}</div>;
}

export function ComposerImproveButton({ label, disabled, onClick }: { label: string; disabled: boolean; onClick(): void }) {
  return <Button type="button" size="sm" variant="ghost" className={`${styles.improve} od-tooltip`} aria-label={label} title={label} data-tooltip={label} data-testid="improve-prompt-button" disabled={disabled} onClick={onClick}>
    <span className={styles.improveGlyph} aria-hidden="true"><Icon name="sparkles" size={16} /></span>
    <span className={styles.improveLabel}>{label}</span>
  </Button>;
}
