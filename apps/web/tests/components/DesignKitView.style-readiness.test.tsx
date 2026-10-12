// @vitest-environment jsdom

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DesignKitView } from '../../src/components/DesignKitView';
import { I18nProvider } from '../../src/i18n';
import type { DesignKit } from '../../src/runtime/design-kit';

const STYLE_SENTINEL = '--od-design-kit-styles-ready';

let stylesReady = false;
let animationFrames: FrameRequestCallback[] = [];
let originalAnimationFrame: typeof requestAnimationFrame;
let originalCancelAnimationFrame: typeof cancelAnimationFrame;

function kit(): DesignKit {
  return {
    designSystemId: 'user:style-readiness',
    name: 'Readiness Kit',
    editable: false,
    canUpload: false,
    logoSrc: null,
    logoAlternates: [],
    colors: [{ role: 'Primary', name: 'Signal orange', hex: '#ff5701', usage: 'Primary actions' }],
    typography: {
      display: { family: 'Playfair Display', fallbacks: [], weights: [700] },
      body: { family: 'Inter', fallbacks: [], weights: [400] },
    },
    fonts: [],
  };
}

beforeEach(() => {
  stylesReady = false;
  animationFrames = [];
  originalAnimationFrame = window.requestAnimationFrame;
  originalCancelAnimationFrame = window.cancelAnimationFrame;

  vi.spyOn(window, 'getComputedStyle').mockImplementation((element) => ({
    getPropertyValue: (property: string) => (
      property === STYLE_SENTINEL && stylesReady && element.hasAttribute('data-testid') ? '1' : ''
    ),
  }) as CSSStyleDeclaration);
  window.requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
    animationFrames.push(callback);
    return animationFrames.length;
  });
  window.cancelAnimationFrame = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.requestAnimationFrame = originalAnimationFrame;
  window.cancelAnimationFrame = originalCancelAnimationFrame;
});

function mount() {
  return render(
    <I18nProvider initial="en">
      <DesignKitView kit={kit()} dataTestId="design-kit-readiness" showCover={false} />
    </I18nProvider>,
  );
}

function flushFrame(): void {
  const callback = animationFrames.shift();
  if (!callback) throw new Error('Expected a pending style-readiness animation frame');
  callback(0);
}

describe('DesignKitView style readiness', () => {
  it('keeps rich content hidden until the CSS-module sentinel resolves', () => {
    mount();
    const root = screen.getByTestId('design-kit-readiness');

    expect(root).toHaveAttribute('data-style-ready', 'false');
    expect(root.style.visibility).toBe('hidden');
    expect(screen.getByTestId('design-kit-readiness-style-loading')).toBeVisible();

    stylesReady = true;
    act(flushFrame);

    expect(root).toHaveAttribute('data-style-ready', 'true');
    expect(root.style.visibility).toBe('');
    expect(screen.queryByTestId('design-kit-readiness-style-loading')).toBeNull();
  });

  it('fails closed when the sentinel stays absent', () => {
    mount();
    const root = screen.getByTestId('design-kit-readiness');

    act(() => {
      let frameCount = 0;
      while (animationFrames.length > 0) {
        flushFrame();
        frameCount += 1;
        if (frameCount > 200) throw new Error('Style-readiness retry chain did not stop');
      }
      expect(frameCount).toBeGreaterThan(0);
    });

    expect(root).toHaveAttribute('data-style-ready', 'false');
    expect(root.style.visibility).toBe('hidden');
    expect(screen.getByTestId('design-kit-readiness-style-loading')).toBeVisible();
    expect(root.textContent).toContain('Typography');
  });

  it('recovers when a stylesheet finishes loading after the frame budget', () => {
    mount();
    const root = screen.getByTestId('design-kit-readiness');

    act(() => {
      let frameCount = 0;
      while (animationFrames.length > 0) {
        flushFrame();
        frameCount += 1;
        if (frameCount > 200) throw new Error('Style-readiness retry chain did not stop');
      }
    });
    expect(root).toHaveAttribute('data-style-ready', 'false');

    stylesReady = true;
    act(() => document.dispatchEvent(new Event('load')));

    expect(root).toHaveAttribute('data-style-ready', 'true');
    expect(screen.queryByTestId('design-kit-readiness-style-loading')).toBeNull();
  });
});
