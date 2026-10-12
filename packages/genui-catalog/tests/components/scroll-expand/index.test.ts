// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { autoInit, defaults, expandProgress, id, mount } from '../../../components/scroll-expand/index.ts';
import { spyListeners, stubIO, stubMatchMedia, stubRaf, trackActiveListeners } from '../../_helpers.ts';

const here = path.resolve(import.meta.dirname, '../../../components/scroll-expand');
const P = '--genui-scroll-expand-p';

function host(): HTMLElement {
  const el = document.createElement('article');
  el.innerHTML = '<h3>Ridge trail</h3><p>Two hours out.</p>';
  el.dataset.genui = id;
  document.body.append(el);
  return el;
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
    expect(el.classList.contains(`genui-${id}--clip`)).toBe(true);
    expect(el.hasAttribute('data-genui-mounted')).toBe(true);
    expect(el.children).toHaveLength(2); // no nodes appended
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
    mount(el, { radius: 10, mode: 'scale' }).destroy();
    expect(el.outerHTML).toBe(before);
  });

  it('maps options to custom properties and clamps from', () => {
    const el = host();
    const handle = mount(el, { radius: 40, endRadius: 4, from: 0.1, mode: 'scale' });
    expect(el.style.getPropertyValue('--genui-scroll-expand-radius')).toBe('40px');
    expect(el.style.getPropertyValue('--genui-scroll-expand-end-radius')).toBe('4px');
    expect(el.style.getPropertyValue('--genui-scroll-expand-from')).toBe('0.3');
    expect(el.classList.contains(`genui-${id}--scale`)).toBe(true);
    handle.destroy();
  });

  it('merges data-genui-opts under opts and drops unknown keys and wrong types', () => {
    const el = host();
    el.dataset.genuiOpts = JSON.stringify({ radius: 12, from: 0.5, bogus: 1, endRadius: 'big' });
    const handle = mount(el, { from: 0.6 });
    expect(el.style.getPropertyValue('--genui-scroll-expand-radius')).toBe('12px');
    expect(el.style.getPropertyValue('--genui-scroll-expand-from')).toBe('0.6');
    expect(el.style.getPropertyValue('--genui-scroll-expand-end-radius')).toBe(`${defaults.endRadius}px`);
    expect(el.style.getPropertyValue('--genui-scroll-expand-bogus')).toBe('');
    handle.destroy();
  });

  it('computes progress from the top edge between start and end', () => {
    expect(expandProgress(900, 800, 0.95, 0.3)).toBe(0);
    expect(expandProgress(100, 800, 0.95, 0.3)).toBe(1);
    expect(expandProgress(400, 800, 1, 0)).toBeCloseTo(0.5);
    expect(expandProgress(400, 800, 0.5, 0.5)).toBe(1);
  });

  it('writes progress on scroll only while in view, and detaches when it leaves', () => {
    const raf = stubRaf();
    const io = stubIO();
    vi.stubGlobal('innerHeight', 800);
    const tracked = trackActiveListeners(window, ['scroll', 'resize']);
    const el = host();
    let top = 800;
    el.getBoundingClientRect = () => ({ top, height: 200 }) as DOMRect;
    const handle = mount(el, { start: 1, end: 0 });
    expect(tracked.active('scroll')).toBe(0);
    io.trigger(el);
    expect(tracked.active('scroll')).toBe(1);
    raf.flush();
    expect(Number(el.style.getPropertyValue(P))).toBe(0);
    top = 400;
    window.dispatchEvent(new Event('scroll'));
    raf.flush();
    expect(Number(el.style.getPropertyValue(P))).toBeCloseTo(0.5);
    io.trigger(el, false);
    expect(tracked.active('scroll')).toBe(0);
    expect(tracked.active('resize')).toBe(0);
    expect(raf.pending()).toBe(0);
    handle.destroy();
  });

  it('destroy removes the scroll listener, disconnects the observer and restores outerHTML', () => {
    stubRaf();
    const io = stubIO();
    const listeners = spyListeners(window);
    const el = host();
    const before = el.outerHTML;
    const handle = mount(el);
    io.trigger(el);
    handle.destroy();
    expect(listeners.removed()).toBeGreaterThan(0);
    expect(io.observers.every((o) => o.disconnected)).toBe(true);
    expect(el.outerHTML).toBe(before);
  });

  it('follows reduced motion at mount and on change, and removes its listener on destroy', () => {
    const media = stubMatchMedia(true);
    const io = stubIO();
    stubRaf();
    const tracked = trackActiveListeners(window, ['scroll']);
    const el = host();
    const before = el.outerHTML;
    const handle = mount(el);
    expect(el.classList.contains(`genui-${id}--reduced`)).toBe(true);
    expect(el.style.getPropertyValue(P)).toBe('1');
    expect(io.observers).toHaveLength(0);
    expect(media.listeners()).toBe(1);
    media.fire(false);
    expect(el.classList.contains(`genui-${id}--reduced`)).toBe(false);
    io.trigger(el);
    expect(tracked.active('scroll')).toBe(1);
    media.fire(true);
    expect(el.classList.contains(`genui-${id}--reduced`)).toBe(true);
    expect(tracked.active('scroll')).toBe(0);
    handle.destroy();
    expect(media.listeners()).toBe(0);
    expect(el.outerHTML).toBe(before);
  });

  it('ships css scoped under .genui-scroll-expand with no url() or @import', () => {
    const css = readFileSync(path.join(here, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).not.toMatch(/url\(|@import|https?:\/\//);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    const selectors = css.replace(/@media[^{]+\{/g, '').match(/[^{}]+(?=\{)/g) ?? [];
    for (const selector of selectors.flatMap((s) => s.split(','))) {
      expect(selector.trim()).toMatch(/genui-scroll-expand/);
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
    const declared = Object.fromEntries(Object.entries(meta.props.properties).map(([key, value]) => [key, value.default]));
    expect(declared).toEqual(defaults);
  });
});
