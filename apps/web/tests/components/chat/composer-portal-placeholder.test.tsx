// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChatPane, COMPOSER_RESERVED_MIN_HEIGHT } from '../../../src/components/ChatPane';

let layerHeight = 0;
let slotHeight = COMPOSER_RESERVED_MIN_HEIGHT;
let resizeObservers: Array<{ callback: ResizeObserverCallback; targets: Element[] }> = [];
let animationFrames: FrameRequestCallback[] = [];
let originalRect: typeof HTMLElement.prototype.getBoundingClientRect;
let originalResizeObserver: typeof ResizeObserver | undefined;
let originalAnimationFrame: typeof requestAnimationFrame;
let originalCancelAnimationFrame: typeof cancelAnimationFrame;

const rect = (height: number, width = 320, top = 0): DOMRect => ({
  x: 0,
  y: top,
  width,
  height,
  top,
  right: width,
  bottom: top + height,
  left: 0,
  toJSON: () => ({}),
});

beforeEach(() => {
  layerHeight = 0;
  slotHeight = COMPOSER_RESERVED_MIN_HEIGHT;
  resizeObservers = [];
  animationFrames = [];
  originalRect = HTMLElement.prototype.getBoundingClientRect;
  originalResizeObserver = globalThis.ResizeObserver;
  originalAnimationFrame = window.requestAnimationFrame;
  originalCancelAnimationFrame = window.cancelAnimationFrame;

  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function getRect(this: HTMLElement) {
    if (this.classList.contains('chat-composer-slot')) return rect(slotHeight, 320, 600);
    if (this.classList.contains('chat-composer-fixed-layer')) return rect(layerHeight, 320, 600);
    if (this.classList.contains('pane')) return rect(742, 320, 0);
    return rect(0);
  });

  class MockResizeObserver {
    private readonly entry: { callback: ResizeObserverCallback; targets: Element[] };
    constructor(callback: ResizeObserverCallback) {
      this.entry = { callback, targets: [] };
      resizeObservers.push(this.entry);
    }
    observe(target: Element): void { this.entry.targets.push(target); }
    unobserve(): void {}
    disconnect(): void {}
  }
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    writable: true,
    value: MockResizeObserver,
  });
  window.requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
    animationFrames.push(callback);
    return animationFrames.length;
  });
  window.cancelAnimationFrame = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  HTMLElement.prototype.getBoundingClientRect = originalRect;
  window.requestAnimationFrame = originalAnimationFrame;
  window.cancelAnimationFrame = originalCancelAnimationFrame;
  if (originalResizeObserver) {
    Object.defineProperty(globalThis, 'ResizeObserver', {
      configurable: true,
      writable: true,
      value: originalResizeObserver,
    });
  } else {
    delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
  }
});

function renderPane(): ReturnType<typeof render> {
  return render(
    <ChatPane
      messages={[]}
      streaming={false}
      error={null}
      projectId="project-1"
      projectFiles={[]}
      onEnsureProject={async () => 'project-1'}
      onSend={() => {}}
      onStop={() => {}}
      conversations={[]}
      activeConversationId={null}
      onSelectConversation={() => {}}
      onDeleteConversation={() => {}}
    />,
  );
}

function flushFrames(): void {
  const pending = animationFrames;
  animationFrames = [];
  pending.forEach((callback) => callback(0));
}

describe('portaled composer placeholder', () => {
  it('reserves the in-flow composer height before the fixed layer can measure', () => {
    const { container } = renderPane();
    const slot = container.querySelector<HTMLElement>('.chat-composer-slot');

    expect(slot).not.toBeNull();
    expect(slot).toHaveAttribute('aria-hidden', 'true');
    expect(slot?.style.minHeight).toBe(`${COMPOSER_RESERVED_MIN_HEIGHT}px`);
  });

  it('retains the safety floor when the in-flow measurement is unavailable', () => {
    slotHeight = 0;
    const { container } = renderPane();
    const slot = container.querySelector<HTMLElement>('.chat-composer-slot');

    expect(slot).toHaveAttribute('aria-hidden', 'true');
    expect(slot?.style.minHeight).toBe(`${COMPOSER_RESERVED_MIN_HEIGHT}px`);
  });

  it('replaces the safety reserve with the fixed layer ResizeObserver measurement', () => {
    const { container } = renderPane();
    const slot = container.querySelector<HTMLElement>('.chat-composer-slot');
    expect(slot?.style.minHeight).toBe(`${COMPOSER_RESERVED_MIN_HEIGHT}px`);

    layerHeight = 188;
    act(() => {
      const layerObserver = resizeObservers.find(({ targets }) => (
        targets.some((target) => target.classList.contains('chat-composer-fixed-layer'))
      ));
      expect(layerObserver).toBeDefined();
      layerObserver!.callback([], {} as ResizeObserver);
      flushFrames();
    });

    expect(slot?.style.minHeight).toBe('188px');
  });
});
