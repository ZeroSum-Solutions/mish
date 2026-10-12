// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Route } from '../../src/router';
import { WORKSPACE_ACCENT_INK_VARS, applyAppearanceToDocument } from '../../src/state/appearance';
import { useWorkspaceUiSystem } from '../../src/hooks/useWorkspaceUiSystem';

function Scope({ route }: { route: Route }) {
  useWorkspaceUiSystem(route);
  return null;
}
afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute('data-ui-system');
  document.documentElement.style.removeProperty('--accent');
  for (const name of WORKSPACE_ACCENT_INK_VARS) document.documentElement.style.removeProperty(name);
});
describe('workspace interface scope', () => {
  it('keeps the shared interface system when navigating through Catalog', () => {
    const { rerender } = render(<Scope route={{ kind: 'home', view: 'settings' }} />);
    expect(document.documentElement.dataset.uiSystem).toBe('workspace');
    rerender(<Scope route={{ kind: 'home', view: 'catalog' }} />);
    expect(document.documentElement.dataset.uiSystem).toBe('workspace');
    rerender(<Scope route={{ kind: 'project', projectId: 'example', fileName: null }} />);
    expect(document.documentElement.dataset.uiSystem).toBe('workspace');
  });
  it('keeps custom accent ink legible across workspace and Catalog', () => {
    document.documentElement.style.setProperty('--accent', '#87ea5c');
    const { rerender } = render(<Scope route={{ kind: 'home', view: 'home' }} />);
    expect(document.documentElement.style.getPropertyValue('--ui-on-accent')).toBe('#000000');
    rerender(<Scope route={{ kind: 'home', view: 'catalog' }} />);
    expect(document.documentElement.style.getPropertyValue('--ui-on-accent')).toBe('#000000');
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#87ea5c');
  });
  it('updates custom accent hover ink when the theme changes', () => {
    document.documentElement.style.setProperty('--accent', '#777777');
    render(<Scope route={{ kind: 'home', view: 'settings' }} />);
    applyAppearanceToDocument({ accentColor: '#777777', theme: 'light' });
    expect(document.documentElement.style.getPropertyValue('--ui-on-accent')).toBe('#000000');
    expect(document.documentElement.style.getPropertyValue('--ui-on-accent-hover')).toBe('#ffffff');
    applyAppearanceToDocument({ accentColor: '#777777', theme: 'dark' });
    expect(document.documentElement.style.getPropertyValue('--ui-on-accent-hover')).toBe('#000000');
    document.documentElement.removeAttribute('data-theme');
    applyAppearanceToDocument({ theme: 'system' });
  });
  it('cleans up its root attribute without changing the theme', () => {
    document.documentElement.dataset.theme = 'dark';
    const { unmount } = render(<Scope route={{ kind: 'home', view: 'home' }} />);
    unmount();
    expect(document.documentElement.hasAttribute('data-ui-system')).toBe(false);
    expect(document.documentElement.dataset.theme).toBe('dark');
    document.documentElement.removeAttribute('data-theme');
  });
});
