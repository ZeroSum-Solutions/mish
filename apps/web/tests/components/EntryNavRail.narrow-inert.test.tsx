// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EntryNavRail, RAIL_AUTO_COLLAPSE_QUERY } from '../../src/components/EntryNavRail';
import { I18nProvider } from '../../src/i18n';

// At the narrow breakpoint (entry-layout.css) the docked rail is clipped to a
// zero-width track with pointer events off. Its controls must leave the Tab
// order and the accessibility tree too, not just the pixels.

type Listener = (event: { matches: boolean }) => void;

function stubMatchMedia(initialNarrow: boolean) {
  let narrow = initialNarrow;
  const listeners = new Set<Listener>();
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
    get matches() {
      return query === RAIL_AUTO_COLLAPSE_QUERY ? narrow : false;
    },
    media: query,
    onchange: null,
    addEventListener: (_type: string, listener: Listener) => {
      if (query === RAIL_AUTO_COLLAPSE_QUERY) listeners.add(listener);
    },
    removeEventListener: (_type: string, listener: Listener) => listeners.delete(listener),
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })));
  return {
    setNarrow(next: boolean) {
      narrow = next;
      act(() => {
        for (const listener of listeners) listener({ matches: next });
      });
    },
  };
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ items: [], messages: [], unreadCount: 0 })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderDockedRail() {
  const view = render(
    <I18nProvider initial="en">
      <EntryNavRail view="home" open context={null} onViewChange={() => {}} onNewProject={() => {}} />
    </I18nProvider>,
  );
  return view.container.querySelector('nav')!;
}

it('keeps a docked rail interactive above the narrow breakpoint', () => {
  stubMatchMedia(false);
  const rail = renderDockedRail();
  expect(rail.hasAttribute('inert')).toBe(false);
  expect(rail.getAttribute('aria-hidden')).toBeNull();
});

it('makes the docked rail inert and hidden while the window is at the narrow breakpoint', () => {
  stubMatchMedia(true);
  const rail = renderDockedRail();
  expect(rail.hasAttribute('inert')).toBe(true);
  expect(rail.getAttribute('aria-hidden')).toBe('true');
});

it('follows the breakpoint live as the window resizes', () => {
  const media = stubMatchMedia(false);
  const rail = renderDockedRail();
  expect(rail.hasAttribute('inert')).toBe(false);

  media.setNarrow(true);
  expect(rail.hasAttribute('inert')).toBe(true);

  media.setNarrow(false);
  expect(rail.hasAttribute('inert')).toBe(false);
  expect(rail.getAttribute('aria-hidden')).toBeNull();
});
