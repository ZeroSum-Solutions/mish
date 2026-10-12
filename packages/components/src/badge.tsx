import type { HTMLAttributes } from 'react';

import { joinClassNames } from './class-names';
import styles from './badge.module.css';

export type BadgeTone = 'neutral' | 'brand' | 'success' | 'warning' | 'danger' | 'info';

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  /** Leading status dot in the tone's color. */
  dot?: boolean;
}

/** Non-interactive status or count label. Tone carries meaning; text carries the words. */
export function Badge({ tone = 'neutral', dot = false, className, children, ...props }: BadgeProps) {
  return (
    <span {...props} className={joinClassNames(styles.badge, styles[tone], className)}>
      {dot ? <span className={styles.dot} aria-hidden="true" /> : null}
      {children}
    </span>
  );
}
