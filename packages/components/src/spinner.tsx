import type { HTMLAttributes } from 'react';

import { joinClassNames } from './class-names';
import styles from './spinner.module.css';

export type SpinnerSize = 'sm' | 'md' | 'lg';

export interface SpinnerProps extends HTMLAttributes<HTMLSpanElement> {
  size?: SpinnerSize;
  /** Accessible status text. Omit when a parent already announces the busy state. */
  label?: string;
}

/** Indeterminate activity ring. Inherits `currentColor`. */
export function Spinner({ size = 'md', label, className, ...props }: SpinnerProps) {
  return (
    <span
      role={label ? 'status' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={joinClassNames(styles.spinner, styles[size], className)}
      {...props}
    />
  );
}
