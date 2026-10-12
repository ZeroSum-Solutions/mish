import { forwardRef } from 'react';
import type { HTMLAttributes, KeyboardEvent } from 'react';

import { joinClassNames } from './class-names';
import styles from './surface.module.css';

export type SurfaceVariant = 'solid' | 'glass' | 'sunken' | 'outline';
export type SurfaceElevation = 0 | 1 | 2 | 3 | 4;
export type SurfaceRadius = 'sm' | 'md' | 'lg' | 'xl';
export type SurfacePadding = 'none' | 'sm' | 'md' | 'lg';

export interface SurfaceProps extends HTMLAttributes<HTMLDivElement> {
  /**
   * solid — content cards and panels (default).
   * glass — functional layers floating over content: toolbars, popovers, docks.
   * sunken — wells inside a card (code, previews, empty states).
   * outline — hairline-only container with no fill.
   */
  variant?: SurfaceVariant;
  /** Elevation tier from docs/design/ui-system.md: 1 resting · 2 raised · 3 floating · 4 modal. */
  elevation?: SurfaceElevation;
  radius?: SurfaceRadius;
  /** sm 12px · md 16px · lg 24px inset. */
  padding?: SurfacePadding;
  /**
   * Clickable cards: lift on hover, spring-press on active, focus ring. Also
   * makes the surface keyboard-operable: focusable (`tabIndex` 0), `role`
   * "button" unless you pass another role, and Enter / Space fire `onClick`.
   */
  interactive?: boolean;
}

/** The one container primitive: picks fill, elevation, radius and inset from tokens. */
export const Surface = forwardRef<HTMLDivElement, SurfaceProps>(function Surface(
  { variant = 'solid', elevation = 1, radius = 'lg', padding = 'md', interactive = false, className, onKeyDown, onKeyUp, ...props },
  ref,
) {
  // Native button semantics: Enter activates on keydown, Space on keyup, and
  // auto-repeat never re-fires.
  const ownKey = (event: KeyboardEvent<HTMLDivElement>) =>
    interactive && !event.defaultPrevented && event.target === event.currentTarget;
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(event);
    if (!ownKey(event)) return;
    if (event.key === ' ') {
      event.preventDefault();
    } else if (event.key === 'Enter' && !event.repeat) {
      event.preventDefault();
      event.currentTarget.click();
    }
  };
  const handleKeyUp = (event: KeyboardEvent<HTMLDivElement>) => {
    onKeyUp?.(event);
    if (ownKey(event) && event.key === ' ') {
      event.preventDefault();
      event.currentTarget.click();
    }
  };
  return (
    <div
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      {...props}
      onKeyDown={interactive ? handleKeyDown : onKeyDown}
      onKeyUp={interactive ? handleKeyUp : onKeyUp}
      ref={ref}
      data-elevation={elevation}
      className={joinClassNames(
        styles.surface,
        styles[variant],
        styles[`radius-${radius}`],
        styles[`padding-${padding}`],
        interactive && styles.interactive,
        className,
      )}
    />
  );
});
