// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaults, id, mount, scaleFor } from '../../../components/glyph-portal/index.ts';
import { stubMatchMedia, stubRaf } from '../../_helpers.ts';

function host(): HTMLElement {
  const el = document.createElement('section');
  el.dataset.genui = id;
  const link = document.createElement('a');
  link.href = '#';
  link.textContent = 'Continue';
  el.append(link);
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
  it('creates the cover SVG with a unique mask id, and a <text> equal to glyph', () => {
    const el = host();
    const handle = mount(el, { glyph: 'M' });
    const svg = el.querySelector(`svg.genui-${id}__cover`);
    expect(svg).not.toBeNull();
    const mask = svg!.querySelector('mask');
    expect(mask).not.toBeNull();
    expect(mask!.id).toMatch(new RegExp(`^genui-${id}-mask-\\d+$`));
    expect(svg!.querySelector('text')!.textContent).toBe('M');
    handle.destroy();
  });

  it('writes --genui-glyph-portal-s from scroll progress as 1 + (maxScale-1) * p^3', () => {
    vi.stubGlobal('innerHeight', 0);
    const raf = stubRaf();
    const el = host();
    const handle = mount(el);
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue(rect(-500, 1000)); // p = 500/1000 = 0.5
    window.dispatchEvent(new Event('scroll'));
    raf.flush();
    const expected = scaleFor(0.5, defaults.maxScale).toFixed(4);
    expect(el.style.getPropertyValue(`--genui-${id}-s`)).toBe(expected);
    handle.destroy();
  });

  it('with reduced motion, creates no SVG and attaches no scroll listener', () => {
    stubMatchMedia(true);
    const el = host();
    const addSpy = vi.spyOn(window, 'addEventListener');
    const handle = mount(el);
    expect(el.querySelector(`svg.genui-${id}__cover`)).toBeNull();
    expect(addSpy.mock.calls.some(([type]) => type === 'scroll')).toBe(false);
    handle.destroy();
  });

  it('scrolls the track on a covered focusin, and destroy() restores outerHTML exactly', () => {
    const el = host();
    const before = el.outerHTML;
    const scrollSpy = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    const handle = mount(el);
    el.querySelector('a')!.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(scrollSpy).toHaveBeenCalled();
    handle.destroy();
    expect(el.outerHTML).toBe(before);
    handle.destroy(); // idempotent
    expect(el.outerHTML).toBe(before);
  });
});
