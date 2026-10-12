// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaults, id, mount } from '../../../components/scroll-locked-video-hero/index.ts';
import { stubMatchMedia, stubRaf, trackActiveListeners } from '../../_helpers.ts';

function host(): HTMLElement {
  const el = document.createElement('section');
  el.dataset.genui = id;
  document.body.append(el);
  return el;
}

/** A DOMRect-shaped stub: `top` px above the viewport, `height` px tall. */
function rect(top: number, height: number): DOMRect {
  return { top, height, bottom: top + height, left: 0, right: 0, width: 0, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe(id, () => {
  it('with no media, creates a canvas and a stage wrapper, and pins the host to trackHeight', () => {
    const el = host();
    const handle = mount(el);
    expect(el.style.height).toBe(defaults.trackHeight);
    expect(el.querySelector(`.genui-${id}__stage`)).not.toBeNull();
    expect(el.querySelector(`canvas.genui-${id}__canvas`)).not.toBeNull();
    handle.destroy();
  });

  it('scrubs a child video\'s currentTime from the scroll-driven progress', () => {
    const el = host();
    const video = document.createElement('video');
    Object.defineProperty(video, 'duration', { value: 10, configurable: true });
    el.append(video);
    vi.stubGlobal('innerHeight', 768);
    const raf = stubRaf();
    const handle = mount(el);
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue(rect(-500, 2000));
    window.dispatchEvent(new Event('scroll'));
    raf.flush();
    const expectedP = 500 / (2000 - 768);
    expect(video.currentTime).toBeCloseTo(expectedP * 10, 2);
    handle.destroy();
  });

  it('with reduced motion, sets no track height and attaches no scroll listener', () => {
    stubMatchMedia(true);
    const el = host();
    const addSpy = vi.spyOn(window, 'addEventListener');
    const handle = mount(el);
    expect(el.style.height).toBe('');
    expect(addSpy.mock.calls.some(([type]) => type === 'scroll')).toBe(false);
    handle.destroy();
  });

  it('repeated reduced-motion switches keep exactly one scroll/resize pair while enabled and none while reduced', () => {
    const media = stubMatchMedia(false);
    const listeners = trackActiveListeners(window, ['scroll', 'resize']);
    const pair = (): number[] => [listeners.active('scroll'), listeners.active('resize')];
    const el = host();
    const handle = mount(el);
    expect(pair()).toEqual([1, 1]);
    for (let round = 0; round < 3; round += 1) {
      media.fire(true);
      expect(pair()).toEqual([0, 0]);
      expect(el.style.height).toBe('');
      media.fire(false);
      expect(pair()).toEqual([1, 1]);
      expect(el.style.height).toBe(defaults.trackHeight);
    }
    handle.destroy();
    expect(pair()).toEqual([0, 0]);
  });

  it('destroy() removes the canvas and stage, cancels rAF and restores outerHTML exactly', () => {
    const el = host();
    const before = el.outerHTML;
    const raf = stubRaf();
    const handle = mount(el);
    expect(el.querySelector(`.genui-${id}__stage`)).not.toBeNull();
    handle.destroy();
    expect(el.querySelector(`.genui-${id}__stage`)).toBeNull();
    expect(el.querySelector('canvas')).toBeNull();
    expect(raf.pending()).toBe(0);
    expect(el.outerHTML).toBe(before);
  });
});
