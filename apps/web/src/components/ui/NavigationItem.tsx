import type { ButtonHTMLAttributes, Ref } from 'react';
import { SelectionIndicator } from './SelectionIndicator';

export interface NavigationItemProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean;
  activeClassName?: string;
  buttonRef?: Ref<HTMLButtonElement>;
}

/** Navigation semantics and selection surface shared by both application rails. */
export function NavigationItem({ active, activeClassName = 'is-active', buttonRef, className = '', children, ...props }: NavigationItemProps) {
  return (
    <button
      {...props}
      ref={buttonRef}
      type="button"
      className={`${className}${active ? ` ${activeClassName}` : ''}`}
      aria-current={active ? 'page' : undefined}
    >
      <SelectionIndicator active={Boolean(active)} />
      {children}
    </button>
  );
}
