import { forwardRef } from 'react';
import type { ButtonHTMLAttributes, HTMLAttributes } from 'react';

import { joinClassNames } from './class-names';
import styles from './preview-card.module.css';

export interface PreviewCardProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  selected?: boolean;
  pending?: boolean;
}

/** A thumbnail selection button. Put independent actions beside it, never inside it. */
export const PreviewCard = forwardRef<HTMLButtonElement, PreviewCardProps>(function PreviewCard(
  { className, type = 'button', selected, pending = false, ...props }, ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={joinClassNames(styles.card, className)}
      aria-pressed={selected}
      aria-busy={pending || undefined}
      data-selected={selected || undefined}
      data-pending={pending || undefined}
      {...props}
    />
  );
});

export const PreviewCardMedia = forwardRef<HTMLSpanElement, HTMLAttributes<HTMLSpanElement>>(
  function PreviewCardMedia({ className, ...props }, ref) {
    return <span ref={ref} className={joinClassNames(styles.media, className)} aria-hidden {...props} />;
  },
);

export function PreviewCardCaption({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return <span className={joinClassNames(styles.caption, className)} {...props} />;
}

export function PreviewCardTitle({ className, children, title, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={joinClassNames(styles.title, className)}
      title={title ?? (typeof children === 'string' ? children : undefined)}
      {...props}
    >{children}</span>
  );
}

export function PreviewCardDescription({ className, children, title, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={joinClassNames(styles.description, className)}
      title={title ?? (typeof children === 'string' ? children : undefined)}
      {...props}
    >{children}</span>
  );
}
