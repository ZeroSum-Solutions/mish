// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  EDGE_REVEAL_GRACE_MS,
  EDGE_REVEAL_INTENT_MS,
  EntryNavRail,
} from '../../src/components/EntryNavRail';
import { I18nProvider } from '../../src/i18n';

// jsdom has no PointerEvent; a MouseEvent subclass carries clientX/buttons.
class TestPointerEvent extends MouseEvent {
  pointerType: string;
  constructor(type: string, init: MouseEventInit & { pointerType?: string } = {}) {
    super(type, init);
    this.pointerType = init.pointerType ?? 'mouse';
  }
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

function renderCollapsedRail(open = false) {
  const onViewChange = vi.fn();
  const view = render(
    <I18nProvider initial="en">
      <button>Outside</button>
      <EntryNavRail view="home" open={open} context={null} onViewChange={onViewChange} onNewProject={() => {}} />
    </I18nProvider>,
  );
  return { ...view, onViewChange, rail: view.container.querySelector('nav')! };
}

function moveTo(target: EventTarget, clientX: number, init: { buttons?: number; pointerType?: string } = {}) {
  act(() => {
    target.dispatchEvent(new TestPointerEvent('pointermove', {
      bubbles: true,
      clientX,
      clientY: 200,
      buttons: init.buttons ?? 0,
      pointerType: init.pointerType,
    }));
  });
}

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

it('slides the collapsed rail in after the pointer rests at the window edge', () => {
  const { rail } = renderCollapsedRail();
  expect(rail.getAttribute('aria-hidden')).toBe('true');
  moveTo(document.body, 3);
  advance(EDGE_REVEAL_INTENT_MS - 20);
  expect(rail.classList.contains('is-peek')).toBe(false);
  advance(40);
  expect(rail.classList.contains('is-peek')).toBe(true);
  expect(rail.getAttribute('aria-hidden')).toBeNull();
  expect(rail.hasAttribute('inert')).toBe(false);
});

it('ignores a pointer that only passes through the edge strip', () => {
  const { rail } = renderCollapsedRail();
  moveTo(document.body, 3);
  advance(EDGE_REVEAL_INTENT_MS / 2);
  moveTo(document.body, 300);
  advance(EDGE_REVEAL_INTENT_MS * 2);
  expect(rail.classList.contains('is-peek')).toBe(false);
});

it('never reveals while something is being dragged or on touch', () => {
  const { rail } = renderCollapsedRail();
  moveTo(document.body, 2, { buttons: 1 });
  advance(EDGE_REVEAL_INTENT_MS * 2);
  moveTo(document.body, 2, { pointerType: 'touch' });
  advance(EDGE_REVEAL_INTENT_MS * 2);
  expect(rail.classList.contains('is-peek')).toBe(false);
});

it('slides back out after the pointer leaves the rail, but not inside the grace delay', () => {
  const { rail } = renderCollapsedRail();
  moveTo(document.body, 2);
  advance(EDGE_REVEAL_INTENT_MS);
  expect(rail.classList.contains('is-peek')).toBe(true);

  moveTo(screen.getByRole('button', { name: 'Outside' }), 600);
  advance(EDGE_REVEAL_GRACE_MS - 50);
  // Coming back inside the rail cancels the pending exit.
  moveTo(screen.getByTestId('entry-nav-catalog'), 40);
  advance(EDGE_REVEAL_GRACE_MS * 2);
  expect(rail.classList.contains('is-peek')).toBe(true);

  moveTo(screen.getByRole('button', { name: 'Outside' }), 600);
  advance(EDGE_REVEAL_GRACE_MS);
  expect(rail.classList.contains('is-peek-leaving')).toBe(true);
  advance(500);
  expect(rail.classList.contains('is-peek')).toBe(false);
  expect(rail.getAttribute('aria-hidden')).toBe('true');
});

it('hides on Escape and after choosing a page', () => {
  const { rail, onViewChange } = renderCollapsedRail();
  moveTo(document.body, 2);
  advance(EDGE_REVEAL_INTENT_MS);
  fireEvent.keyDown(document, { key: 'Escape' });
  advance(500);
  expect(rail.classList.contains('is-peek')).toBe(false);

  moveTo(document.body, 2);
  advance(EDGE_REVEAL_INTENT_MS);
  fireEvent.click(screen.getByTestId('entry-nav-catalog'));
  expect(onViewChange).toHaveBeenCalledWith('catalog');
  expect(rail.classList.contains('is-peek')).toBe(false);
});

it('leaves a docked rail alone', () => {
  const { rail } = renderCollapsedRail(true);
  moveTo(document.body, 2);
  advance(EDGE_REVEAL_INTENT_MS * 2);
  expect(rail.classList.contains('is-peek')).toBe(false);
  expect(rail.getAttribute('aria-hidden')).toBeNull();
});

it('moves focus to the main region before the hidden peek goes inert', () => {
  // Browsers drop focus to <body> when an ancestor of the focused element
  // turns inert, so Tab would restart from the top of the document.
  const onViewChange = vi.fn();
  render(
    <I18nProvider initial="en">
      <EntryNavRail view="home" open={false} context={null} onViewChange={onViewChange} onNewProject={() => {}} />
      <main className="entry-main">Page</main>
    </I18nProvider>,
  );
  const rail = document.querySelector('nav')!;
  moveTo(document.body, 2);
  advance(EDGE_REVEAL_INTENT_MS);
  const item = screen.getByTestId('entry-nav-catalog');
  item.focus();
  fireEvent.click(item);
  expect(rail.hasAttribute('inert')).toBe(true);
  expect(rail.contains(document.activeElement)).toBe(false);
  expect(document.activeElement).toBe(document.querySelector('main.entry-main'));
});
