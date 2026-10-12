// @vitest-environment jsdom
import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useDeckPreviewScale } from '../../src/lib/use-deck-preview-scale';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function frame(width: number, height: number) {
  const element = document.createElement('span');
  Object.defineProperties(element, {
    clientWidth: { value: width }, clientHeight: { value: height },
  });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  return { current: element };
}

it('covers a thumbnail taller than the authored deck without letterboxing', () => {
  const ref = frame(246, 149);
  renderHook(() => useDeckPreviewScale(ref, true, 'cover'));
  expect(Number(ref.current.style.getPropertyValue('--deck-preview-scale'))).toBe(149 / 720);
});

it('covers a thumbnail wider than the authored deck without side gutters', () => {
  const ref = frame(320, 100);
  renderHook(() => useDeckPreviewScale(ref, true, 'cover'));
  expect(Number(ref.current.style.getPropertyValue('--deck-preview-scale'))).toBe(320 / 1280);
});

it('preserves the width-fit default used by the other preview surfaces', () => {
  const ref = frame(246, 149);
  renderHook(() => useDeckPreviewScale(ref, true));
  expect(Number(ref.current.style.getPropertyValue('--deck-preview-scale'))).toBe(246 / 1280);
});
