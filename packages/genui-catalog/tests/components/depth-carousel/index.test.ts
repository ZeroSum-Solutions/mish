// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { autoInit, defaults, id, mount, offsetOf } from '../../../components/depth-carousel/index.ts';
import { stubIO, stubMatchMedia } from '../../_helpers.ts';

const here = path.resolve(import.meta.dirname, '../../../components/depth-carousel');
const P = 'genui-depth-carousel';

function host(count = 5): { el: HTMLElement; items: HTMLElement[] } {
  const el = document.createElement('div');
  el.dataset.genui = id;
  const items: HTMLElement[] = [];
  for (let i = 0; i < count; i += 1) {
    const item = document.createElement('article');
    item.className = `${P}__item`;
    item.tabIndex = 0;
    item.textContent = `Slide ${i}`;
    el.append(item);
    items.push(item);
  }
  document.body.append(el);
  return { el, items };
}

const offsets = (items: HTMLElement[]): string[] => items.map((item) => item.style.getPropertyValue(`--${P}-o`));
const key = (el: HTMLElement, k: string): void => { el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })); };

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe(id, () => {
  it('autoInit mounts once, and destroy restores outerHTML exactly', () => {
    const { el } = host();
    const before = el.outerHTML;
    const [handle] = autoInit(document);
    expect(el.classList.contains(`genui-${id}`)).toBe(true);
    expect(el.hasAttribute('data-genui-mounted')).toBe(true);
    expect(el.querySelectorAll(`.${P}__btn`)).toHaveLength(2);
    expect(autoInit(document)).toHaveLength(0);
    handle!.destroy();
    expect(el.outerHTML).toBe(before);
    handle!.destroy(); // idempotent
    expect(el.outerHTML).toBe(before);
  });

  it('keeps an existing class and style attribute byte-for-byte', () => {
    const { el, items } = host();
    el.className = 'card  featured';
    el.setAttribute('style', 'color: red;');
    items[1]!.setAttribute('style', 'width: 10px;');
    const before = el.outerHTML;
    const handle = mount(el, { start: 1 });
    key(el, 'ArrowRight');
    handle.destroy();
    expect(el.outerHTML).toBe(before);
  });

  it('maps options to custom properties', () => {
    const { el } = host();
    const handle = mount(el, { spacing: 90, rotate: 20 });
    expect(el.style.getPropertyValue(`--${P}-spacing`)).toBe('90px');
    expect(el.style.getPropertyValue(`--${P}-rotate`)).toBe('20deg');
    expect(el.style.getPropertyValue(`--${P}-depth`)).toBe(`${defaults.depth}px`);
    expect(el.style.getPropertyValue(`--${P}-duration`)).toBe(`${defaults.duration}ms`);
    expect(el.style.getPropertyValue(`--${P}-visible`)).toBe(String(defaults.visible));
    handle.destroy();
  });

  it('merges data-genui-opts under opts and drops unknown keys and wrong types', () => {
    const { el } = host();
    el.dataset.genuiOpts = JSON.stringify({ spacing: 70, depth: 300, bogus: 1, rotate: 'lots' });
    const handle = mount(el, { depth: 200 });
    expect(el.style.getPropertyValue(`--${P}-spacing`)).toBe('70px');
    expect(el.style.getPropertyValue(`--${P}-depth`)).toBe('200px');
    expect(el.style.getPropertyValue(`--${P}-rotate`)).toBe(`${defaults.rotate}deg`);
    expect(el.style.getPropertyValue(`--${P}-bogus`)).toBe('');
    handle.destroy();
  });

  it('places items by signed distance from the active one, wrapping when looping', () => {
    expect(offsetOf(4, 0, 5, true)).toBe(-1);
    expect(offsetOf(4, 0, 5, false)).toBe(4);
    const { el, items } = host();
    const handle = mount(el, { start: 2 });
    expect(offsets(items)).toEqual(['-2', '-1', '0', '1', '2']);
    expect(items[2]!.getAttribute('aria-current')).toBe('true');
    expect(items[2]!.classList.contains(`${P}__item--active`)).toBe(true);
    handle.destroy();
  });

  it('moves with keys, buttons, clicks and focus, and announces the slide', () => {
    const { el, items } = host();
    const handle = mount(el);
    key(el, 'ArrowRight');
    expect(items[1]!.getAttribute('aria-current')).toBe('true');
    expect(el.querySelector(`.${P}__status`)!.textContent).toBe('Slide 2 of 5');
    key(el, 'End');
    expect(items[4]!.getAttribute('aria-current')).toBe('true');
    (el.querySelector(`.${P}__btn--next`) as HTMLButtonElement).click();
    expect(items[0]!.getAttribute('aria-current')).toBe('true'); // loop wraps
    (el.querySelector(`.${P}__btn--prev`) as HTMLButtonElement).click();
    expect(items[4]!.getAttribute('aria-current')).toBe('true');
    items[2]!.click();
    expect(items[2]!.getAttribute('aria-current')).toBe('true');
    items[3]!.focus();
    expect(items[3]!.getAttribute('aria-current')).toBe('true');
    expect(items[2]!.hasAttribute('aria-current')).toBe(false);
    handle.destroy();
  });

  it('clamps and disables the edge buttons when loop is off', () => {
    const { el, items } = host(3);
    const handle = mount(el, { loop: false });
    const prev = el.querySelector(`.${P}__btn--prev`) as HTMLButtonElement;
    expect(prev.disabled).toBe(true);
    key(el, 'ArrowLeft');
    expect(items[0]!.getAttribute('aria-current')).toBe('true');
    handle.destroy();
  });

  it('autoplays, pauses on hover and off-screen, and stops on destroy', () => {
    vi.useFakeTimers();
    const io = stubIO();
    const { el, items } = host();
    const handle = mount(el, { autoplay: 1000 });
    vi.advanceTimersByTime(1000);
    expect(items[1]!.getAttribute('aria-current')).toBe('true');
    el.dispatchEvent(new Event('pointerenter'));
    vi.advanceTimersByTime(3000);
    expect(items[1]!.getAttribute('aria-current')).toBe('true');
    el.dispatchEvent(new Event('pointerleave'));
    io.trigger(el, false);
    vi.advanceTimersByTime(3000);
    expect(items[1]!.getAttribute('aria-current')).toBe('true');
    io.trigger(el, true);
    vi.advanceTimersByTime(1000);
    expect(items[2]!.getAttribute('aria-current')).toBe('true');
    handle.destroy();
    expect(io.observers[0]!.disconnected).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('follows reduced motion at mount and on change, and removes its listener on destroy', () => {
    vi.useFakeTimers();
    const media = stubMatchMedia(true);
    const { el, items } = host();
    const before = el.outerHTML;
    const handle = mount(el, { autoplay: 1000 });
    expect(el.classList.contains(`${P}--reduced`)).toBe(true);
    expect(media.listeners()).toBe(1);
    vi.advanceTimersByTime(3000);
    expect(items[0]!.getAttribute('aria-current')).toBe('true'); // no autoplay under reduce
    key(el, 'ArrowRight');
    expect(items[1]!.getAttribute('aria-current')).toBe('true'); // manual control still works
    media.fire(false);
    expect(el.classList.contains(`${P}--reduced`)).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(items[2]!.getAttribute('aria-current')).toBe('true');
    handle.destroy();
    expect(media.listeners()).toBe(0);
    expect(el.outerHTML).toBe(before);
  });

  it('ships css scoped under .genui-depth-carousel with no url() or @import', () => {
    const css = readFileSync(path.join(here, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).not.toMatch(/url\(|@import|https?:\/\//);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    const selectors = css.replace(/@media[^{]+\{/g, '').match(/[^{}]+(?=\{)/g) ?? [];
    for (const selector of selectors.flatMap((s) => s.split(','))) {
      expect(selector.trim()).toMatch(/genui-depth-carousel/);
    }
  });

  it('has a demo fragment with no script, style block, image or external URL', () => {
    const demo = readFileSync(path.join(here, 'demo.html'), 'utf8');
    expect(demo).toContain(`data-genui="${id}"`);
    expect(demo).not.toMatch(/<script|<style|<img|url\(|https?:\/\//i);
  });

  it('declares the same defaults in meta.json props as in the code', () => {
    const meta = JSON.parse(readFileSync(path.join(here, 'meta.json'), 'utf8')) as {
      id: string; props: { properties: Record<string, { default: unknown }> };
    };
    expect(meta.id).toBe(id);
    const declared = Object.fromEntries(Object.entries(meta.props.properties).map(([k, value]) => [k, value.default]));
    expect(declared).toEqual(defaults);
  });
});
