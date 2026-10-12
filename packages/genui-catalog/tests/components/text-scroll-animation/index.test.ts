// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { autoInit, defaults, id, mount, progress } from '../../../components/text-scroll-animation/index.ts';
import { stubIO, stubMatchMedia, stubRaf, trackActiveListeners } from '../../_helpers.ts';

const here = path.resolve(import.meta.dirname, '../../../components/text-scroll-animation');
const P = `--genui-${id}`;

function host(html = 'Hi <em>you</em>'): HTMLElement {
  const el = document.createElement('h2');
  el.innerHTML = html;
  el.dataset.genui = id;
  document.body.append(el);
  return el;
}

function placeAt(el: HTMLElement, top: number): void {
  el.getBoundingClientRect = () => ({ top, bottom: top + 40, left: 0, right: 0, width: 0, height: 40, x: 0, y: top, toJSON() {} });
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe(id, () => {
  it('autoInit mounts once, and destroy restores outerHTML exactly', () => {
    const el = host();
    const before = el.outerHTML;
    const [handle] = autoInit(document);
    expect(el.classList.contains(`genui-${id}`)).toBe(true);
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
    mount(el, { tilt: 10 }).destroy();
    expect(el.outerHTML).toBe(before);
  });

  it('splits into aria-hidden characters and keeps the original text once for screen readers', () => {
    const el = host('Hi <em>you</em>');
    const handle = mount(el);
    const chars = el.querySelectorAll(`.genui-${id}__char`);
    expect(chars).toHaveLength(5);
    expect((chars[4] as HTMLElement).style.getPropertyValue('--i')).toBe('4');
    expect(el.querySelector(`.genui-${id}__visual`)?.getAttribute('aria-hidden')).toBe('true');
    expect(el.querySelector(`.genui-${id}__visual em`)).not.toBeNull();
    expect(el.querySelector(`.genui-${id}__sr`)?.textContent).toBe('Hi you');
    expect(el.style.getPropertyValue(`${P}-n`)).toBe('5');
    handle.destroy();
  });

  it('maps options to custom properties', () => {
    const el = host();
    const handle = mount(el, { tilt: 30, rise: '1em', baseOpacity: 2, spread: 0 });
    expect(el.style.getPropertyValue(`${P}-tilt`)).toBe('30deg');
    expect(el.style.getPropertyValue(`${P}-rise`)).toBe('1em');
    expect(el.style.getPropertyValue(`${P}-base-opacity`)).toBe('1');
    expect(el.style.getPropertyValue(`${P}-w`)).toBe('1');
    handle.destroy();
  });

  it('merges data-genui-opts under opts and drops unknown keys and wrong types', () => {
    const el = host();
    el.dataset.genuiOpts = JSON.stringify({ tilt: 12, spread: 3, bogus: 1, baseOpacity: 'loud' });
    const handle = mount(el, { spread: 5 });
    expect(el.style.getPropertyValue(`${P}-tilt`)).toBe('12deg');
    expect(el.style.getPropertyValue(`${P}-w`)).toBe('5');
    expect(el.style.getPropertyValue(`${P}-base-opacity`)).toBe(String(defaults.baseOpacity));
    expect(el.style.getPropertyValue(`${P}-bogus`)).toBe('');
    handle.destroy();
  });

  it('computes progress from the host position in the viewport', () => {
    expect(progress(1000, 1000, 0.95, 0.35)).toBe(0);
    expect(progress(350, 1000, 0.95, 0.35)).toBe(1);
    expect(progress(650, 1000, 0.95, 0.35)).toBeCloseTo(0.5);
    expect(progress(10, 1000, 0.5, 0.5)).toBe(1);
  });

  it('follows native scroll only while in view, through one rAF, and detaches on destroy', () => {
    const io = stubIO();
    const raf = stubRaf();
    const listeners = trackActiveListeners(window, ['scroll', 'resize']);
    vi.stubGlobal('innerHeight', 1000);
    const el = host();
    placeAt(el, 650);
    const handle = mount(el);
    expect(listeners.active('scroll')).toBe(0);
    io.trigger(el);
    expect(listeners.active('scroll')).toBe(1);
    expect(listeners.active('resize')).toBe(1);
    raf.flush();
    expect(Number(el.style.getPropertyValue(`${P}-p`))).toBeCloseTo(0.5, 3);
    placeAt(el, 200);
    window.dispatchEvent(new Event('scroll'));
    window.dispatchEvent(new Event('scroll'));
    expect(raf.pending()).toBe(1);
    raf.flush();
    expect(el.style.getPropertyValue(`${P}-p`)).toBe('1.0000');
    io.trigger(el, false);
    expect(listeners.active('scroll')).toBe(0);
    io.trigger(el);
    handle.destroy();
    expect(listeners.active('scroll')).toBe(0);
    expect(listeners.active('resize')).toBe(0);
    expect(raf.pending()).toBe(0);
    expect(io.observers[0]!.disconnected).toBe(true);
  });

  it('under reduced motion at mount: no split, no observer, reduced class, listener removed on destroy', () => {
    const media = stubMatchMedia(true);
    const io = stubIO();
    const el = host();
    const before = el.outerHTML;
    const handle = mount(el);
    expect(el.classList.contains(`genui-${id}--reduced`)).toBe(true);
    expect(el.querySelectorAll(`.genui-${id}__char`)).toHaveLength(0);
    expect(io.observers).toHaveLength(0);
    expect(media.listeners()).toBe(1);
    handle.destroy();
    expect(media.listeners()).toBe(0);
    expect(el.outerHTML).toBe(before);
  });

  it('snaps to the final state and stops following scroll when reduced motion turns on', () => {
    const media = stubMatchMedia(false);
    const io = stubIO();
    stubRaf();
    const listeners = trackActiveListeners(window, ['scroll']);
    const el = host();
    const before = el.outerHTML;
    const handle = mount(el);
    io.trigger(el);
    expect(listeners.active('scroll')).toBe(1);
    media.fire(true);
    expect(el.classList.contains(`genui-${id}--reduced`)).toBe(true);
    expect(el.style.getPropertyValue(`${P}-p`)).toBe('1');
    expect(listeners.active('scroll')).toBe(0);
    expect(io.observers[0]!.disconnected).toBe(true);
    media.fire(false);
    expect(el.classList.contains(`genui-${id}--reduced`)).toBe(false);
    handle.destroy();
    expect(media.listeners()).toBe(0);
    expect(el.outerHTML).toBe(before);
  });

  it(`ships css scoped under .genui-${id} with no url() or @import`, () => {
    const css = readFileSync(path.join(here, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).not.toMatch(/url\(|@import|https?:\/\//);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    const selectors = css.replace(/@media[^{]+\{/g, '').match(/[^{}]+(?=\{)/g) ?? [];
    for (const selector of selectors.flatMap((s) => s.split(','))) {
      expect(selector.trim()).toMatch(new RegExp(`genui-${id}`));
    }
  });

  it('has a demo fragment with no script, style block, image or external URL', () => {
    const demo = readFileSync(path.join(here, 'demo.html'), 'utf8');
    expect(demo).toContain(`data-genui="${id}"`);
    expect(demo).not.toMatch(/<script|<style|<img|url\(|https?:\/\//i);
    expect(demo).not.toMatch(/xmlns|data:/i);
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
