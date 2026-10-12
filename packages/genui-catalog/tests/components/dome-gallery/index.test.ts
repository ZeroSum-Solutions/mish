// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { autoInit, defaults, id, mount } from '../../../components/dome-gallery/index.ts';
import { stubIO, stubMatchMedia, stubRaf, trackActiveListeners } from '../../_helpers.ts';

const here = path.resolve(import.meta.dirname, '../../../components/dome-gallery');
const P = '--genui-dome-gallery';

function host(itemCount = 6): HTMLElement {
  const el = document.createElement('div');
  el.dataset.genui = id;
  for (let i = 0; i < itemCount; i += 1) {
    const item = document.createElement('figure');
    item.className = 'genui-dome-gallery__item';
    if (i === 0) item.setAttribute('style', 'background: red;');
    const link = document.createElement('a');
    link.href = '#';
    link.textContent = `Photo ${i}`;
    item.append(link);
    el.append(item);
  }
  document.body.append(el);
  return el;
}

const items = (el: HTMLElement): HTMLElement[] => Array.from(el.querySelectorAll<HTMLElement>('.genui-dome-gallery__item'));
/** rAF stub whose clock advances 16 ms per frame, so eased motion settles when flushed. */
function frames(): { flush(): void; pending(): number } {
  let queue = new Map<number, FrameRequestCallback>();
  let next = 1; let now = 0;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { const n = next++; queue.set(n, cb); return n; });
  vi.stubGlobal('cancelAnimationFrame', (n: number) => { queue.delete(n); });
  return {
    flush() {
      for (let i = 0; i < 200 && queue.size > 0; i += 1) {
        const current = queue; queue = new Map(); now += 16;
        for (const cb of current.values()) cb(now);
      }
    },
    pending: () => queue.size,
  };
}

