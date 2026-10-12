import { useId, useState } from 'react';
import type { HTMLAttributes, MouseEvent, ReactNode } from 'react';

import { joinClassNames } from './class-names';
import { IconButton } from './icon-button';
import styles from './disclosure-row.module.css';

export interface DisclosureRowProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  /** Row name, at the list-row title role. */
  title: ReactNode;
  /** One supporting line under the title; truncates to a single line. */
  description?: ReactNode;
  /** Optional icon or logo before the title. */
  leading?: ReactNode;
  /** Glanceable state, usually a `Badge`. */
  status?: ReactNode;
  /** The row's always-visible action(s); keep it to one primary action. */
  actions?: ReactNode;
  /**
   * Accessible name of the expand toggle (for example "HiggsField details").
   * Required when the row has `children`.
   */
  detailsLabel?: string;
  /** Controlled open state. */
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Details shown when the row expands: explanatory copy, fields, secondary actions. */
  children?: ReactNode;
}

const INTERACTIVE = 'button, a, input, select, textarea, label, [role="button"], [role="link"]';

/**
 * One compact list row — name, status and one action at a glance — that
 * expands in place to show the details. Rows stack inside a list container
 * (a `Surface`) and draw their own hairline separators. The details stay
 * mounted so the collapse can animate; collapsed details are hidden from
 * keyboard and assistive technology.
 */
export function DisclosureRow({
  title,
  description,
  leading,
  status,
  actions,
  detailsLabel,
  open,
  defaultOpen = false,
  onOpenChange,
  children,
  className,
  ...props
}: DisclosureRowProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const expanded = open ?? uncontrolledOpen;
  const baseId = useId();
  const titleId = `${baseId}-title`;
  const bodyId = `${baseId}-details`;
  const hasDetails = children !== undefined && children !== null && children !== false;

  const setExpanded = (next: boolean) => {
    if (open === undefined) setUncontrolledOpen(next);
    onOpenChange?.(next);
  };

  // A click on the row's empty space toggles it too (mouse convenience); the
  // toggle button stays the keyboard and assistive-technology control.
  const onHeaderClick = (event: MouseEvent<HTMLDivElement>) => {
    if (!hasDetails) return;
    const target = event.target as Element;
    if (target.closest(INTERACTIVE)) return;
    setExpanded(!expanded);
  };

  return (
    <div
      {...props}
      className={joinClassNames(styles.row, expanded && hasDetails && styles.open, leading ? styles.hasLeading : undefined, className)}
      data-open={hasDetails ? String(expanded) : undefined}
    >
      <div className={joinClassNames(styles.header, hasDetails && styles.toggleable)} onClick={onHeaderClick}>
        {leading ? <span className={styles.leading}>{leading}</span> : null}
        <span className={styles.text}>
          <span className={styles.title} id={titleId}>{title}</span>
          {description ? <span className={styles.description}>{description}</span> : null}
        </span>
        {status ? <span className={styles.status}>{status}</span> : null}
        {actions ? <span className={styles.actions}>{actions}</span> : null}
        {hasDetails ? (
          <IconButton
            size="sm"
            className={styles.toggle}
            label={detailsLabel ?? 'Details'}
            aria-expanded={expanded}
            aria-controls={bodyId}
            onClick={() => setExpanded(!expanded)}
          >
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </IconButton>
        ) : null}
      </div>
      {hasDetails ? (
        <div
          className={styles.body}
          id={bodyId}
          role="region"
          aria-labelledby={titleId}
          aria-hidden={expanded ? undefined : true}
        >
          <div className={styles.bodyInner}>
            <div className={styles.bodyContent}>{children}</div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
