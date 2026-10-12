// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { autoInit, id, mount } from '../../../components/chroma-grid/index.ts';
import { spyListeners, stubMatchMedia, stubRaf } from '../../_helpers.ts';

function host(): HTMLElement {
  const el = document.createElement('div');
  el.dataset.genui = id;
  document.body.append(el);
  return el;
}

function stubRect(el: HTMLElement, rect: { left: number; top: number; width: number; height: number }): void {
  el.getBoundingClientRect = () => ({
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
    right: rect.left + rect.width,
    bottom: rect.top + rect.height,
    x: rect.left,
    y: rect.top,
    toJSON() { return this; },
  });
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe(id, () => {
  it('maps columns to --genui-chroma-grid-cols and appends the desat/fade overlays', () => {
    const el = host();
    const handle = mount(el, { columns: 4 });
    expect(el.style.getPropertyValue('--genui-chroma-grid-cols')).toBe('4');
    expect(el.querySelectorAll(':scope > .genui-chroma-grid__desat')).toHaveLength(1);
    expect(el.querySelectorAll(':scope > .genui-chroma-grid__fade')).toHaveLength(1);
    handle.destroy();
  });

  it('writes --genui-chroma-grid-x/-y from a pointermove after a rAF flush, inside the element bounds', () => {
    const raf = stubRaf();
    const el = host();
    stubRect(el, { left: 0, top: 0, width: 300, height: 200 });
    const handle = mount(el);
    el.dispatchEvent(new PointerEvent('pointermove', { clientX: 90, clientY: 100, pointerType: 'mouse' }));
    raf.flush();
    const x = Number(el.style.getPropertyValue('--genui-chroma-grid-x').replace('%', ''));
    const y = Number(el.style.getPropertyValue('--genui-chroma-grid-y').replace('%', ''));
    expect(x).toBeGreaterThanOrEqual(0);
    expect(x).toBeLessThanOrEqual(100);
    expect(y).toBeGreaterThanOrEqual(0);
    expect(y).toBeLessThanOrEqual(100);
    expect(x).toBeCloseTo(30, 0); // 90/300 = 30%
    expect(y).toBeCloseTo(50, 0); // 100/200 = 50%
    handle.destroy();
  });

  it('creates no overlays and attaches no pointer listener under reduced motion', () => {
    stubMatchMedia(true);
    const el = host();
    const listeners = spyListeners(el);
    const handle = mount(el);
    expect(el.querySelectorAll('.genui-chroma-grid__desat, .genui-chroma-grid__fade')).toHaveLength(0);
    expect(listeners.added()).toBe(0);
    handle.destroy();
  });

  it('destroy() removes the overlays and restores outerHTML exactly', () => {
    const el = host();
    el.className = 'grid featured';
    const before = el.outerHTML;
    const [handle] = autoInit(document);
    expect(el.querySelector('.genui-chroma-grid__desat')).not.toBeNull();
    expect(el.querySelector('.genui-chroma-grid__fade')).not.toBeNull();
    handle!.destroy();
    expect(el.outerHTML).toBe(before);
    handle!.destroy(); // idempotent
    expect(el.outerHTML).toBe(before);
  });
});
