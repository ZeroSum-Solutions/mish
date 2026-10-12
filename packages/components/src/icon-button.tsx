import { forwardRef } from 'react';
import type { ButtonHTMLAttributes } from 'react';

import { joinClassNames } from './class-names';
import styles from './icon-button.module.css';

export type IconButtonVariant = 'ghost' | 'subtle' | 'solid' | 'glass';
export type IconButtonSize = 'sm' | 'md' | 'lg';

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label'> {
  /** Required accessible name: an icon alone is not a label. */
  label: string;
  variant?: IconButtonVariant;
  /** sm 28px · md 32px · lg 36px square hit area. */
  size?: IconButtonSize;
  /** Toggle buttons: exposes `aria-pressed` and the selected treatment. */
  pressed?: boolean;
}

/**
 * Square, icon-only action. Pass the icon as the child (16px glyphs for sm/md,
 * 18px for lg). Presses deeper than a text Button because the target is
 * smaller — the spring has to be felt.
 */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, variant = 'ghost', size = 'md', pressed, className, type = 'button', title, ...props },
  ref,
) {
  return (
    <button
      {...props}
      ref={ref}
      type={type}
      aria-label={label}
      title={title ?? label}
      aria-pressed={pressed}
      className={joinClassNames(styles.iconButton, styles[variant], styles[size], className)}
    />
  );
});