const deg = (el: HTMLElement, key: string): number => parseFloat(el.style.getPropertyValue(`${P}-${key}`));

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe(id, () => {
  it('autoInit mounts once, and destroy restores outerHTML exactly', () => {
    const el = host();
    const before = el.outerHTML;
    const [handle] = autoInit(document);
    expect(el.classList.contains(`genui-${id}`)).toBe(true);
    expect(el.classList.contains('genui-dome-gallery--3d')).toBe(true);
    expect(el.hasAttribute('data-genui-mounted')).toBe(true);
    expect(el.getAttribute('tabindex')).toBe('0');
    expect(el.getAttribute('role')).toBe('group');
    expect(el.getAttribute('aria-label')).toBe(defaults.label);
    expect(autoInit(document)).toHaveLength(0);
    handle!.destroy();
    expect(el.outerHTML).toBe(before);
    handle!.destroy(); // idempotent
    expect(el.outerHTML).toBe(before);
  });

  it('keeps an existing class, style and label byte-for-byte', () => {
    const el = host();
    el.className = 'gallery  featured';
    el.setAttribute('style', 'color: red;');
    el.setAttribute('aria-label', 'Trip photos');
    const before = el.outerHTML;
    const handle = mount(el, { radius: 300 });
    expect(el.getAttribute('aria-label')).toBe('Trip photos');
    handle.destroy();
    expect(el.outerHTML).toBe(before);
  });

  it('maps options to custom properties and places each tile on the dome', () => {
    const el = host(6);
    const handle = mount(el, { radius: 300, tile: 100, rows: 2, step: 20 });
    expect(el.style.getPropertyValue(`${P}-radius`)).toBe('300px');
    expect(el.style.getPropertyValue(`${P}-tile`)).toBe('100px');
    expect(deg(el, 'yaw')).toBe(0);
    const [first, , third, fourth] = items(el);
    // Row 0 sits above row 1; columns run left to right (CSS rotateY(+a) moves a tile left).
    expect(deg(first!, 'lat')).toBeLessThan(deg(fourth!, 'lat'));
    expect(deg(first!, 'lon')).toBeGreaterThan(deg(third!, 'lon'));
    handle.destroy();
    expect(first!.getAttribute('style')).toBe('background: red;');
    expect(third!.hasAttribute('style')).toBe(false);
  });

  it('merges data-genui-opts under opts and drops unknown keys and wrong types', () => {
    const el = host();
    el.dataset.genuiOpts = JSON.stringify({ radius: 500, tile: 90, bogus: 1, rows: 'many' });
    const handle = mount(el, { tile: 120 });
    expect(el.style.getPropertyValue(`${P}-radius`)).toBe('500px');
    expect(el.style.getPropertyValue(`${P}-tile`)).toBe('120px');
    expect(el.style.getPropertyValue(`${P}-bogus`)).toBe('');
    // rows fell back to the default (3): six tiles make three rows of two.
    const lats = new Set(items(el).map((item) => deg(item, 'lat')));
    expect(lats.size).toBe(defaults.rows);
    handle.destroy();
  });

  it('turns with the arrow keys and fades tiles that face away', () => {
    const el = host(6);
    const raf = frames();
    const handle = mount(el, { rows: 1, step: 40, autoRotate: 0 });
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    raf.flush();
    expect(deg(el, 'yaw')).toBeCloseTo(40, 1);
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    raf.flush();
    expect(deg(el, 'yaw')).toBeCloseTo(0, 1);
    expect(raf.pending()).toBe(0); // settled with no drift: the loop stops
    // Six tiles 40deg apart span 200deg: the outermost face away from a centred view.
    const away = items(el).map((item) => item.classList.contains('genui-dome-gallery__item--away'));
    expect(away).toEqual([true, false, false, false, false, true]);
    handle.destroy();
  });

  it('turns to face a tile whose content takes focus', () => {
    const el = host(6);
    const raf = frames();
    const handle = mount(el, { rows: 1, step: 30, autoRotate: 0 });
    const last = items(el)[5]!;
    last.querySelector('a')!.focus();
    raf.flush();
    expect(deg(el, 'yaw')).toBeCloseTo(-deg(last, 'lon'), 1);
    handle.destroy();
  });

  it('drags on a rAF loop that pauses off-screen and stops on destroy', () => {
    const raf = frames();
    const io = stubIO();
    const el = host(6);
    const handle = mount(el, { rows: 1, autoRotate: 0, inertia: false, sensitivity: 0.5 });
    expect(raf.pending()).toBe(0); // not visible yet
    io.trigger(el, true);
    el.dispatchEvent(Object.assign(new MouseEvent('pointerdown', { clientX: 100, clientY: 50, bubbles: true }), { pointerId: 1, pointerType: 'mouse' }));
    el.dispatchEvent(Object.assign(new MouseEvent('pointermove', { clientX: 60, clientY: 50, bubbles: true }), { pointerId: 1, pointerType: 'mouse' }));
    raf.flush();
    expect(deg(el, 'yaw')).toBeCloseTo(20); // dragging left turns the view right
    expect(raf.pending()).toBe(1); // still dragging
    io.trigger(el, false);
    expect(raf.pending()).toBe(0);
    io.trigger(el, true);
    expect(raf.pending()).toBe(1);
    handle.destroy();
    expect(raf.pending()).toBe(0);
    expect(io.observers[0]!.disconnected).toBe(true);
  });

  it('attaches every listener with the signal, so destroy removes them all', () => {
    const el = host();
    const tracked = trackActiveListeners(el, ['pointerdown', 'pointermove', 'keydown', 'focusin', 'click']);
    const handle = mount(el);
    expect(tracked.active('pointerdown')).toBe(1);
    handle.destroy();
    for (const type of ['pointerdown', 'pointermove', 'keydown', 'focusin', 'click']) expect(tracked.active(type)).toBe(0);
  });

  it('follows reduced motion at mount and on change, and removes its listener on destroy', () => {
    const raf = stubRaf();
    const media = stubMatchMedia(true);
    const el = host();
    const before = el.outerHTML;
    const handle = mount(el);
    expect(el.classList.contains('genui-dome-gallery--reduced')).toBe(true);
    expect(el.classList.contains('genui-dome-gallery--3d')).toBe(false);
    expect(raf.pending()).toBe(0);
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(deg(el, 'yaw')).toBe(0);
    expect(media.listeners()).toBe(1);
    media.fire(false);
    expect(el.classList.contains('genui-dome-gallery--reduced')).toBe(false);
    expect(el.classList.contains('genui-dome-gallery--3d')).toBe(true);
    expect(raf.pending()).toBe(1); // idle drift resumes
    media.fire(true);
    expect(raf.pending()).toBe(0);
    handle.destroy();
    expect(media.listeners()).toBe(0);
    expect(el.outerHTML).toBe(before);
  });

  it('ships css scoped under .genui-dome-gallery with no url() or @import', () => {
    const css = readFileSync(path.join(here, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).not.toMatch(/url\(|@import|https?:\/\//);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    const selectors = css.replace(/@media[^{]+\{/g, '').match(/[^{}]+(?=\{)/g) ?? [];
    for (const selector of selectors.flatMap((s) => s.split(','))) {
      expect(selector.trim()).toMatch(/genui-dome-gallery/);
    }
  });

  it('has a demo fragment with no script, style block, image or external URL', () => {
    const demo = readFileSync(path.join(here, 'demo.html'), 'utf8');
    expect(demo).toContain(`data-genui="${id}"`);
    expect(demo).not.toMatch(/<script|<style|<img|url\(|https?:\/\/|xmlns/i);
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
