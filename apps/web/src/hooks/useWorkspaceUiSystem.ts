import { useLayoutEffect } from 'react';
import type { Route } from '../router';
import { updateWorkspaceAccentInk, WORKSPACE_ACCENT_INK_VARS } from '../state/appearance';

export function workspaceUiEnabled(_route: Route): boolean {
  return true;
}

/** Apply before paint so portals and route content use the same theme roles. */
export function useWorkspaceUiSystem(route: Route): void {
  const enabled = workspaceUiEnabled(route);
  useLayoutEffect(() => {
    const root = document.documentElement;
    const previous = root.getAttribute('data-ui-system');
    const previousInks = WORKSPACE_ACCENT_INK_VARS.map((name) => root.style.getPropertyValue(name));
    if (enabled) root.setAttribute('data-ui-system', 'workspace');
    else root.removeAttribute('data-ui-system');
    updateWorkspaceAccentInk(root);
    const scheme = window.matchMedia?.('(prefers-color-scheme: dark)');
    const updateInk = () => updateWorkspaceAccentInk(root);
    scheme?.addEventListener('change', updateInk);
    return () => {
      scheme?.removeEventListener('change', updateInk);
      WORKSPACE_ACCENT_INK_VARS.forEach((name, index) => {
        const previousInk = previousInks[index];
        if (previousInk) root.style.setProperty(name, previousInk);
        else root.style.removeProperty(name);
      });
      if (previous === null) root.removeAttribute('data-ui-system');
      else root.setAttribute('data-ui-system', previous);
    };
  }, [enabled]);
}
