// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { autoInit, defaults, id, mount } from '../../../components/liquid-glass-card/index.ts';
import { stubMatchMedia, stubRaf } from '../../_helpers.ts';

function host(): HTMLElement {
  const el = document.createElement('div');
  el.dataset.genui = id;
  el.innerHTML = '<strong>Thick glass, live behind it</strong><span>Hover to see it distort.</span>';
  document.body.append(el);
  return el;
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe(id, () => {
  it('mount creates the lens, shine and defs, and moves the children into __content in order', () => {
    stubMatchMedia(false);
    const el = host();
    const originalHtml = el.innerHTML;
    const handle = mount(el);

    expect(el.querySelector(`.genui-${id}__lens`)).not.toBeNull();
    expect(el.querySelector(`.genui-${id}__shine`)).not.toBeNull();
    expect(el.querySelector(`.genui-${id}__defs`)).not.toBeNull();

    const contentEl = el.querySelector(`.genui-${id}__content`);
    expect(contentEl).not.toBeNull();
    expect(contentEl!.innerHTML).toBe(originalHtml);

    // defs, lens, shine, then content last (so it paints above the decorative layers).
    expect(Array.from(el.children).map((child) => child.getAttribute('class'))).toEqual([
      `genui-${id}__defs`,
      `genui-${id}__lens`,
      `genui-${id}__shine`,
      `genui-${id}__content`,
    ]);

    handle.destroy();
  });

  it('scale:25 sets scale="25" on feDisplacementMap', () => {
    stubMatchMedia(false);
    const el = host();
    const handle = mount(el, { scale: 25 });
    const displacement = el.querySelector('feDisplacementMap');
    expect(displacement?.getAttribute('scale')).toBe('25');
    handle.destroy();
  });

  it('with reduced motion, no rAF is requested', () => {
    stubMatchMedia(true);
    const raf = vi.fn();
    vi.stubGlobal('requestAnimationFrame', raf);
    const el = host();
    const handle = mount(el);
    expect(raf).not.toHaveBeenCalled();
    handle.destroy();
  });

  it('destroy() unwraps, removes injected nodes, cancels rAF and restores outerHTML exactly', () => {
    stubMatchMedia(false);
    const raf = stubRaf();
    const el = host();
    const before = el.outerHTML;
    const handle = mount(el);

    expect(el.querySelector(`.genui-${id}__lens`)).not.toBeNull();
    handle.destroy();

    expect(el.querySelector(`.genui-${id}__lens`)).toBeNull();
    expect(el.querySelector(`.genui-${id}__shine`)).toBeNull();
    expect(el.querySelector(`.genui-${id}__defs`)).toBeNull();
    expect(el.outerHTML).toBe(before);
    expect(raf.pending()).toBe(0);

    handle.destroy(); // idempotent
    expect(el.outerHTML).toBe(before);
  });

  it('merges data-genui-opts under opts and drops unknown keys and wrong types', () => {
    stubMatchMedia(false);
    const el = host();
    el.dataset.genuiOpts = JSON.stringify({ radius: 40, bogus: 'nope', blur: 'loud' });
    const handle = mount(el, { radius: 30 });
    expect(el.style.getPropertyValue(`--genui-${id}-radius`)).toBe('30px');
    expect(el.style.getPropertyValue(`--genui-${id}-blur`)).toBe(`${defaults.blur}px`);
    expect(el.style.getPropertyValue(`--genui-${id}-bogus`)).toBe('');
    handle.destroy();
  });

  it('autoInit mounts every host once', () => {
    stubMatchMedia(false);
    const el = host();
    const handles = autoInit(document);
    expect(handles).toHaveLength(1);
    expect(autoInit(document)).toHaveLength(0);
    handles[0]!.destroy();
  });
});
