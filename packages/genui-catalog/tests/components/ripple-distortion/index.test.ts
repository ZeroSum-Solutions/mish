// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { id, mount } from '../../../components/ripple-distortion/index.ts';
import { stubMatchMedia, stubRaf } from '../../_helpers.ts';

// Mirrors the DOM contract in component-specs.md §12: a host with a `.genui-ripple-distortion__media` child.
function host(rect: Partial<DOMRect> = { left: 0, top: 0, width: 200, height: 100 }): HTMLElement {
  const el = document.createElement('div');
  el.dataset.genui = id;
  const media = document.createElement('div');
  media.className = 'genui-ripple-distortion__media';
  el.append(media);
  document.body.append(el);
  el.getBoundingClientRect = () => ({
    left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON() { return {}; }, ...rect,
  }) as DOMRect;
  return el;
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe(id, () => {
  it('mount duplicates __media into an aria-hidden __warp with a unique filter', () => {
    const a = host();
    const b = host();
    const ha = mount(a);
    const hb = mount(b);

    const warpA = a.querySelector('.genui-ripple-distortion__warp');
    const warpB = b.querySelector('.genui-ripple-distortion__warp');
    expect(warpA).not.toBeNull();
    expect(warpA!.getAttribute('aria-hidden')).toBe('true');
    expect(warpA!.classList.contains('genui-ripple-distortion__media')).toBe(true);

    const filterA = a.querySelector('filter');
    const filterB = b.querySelector('filter');
    expect(filterA).not.toBeNull();
    expect(filterA!.id).not.toBe('');
    expect(filterA!.id).not.toBe(filterB!.id); // unique per mount

    ha.destroy();
    hb.destroy();
  });

  it('a pointermove sets --x/--y and starts the rAF; a second move within throttle does not start a new ripple', () => {
    const raf = stubRaf();
    const el = host({ left: 0, top: 0, width: 200, height: 100 });
    const handle = mount(el, { throttle: 120 });

    el.dispatchEvent(new PointerEvent('pointermove', { clientX: 150, clientY: 25 }));
    expect(el.style.getPropertyValue('--genui-ripple-distortion-x')).toBe('75%');
    expect(el.style.getPropertyValue('--genui-ripple-distortion-y')).toBe('25%');
    expect(raf.pending()).toBe(1);

    // A second move, at a different point, arrives well inside the throttle window.
    el.dispatchEvent(new PointerEvent('pointermove', { clientX: 10, clientY: 10 }));
    expect(el.style.getPropertyValue('--genui-ripple-distortion-x')).toBe('75%'); // unchanged
    expect(el.style.getPropertyValue('--genui-ripple-distortion-y')).toBe('25%'); // unchanged
    expect(raf.pending()).toBe(1); // no second rAF was scheduled

    handle.destroy();
  });

  it('after duration the scale returns to 0 and no rAF is pending', () => {
    let now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const raf = stubRaf();
    const el = host({ left: 0, top: 0, width: 200, height: 100 });
    const handle = mount(el, { duration: 500 });

    el.dispatchEvent(new PointerEvent('pointermove', { clientX: 100, clientY: 50 }));
    expect(raf.pending()).toBe(1);

    now += 500; // past `duration`
    raf.flush();

    expect(el.querySelector('feDisplacementMap')!.getAttribute('scale')).toBe('0');
    expect(raf.pending()).toBe(0);

    handle.destroy();
  });

  it('with reduced motion there is no __warp, and destroy() restores outerHTML', () => {
    stubMatchMedia(true);
    const el = host();
    const before = el.outerHTML;
    const handle = mount(el);

    expect(el.querySelector('.genui-ripple-distortion__warp')).toBeNull();

    handle.destroy();
    expect(el.outerHTML).toBe(before);
    handle.destroy(); // idempotent
    expect(el.outerHTML).toBe(before);
  });
});
