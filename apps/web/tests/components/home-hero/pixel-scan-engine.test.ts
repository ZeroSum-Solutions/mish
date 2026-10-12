// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PixelScanField,
  hasParticleFieldSizeChanged,
  resolveParticleColor,
  resolvePointerRepel,
} from '../../../src/components/home-hero/pixel-scan/engine';

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('particle wordmark colors', () => {
  it('uses the supplied theme ink at rest and blends from it on hover', () => {
    expect(resolveParticleColor(0, 0, [23, 29, 40])).toEqual([23, 29, 40]);
    expect(resolveParticleColor(0, 0.5, [23, 29, 40])).toEqual([81, 61, 143]);
    expect(resolveParticleColor(1, 0, [244, 247, 252])).toEqual([244, 247, 252]);
  });

  it('updates the rendered ink when the host theme color changes', async () => {
    let nextFrame: FrameRequestCallback | undefined;
    const ctx = {
      fillStyle: '', globalAlpha: 1,
      clearRect: vi.fn(), setTransform: vi.fn(), scale: vi.fn(), drawImage: vi.fn(),
      fillRect: vi.fn(),
      getImageData: () => ({ data: new Uint8ClampedArray(100 * 20 * 4).fill(255) }),
    };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
    vi.stubGlobal('Image', class {
      naturalWidth = 100; naturalHeight = 20;
      onload: (() => void) | null = null;
      set src(_value: string) { this.onload?.(); }
    });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { nextFrame = callback; return 1; });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const host = document.createElement('div');
    host.style.color = '#171d28';
    host.getBoundingClientRect = () => ({ width: 100, height: 20 }) as DOMRect;
    document.body.append(host);
    const field = new PixelScanField(host, document.createElement('canvas'));
    try {
      await field.start();
      nextFrame!(2000);
      expect(ctx.fillStyle).toBe('rgb(23 29 40)');
      host.style.color = '#f4f7fc';
      nextFrame!(2100);
      expect(ctx.fillStyle).toBe('rgb(244 247 252)');
    } finally { field.destroy(); }
  });
  it('keeps every resting particle white', () => {
    expect(resolveParticleColor(0, 0)).toEqual([237, 237, 237]);
    expect(resolveParticleColor(0.5, 0)).toEqual([237, 237, 237]);
    expect(resolveParticleColor(1, 0)).toEqual([237, 237, 237]);
  });

  it('moves through violet, magenta, and orange while hovered', () => {
    expect(resolveParticleColor(0, 1)).toEqual([139, 92, 246]);
    expect(resolveParticleColor(0.5, 1)).toEqual([224, 64, 163]);
    expect(resolveParticleColor(1, 1)).toEqual([255, 122, 24]);
  });

  it('repels particles only inside the active cursor radius', () => {
    expect(resolvePointerRepel(50, 0, 100, 40, 1)).toEqual([10, 0]);
    expect(resolvePointerRepel(100, 0, 100, 40, 1)).toEqual([0, 0]);
    expect(resolvePointerRepel(50, 0, 100, 40, 0)).toEqual([0, 0]);
  });

  it('ignores resize notifications when the measured size is unchanged', () => {
    expect(hasParticleFieldSizeChanged(540, 62, 540, 62)).toBe(false);
    expect(hasParticleFieldSizeChanged(540, 62, 390, 45)).toBe(true);
  });
});
