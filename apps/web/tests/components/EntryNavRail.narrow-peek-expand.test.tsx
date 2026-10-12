// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  EDGE_REVEAL_INTENT_MS,
  EntryNavRail,
  RAIL_AUTO_COLLAPSE_QUERY,
} from '../../src/components/EntryNavRail';
import { ENTRY_RAIL_TOGGLE_EVENT } from '../../src/components/entryRailBridge';
import { I18nProvider } from '../../src/i18n';

// Wave-2 review (#190): at or below the 1080px breakpoint the docked rail is
// clipped away by CSS, so the rail cannot dock there. The control inside the
// edge-reveal peek used to request a dock anyway: the shell set `open`, the
// peek vanished, edge reveal stopped arming, and the Home toggle reported an
// open rail nobody could see. Edge reveal must stay the way to reach the rail
// while it cannot dock (docs/design/ui-system.md, edge-reveal overlays).

class TestPointerEvent extends MouseEvent {
  pointerType: string;
  constructor(type: string, init: MouseEventInit & { pointerType?: string } = {}) {
    super(type, init);
    this.pointerType = init.pointerType ?? 'mouse';
  }
}

function stubMatchMedia(narrow: boolean) {
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
    matches: query === RAIL_AUTO_COLLAPSE_QUERY ? narrow : false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('PointerEvent', TestPointerEvent);
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ items: [], messages: [], unreadCount: 0 })));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// Stands in for EntryShell: owns `open` and flips it on the toggle event.
function Shell({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onToggle = () => setOpen((v) => !v);
    window.addEventListener(ENTRY_RAIL_TOGGLE_EVENT, onToggle);
    return () => window.removeEventListener(ENTRY_RAIL_TOGGLE_EVENT, onToggle);
  }, []);
  useEffect(() => onOpenChange(open), [open, onOpenChange]);
  return <EntryNavRail view="home" open={open} context={null} onViewChange={() => {}} onNewProject={() => {}} />;
}

function renderShell() {
  const onOpenChange = vi.fn();
  const view = render(
    <I18nProvider initial="en">
      <Shell onOpenChange={onOpenChange} />
    </I18nProvider>,
  );
  return { ...view, onOpenChange, rail: view.container.querySelector('nav')! };
}

function peekFromEdge() {
  act(() => {
    document.body.dispatchEvent(new TestPointerEvent('pointermove', {
      bubbles: true,
      clientX: 2,
      clientY: 200,
      buttons: 0,
    }));
  });
  act(() => {
    vi.advanceTimersByTime(EDGE_REVEAL_INTENT_MS);
  });
}

it('at the narrow breakpoint the peek control does not dock a rail that cannot dock', () => {
  stubMatchMedia(true);
  const { rail, onOpenChange } = renderShell();
  peekFromEdge();
  expect(rail.classList.contains('is-peek')).toBe(true);

  const control = screen.getByTestId('entry-rail-collapse');
  // It must not offer an action it cannot perform.
  expect(control.getAttribute('aria-label')).not.toBe('Expand sidebar');
  fireEvent.click(control);
  act(() => {
    vi.advanceTimersByTime(500);
  });

  // The shell never saw a dock request, so the Home toggle keeps reporting a
  // collapsed rail.
  expect(onOpenChange).not.toHaveBeenCalledWith(true);
  expect(rail.classList.contains('is-open')).toBe(false);
  expect(rail.classList.contains('is-peek')).toBe(false);

  // Edge reveal is still armed.
  peekFromEdge();
  expect(rail.classList.contains('is-peek')).toBe(true);
  expect(rail.hasAttribute('inert')).toBe(false);
  expect(rail.getAttribute('aria-hidden')).toBeNull();
});

it('above the narrow breakpoint the peek control still docks the rail', () => {
  stubMatchMedia(false);
  const { rail, onOpenChange } = renderShell();
  peekFromEdge();
  const control = screen.getByTestId('entry-rail-collapse');
  expect(control.getAttribute('aria-label')).toBe('Expand sidebar');
  fireEvent.click(control);
  expect(onOpenChange).toHaveBeenLastCalledWith(true);
  expect(rail.classList.contains('is-open')).toBe(true);
  expect(rail.classList.contains('is-peek')).toBe(false);
});
