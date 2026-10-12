// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { WorkspaceTabsBar } from '../../src/components/WorkspaceTabsBar';
import {
  ENTRY_RAIL_STATE_EVENT,
  ENTRY_RAIL_TOGGLE_EVENT,
  RAIL_OPEN_STORAGE_KEY,
} from '../../src/components/entryRailBridge';
import { setWorkspaceTabsDock } from '../../src/components/workspaceTabsDock';
import { installViewport } from '../helpers/viewport-media';

// Decision D13 (2026-10-09): the pinned Home tab's rail opener reports what the
// user can see. Before EntryShell's first state broadcast it seeds from the
// same resolver EntryShell uses, so a never-chosen wide viewport reads as an
// open rail, and a stored open preference that CSS hides at <= 1080 px reads
// as closed — so the opener still works there.

vi.mock('../../src/i18n', () => ({
  useI18n: () => ({ locale: 'en', setLocale: () => undefined, t: (key: string) => key }),
  useT: () => (key: string) => key,
}));

vi.mock('../../src/router', async () => {
  const actual = await vi.importActual<typeof import('../../src/router')>('../../src/router');
  return { ...actual, navigate: vi.fn() };
});

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  setWorkspaceTabsDock(null);
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

function renderBar() {
  render(<WorkspaceTabsBar route={{ kind: 'home', view: 'home' }} projects={[]} />);
  return screen.getByTestId('workspace-home-rail-toggle');
}

it('seeds as open for a never-chosen rail on a wide viewport', () => {
  installViewport(1440);
  expect(renderBar().getAttribute('aria-expanded')).toBe('true');
});

it('seeds as closed for a never-chosen rail below 1280 px', () => {
  installViewport(1200);
  expect(renderBar().getAttribute('aria-expanded')).toBe('false');
});

it('reports closed where CSS hides a stored open rail, and still opens it', () => {
  window.localStorage.setItem(RAIL_OPEN_STORAGE_KEY, 'true');
  installViewport(1024);
  const toggle = renderBar();
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(toggle.classList.contains('is-inert')).toBe(false);

  const onToggle = vi.fn();
  window.addEventListener(ENTRY_RAIL_TOGGLE_EVENT, onToggle);
  try {
    fireEvent.click(toggle);
    expect(onToggle).toHaveBeenCalledTimes(1);
  } finally {
    window.removeEventListener(ENTRY_RAIL_TOGGLE_EVENT, onToggle);
  }

  // EntryShell's broadcast stays authoritative once it arrives.
  act(() => {
    window.dispatchEvent(new CustomEvent(ENTRY_RAIL_STATE_EVENT, { detail: { open: true } }));
  });
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
});
