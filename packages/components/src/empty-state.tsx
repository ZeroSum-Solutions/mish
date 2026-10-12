import type { HTMLAttributes, ReactNode } from 'react';

import { joinClassNames } from './class-names';
import styles from './empty-state.module.css';

export type EmptyStateVariant = 'panel' | 'plain';

export interface EmptyStateProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  /** One line that says what is empty, at the title role. */
  title: ReactNode;
  /** Optional supporting sentence; keep it short (it wraps at 46ch). */
  description?: ReactNode;
  /** Optional 20px glyph, shown in a quiet tile above the title. */
  icon?: ReactNode;
  /** The one action that moves the user on (docs/design/ui-system.md § 7). */
  action?: ReactNode;
  /**
   * `panel` (default) draws the page-level empty panel: hairline border,
   * panel fill, generous inset. `plain` drops the chrome for empty states
   * that already sit inside a drawer, card or popover.
   */
  variant?: EmptyStateVariant;
}

/** One designed empty state: a mark, one line, an optional sentence and one action. */
export function EmptyState({
  title,
  description,
  icon,
  action,
  variant = 'panel',
  className,
  ...props
}: EmptyStateProps) {
  return (
    <div {...props} className={joinClassNames(styles.root, styles[variant], className)}>
      {icon ? <span className={styles.mark} aria-hidden="true">{icon}</span> : null}
      <p className={styles.title}>{title}</p>
      {description ? <p className={styles.description}>{description}</p> : null}
      {action ? <div className={styles.action}>{action}</div> : null}
    </div>
  );
}
