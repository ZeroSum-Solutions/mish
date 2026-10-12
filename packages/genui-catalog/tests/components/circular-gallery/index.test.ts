// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { autoInit, defaults, id, mount } from '../../../components/circular-gallery/index.ts';
import { stubIO, stubMatchMedia, stubRaf } from '../../_helpers.ts';

const here = path.resolve(import.meta.dirname, '../../../components/circular-gallery');
const P = `genui-${id}`;

function host(count = 4): HTMLElement {
  const el = document.createElement('ul');
  el.dataset.genui = id;
  for (let i = 0; i < count; i += 1) {
    const li = document.createElement('li');
    li.className = `${P}__item`;
    li.innerHTML = `<a href="#">Item ${i}</a>`;
    el.append(li);
  }
  document.body.append(el);
  return el;
}

function items(el: HTMLElement): HTMLElement[] {
  return Array.from(el.querySelectorAll<HTMLElement>(`.${P}__item`));
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
    expect(el.classList.contains(`${P}--live`)).toBe(true);
    expect(items(el)[0]!.style.transform).toMatch(/translate3d\(.*rotate\(/);
    expect(autoInit(document)).toHaveLength(0);
    handle!.destroy();
    expect(el.outerHTML).toBe(before);
    handle!.destroy(); // idempotent
    expect(el.outerHTML).toBe(before);
  });

  it('keeps an existing class and style attribute byte-for-byte, on the host and items', () => {
    const el = host();
    el.className = 'card  featured';
    el.setAttribute('style', 'color: red;');
    items(el)[1]!.setAttribute('style', 'width: 120px;');
    const before = el.outerHTML;
    mount(el, { bend: 10 }).destroy();
    expect(el.outerHTML).toBe(before);
  });

  it('maps options to custom properties', () => {
    const el = host();
    const handle = mount(el, { bend: 30, gap: 24 });
    expect(el.style.getPropertyValue(`--${P}-bend`)).toBe('30deg');
    expect(el.style.getPropertyValue(`--${P}-gap`)).toBe('24px');
    handle.destroy();
    const clamped = mount(host(), { bend: 400, gap: -5 });
    const el2 = document.querySelectorAll<HTMLElement>(`.${P}`)[0]!;
    expect(el2.style.getPropertyValue(`--${P}-bend`)).toBe('80deg');
    expect(el2.style.getPropertyValue(`--${P}-gap`)).toBe('0px');
    clamped.destroy();
  });

  it('merges data-genui-opts under opts and drops unknown keys and wrong types', () => {
    const el = host();
    el.dataset.genuiOpts = JSON.stringify({ bend: 12, gap: 30, bogus: 1, speed: 'fast' });
    const handle = mount(el, { gap: 20 });
    expect(el.style.getPropertyValue(`--${P}-bend`)).toBe('12deg');
    expect(el.style.getPropertyValue(`--${P}-gap`)).toBe('20px');
    expect(el.style.getPropertyValue(`--${P}-bogus`)).toBe('');
    handle.destroy();
  });

  it('drifts only while visible and stops the rAF loop on destroy', () => {
    const raf = stubRaf();
    const io = stubIO();
    const el = host();
    const handle = mount(el);
    expect(raf.pending()).toBe(0); // not intersecting yet
    io.trigger(el, true);
    expect(raf.pending()).toBe(1);
    io.trigger(el, false);
    expect(raf.pending()).toBe(0);
    io.trigger(el, true);
    handle.destroy();
    expect(raf.pending()).toBe(0);
    expect(io.observers[0]!.disconnected).toBe(true);
  });

  it('idles the loop when speed is 0 and nothing is moving', () => {
    const raf = stubRaf();
    const el = host();
    const handle = mount(el, { speed: 0 });
    expect(raf.pending()).toBe(0);
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(raf.pending()).toBe(1);
    handle.destroy();
    expect(raf.pending()).toBe(0);
  });

  it('follows reduced motion at mount and on change, and removes its listener on destroy', () => {
    const media = stubMatchMedia(true);
    const el = host();
    const before = el.outerHTML;
    const handle = mount(el);
    expect(el.classList.contains(`${P}--reduced`)).toBe(true);
    expect(el.classList.contains(`${P}--live`)).toBe(false);
    expect(items(el).every((item) => !item.hasAttribute('style'))).toBe(true);
    expect(media.listeners()).toBe(1);
    media.fire(false);
    expect(el.classList.contains(`${P}--reduced`)).toBe(false);
    expect(el.classList.contains(`${P}--live`)).toBe(true);
    expect(items(el)[0]!.style.transform).not.toBe('');
    media.fire(true);
    expect(el.classList.contains(`${P}--live`)).toBe(false);
    expect(items(el).every((item) => !item.hasAttribute('style'))).toBe(true);
    handle.destroy();
    expect(media.listeners()).toBe(0);
    expect(el.outerHTML).toBe(before);
  });

  it('ships css scoped under .genui-circular-gallery with no url() or @import', () => {
    const css = readFileSync(path.join(here, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).not.toMatch(/url\(|@import|https?:\/\//);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    const selectors = css.replace(/@media[^{]+\{/g, '').match(/[^{}]+(?=\{)/g) ?? [];
    for (const selector of selectors.flatMap((s) => s.split(','))) {
      expect(selector.trim()).toMatch(/genui-circular-gallery/);
    }
  });

  it('has a demo fragment with no script, style block, image or external URL', () => {
    const demo = readFileSync(path.join(here, 'demo.html'), 'utf8');
    expect(demo).toContain(`data-genui="${id}"`);
    expect(demo).not.toMatch(/<script|<style|<img|url\(|https?:\/\//i);
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
