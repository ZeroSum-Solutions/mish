import { forwardRef } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

import { joinClassNames } from './class-names';
import styles from './chip.module.css';

export type ChipSize = 'sm' | 'md';

export interface ChipProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /**
   * Toggle state. Pass a boolean (`true` or `false`) for filter and toggle
   * chips so assistive tech hears `aria-pressed` on every chip in the group;
   * leave it undefined only for plain action chips (suggestions).
   */
  selected?: boolean;
  /** Leading glyph, 14px. */
  icon?: ReactNode;
  /** Trailing glyph (chevron, count, close). */
  trailing?: ReactNode;
  /** sm 24px · md 32px tall. */
  size?: ChipSize;
}

/** Pill-shaped filter, mode or suggestion toggle. */
export const Chip = forwardRef<HTMLButtonElement, ChipProps>(function Chip(
  { selected, icon, trailing, size = 'md', className, type = 'button', children, ...props },
  ref,
) {
  return (
    <button
      {...props}
      ref={ref}
      type={type}
      aria-pressed={selected}
      className={joinClassNames(styles.chip, styles[size], className)}
    >
      {icon ? <span className={styles.icon} aria-hidden="true">{icon}</span> : null}
      {children}
      {trailing ? <span className={styles.trailing}>{trailing}</span> : null}
    </button>
  );
});
