// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { autoInit, defaults, id, layerVars, mount } from '../../../components/gradual-blur/index.ts';
import { stubMatchMedia, stubRaf, trackActiveListeners } from '../../_helpers.ts';

const here = path.resolve(import.meta.dirname, '../../../components/gradual-blur');
const P = `genui-${id}`;

function host(tag = 'div'): HTMLElement {
  const el = document.createElement(tag);
  el.innerHTML = tag === 'ul' ? '<li>One</li><li>Two</li>' : '<p>One</p><p>Two</p>';
  el.dataset.genui = id;
  document.body.append(el);
  return el;
}

/** Give a host a fake scroll geometry: `room` px of overflow, scrolled to `top`. */
function scrollGeometry(el: HTMLElement, room: number, top: number): void {
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: 100 });
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: 100 + room });
  Object.defineProperty(el, 'scrollTop', { configurable: true, writable: true, value: top });
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe(id, () => {
  it('autoInit mounts once, and destroy restores outerHTML exactly', () => {
    const el = host();
    const before = el.outerHTML;
    const [handle] = autoInit(document);
    expect(el.classList.contains(P)).toBe(true);
    expect(el.hasAttribute('data-genui-mounted')).toBe(true);
    expect(autoInit(document)).toHaveLength(0);
    handle!.destroy();
    expect(el.outerHTML).toBe(before);
    handle!.destroy(); // idempotent
    expect(el.outerHTML).toBe(before);
  });

  it('keeps an existing class and style attribute byte-for-byte', () => {
    const el = host();
    el.className = 'card  featured';
    el.setAttribute('style', 'color: red;');
    const before = el.outerHTML;
    mount(el, { position: 'both' }).destroy();
    expect(el.outerHTML).toBe(before);
  });

  it('adds one aria-hidden edge per side with `layers` layers, and leaves the content untouched', () => {
    const el = host();
    const handle = mount(el, { position: 'both', layers: 4 });
    const edges = el.querySelectorAll(`.${P}__edge`);
    expect(edges).toHaveLength(2);
    expect(el.firstElementChild?.classList.contains(`${P}__edge--top`)).toBe(true);
    expect(el.lastElementChild?.classList.contains(`${P}__edge--bottom`)).toBe(true);
    for (const edge of edges) {
      expect(edge.getAttribute('aria-hidden')).toBe('true');
      expect(edge.querySelectorAll(`.${P}__layer`)).toHaveLength(4);
    }
    expect(Array.from(el.querySelectorAll('p'), (p) => p.textContent)).toEqual(['One', 'Two']);
    handle.destroy();
  });

  it('uses <li> edges inside a list and only the requested side', () => {
    const el = host('ul');
    const before = el.outerHTML;
    const handle = mount(el, { position: 'top' });
    const edges = el.querySelectorAll(`.${P}__edge`);
    expect(edges).toHaveLength(1);
    expect(edges[0]!.tagName).toBe('LI');
    expect(edges[0]!.classList.contains(`${P}__edge--top`)).toBe(true);
    handle.destroy();
    expect(el.outerHTML).toBe(before);
  });

  it('maps options to custom properties on the host and each layer', () => {
    const el = host();
    const handle = mount(el, { height: '64px', tint: 'red', strength: 16, layers: 4 });
    expect(el.style.getPropertyValue(`--${P}-height`)).toBe('64px');
    expect(el.style.getPropertyValue(`--${P}-tint`)).toBe('red');
    expect(el.style.getPropertyValue(`--${P}-duration`)).toBe(`${defaults.duration}ms`);
    const layers = el.querySelectorAll<HTMLElement>(`.${P}__layer`);
    // exponential: 16 * 2^(i+1-n) -> 2, 4, 8, 16
    expect(Array.from(layers, (l) => l.style.getPropertyValue(`--${P}-b`))).toEqual(['2px', '4px', '8px', '16px']);
    expect(layers[0]!.style.getPropertyValue(`--${P}-s0`)).toBe('0%');
    expect(layers[3]!.style.getPropertyValue(`--${P}-s3`)).toBe('100%');
    handle.destroy();
  });

  it('ramps linearly with curve:"linear" and clamps the layer count', () => {
    expect(layerVars(1, 4, 8, 'linear').b).toBe('4px');
    expect(layerVars(0, 3, 9, 'linear')).toEqual({ b: '3px', s0: '0%', s1: '33.33%', s2: '66.67%', s3: '100%' });
    const el = host();
    const handle = mount(el, { layers: 40 });
    expect(el.querySelectorAll(`.${P}__layer`)).toHaveLength(12);
    handle.destroy();
  });

  it('merges data-genui-opts under opts and drops unknown keys and wrong types', () => {
    const el = host();
    el.dataset.genuiOpts = JSON.stringify({ height: '40px', tint: 'blue', bogus: 1, strength: 'loud', duration: 900 });
    const handle = mount(el, { duration: 120 });
    expect(el.style.getPropertyValue(`--${P}-height`)).toBe('40px');
    expect(el.style.getPropertyValue(`--${P}-tint`)).toBe('blue');
    expect(el.style.getPropertyValue(`--${P}-duration`)).toBe('120ms');
    expect(el.style.getPropertyValue(`--${P}-bogus`)).toBe('');
    const last = Array.from(el.querySelectorAll<HTMLElement>(`.${P}__layer`)).at(-1)!;
    expect(last.style.getPropertyValue(`--${P}-b`)).toBe(`${defaults.strength}px`);
    handle.destroy();
  });

  it('fades each band out at its end of the scroll, rAF-throttled', () => {
    const raf = stubRaf();
    const el = host();
    scrollGeometry(el, 200, 0);
    const handle = mount(el, { position: 'both' });
    const top = el.querySelector(`.${P}__edge--top`)!;
    const bottom = el.querySelector(`.${P}__edge--bottom`)!;
    expect(top.classList.contains(`${P}__edge--off`)).toBe(true);
    expect(bottom.classList.contains(`${P}__edge--off`)).toBe(false);
    el.scrollTop = 200;
    el.dispatchEvent(new Event('scroll'));
    el.dispatchEvent(new Event('scroll'));
    expect(raf.pending()).toBe(1);
    raf.flush();
    expect(top.classList.contains(`${P}__edge--off`)).toBe(false);
    expect(bottom.classList.contains(`${P}__edge--off`)).toBe(true);
    handle.destroy();
    expect(raf.pending()).toBe(0);
  });

  it('keeps bands visible on a host that does not scroll, and removes its listeners on destroy', () => {
    const el = host();
    const tracked = trackActiveListeners(el, ['scroll']);
    const win = trackActiveListeners(window, ['resize']);
    const handle = mount(el, { position: 'both' });
    expect(el.querySelectorAll(`.${P}__edge--off`)).toHaveLength(0);
    expect(tracked.active('scroll')).toBe(1);
    expect(win.active('resize')).toBe(1);
    handle.destroy();
    expect(tracked.active('scroll')).toBe(0);
    expect(win.active('resize')).toBe(0);
  });

  it('attaches no scroll listener with fadeAtEnds:false', () => {
    const el = host();
    const tracked = trackActiveListeners(el, ['scroll']);
    const handle = mount(el, { fadeAtEnds: false });
    expect(tracked.active('scroll')).toBe(0);
    handle.destroy();
  });

  it('follows reduced motion at mount and on change, and removes its listener on destroy', () => {
    const media = stubMatchMedia(true);
    const el = host();
    const before = el.outerHTML;
    const handle = mount(el);
    expect(el.classList.contains(`${P}--reduced`)).toBe(true);
    expect(media.listeners()).toBe(1);
    media.fire(false);
    expect(el.classList.contains(`${P}--reduced`)).toBe(false);
    media.fire(true);
    expect(el.classList.contains(`${P}--reduced`)).toBe(true);
    handle.destroy();
    expect(media.listeners()).toBe(0);
    expect(el.outerHTML).toBe(before);
  });

  it('ships css scoped under .genui-gradual-blur with no url() or @import, and a reduced-motion block', () => {
    const raw = readFileSync(path.join(here, 'styles.css'), 'utf8');
    expect(raw).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    const css = raw.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).not.toMatch(/url\(|@import|https?:\/\//);
    const selectors = css.replace(/@(media|supports)[^{]+\{/g, '').match(/[^{}]+(?=\{)/g) ?? [];
    expect(selectors.length).toBeGreaterThan(0);
    for (const selector of selectors.flatMap((s) => s.split(','))) {
      expect(selector.trim()).toMatch(/genui-gradual-blur/);
    }
  });

  it('has a demo fragment with no script, style block, image or external URL', () => {
    const demo = readFileSync(path.join(here, 'demo.html'), 'utf8');
    expect(demo).toContain(`data-genui="${id}"`);
    expect(demo).not.toMatch(/<script|<style|<img|url\(|https?:\/\//i);
    expect(demo).not.toMatch(/<!doctype|<\/?(html|head|body|script|style|iframe|object|embed|link|meta|base)\b/i);
    expect(demo).not.toMatch(/xmlns/);
  });

  it('declares the same defaults in meta.json props as in the code', () => {
    const meta = JSON.parse(readFileSync(path.join(here, 'meta.json'), 'utf8')) as {
      id: string; props: { properties: Record<string, { default: unknown }> };
    };
    expect(meta.id).toBe(id);
    const declared = Object.fromEntries(Object.entries(meta.props.properties).map(([key, value]) => [key, value.default]));
    expect(declared).toEqual(defaults);
  });
});
